/**
 * crank.ts — the permissionless settlement cranks, shared by the operator terminal, the
 * autonomous manager, and the orchestrated demo. Nothing here needs a role: settle,
 * resolvePurchase and slashUnrevealed are open to anyone; the operator runs them because
 * it is already funded.
 */

import type { PublicClient, WalletClient } from 'viem';
import { sendBatch, read } from './tx.js';
import { act } from './log.js';
import { isTerminal, type MarketState, type IndexedClaim } from './indexer.js';

export type ClaimFilter = (c: IndexedClaim) => boolean;

/** settle every revealed, final listing; then resolve every purchase on every terminal listing. */
export async function settleAndResolve(
  pub: PublicClient,
  wallet: WalletClient,
  state: MarketState,
  inScope: ClaimFilter,
  actor = 'CRANK',
): Promise<{ settled: number; resolved: number }> {
  const finals = new Map<string, boolean>();
  const isFinal = async (gameId: `0x${string}`) => {
    if (!finals.has(gameId)) finals.set(gameId, await read<boolean>(pub, 'isFinal', [gameId]));
    return finals.get(gameId)!;
  };

  const toSettle: IndexedClaim[] = [];
  for (const c of state.claims.values()) {
    if (!inScope(c) || !c.revealed || isTerminal(c)) continue;
    if (await isFinal(c.gameId)) toSettle.push(c);
  }
  if (toSettle.length > 0) {
    const res = await sendBatch(pub, wallet, toSettle.map((c) => ({ functionName: 'settle', args: [BigInt(c.claimId)] })));
    toSettle.forEach((c, i) => act(actor, `settle claim#${c.claimId}`, res[i].hash));
  }
  const settledNow = new Set(toSettle.map((c) => c.claimId));

  const toResolve: Array<{ claimId: number; buyer: `0x${string}` }> = [];
  for (const c of state.claims.values()) {
    if (!inScope(c)) continue;
    if (!isTerminal(c) && !settledNow.has(c.claimId)) continue;
    for (const p of c.purchases.values()) {
      if (p.refunded || p.resolved) continue;
      toResolve.push({ claimId: c.claimId, buyer: p.buyer });
    }
  }
  if (toResolve.length > 0) {
    const res = await sendBatch(pub, wallet, toResolve.map((p) => ({ functionName: 'resolvePurchase', args: [BigInt(p.claimId), p.buyer] })));
    toResolve.forEach((p, i) => act(actor, `resolvePurchase claim#${p.claimId} buyer ${p.buyer.slice(0, 8)}…`, res[i].hash));
  }
  return { settled: toSettle.length, resolved: toResolve.length };
}

/** slash every unrevealed listing whose reveal deadline has passed. Returns ids slashed. */
export async function slashStale(
  pub: PublicClient,
  wallet: WalletClient,
  state: MarketState,
  inScope: ClaimFilter,
  chainNow: number,
  actor = 'CRANK',
): Promise<number[]> {
  const cw = Number(await read<bigint>(pub, 'challengeWindow'));
  const rw = Number(await read<bigint>(pub, 'revealWindow'));
  const attestedAt = new Map<string, number>();
  const todo: IndexedClaim[] = [];
  for (const c of state.claims.values()) {
    if (!inScope(c) || c.revealed || isTerminal(c)) continue;
    const g = state.games.get(c.gameId);
    if (!g?.attested || g.voided || g.unwound) continue;
    if (!attestedAt.has(c.gameId)) {
      const rec = await read<readonly [bigint, bigint, `0x${string}`, boolean, boolean]>(pub, 'games', [c.gameId]);
      attestedAt.set(c.gameId, Number(rec[1]));
    }
    if (chainNow <= attestedAt.get(c.gameId)! + cw + rw) continue;
    todo.push(c);
  }
  if (todo.length === 0) return [];
  const res = await sendBatch(pub, wallet, todo.map((c) => ({ functionName: 'slashUnrevealed', args: [BigInt(c.claimId)] })));
  todo.forEach((c, i) => act(actor, `slashUnrevealed claim#${c.claimId} — never revealed, bond forfeit to the burn sink`, res[i].hash));
  return todo.map((c) => c.claimId);
}
