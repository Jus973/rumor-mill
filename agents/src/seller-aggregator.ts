/**
 * seller-aggregator.ts — the scraper seller (LLD §4.2).
 *
 * Sells LEAD TIME. It watches local-beat reporting that hasn't been republished nationally
 * and turns it into a typed claim. Rules mode is the default and the only mode required;
 * `llm` mode is the documented cut line (§9) and is gated on ANTHROPIC_API_KEY.
 */

import { Outcome, Bucket, ReportTag, Practice } from './lib/enums.js';
import { publicClient, roleWallet } from './lib/chain.js';
import { Seller, type Decider, type Decision } from './lib/seller.js';
import { newsAsOf, type ResolvedPlayer } from './lib/fixtures.js';
import type { EvidenceItem } from './lib/crypto.js';

/**
 * Keyword map (§4.2). Ordered most-specific first; the first match wins so that a decisive
 * phrase ("will not travel") beats a weaker one ("limited") in the same item.
 */
const RULES: Array<{ match: RegExp; claimed: Outcome; bucket: Bucket; why: string }> = [
  { match: /ruled out|will not play|won'?t play|will not travel|won'?t travel|not travel/i,
    claimed: Outcome.INACTIVE, bucket: Bucket.B95, why: 'decisive beat report of non-availability' },
  { match: /did not practice|missed practice|absent from practice|not spotted/i,
    claimed: Outcome.INACTIVE, bucket: Bucket.B68, why: 'absence from practice' },
  { match: /full go|expected to play|full participant|every rep|took part in full/i,
    claimed: Outcome.ACTIVE, bucket: Bucket.B83, why: 'reported full participation' },
  { match: /limited/i,
    claimed: Outcome.ACTIVE, bucket: Bucket.B55, why: 'limited participation, leans active but low confidence' },
];

export function decideFromNews(items: EvidenceItem[]): Decision | null {
  for (const rule of RULES) {
    const hit = items.find((i) => rule.match.test(i.text));
    if (hit) {
      return {
        claimed: rule.claimed,
        bucket: rule.bucket,
        evidence: items,
        rationale: `Aggregator(rules): ${rule.why} — "${hit.text}" [${hit.source}]`,
      };
    }
  }
  return null;
}

export const aggregatorDecider: Decider = ({ player, now, t0 }) => {
  // Only news that has actually broken as of `now` is visible. This is the lead-time edge.
  const items: EvidenceItem[] = newsAsOf(player, t0, now).map((n) => ({
    source: n.source,
    ts: t0 + n.tsOffsetSec,
    text: n.text,
  }));
  if (items.length === 0) return null; // nothing to sell
  return decideFromNews(items);
};

export function makeAggregator(withhold?: Seller['withholdReveal']): Seller {
  return new Seller('AGGREGATOR', publicClient(), roleWallet('aggregator'), aggregatorDecider, withhold);
}

export { ReportTag, Practice, type ResolvedPlayer };
