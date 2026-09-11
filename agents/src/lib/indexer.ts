/**
 * indexer.ts — rebuild all market state from logs.
 *
 * Design rule: the contract is the only stateful component. Agents are stateless scripts
 * that replay from `getLogs(fromBlock: DEPLOY_BLOCK)` on startup. A web UI would use the
 * same normalization so both show identical numbers.
 *
 * Two independent flows meet here. Sellers LIST claims on (game, player) at an ask.
 * Buyers post BOUNTIES — bids on (game, player) with a budget. Neither references the
 * other on-chain; `offersForBounty` is the matcher.
 */

import type { Address, Hex, PublicClient } from 'viem';
import { SAM_ABI, CONTRACT_ADDRESS, DEPLOY_BLOCK } from './constants.js';
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
  unwound: boolean;
}

/** A buyer's bid. Non-binding. */
export interface IndexedBounty {
  bountyId: number;
  buyer: Address;
  gameId: Hex;
  playerId: Hex;
  maxRevealFee: bigint;
  maxContingent: bigint;
  cancelled: boolean;
}

/** One buyer's purchase of one listing. */
export interface IndexedPurchase {
  buyer: Address;
  revealFee: bigint;
  contingent: bigint;
  encKey?: Hex;
  refunded: boolean;
  resolved?: { toSeller: bigint; toBuyer: bigint };
}

/** A seller's listing. */
export interface IndexedClaim {
  claimId: number;
  seller: Address;
  gameId: Hex;
  playerId: Hex;
  commitHash: Hex;
  bond: bigint;
  askRevealFee: bigint;
  askContingent: bigint;
  committedAt: number;
  priorTag: ReportTag;
  priorPractice: Practice;
  ciphertext: Hex;
  blockNumber: bigint;
  /** keyed by lowercase buyer address */
  purchases: Map<string, IndexedPurchase>;
  revealed?: { claimed: Outcome; bucket: Bucket; evidence: Hex };
  settled?: { correct: boolean; actual: Outcome; payoutBps: number };
  slashed: boolean;
  unwound: boolean;
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
          unwound: false,
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
          maxRevealFee: a.maxRevealFee,
          maxContingent: a.maxContingent,
          cancelled: false,
        });
        break;

      case 'BountyCancelled': {
        const b = state.bounties.get(Number(a.bountyId));
        if (b) b.cancelled = true;
        break;
      }

      case 'ClaimListed': {
        const id = Number(a.claimId);
        state.claims.set(id, {
          claimId: id,
          seller: a.seller,
          gameId: a.gameId,
          playerId: a.playerId,
          commitHash: a.commitHash,
          bond: a.bond,
          askRevealFee: a.askRevealFee,
          askContingent: a.askContingent,
          committedAt: Number(a.committedAt),
          priorTag: Number(a.priorTag) as ReportTag,
          priorPractice: Number(a.priorPractice) as Practice,
          ciphertext: a.ciphertext,
          blockNumber: log.blockNumber ?? 0n,
          purchases: new Map(),
          slashed: false,
          unwound: false,
        });
        sellerOfClaim.set(id, String(a.seller).toLowerCase());
        break;
      }

      case 'ClaimPurchased': {
        const c = state.claims.get(Number(a.claimId));
        if (c) {
          c.purchases.set(String(a.buyer).toLowerCase(), {
            buyer: a.buyer,
            revealFee: a.revealFee,
            contingent: a.contingent,
            refunded: false,
          });
        }
        break;
      }

      case 'KeyDelivered': {
        const p = state.claims.get(Number(a.claimId))?.purchases.get(String(a.buyer).toLowerCase());
        if (p) p.encKey = a.encKey;
        break;
      }

      case 'PurchaseRefunded': {
        const id = Number(a.claimId);
        const p = state.claims.get(id)?.purchases.get(String(a.buyer).toLowerCase());
        if (p) p.refunded = true;
        // No seller field on this event — joined below against ClaimListed. Bond = 0: a
        // refund never burns the bond, so this is a reputational penalty only.
        refunded.push({ claimId: id, bond: 0n });
        break;
      }

      case 'PurchaseResolved': {
        const p = state.claims.get(Number(a.claimId))?.purchases.get(String(a.buyer).toLowerCase());
        if (p) p.resolved = { toSeller: a.toSeller, toBuyer: a.toBuyer };
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

      case 'GameUnwound': {
        const g = state.games.get(a.gameId);
        if (g) g.unwound = true;
        break;
      }

      case 'ClaimUnwound': {
        const c = state.claims.get(Number(a.claimId));
        if (c) c.unwound = true; // terminal, funds returned, nobody scored
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
            payoutBps: Number(a.payoutBps),
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
          payoutBps: Number(a.payoutBps),
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
    }
  }

  penalties.push(...attributeRefunds(refunded, sellerOfClaim));
  state.settledEvents = settled;
  state.penaltyEvents = penalties;
  state.ledger = ledger({ settled, penalties });
  return state;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** A listing is terminal once settled, slashed, or unwound. */
export function isTerminal(c: IndexedClaim): boolean {
  return Boolean(c.settled) || c.slashed || c.unwound;
}

/** Every listing on one (game, player), oldest first. */
export function claimsFor(state: MarketState, gameId: Hex, playerId: Hex): IndexedClaim[] {
  return [...state.claims.values()]
    .filter((c) => c.gameId === gameId && c.playerId === playerId)
    .sort((a, b) => a.claimId - b.claimId);
}

/** Does this listing satisfy this bid? Same slot, ask within budget. */
export function matchesBounty(c: IndexedClaim, b: IndexedBounty): boolean {
  return (
    c.gameId === b.gameId &&
    c.playerId === b.playerId &&
    c.askRevealFee <= b.maxRevealFee &&
    c.askContingent <= b.maxContingent
  );
}

/** THE MATCHER: listings that answer a buyer's bid. Off-chain by design. */
export function offersForBounty(state: MarketState, bountyId: number): IndexedClaim[] {
  const b = state.bounties.get(bountyId);
  if (!b) return [];
  return [...state.claims.values()]
    .filter((c) => matchesBounty(c, b))
    .sort((a, b2) => a.claimId - b2.claimId);
}

/** Open bids on one (game, player) — what a seller sees as demand. */
export function bountiesFor(state: MarketState, gameId: Hex, playerId: Hex, now: number): IndexedBounty[] {
  return [...state.bounties.values()].filter((b) => {
    const g = state.games.get(b.gameId);
    return b.gameId === gameId && b.playerId === playerId && !b.cancelled && g && now < g.lockTime;
  });
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
    return !b.cancelled && g && now < g.lockTime;
  });
}

/** Purchases of this claim by this buyer, if any. */
export function purchaseBy(c: IndexedClaim, buyer: Address): IndexedPurchase | undefined {
  return c.purchases.get(buyer.toLowerCase());
}
