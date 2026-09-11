/**
 * SELLER terminal — a tipster agent. Sells whenever it has something.
 *
 *   scan                      what the wires say, what the model thinks, and who is bidding
 *   sell <player> [OUT] [B]   LIST a sealed claim at your ask; no bounty required
 *   deliver                   hand the key to every buyer who has paid
 *   reveal                    mandatory post-lock reveal
 *   hold <claimId>            refuse to reveal — get slashed on purpose
 *   status / withdraw
 *
 * SELLER=forecaster npm run seller  switches identity (default: aggregator/scraper).
 */

import { roleAccount, short } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { fmt, Seller, ASK_REVEAL_FEE, ASK_CONTINGENT } from '../lib/seller.js';
import { makeAggregator, aggregatorDecider } from '../seller-aggregator.js';
import { makeForecaster, forecast, MARGIN } from '../seller-forecaster.js';
import { priorPActive } from '../lib/scoring.js';
import { Outcome, Bucket } from '../lib/enums.js';
import { newsAsOf } from '../lib/fixtures.js';
import { bountiesFor, claimsBySeller } from '../lib/indexer.js';
import { startRepl, findPlayerBySlug, gameOfPlayer, color as C, type Command, type Ctx } from './repl.js';

const KIND = (process.env.SELLER ?? 'aggregator').toLowerCase() === 'forecaster' ? 'forecaster' : 'aggregator';
const ROLE = KIND === 'forecaster' ? 'forecaster' : 'aggregator';
const me = roleAccount(ROLE);
const held = new Set<number>();

let seller: Seller;
function getSeller(): Seller {
  if (!seller) {
    seller = KIND === 'forecaster'
      ? makeForecaster(({ claimId }) => held.has(claimId))
      : makeAggregator(({ claimId }) => held.has(claimId));
  }
  return seller;
}

function playerOf(ctx: Ctx) {
  return (gameId: `0x${string}`, playerId: `0x${string}`) =>
    ctx.fixture?.games.find((g) => g.gameId === gameId)?.players.find((p) => p.playerId === playerId);
}

const commands: Command[] = [
  {
    name: 'scan',
    usage: 'scan',
    help: 'what the sources are reporting, what it implies, and who is bidding',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      console.log('');
      for (const g of ctx.fixture.games) {
        for (const p of g.players) {
          const prior = ctx.state.priors.get(`${g.gameId}:${p.playerId}`);
          const p0 = priorPActive(prior?.tag ?? p.priorTag, prior?.practice ?? p.priorPractice);
          const bids = bountiesFor(ctx.state, g.gameId, p.playerId, ctx.chainNow);
          const demand = bids.length === 0
            ? C.dim('no bids')
            : C.green(`${bids.length} bid(s), budget ≤ ${fmt(bids[0].maxRevealFee)}+${fmt(bids[0].maxContingent)}`);
          console.log(`  ${C.bold(p.slug.padEnd(7))} ${p.name.padEnd(22)} public prior P(ACTIVE)=${p0.toFixed(2)}   ${demand}`);
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
    help: 'LIST a sealed claim at your ask — no bounty needed (omit args to use the strategy)',
    run: async (ctx, [slug, outcome, bucket]) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      if (!slug) throw new Error('usage: sell <player> [ACTIVE|INACTIVE] [bucket]');
      const p = findPlayerBySlug(ctx.fixture, slug);
      if (!p) throw new Error(`no player "${slug}"`);
      const g = gameOfPlayer(ctx.fixture, p);
      if (ctx.chainNow >= g.lockTime) throw new Error(`LOCKED ${ctx.chainNow - g.lockTime}s ago — listings revert at the cliff`);
      const s = getSeller();
      if (s.hasListed(ctx.state, g.gameId, p.playerId)) throw new Error(`already listed on ${p.slug}`);

      const prior = ctx.state.priors.get(`${g.gameId}:${p.playerId}`);
      const item = { gameId: g.gameId, playerId: p.playerId, player: p, priorTag: prior?.tag ?? p.priorTag, priorPractice: prior?.practice ?? p.priorPractice };
      const bids = bountiesFor(ctx.state, g.gameId, p.playerId, ctx.chainNow);
      console.log(C.dim(`  demand on ${p.slug}: ${bids.length} open bid(s). ask = ${fmt(ASK_REVEAL_FEE)} to unlock + ${fmt(ASK_CONTINGENT)} escrowed, paid only if right`));

      if (outcome) {
        // Manual claim: override the strategy entirely.
        const claimed = outcome.toUpperCase() === 'INACTIVE' ? Outcome.INACTIVE : Outcome.ACTIVE;
        const bk = Bucket[(bucket ?? 'B83').toUpperCase() as keyof typeof Bucket] ?? Bucket.B83;
        const strategy = s.decide;
        s.decide = () => ({
          claimed,
          bucket: bk,
          evidence: [{ source: 'operator-entered', ts: ctx.chainNow, text: `manual claim: ${Outcome[claimed]} @ ${Bucket[bk]}` }],
          rationale: `Manual claim entered at the ${KIND} terminal`,
        });
        console.log(C.dim(`  sealing ${Outcome[claimed]}/${Bucket[bk]} under a fresh AES key; ciphertext goes public, key does not`));
        try {
          await s.list(item, ctx.chainNow, ctx.fixture.t0);
        } finally {
          s.decide = strategy;
        }
      } else {
        console.log(C.dim(`  running the ${KIND} strategy against the current prior...`));
        const id = await s.list(item, ctx.chainNow, ctx.fixture.t0);
        if (id === null) console.log(C.dim('  strategy declined — no edge over the public report'));
      }
    },
  },
  {
    name: 'deliver',
    usage: 'deliver',
    help: 'send ECIES(buyerPubKey, K) to every buyer who has paid — THIS is the sale',
    run: async (ctx) => {
      console.log(C.dim('  the key is the product: until now each buyer holds only ciphertext'));
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
      held.add(c.claimId);
      console.log(`  ${C.red('✗')} will NOT reveal claim#${id} — it will be slashed, bond forfeit`);
      console.log(C.dim('  mandatory reveal is what makes miss history impossible to cherry-pick'));
    },
  },
  {
    name: 'reveal',
    usage: 'reveal',
    help: 'mandatory post-lock reveal of every listing (except any held)',
    run: async (ctx) => {
      if (!ctx.fixture) throw new Error('no slate yet');
      await getSeller().revealAll(ctx.state, playerOf(ctx));
    },
  },
  {
    name: 'withdraw',
    usage: 'withdraw',
    help: 'collect your share of every settled escrow, then pull your balance out',
    run: async (ctx) => {
      await getSeller().resolveAll(ctx.state);
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      if (bal === 0n) return console.log(C.dim('  nothing to withdraw'));
      await getSeller().withdraw();
    },
  },
  {
    name: 'status',
    usage: 'status',
    help: 'your listings, their buyers, and your ledger',
    run: async (ctx) => {
      if (!ctx.fixture) return console.log(C.dim('  no slate yet'));
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const mine = claimsBySeller(ctx.state, me.address).filter((c) => ids.has(c.gameId));
      console.log('');
      if (mine.length === 0) console.log(C.dim('  no listings yet'));
      for (const c of mine) {
        const p = playerOf(ctx)(c.gameId, c.playerId);
        const st = c.slashed ? C.red('SLASHED') : c.unwound ? C.yellow('UNWOUND')
          : c.settled ? (c.settled.correct ? C.green(`CORRECT → earns ${(c.settled.payoutBps / 100).toFixed(0)}% of each escrow`) : C.red('WRONG → bond burned'))
          : c.revealed ? C.cyan('revealed') : C.dim('sealed');
        console.log(`  #${String(c.claimId).padEnd(4)} ${(p?.slug ?? '?').padEnd(7)} bond=${fmt(c.bond)}  ${st}`);
        for (const pu of c.purchases.values()) {
          const ps = pu.resolved ? `resolved: +${fmt(pu.resolved.toSeller)} to you` : pu.refunded ? C.yellow('refunded (no key)') : pu.encKey ? 'key delivered' : C.yellow('PAID — key owed');
          console.log(C.dim(`         buyer ${short(pu.buyer)}  ${ps}`));
        }
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
      : `sells     CALIBRATION — models the prior; only lists when it disagrees by ≥ ${MARGIN}`,
    `ask       ${fmt(ASK_REVEAL_FEE)} to unlock + ${fmt(ASK_CONTINGENT)} escrowed — the chain scales the escrow by lead time × surprise`,
    C.dim(`try: scan → sell cmc → deliver → (after lock) reveal → withdraw`),
  ],
  commands,
});
