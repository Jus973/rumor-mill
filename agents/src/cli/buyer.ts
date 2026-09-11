/**
 * BUYER terminal — the lineup optimizer.
 *
 *   bounty [player ...]   post bounties on the slots you are unsure about
 *   offers                the sealed claims available, and who is selling them
 *   buy <claimId>         pay — you still cannot read it
 *   open                  decrypt delivered keys and verify against the on-chain commitment
 *   decide                logit-pool the verified claims with the public prior
 *   refund / withdraw / status
 */

import { roleAccount, short } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { fmt } from '../lib/seller.js';
import { makeBuyer, REVEAL_FEE, CONTINGENT } from '../buyer.js';
import { claimsForBounty } from '../lib/indexer.js';
import { Outcome, Bucket } from '../lib/enums.js';
import { priorPActive } from '../lib/scoring.js';
import { startRepl, findPlayerBySlug, color as C, type Command, type Ctx } from './repl.js';
import type { Buyer } from '../buyer.js';

const me = roleAccount('buyer');
let buyer: Buyer | null = null;

function get(ctx: Ctx): Buyer {
  if (!ctx.fixture) throw new Error('no slate yet — the operator has not opened the week');
  if (!buyer) buyer = makeBuyer(ctx.fixture);
  return buyer;
}

/** Re-attach bounty ids after a restart, so `buy` works without re-posting. */
function adopt(ctx: Ctx, b: Buyer) {
  if (!ctx.fixture) return;
  const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
  for (const bo of ctx.state.bounties.values()) {
    if (!ids.has(bo.gameId)) continue;
    if (bo.buyer.toLowerCase() !== me.address.toLowerCase()) continue;
    const p = ctx.fixture.games.flatMap((g) => g.players).find((x) => x.playerId === bo.playerId);
    if (p) b.adoptBounty(bo.bountyId, bo.gameId, bo.playerId, p);
  }
}

const commands: Command[] = [
  {
    name: 'bounty',
    usage: 'bounty [player ...]',
    help: 'post a bounty per uncertain slot (no args = every QUESTIONABLE/DOUBTFUL player)',
    run: async (ctx) => {
      const b = get(ctx);
      console.log(C.dim(`  posting ${fmt(REVEAL_FEE)} reveal fee + ${fmt(CONTINGENT)} escrow per slot`));
      await b.registerAndPostBounties();
      adopt(ctx, b);
    },
  },
  {
    name: 'offers',
    usage: 'offers',
    help: 'sealed claims on your bounties — seller and reputation only, content hidden',
    run: async (ctx) => {
      const b = get(ctx);
      adopt(ctx, b);
      console.log('');
      for (const id of b.bountyIds()) {
        const bo = ctx.state.bounties.get(id)!;
        const p = ctx.fixture!.games.flatMap((g) => g.players).find((x) => x.playerId === bo.playerId);
        console.log(`  bounty#${id} ${C.bold(p?.slug ?? '?')}`);
        const cs = claimsForBounty(ctx.state, id);
        if (cs.length === 0) console.log(C.dim('     no offers yet'));
        for (const c of cs) {
          const rep = ctx.state.ledger.get(c.seller.toLowerCase())?.score ?? 0;
          const st = c.purchased ? (c.encKey ? C.green('bought, key delivered') : C.yellow('bought, awaiting key')) : C.cyan('FOR SALE');
          console.log(`     claim#${String(c.claimId).padEnd(4)} ${short(c.seller)} bond=${fmt(c.bond)} rep=${rep.toFixed(2)}  ${st}`);
          console.log(C.dim(`             content: ${c.ciphertext.length / 2 - 1} bytes of AES-GCM ciphertext — unreadable without K`));
        }
      }
      console.log('');
    },
  },
  {
    name: 'buy',
    usage: 'buy <claimId>',
    help: 'pay for a sealed claim — you still cannot read it until the key arrives',
    run: async (ctx, [id]) => {
      const b = get(ctx);
      adopt(ctx, b);
      const c = ctx.state.claims.get(Number(id));
      if (!c) throw new Error(`no claim #${id}`);
      await b.purchaseOne(ctx.state, Number(id));
      console.log(C.dim('  paid. the seller now owes you the decryption key (deliverKey).'));
    },
  },
  {
    name: 'open',
    usage: 'open',
    help: 'decrypt delivered keys and verify each payload against its on-chain commitment',
    run: async (ctx) => {
      const b = get(ctx);
      adopt(ctx, b);
      const opened = b.openDelivered(ctx.state);
      if (opened.length === 0) console.log(C.dim('  no new keys delivered yet'));
    },
  },
  {
    name: 'decide',
    usage: 'decide',
    help: 'ensemble the verified claims with the public prior into START/BENCH',
    run: async (ctx) => {
      const b = get(ctx);
      adopt(ctx, b);
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
      const b = get(ctx);
      adopt(ctx, b);
      await b.refundUndelivered(ctx.state);
    },
  },
  {
    name: 'withdraw',
    usage: 'withdraw',
    help: 'pull your balance out',
    run: async (ctx) => {
      const bal = await read<bigint>(ctx.pub, 'balances', [me.address]);
      if (bal === 0n) return console.log(C.dim('  nothing to withdraw'));
      await get(ctx).withdraw();
    },
  },
  {
    name: 'status',
    usage: 'status',
    help: 'your slots, what you bought, and how it settled',
    run: async (ctx) => {
      if (!ctx.fixture) return console.log(C.dim('  no slate yet'));
      const ids = new Set(ctx.fixture.games.map((g) => g.gameId));
      const mine = [...ctx.state.claims.values()].filter(
        (c) => c.buyer?.toLowerCase() === me.address.toLowerCase() && ids.has(ctx.state.bounties.get(c.bountyId)?.gameId ?? '0x'),
      );
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
      console.log(`\n  bought ${mine.length} claim(s)`);
      for (const c of mine) {
        const st = c.slashed ? C.red('SLASHED → escrow refunded') : c.refunded ? C.yellow('REFUNDED')
          : c.settled ? (c.settled.correct ? C.green('CORRECT → seller paid') : C.red('WRONG → escrow refunded')) : C.dim('pending');
        console.log(`    claim#${String(c.claimId).padEnd(4)} ${st}`);
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
    C.dim(`try: bounty → offers → buy 1 → open → decide`),
  ],
  commands,
});
