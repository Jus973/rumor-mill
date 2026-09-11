/**
 * FORECASTER — the model seller. Sells CALIBRATION.
 *
 * It has no news and no sources. It starts from exactly the same public prior everyone can
 * see and moves it with practice trajectory and injury base rates. It fills a bounty ONLY
 * when it disagrees with the report by more than a margin — agreeing with the prior scores
 * ~0 by construction, so a bond posted on agreement is dead capital.
 *
 * One claim per run is deliberately left UNREVEALED, to show slashing. That is the
 * mechanism that makes a seller's miss history impossible to cherry-pick.
 */

import { makeForecaster, forecast, MARGIN } from '../seller-forecaster.js';
import { roleAccount } from '../lib/chain.js';
import { priorPActive } from '../lib/scoring.js';
import { act, info, sub } from '../lib/log.js';
import { claimsForBounty } from '../lib/indexer.js';
import { runAgent, inRun } from './runtime.js';

const NAME = 'FORECASTER';
/** The slot this agent deliberately refuses to reveal, to demonstrate slashing. */
const WITHHOLD_SLUG = process.env.WITHHOLD_SLUG ?? 'kelce';

async function main() {
  const seller = makeForecaster(({ player }) => player.slug === WITHHOLD_SLUG);
  const me = roleAccount('forecaster');
  const explained = new Set<number>();
  let revealedAfterLock = false;

  await runAgent({
    name: NAME,
    requiresSlate: true,
    every: 4000,
    banner: [
      `address   ${me.address}`,
      `role      tipster agent — sells CALIBRATION, not news`,
      `strategy  move the public prior with practice trajectory + injury base rates;`,
      `          only bid when |p − prior| ≥ ${MARGIN} (selling agreement earns ~0)`,
      `note      will deliberately NOT reveal its "${WITHHOLD_SLUG}" claim, to show slashing`,
    ],
    step: async ({ state, fixture, chainNow }) => {
      const bounties = [...state.bounties.values()].filter((b) => inRun(state, fixture, b.bountyId));
      if (bounties.length === 0) {
        if (explained.size === 0) info('no open bounties yet — waiting for a buyer');
        return false;
      }

      const toFill = [];
      for (const b of bounties) {
        const g = fixture.games.find((x) => x.gameId === b.gameId);
        const player = g?.players.find((p) => p.playerId === b.playerId);
        if (!player) continue;

        const already = claimsForBounty(state, b.bountyId).some(
          (c) => c.seller.toLowerCase() === me.address.toLowerCase(),
        );
        if (already) continue;

        const prior = state.priors.get(`${b.gameId}:${b.playerId}`);
        const p0 = priorPActive(prior?.tag ?? player.priorTag, prior?.practice ?? player.priorPractice);
        const { p, steps } = forecast(player, p0);

        if (!explained.has(b.bountyId)) {
          explained.add(b.bountyId);
          info(`modelling ${player.name} (${player.team})`);
          for (const s of steps) info(`  └ ${s}`);
          const disagreement = Math.abs(p - p0);
          info(
            `  └ disagreement with the public report = ${disagreement.toFixed(2)} ` +
              (disagreement >= MARGIN ? `≥ ${MARGIN} → BIDDING` : `< ${MARGIN} → no edge, skipping`),
          );
        }

        toFill.push({
          b,
          player,
          priorTag: prior?.tag ?? player.priorTag,
          priorPractice: prior?.practice ?? player.priorPractice,
        });
      }

      if (toFill.length > 0) {
        sub(`${NAME}: filling ${toFill.length} bounty(s) with sealed claims`);
        await seller.fillMany(toFill, chainNow, fixture.t0);
      }

      await seller.deliverKeys(state, chainNow);

      const locked = fixture.games.every((g) => chainNow >= g.lockTime);
      const attested = fixture.games.every((g) => state.games.get(g.gameId)?.attested);
      if (locked && attested && !revealedAfterLock) {
        sub(`${NAME}: LOCK PASSED — mandatory reveal (one claim deliberately withheld)`);
        await seller.revealAll(state, (bountyId) => {
          const b = state.bounties.get(bountyId);
          if (!b) return undefined;
          return fixture.games.find((g) => g.gameId === b.gameId)?.players.find((p) => p.playerId === b.playerId);
        });
        revealedAfterLock = true;
      }

      if (revealedAfterLock) {
        const mine = [...state.claims.values()].filter(
          (c) => c.seller.toLowerCase() === me.address.toLowerCase() && inRun(state, fixture, c.bountyId),
        );
        if (mine.length > 0 && mine.every((c) => c.settled || c.slashed || c.refunded)) {
          await seller.withdraw();
          const slashed = mine.filter((c) => c.slashed).length;
          act(NAME, `done — ${mine.length} claims, ${slashed} slashed for non-reveal`);
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
