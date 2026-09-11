/**
 * MANAGER — the market operator (run this one FIRST).
 *
 * Its job, and only its job:
 *   1. publish the slate           createGame     — once a week
 *   2. publish the public prior    setPriorBatch  — as the injury report updates (~3x/week)
 *   3. attest the official list    attest         — once per game, after lock
 *   4. crank settlement            settle/resolvePurchase/slash — permissionless; it pays the gas
 *   5. collect its fee             withdraw       — % of each reveal fee, never of outcomes
 *
 * It does NOT decide who is right. It publishes what the league published, and the
 * snapshot it hashes is written to out/attestations/ so anyone can check it against
 * nfl.com. The fee is charged on the sale, so the operator earns the same whether a claim
 * settles correct or wrong — it has no stake in the answer.
 */

import { makeResolver } from '../resolver.js';
import { publicClient, resolverAccount, schedulerWallet } from '../lib/chain.js';
import { read, send } from '../lib/tx.js';
import { act, info, sub, setT0 } from '../lib/log.js';
import { fmt } from '../lib/seller.js';
import { runAgent, inRun, DEFAULT_LOCK_SEC, FIXTURE_PATH, nextFreeWeek, chainTime } from './runtime.js';
import { loadFixture, resolveFixture } from '../lib/fixtures.js';
import { indexMarket, isTerminal } from '../lib/indexer.js';
import { settleAndResolve, slashStale } from '../lib/crank.js';

const NAME = 'MANAGER';
const pub = publicClient();

async function main() {
  const me = resolverAccount();
  const lockOffset = Number(process.env.DEMO_LOCK_SEC ?? DEFAULT_LOCK_SEC);
  const file = loadFixture(FIXTURE_PATH);
  const feeBps = await read<number>(pub, 'protocolFeeBps');

  // --- 1. publish the slate (the weekly job) --------------------------------
  const week = await nextFreeWeek(pub, file);
  file.week = week;

  const t0 = await chainTime(pub);
  setT0(t0);
  const scale = lockOffset / file.games[0].lockOffsetSec;
  for (const g of file.games) {
    g.lockOffsetSec = lockOffset;
    for (const p of g.players) {
      for (const n of p.news) if (n.tsOffsetSec > 0) n.tsOffsetSec = Math.round(n.tsOffsetSec * scale);
    }
  }
  const fixture = resolveFixture(file, t0);
  const resolver = makeResolver(fixture);

  console.log('\n' + '═'.repeat(96));
  console.log(`  MANAGER — market operator`);
  console.log('═'.repeat(96));
  console.log(`  address        ${me.address}`);
  console.log(`  roles          scheduler (slate + priors) · attester (outcome) · fee recipient`);
  console.log(`  take rate      ${Number(feeBps) / 100}% of each reveal fee, charged on the SALE`);
  console.log(`  NOT entitled   forfeited bonds (they burn) — so it cannot profit from a wrong claim`);
  console.log(`  publishing     season ${file.season} week ${week}, ${fixture.games.length} games\n`);

  sub('WEEKLY JOB 1/2 — publish the slate and the public injury report');
  await resolver.createGames();
  await resolver.setPriors();
  for (const g of fixture.games) {
    for (const p of g.players) {
      info(`  prior published: ${p.name.padEnd(22)} ${p.prior.tag}/${p.prior.practice}`);
    }
  }
  info('sellers are priced and scored against THIS snapshot, frozen at the moment they list');

  // --- 2. attest, settle, slash, collect ------------------------------------
  const attested = new Set<string>();
  let settledAll = false;
  const inScope = (c: { gameId: `0x${string}` }) => inRun(fixture, c.gameId);

  await runAgent({
    name: NAME,
    banner: [`watching for lock at +${lockOffset}s, then attesting the official inactive list`],
    every: 4000,
    step: async ({ chainNow }) => {
      const state = await indexMarket(pub);

      // GAME-DAY JOB: attest once lock passes.
      for (const g of fixture.games) {
        if (attested.has(g.gameId)) continue;
        if (chainNow < g.lockTime) continue;
        const onchain = state.games.get(g.gameId);
        if (onchain?.attested) {
          attested.add(g.gameId);
          continue;
        }
        if (attested.size === 0) sub('GAME DAY — the official inactive list is out; attesting it');
        await resolver.attest(g);
        attested.add(g.gameId);
      }
      if (attested.size < fixture.games.length) return false;

      // CRANK: settle everything revealed and final, pay out every purchase.
      await settleAndResolve(pub, schedulerWallet(), state, inScope, NAME);

      // CRANK: slash anything that never revealed past the deadline, then pay its buyers back.
      const slashed = await slashStale(pub, schedulerWallet(), state, inScope, chainNow, NAME);
      if (slashed.length > 0) {
        const fresh = await indexMarket(pub);
        await settleAndResolve(pub, schedulerWallet(), fresh, (c) => slashed.includes(c.claimId), NAME);
      }

      const outstanding = [...state.claims.values()].filter((c) => inScope(c) && !isTerminal(c));
      if (outstanding.length > 0) return false;

      if (!settledAll) {
        settledAll = true;
        sub('COLLECT — the operator sweeps its accrued fees');
        const bal = await read<bigint>(pub, 'balances', [me.address]);
        if (bal > 0n) {
          const { hash } = await send(pub, schedulerWallet(), { functionName: 'withdraw', args: [] });
          act(NAME, `withdraw ${fmt(bal)} in protocol fees`, hash);
        } else {
          info('no fees accrued this run');
        }
        info('every listing on the slate is settled. MANAGER done.');
      }
      return true;
    },
  });
}

main().catch((e) => {
  console.error(`${NAME} failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
