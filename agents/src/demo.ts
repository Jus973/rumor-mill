/**
 * demo.ts — the §4.6 orchestrator. One command, live Sepolia, full lifecycle.
 *
 * Shows, in order:
 *   1. sellers LIST sealed claims the moment they have an edge; the buyer BIDS on its slots
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
import { indexMarket, type MarketState } from './lib/indexer.js';
import { settleAndResolve, slashStale } from './lib/crank.js';
import { makeResolver } from './resolver.js';
import { makeAggregator } from './seller-aggregator.js';
import { makeForecaster } from './seller-forecaster.js';
import { makeBuyer } from './buyer.js';
import { fmt, type ListItem } from './lib/seller.js';
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
  const feeBps = await read<number>(pub, 'protocolFeeBps');

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
  const isRunClaim = (c: { gameId: string }) => runGameIds.has(c.gameId);

  const resolver = makeResolver(fixture);
  const aggregator = makeAggregator();
  const forecaster = makeForecaster(({ player }) => player.slug === WITHHOLD_SLUG);
  const buyer = makeBuyer(fixture);

  const lockAt = t0 + lockOffset;
  const totalEstimate = lockOffset + challengeWindow + revealWindow + 40;

  const parties: Array<{ label: string; addr: `0x${string}`; role: string }> = [
    { label: 'OPERATOR', addr: resolver.address as `0x${string}`, role: 'scheduler + attester + fees' },
    { label: 'BUYER', addr: buyer.address as `0x${string}`, role: 'lineup optimizer' },
    { label: 'AGGREGATOR', addr: aggregator.address as `0x${string}`, role: 'sells lead time' },
    { label: 'FORECASTER', addr: forecaster.address as `0x${string}`, role: 'sells calibration' },
  ];
  const opening = new Map<string, bigint>();
  for (const p of parties) opening.set(p.label, await pub.getBalance({ address: p.addr }));

  head('SEALED AVAILABILITY MARKET — live demo on Ethereum Sepolia');
  console.log(`  contract        ${CONTRACT_ADDRESS}`);
  console.log(`  explorer        ${EXPLORER}`);
  console.log('');
  console.log('  STAKEHOLDERS');
  console.log(`    OPERATOR    ${resolver.address}`);
  console.log(`                scheduler (slate + public priors) · attester (outcome) · fee recipient`);
  console.log(`                earns ${Number(feeBps) / 100}% of every reveal fee — charged on the SALE, never on the outcome`);
  console.log(`    BUYER       ${buyer.address}`);
  console.log(`                lineup optimizer · posts bounties, buys sealed claims, must lock`);
  console.log(`    AGGREGATOR  ${aggregator.address}`);
  console.log(`                tipster agent · sells LEAD TIME from local beat reporting`);
  console.log(`    FORECASTER  ${forecaster.address}`);
  console.log(`                tipster agent · sells CALIBRATION, only when it disagrees with the report`);
  console.log(`    BURN SINK   0x00000000000000000000000000000000000dEaD`);
  console.log(`                forfeited bonds — deliberately NOT the operator, so the attester`);
  console.log(`                can never profit from sellers being wrong`);
  console.log('');
  console.log(`  params          baseBond=${fmt(baseBond)}  lock=+${lockOffset}s  challenge=${challengeWindow}s  reveal=${revealWindow}s  fee=${Number(feeBps) / 100}%`);
  console.log(`  est. runtime    ~${Math.ceil(totalEstimate / 60)}m${totalEstimate % 60}s`);

  // ── t+0:00 ────────────────────────────────────────────────────────────────
  sub('1. OPERATOR sets up the slate and publishes the public prior');
  await resolver.createGames();
  await resolver.setPriors();

  // ── t+0:10 ────────────────────────────────────────────────────────────────
  sub('2. SELLERS list SEALED claims wherever they have an edge (content hidden, bond posted)');
  let state = await indexMarket(pub);
  await listPass(state, [aggregator, forecaster], fixture, now());

  // ── t+0:20 ────────────────────────────────────────────────────────────────
  sub('3. BUYER bids on the slots it is uncertain about, and searches the listings');
  await buyer.registerAndPostBounties();

  // ── t+0:40 ────────────────────────────────────────────────────────────────
  sub('4. BUYER buys the top-ranked matching listings — still cannot read them');
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
    sub('7. Late news breaks — AGGREGATOR lists a new claim AFTER the buyer has bought');
    state = await indexMarket(pub);
    await listPass(state, [aggregator], fixture, now());
  }

  // ── t+lock ────────────────────────────────────────────────────────────────
  await waitUntilChain(lockAt, 'LINEUP LOCK — purchases close by construction');
  sub('8. THE LOCK CLIFF — a late purchase must revert');
  state = await indexMarket(pub);
  const unsold = [...state.claims.values()].find((c) => c.purchases.size === 0 && isRunClaim(c));
  if (unsold) {
    const reason = await buyer.attemptLatePurchase(state, unsold.claimId);
    if (reason) {
      act('BUYER', `purchase claim#${unsold.claimId} at lock → REVERTED: ${reason}  ✓ stale intel is unsellable`);
    } else {
      act('BUYER', `purchase claim#${unsold.claimId} did NOT revert — lock cliff FAILED`);
    }
  } else {
    info('no unsold claim available to demonstrate the lock cliff');
  }

  // ── attest ────────────────────────────────────────────────────────────────
  sub('9. OPERATOR attests the official inactive list — one tx settles the whole game');
  for (const g of fixture.games) await resolver.attest(g);

  // ── reveal ────────────────────────────────────────────────────────────────
  sub('10. MANDATORY REVEAL — every claim, sold or not (one is deliberately withheld)');
  state = await indexMarket(pub);
  const playerOf = (gameId: Hex, playerId: Hex) =>
    findGame(fixture, gameId)?.players.find((p) => p.playerId === playerId);
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
  sub('11. BATCH SETTLEMENT — correct sellers earn lead time × surprise of each escrow, wrong ones burn bond');
  state = await indexMarket(pub);
  await settleAndResolve(pub, (await import('./lib/chain.js')).resolverWallet(), state, isRunClaim);

  // ── slash ─────────────────────────────────────────────────────────────────
  await waitUntilChain(attestedAt + challengeWindow + revealWindow + 1, `reveal window (${revealWindow}s) to expire so the unrevealed claim can be slashed`);
  sub('12. SLASHING — the claim that was never revealed forfeits its bond');
  state = await indexMarket(pub);
  const slashed = await slashStale(pub, (await import('./lib/chain.js')).resolverWallet(), state, isRunClaim, await chainNow());
  if (slashed.length > 0) {
    state = await indexMarket(pub);
    await settleAndResolve(pub, (await import('./lib/chain.js')).resolverWallet(), state, (c) => slashed.includes(c.claimId));
  }

  // ── withdraw + ledger ─────────────────────────────────────────────────────
  sub('13. PULL PAYMENTS — everyone withdraws');
  await Promise.all([
    aggregator.withdraw(),
    forecaster.withdraw(),
    buyer.withdraw(),
    operatorWithdraw(resolver.address),
  ]);

  state = await indexMarket(pub);
  printLedger(state, { aggregator, forecaster }, fixture, isRunClaim);
  await printStakeholders(parties, opening);
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

/**
 * Per-stakeholder P&L across the run, measured from real wallet balances. Includes gas, so
 * these are what each party actually ended up with — not an idealized accounting.
 */
async function printStakeholders(
  parties: Array<{ label: string; addr: `0x${string}`; role: string }>,
  opening: Map<string, bigint>,
) {
  head('STAKEHOLDERS — net position across this run (includes gas)');
  console.log('');
  console.log(`  ${'party'.padEnd(13)}${'role'.padEnd(30)}${'opening'.padEnd(14)}${'closing'.padEnd(14)}net`);
  console.log('  ' + '─'.repeat(94));
  for (const p of parties) {
    const closing = await pub.getBalance({ address: p.addr });
    const open = opening.get(p.label) ?? 0n;
    const delta = closing - open;
    const sign = delta >= 0n ? '+' : '-';
    const mag = delta >= 0n ? delta : -delta;
    console.log(
      `  ${p.label.padEnd(13)}${p.role.padEnd(30)}${fmt(open).padEnd(14)}${fmt(closing).padEnd(14)}${sign}${fmt(mag)}`,
    );
  }
  console.log('');
  console.log('  The OPERATOR is paid on the SALE (a % of each reveal fee), never on the outcome.');
  console.log('  Forfeited bonds go to the burn sink, so the attester cannot profit from a wrong claim.');
  console.log('');
}

/** The operator sweeps its accrued protocol fees, like any other participant. */
async function operatorWithdraw(who: `0x${string}`) {
  const { send } = await import('./lib/tx.js');
  const { schedulerWallet } = await import('./lib/chain.js');
  const bal = await read<bigint>(pub, 'balances', [who]);
  if (bal === 0n) {
    info('OPERATOR has no accrued fees to withdraw');
    return;
  }
  const { hash } = await send(pub, schedulerWallet(), { functionName: 'withdraw', args: [] });
  act('OPERATOR', `withdraw ${fmt(bal)} in protocol fees`, hash);
}

async function listPass(
  state: MarketState,
  sellers: Seller[],
  fixture: ReturnType<typeof resolveFixture>,
  now: number,
) {
  // Each seller batches its own listings; the sellers run concurrently against each other.
  await Promise.all(
    sellers.map((s) => {
      const items: ListItem[] = [];
      for (const g of fixture.games) {
        for (const player of g.players) {
          if (s.hasListed(state, g.gameId, player.playerId)) continue;
          const prior = state.priors.get(`${g.gameId}:${player.playerId}`);
          items.push({
            gameId: g.gameId,
            playerId: player.playerId,
            player,
            priorTag: prior?.tag ?? player.priorTag,
            priorPractice: prior?.practice ?? player.priorPractice,
          });
        }
      }
      return s.listMany(items, now, fixture.t0);
    }),
  );
}

function printLedger(
  state: MarketState,
  sellers: { aggregator: Seller; forecaster: Seller },
  fixture: ReturnType<typeof resolveFixture>,
  inRun: (c: { gameId: string }) => boolean,
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
    `  ${'claim'.padEnd(7)}${'seller'.padEnd(13)}${'player'.padEnd(9)}${'claimed'.padEnd(11)}${'bucket'.padEnd(8)}${'actual'.padEnd(10)}${'outcome'.padEnd(12)}${'payout'.padEnd(8)}${'bond'.padEnd(13)}Δ score`,
  );
  console.log('  ' + '─'.repeat(94));

  const rows = [...state.claims.values()].filter((c) => inRun(c)).sort((a, b) => a.claimId - b.claimId);
  for (const c of rows) {
    const player = findGame(fixture, c.gameId)?.players.find((p) => p.playerId === c.playerId);
    const led = state.ledger.get(c.seller.toLowerCase());
    const entry = led?.claims.find((x) => x.claimId === c.claimId);

    let outcome = 'pending';
    if (c.slashed) outcome = 'SLASHED';
    else if (c.unwound) outcome = 'UNWOUND';
    else if (c.settled) outcome = c.settled.correct ? 'CORRECT' : 'WRONG';
    const payout = c.settled ? `${(c.settled.payoutBps / 100).toFixed(0)}%` : '—';

    const claimed = c.revealed ? Outcome[c.revealed.claimed] : '(unrevealed)';
    const bucket = c.revealed ? Bucket[c.revealed.bucket] : '—';
    const actual = c.settled ? Outcome[c.settled.actual] : player ? player.actual : '—';
    const burned = entry && entry.bondBurned > 0n ? `-${fmt(entry.bondBurned)}` : fmt(0n);

    console.log(
      `  #${String(c.claimId).padEnd(6)}${nameOf(c.seller).padEnd(13)}${(player?.slug ?? '—').padEnd(9)}${claimed.padEnd(11)}${bucket.padEnd(8)}${actual.padEnd(10)}${outcome.padEnd(12)}${payout.padEnd(8)}${burned.padEnd(13)}${entry ? (entry.delta >= 0 ? '+' : '') + entry.delta.toFixed(4) : '—'}`,
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
