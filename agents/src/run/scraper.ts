/**
 * SCRAPER — the aggregator seller. Sells LEAD TIME, whenever it has some.
 *
 * Polls local beat reporting, practice observations and travel notes. When something breaks
 * that the national outlets have not republished yet, it turns that into a typed, sealed,
 * bonded LISTING on that player — whether or not anyone has bid yet. Bids are demand it
 * reports on, not a precondition.
 *
 * The "internet" here is the fixture's news items, gated by the shared clock — an item is
 * invisible until its timestamp passes, which is exactly the lead-time edge being sold.
 * Swap `pollSources()` for real HTTP and nothing else changes.
 */

import { makeAggregator, decideFromNews } from '../seller-aggregator.js';
import { roleAccount } from '../lib/chain.js';
import { act, info, sub } from '../lib/log.js';
import { newsAsOf, type ResolvedPlayer, type ResolvedFixture } from '../lib/fixtures.js';
import { bountiesFor, claimsBySeller } from '../lib/indexer.js';
import { runAgent, inRun } from './runtime.js';
import { Outcome, Bucket } from '../lib/enums.js';
import type { EvidenceItem } from '../lib/crypto.js';
import type { ListItem } from '../lib/seller.js';

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
      `strategy  scrape local reporting; LIST a sealed claim the moment something breaks`,
      `sources   ${SOURCES.join(', ')}`,
    ],
    step: async ({ state, fixture, chainNow }) => {
      // ---- the scrape pass: list on every slot where something has broken ----
      const toList: ListItem[] = [];
      for (const g of fixture.games) {
        if (chainNow >= g.lockTime) continue;
        for (const player of g.players) {
          if (seller.hasListed(state, g.gameId, player.playerId)) continue;
          const items = pollSources(player, fixture, chainNow);
          const key = `${g.gameId}:${player.playerId}:${items.length}`;
          if (!seen.has(key)) {
            seen.add(key);
            const bids = bountiesFor(state, g.gameId, player.playerId, chainNow);
            info(`polling ${SOURCES.length} sources for ${player.name} (${player.team}) — ${bids.length} open bid(s)`);
            if (items.length === 0) {
              info(`  └ nothing published yet — no edge, not listing`);
            } else {
              for (const it of items) info(`  └ HIT [${it.source}] "${it.text}"`);
              const d = decideFromNews(items);
              if (d) info(`  └ rules engine ⇒ ${Outcome[d.claimed]} @ ${Bucket[d.bucket]}  (${d.rationale.split('—')[0].trim()})`);
            }
          }
          if (items.length > 0) {
            const prior = state.priors.get(`${g.gameId}:${player.playerId}`);
            toList.push({
              gameId: g.gameId,
              playerId: player.playerId,
              player,
              priorTag: prior?.tag ?? player.priorTag,
              priorPractice: prior?.practice ?? player.priorPractice,
            });
          }
        }
      }
      if (toList.length > 0) {
        sub(`${NAME}: listing ${toList.length} sealed claim(s)`);
        await seller.listMany(toList, chainNow, fixture.t0);
      }

      // ---- deliver keys to every buyer who has paid ----
      await seller.deliverKeys(state, chainNow);

      // ---- mandatory reveal once lock passes and the list is attested ----
      const locked = fixture.games.every((g) => chainNow >= g.lockTime);
      const attested = fixture.games.every((g) => state.games.get(g.gameId)?.attested);
      if (locked && attested && !revealedAfterLock) {
        sub(`${NAME}: LOCK PASSED — revealing every listing, sold or not`);
        await seller.revealAll(state, (gameId, playerId) =>
          fixture.games.find((g) => g.gameId === gameId)?.players.find((p) => p.playerId === playerId),
        );
        revealedAfterLock = true;
      }

      // ---- collect ----
      if (revealedAfterLock) {
        const mine = claimsBySeller(state, me.address).filter((c) => inRun(fixture, c.gameId));
        if (mine.length > 0 && mine.every((c) => c.settled || c.slashed || c.unwound)) {
          await seller.resolveAll(state);
          await seller.withdraw();
          act(NAME, 'all listings settled — done');
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
