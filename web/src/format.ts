/** format.ts — display helpers. Nothing here touches the chain. */

import { formatEther, type Address, type Hex } from 'viem';
import { CONTRACT_ADDRESS } from '../../agents/src/lib/constants.js';

export const EXPLORER_BASE = 'https://sepolia.etherscan.io';
export const addrUrl = (a: string) => `${EXPLORER_BASE}/address/${a}`;
export const txUrl = (h: string) => `${EXPLORER_BASE}/tx/${h}`;
export const CONTRACT = CONTRACT_ADDRESS;

/** Trim an address to the form people actually compare. */
export const short = (a: string, lead = 6): string => `${a.slice(0, lead)}…${a.slice(-4)}`;

/**
 * Wei → ETH with enough precision for demo-sized numbers (bonds are 2e14 wei) but
 * without the 18-decimal tail that makes a table unreadable.
 */
export function eth(wei: bigint, dp = 5): string {
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  if (n < 10 ** -dp) return `<${(10 ** -dp).toFixed(dp)}`;
  return n.toFixed(dp).replace(/\.?0+$/, '');
}

export const ethLabel = (wei: bigint, dp = 5): string => `${eth(wei, dp)} ETH`;

export function pct(x: number, dp = 0): string {
  return `${(x * 100).toFixed(dp)}%`;
}

/** Compact, unambiguous UTC — the demo's clock is synthetic, so local time misleads. */
export function ts(sec: number): string {
  const d = new Date(sec * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

/** Lead time in the units the market actually prices: seconds before lock. */
export function lead(committedAt: number, lockTime: number): string {
  const s = lockTime - committedAt;
  if (s <= 0) return 'after lock';
  if (s < 90) return `${s}s early`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m early`;
  return `${(s / 3600).toFixed(1)}h early`;
}

export function ago(sec: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Escape untrusted-ish strings before they go into innerHTML. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const addrLink = (a: Address, lead = 6): string =>
  `<a class="mono" href="${addrUrl(a)}" target="_blank" rel="noopener">${short(a, lead)}</a>`;

export const hexShort = (h: Hex): string => `<span class="mono faint">${h.slice(0, 10)}…</span>`;
