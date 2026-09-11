/**
 * runtime.ts — shared loop for the standalone stakeholder agents.
 *
 * Each stakeholder runs in its own terminal as an independent process. They coordinate
 * through NOTHING but the chain: every agent replays from `getLogs(deployBlock)` on each
 * tick and acts on what it finds. No shared memory, no message bus, no agreed start time.
 *
 * Clock sync is the one subtlety. The fixture expresses news as offsets from demo start,
 * so four processes started at four different moments would disagree about what has
 * "broken" yet. So `t0` is derived from the CHAIN: the game's on-chain lockTime minus the
 * fixture's lock offset. Every agent computes the same t0 regardless of when it started.
 */

import type { PublicClient } from 'viem';
import { publicClient } from '../lib/chain.js';
import { indexMarket, type MarketState } from '../lib/indexer.js';
import { loadFixture, resolveFixture, type ResolvedFixture, type FixtureFile } from '../lib/fixtures.js';
import { gameIdOf } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { setT0, act, info, head, sleep } from '../lib/log.js';

export const FIXTURE_PATH = 'fixtures/week1.json';
export const DEFAULT_LOCK_SEC = 110;

export interface AgentContext {
  pub: PublicClient;
  state: MarketState;
  fixture: ResolvedFixture;
  now: number;
  chainNow: number;
  tick: number;
}

export async function chainTime(pub: PublicClient): Promise<number> {
  const b = await pub.getBlock({ blockTag: 'latest' });
  return Number(b.timestamp);
}

/**
 * MANAGER: the first synthetic week whose gameIds are unused, so a new slate never
 * collides with a previous run's. `gameId` is deterministic from (season, week, teams).
 */
export async function nextFreeWeek(pub: PublicClient, file: FixtureFile): Promise<number> {
  for (let off = 0; off < 512; off++) {
    const week = file.week + off;
    const id = gameIdOf(file.season, week, file.games[0].home, file.games[0].away);
    const g = await read<readonly [bigint, bigint, `0x${string}`, boolean]>(pub, 'games', [id]);
    if (g[0] === 0n) return week;
  }
  throw new Error('no free week found');
}

/**
 * JOINERS: find the live slate to participate in, and derive t0 from its on-chain
 * lockTime. Returns null until the manager has published an un-attested slate.
 */
export async function discoverRun(
  pub: PublicClient,
  file: FixtureFile,
  lockOffset: number,
): Promise<ResolvedFixture | null> {
  const base = file.week;
  let best: { week: number; lockTime: number } | null = null;

  for (let off = 0; off < 512; off++) {
    const week = base + off;
    const id = gameIdOf(file.season, week, file.games[0].home, file.games[0].away);
    // games(gameId) => (lockTime, attestedAt, reportHash, voided)
    const g = await read<readonly [bigint, bigint, `0x${string}`, boolean]>(pub, 'games', [id]);
    if (g[0] === 0n) break; // first unused week — everything before it exists
    // Only join a slate that has NOT been attested yet. Otherwise an agent that starts
    // while the manager is still publishing latches onto the PREVIOUS week's settled
    // games, derives t0 from their stale lockTime, and sits out the whole run.
    best = g[1] === 0n ? { week, lockTime: Number(g[0]) } : null;
  }
  if (!best) return null;

  const f: FixtureFile = JSON.parse(JSON.stringify(file));
  f.week = best.week;
  const scale = lockOffset / f.games[0].lockOffsetSec;
  for (const g of f.games) {
    g.lockOffsetSec = lockOffset;
    for (const p of g.players) {
      for (const n of p.news) if (n.tsOffsetSec > 0) n.tsOffsetSec = Math.round(n.tsOffsetSec * scale);
    }
  }
  // t0 such that t0 + lockOffset == the on-chain lockTime. All agents agree on this.
  return resolveFixture(f, best.lockTime - lockOffset);
}

export interface AgentOptions {
  name: string;
  banner: string[];
  /** Poll interval in ms. */
  every?: number;
  /** Return true to stop the loop. */
  step: (ctx: AgentContext) => Promise<boolean | void>;
  /** If true, wait for the manager to create the slate before starting. */
  requiresSlate?: boolean;
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const pub = publicClient();
  const file = loadFixture(FIXTURE_PATH);
  const lockOffset = Number(process.env.DEMO_LOCK_SEC ?? DEFAULT_LOCK_SEC);

  head(opts.name);
  for (const line of opts.banner) console.log(`  ${line}`);
  console.log('');

  let fixture: ResolvedFixture | null = null;
  if (opts.requiresSlate) {
    info('waiting for the MANAGER to publish this week\'s slate...');
    for (;;) {
      fixture = await discoverRun(pub, file, lockOffset);
      if (fixture) break;
      await sleep(3000);
    }
    setT0(fixture.t0);
    act(opts.name, `found slate: week ${fixture.week}, ${fixture.games.length} games, lock at +${lockOffset}s`);
  }

  let tick = 0;
  for (;;) {
    tick++;
    if (!fixture) {
      fixture = await discoverRun(pub, file, lockOffset);
      if (fixture) setT0(fixture.t0);
    }
    if (fixture) {
      try {
        const [state, cNow] = await Promise.all([indexMarket(pub), chainTime(pub)]);
        const done = await opts.step({
          pub,
          state,
          fixture,
          now: Math.floor(Date.now() / 1000),
          chainNow: cNow,
          tick,
        });
        if (done) return;
      } catch (err) {
        // A long-running agent must survive a reverted tx or a flaky RPC. Dying here would
        // also mean never revealing, which forfeits every bond this agent has posted.
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        info(`recoverable error (continuing): ${msg}`);
      }
    }
    await sleep(opts.every ?? 4000);
  }
}

/** Only this run's games — the contract accumulates across runs. */
export function inRun(fixture: ResolvedFixture, gameId: `0x${string}`): boolean {
  return fixture.games.some((g) => g.gameId === gameId);
}
