/**
 * chain.ts — viem clients, deployed address, and role accounts.
 *
 * Design rule (LLD §1): the contract is the only stateful component. Agents hold no
 * database; they replay from `getLogs(fromBlock: DEPLOY_BLOCK)` on startup.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { SAM_ABI } from './abi.js';

export { SAM_ABI };

// ---------------------------------------------------------------------------
// Deployment (LLD §8 step 2)
// ---------------------------------------------------------------------------

/**
 * Deployed on Ethereum Sepolia, NOT Base Sepolia as the LLD assumed (A1): Base faucets
 * were dry, so the fallback chain in A1 was taken.
 */
export const CONTRACT_ADDRESS: Address = '0x7D228e488Ff5A9069e019A7AB68558d26fA0A138';

/**
 * The block the contract was mined in. Taken from the broadcast receipt, not from the
 * script's console.log — that one runs during simulation and is one block early, which
 * would make getLogs miss the deployment block.
 */
export const DEPLOY_BLOCK = 11680305n;

export const CHAIN = sepolia;
export const EXPLORER = `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`;

export function rpcUrl(): string {
  const url = process.env.SEPOLIA_RPC_URL;
  if (!url) throw new Error('SEPOLIA_RPC_URL is not set (source .env)');
  return url;
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type Role = 'buyer' | 'aggregator' | 'forecaster';

interface AgentKeyFile {
  buyer: { privateKey: Hex; address: Address; encPrivateKey: Hex; encPublicKey: Hex };
  aggregator: { privateKey: Hex; address: Address };
  forecaster: { privateKey: Hex; address: Address };
}

const KEYFILE = new URL('../../.agent-keys.json', import.meta.url).pathname;

let cached: AgentKeyFile | null = null;

export function agentKeys(): AgentKeyFile {
  if (cached) return cached;
  if (!existsSync(KEYFILE)) {
    throw new Error(
      `missing ${KEYFILE}. Generate agent keys first (see README "Running the demo").`,
    );
  }
  cached = JSON.parse(readFileSync(KEYFILE, 'utf8')) as AgentKeyFile;
  return cached;
}

/** The resolver/owner is the deployer, whose key is in .env (LLD A3). */
export function resolverAccount() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error('PRIVATE_KEY is not set (source .env)');
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(pk);
}

export function roleAccount(role: Role) {
  return privateKeyToAccount(agentKeys()[role].privateKey);
}

export function buyerEncKeys(): { privateKey: Hex; publicKey: Hex } {
  const b = agentKeys().buyer;
  return { privateKey: b.encPrivateKey, publicKey: b.encPublicKey };
}

export function walletFor(account: ReturnType<typeof privateKeyToAccount>): WalletClient {
  return createWalletClient({ account, chain: CHAIN, transport: http(rpcUrl()) });
}

export function resolverWallet(): WalletClient {
  return walletFor(resolverAccount());
}

export function roleWallet(role: Role): WalletClient {
  return walletFor(roleAccount(role));
}

// ---------------------------------------------------------------------------
// Identifiers (LLD §3.1)
// ---------------------------------------------------------------------------

import { encodePacked, keccak256 } from 'viem';

/** gameId = keccak256(abi.encodePacked("NFL", season, week, homeAbbr, awayAbbr)) */
export function gameIdOf(season: number, week: number, home: string, away: string): Hex {
  return keccak256(
    encodePacked(
      ['string', 'uint16', 'uint8', 'string', 'string'],
      ['NFL', season, week, home, away],
    ),
  );
}

/** playerId = keccak256(abi.encodePacked("NFL", teamAbbr, playerSlug)) */
export function playerIdOf(team: string, slug: string): Hex {
  return keccak256(encodePacked(['string', 'string', 'string'], ['NFL', team, slug]));
}

/** Short form for console tables. */
export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
