/**
 * SCRAPER — the aggregator seller. Sells LEAD TIME.
 *
 * Polls local beat reporting, practice observations and travel notes. When something breaks
 * that the national outlets have not republished yet, it turns that into a typed, sealed,
 * bonded claim and fills any open bounty on that player.
 *
 * The "internet" here is the fixture's news items, gated by the shared clock — an item is
 * invisible until its timestamp passes, which is exactly the lead-time edge being sold.
 * Swap `pollSources()` for real HTTP and nothing else changes.
 */

import { makeAggregator } from '../seller-aggregator.js';
import { publicClient, roleAccount } from '../lib/chain.js';
import { act, info, sub } from '../lib/log.js';
import { newsAsOf, type ResolvedPlayer, type ResolvedFixture } from '../lib/fixtures.js';
import { claimsForBounty } from '../lib/indexer.js';
import { runAgent, inRun } from './runtime.js';
import { decideFromNews } from '../seller-aggregator.js';
import { Outcome, Bucket } from '../lib/enums.js';
import type { EvidenceItem } from '../lib/crypto.js';

const NAME = 'SCRAPER';
const SOURCES = ['local-beat', 'team-radio', 'practice-report', 'player-social'];

/** Stand-in for real scraping. Returns whatever has "published" as of now. */
function pollSources(p: ResolvedPlayer, f: ResolvedFixture, now: number): EvidenceItem[] {
  return newsAsOf(p, f.t0, now).map((n) => ({ source: n.source, ts: f.t0 + n.tsOffsetSec, text: n.text }));
}

async function main() {
  const seller = makeAggregator();
  const me = roleAccount('aggregator');
  const seen = new Set<string>();
  let revealedAfterLock = false;

  await runAgent({
    name: NAME,
    requiresSlate: true,
    every: 4000,
    banner: [
      `address   ${me.address}`,
      `role      tipster agent — sells LEAD TIME`,
      `strategy  scrape local reporting; fill a bounty only when something has actually broken`,
      `sources   ${SOURCES.join(', ')}`,
    ],
    step: async ({ state, fixture, chainNow }) => {
      const openBounties = [...state.bounties.values()].filter((b) => inRun(state, fixture, b.bountyId));
      if (openBounties.length === 0) {
        if (seen.size === 0) info('no open bounties yet — waiting for a buyer');
        return false;
      }

      // ---- the scrape pass ----
      const toFill = [];
      for (const b of openBounties) {
        const g = fixture.games.find((x) => x.gameId === b.gameId);
        const player = g?.players.find((p) => p.playerId === b.playerId);
        if (!player) continue;

        const already = claimsForBounty(state, b.bountyId).some(
          (c) => c.seller.toLowerCase() === me.address.toLowerCase(),
        );
        if (already) continue;

        const items = pollSources(player, fixture, chainNow);
        const key = `${b.bountyId}:${items.length}`;
        if (!seen.has(key)) {
          seen.add(key);
          info(`polling ${SOURCES.length} sources for ${player.name} (${player.team}) ...`);
          if (items.length === 0) {
            info(`  └ nothing published yet — no edge, not bidding`);
          } else {
            for (const it of items) info(`  └ HIT [${it.source}] "${it.text}"`);
            const d = decideFromNews(items);
            if (d) {
              info(`  └ rules engine ⇒ ${Outcome[d.claimed]} @ ${Bucket[d.bucket]}  (${d.rationale.split('—')[0].trim()})`);
            }
          }
        }
        if (items.length > 0) {
          const prior = state.priors.get(`${b.gameId}:${b.playerId}`);
          toFill.push({
            b,
            player,
            priorTag: prior?.tag ?? player.priorTag,
            priorPractice: prior?.practice ?? player.priorPractice,
          });
        }
      }

      if (toFill.length > 0) {
        sub(`${NAME}: filling ${toFill.length} bounty(s) with sealed claims`);
        await seller.fillMany(toFill, chainNow, fixture.t0);
      }

      // ---- deliver keys for anything purchased ----
      await seller.deliverKeys(state, chainNow);

      // ---- mandatory reveal once lock passes ----
      const locked = fixture.games.every((g) => chainNow >= g.lockTime);
      const attested = fixture.games.every((g) => state.games.get(g.gameId)?.attested);
      if (locked && attested && !revealedAfterLock) {
        sub(`${NAME}: LOCK PASSED — revealing every claim, sold or not`);
        await seller.revealAll(state, (bountyId) => {
          const b = state.bounties.get(bountyId);
          if (!b) return undefined;
          return fixture.games.find((g) => g.gameId === b.gameId)?.players.find((p) => p.playerId === b.playerId);
        });
        revealedAfterLock = true;
      }

      // ---- collect ----
      if (revealedAfterLock) {
        const mine = [...state.claims.values()].filter(
          (c) => c.seller.toLowerCase() === me.address.toLowerCase() && inRun(state, fixture, c.bountyId),
        );
        if (mine.length > 0 && mine.every((c) => c.settled || c.slashed || c.refunded)) {
          await seller.withdraw();
          act(NAME, 'all claims settled — done');
          return true;
        }
      }
      return false;
    },
  });
}

main().catch((e) => {
  console.error(`${NAME} failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
