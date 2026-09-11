/**
 * demo.ts — the §4.6 orchestrator. One command, live Sepolia, full lifecycle.
 *
 * Shows, in order:
 *   1. sealed claims filled against bounties, content hidden
 *   2. purchase → key delivery → buyer decrypts and VERIFIES against the commitment
 *   3. a late purchase REVERTING at the lock cliff
 *   4. batch attestation settling every claim on a game at once
 *   5. one contrarian claim right, one wrong (bond burned)
 *   6. one deliberately unrevealed claim being SLASHED
 *   7. the final reputation ledger
 *
 * Timing is derived from the contract's own challengeWindow/revealWindow, so the same
 * script works against any deployment.
 */

import { rmSync } from 'node:fs';
import { publicClient, short, CONTRACT_ADDRESS, EXPLORER, gameIdOf } from './lib/chain.js';
import type { Hex } from 'viem';
import { read } from './lib/tx.js';
import { act, info, head, sub, setT0, waitUntil, sleep, stamp } from './lib/log.js';
import { loadFixture, resolveFixture, findGame } from './lib/fixtures.js';
import { indexMarket, claimsForBounty, type MarketState } from './lib/indexer.js';
import { makeResolver } from './resolver.js';
import { makeAggregator } from './seller-aggregator.js';
import { makeForecaster } from './seller-forecaster.js';
import { makeBuyer, REVEAL_FEE, CONTINGENT } from './buyer.js';
import { fmt } from './lib/seller.js';
import { rankedLedger, ledger } from './lib/scoring.js';
import { Outcome, Bucket } from './lib/enums.js';
import type { Seller } from './lib/seller.js';

const pub = publicClient();

/** The slot whose forecaster claim is deliberately never revealed. */
const WITHHOLD_SLUG = 'kelce';

async function main() {
  const now = () => Math.floor(Date.now() / 1000);

  // Sellers persist {claimId, payload, K} to out/ so they can deliver keys and reveal.
  // Each demo run is self-contained, so start from a clean slate rather than trying to
  // deliver keys for claims that belong to an earlier run.
  rmSync('out', { recursive: true, force: true });

  const challengeWindow = Number(await read<bigint>(pub, 'challengeWindow'));
  const revealWindow = Number(await read<bigint>(pub, 'revealWindow'));
  const baseBond = await read<bigint>(pub, 'baseBond');

  const fixtureFile = loadFixture('fixtures/week1.json');
  // Demo default: 110s lock. Long enough for ~25 pre-lock txs at Sepolia's ~13s
  // confirmations, short enough that lock + challenge + reveal fits a 5-minute video.
  const nominalLock = fixtureFile.games[0].lockOffsetSec;
  const lockOffset = Number(process.env.DEMO_LOCK_SEC ?? 110);
  // Scale FUTURE news offsets with the lock so late-breaking news still lands before the
  // cliff when the lock is shortened. Past news (negative offsets) has already broken.
  const scale = lockOffset / nominalLock;
  for (const g of fixtureFile.games) {
    g.lockOffsetSec = lockOffset;
    for (const p of g.players) {
      for (const n of p.news) if (n.tsOffsetSec > 0) n.tsOffsetSec = Math.round(n.tsOffsetSec * scale);
    }
  }

  // gameId is deterministic from (season, week, teams), so a re-run would collide with the
  // previous run's games. Advance the synthetic week until every gameId in the slate is
  // free. Keeps the §3.1 derivation intact and makes `npm run demo` idempotent.
  const baseWeek = fixtureFile.week;
  for (let off = 0; off < 512; off++) {
    fixtureFile.week = baseWeek + off;
    const ids = fixtureFile.games.map((g) => gameIdOf(fixtureFile.season, fixtureFile.week, g.home, g.away));
    const used = await Promise.all(
      ids.map(async (id) => {
        const g = await read<readonly [bigint, bigint, Hex, boolean]>(pub, 'games', [id]);
        return g[0] !== 0n;
      }),
    );
    if (!used.some(Boolean)) break;
  }
  if (fixtureFile.week !== baseWeek) {
    info(`week ${baseWeek} already used on this contract — running as synthetic week ${fixtureFile.week}`);
  }

  const t0 = now();
  setT0(t0);
  const fixture = resolveFixture(fixtureFile, t0);
  // Everything below acts ONLY on this run's games, so leftovers from earlier runs on the
  // same contract are never settled, slashed, or counted in the ledger.
  const runGameIds = new Set<string>(fixture.games.map((g) => g.gameId));
  const isRunClaim = (st: MarketState, bountyId: number) => {
    const b = st.bounties.get(bountyId);
    return !!b && runGameIds.has(b.gameId);
  };

  const resolver = makeResolver(fixture);
  const aggregator = makeAggregator();
  const forecaster = makeForecaster(({ player }) => player.slug === WITHHOLD_SLUG);
  const buyer = makeBuyer(fixture);

  const lockAt = t0 + lockOffset;
  const totalEstimate = lockOffset + challengeWindow + revealWindow + 40;

  head('SEALED AVAILABILITY MARKET — live demo on Ethereum Sepolia');
  console.log(`  contract        ${CONTRACT_ADDRESS}`);
  console.log(`  explorer        ${EXPLORER}`);
  console.log(`  resolver/owner  ${resolver.address}  (also the deployer — the trust assumption)`);
  console.log(`  buyer           ${buyer.address}`);
  console.log(`  aggregator      ${aggregator.address}`);
  console.log(`  forecaster      ${forecaster.address}`);
  console.log(`  params          baseBond=${fmt(baseBond)}  lock=+${lockOffset}s  challenge=${challengeWindow}s  reveal=${revealWindow}s`);
  console.log(`  est. runtime    ~${Math.ceil(totalEstimate / 60)}m${totalEstimate % 60}s`);

  // ── t+0:00 ────────────────────────────────────────────────────────────────
  sub('1. RESOLVER sets up the slate and publishes the public prior');
  await resolver.createGames();
  await resolver.setPriors();

  // ── t+0:10 ────────────────────────────────────────────────────────────────
  sub('2. BUYER posts bounties on the slots it is uncertain about');
  await buyer.registerAndPostBounties();

  // ── t+0:20 ────────────────────────────────────────────────────────────────
  sub('3. SELLERS fill bounties with SEALED claims (content hidden, bond posted)');
  let state = await indexMarket(pub);
  await fillPass(state, [aggregator, forecaster], fixture, buyer, now());

  // ── t+0:40 ────────────────────────────────────────────────────────────────
  sub('4. BUYER buys the top-ranked sealed claims — still cannot read them');
  state = await indexMarket(pub);
  await buyer.purchaseTopK(state, 2);

  // ── t+0:50 ────────────────────────────────────────────────────────────────
  sub('5. SELLERS deliver ECIES(buyerPubKey, K) — THIS is the sale');
  state = await indexMarket(pub);
  await Promise.all([aggregator.deliverKeys(state), forecaster.deliverKeys(state)]);

  sub('6. BUYER decrypts and verifies each payload against its on-chain commitment');
  state = await indexMarket(pub);
  buyer.openDelivered(state);

  const decisions = buyer.ensemble(state);
  console.log('');
  info('ensemble decision (logit pool of public prior + verified claims, weighted by reputation):');
  for (const d of decisions) {
    console.log(
      `             ${d.player.padEnd(22)} prior=${d.priorPActive.toFixed(2)} → P(ACTIVE)=${d.pActive.toFixed(3)}  ${d.decision.padEnd(5)} from claims [${d.sources.join(', ')}]`,
    );
  }
  info('written to out/decision.json');

  // ── late-breaking news ────────────────────────────────────────────────────
  const lateNewsAt = t0 + Math.min(...fixtureFile.games.flatMap((g) => g.players.flatMap((p) => p.news.map((n) => n.tsOffsetSec))).filter((s) => s > 0));
  if (lateNewsAt < lockAt) {
    await waitUntil(lateNewsAt + 5, 'late-breaking beat report reaches the aggregator');
    sub('7. Late news breaks — AGGREGATOR fills a new bounty AFTER the buyer has bought');
    state = await indexMarket(pub);
    await fillPass(state, [aggregator], fixture, buyer, now());
  }

  // ── t+lock ────────────────────────────────────────────────────────────────
  await waitUntilChain(lockAt, 'LINEUP LOCK — purchases close by construction');
  sub('8. THE LOCK CLIFF — a late purchase must revert');
  state = await indexMarket(pub);
  const unsold = [...state.claims.values()].find((c) => !c.purchased && isRunClaim(state, c.bountyId));
  if (unsold) {
    const reason = await buyer.attemptLatePurchase(unsold.claimId);
    if (reason) {
      act('BUYER', `purchase claim#${unsold.claimId} at lock → REVERTED: ${reason}  ✓ stale intel is unsellable`);
    } else {
      act('BUYER', `purchase claim#${unsold.claimId} did NOT revert — lock cliff FAILED`);
    }
  } else {
    info('no unsold claim available to demonstrate the lock cliff');
  }

  // ── attest ────────────────────────────────────────────────────────────────
  sub('9. RESOLVER attests the official inactive list — one tx settles the whole game');
  for (const g of fixture.games) await resolver.attest(g);

  // ── reveal ────────────────────────────────────────────────────────────────
  sub('10. MANDATORY REVEAL — every claim, sold or not (one is deliberately withheld)');
  state = await indexMarket(pub);
  const playerOf = (bountyId: number) => {
    const b = state.bounties.get(bountyId);
    if (!b) return undefined;
    return findGame(fixture, b.gameId)?.players.find((p) => p.playerId === b.playerId);
  };
  await Promise.all([aggregator.revealAll(state, playerOf), forecaster.revealAll(state, playerOf)]);

  // ── settle ────────────────────────────────────────────────────────────────
  // Read the real attestation timestamp from the contract; the settle/slash deadlines are
  // measured from it, not from when the script happened to send the tx.
  // Games are attested in separate txs, so the LAST attestation governs when the whole
  // slate is final. Taking games[0] alone makes settle() revert NotFinal on later games.
  const attestedAts = await Promise.all(
    fixture.games.map(async (g) => {
      const rec = await read<readonly [bigint, bigint, Hex, boolean]>(pub, 'games', [g.gameId]);
      return Number(rec[1]);
    }),
  );
  const attestedAt = Math.max(...attestedAts);
  info(`last attestation (chain) = ${attestedAt}; settle at +${challengeWindow}s, slash at +${challengeWindow + revealWindow}s`);
  await waitUntilChain(attestedAt + challengeWindow, `challenge window (${challengeWindow}s) to elapse before settlement`);
  sub('11. BATCH SETTLEMENT — correct claims release escrow, wrong ones burn bond');
  state = await indexMarket(pub);
  await settleAll(state, isRunClaim);

  // ── slash ─────────────────────────────────────────────────────────────────
  await waitUntilChain(attestedAt + challengeWindow + revealWindow + 1, `reveal window (${revealWindow}s) to expire so the unrevealed claim can be slashed`);
  sub('12. SLASHING — the claim that was never revealed forfeits its bond');
  state = await indexMarket(pub);
  await slashAll(state, isRunClaim);

  // ── withdraw + ledger ─────────────────────────────────────────────────────
  sub('13. PULL PAYMENTS — everyone withdraws');
  await Promise.all([aggregator.withdraw(), forecaster.withdraw(), buyer.withdraw()]);

  state = await indexMarket(pub);
  printLedger(state, { aggregator, forecaster }, fixture, isRunClaim);
}

/** Latest block timestamp — the ONLY clock the contract's require()s care about. */
async function chainNow(): Promise<number> {
  const b = await pub.getBlock({ blockTag: 'latest' });
  return Number(b.timestamp);
}

/**
 * Wait until CHAIN time reaches `ts`. Waiting on wall clock instead silently breaks every
 * time-gated call: Sepolia block timestamps trail real time, so a purchase that looks late
 * still simulates as pre-lock, and `attest` reverts LockNotReached.
 */
async function waitUntilChain(ts: number, why: string) {
  let lastPrinted = -1;
  for (;;) {
    const n = await chainNow();
    if (n >= ts) return;
    const left = ts - n;
    if (lastPrinted < 0 || lastPrinted - left >= 15) {
      info(`waiting ${left}s (chain time) — ${why}`);
      lastPrinted = left;
    }
    await sleep(3000);
  }
}

async function fillPass(
  state: MarketState,
  sellers: Seller[],
  fixture: ReturnType<typeof resolveFixture>,
  buyer: ReturnType<typeof makeBuyer>,
  now: number,
) {
  // Each seller batches its own fills; the sellers run concurrently against each other.
  await Promise.all(
    sellers.map((s) => {
      const items = [];
      for (const bountyId of buyer.bountyIds()) {
        const b = state.bounties.get(bountyId);
        if (!b) continue;
        const player = findGame(fixture, b.gameId)?.players.find((p) => p.playerId === b.playerId);
        if (!player) continue;
        const already = claimsForBounty(state, bountyId).some(
          (c) => c.seller.toLowerCase() === s.address.toLowerCase(),
        );
        if (already) continue;
        const prior = state.priors.get(`${b.gameId}:${b.playerId}`);
        items.push({
          b,
          player,
          priorTag: prior?.tag ?? player.priorTag,
          priorPractice: prior?.practice ?? player.priorPractice,
        });
      }
      return s.fillMany(items, now, fixture.t0);
    }),
  );
}

async function settleAll(state: MarketState, inRun: (s: MarketState, b: number) => boolean) {
  const { sendBatch } = await import('./lib/tx.js');
  const { resolverWallet } = await import('./lib/chain.js');
  // settle is permissionless — anyone can crank it. The demo uses the resolver key purely
  // because it is already funded; nothing about settlement requires that role.
  const wallet = resolverWallet();
  const todo = [...state.claims.values()].filter((c) => inRun(state, c.bountyId) && c.revealed && !c.settled && !c.slashed && !c.refunded);
  if (todo.length === 0) return;
  const results = await sendBatch(pub, wallet, todo.map((c) => ({ functionName: 'settle', args: [BigInt(c.claimId)] })));
  todo.forEach((c, i) => act('CRANK', `settle claim#${c.claimId}`, results[i].hash));
}

async function slashAll(state: MarketState, inRun: (s: MarketState, b: number) => boolean) {
  const { sendBatch } = await import('./lib/tx.js');
  const { resolverWallet } = await import('./lib/chain.js');
  const wallet = resolverWallet();
  const todo = [...state.claims.values()].filter((c) => inRun(state, c.bountyId) && !c.revealed && !c.settled && !c.slashed && !c.refunded);
  if (todo.length === 0) return;
  const results = await sendBatch(pub, wallet, todo.map((c) => ({ functionName: 'slashUnrevealed', args: [BigInt(c.claimId)] })));
  todo.forEach((c, i) =>
    act('CRANK', `slashUnrevealed claim#${c.claimId} — bond forfeit, escrow returned to buyer`, results[i].hash),
  );
}

function printLedger(
  state: MarketState,
  sellers: { aggregator: Seller; forecaster: Seller },
  fixture: ReturnType<typeof resolveFixture>,
  inRun: (s: MarketState, b: number) => boolean,
) {
  head('FINAL LEDGER — reputation is a pure fold over ClaimSettled / ClaimSlashed');

  const nameOf = (addr: string) => {
    const a = addr.toLowerCase();
    if (a === sellers.aggregator.address.toLowerCase()) return 'AGGREGATOR';
    if (a === sellers.forecaster.address.toLowerCase()) return 'FORECASTER';
    return short(addr);
  };

  console.log('');
  console.log(
    `  ${'claim'.padEnd(7)}${'seller'.padEnd(13)}${'player'.padEnd(9)}${'claimed'.padEnd(11)}${'bucket'.padEnd(8)}${'actual'.padEnd(10)}${'outcome'.padEnd(12)}${'bond'.padEnd(13)}Δ score`,
  );
  console.log('  ' + '─'.repeat(94));

  const rows = [...state.claims.values()].filter((c) => inRun(state, c.bountyId)).sort((a, b) => a.claimId - b.claimId);
  for (const c of rows) {
    const b = state.bounties.get(c.bountyId);
    const player = b ? findGame(fixture, b.gameId)?.players.find((p) => p.playerId === b.playerId) : undefined;
    const led = state.ledger.get(c.seller.toLowerCase());
    const entry = led?.claims.find((x) => x.claimId === c.claimId);

    let outcome = 'pending';
    if (c.slashed) outcome = 'SLASHED';
    else if (c.refunded) outcome = 'REFUNDED';
    else if (c.settled) outcome = c.settled.correct ? 'CORRECT' : 'WRONG';

    const claimed = c.revealed ? Outcome[c.revealed.claimed] : '(unrevealed)';
    const bucket = c.revealed ? Bucket[c.revealed.bucket] : '—';
    const actual = c.settled ? Outcome[c.settled.actual] : player ? player.actual : '—';
    const burned = entry && entry.bondBurned > 0n ? `-${fmt(entry.bondBurned)}` : fmt(0n);

    console.log(
      `  #${String(c.claimId).padEnd(6)}${nameOf(c.seller).padEnd(13)}${(player?.slug ?? '—').padEnd(9)}${claimed.padEnd(11)}${bucket.padEnd(8)}${actual.padEnd(10)}${outcome.padEnd(12)}${burned.padEnd(13)}${entry ? (entry.delta >= 0 ? '+' : '') + entry.delta.toFixed(4) : '—'}`,
    );
  }

  // Reputation scoped to THIS run. The contract accumulates across runs, but a demo table
  // that disagrees with the claim rows above it is just confusing.
  const runClaimIds = new Set(rows.map((r) => r.claimId));
  const runLedger = ledger({
    settled: state.settledEvents.filter((e) => runClaimIds.has(e.claimId)),
    penalties: state.penaltyEvents.filter((e) => runClaimIds.has(e.claimId)),
  });

  console.log('');
  console.log(`  ${'seller'.padEnd(13)}${'score'.padEnd(11)}${'n'.padEnd(5)}${'hits'.padEnd(7)}${'hit rate'.padEnd(11)}bond burned`);
  console.log('  ' + '─'.repeat(94));
  for (const l of rankedLedger(runLedger)) {
    const score = `${l.score >= 0 ? '+' : ''}${l.score.toFixed(4)}`;
    const rate = `${(l.hitRate * 100).toFixed(0)}%`;
    console.log(
      `  ${nameOf(l.seller).padEnd(13)}${score.padEnd(11)}${String(l.n).padEnd(5)}${String(l.hits).padEnd(7)}${rate.padEnd(11)}${fmt(l.bondBurned)}`,
    );
  }

  console.log('');
  console.log(`  explorer: ${EXPLORER}`);
  console.log(`  attestation snapshots: out/attestations/*.json (rehash to verify reportHash)`);
  console.log('');
}

main().catch((e) => {
  console.error(`\n${stamp()} DEMO FAILED:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
