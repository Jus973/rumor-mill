/**
 * constants.ts — deployment facts with no Node dependencies.
 *
 * Split out of chain.ts so browser code (the web dashboard) can import the indexer
 * without pulling in `node:fs`, `process.env`, or the private-key loader. chain.ts
 * re-exports everything here, so Node callers are unaffected.
 */

import type { Address } from 'viem';
import { sepolia } from 'viem/chains';
import { SAM_ABI } from './abi.js';

export { SAM_ABI };

/**
 * Deployed on Ethereum Sepolia, NOT Base Sepolia as the LLD assumed (A1): Base faucets
 * were dry, so the fallback chain in A1 was taken.
 */
export const CONTRACT_ADDRESS: Address = '0x7a06f5991498A9D40A03D497d31e3ea81c643d5E';

/**
 * The block the contract was mined in. Taken from the broadcast receipt, not from the
 * script's console.log — that one runs during simulation and is one block early, which
 * would make getLogs miss the deployment block.
 */
export const DEPLOY_BLOCK = 11683458n;

export const CHAIN = sepolia;

export const EXPLORER = `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`;
