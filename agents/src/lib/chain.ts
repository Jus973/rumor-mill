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
import './env.js'; // side effect: populates process.env from .env if not already set
import { SAM_ABI } from './abi.js';

export { SAM_ABI };

// ---------------------------------------------------------------------------
// Deployment (LLD §8 step 2)
// ---------------------------------------------------------------------------

/**
 * Deployed on Ethereum Sepolia, NOT Base Sepolia as the LLD assumed (A1): Base faucets
 * were dry, so the fallback chain in A1 was taken.
 */
export const CONTRACT_ADDRESS: Address = '0xF82a25dd634Ea459597F41b13A290CFe7F360452';

/**
 * The block the contract was mined in. Taken from the broadcast receipt, not from the
 * script's console.log — that one runs during simulation and is one block early, which
 * would make getLogs miss the deployment block.
 */
export const DEPLOY_BLOCK = 11680684n;

export const CHAIN = sepolia;
export const EXPLORER = `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`;

export function rpcUrl(): string {
  const url = process.env.SEPOLIA_RPC_URL;
  if (!url) {
    throw new Error(
      'SEPOLIA_RPC_URL is not set. Copy .env.example to .env in the repo root and fill it in.',
    );
  }
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

/**
 * The market OPERATOR: scheduler, attester, owner and fee recipient in this deployment.
 * Its key is in .env. This is the primary trust assumption (LLD A3).
 */
export function resolverAccount() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      'PRIVATE_KEY is not set. Copy .env.example to .env in the repo root and fill it in.',
    );
  }
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

/** Alias: the operator holds the scheduler role in this deployment. */
export function schedulerWallet(): WalletClient {
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

/**
 * playerId = keccak256(abi.encodePacked("NFL", gsisId))
 *
 * GSIS is the NFL's own player identifier ("00-0033280"). It is what the official injury
 * report and every downstream data provider key on, so it is the only identifier an oracle
 * can actually resolve. Hashing a team+slug we invented produces an id that exists nowhere
 * outside this repo — fine for a fixture, useless the moment settlement comes from a feed.
 *
 * playerId is baked into every claim and attestation, so this is expensive to change later.
 */
export function playerIdOf(gsisId: string): Hex {
  if (!GSIS_RE.test(gsisId)) {
    throw new Error(`not a GSIS id: "${gsisId}" (expected 00-0000000)`);
  }
  return keccak256(encodePacked(['string', 'string'], ['NFL', gsisId]));
}

/** NFL GSIS ids are "00-" followed by seven digits. */
export const GSIS_RE = /^00-\d{7}$/;

/** Short form for console tables. */
export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
