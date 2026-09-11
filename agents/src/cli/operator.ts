/**
 * OPERATOR terminal — the market manager.
 *
 * Centralized on the happy path, in the shape a rollup sequencer is: trusted for liveness
 * and speed, never for custody. Commands:
 *
 *   open                       publish a fresh week: games + the public injury report
 *   prior <player> <tag> <practice>   revise the public report mid-week
 *   attest <game> [slugs...]   MANUAL OVERRIDE — you type who was inactive
 *   oracle                     attest from the fixture feed instead (the "oracle" path)
 *   settle / slash / fees / unwind / status
 *
 * `attest` is the manual override: whatever you type becomes ground truth, which is exactly
 * how you make a seller right or wrong on camera.
 */

import { resolverAccount, schedulerWallet, short } from '../lib/chain.js';
import { read, send } from '../lib/tx.js';
import { settleAndResolve, slashStale } from '../lib/crank.js';
import { setT0 } from '../lib/log.js';
import { fmt } from '../lib/seller.js';
import { makeResolver } from '../resolver.js';
import { loadFixture, resolveFixture, inactiveListFor } from '../lib/fixtures.js';
import { ReportTag, Practice, Outcome } from '../lib/enums.js';
import { gameIdOf } from '../lib/chain.js';
import { keccak256, toHex } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  startRepl, findSlate, findPlayerBySlug, chainTime, color as C,
  FIXTURE_PATH, LOCK_SEC, type Command, type Ctx,
} from './repl.js';

const me = resolverAccount();

function gameByToken(ctx: Ctx, token?: string) {
  if (!ctx.fixture) throw new Error('no slate — run "open" first');
  if (!token) return ctx.fixture.games;
  const t = token.toLowerCase();
  const g = ctx.fixture.games.find(
    (x) => x.label.toLowerCase() === t || x.home.toLowerCase() === t || x.away.toLowerCase() === t,
  );
  if (!g) throw new Error(`no game matching "${token}" (try: ${ctx.fixture.games.map((x) => x.label).join(', ')})`);
  return [g];
}

const commands: Command[] = [
  {
    name: 'open',
    usage: 'open',
    help: 'publish a fresh week: create games + the public injury report',
    run: async (ctx) => {
      const file = loadFixture(FIXTURE_PATH);
      let week = file.week;
      for (let off = 0; off < 512; off++) {
        const id = gameIdOf(file.season, file.week + off, file.games[0].home, file.games[0].away);
        const g = await read<readonly [bigint, ...unknown[]]>(ctx.pub, 'games', [id]);
        if (g[0] === 0n) { week = file.week + off; break; }
      }
      file.week = week;
      const scale = LOCK_SEC / file.games[0].lockOffsetSec;
      for (const g of file.games) {
        g.lockOffsetSec = LOCK_SEC;
        for (const p of g.players) {
          for (const n of p.news) if (n.tsOffsetSec > 0) n.tsOffsetSec = Math.round(n.tsOffsetSec * scale);
        }
      }
      const t0 = await chainTime(ctx.pub);
      setT0(t0);
      const fixture = resolveFixture(file, t0);
      const r = makeResolver(fixture);
      console.log(C.dim(`publishing season ${file.season} week ${week}, lock in ${LOCK_SEC}s`));
      await r.createGames();
      await r.setPriors();
      console.log('');
      for (const g of fixture.games) {
        for (const p of g.players) {
          console.log(`    ${p.slug.padEnd(7)} ${p.name.padEnd(22)} ${C.yellow(`${p.prior.tag}/${p.prior.practice}`)}`);
        }
      }
      console.log(C.dim('\n  sellers are scored against THIS snapshot, frozen when they commit'));
    },
  },
  {
    name: 'prior',
    usage: 'prior <player> <tag> <practice>',
    help: 'revise the public injury report (e.g. prior cmc DOUBTFUL DNP)',
    run: async (ctx, [slug, tag, practice]) => {
      if (!ctx.fixture) throw new Error('no slate — run "open" first');
      if (!slug || !tag || !practice) throw new Error('usage: prior <player> <tag> <practice>');
      const p = findPlayerBySlug(ctx.fixture, slug);
      if (!p) throw new Error(`no player "${slug}"`);
      const t = ReportTag[tag.toUpperCase() as keyof typeof ReportTag];
      const pr = Practice[practice.toUpperCase() as keyof typeof Practice];
      if (t === undefined) throw new Error(`bad tag (NONE|PROBABLE|QUESTIONABLE|DOUBTFUL|OUT)`);
      if (pr === undefined) throw new Error(`bad practice (UNKNOWN|FULL|LIMITED|DNP)`);
      const g = ctx.fixture.games.find((x) => x.players.some((y) => y.playerId === p.playerId))!;
      const { hash } = await send(ctx.pub, schedulerWallet(), {
        functionName: 'setPrior',
        args: [g.gameId, p.playerId, t, pr],
      });
      console.log(`  ${C.green('✓')} ${p.name} → ${tag.toUpperCase()}/${practice.toUpperCase()}  ${C.dim(hash)}`);
      console.log(C.dim('  claims committed from now on are scored against the NEW prior'));
    },
  },
  {
    name: 'attest',
    usage: 'attest <game> [slug ...]',
    help: 'MANUAL OVERRIDE: you declare who was inactive (no args = nobody)',
    run: async (ctx, [gameTok, ...slugs]) => {
      if (!ctx.fixture) throw new Error('no slate — run "open" first');
      if (!gameTok) throw new Error(`usage: attest <game> [slugs...] — games: ${ctx.fixture.games.map((g) => g.label).join(', ')}`);
      const [g] = gameByToken(ctx, gameTok);
      if (ctx.chainNow < g.lockTime) throw new Error(`lock is ${g.lockTime - ctx.chainNow}s away; cannot attest before lock`);

      const players = slugs.map((s) => {
        const p = findPlayerBySlug(ctx.fixture!, s);
        if (!p) throw new Error(`no player "${s}"`);
        return p;
      });
      const ids = players.map((p) => p.playerId);

      const snapshot = {
        source: 'MANUAL OVERRIDE (operator-entered)',
        game: g.label,
        gameId: g.gameId,
        attestedBy: me.address,
        inactive: players.map((p) => ({ name: p.name, gsisId: p.gsisId, playerId: p.playerId })),
      };
      const json = JSON.stringify(snapshot, null, 2);
      const reportHash = keccak256(toHex(json));
      mkdirSync('out/attestations', { recursive: true });
      writeFileSync(`out/attestations/${g.gameId}.json`, json + '\n');

      console.log(C.yellow(`  MANUAL OVERRIDE — the operator is declaring ground truth by hand`));
      console.log(`  ${g.label} inactive = [${players.map((p) => p.slug).join(', ') || '—'}]`);
      const { hash } = await send(ctx.pub, schedulerWallet(), {
        functionName: 'attest',
        args: [g.gameId, reportHash, ids],
      });
      console.log(`  ${C.green('✓')} attested  ${C.dim(hash)}`);
      console.log(C.dim(`  snapshot → out/attestations/${g.gameId.slice(0, 12)}….json (rehash to verify)`));
      console.log(C.dim(`  every claim on ${g.label} now resolves against this list`));
    },
  },
  {
    name: 'oracle',
    usage: 'oracle <game>',
    help: 'attest from the fixture feed instead of by hand (the non-override path)',
    run: async (ctx, [gameTok]) => {
      const games = gameByToken(ctx, gameTok);
      for (const g of games) {
        if (ctx.chainNow < g.lockTime) throw new Error(`lock is ${g.lockTime - ctx.chainNow}s away`);
        const r = makeResolver(ctx.fixture!);
        console.log(C.cyan(`  reading the feed for ${g.label} ...`));
        const list = inactiveListFor(g);
        console.log(C.dim(`  feed says inactive = [${g.players.filter((p) => list.includes(p.playerId)).map((p) => p.slug).join(', ') || '—'}]`));
        await r.attest(g);
      }
    },
  },
  {
    name: 'settle',
    usage: 'settle',
    help: 'crank settlement: settle every revealed listing, then pay out every purchase',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate');
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const r = await settleAndResolve(ctx.pub, schedulerWallet(), ctx.state, (c) => ids.has(c.gameId), 'OPERATOR');
      if (r.settled === 0 && r.resolved === 0) console.log(C.dim('  nothing revealed-and-final to settle'));
      else console.log(C.dim(`  ${r.settled} listing(s) settled, ${r.resolved} purchase(s) paid out — correct sellers earn lead time × surprise of each escrow`));
    },
  },
  {
    name: 'slash',
    usage: 'slash',
    help: 'forfeit the bond of anything that never revealed past the deadline',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate');
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const done = await slashStale(ctx.pub, schedulerWallet(), ctx.state, (c) => ids.has(c.gameId), ctx.chainNow, 'OPERATOR');
      if (done.length === 0) console.log(C.dim('  nothing slashable yet (reveal window still open, or nothing unrevealed)'));
      else await settleAndResolve(ctx.pub, schedulerWallet(), ctx.state, (c) => done.includes(c.claimId), 'OPERATOR');
    },
  },
  {
    name: 'unwind',
    usage: 'unwind <game>',
    help: 'ESCAPE HATCH: abandon an un-attested game, everyone takes their money back',
    run: async (ctx, [gameTok]) => {
      const [g] = gameByToken(ctx, gameTok);
      const { hash } = await send(ctx.pub, schedulerWallet(), { functionName: 'forceUnwind', args: [g.gameId] });
      console.log(`  ${C.green('✓')} ${g.label} unwound (permissionless — anyone could have done this)  ${C.dim(hash)}`);
      const ids = [...ctx.state.claims.values()].filter((c) => c.gameId === g.gameId);
      for (const c of ids) {
        try {
          await send(ctx.pub, schedulerWallet(), { functionName: 'unwindClaim', args: [BigInt(c.claimId)] });
          console.log(`  ${C.green('✓')} claim#${c.claimId} unwound — bond to seller, nothing burned`);
        } catch { /* already terminal */ }
      }
      const fresh = await (await import('../lib/indexer.js')).indexMarket(ctx.pub);
      await settleAndResolve(ctx.pub, schedulerWallet(), fresh, (c) => c.gameId === g.gameId, 'OPERATOR');
    },
  },
  {
    name: 'fees',
    usage: 'fees',
    help: 'withdraw accrued protocol fees',
    run: async (ctx) => {
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      if (bal === 0n) return console.log(C.dim('  no fees accrued'));
      const { hash } = await send(ctx.pub, schedulerWallet(), { functionName: 'withdraw', args: [] });
      console.log(`  ${C.green('✓')} withdrew ${fmt(bal)} in protocol fees  ${C.dim(hash)}`);
      console.log(C.dim('  charged on the SALE, never the outcome — the operator has no stake in who is right'));
    },
  },
  {
    name: 'status',
    usage: 'status',
    help: 'the whole market at a glance',
    run: async (ctx) => {
      if (!ctx.fixture) return console.log(C.dim('  no slate published — run "open"'));
      const feeBps = await read<number>(ctx.pub, 'protocolFeeBps');
      console.log('');
      for (const g of ctx.fixture.games) {
        const og = ctx.state.games.get(g.gameId);
        const left = g.lockTime - ctx.chainNow;
        const st = og?.unwound ? C.red('UNWOUND') : og?.attested ? C.green('ATTESTED') : left > 0 ? C.green(`open, lock in ${left}s`) : C.yellow('LOCKED, awaiting attestation');
        console.log(`  ${C.bold(g.label)}  ${st}`);
        for (const p of g.players) {
          const pr = ctx.state.priors.get(`${g.gameId}:${p.playerId}`);
          const inactive = og?.inactivePlayerIds.includes(p.playerId);
          const truth = og?.attested ? (inactive ? C.red('INACTIVE') : C.green('ACTIVE')) : C.dim('unknown');
          console.log(`    ${p.slug.padEnd(7)} prior=${ReportTag[pr?.tag ?? 0]}/${Practice[pr?.practice ?? 0]}  actual=${truth}`);
        }
      }
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const bids = [...ctx.state.bounties.values()].filter((b) => ids.has(b.gameId) && !b.cancelled);
      console.log(`\n  ${bids.length} open bid(s) on this slate`);
      const claims = [...ctx.state.claims.values()].filter((c) => ids.has(c.gameId));
      console.log(`  ${claims.length} listing(s) on this slate`);
      for (const c of claims) {
        const p = ctx.fixture.games.flatMap((g) => g.players).find((x) => x.playerId === c.playerId);
        const state = c.slashed ? C.red('SLASHED') : c.unwound ? C.yellow('UNWOUND')
          : c.settled ? (c.settled.correct ? C.green(`CORRECT (${(c.settled.payoutBps / 100).toFixed(0)}% payout)`) : C.red('WRONG'))
          : c.revealed ? `revealed ${Outcome[c.revealed.claimed]}` : C.dim(`sealed, ${c.purchases.size} buyer(s)`);
        console.log(`    #${String(c.claimId).padEnd(4)} ${short(c.seller)} ${(p?.slug ?? '?').padEnd(7)} bond=${fmt(c.bond)} ask=${fmt(c.askRevealFee + c.askContingent)}  ${state}`);
      }
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      console.log(`\n  operator fees accrued: ${fmt(bal)} (${Number(feeBps) / 100}% of each reveal fee)\n`);
    },
  },
];

startRepl({
  role: 'OPERATOR',
  banner: [
    `address   ${me.address}`,
    `roles     scheduler (slate + priors) · attester (outcome) · fee recipient`,
    `${C.yellow('attest')}    is a MANUAL OVERRIDE — whatever you type becomes ground truth`,
    `${C.cyan('oracle')}    attests from the fixture feed instead`,
  ],
  commands,
});
