/**
 * scoring.ts — the reputation truth (LLD §4.5).
 *
 * A pure fold over settlement events. No chain access, no I/O, no clock: the buyer agent
 * and the web UI both call this and must show identical numbers.
 *
 * The shape of the formula is the whole mechanism:
 *
 *   Δ = w * ( ln(qy) - ln(py) )
 *
 * ...the log-score improvement of the seller's stated confidence over the public prior
 * AS IT STOOD WHEN THEY COMMITTED. Agreeing with an obvious report earns ~0 no matter how
 * confident you are. Disagreeing with it and being right earns a lot. Disagreeing and being
 * wrong costs more than being right earns, and burns the bond on top. Lead time scales all
 * of it, so a correct call made after the news broke is worth almost nothing.
 *
 * `ClaimSettled` carries every input needed here, which is why scoring can live off-chain.
 */

import { ReportTag, Practice, Outcome, Bucket } from './enums.js';

export { ReportTag, Practice, Outcome, Bucket };

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

/**
 * P(ACTIVE) given the official designation and last practice status (LLD §4.5).
 *
 * These are illustrative seed constants, NOT measurements. They are falsifiable: backtest
 * against any public season of injury reports and replace them. The README says so.
 */
export const PRIOR_TABLE: Record<ReportTag, Record<Practice, number>> = {
  [ReportTag.NONE]: {
    [Practice.FULL]: 0.98,
    [Practice.LIMITED]: 0.9,
    [Practice.DNP]: 0.7,
    [Practice.UNKNOWN]: 0.95,
  },
  [ReportTag.PROBABLE]: {
    [Practice.FULL]: 0.95,
    [Practice.LIMITED]: 0.85,
    [Practice.DNP]: 0.65,
    [Practice.UNKNOWN]: 0.88,
  },
  [ReportTag.QUESTIONABLE]: {
    [Practice.FULL]: 0.85,
    [Practice.LIMITED]: 0.7,
    [Practice.DNP]: 0.45,
    [Practice.UNKNOWN]: 0.72,
  },
  [ReportTag.DOUBTFUL]: {
    [Practice.FULL]: 0.15,
    [Practice.LIMITED]: 0.08,
    [Practice.DNP]: 0.03,
    [Practice.UNKNOWN]: 0.08,
  },
  [ReportTag.OUT]: {
    [Practice.FULL]: 0.02,
    [Practice.LIMITED]: 0.02,
    [Practice.DNP]: 0.01,
    [Practice.UNKNOWN]: 0.02,
  },
};

/** Confidence attributed to the seller's stated bucket. */
export const BUCKET_MID: Record<Bucket, number> = {
  [Bucket.B55]: 0.55,
  [Bucket.B68]: 0.675,
  [Bucket.B83]: 0.825,
  [Bucket.B95]: 0.95,
};

/** Lead time saturates at four days. */
export const LEAD_TIME_SATURATION_HOURS = 96;

/** A claim that never revealed is treated as a maximal miss: ln(0.05) at full weight. */
export const MISS_PENALTY = Math.log(0.05);

// ---------------------------------------------------------------------------
// Normalized event inputs
// ---------------------------------------------------------------------------

export interface SettledEvent {
  claimId: number;
  seller: string;
  correct: boolean;
  actual: Outcome;
  bucket: Bucket;
  priorTag: ReportTag;
  priorPractice: Practice;
  committedAt: number;
  lockTime: number;
  bond: bigint;
  /** Share of each buyer's escrow the seller earned (on-chain price multiplier). */
  payoutBps: number;
}

/**
 * `ClaimSlashed` carries the seller. `PurchaseRefunded` does NOT, so the indexer joins it
 * against `ClaimListed` on claimId before it reaches this module — see `attributeRefunds`
 * below. A listing with several undelivered buyers is penalised once, not once per buyer.
 */
export interface PenaltyEvent {
  claimId: number;
  seller: string;
  bond: bigint;
  kind: 'slashed' | 'refunded';
}

export interface ClaimScore {
  claimId: number;
  delta: number;
  correct: boolean | null; // null for slashed/refunded
  bucket: Bucket | null;
  priorPActive: number | null;
  leadTimeHours: number | null;
  weight: number;
  bondBurned: bigint;
  kind: 'settled' | 'slashed' | 'refunded';
}

export interface SellerLedger {
  seller: string;
  score: number;
  n: number;
  hits: number;
  hitRate: number;
  bondBurned: bigint;
  claims: ClaimScore[];
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function priorPActive(tag: ReportTag, practice: Practice): number {
  const row = PRIOR_TABLE[tag];
  if (!row) throw new Error(`unknown ReportTag ${tag}`);
  const p = row[practice];
  if (p === undefined) throw new Error(`unknown Practice ${practice}`);
  return p;
}

/** w = 0.1 + 0.9 * min(1, hoursBeforeLock / 96) */
export function leadTimeWeight(committedAt: number, lockTime: number): number {
  const hours = Math.max(0, (lockTime - committedAt) / 3600);
  return 0.1 + 0.9 * Math.min(1, hours / LEAD_TIME_SATURATION_HOURS);
}

export function leadTimeHours(committedAt: number, lockTime: number): number {
  return Math.max(0, (lockTime - committedAt) / 3600);
}

/**
 * Δ for one settled claim.
 *
 *   p0 = prior P(ACTIVE) at commit time
 *   q  = confidence the seller placed on their stated claim
 *   qy = probability the seller assigned to what actually happened
 *   py = probability the public prior assigned to what actually happened
 */
export function claimDelta(e: SettledEvent): number {
  const p0 = priorPActive(e.priorTag, e.priorPractice);
  const q = BUCKET_MID[e.bucket];
  if (q === undefined) throw new Error(`unknown Bucket ${e.bucket}`);

  const y = e.actual === Outcome.ACTIVE;
  const qy = e.correct ? q : 1 - q;
  const py = y ? p0 : 1 - p0;

  return leadTimeWeight(e.committedAt, e.lockTime) * (Math.log(qy) - Math.log(py));
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Reputation ledger. Deterministic: claims are sorted by claimId so two callers replaying
 * the same logs in different order produce byte-identical tables.
 */
export function ledger(input: {
  settled: SettledEvent[];
  penalties?: PenaltyEvent[];
}): Map<string, SellerLedger> {
  const out = new Map<string, SellerLedger>();

  const get = (seller: string): SellerLedger => {
    const key = seller.toLowerCase();
    let l = out.get(key);
    if (!l) {
      l = { seller: key, score: 0, n: 0, hits: 0, hitRate: 0, bondBurned: 0n, claims: [] };
      out.set(key, l);
    }
    return l;
  };

  for (const e of input.settled) {
    const l = get(e.seller);
    const delta = claimDelta(e);
    l.score += delta;
    l.n += 1;
    if (e.correct) l.hits += 1;
    else l.bondBurned += e.bond;
    l.claims.push({
      claimId: e.claimId,
      delta,
      correct: e.correct,
      bucket: e.bucket,
      priorPActive: priorPActive(e.priorTag, e.priorPractice),
      leadTimeHours: leadTimeHours(e.committedAt, e.lockTime),
      weight: leadTimeWeight(e.committedAt, e.lockTime),
      bondBurned: e.correct ? 0n : e.bond,
      kind: 'settled',
    });
  }

  // A claim that never revealed is the worst possible outcome for a seller: it is the
  // mechanism that makes miss history unhideable, so it must cost more than being wrong.
  for (const e of input.penalties ?? []) {
    const l = get(e.seller);
    l.score += MISS_PENALTY;
    l.n += 1;
    l.bondBurned += e.bond;
    l.claims.push({
      claimId: e.claimId,
      delta: MISS_PENALTY,
      correct: null,
      bucket: null,
      priorPActive: null,
      leadTimeHours: null,
      weight: 1,
      bondBurned: e.bond,
      kind: e.kind,
    });
  }

  for (const l of out.values()) {
    l.claims.sort((a, b) => a.claimId - b.claimId);
    l.hitRate = l.n === 0 ? 0 : l.hits / l.n;
  }
  return out;
}

/**
 * `PurchaseRefunded` has no seller field on-chain, so attribute it via the claimId -> seller
 * map built from `ClaimListed`. Claims with no known seller are dropped rather than
 * silently mis-attributed, and repeated refunds on one listing collapse to one penalty.
 * The bond is not burned by a refund, so the penalty is reputational only (bond = 0).
 */
export function attributeRefunds(
  refunded: Array<{ claimId: number; bond: bigint }>,
  sellerOfClaim: Map<number, string>,
): PenaltyEvent[] {
  const out: PenaltyEvent[] = [];
  const seen = new Set<number>();
  for (const r of refunded) {
    if (seen.has(r.claimId)) continue;
    const seller = sellerOfClaim.get(r.claimId);
    if (!seller) continue;
    seen.add(r.claimId);
    out.push({ claimId: r.claimId, seller, bond: r.bond, kind: 'refunded' });
  }
  return out;
}

/** Buyer ensemble weight (LLD §4.4 step 5): w_i = 1 + max(0, rep_i). */
export function ensembleWeight(score: number): number {
  return 1 + Math.max(0, score);
}

/** Ledger sorted for display: best score first. */
export function rankedLedger(l: Map<string, SellerLedger>): SellerLedger[] {
  return [...l.values()].sort((a, b) => b.score - a.score || a.seller.localeCompare(b.seller));
}
