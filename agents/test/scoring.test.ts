import { describe, it, expect } from 'vitest';
import {
  ReportTag,
  Practice,
  Outcome,
  Bucket,
  PRIOR_TABLE,
  BUCKET_MID,
  MISS_PENALTY,
  priorPActive,
  leadTimeWeight,
  claimDelta,
  ledger,
  attributeRefunds,
  ensembleWeight,
  rankedLedger,
  type SettledEvent,
} from '../src/lib/scoring.js';

const HOUR = 3600;
const LOCK = 1_800_000_000;

function settled(over: Partial<SettledEvent> = {}): SettledEvent {
  return {
    claimId: 1,
    seller: '0xAAA',
    correct: true,
    actual: Outcome.ACTIVE,
    bucket: Bucket.B55,
    priorTag: ReportTag.PROBABLE,
    priorPractice: Practice.FULL,
    committedAt: LOCK, // late by default -> w = 0.1
    lockTime: LOCK,
    bond: 10n,
    escrowReleased: 0n,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The three worked examples in LLD §4.5 — these pin the formula.
// ---------------------------------------------------------------------------

describe('§4.5 worked examples', () => {
  it('a late ACTIVE/B55 on PROBABLE/FULL is worthless-safe: ~ -0.05', () => {
    // 0.1 * (ln 0.55 - ln 0.95)
    const e = settled({
      bucket: Bucket.B55,
      priorTag: ReportTag.PROBABLE,
      priorPractice: Practice.FULL,
      actual: Outcome.ACTIVE,
      correct: true,
      committedAt: LOCK, // zero lead time
    });
    const expected = 0.1 * (Math.log(0.55) - Math.log(0.95));
    expect(claimDelta(e)).toBeCloseTo(expected, 12);
    expect(claimDelta(e)).toBeCloseTo(-0.0546, 3);
    expect(claimDelta(e)).toBeLessThan(0); // safe + late is not merely small, it is negative
  });

  it('an early contrarian INACTIVE/B83 on QUESTIONABLE/LIMITED that hits: ~ +1.01', () => {
    // 1.0 * (ln 0.825 - ln 0.30)
    const e = settled({
      bucket: Bucket.B83,
      priorTag: ReportTag.QUESTIONABLE,
      priorPractice: Practice.LIMITED,
      actual: Outcome.INACTIVE,
      correct: true,
      committedAt: LOCK - 96 * HOUR, // full lead time -> w = 1.0
    });
    const expected = Math.log(0.825) - Math.log(0.3);
    expect(claimDelta(e)).toBeCloseTo(expected, 12);
    expect(claimDelta(e)).toBeCloseTo(1.0116, 3);
  });

  it('the same call, wrong: ~ -1.39', () => {
    // 1.0 * (ln 0.175 - ln 0.70)
    const e = settled({
      bucket: Bucket.B83,
      priorTag: ReportTag.QUESTIONABLE,
      priorPractice: Practice.LIMITED,
      actual: Outcome.ACTIVE, // claimed INACTIVE, so this is a miss
      correct: false,
      committedAt: LOCK - 96 * HOUR,
    });
    const expected = Math.log(0.175) - Math.log(0.7);
    expect(claimDelta(e)).toBeCloseTo(expected, 12);
    expect(claimDelta(e)).toBeCloseTo(-1.3863, 3);
  });

  it('being wrong costs more than being right earns, for the same contrarian call', () => {
    const base = {
      bucket: Bucket.B83,
      priorTag: ReportTag.QUESTIONABLE,
      priorPractice: Practice.LIMITED,
      committedAt: LOCK - 96 * HOUR,
    };
    const right = claimDelta(settled({ ...base, actual: Outcome.INACTIVE, correct: true }));
    const wrong = claimDelta(settled({ ...base, actual: Outcome.ACTIVE, correct: false }));
    expect(Math.abs(wrong)).toBeGreaterThan(Math.abs(right));
  });
});

// ---------------------------------------------------------------------------
// Formula components
// ---------------------------------------------------------------------------

describe('lead-time weight', () => {
  it('floors at 0.1 with no lead time and saturates at 1.0 after 96h', () => {
    expect(leadTimeWeight(LOCK, LOCK)).toBeCloseTo(0.1, 12);
    expect(leadTimeWeight(LOCK - 48 * HOUR, LOCK)).toBeCloseTo(0.55, 12);
    expect(leadTimeWeight(LOCK - 96 * HOUR, LOCK)).toBeCloseTo(1.0, 12);
    expect(leadTimeWeight(LOCK - 500 * HOUR, LOCK)).toBeCloseTo(1.0, 12); // clamped
  });

  it('never goes negative for a commit after lock', () => {
    expect(leadTimeWeight(LOCK + HOUR, LOCK)).toBeCloseTo(0.1, 12);
  });

  it('earlier is strictly better for a correct contrarian call', () => {
    const mk = (h: number) =>
      claimDelta(
        settled({
          bucket: Bucket.B83,
          priorTag: ReportTag.QUESTIONABLE,
          priorPractice: Practice.LIMITED,
          actual: Outcome.INACTIVE,
          correct: true,
          committedAt: LOCK - h * HOUR,
        }),
      );
    expect(mk(96)).toBeGreaterThan(mk(48));
    expect(mk(48)).toBeGreaterThan(mk(1));
  });
});

describe('prior table', () => {
  it('matches the §4.5 seed table', () => {
    expect(priorPActive(ReportTag.NONE, Practice.FULL)).toBe(0.98);
    expect(priorPActive(ReportTag.QUESTIONABLE, Practice.LIMITED)).toBe(0.7);
    expect(priorPActive(ReportTag.QUESTIONABLE, Practice.DNP)).toBe(0.45);
    expect(priorPActive(ReportTag.DOUBTFUL, Practice.DNP)).toBe(0.03);
    expect(priorPActive(ReportTag.OUT, Practice.DNP)).toBe(0.01);
    expect(priorPActive(ReportTag.PROBABLE, Practice.UNKNOWN)).toBe(0.88);
  });

  it('is a complete 5x4 grid of valid probabilities', () => {
    for (const tag of [0, 1, 2, 3, 4] as ReportTag[]) {
      for (const pr of [0, 1, 2, 3] as Practice[]) {
        const p = priorPActive(tag, pr);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }
    }
  });

  it('bucket midpoints match §4.5', () => {
    expect(BUCKET_MID[Bucket.B55]).toBe(0.55);
    expect(BUCKET_MID[Bucket.B68]).toBe(0.675);
    expect(BUCKET_MID[Bucket.B83]).toBe(0.825);
    expect(BUCKET_MID[Bucket.B95]).toBe(0.95);
  });
});

describe('agreeing with the prior earns ~nothing', () => {
  it('a confident call that merely restates an obvious OUT scores near zero or below', () => {
    const e = settled({
      bucket: Bucket.B95,
      priorTag: ReportTag.OUT,
      priorPractice: Practice.DNP, // prior P(ACTIVE) = 0.01, so INACTIVE is 0.99
      actual: Outcome.INACTIVE,
      correct: true,
      committedAt: LOCK - 96 * HOUR,
    });
    // ln(0.95) - ln(0.99) < 0 : you cannot beat a prior that is already near-certain
    expect(claimDelta(e)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

describe('ledger fold', () => {
  it('accumulates score, n, hits and burned bond per seller', () => {
    const l = ledger({
      settled: [
        settled({ claimId: 1, seller: '0xAAA', correct: true, bond: 100n }),
        settled({ claimId: 2, seller: '0xAAA', correct: false, actual: Outcome.INACTIVE, bond: 200n }),
        settled({ claimId: 3, seller: '0xBBB', correct: true, bond: 50n }),
      ],
    });

    const a = l.get('0xaaa')!;
    expect(a.n).toBe(2);
    expect(a.hits).toBe(1);
    expect(a.hitRate).toBe(0.5);
    expect(a.bondBurned).toBe(200n); // only the wrong claim burns
    expect(a.claims.map((c) => c.claimId)).toEqual([1, 2]);

    const b = l.get('0xbbb')!;
    expect(b.n).toBe(1);
    expect(b.bondBurned).toBe(0n);
  });

  it('is a pure fold: order of events does not change the result', () => {
    const evs = [
      settled({ claimId: 3, seller: '0xAAA', correct: true }),
      settled({ claimId: 1, seller: '0xAAA', correct: false, actual: Outcome.INACTIVE }),
      settled({ claimId: 2, seller: '0xAAA', correct: true }),
    ];
    const forward = ledger({ settled: evs }).get('0xaaa')!;
    const backward = ledger({ settled: [...evs].reverse() }).get('0xaaa')!;

    expect(forward.score).toBeCloseTo(backward.score, 12);
    expect(forward.claims.map((c) => c.claimId)).toEqual([1, 2, 3]);
    expect(backward.claims.map((c) => c.claimId)).toEqual([1, 2, 3]);
  });

  it('normalizes seller addresses to lowercase', () => {
    const l = ledger({
      settled: [
        settled({ claimId: 1, seller: '0xAbCd' }),
        settled({ claimId: 2, seller: '0xABCD' }),
      ],
    });
    expect(l.size).toBe(1);
    expect(l.get('0xabcd')!.n).toBe(2);
  });

  it('an unrevealed claim is the worst outcome available', () => {
    const worstHonestMiss = claimDelta(
      settled({
        bucket: Bucket.B95,
        priorTag: ReportTag.OUT,
        priorPractice: Practice.DNP,
        actual: Outcome.ACTIVE,
        correct: false,
        committedAt: LOCK - 96 * HOUR,
      }),
    );
    // Slashing must dominate any honest miss, or hiding a bad call becomes rational.
    const l = ledger({
      settled: [],
      penalties: [{ claimId: 9, seller: '0xAAA', bond: 500n, kind: 'slashed' }],
    });
    const a = l.get('0xaaa')!;
    expect(a.score).toBeCloseTo(MISS_PENALTY, 12);
    expect(a.bondBurned).toBe(500n);
    expect(a.n).toBe(1);
    expect(a.hits).toBe(0);
    expect(MISS_PENALTY).toBeLessThan(worstHonestMiss);
  });

  it('mixes settled and penalty events for the same seller', () => {
    const l = ledger({
      settled: [settled({ claimId: 1, seller: '0xAAA', correct: true, bond: 10n })],
      penalties: [{ claimId: 2, seller: '0xAAA', bond: 20n, kind: 'refunded' }],
    });
    const a = l.get('0xaaa')!;
    expect(a.n).toBe(2);
    expect(a.hits).toBe(1);
    expect(a.bondBurned).toBe(20n);
    expect(a.claims.map((c) => c.kind)).toEqual(['settled', 'refunded']);
  });

  it('returns an empty ledger for no events', () => {
    expect(ledger({ settled: [] }).size).toBe(0);
  });
});

describe('refund attribution', () => {
  it('joins ClaimRefunded to a seller via ClaimCommitted', () => {
    const sellerOf = new Map([
      [1, '0xAAA'],
      [2, '0xBBB'],
    ]);
    const out = attributeRefunds(
      [
        { claimId: 1, bond: 10n },
        { claimId: 2, bond: 20n },
        { claimId: 99, bond: 30n }, // unknown claim
      ],
      sellerOf,
    );
    expect(out).toHaveLength(2); // the unknown one is dropped, not mis-attributed
    expect(out[0]).toEqual({ claimId: 1, seller: '0xAAA', bond: 10n, kind: 'refunded' });
  });
});

describe('buyer-side helpers', () => {
  it('ensemble weight is 1 for non-positive reputation and grows above it', () => {
    expect(ensembleWeight(-5)).toBe(1);
    expect(ensembleWeight(0)).toBe(1);
    expect(ensembleWeight(1.5)).toBe(2.5);
  });

  it('ranks sellers best-first, deterministically', () => {
    const l = ledger({
      settled: [
        settled({
          claimId: 1,
          seller: '0xGOOD',
          bucket: Bucket.B83,
          priorTag: ReportTag.QUESTIONABLE,
          priorPractice: Practice.LIMITED,
          actual: Outcome.INACTIVE,
          correct: true,
          committedAt: LOCK - 96 * HOUR,
        }),
        settled({
          claimId: 2,
          seller: '0xBAD',
          bucket: Bucket.B83,
          priorTag: ReportTag.QUESTIONABLE,
          priorPractice: Practice.LIMITED,
          actual: Outcome.ACTIVE,
          correct: false,
          committedAt: LOCK - 96 * HOUR,
        }),
      ],
    });
    const ranked = rankedLedger(l);
    expect(ranked[0].seller).toBe('0xgood');
    expect(ranked[0].score).toBeGreaterThan(0);
    expect(ranked[1].seller).toBe('0xbad');
    expect(ranked[1].score).toBeLessThan(0);
  });
});
