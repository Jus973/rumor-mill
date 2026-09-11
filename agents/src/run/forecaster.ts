/**
 * FORECASTER — the model seller. Sells CALIBRATION, whenever it has an edge.
 *
 * It has no news and no sources. It starts from exactly the same public prior everyone can
 * see and moves it with practice trajectory and injury base rates. It LISTS only when it
 * disagrees with the report by more than a margin — agreeing with the prior is priced at
 * ~0 by the contract and scores ~0 off-chain, so a bond posted on agreement is dead capital.
 *
 * One listing per run is deliberately left UNREVEALED, to show slashing.
 */

import { makeForecaster, forecast, MARGIN } from '../seller-forecaster.js';
import { roleAccount } from '../lib/chain.js';
import { priorPActive } from '../lib/scoring.js';
import { act, info, sub } from '../lib/log.js';
import { bountiesFor, claimsBySeller } from '../lib/indexer.js';
import { runAgent, inRun } from './runtime.js';
import type { ListItem } from '../lib/seller.js';

const NAME = 'FORECASTER';
/** The slot this agent deliberately refuses to reveal, to demonstrate slashing. */
const WITHHOLD_SLUG = process.env.WITHHOLD_SLUG ?? 'kelce';

async function main() {
  const seller = makeForecaster(({ player }) => player.slug === WITHHOLD_SLUG);
  const me = roleAccount('forecaster');
  const explained = new Set<string>();
  let revealedAfterLock = false;

  await runAgent({
    name: NAME,
    requiresSlate: true,
    every: 4000,
    banner: [
      `address   ${me.address}`,
      `role      tipster agent — sells CALIBRATION, not news`,
      `strategy  move the public prior with practice trajectory + injury base rates;`,
      `          only list when |p − prior| ≥ ${MARGIN} (selling agreement earns ~0)`,
      `note      will deliberately NOT reveal its "${WITHHOLD_SLUG}" listing, to show slashing`,
    ],
    step: async ({ state, fixture, chainNow }) => {
      const toList: ListItem[] = [];
      for (const g of fixture.games) {
        if (chainNow >= g.lockTime) continue;
        for (const player of g.players) {
          if (seller.hasListed(state, g.gameId, player.playerId)) continue;
          const prior = state.priors.get(`${g.gameId}:${player.playerId}`);
          const p0 = priorPActive(prior?.tag ?? player.priorTag, prior?.practice ?? player.priorPractice);
          const { p, steps } = forecast(player, p0);

          const key = `${g.gameId}:${player.playerId}`;
          if (!explained.has(key)) {
            explained.add(key);
            const bids = bountiesFor(state, g.gameId, player.playerId, chainNow);
            info(`modelling ${player.name} (${player.team}) — ${bids.length} open bid(s)`);
            for (const s of steps) info(`  └ ${s}`);
            const disagreement = Math.abs(p - p0);
            info(
              `  └ disagreement with the public report = ${disagreement.toFixed(2)} ` +
                (disagreement >= MARGIN ? `≥ ${MARGIN} → LISTING` : `< ${MARGIN} → no edge, skipping`),
            );
          }
          toList.push({
            gameId: g.gameId,
            playerId: player.playerId,
            player,
            priorTag: prior?.tag ?? player.priorTag,
            priorPractice: prior?.practice ?? player.priorPractice,
          });
        }
      }
      if (toList.length > 0) {
        sub(`${NAME}: evaluating ${toList.length} slot(s)`);
        await seller.listMany(toList, chainNow, fixture.t0);
      }

      await seller.deliverKeys(state, chainNow);

      const locked = fixture.games.every((g) => chainNow >= g.lockTime);
      const attested = fixture.games.every((g) => state.games.get(g.gameId)?.attested);
      if (locked && attested && !revealedAfterLock) {
        sub(`${NAME}: LOCK PASSED — mandatory reveal (one listing deliberately withheld)`);
        await seller.revealAll(state, (gameId, playerId) =>
          fixture.games.find((g) => g.gameId === gameId)?.players.find((p) => p.playerId === playerId),
        );
        revealedAfterLock = true;
      }

      if (revealedAfterLock) {
        const mine = claimsBySeller(state, me.address).filter((c) => inRun(fixture, c.gameId));
        if (mine.length > 0 && mine.every((c) => c.settled || c.slashed || c.unwound)) {
          await seller.resolveAll(state);
          await seller.withdraw();
          const slashed = mine.filter((c) => c.slashed).length;
          act(NAME, `done — ${mine.length} listings, ${slashed} slashed for non-reveal`);
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
