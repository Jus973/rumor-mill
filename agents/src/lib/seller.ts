/**
 * seller.ts — shared seller runtime.
 *
 * Both sellers differ ONLY in `decide()`. Everything else — sealing, bonding, pricing, key
 * delivery per buyer, and mandatory reveal — is identical, and is the part the mechanism
 * actually depends on.
 *
 * A seller LISTS whenever it has something to say about a (game, player). It does not wait
 * for a bounty; bounties are the demand it watches, not a precondition.
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
import { isTerminal, type MarketState } from './indexer.js';
import type { ResolvedPlayer } from './fixtures.js';

/**
 * The seller's ask. Flat by design: the contract scales what a correct seller actually
 * collects by lead time and surprise, so the ask is a ceiling, not the price.
 */
export const ASK_REVEAL_FEE = BigInt(process.env.ASK_REVEAL_FEE ?? '100000000000000'); // 0.0001 ETH
export const ASK_CONTINGENT = BigInt(process.env.ASK_CONTINGENT ?? '400000000000000'); // 0.0004 ETH

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

export interface ListItem {
  gameId: Hex;
  playerId: Hex;
  player: ResolvedPlayer;
  priorTag: ReportTag;
  priorPractice: Practice;
}

interface StoredClaim {
  claimId: number;
  gameId: Hex;
  playerId: Hex;
  payload: ClaimPayload;
  key: Hex; // K, withheld until a buyer pays
  evidenceBytes: Hex;
  commitHash: Hex;
}

export class Seller {
  private store = new Map<number, StoredClaim>();
  private delivered = new Set<string>(); // `${claimId}:${buyer}`
  private missed = new Set<string>();
  private revealed = new Set<number>();

  constructor(
    public name: string,
    private pub: PublicClient,
    private wallet: WalletClient,
    public decide: Decider,
    /** Claims this seller deliberately never reveals — demonstrates slashing. */
    public withholdReveal: (c: { claimId: number; player: ResolvedPlayer }) => boolean = () => false,
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
    for (const c of raw) if (c.payload?.v === 2) this.store.set(c.claimId, c);
  }

  private persist() {
    mkdirSync('out', { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.store.values()], null, 2) + '\n');
  }

  /** Have I already listed on this slot? One listing per seller per slot is the convention. */
  hasListed(state: MarketState, gameId: Hex, playerId: Hex): boolean {
    const me = this.address.toLowerCase();
    return [...state.claims.values()].some(
      (c) => c.gameId === gameId && c.playerId === playerId && c.seller.toLowerCase() === me,
    );
  }

  /** List a sealed, bonded claim on one slot. Returns null if the strategy declines. */
  async list(it: ListItem, now: number, t0: number): Promise<number | null> {
    const ids = await this.listMany([it], now, t0);
    return ids[0] ?? null;
  }

  /**
   * List several INDEPENDENT claims in one block. Sepolia's ~13s confirmations make serial
   * listings impossible inside a short lock window.
   */
  async listMany(items: ListItem[], now: number, t0: number): Promise<number[]> {
    const prepared: Array<{ it: ListItem; payload: ClaimPayload; sealed: ReturnType<typeof sealClaim>; bond: bigint }> = [];

    for (const it of items) {
      const d = this.decide({ player: it.player, priorTag: it.priorTag, priorPractice: it.priorPractice, now, t0 });
      if (!d) {
        info(`${this.name} skips ${it.player.slug} — no edge over the public report`);
        continue;
      }
      const payload: ClaimPayload = {
        v: 2,
        gameId: it.gameId,
        playerId: it.playerId,
        claimed: d.claimed,
        bucket: d.bucket,
        evidence: d.evidence,
        rationale: d.rationale,
        salt: randomSalt(),
      };
      const sealed = sealClaim(payload);
      const bond = await read<bigint>(this.pub, 'bondFor', [d.bucket]);
      prepared.push({ it, payload, sealed, bond });
    }

    if (prepared.length === 0) return [];

    const results = await sendBatch(
      this.pub,
      this.wallet,
      prepared.map((p) => ({
        functionName: 'listClaim',
        args: [
          p.it.gameId,
          p.it.playerId,
          p.sealed.commitHash,
          bytesToHex(p.sealed.ciphertext),
          ASK_REVEAL_FEE,
          ASK_CONTINGENT,
        ],
        value: p.bond,
      })),
    );

    const ids: number[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const claimId = await this.claimIdFrom(results[i].receipt);
      this.store.set(claimId, {
        claimId,
        gameId: p.it.gameId,
        playerId: p.it.playerId,
        payload: p.payload,
        key: bytesToHex(p.sealed.key),
        evidenceBytes: bytesToHex(p.sealed.evidenceBytes),
        commitHash: p.sealed.commitHash,
      });
      ids.push(claimId);
      act(
        this.name,
        `listClaim ${p.it.player.slug} → claim#${claimId} SEALED bond=${fmt(p.bond)} ask=${fmt(ASK_REVEAL_FEE)}+${fmt(ASK_CONTINGENT)} (${Bucket[p.payload.bucket]}, content hidden)`,
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
        if (ev.eventName === 'ClaimListed') return Number((ev.args as { claimId: bigint }).claimId);
      } catch {
        /* not ours */
      }
    }
    throw new Error('ClaimListed not found in receipt');
  }

  /** Deliver ECIES(buyerPubKey, K) to every buyer who has paid. This is the sale. */
  async deliverKeys(state: MarketState, nowSec = Math.floor(Date.now() / 1000)) {
    const pending: Array<{ claimId: number; buyer: `0x${string}`; encKey: Uint8Array }> = [];
    for (const [claimId, stored] of this.store) {
      const c = state.claims.get(claimId);
      if (!c) continue;
      const g = state.games.get(c.gameId);
      for (const p of c.purchases.values()) {
        const key = `${claimId}:${p.buyer.toLowerCase()}`;
        if (p.encKey || p.refunded || this.delivered.has(key)) continue;
        const buyerPub = state.encPubKeys.get(p.buyer);
        if (!buyerPub) {
          info(`${this.name} cannot deliver claim#${claimId} to ${short(p.buyer)}: no registered pubkey`);
          continue;
        }
        // deliverKey reverts once the game locks. A purchase made at the cliff can miss its
        // delivery window — the buyer then reclaims fee AND escrow via refundUndelivered.
        if (g && nowSec >= g.lockTime) {
          if (!this.missed.has(key)) {
            this.missed.add(key);
            info(`${this.name} MISSED the delivery window on claim#${claimId} for ${short(p.buyer)} — they will be refunded`);
          }
          continue;
        }
        pending.push({ claimId, buyer: p.buyer, encKey: wrapKeyForBuyer(buyerPub, hexToBytes(stored.key)) });
      }
    }
    if (pending.length === 0) return;

    const results = await sendBatch(
      this.pub,
      this.wallet,
      pending.map((p) => ({
        functionName: 'deliverKey',
        args: [BigInt(p.claimId), p.buyer, bytesToHex(p.encKey)],
      })),
    );
    pending.forEach((p, i) => {
      this.delivered.add(`${p.claimId}:${p.buyer.toLowerCase()}`);
      act(this.name, `deliverKey claim#${p.claimId} → ${short(p.buyer)}  ECIES(buyerPub, K) ${p.encKey.length}B`, results[i].hash);
    });
  }

  /**
   * Mandatory reveal: EVERY listing, sold or not, or the bond is forfeit. This is what makes
   * a seller's miss history impossible to cherry-pick.
   */
  async revealAll(state: MarketState, playerOf: (gameId: Hex, playerId: Hex) => ResolvedPlayer | undefined) {
    const pending: Array<{ claimId: number; stored: StoredClaim; unsold: boolean }> = [];
    for (const [claimId, stored] of this.store) {
      if (this.revealed.has(claimId)) continue;
      const c = state.claims.get(claimId);
      if (!c || c.revealed || isTerminal(c)) continue;
      const g = state.games.get(c.gameId);
      if (!g || !g.attested) continue;

      const player = playerOf(stored.gameId, stored.playerId);
      if (player && this.withholdReveal({ claimId, player })) {
        act(this.name, `DELIBERATELY NOT REVEALING claim#${claimId} (${player.slug}) — will be slashed`);
        this.revealed.add(claimId); // don't retry
        continue;
      }
      pending.push({ claimId, stored, unsold: c.purchases.size === 0 });
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

  /** Crank `resolvePurchase` for every buyer of my settled listings, collecting my share. */
  async resolveAll(state: MarketState) {
    const pending: Array<{ claimId: number; buyer: `0x${string}` }> = [];
    for (const claimId of this.store.keys()) {
      const c = state.claims.get(claimId);
      if (!c || !isTerminal(c)) continue;
      for (const p of c.purchases.values()) {
        if (p.refunded || p.resolved) continue;
        pending.push({ claimId, buyer: p.buyer });
      }
    }
    if (pending.length === 0) return;
    const results = await sendBatch(
      this.pub,
      this.wallet,
      pending.map((p) => ({ functionName: 'resolvePurchase', args: [BigInt(p.claimId), p.buyer] })),
    );
    pending.forEach((p, i) => act(this.name, `resolvePurchase claim#${p.claimId} ← ${short(p.buyer)}`, results[i].hash));
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
