/**
 * seller.ts — shared seller runtime (LLD §4.2, §4.3).
 *
 * Both sellers differ ONLY in `decide()`. Everything else — sealing, bonding, key delivery,
 * and mandatory reveal — is identical, and is the part the mechanism actually depends on.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import type { Hex, PublicClient, WalletClient } from 'viem';
import { bytesToHex, hexToBytes } from 'viem';
import { SAM_ABI, CONTRACT_ADDRESS, short } from './chain.js';
import { send, sendBatch, read } from './tx.js';
import { act, info } from './log.js';
import { Outcome, Bucket, ReportTag, Practice } from './enums.js';
import {
  sealClaim,
  wrapKeyForBuyer,
  randomSalt,
  type ClaimPayload,
  type EvidenceItem,
} from './crypto.js';
import type { MarketState, IndexedBounty } from './indexer.js';
import type { ResolvedPlayer } from './fixtures.js';

export interface Decision {
  claimed: Outcome;
  bucket: Bucket;
  evidence: EvidenceItem[];
  rationale: string;
}

export type Decider = (ctx: {
  player: ResolvedPlayer;
  priorTag: ReportTag;
  priorPractice: Practice;
  now: number;
  t0: number;
}) => Decision | null;

interface StoredClaim {
  claimId: number;
  bountyId: number;
  payload: ClaimPayload;
  key: Hex; // K, withheld until purchase
  evidenceBytes: Hex;
  commitHash: Hex;
}

export class Seller {
  private store = new Map<number, StoredClaim>();
  private delivered = new Set<number>();
  private revealed = new Set<number>();

  constructor(
    public name: string,
    private pub: PublicClient,
    private wallet: WalletClient,
    private decide: Decider,
    /** Claims this seller deliberately never reveals — demonstrates slashing (§4.6). */
    public withholdReveal: (c: { bountyId: number; player: ResolvedPlayer }) => boolean = () => false,
  ) {
    this.load();
  }

  get address() {
    return this.wallet.account!.address;
  }
  private get path() {
    return `out/seller-${this.address.toLowerCase()}.json`;
  }

  private load() {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoredClaim[];
    for (const c of raw) this.store.set(c.claimId, c);
  }

  private persist() {
    mkdirSync('out', { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.store.values()], null, 2) + '\n');
  }

  /**
   * Fill an open bounty with a sealed, bonded claim. The bond is chosen from the bucket
   * (`bondFor`), but the bucket itself stays hidden until reveal.
   */
  async fill(b: IndexedBounty, player: ResolvedPlayer, priorTag: ReportTag, priorPractice: Practice, now: number, t0: number) {
    const d = this.decide({ player, priorTag, priorPractice, now, t0 });
    if (!d) {
      info(`${this.name} skips bounty#${b.bountyId} (${player.slug}) — no edge over the prior`);
      return null;
    }

    const payload: ClaimPayload = {
      v: 1,
      bountyId: b.bountyId,
      claimed: d.claimed,
      bucket: d.bucket,
      evidence: d.evidence,
      rationale: d.rationale,
      salt: randomSalt(),
    };
    const sealed = sealClaim(payload);
    const bond = await read<bigint>(this.pub, 'bondFor', [d.bucket]);

    const { hash, receipt } = await send(this.pub, this.wallet, {
      functionName: 'fillBounty',
      args: [BigInt(b.bountyId), sealed.commitHash, bytesToHex(sealed.ciphertext)],
      value: bond,
    });

    const claimId = await this.claimIdFrom(receipt);
    this.store.set(claimId, {
      claimId,
      bountyId: b.bountyId,
      payload,
      key: bytesToHex(sealed.key),
      evidenceBytes: bytesToHex(sealed.evidenceBytes),
      commitHash: sealed.commitHash,
    });
    this.persist();

    act(
      this.name,
      `fillBounty#${b.bountyId} ${player.slug} → claim#${claimId} SEALED bond=${fmt(bond)} (${Bucket[d.bucket]}, content hidden)`,
      hash,
    );
    return claimId;
  }

  /**
   * Fill several INDEPENDENT bounties in one block. Sepolia's ~13s confirmations make
   * serial fills impossible inside a short lock window.
   */
  async fillMany(
    items: Array<{ b: IndexedBounty; player: ResolvedPlayer; priorTag: ReportTag; priorPractice: Practice }>,
    now: number,
    t0: number,
  ): Promise<number[]> {
    const prepared: Array<{ b: IndexedBounty; player: ResolvedPlayer; payload: ClaimPayload; sealed: ReturnType<typeof sealClaim>; bond: bigint; bucket: Bucket }> = [];

    for (const it of items) {
      const d = this.decide({ player: it.player, priorTag: it.priorTag, priorPractice: it.priorPractice, now, t0 });
      if (!d) {
        info(`${this.name} skips bounty#${it.b.bountyId} (${it.player.slug}) — no edge over the public prior`);
        continue;
      }
      const payload: ClaimPayload = {
        v: 1,
        bountyId: it.b.bountyId,
        claimed: d.claimed,
        bucket: d.bucket,
        evidence: d.evidence,
        rationale: d.rationale,
        salt: randomSalt(),
      };
      const sealed = sealClaim(payload);
      const bond = await read<bigint>(this.pub, 'bondFor', [d.bucket]);
      prepared.push({ b: it.b, player: it.player, payload, sealed, bond, bucket: d.bucket });
    }

    if (prepared.length === 0) return [];

    const results = await sendBatch(
      this.pub,
      this.wallet,
      prepared.map((p) => ({
        functionName: 'fillBounty',
        args: [BigInt(p.b.bountyId), p.sealed.commitHash, bytesToHex(p.sealed.ciphertext)],
        value: p.bond,
      })),
    );

    const ids: number[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const claimId = await this.claimIdFrom(results[i].receipt);
      this.store.set(claimId, {
        claimId,
        bountyId: p.b.bountyId,
        payload: p.payload,
        key: bytesToHex(p.sealed.key),
        evidenceBytes: bytesToHex(p.sealed.evidenceBytes),
        commitHash: p.sealed.commitHash,
      });
      ids.push(claimId);
      act(
        this.name,
        `fillBounty#${p.b.bountyId} ${p.player.slug} → claim#${claimId} SEALED bond=${fmt(p.bond)} (${Bucket[p.bucket]}, content hidden)`,
        results[i].hash,
      );
    }
    this.persist();
    return ids;
  }

  private async claimIdFrom(receipt: { logs: readonly { data: Hex; topics: readonly Hex[] }[] }): Promise<number> {
    const { decodeEventLog } = await import('viem');
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: SAM_ABI, data: log.data, topics: log.topics as never });
        if (ev.eventName === 'ClaimCommitted') return Number((ev.args as { claimId: bigint }).claimId);
      } catch {
        /* not ours */
      }
    }
    throw new Error('ClaimCommitted not found in receipt');
  }

  /** Deliver ECIES(buyerPubKey, K) for every purchased claim. This is the sale. */
  async deliverKeys(state: MarketState) {
    const pending: Array<{ claimId: number; encKey: Uint8Array }> = [];
    for (const [claimId, stored] of this.store) {
      if (this.delivered.has(claimId)) continue;
      const c = state.claims.get(claimId);
      if (!c || !c.purchased || c.encKey) continue;

      const buyerPub = state.encPubKeys.get(c.buyer!);
      if (!buyerPub) {
        info(`${this.name} cannot deliver claim#${claimId}: buyer has no registered pubkey`);
        continue;
      }
      pending.push({ claimId, encKey: wrapKeyForBuyer(buyerPub, hexToBytes(stored.key)) });
    }
    if (pending.length === 0) return;

    const results = await sendBatch(
      this.pub,
      this.wallet,
      pending.map((p) => ({
        functionName: 'deliverKey',
        args: [BigInt(p.claimId), bytesToHex(p.encKey)],
      })),
    );
    pending.forEach((p, i) => {
      this.delivered.add(p.claimId);
      act(this.name, `deliverKey claim#${p.claimId} → ECIES(buyerPub, K) ${p.encKey.length}B`, results[i].hash);
    });
  }

  /**
   * Mandatory reveal: EVERY claim, sold or not, or the bond is forfeit. This is what makes
   * a seller's miss history impossible to cherry-pick.
   */
  async revealAll(state: MarketState, playerOf: (bountyId: number) => ResolvedPlayer | undefined) {
    const pending: Array<{ claimId: number; stored: StoredClaim; unsold: boolean }> = [];
    for (const [claimId, stored] of this.store) {
      if (this.revealed.has(claimId)) continue;
      const c = state.claims.get(claimId);
      if (!c || c.revealed || c.slashed || c.refunded) continue;

      const player = playerOf(stored.bountyId);
      if (player && this.withholdReveal({ bountyId: stored.bountyId, player })) {
        act(this.name, `DELIBERATELY NOT REVEALING claim#${claimId} (${player.slug}) — will be slashed`);
        this.revealed.add(claimId); // don't retry
        continue;
      }

      pending.push({ claimId, stored, unsold: !c.purchased });
    }

    if (pending.length === 0) return;
    const results = await sendBatch(
      this.pub,
      this.wallet,
      pending.map((p) => ({
        functionName: 'reveal',
        args: [
          BigInt(p.claimId),
          p.stored.payload.claimed,
          p.stored.payload.bucket,
          p.stored.evidenceBytes,
          p.stored.payload.salt,
        ],
      })),
    );
    pending.forEach((p, i) => {
      this.revealed.add(p.claimId);
      act(
        this.name,
        `reveal claim#${p.claimId} → ${Outcome[p.stored.payload.claimed]}/${Bucket[p.stored.payload.bucket]}${p.unsold ? '  (UNSOLD — revealed anyway)' : ''}`,
        results[i].hash,
      );
    });
  }

  async withdraw() {
    const bal = await read<bigint>(this.pub, 'balances', [this.address]);
    if (bal === 0n) return;
    const { hash } = await send(this.pub, this.wallet, { functionName: 'withdraw', args: [] });
    act(this.name, `withdraw ${fmt(bal)}`, hash);
  }

  claimIds(): number[] {
    return [...this.store.keys()];
  }
}

export function fmt(wei: bigint): string {
  return `${(Number(wei) / 1e18).toFixed(5)} ETH`;
}

export { short };
