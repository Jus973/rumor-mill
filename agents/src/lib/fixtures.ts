/**
 * fixtures.ts — fixture loader and the simulated clock (LLD §4.1, §6).
 *
 * Real Week 1 games lock before the submission deadline, so a live game cannot be settled
 * inside a 5-minute video (A4). Fixture mode is the only way to show the full lifecycle.
 * Every timestamp in the file is an OFFSET from demo start, resolved here against a single
 * `t0` so all agents agree on the clock.
 */

import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { ReportTag, Practice, Outcome } from './enums.js';
import { gameIdOf, playerIdOf } from './chain.js';

export interface FixtureNews {
  tsOffsetSec: number;
  source: string;
  text: string;
}

export interface FixturePlayer {
  team: string;
  slug: string;
  name: string;
  prior: { tag: keyof typeof ReportTag; practice: keyof typeof Practice };
  practiceTrajectory: Array<keyof typeof Practice>;
  injury: { class: string; daysSince: number };
  news: FixtureNews[];
  actual: 'ACTIVE' | 'INACTIVE';
  narrative?: string;
}

export interface FixtureGame {
  home: string;
  away: string;
  lockOffsetSec: number;
  players: FixturePlayer[];
}

export interface FixtureFile {
  season: number;
  week: number;
  games: FixtureGame[];
}

// Resolved, id-bearing views used by the agents.

export interface ResolvedPlayer extends FixturePlayer {
  playerId: Hex;
  priorTag: ReportTag;
  priorPractice: Practice;
  actualOutcome: Outcome;
}

export interface ResolvedGame {
  gameId: Hex;
  home: string;
  away: string;
  label: string;
  lockTime: number; // absolute unix seconds
  players: ResolvedPlayer[];
}

export interface ResolvedFixture {
  season: number;
  week: number;
  t0: number;
  games: ResolvedGame[];
}

export function loadFixture(path: string): FixtureFile {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
}

/**
 * Bind a fixture to a concrete start time. Every agent in a demo run must be given the
 * SAME t0 or their view of which news has "broken" will diverge.
 */
export function resolveFixture(f: FixtureFile, t0: number): ResolvedFixture {
  return {
    season: f.season,
    week: f.week,
    t0,
    games: f.games.map((g) => ({
      gameId: gameIdOf(f.season, f.week, g.home, g.away),
      home: g.home,
      away: g.away,
      label: `${g.away}@${g.home}`,
      lockTime: t0 + g.lockOffsetSec,
      players: g.players.map((p) => ({
        ...p,
        playerId: playerIdOf(p.team, p.slug),
        priorTag: ReportTag[p.prior.tag],
        priorPractice: Practice[p.prior.practice],
        actualOutcome: p.actual === 'ACTIVE' ? Outcome.ACTIVE : Outcome.INACTIVE,
      })),
    })),
  };
}

/** News items that have "broken" as of `now`. Sellers only ever see these. */
export function newsAsOf(p: ResolvedPlayer, t0: number, now: number): FixtureNews[] {
  return p.news.filter((n) => t0 + n.tsOffsetSec <= now);
}

export function findPlayer(f: ResolvedFixture, gameId: Hex, playerId: Hex): ResolvedPlayer | undefined {
  return f.games.find((g) => g.gameId === gameId)?.players.find((p) => p.playerId === playerId);
}

export function findGame(f: ResolvedFixture, gameId: Hex): ResolvedGame | undefined {
  return f.games.find((g) => g.gameId === gameId);
}

/** The inactive list the resolver attests for a game, straight from the fixture. */
export function inactiveListFor(g: ResolvedGame): Hex[] {
  return g.players.filter((p) => p.actualOutcome === Outcome.INACTIVE).map((p) => p.playerId);
}
