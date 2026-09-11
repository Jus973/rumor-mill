# HLD — Sealed Availability Market (Black Box Bazaar, sports vertical)

## One-line

A market where tipster agents sell sealed, bonded claims about a player's availability status to lineup-optimizing agents that must lock before kickoff — settled against the official inactive list, with reputation earned for being right early and against the public report.

## The one action the system excels at

Selling a lead-time or calibration advantage on a single typed claim — `(game, player, status, confidence)` — ahead of a hard lineup lock. Nothing else is sold. Every mechanism component exists because of this action.

## Stakeholders

**Sellers (agents)**
- *Aggregators* — LLM scrapers that surface local reporter footage, radio, practice reports, and player social activity before national outlets republish it. Sell lead time plus an evidence trail.
- *Forecasters* — models over injury type, practice trajectory, recovery base rates, and coach behavior that resolve "questionable" into a calibrated probability. Sell information that doesn't exist on any feed.
- *Insiders (humans, optional)* — may participate through a wallet; the design does not depend on them and is not built around private leaks.

**Buyers (agents)**
- Fantasy / DFS / betting optimizers run by sharps. Each has specific players in specific slots and a fixed lock time. They post bounties on the players they're uncertain about, buy several forecasts, and ensemble them weighted by each seller's ledger.

**Resolver**
- A bonded party that attests hashes of official injury-report snapshots as they publish (mid-week updates and the final inactive list). One attestation per game settles every claim on that game. Challengeable within a window. This is the primary trust assumption.

**Operators (humans)**
- Run the agents, hold the keys, and take the revenue. They never touch the protocol per-tip.

**The counterparty (not a participant)**
- Teams and leagues, who actively withhold availability information. Their obfuscation is why lead time and calibration are scarce.

## How the market works (no architecture)

1. **Bounties first.** A buyer posts what it needs: a player, a game, and a price it will pay to resolve that slot before lock.
2. **Sealed claims.** A seller fills the bounty with a committed claim — status and confidence bucket hidden, bond posted, bond scaling with confidence.
3. **Pay, then see.** The buyer pays a small reveal fee and receives the claim and its evidence; a larger contingent payment stays escrowed until settlement.
4. **Lock cliff.** Purchases on a game close at lineup lock. Stale intel cannot be sold by construction.
5. **Batch settlement.** When the resolver attests the official list, all claims on that game settle at once. Correct claims release escrow; wrong ones burn bond.
6. **Mandatory reveal.** Every commitment, sold or not, is revealed at settlement or forfeits its bond. Miss history is permanent; cherry-picking is impossible.
7. **Scoring.** Reputation is improvement over the attested public prior (report tag plus practice status) at the claimed confidence, multiplied by lead time. Safe, late calls earn ~0; early contrarian correct calls earn a lot; wrong contrarian calls cost money.

## Why on-chain

- Commitments are provably pre-event, and no platform can edit or delete the miss history.
- Sellers stay pseudonymous yet accountable through stake.
- Agents participate with wallets, not accounts that can be revoked; escrow settles without an intermediary.

## Why agents

- The market only clears at machine scale: hundreds of small tips per week.
- Commit, pay, decrypt, verify, wait for settlement is tedious for humans and free for agents.
- Sellers are scrapers and models by nature; buyers are optimizers by nature.

## Why it isn't a swappable marketplace

Single-document batch settlement, the lock cliff, a public-prior enum to score surprise against, and slot-shaped demand all break under a rename to any other vertical.

## Trust assumptions

Resolver honesty (bounded by bond and challenge window); buyer key custody; the official report as ground truth.

## Known limitations

- Two-sided cold start: third-party sellers must be bootstrapped; unfilled bounties are the intended pull.
- Tips are non-exclusive; a seller can fill many bounties with the same claim.
- Residual forecaster edge over an informed prior is small; the market is a niche of sharps, not a mass product.
- Insider-sourced claims raise misappropriation concerns; the design scopes to public-source aggregation and modeling.
