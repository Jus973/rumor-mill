/**
 * buyer.ts — the lineup optimizer.
 *
 * Posts bounties (bids) on the slots it is uncertain about, SEARCHES the listings that
 * answer them, buys the best-rated ones before lock, decrypts them, verifies each against
 * its on-chain commitment, and pools them with the public prior into a START/BENCH call.
 *
 * Verification is the point: decrypting is not trusting. A payload that does not rehash to
 * the committed hash is discarded and its seller blacklisted for the run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { hexToBytes } from 'viem';
import { publicClient, roleWallet, buyerEncKeys, short } from './lib/chain.js';
import { send, sendBatch, read, expectRevert } from './lib/tx.js';
import { act, info } from './lib/log.js';
import { Outcome, Bucket, ReportTag } from './lib/enums.js';
import { openClaim } from './lib/crypto.js';
import { BUCKET_MID, priorPActive, ensembleWeight, type SellerLedger } from './lib/scoring.js';
import {
  indexMarket,
  offersForBounty,
  claimsFor,
  priorKey,
  isTerminal,
  purchaseBy,
  type MarketState,
  type IndexedClaim,
} from './lib/indexer.js';
import { fmt } from './lib/seller.js';
import type { ResolvedFixture, ResolvedPlayer } from './lib/fixtures.js';

/** The buyer's budget per slot. A listing whose ask exceeds either leg is not shown. */
export const MAX_REVEAL_FEE = BigInt(process.env.MAX_REVEAL_FEE ?? '200000000000000'); // 0.0002 ETH
export const MAX_CONTINGENT = BigInt(process.env.MAX_CONTINGENT ?? '800000000000000'); // 0.0008 ETH

export interface OpenedClaim {
  claimId: number;
  seller: Address;
  claimed: Outcome;
  bucket: Bucket;
  rationale: string;
  verified: boolean;
}

export interface SlotDecision {
  player: string;
  playerId: Hex;
  priorPActive: number;
  pActive: number;
  decision: 'START' | 'BENCH';
  sources: number[];
  detail: Array<{ claimId: number; seller: string; p: number; weight: number; verified: boolean }>;
}

export class Buyer {
  private bounties = new Map<number, { gameId: Hex; playerId: Hex; player: ResolvedPlayer }>();
  private opened = new Map<number, OpenedClaim>();
  private blacklist = new Set<string>();
  private purchased = new Set<number>();

  constructor(
    private pub: PublicClient,
    private wallet: WalletClient,
    private fixture: ResolvedFixture,
  ) {}

  get address(): Address {
    return this.wallet.account!.address;
  }

  /**
   * Register the ECIES pubkey AND post a bid on every uncertain slot
   * (prior tag ∈ {QUESTIONABLE, DOUBTFUL}) in a single block.
   */
  async registerAndPostBounties(only?: ResolvedPlayer[]) {
    const pubKey = buyerEncKeys().publicKey;
    const existing = await read<Hex>(this.pub, 'encPubKeys', [this.address]);
    const needsKey = !existing || existing === '0x';

    const slots: Array<{ gameId: Hex; player: ResolvedPlayer }> = [];
    for (const g of this.fixture.games) {
      for (const p of g.players) {
        if (only) {
          if (!only.some((x) => x.playerId === p.playerId)) continue;
        } else if (p.priorTag !== ReportTag.QUESTIONABLE && p.priorTag !== ReportTag.DOUBTFUL) {
          continue;
        }
        slots.push({ gameId: g.gameId, player: p });
      }
    }

    const batch = [
      ...(needsKey ? [{ functionName: 'registerEncPubKey', args: [pubKey] as const }] : []),
      ...slots.map((s) => ({
        functionName: 'postBounty',
        args: [s.gameId, s.player.playerId, MAX_REVEAL_FEE, MAX_CONTINGENT] as const,
      })),
    ];
    if (batch.length === 0) return;
    const results = await sendBatch(this.pub, this.wallet, batch as never);

    let i = 0;
    if (needsKey) {
      act('BUYER', `registerEncPubKey ${pubKey.slice(0, 20)}…`, results[i].hash);
      i++;
    } else {
      info('BUYER encryption pubkey already registered');
    }

    const lineup: unknown[] = [];
    for (const s of slots) {
      const bountyId = await this.bountyIdFrom(results[i].receipt);
      this.bounties.set(bountyId, { gameId: s.gameId, playerId: s.player.playerId, player: s.player });
      lineup.push({
        gameId: s.gameId,
        playerId: s.player.playerId,
        player: s.player.name,
        maxRevealFeeWei: MAX_REVEAL_FEE.toString(),
        maxContingentWei: MAX_CONTINGENT.toString(),
      });
      act('BUYER', `postBounty#${bountyId} ${s.player.slug} (${s.player.prior.tag}/${s.player.prior.practice}) budget ≤ ${fmt(MAX_REVEAL_FEE)}+${fmt(MAX_CONTINGENT)}`, results[i].hash);
      i++;
    }

    mkdirSync('out', { recursive: true });
    writeFileSync('out/lineup.json', JSON.stringify({ slots: lineup }, null, 2) + '\n');
  }

  private async bountyIdFrom(receipt: { logs: readonly { data: Hex; topics: readonly Hex[] }[] }): Promise<number> {
    const { decodeEventLog } = await import('viem');
    const { SAM_ABI } = await import('./lib/chain.js');
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: SAM_ABI, data: log.data, topics: log.topics as never });
        if (ev.eventName === 'BountyPosted') return Number((ev.args as { bountyId: bigint }).bountyId);
      } catch {
        /* not ours */
      }
    }
    throw new Error('BountyPosted not found in receipt');
  }

  /** Re-attach a bounty discovered from logs (the CLI restarts between commands). */
  adoptBounty(bountyId: number, gameId: Hex, playerId: Hex, player: ResolvedPlayer) {
    if (!this.bounties.has(bountyId)) this.bounties.set(bountyId, { gameId, playerId, player });
  }

  bountyIds(): number[] {
    return [...this.bounties.keys()];
  }

  /** Listings that answer one of my bids and that I have not bought. */
  offers(state: MarketState, bountyId: number): IndexedClaim[] {
    return offersForBounty(state, bountyId).filter(
      (c) =>
        !isTerminal(c) &&
        !c.revealed &&
        !purchaseBy(c, this.address) &&
        !this.blacklist.has(c.seller.toLowerCase()) &&
        c.seller.toLowerCase() !== this.address.toLowerCase(),
    );
  }

  /** Buy one specific listing at its ask, for the interactive terminal. */
  async purchaseOne(state: MarketState, claimId: number) {
    const c = state.claims.get(claimId);
    if (!c) throw new Error(`no claim #${claimId}`);
    if (purchaseBy(c, this.address)) throw new Error(`you already bought claim #${claimId}`);
    const { hash } = await send(this.pub, this.wallet, {
      functionName: 'purchase',
      args: [BigInt(claimId)],
      value: c.askRevealFee + c.askContingent,
    });
    this.purchased.add(claimId);
    act('BUYER', `purchase claim#${claimId} from ${short(c.seller)} for ${fmt(c.askRevealFee + c.askContingent)} — content still sealed`, hash);
  }

  /**
   * Buy the top-k listings per bid, ranked by the seller's ledger score. Reputation is the
   * only signal available pre-purchase: the claim itself is sealed.
   */
  async purchaseTopK(state: MarketState, k = 2) {
    const picks: IndexedClaim[] = [];
    const seen = new Set<number>();
    for (const [bountyId, b] of this.bounties) {
      const candidates = this.offers(state, bountyId).filter((c) => !seen.has(c.claimId));
      if (candidates.length === 0) continue;
      const ranked = candidates.sort((x, y) => scoreOf(state.ledger, y.seller) - scoreOf(state.ledger, x.seller));
      const take = ranked.slice(0, k);
      info(`BUYER bounty#${bountyId} ${b.player.slug}: ${candidates.length} matching listing(s), buying top ${take.length} by ledger score`);
      for (const c of take) {
        picks.push(c);
        seen.add(c.claimId);
      }
    }

    if (picks.length === 0) return;
    const results = await sendBatch(
      this.pub,
      this.wallet,
      picks.map((c) => ({
        functionName: 'purchase',
        args: [BigInt(c.claimId)],
        value: c.askRevealFee + c.askContingent,
      })),
    );
    picks.forEach((c, i) => {
      this.purchased.add(c.claimId);
      act('BUYER', `purchase claim#${c.claimId} from ${short(c.seller)} (rep ${scoreOf(state.ledger, c.seller).toFixed(2)}) for ${fmt(c.askRevealFee + c.askContingent)} — content still sealed`, results[i].hash);
    });
  }

  /** Decrypt every delivered key and verify the payload against the on-chain commitment. */
  openDelivered(state: MarketState): OpenedClaim[] {
    const out: OpenedClaim[] = [];
    const { privateKey } = buyerEncKeys();
    const mySlots = new Set([...this.bounties.values()].map((b) => priorKey(b.gameId, b.playerId)));

    for (const c of state.claims.values()) {
      const p = purchaseBy(c, this.address);
      if (!p || !p.encKey || this.opened.has(c.claimId)) continue;
      // Only this run's slots — the contract may carry claims from earlier demo runs.
      if (!mySlots.has(priorKey(c.gameId, c.playerId))) continue;

      try {
        const { payload, verified } = openClaim({
          buyerPrivKey: privateKey,
          encKey: hexToBytes(p.encKey),
          ciphertext: hexToBytes(c.ciphertext),
          commitHash: c.commitHash,
        });
        const rec: OpenedClaim = {
          claimId: c.claimId,
          seller: c.seller,
          claimed: payload.claimed,
          bucket: payload.bucket,
          rationale: payload.rationale,
          verified,
        };
        if (!verified) {
          this.blacklist.add(c.seller.toLowerCase());
          act('BUYER', `claim#${c.claimId} COMMIT MISMATCH — discarded, seller ${short(c.seller)} blacklisted`);
        } else {
          act('BUYER', `decrypt claim#${c.claimId} → ${Outcome[payload.claimed]}/${Bucket[payload.bucket]}  commitHash ✓ verified`);
          info(`          └ "${payload.rationale}"`);
        }
        this.opened.set(c.claimId, rec);
        out.push(rec);
      } catch {
        // Garbage key: loss is bounded to the reveal fee.
        this.blacklist.add(c.seller.toLowerCase());
        act('BUYER', `claim#${c.claimId} KEY FAILED TO DECRYPT — seller ${short(c.seller)} blacklisted (loss bounded to reveal fee)`);
      }
    }
    return out;
  }

  /**
   * Logit-pool the public prior with each verified claim, weighting sellers by reputation.
   * The prior always carries weight 1, so an unrated seller cannot move the decision alone.
   */
  ensemble(state: MarketState): SlotDecision[] {
    const decisions: SlotDecision[] = [];

    for (const b of this.bounties.values()) {
      const prior = state.priors.get(priorKey(b.gameId, b.playerId));
      const p0 = prior ? priorPActive(prior.tag, prior.practice) : 0.5;

      const detail: SlotDecision['detail'] = [
        { claimId: -1, seller: 'public-prior', p: p0, weight: 1, verified: true },
      ];
      let wSum = 1;
      let lSum = logit(p0);

      for (const c of claimsFor(state, b.gameId, b.playerId)) {
        const opened = this.opened.get(c.claimId);
        if (!opened || !opened.verified) continue;
        const q = BUCKET_MID[opened.bucket];
        const pActive = opened.claimed === Outcome.ACTIVE ? q : 1 - q;
        const w = ensembleWeight(scoreOf(state.ledger, c.seller));
        wSum += w;
        lSum += w * logit(pActive);
        detail.push({ claimId: c.claimId, seller: c.seller, p: pActive, weight: w, verified: true });
      }

      const pActive = sigmoid(lSum / wSum);
      decisions.push({
        player: b.player.name,
        playerId: b.playerId,
        priorPActive: p0,
        pActive,
        decision: pActive >= 0.5 ? 'START' : 'BENCH',
        sources: detail.filter((d) => d.claimId >= 0).map((d) => d.claimId),
        detail,
      });
    }

    mkdirSync('out', { recursive: true });
    writeFileSync('out/decision.json', JSON.stringify(decisions, null, 2) + '\n');
    return decisions;
  }

  /** My purchases on this run's slots. */
  myPurchases(state: MarketState): IndexedClaim[] {
    const mySlots = new Set([...this.bounties.values()].map((b) => priorKey(b.gameId, b.playerId)));
    return [...state.claims.values()].filter(
      (c) => purchaseBy(c, this.address) && mySlots.has(priorKey(c.gameId, c.playerId)),
    );
  }

  /** After lock: any purchase with no key refunds the fee AND the escrow. */
  async refundUndelivered(state: MarketState) {
    for (const c of this.myPurchases(state)) {
      const p = purchaseBy(c, this.address)!;
      if (p.encKey || p.refunded || p.resolved) continue;
      const { hash } = await send(this.pub, this.wallet, {
        functionName: 'refundUndelivered',
        args: [BigInt(c.claimId)],
      });
      act('BUYER', `refundUndelivered claim#${c.claimId} — no key before lock, fee + escrow back`, hash);
    }
  }

  /** Crank `resolvePurchase` on my purchases of settled listings, reclaiming escrow. */
  async resolveAll(state: MarketState) {
    const todo = this.myPurchases(state).filter((c) => {
      const p = purchaseBy(c, this.address)!;
      return isTerminal(c) && !p.refunded && !p.resolved;
    });
    if (todo.length === 0) return;
    const results = await sendBatch(
      this.pub,
      this.wallet,
      todo.map((c) => ({ functionName: 'resolvePurchase', args: [BigInt(c.claimId), this.address] })),
    );
    todo.forEach((c, i) => act('BUYER', `resolvePurchase claim#${c.claimId}`, results[i].hash));
  }

  /** Demonstrate the lock cliff: a purchase attempted at/after lock must revert. */
  async attemptLatePurchase(state: MarketState, claimId: number): Promise<string | null> {
    const c = state.claims.get(claimId);
    if (!c) return null;
    const r = await expectRevert(this.pub, this.wallet, {
      functionName: 'purchase',
      args: [BigInt(claimId)],
      value: c.askRevealFee + c.askContingent,
    });
    return r.reverted ? r.reason : null;
  }

  async withdraw() {
    const bal = await read<bigint>(this.pub, 'balances', [this.address]);
    if (bal === 0n) return;
    const { hash } = await send(this.pub, this.wallet, { functionName: 'withdraw', args: [] });
    act('BUYER', `withdraw ${fmt(bal)}`, hash);
  }
}

export function scoreOf(l: Map<string, SellerLedger>, seller: string): number {
  return l.get(seller.toLowerCase())?.score ?? 0;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function makeBuyer(fixture: ResolvedFixture): Buyer {
  return new Buyer(publicClient(), roleWallet('buyer'), fixture);
}

export { indexMarket };
