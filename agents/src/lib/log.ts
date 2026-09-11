/**
 * log.ts — structured console output for the demo (LLD §4.6).
 * Format: `[t+mm:ss] ACTOR action → txHash` so the video can be a terminal plus the explorer.
 */

let T0 = Math.floor(Date.now() / 1000);

export function setT0(t: number) {
  T0 = t;
}
export function t0(): number {
  return T0;
}

export function stamp(at = Math.floor(Date.now() / 1000)): string {
  const d = Math.max(0, at - T0);
  return `[t+${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}]`;
}

const TX = 'https://sepolia.etherscan.io/tx/';

export function act(actor: string, action: string, txHash?: string) {
  const tail = txHash ? `  → ${txHash}` : '';
  console.log(`${stamp()} ${actor.padEnd(11)} ${action}${tail}`);
}

export function info(msg: string) {
  console.log(`${stamp()} ${''.padEnd(11)} ${msg}`);
}

export function head(title: string) {
  console.log(`\n${'═'.repeat(96)}\n  ${title}\n${'═'.repeat(96)}`);
}

export function sub(title: string) {
  console.log(`\n${'─'.repeat(96)}\n  ${title}\n${'─'.repeat(96)}`);
}

export function txLink(hash: string): string {
  return TX + hash;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the wall clock reaches `at`, printing a countdown every 15s. */
export async function waitUntil(at: number, why: string) {
  let last = 0;
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= at) return;
    const left = at - now;
    if (left !== last && (left % 15 === 0 || left <= 5)) {
      info(`waiting ${left}s — ${why}`);
      last = left;
    }
    await sleep(1000);
  }
}
