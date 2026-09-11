/**
 * seller-forecaster.ts — the model seller (LLD §4.3).
 *
 * Sells CALIBRATION, not news. It starts from the same public prior everyone can see and
 * moves it using practice trajectory and injury base rates. It only fills a bounty when it
 * disagrees with the report by more than a margin: agreeing with the prior scores ~0 by
 * construction, so a bond posted on agreement is dead capital.
 */

import { Outcome, Bucket } from './lib/enums.js';
import { publicClient, roleWallet } from './lib/chain.js';
import { priorPActive } from './lib/scoring.js';
import { Seller, type Decider, type Decision } from './lib/seller.js';
import type { ResolvedPlayer } from './lib/fixtures.js';
import type { EvidenceItem } from './lib/crypto.js';
import { Practice } from './lib/enums.js';

/** Only sell disagreement this large or larger. */
export const MARGIN = 0.1;

/** Base rates by injury class: how much a given class shifts P(ACTIVE) when fresh. */
const INJURY_BASE: Record<string, { fresh: number; recoveryPerDay: number }> = {
  'soft-tissue': { fresh: -0.25, recoveryPerDay: 0.02 },
  'bone-bruise': { fresh: -0.2, recoveryPerDay: 0.025 },
  concussion: { fresh: -0.35, recoveryPerDay: 0.03 },
  default: { fresh: -0.15, recoveryPerDay: 0.02 },
};

const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

/** DNP→LIM→FULL over the week is a positive signal; FULL→LIM→DNP is a negative one. */
export function trajectoryAdjustment(traj: Array<keyof typeof Practice>): number {
  if (traj.length < 2) return 0;
  const rank: Record<string, number> = { DNP: 0, LIMITED: 1, FULL: 2, UNKNOWN: 1 };
  let delta = 0;
  for (let i = 1; i < traj.length; i++) {
    delta += (rank[traj[i]] ?? 1) - (rank[traj[i - 1]] ?? 1);
  }
  return delta * 0.12;
}

export function injuryAdjustment(cls: string, daysSince: number): number {
  const base = INJURY_BASE[cls] ?? INJURY_BASE.default;
  return Math.min(0, base.fresh + base.recoveryPerDay * daysSince);
}

export function bucketFor(confidence: number): Bucket {
  if (confidence >= 0.9) return Bucket.B95;
  if (confidence >= 0.75) return Bucket.B83;
  if (confidence >= 0.6) return Bucket.B68;
  return Bucket.B55;
}

export function forecast(player: ResolvedPlayer, p0: number): { p: number; steps: string[] } {
  const steps: string[] = [`prior P(ACTIVE)=${p0.toFixed(2)} from ${player.prior.tag}/${player.prior.practice}`];
  let p = p0;

  const traj = trajectoryAdjustment(player.practiceTrajectory);
  p = clamp01(p + traj);
  steps.push(`practice trajectory [${player.practiceTrajectory.join('→')}] ${traj >= 0 ? '+' : ''}${traj.toFixed(2)} → ${p.toFixed(2)}`);

  const inj = injuryAdjustment(player.injury.class, player.injury.daysSince);
  p = clamp01(p + inj);
  steps.push(`${player.injury.class} at day ${player.injury.daysSince} ${inj.toFixed(2)} → ${p.toFixed(2)}`);

  return { p, steps };
}

export const forecasterDecider: Decider = ({ player, priorTag, priorPractice }) => {
  const p0 = priorPActive(priorTag, priorPractice);
  const { p, steps } = forecast(player, p0);

  // The calibration story in one line: sell disagreement, not agreement.
  if (Math.abs(p - p0) < MARGIN) return null;

  const claimed = p >= 0.5 ? Outcome.ACTIVE : Outcome.INACTIVE;
  const confidence = Math.max(p, 1 - p);
  const evidence: EvidenceItem[] = [
    {
      source: 'forecaster-model',
      ts: Math.floor(Date.now() / 1000),
      text: steps.join(' | '),
    },
  ];

  return {
    claimed,
    bucket: bucketFor(confidence),
    evidence,
    rationale: `Forecaster: P(ACTIVE)=${p.toFixed(2)} vs public prior ${p0.toFixed(2)} (disagreement ${Math.abs(p - p0).toFixed(2)} ≥ margin ${MARGIN})`,
  };
};

export function makeForecaster(withhold?: Seller['withholdReveal']): Seller {
  return new Seller('FORECASTER', publicClient(), roleWallet('forecaster'), forecasterDecider, withhold);
}
