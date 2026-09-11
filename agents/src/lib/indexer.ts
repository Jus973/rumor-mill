/**
 * indexer.ts — rebuild all market state from logs.
 *
 * LLD §1 design rule: the contract is the only stateful component. Agents are stateless
 * scripts that replay from `getLogs(fromBlock: DEPLOY_BLOCK)` on startup. The web UI uses
 * the same normalization so both show identical numbers.
 */

import type { Address, Hex, PublicClient } from 'viem';
import { SAM_ABI, CONTRACT_ADDRESS, DEPLOY_BLOCK } from './chain.js';
import { ReportTag, Practice, Outcome, Bucket } from './enums.js';
import {
  ledger,
  attributeRefunds,
  type SettledEvent,
  type PenaltyEvent,
  type SellerLedger,
} from './scoring.js';

export interface IndexedGame {
  gameId: Hex;
  lockTime: number;
  attested: boolean;
  reportHash?: Hex;
  inactivePlayerIds: Hex[];
  voided: boolean;
}

export interface IndexedBounty {
  bountyId: number;
  buyer: Address;
  gameId: Hex;
  playerId: Hex;
  revealFee: bigint;
  contingent: bigint;
}

export interface IndexedClaim {
  claimId: number;
  bountyId: number;
  seller: Address;
  commitHash: Hex;
  bond: bigint;
  priorTag: ReportTag;
  priorPractice: Practice;
  ciphertext: Hex;
  blockNumber: bigint;
  purchased: boolean;
  buyer?: Address;
  encKey?: Hex;
  revealed?: { claimed: Outcome; bucket: Bucket; evidence: Hex };
  settled?: { correct: boolean; actual: Outcome; escrowReleased: bigint };
  slashed: boolean;
  refunded: boolean;
}

export interface MarketState {
  games: Map<Hex, IndexedGame>;
  bounties: Map<number, IndexedBounty>;
  claims: Map<number, IndexedClaim>;
  priors: Map<string, { tag: ReportTag; practice: Practice }>;
  encPubKeys: Map<Address, Hex>;
  ledger: Map<string, SellerLedger>;
  /** Raw scorer inputs, so callers can re-fold over a subset (e.g. a single demo run). */
  settledEvents: SettledEvent[];
  penaltyEvents: PenaltyEvent[];
  toBlock: bigint;
}

export const priorKey = (gameId: Hex, playerId: Hex) => `${gameId}:${playerId}`;

/**
 * Replay the whole market. `getLogs` with no event filter returns every log from the
 * contract in block order, which keeps this to one RPC round trip per range.
 */
export async function indexMarket(
  client: PublicClient,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<MarketState> {
  const fromBlock = opts.fromBlock ?? DEPLOY_BLOCK;
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());

  const logs = await client.getLogs({
    address: CONTRACT_ADDRESS,
    fromBlock,
    toBlock,
  });

  const state: MarketState = {
    games: new Map(),
    bounties: new Map(),
    claims: new Map(),
    priors: new Map(),
    encPubKeys: new Map(),
    ledger: new Map(),
    settledEvents: [],
    penaltyEvents: [],
    toBlock,
  };

  const settled: SettledEvent[] = [];
  const penalties: PenaltyEvent[] = [];
  const refunded: Array<{ claimId: number; bond: bigint }> = [];
  const sellerOfClaim = new Map<number, string>();
  // committedAt/lockTime are needed by the scorer but ClaimCommitted does not carry a
  // timestamp, so take it from ClaimSettled itself (which does).

  const { decodeEventLog } = await import('viem');

  for (const log of logs) {
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: SAM_ABI, data: log.data, topics: log.topics }) as typeof ev;
    } catch {
      continue; // not one of ours
    }
    const a = ev.args as Record<string, never>;

    switch (ev.eventName) {
      case 'GameCreated':
        state.games.set(a.gameId, {
          gameId: a.gameId,
          lockTime: Number(a.lockTime),
          attested: false,
          inactivePlayerIds: [],
          voided: false,
        });
        break;

      case 'PriorSet':
        state.priors.set(priorKey(a.gameId, a.playerId), {
          tag: Number(a.tag) as ReportTag,
          practice: Number(a.practice) as Practice,
        });
        break;

      case 'EncPubKeyRegistered':
        state.encPubKeys.set(a.who, a.pubKey);
        break;

      case 'BountyPosted':
        state.bounties.set(Number(a.bountyId), {
          bountyId: Number(a.bountyId),
          buyer: a.buyer,
          gameId: a.gameId,
          playerId: a.playerId,
          revealFee: a.revealFee,
          contingent: a.contingent,
        });
        break;

      case 'ClaimCommitted': {
        const id = Number(a.claimId);
        state.claims.set(id, {
          claimId: id,
          bountyId: Number(a.bountyId),
          seller: a.seller,
          commitHash: a.commitHash,
          bond: a.bond,
          priorTag: Number(a.priorTag) as ReportTag,
          priorPractice: Number(a.priorPractice) as Practice,
          ciphertext: a.ciphertext,
          blockNumber: log.blockNumber ?? 0n,
          purchased: false,
          slashed: false,
          refunded: false,
        });
        sellerOfClaim.set(id, String(a.seller).toLowerCase());
        break;
      }

      case 'ClaimPurchased': {
        const c = state.claims.get(Number(a.claimId));
        if (c) {
          c.purchased = true;
          c.buyer = a.buyer;
        }
        break;
      }

      case 'KeyDelivered': {
        const c = state.claims.get(Number(a.claimId));
        if (c) c.encKey = a.encKey;
        break;
      }

      case 'Attested': {
        const g = state.games.get(a.gameId);
        if (g) {
          g.attested = true;
          g.reportHash = a.reportHash;
          g.inactivePlayerIds = [...(a.inactivePlayerIds as unknown as Hex[])];
        }
        break;
      }

      case 'AttestationVoided': {
        const g = state.games.get(a.gameId);
        if (g) g.voided = true;
        break;
      }

      case 'ClaimRevealed': {
        const c = state.claims.get(Number(a.claimId));
        if (c) {
          c.revealed = {
            claimed: Number(a.claimed) as Outcome,
            bucket: Number(a.bucket) as Bucket,
            evidence: a.evidence,
          };
        }
        break;
      }

      case 'ClaimSettled': {
        const id = Number(a.claimId);
        const c = state.claims.get(id);
        if (c) {
          c.settled = {
            correct: Boolean(a.correct),
            actual: Number(a.actual) as Outcome,
            escrowReleased: a.escrowReleased,
          };
        }
        settled.push({
          claimId: id,
          seller: String(a.seller),
          correct: Boolean(a.correct),
          actual: Number(a.actual) as Outcome,
          bucket: Number(a.bucket) as Bucket,
          priorTag: Number(a.priorTag) as ReportTag,
          priorPractice: Number(a.priorPractice) as Practice,
          committedAt: Number(a.committedAt),
          lockTime: Number(a.lockTime),
          bond: a.bond as unknown as bigint,
          escrowReleased: a.escrowReleased as unknown as bigint,
        });
        break;
      }

      case 'ClaimSlashed': {
        const id = Number(a.claimId);
        const c = state.claims.get(id);
        if (c) c.slashed = true;
        penalties.push({
          claimId: id,
          seller: String(a.seller),
          bond: a.bond as unknown as bigint,
          kind: 'slashed',
        });
        break;
      }

      case 'ClaimRefunded': {
        const id = Number(a.claimId);
        const c = state.claims.get(id);
        if (c) c.refunded = true;
        // No seller field on this event (§3.4) — joined below against ClaimCommitted.
        refunded.push({ claimId: id, bond: a.bond as unknown as bigint });
        break;
      }
    }
  }

  penalties.push(...attributeRefunds(refunded, sellerOfClaim));
  state.settledEvents = settled;
  state.penaltyEvents = penalties;
  state.ledger = ledger({ settled, penalties });
  return state;
}

export function claimsForBounty(state: MarketState, bountyId: number): IndexedClaim[] {
  return [...state.claims.values()]
    .filter((c) => c.bountyId === bountyId)
    .sort((a, b) => a.claimId - b.claimId);
}

export function claimsBySeller(state: MarketState, seller: Address): IndexedClaim[] {
  const s = seller.toLowerCase();
  return [...state.claims.values()]
    .filter((c) => c.seller.toLowerCase() === s)
    .sort((a, b) => a.claimId - b.claimId);
}

export function openBounties(state: MarketState, now: number): IndexedBounty[] {
  return [...state.bounties.values()].filter((b) => {
    const g = state.games.get(b.gameId);
    return g && now < g.lockTime;
  });
}
