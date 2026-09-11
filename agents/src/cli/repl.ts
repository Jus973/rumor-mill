/**
 * repl.ts — interactive command shell shared by the three stakeholder terminals.
 *
 * The autonomous agents in src/run/ drive themselves end to end. These are the opposite:
 * you type commands and watch the market respond, so a demo can steer the scenario live —
 * sell a claim, buy it, make it right or wrong, refuse to reveal, override the oracle.
 */

import { createInterface } from 'node:readline';
import type { PublicClient } from 'viem';
import { publicClient } from '../lib/chain.js';
import { indexMarket, type MarketState } from '../lib/indexer.js';
import { loadFixture, resolveFixture, type ResolvedFixture, type ResolvedPlayer } from '../lib/fixtures.js';
import { gameIdOf } from '../lib/chain.js';
import { read } from '../lib/tx.js';
import { setT0 } from '../lib/log.js';

export const FIXTURE_PATH = 'fixtures/week1.json';
export const LOCK_SEC = Number(process.env.DEMO_LOCK_SEC ?? 600); // interactive: 10 min

export interface Ctx {
  pub: PublicClient;
  state: MarketState;
  fixture: ResolvedFixture | null;
  chainNow: number;
}

export interface Command {
  name: string;
  usage: string;
  help: string;
  run: (ctx: Ctx, args: string[]) => Promise<void>;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
export const color = C;

export async function chainTime(pub: PublicClient): Promise<number> {
  const b = await pub.getBlock({ blockTag: 'latest' });
  return Number(b.timestamp);
}

/** Latest un-attested slate, with t0 derived from its on-chain lockTime. */
export async function findSlate(pub: PublicClient): Promise<ResolvedFixture | null> {
  const file = loadFixture(FIXTURE_PATH);
  let newest: { week: number; lockTime: number } | null = null;
  let live: { week: number; lockTime: number } | null = null;
  for (let off = 0; off < 512; off++) {
    const week = file.week + off;
    const id = gameIdOf(file.season, week, file.games[0].home, file.games[0].away);
    const g = await read<readonly [bigint, bigint, `0x${string}`, boolean, boolean]>(pub, 'games', [id]);
    if (g[0] === 0n) break;
    newest = { week, lockTime: Number(g[0]) };
    if (g[1] === 0n) live = newest; // not attested yet — this is the one in play
  }
  // Prefer the slate still in play; fall back to the newest so `status` stays useful.
  const best = live ?? newest;
  if (!best) return null;
  const f = JSON.parse(JSON.stringify(file));
  f.week = best.week;
  const scale = LOCK_SEC / f.games[0].lockOffsetSec;
  for (const g of f.games) {
    g.lockOffsetSec = LOCK_SEC;
    for (const p of g.players) {
      for (const n of p.news) if (n.tsOffsetSec > 0) n.tsOffsetSec = Math.round(n.tsOffsetSec * scale);
    }
  }
  return resolveFixture(f, best.lockTime - LOCK_SEC);
}

/** Resolve a player by slug ("cmc") or by name fragment ("mccaffrey"). */
export function findPlayerBySlug(f: ResolvedFixture, token: string): ResolvedPlayer | undefined {
  const t = token.toLowerCase();
  for (const g of f.games) {
    for (const p of g.players) {
      if (p.slug.toLowerCase() === t || p.name.toLowerCase().includes(t)) return p;
    }
  }
  return undefined;
}

export function gameOfPlayer(f: ResolvedFixture, p: ResolvedPlayer) {
  return f.games.find((g) => g.players.some((x) => x.playerId === p.playerId))!;
}

/** Seconds until (or past) lock, rendered for the prompt. */
export function lockStatus(f: ResolvedFixture | null, chainNow: number): string {
  if (!f) return C.dim('no slate');
  const left = Math.min(...f.games.map((g) => g.lockTime)) - chainNow;
  if (left > 0) return C.green(`lock in ${Math.floor(left / 60)}m${String(left % 60).padStart(2, '0')}s`);
  return C.red(`LOCKED ${Math.floor(-left / 60)}m${String(-left % 60).padStart(2, '0')}s ago`);
}

export async function startRepl(opts: {
  role: string;
  banner: string[];
  commands: Command[];
  /** Called once at startup after the first state load. */
  onReady?: (ctx: Ctx) => Promise<void>;
}) {
  const pub = publicClient();

  const load = async (): Promise<Ctx> => {
    const [state, cNow, fixture] = await Promise.all([indexMarket(pub), chainTime(pub), findSlate(pub)]);
    if (fixture) setT0(fixture.t0);
    return { pub, state, fixture, chainNow: cNow };
  };

  console.log('\n' + '═'.repeat(90));
  console.log(`  ${C.bold(opts.role)}`);
  console.log('═'.repeat(90));
  for (const b of opts.banner) console.log(`  ${b}`);
  console.log('');

  let ctx = await load();
  if (opts.onReady) await opts.onReady(ctx);

  const all: Command[] = [
    ...opts.commands,
    {
      name: 'help',
      usage: 'help',
      help: 'list commands',
      run: async () => {
        console.log('');
        for (const c of all) {
          console.log(`  ${C.cyan(c.usage.padEnd(34))} ${C.dim(c.help)}`);
        }
        console.log('');
      },
    },
    {
      name: 'quit',
      usage: 'quit',
      help: 'exit',
      run: async () => {
        process.exit(0);
      },
    },
  ];

  await all.find((c) => c.name === 'help')!.run(ctx, []);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.setPrompt(`${C.bold(opts.role.split(' ')[0].toLowerCase())} ${lockStatus(ctx.fixture, ctx.chainNow)}> `);
    rl.prompt();
  };
  prompt();

  // Commands are async and stdin may be a pipe, which closes immediately. Queue lines and
  // drain them one at a time so a scripted run behaves exactly like a typed one.
  const queue: string[] = [];
  let draining = false;
  let closed = false;

  const handle = async (line: string) => {
    const [name, ...args] = line.trim().split(/\s+/).filter(Boolean);
    if (!name) return;
    const cmd = all.find((c) => c.name === name || c.name.startsWith(name));
    if (!cmd) {
      console.log(C.red(`unknown command "${name}" — try "help"`));
      return;
    }
    try {
      ctx = await load(); // always act on fresh chain state
      await cmd.run(ctx, args);
      ctx = await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.log(C.red(`✗ ${msg}`));
    }
  };

  const pump = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) await handle(queue.shift()!);
    draining = false;
    if (closed) process.exit(0);
    prompt();
  };

  rl.on('line', (line) => {
    queue.push(line);
    void pump();
  });
  rl.on('close', () => {
    closed = true;
    void pump();
  });
}
