/**
 * BUYER terminal — the lineup optimizer. Bids whenever it wants to search.
 *
 *   bounty [player ...]   post a bid per uncertain slot: "I'll pay up to X for intel on Y"
 *   search                the listings that answer your bids — seller, ask, rep; not content
 *   buy <claimId>         pay the ask — you still cannot read it
 *   open                  decrypt delivered keys and verify against the on-chain commitment
 *   decide                logit-pool the verified claims with the public prior
 *   refund / withdraw / status
 */

import { roleAccount, short } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { fmt } from '../lib/seller.js';
import { makeBuyer, MAX_REVEAL_FEE, MAX_CONTINGENT, scoreOf } from '../buyer.js';
import { claimsFor, matchesBounty, purchaseBy } from '../lib/indexer.js';
import { priorPActive } from '../lib/scoring.js';
import { startRepl, findPlayerBySlug, color as C, type Command, type Ctx } from './repl.js';
import type { Buyer } from '../buyer.js';

const me = roleAccount('buyer');
let buyer: Buyer | null = null;

function get(ctx: Ctx): Buyer {
  if (!ctx.fixture) throw new Error('no slate yet — the operator has not opened the week');
  if (!buyer) buyer = makeBuyer(ctx.fixture);
  adopt(ctx, buyer);
  return buyer;
}

/** Re-attach bounty ids after a restart, so `search` and `buy` work without re-posting. */
function adopt(ctx: Ctx, b: Buyer) {
  if (!ctx.fixture) return;
  const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
  for (const bo of ctx.state.bounties.values()) {
    if (!ids.has(bo.gameId) || bo.cancelled) continue;
    if (bo.buyer.toLowerCase() !== me.address.toLowerCase()) continue;
    const p = ctx.fixture.games.flatMap((g) => g.players).find((x) => x.playerId === bo.playerId);
    if (p) b.adoptBounty(bo.bountyId, bo.gameId, bo.playerId, p);
  }
}

const commands: Command[] = [
  {
    name: 'bounty',
    usage: 'bounty [player ...]',
    help: 'post a bid per uncertain slot (no args = every QUESTIONABLE/DOUBTFUL player)',
    run: async (ctx, slugs) => {
      const b = get(ctx);
      const only = slugs.length ? slugs.map((s) => {
        const p = findPlayerBySlug(ctx.fixture!, s);
        if (!p) throw new Error(`no player "${s}"`);
        return p;
      }) : undefined;
      console.log(C.dim(`  bidding up to ${fmt(MAX_REVEAL_FEE)} to unlock + ${fmt(MAX_CONTINGENT)} escrow per slot — nothing moves until you buy`));
      await b.registerAndPostBounties(only);
    },
  },
  {
    name: 'search',
    usage: 'search',
    help: 'listings that answer your bids — seller, ask, bond, reputation; content hidden',
    run: async (ctx) => {
      const b = get(ctx);
      console.log('');
      for (const id of b.bountyIds()) {
        const bo = ctx.state.bounties.get(id)!;
        const p = ctx.fixture!.games.flatMap((g) => g.players).find((x) => x.playerId === bo.playerId);
        console.log(`  bid#${id} ${C.bold(p?.slug ?? '?')}  budget ≤ ${fmt(bo.maxRevealFee)}+${fmt(bo.maxContingent)}`);
        const all = claimsFor(ctx.state, bo.gameId, bo.playerId).filter((c) => !c.revealed && !c.settled && !c.slashed);
        if (all.length === 0) console.log(C.dim('     no listings yet'));
        for (const c of all) {
          const rep = scoreOf(ctx.state.ledger, c.seller);
          const mine = purchaseBy(c, me.address);
          const st = !matchesBounty(c, bo) ? C.red('over budget')
            : mine ? (mine.encKey ? C.green('bought, key delivered') : C.yellow('bought, awaiting key')) : C.cyan('FOR SALE');
          console.log(`     claim#${String(c.claimId).padEnd(4)} ${short(c.seller)} ask=${fmt(c.askRevealFee)}+${fmt(c.askContingent)} bond=${fmt(c.bond)} rep=${rep.toFixed(2)} buyers=${c.purchases.size}  ${st}`);
          console.log(C.dim(`             content: ${c.ciphertext.length / 2 - 1} bytes of AES-GCM ciphertext — unreadable without K`));
        }
      }
      console.log('');
    },
  },
  {
    name: 'buy',
    usage: 'buy <claimId>',
    help: 'pay the ask for a sealed listing — you still cannot read it until the key arrives',
    run: async (ctx, [id]) => {
      const b = get(ctx);
      await b.purchaseOne(ctx.state, Number(id));
      console.log(C.dim('  paid. the seller now owes you the decryption key (deliverKey).'));
    },
  },
  {
    name: 'open',
    usage: 'open',
    help: 'decrypt delivered keys and verify each payload against its on-chain commitment',
    run: async (ctx) => {
      const opened = get(ctx).openDelivered(ctx.state);
      if (opened.length === 0) console.log(C.dim('  no new keys delivered yet'));
    },
  },
  {
    name: 'decide',
    usage: 'decide',
    help: 'ensemble the verified claims with the public prior into START/BENCH',
    run: async (ctx) => {
      const b = get(ctx);
      b.openDelivered(ctx.state);
      const ds = b.ensemble(ctx.state);
      console.log('');
      for (const d of ds) {
        const col = d.decision === 'START' ? C.green : C.red;
        console.log(`  ${d.player.padEnd(22)} prior ${d.priorPActive.toFixed(2)} → P(ACTIVE)=${d.pActive.toFixed(3)}  ${col(d.decision)}`);
        for (const s of d.detail) {
          const who = s.claimId < 0 ? 'public prior' : `claim#${s.claimId}`;
          console.log(C.dim(`      ${who.padEnd(14)} p=${s.p.toFixed(3)}  weight=${s.weight.toFixed(2)}`));
        }
      }
      console.log(C.dim('\n  written to out/decision.json\n'));
    },
  },
  {
    name: 'refund',
    usage: 'refund',
    help: 'reclaim fee + escrow on anything bought whose key never arrived',
    run: async (ctx) => {
      await get(ctx).refundUndelivered(ctx.state);
    },
  },
  {
    name: 'withdraw',
    usage: 'withdraw',
    help: 'reclaim escrow on every settled purchase, then pull your balance out',
    run: async (ctx) => {
      const b = get(ctx);
      await b.resolveAll(ctx.state);
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      if (bal === 0n) return console.log(C.dim('  nothing to withdraw'));
      await b.withdraw();
    },
  },
  {
    name: 'status',
    usage: 'status',
    help: 'your slots, what you bought, and how it settled',
    run: async (ctx) => {
      if (!ctx.fixture) return console.log(C.dim('  no slate yet'));
      const b = get(ctx);
      console.log('');
      for (const g of ctx.fixture.games) {
        for (const p of g.players) {
          const pr = ctx.state.priors.get(`${g.gameId}:${p.playerId}`);
          const og = ctx.state.games.get(g.gameId);
          const truth = og?.attested ? (og.inactivePlayerIds.includes(p.playerId) ? C.red('INACTIVE') : C.green('ACTIVE')) : C.dim('unknown');
          const p0 = pr ? priorPActive(pr.tag, pr.practice) : 0.5;
          console.log(`  ${p.slug.padEnd(7)} ${p.name.padEnd(22)} prior P(ACTIVE)=${p0.toFixed(2)}  actual=${truth}`);
        }
      }
      const mine = b.myPurchases(ctx.state);
      console.log(`\n  bought ${mine.length} claim(s)`);
      for (const c of mine) {
        const pu = purchaseBy(c, me.address)!;
        const paid = pu.revealFee + pu.contingent;
        const st = pu.refunded ? C.yellow('REFUNDED — no key')
          : c.slashed ? C.red('SLASHED → escrow back')
          : c.settled ? (c.settled.correct
              ? C.green(`CORRECT → seller earned ${(c.settled.payoutBps / 100).toFixed(0)}% of escrow`) + (pu.resolved ? C.dim(`, ${fmt(pu.resolved.toBuyer)} back to you`) : '')
              : C.red('WRONG → escrow back'))
          : C.dim('pending');
        console.log(`    claim#${String(c.claimId).padEnd(4)} paid ${fmt(paid)}  ${st}`);
      }
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      console.log(`\n  withdrawable: ${fmt(bal)}\n`);
    },
  },
];

startRepl({
  role: 'BUYER',
  banner: [
    `address   ${me.address}`,
    `role      DFS lineup optimizer — must lock before kickoff`,
    C.dim(`try: bounty → search → buy 1 → open → decide`),
  ],
  commands,
});
