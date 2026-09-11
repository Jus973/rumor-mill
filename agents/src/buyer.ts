/**
 * buyer.ts — the lineup optimizer (LLD §4.4).
 *
 * Posts bounties on the slots it is uncertain about, buys the best-rated sealed claims
 * before lock, decrypts them, verifies each against its on-chain commitment, and pools
 * them with the public prior into a single START/BENCH decision.
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
import { indexMarket, claimsForBounty, priorKey, type MarketState } from './lib/indexer.js';
import { fmt } from './lib/seller.js';
import type { ResolvedFixture, ResolvedPlayer } from './lib/fixtures.js';

export const REVEAL_FEE = 100_000_000_000_000n; // 0.0001 ETH
export const CONTINGENT = 400_000_000_000_000n; // 0.0004 ETH

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
   * Register the ECIES pubkey AND post a bounty on every uncertain slot
   * (prior tag ∈ {QUESTIONABLE, DOUBTFUL}) in a single block. These are independent, and
   * the lock cliff leaves no room for serial confirmations.
   */
  async registerAndPostBounties() {
    const pubKey = buyerEncKeys().publicKey;
    const existing = await read<Hex>(this.pub, 'encPubKeys', [this.address]);
    const needsKey = !existing || existing === '0x';

    const slots: Array<{ gameId: Hex; player: ResolvedPlayer }> = [];
    for (const g of this.fixture.games) {
      for (const p of g.players) {
        if (p.priorTag !== ReportTag.QUESTIONABLE && p.priorTag !== ReportTag.DOUBTFUL) continue;
        slots.push({ gameId: g.gameId, player: p });
      }
    }

    const batch = [
      ...(needsKey ? [{ functionName: 'registerEncPubKey', args: [pubKey] as const }] : []),
      ...slots.map((s) => ({
        functionName: 'postBounty',
        args: [s.gameId, s.player.playerId, REVEAL_FEE, CONTINGENT] as const,
      })),
    ];
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
        revealFeeWei: REVEAL_FEE.toString(),
        contingentWei: CONTINGENT.toString(),
      });
      act('BUYER', `postBounty#${bountyId} ${s.player.slug} (${s.player.prior.tag}/${s.player.prior.practice}) fee=${fmt(REVEAL_FEE)} escrow=${fmt(CONTINGENT)}`, results[i].hash);
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

  bountyIds(): number[] {
    return [...this.bounties.keys()];
  }

  /**
   * Buy the top-k claims per slot, ranked by the seller's ledger score. Reputation is the
   * only signal available pre-purchase: the claim itself is sealed.
   */
  async purchaseTopK(state: MarketState, k = 2) {
    const picks: ReturnType<typeof claimsForBounty> = [];
    for (const [bountyId, b] of this.bounties) {
      const candidates = claimsForBounty(state, bountyId).filter(
        (c) => !c.purchased && !this.blacklist.has(c.seller.toLowerCase()),
      );
      if (candidates.length === 0) continue;

      const ranked = candidates.sort((x, y) => scoreOf(state.ledger, y.seller) - scoreOf(state.ledger, x.seller));
      const take = ranked.slice(0, k);
      info(
        `BUYER bounty#${bountyId} ${b.player.slug}: ${candidates.length} sealed claim(s), buying top ${take.length} by ledger score`,
      );

      for (const c of take) picks.push(c);
    }

    if (picks.length === 0) return;
    const results = await sendBatch(
      this.pub,
      this.wallet,
      picks.map((c) => ({
        functionName: 'purchase',
        args: [BigInt(c.claimId)],
        value: REVEAL_FEE + CONTINGENT,
      })),
    );
    picks.forEach((c, i) => {
      this.purchased.add(c.claimId);
      act('BUYER', `purchase claim#${c.claimId} from ${short(c.seller)} (rep ${scoreOf(state.ledger, c.seller).toFixed(2)}) — content still sealed`, results[i].hash);
    });
  }

  /** Decrypt every delivered key and verify the payload against the on-chain commitment. */
  openDelivered(state: MarketState): OpenedClaim[] {
    const out: OpenedClaim[] = [];
    const { privateKey } = buyerEncKeys();

    for (const c of state.claims.values()) {
      if (!c.encKey || this.opened.has(c.claimId)) continue;
      if (c.buyer?.toLowerCase() !== this.address.toLowerCase()) continue;
      // Only this run's bounties — the contract may carry claims from earlier demo runs.
      if (!this.bounties.has(c.bountyId)) continue;

      try {
        const { payload, verified } = openClaim({
          buyerPrivKey: privateKey,
          encKey: hexToBytes(c.encKey),
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
          // Payload does not match what was committed before lock — do not count it.
          this.blacklist.add(c.seller.toLowerCase());
          act('BUYER', `claim#${c.claimId} COMMIT MISMATCH — discarded, seller ${short(c.seller)} blacklisted`);
        } else {
          act('BUYER', `decrypt claim#${c.claimId} → ${Outcome[payload.claimed]}/${Bucket[payload.bucket]}  commitHash ✓ verified`);
          info(`          └ "${payload.rationale}"`);
        }
        this.opened.set(c.claimId, rec);
        out.push(rec);
      } catch (err) {
        // Garbage key: loss is bounded to the reveal fee (§3.6 residual hole).
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

    for (const [bountyId, b] of this.bounties) {
      const prior = state.priors.get(priorKey(b.gameId, b.playerId));
      const p0 = prior ? priorPActive(prior.tag, prior.practice) : 0.5;

      const detail: SlotDecision['detail'] = [
        { claimId: -1, seller: 'public-prior', p: p0, weight: 1, verified: true },
      ];
      let wSum = 1;
      let lSum = logit(p0);

      for (const c of claimsForBounty(state, bountyId)) {
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

  /** After lock: any purchased claim with no key refunds the fee AND the escrow. */
  async refundUndelivered(state: MarketState) {
    for (const claimId of this.purchased) {
      const c = state.claims.get(claimId);
      if (!c || c.encKey || c.refunded) continue;
      const { hash } = await send(this.pub, this.wallet, {
        functionName: 'refundUndelivered',
        args: [BigInt(claimId)],
      });
      act('BUYER', `refundUndelivered claim#${claimId} — no key before lock, bond burned`, hash);
    }
  }

  /** Demonstrate the lock cliff: a purchase attempted at/after lock must revert. */
  async attemptLatePurchase(claimId: number): Promise<string | null> {
    const r = await expectRevert(this.pub, this.wallet, {
      functionName: 'purchase',
      args: [BigInt(claimId)],
      value: REVEAL_FEE + CONTINGENT,
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

function scoreOf(l: Map<string, SellerLedger>, seller: string): number {
  return l.get(seller.toLowerCase())?.score ?? 0;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function makeBuyer(fixture: ResolvedFixture): Buyer {
  return new Buyer(publicClient(), roleWallet('buyer'), fixture);
}

export { indexMarket };
