/**
 * BUYER — the lineup optimizer.
 *
 * Posts bids on the slots it is uncertain about, then SEARCHES: every tick it looks for
 * listings that answer a bid and buys the best-rated ones before lock (it cannot read them
 * at purchase time — reputation is the only signal it has), decrypts on key delivery,
 * verifies each payload against its on-chain commitment, and pools the survivors with the
 * public prior into one START/BENCH call per slot.
 */

import { makeBuyer, MAX_REVEAL_FEE, MAX_CONTINGENT } from '../buyer.js';
import { roleAccount } from '../lib/chain.js';
import { act, info, sub } from '../lib/log.js';
import { fmt } from '../lib/seller.js';
import { runAgent } from './runtime.js';

const NAME = 'BUYER';
const K = Number(process.env.BUYER_K ?? 2);

async function run() {
  const me = roleAccount('buyer');
  let buyerInstance: ReturnType<typeof makeBuyer> | null = null;
  let posted = false;
  let decided = false;
  let done = false;

  await runAgent({
    name: NAME,
    requiresSlate: true,
    every: 4000,
    banner: [
      `address   ${me.address}`,
      `role      DFS lineup optimizer — must lock before kickoff`,
      `strategy  bid on every QUESTIONABLE/DOUBTFUL slot; buy the top ${K} matching listings per slot`,
      `          ranked by ledger reputation, then ensemble with the public prior`,
      `budget    ≤ ${fmt(MAX_REVEAL_FEE)} to unlock + ${fmt(MAX_CONTINGENT)} escrow per listing`,
    ],
    step: async ({ state, fixture, chainNow }) => {
      if (!buyerInstance) buyerInstance = makeBuyer(fixture);
      const buyer = buyerInstance;

      if (!posted) {
        sub(`${NAME}: bidding on the uncertain slots`);
        for (const g of fixture.games) {
          for (const p of g.players) {
            info(`  ${p.name.padEnd(22)} official report: ${p.prior.tag}/${p.prior.practice} → uncertain, bidding`);
          }
        }
        await buyer.registerAndPostBounties();
        posted = true;
        return false;
      }

      const locked = fixture.games.every((g) => chainNow >= g.lockTime);

      if (!locked) {
        // Search the listings that answer our bids; buy the best. Content is unreadable here.
        await buyer.purchaseTopK(state, K);
        const opened = buyer.openDelivered(state);
        if (opened.length > 0) {
          sub(`${NAME}: keys delivered — decrypting and checking against the on-chain commitment`);
        }
        return false;
      }

      if (!decided) {
        buyer.openDelivered(state);
        const decisions = buyer.ensemble(state);
        if (decisions.length > 0) {
          sub(`${NAME}: LINEUP LOCK — final call per slot`);
          for (const d of decisions) {
            console.log(
              `             ${d.player.padEnd(22)} public prior ${d.priorPActive.toFixed(2)} → ` +
                `P(ACTIVE)=${d.pActive.toFixed(3)}   ${d.decision.padEnd(5)}  from claims [${d.sources.join(', ')}]`,
            );
          }
          info('written to out/decision.json');
          decided = true;
        }
        return false;
      }

      if (!done) {
        await buyer.refundUndelivered(state);
        const mine = buyer.myPurchases(state);
        if (mine.length > 0 && mine.every((c) => c.settled || c.slashed || c.unwound)) {
          sub(`${NAME}: settled — reclaiming escrow on every purchase`);
          const wrong = mine.filter((c) => c.settled && !c.settled.correct).length;
          const slashed = mine.filter((c) => c.slashed).length;
          info(`bought ${mine.length}; ${wrong} settled wrong, ${slashed} never revealed → escrow returned on both`);
          await buyer.resolveAll(state);
          await buyer.withdraw();
          done = true;
          act(NAME, 'done');
          return true;
        }
      }
      return false;
    },
  });
}

run().catch((e) => {
  console.error(`${NAME} failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
