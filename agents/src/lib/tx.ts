/**
 * tx.ts — contract write helpers shared by every agent.
 */

import type { Address, Hash, PublicClient, WalletClient } from 'viem';
import { SAM_ABI, CONTRACT_ADDRESS } from './chain.js';

export interface SendOpts {
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/** Simulate then send, and wait for the receipt. Throws with the decoded revert reason. */
export async function send(
  pub: PublicClient,
  wallet: WalletClient,
  opts: SendOpts,
): Promise<{ hash: Hash; receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> }> {
  const account = wallet.account;
  if (!account) throw new Error('wallet has no account');

  const { request } = await pub.simulateContract({
    address: CONTRACT_ADDRESS,
    abi: SAM_ABI,
    functionName: opts.functionName as never,
    args: opts.args as never,
    account,
    value: opts.value,
  });

  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return { hash, receipt };
}

/**
 * Submit several INDEPENDENT txs from one account in a single block.
 *
 * Sepolia confirms in ~13s, and the demo needs ~23 txs before the lock cliff. Awaiting each
 * receipt serially costs ~300s, which blows any realistic lock. Assigning explicit nonces
 * and awaiting all receipts together collapses a batch to roughly one block.
 *
 * Callers must only batch txs that do not depend on each other's state.
 */
export async function sendBatch(
  pub: PublicClient,
  wallet: WalletClient,
  batch: SendOpts[],
): Promise<Array<{ hash: Hash; receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> }>> {
  const account = wallet.account;
  if (!account) throw new Error('wallet has no account');
  if (batch.length === 0) return [];

  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });

  const hashes: Hash[] = [];
  for (const opts of batch) {
    const hash = await wallet.writeContract({
      address: CONTRACT_ADDRESS,
      abi: SAM_ABI,
      functionName: opts.functionName as never,
      args: opts.args as never,
      value: opts.value,
      account,
      chain: wallet.chain,
      nonce: nonce++,
    } as never);
    hashes.push(hash);
  }

  const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  receipts.forEach((r, i) => {
    if (r.status !== 'success') throw new Error(`tx reverted: ${hashes[i]} (${batch[i].functionName})`);
  });
  return hashes.map((hash, i) => ({ hash, receipt: receipts[i] }));
}

/**
 * Attempt a call that is EXPECTED to revert, and return the error name.
 * Used by the demo to show the lock cliff rejecting a late purchase.
 */
export async function expectRevert(
  pub: PublicClient,
  wallet: WalletClient,
  opts: SendOpts,
): Promise<{ reverted: true; reason: string } | { reverted: false }> {
  try {
    await pub.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: SAM_ABI,
      functionName: opts.functionName as never,
      args: opts.args as never,
      account: wallet.account,
      value: opts.value,
    });
    return { reverted: false };
  } catch (err) {
    return { reverted: true, reason: revertName(err) };
  }
}

export function revertName(err: unknown): string {
  const s = err instanceof Error ? `${err.message}\n${(err as { details?: string }).details ?? ''}` : String(err);
  const m = s.match(/Error:\s*(\w+)\(\)/) ?? s.match(/reverted with the following reason:\s*(\w+)/) ?? s.match(/custom error '?(\w+)/);
  if (m) return m[1];
  const known = [
    'LockPassed','LockNotReached','BadState','BadValue','BondTooLow','NotBuyer','NotSeller',
    'NoPubKey','CommitMismatch','NotFinal','RevealWindowOpen','AlreadyAttested','NotResolver',
  ];
  for (const k of known) if (s.includes(k)) return k;
  return s.split('\n')[0].slice(0, 120);
}

/** Read a view function. */
export async function read<T>(pub: PublicClient, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await pub.readContract({
    address: CONTRACT_ADDRESS,
    abi: SAM_ABI,
    functionName: functionName as never,
    args: args as never,
  })) as T;
}

export async function balanceOf(pub: PublicClient, who: Address): Promise<bigint> {
  return read<bigint>(pub, 'balances', [who]);
}
