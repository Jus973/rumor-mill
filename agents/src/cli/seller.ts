/**
 * SELLER terminal — a tipster agent.
 *
 *   scan                      what the wires are saying (and what the model thinks)
 *   sell <player> [OUT] [B]   fill a bounty with a SEALED claim; content hidden until paid
 *   deliver                   hand over the key for anything that has been bought
 *   reveal [claimId]          mandatory post-lock reveal
 *   hold <claimId>            refuse to reveal — get slashed on purpose
 *   status / withdraw
 *
 * SELLER=forecaster npm run seller  switches identity (default: aggregator/scraper).
 */

import { roleAccount, short } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { fmt, Seller } from '../lib/seller.js';
import { makeAggregator, aggregatorDecider } from '../seller-aggregator.js';
import { makeForecaster, forecasterDecider, forecast, MARGIN } from '../seller-forecaster.js';
import { priorPActive } from '../lib/scoring.js';
import { Outcome, Bucket } from '../lib/enums.js';
import { newsAsOf } from '../lib/fixtures.js';
import { claimsForBounty } from '../lib/indexer.js';
import { startRepl, findPlayerBySlug, color as C, type Command, type Ctx } from './repl.js';

const KIND = (process.env.SELLER ?? 'aggregator').toLowerCase() === 'forecaster' ? 'forecaster' : 'aggregator';
const ROLE = KIND === 'forecaster' ? 'forecaster' : 'aggregator';
const me = roleAccount(ROLE);
const held = new Set<number>();

let seller: Seller;
function getSeller(): Seller {
  if (!seller) {
    seller = KIND === 'forecaster'
      ? makeForecaster(({ bountyId }) => held.has(bountyId))
      : makeAggregator(({ bountyId }) => held.has(bountyId));
  }
  return seller;
}

function myBounties(ctx: Ctx) {
  if (!ctx.fixture) throw new Error('no slate yet — the operator has not opened the week');
  const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
  return [...ctx.state.bounties.values()].filter((b) => ids.has(b.gameId));
}

const commands: Command[] = [
  {
    name: 'scan',
    usage: 'scan',
    help: 'what the sources are reporting, and what it implies',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      console.log('');
      for (const g of ctx.fixture.games) {
        for (const p of g.players) {
          const prior = ctx.state.priors.get(`${g.gameId}:${p.playerId}`);
          const p0 = priorPActive(prior?.tag ?? p.priorTag, prior?.practice ?? p.priorPractice);
          console.log(`  ${C.bold(p.slug.padEnd(7))} ${p.name.padEnd(22)} public prior P(ACTIVE)=${p0.toFixed(2)}`);
          if (KIND === 'aggregator') {
            const items = newsAsOf(p, ctx.fixture.t0, ctx.chainNow);
            if (items.length === 0) console.log(C.dim(`          nothing on the wires yet — no edge`));
            for (const n of items) console.log(`          ${C.cyan('HIT')} [${n.source}] "${n.text}"`);
            const d = aggregatorDecider({ player: p, priorTag: prior?.tag ?? p.priorTag, priorPractice: prior?.practice ?? p.priorPractice, now: ctx.chainNow, t0: ctx.fixture.t0 });
            if (d) console.log(`          ⇒ ${C.yellow(`${Outcome[d.claimed]}/${Bucket[d.bucket]}`)}`);
          } else {
            const { p: pm, steps } = forecast(p, p0);
            for (const s of steps) console.log(C.dim(`          ${s}`));
            const disagree = Math.abs(pm - p0);
            console.log(`          model P(ACTIVE)=${pm.toFixed(2)}  disagreement=${disagree.toFixed(2)} ` +
              (disagree >= MARGIN ? C.yellow('≥ margin → worth selling') : C.dim('< margin → agreeing with the report earns ~0')));
          }
        }
      }
      console.log('');
    },
  },
  {
    name: 'sell',
    usage: 'sell <player> [ACTIVE|INACTIVE] [B55|B68|B83|B95]',
    help: 'fill the bounty with a SEALED claim (omit args to use the strategy)',
    run: async (ctx, [slug, outcome, bucket]) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      if (!slug) throw new Error('usage: sell <player> [ACTIVE|INACTIVE] [bucket]');
      const p = findPlayerBySlug(ctx.fixture, slug);
      if (!p) throw new Error(`no player "${slug}"`);
      const b = myBounties(ctx).find((x) => x.playerId === p.playerId);
      if (!b) throw new Error(`no open bounty on ${p.slug} — the buyer has not posted one`);
      const g = ctx.fixture.games.find((x) => x.gameId === b.gameId)!;
      if (ctx.chainNow >= g.lockTime) throw new Error(`LOCKED ${ctx.chainNow - g.lockTime}s ago — fills revert at the cliff`);
      if (claimsForBounty(ctx.state, b.bountyId).some((c) => c.seller.toLowerCase() === me.address.toLowerCase())) {
        throw new Error(`already filled bounty#${b.bountyId}`);
      }

      const prior = ctx.state.priors.get(`${b.gameId}:${b.playerId}`);
      const priorTag = prior?.tag ?? p.priorTag;
      const priorPractice = prior?.practice ?? p.priorPractice;

      const s = getSeller();
      if (outcome) {
        // Manual claim: override the strategy entirely.
        const claimed = outcome.toUpperCase() === 'INACTIVE' ? Outcome.INACTIVE : Outcome.ACTIVE;
        const bk = Bucket[(bucket ?? 'B83').toUpperCase() as keyof typeof Bucket] ?? Bucket.B83;
        const forced = () => ({
          claimed,
          bucket: bk,
          evidence: [{ source: 'operator-entered', ts: ctx.chainNow, text: `manual claim: ${Outcome[claimed]} @ ${Bucket[bk]}` }],
          rationale: `Manual claim entered at the ${KIND} terminal`,
        });
        const manual = KIND === 'forecaster'
          ? makeForecaster(({ bountyId }) => held.has(bountyId))
          : makeAggregator(({ bountyId }) => held.has(bountyId));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (manual as any).decide = forced;
        console.log(C.dim(`  sealing ${Outcome[claimed]}/${Bucket[bk]} under a fresh AES key; ciphertext goes public, key does not`));
        await manual.fillMany([{ b, player: p, priorTag, priorPractice }], ctx.chainNow, ctx.fixture.t0);
        seller = manual;
      } else {
        console.log(C.dim(`  running the ${KIND} strategy against the current prior...`));
        const ids = await s.fillMany([{ b, player: p, priorTag, priorPractice }], ctx.chainNow, ctx.fixture.t0);
        if (ids.length === 0) console.log(C.dim('  strategy declined — no edge over the public report'));
      }
    },
  },
  {
    name: 'deliver',
    usage: 'deliver',
    help: 'send ECIES(buyerPubKey, K) for every claim that has been bought — THIS is the sale',
    run: async (ctx) => {
      console.log(C.dim('  the key is the product: until now the buyer holds only ciphertext'));
      await getSeller().deliverKeys(ctx.state, ctx.chainNow);
    },
  },
  {
    name: 'hold',
    usage: 'hold <claimId>',
    help: 'refuse to reveal this claim — demonstrates slashing',
    run: async (ctx, [id]) => {
      const c = ctx.state.claims.get(Number(id));
      if (!c) throw new Error(`no claim #${id}`);
      held.add(c.bountyId);
      console.log(`  ${C.red('✗')} will NOT reveal claim#${id} — it will be slashed, bond forfeit`);
      console.log(C.dim('  mandatory reveal is what makes miss history impossible to cherry-pick'));
    },
  },
  {
    name: 'reveal',
    usage: 'reveal',
    help: 'mandatory post-lock reveal of every claim (except any held)',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      await getSeller().revealAll(ctx.state, (bountyId) => {
        const b = ctx.state.bounties.get(bountyId);
        if (!b) return undefined;
        return ctx.fixture!.games.find((g) => g.gameId === b.gameId)?.players.find((p) => p.playerId === b.playerId);
      });
    },
  },
  {
    name: 'withdraw',
    usage: 'withdraw',
    help: 'pull your balance out',
    run: async (ctx) => {
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      if (bal === 0n) return console.log(C.dim('  nothing to withdraw'));
      await getSeller().withdraw();
    },
  },
  {
    name: 'status',
    usage: 'status',
    help: 'your claims and your ledger',
    run: async (ctx) => {
      if (!ctx.fixture) return console.log(C.dim('  no slate yet'));
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const mine = [...ctx.state.claims.values()].filter(
        (c) => c.seller.toLowerCase() === me.address.toLowerCase() && ids.has(ctx.state.bounties.get(c.bountyId)?.gameId ?? '0x'),
      );
      console.log('');
      console.log(C.dim(`  open bounties: ${myBounties(ctx).map((b) => `#${b.bountyId}`).join(' ') || 'none'}`));
      if (mine.length === 0) console.log(C.dim('  no claims yet'));
      for (const c of mine) {
        const b = ctx.state.bounties.get(c.bountyId)!;
        const p = ctx.fixture.games.flatMap((g) => g.players).find((x) => x.playerId === b.playerId);
        const st = c.slashed ? C.red('SLASHED') : c.refunded ? C.yellow('REFUNDED')
          : c.settled ? (c.settled.correct ? C.green('CORRECT') : C.red('WRONG'))
          : c.revealed ? C.cyan('revealed') : c.encKey ? 'sold + key delivered' : c.purchased ? 'sold, key owed' : C.dim('sealed, unsold');
        console.log(`  #${String(c.claimId).padEnd(4)} ${(p?.slug ?? '?').padEnd(7)} bond=${fmt(c.bond)}  ${st}`);
      }
      const led = ctx.state.ledger.get(me.address.toLowerCase());
      if (led) console.log(`\n  ledger: score ${led.score >= 0 ? '+' : ''}${led.score.toFixed(4)}  n=${led.n}  hits=${led.hits}  burned=${fmt(led.bondBurned)}`);
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      console.log(`  withdrawable: ${fmt(bal)}\n`);
    },
  },
];

startRepl({
  role: `SELLER (${KIND})`,
  banner: [
    `address   ${me.address}`,
    KIND === 'aggregator'
      ? `sells     LEAD TIME — scrapes local reporting before national outlets republish`
      : `sells     CALIBRATION — models the prior; only bids when it disagrees by ≥ ${MARGIN}`,
    C.dim(`try: scan → sell cmc → deliver → (after lock) reveal`),
  ],
  commands,
});
