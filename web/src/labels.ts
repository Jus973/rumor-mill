/**
 * labels.ts — turn on-chain ids back into names.
 *
 * `gameId` is keccak(("NFL", season, week, home, away)) and `playerId` is
 * keccak(("NFL", gsisId)), so the fixture slate is enough to invert both. demo.ts
 * advances a synthetic week on every re-run to keep gameIds unique, so we walk a
 * window of weeks forward from the fixture's base week and precompute the table.
 */

import { encodePacked, keccak256, type Hex } from 'viem';
import fixture from '../../agents/fixtures/week1.json';

/** How many synthetic weeks of demo re-runs to resolve. Cheap: 2 hashes per week. */
const WEEK_WINDOW = 120;

export interface GameLabel {
  /** e.g. "SEA @ SF" */
  matchup: string;
  /** the synthetic week the demo run used */
  week: number;
}

const gameIdOf = (season: number, week: number, home: string, away: string): Hex =>
  keccak256(encodePacked(['string', 'uint16', 'uint8', 'string', 'string'], ['NFL', season, week, home, away]));

const playerIdOf = (gsisId: string): Hex => keccak256(encodePacked(['string', 'string'], ['NFL', gsisId]));

const games = new Map<string, GameLabel>();
const players = new Map<string, string>();

for (let w = fixture.week; w < fixture.week + WEEK_WINDOW; w++) {
  for (const g of fixture.games) {
    games.set(gameIdOf(fixture.season, w, g.home, g.away).toLowerCase(), {
      matchup: `${g.away} @ ${g.home}`,
      week: w,
    });
  }
}

for (const g of fixture.games) {
  for (const p of g.players) players.set(playerIdOf(p.gsisId).toLowerCase(), p.name);
}

export function gameLabel(id: Hex): GameLabel | undefined {
  return games.get(id.toLowerCase());
}

export function playerName(id: Hex): string | undefined {
  return players.get(id.toLowerCase());
}

/** The team each fixture player belongs to, for the secondary line in tables. */
const playerTeams = new Map<string, string>();
for (const g of fixture.games) {
  for (const p of g.players) playerTeams.set(playerIdOf(p.gsisId).toLowerCase(), p.team);
}
export const playerTeam = (id: Hex): string | undefined => playerTeams.get(id.toLowerCase());
