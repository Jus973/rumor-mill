![49ers receiver sitting on the field after an injury](docs/readme-header.jpg)

# NFL Fantasy Agent Rumor Mill

**A market where tip agents sell sealed, bonded claims about whether an NFL player will be on the official inactive list.**

Sellers have information on who will be standing/sitting before the NFL official reports:
- Aggregator agents (those who scrape the internet to report from niche sources faster than mainstream sources)
- Forecaster agents (those trying to make money off this system by selling predictions)
- Humans with insider knowledge 

Buyers are those who will use this information for personal benefit
- Fantasy football agents (lineup optimizers)
- Prediction market agents (trying to bet before the curve)

### Features: 
- Sellers are paid on outcome, and post a bond that burns if they're wrong. 
- Reputation is earned for being right early and against the public report.
- Contracts are locked at lineup lock (90 minutes before an actual game)
- Price is compared to oracle-driven truth values; there is a surprise factor that incentivizes sellers to give nicher information
- The earlier you send your information as compared to lineup lock, the price is set to be higher 
- Bounty-based shopping (buyers don't browse information in a catalog, they ask the system for information instead)


| | |
|---|---|
| **Contract** | [`0x7a06f5991498A9D40A03D497d31e3ea81c643d5E`](https://sepolia.etherscan.io/address/0x7a06f5991498A9D40A03D497d31e3ea81c643d5E) |
| **Chain** | Ethereum Sepolia (`11155111`), deploy block `11683458` |
| **Verified source** | [Sourcify](https://repo.sourcify.dev/11155111/0x7a06f5991498A9D40A03D497d31e3ea81c643d5E) — exact match on creation and runtime bytecode |
| **Live dashboard** | [`web/`](web) — read-only view of the deployed market, see [Live dashboard](#live-dashboard) |

### Two flows, one matcher

**Sellers list whenever they have something.** A listing is a sealed claim on one
`(game, player)` at the seller's own ask, with a bond behind it. It does not wait for anyone
to ask. **Buyers bid whenever they want to search.** A bounty is a bid: "intel on this player,
up to this price." It escrows nothing. The buyer's agent matches its bids against the
listings and buys the ones it trusts. One listing can sell to many buyers, each with their
own escrow and their own key.

### Stakeholders

| Who | Puts in | Gets out |
|---|---|---|
| **Sellers** (aggregators, forecasters) | A sealed listing per slot, a bond scaled to their stated confidence, an ask, and a mandatory post-lock reveal | The `revealFee` on every key delivered, a share of every buyer's `contingent` if right, scaled by lead time × surprise, and a public reputation ledger |
| **Buyers** (DFS / betting optimizers) | Bids on the slots they are unsure about, then `revealFee + contingent` per listing they choose to buy | Availability intel before lock, weighted by each seller's ledger; the unearned part of `contingent` back after settlement |
| **Operator** (scheduler + attester + fee recipient, one key in this deployment) | Games, the public prior snapshot, and the attestation that settles every claim on a game | A fixed cut of each `revealFee` (`protocolFeeBps`, 2.5%), charged on the sale and never on the outcome, so it cannot profit from attesting falsely |
| **Burn sink** | Nothing | Every forfeited bond. Bonds never reach a buyer or the operator, so nobody is paid for a seller being wrong |

## How a claim moves

**Sealing is two-step. We sell the key.** At `listClaim` the seller posts AES-256-GCM
ciphertext under a fresh key `K` plus a `commitHash`. The ciphertext is public at once; `K`
is withheld. Each time a buyer pays, `deliverKey` carries `ECIES(thatBuyerPubKey, K)`.
Content is fixed and publicly committed before lock, and unreadable until money moves.

That commitment makes the rest enforceable:

- **Lock cliff.** `listClaim`, `purchase` and `deliverKey` revert at `lockTime`. Stale intel is unsellable by construction.
- **Mandatory reveal.** After lock every listing is revealed, sold or not, or `slashUnrevealed`
  burns the bond. The ledger is a complete record, not a highlight reel.
- **Bond checked at reveal.** Bond must clear `bondFor(bucket)` (1×/2×/4×/8× base), but the
  bucket stays hidden until reveal.
- **Priced and scored against the prior at listing time.** The public report is snapshotted
  on-chain the moment a seller lists, so an early call is not punished when the report
  catches up.

## Price

The ask has two legs. `revealFee` buys the key and is never refunded. `contingent` is
escrowed per buyer and settled against the oracle:

```
w        = 0.1 + 0.9 * min(1, leadTime / leadSaturation)       # earlier is worth more
surprise = min(1, 2 * (1 - P_public(actual)))                  # against the prior at listing
payout   = w * surprise                                        # share of each escrow, if right
```

A correct seller collects `contingent × payout` from every buyer; the remainder returns to
the buyer. A wrong seller collects nothing and its bond burns. Restating an obvious `OUT` at
the last second earns 0.2% of the escrow. Calling `INACTIVE` on a `QUESTIONABLE` player with
full lead time, and being right, earns all of it. Both inputs are fixed on-chain at listing,
so the ceiling is known at purchase and only the outcome is unknown.

## Trust model

The operator is centralized on the happy path, in the shape a rollup sequencer is: **trusted
for liveness and speed, never for custody.**

| Failure | What stops it |
|---|---|
| **Operator profits from a wrong claim** | It cannot. The fee is a fixed cut of `revealFee`, charged on the sale before any outcome exists. Forfeited bonds go to the burn sink. |
| **Operator rewrites reputation or price** | `scheduler` (slate + priors) and `attester` (outcome) are separate roles. Payout and score read both. |
| **Operator attests a false list** | Publicly detectable — `reportHash` lets anyone rehash the published snapshot in `out/attestations/`. `settle` is timelocked behind `challengeWindow`; `voidAttestation` can cancel inside it, after which the game can only be unwound. ⚠️ Only the owner can void, and owner == operator. |
| **Operator disappears** | `forceUnwind` + `unwindClaim` + `resolvePurchase`. After `lockTime + unwindDelay` with no attestation, **anyone** unwinds the game and every participant takes their own money back. |
| **Buyer griefs a seller at the cliff** | A purchase whose key never arrives is refunded in full, but the bond is not burned. Non-delivery costs the seller reputation, not capital, so a buyer cannot torch a bond by buying one second before lock. |

The remaining gap is the attester. `src/UmaAttester.sol` sources outcomes from UMA's
Optimistic Oracle V3 so a bonded proposer can be disputed by anyone; swapping it in is a
redeployment of that adapter, not of the market.

## Reputation

```
p0  = priorTable[priorTag][priorPractice]      # P(ACTIVE) from the public report AT LISTING
q   = bucketMid[bucket]                        # 0.55 / 0.675 / 0.825 / 0.95
qy  = (claimed == actual) ? q : 1 - q
py  = (actual == ACTIVE) ? p0 : 1 - p0
w   = 0.1 + 0.9 * min(1, hoursBeforeLock / 96)
Δ   = w * (ln(qy) - ln(py))
```

Slashed listings and undelivered keys score `ln(0.05) = −2.996`, worse than any honest miss.
Scoring is off-chain: `ClaimSettled` carries every input, so anyone can recompute the ledger
from `agents/src/lib/scoring.ts`. Buyers rank listings by it before they can read them.

## Live dashboard

`web/` is a static, read-only page that replays the contract's logs in the browser and
renders the whole market: the stat line, the seller reputation ledger, every sealed
listing, every bounty, and each game's attested inactive list. It connects no wallet,
signs nothing, and has no backend — it is a Vite build over a public Sepolia RPC.

It imports `indexMarket` and the scorer directly from `agents/src/lib`, so the page and
the CLI agents cannot drift apart: one indexer, one definition of every number.

```bash
cd web && npm install && npm run dev      # http://localhost:5173
npm run build                             # static bundle in web/dist
```

Deploying is a static-host drop. `vercel.json` at the repo root already points Vercel at
`web/`; any host that can serve `web/dist` works the same way. Set `VITE_RPC_URL` at build
time to use a dedicated RPC instead of the public endpoint.

## Running the demo

```bash
forge test                                  # 25 contract tests
cd agents && npm install && npm test        # 39 crypto + scoring tests
```

Copy `.env.example` to `.env` in the repo root and fill it in. Then `npm run keys` in
`agents/` to generate the agent wallets, and fund the three printed addresses with ~0.05
Sepolia ETH each.

### Interactive: three terminals

Each terminal is a stakeholder you drive by typing commands. The deployed contract uses a
20s challenge window and a 40s reveal window, so the whole arc fits in about five minutes
with `DEMO_LOCK_SEC=180`. Set it identically in all three terminals.

```bash
DEMO_LOCK_SEC=180 npm run operator                    # terminal 1 — the manager
DEMO_LOCK_SEC=180 npm run seller                      # terminal 2 — aggregator
DEMO_LOCK_SEC=180 npm run buyer                       # terminal 3 — lineup optimizer
DEMO_LOCK_SEC=180 SELLER=forecaster npm run seller    # optional 4th — the model seller
```

| When | Terminal | Command | What it shows |
|---|---|---|---|
| 0:00 | operator | `open` | publishes the slate and the public injury report |
| 0:20 | seller | `scan`, `sell cmc` | news broke; the seller **lists** a sealed claim, no bid needed |
| 0:40 | seller | `sell dk INACTIVE B83` | a hand-entered contrarian call that will turn out wrong |
| 1:00 | buyer | `bounty` | bids on every uncertain slot: "up to X for intel on Y" |
| 1:10 | buyer | `search` | the listings that answer its bids: seller, ask, bond, rep, *not* content |
| 1:20 | buyer | `buy <id>` ×2 | pays the ask; still cannot read either |
| 1:50 | seller | `deliver` | sends `ECIES(buyerPubKey, K)` per buyer — **this** is the sale |
| 2:10 | buyer | `open`, `decide` | decrypts, verifies against the commitment, McCaffrey flips to BENCH |
| 2:30 | seller | `sell kelce` | late news; this one goes unsold |
| 3:00 | seller | `sell cmc` | after lock: `LOCKED 4s ago — listings revert at the cliff` |
| 3:05 | operator | `attest SEA@SF cmc`, `attest BUF@KC` | **manual override** — you declare who was inactive |
| 3:30 | seller | `hold <kelce id>`, `reveal` | refuses one reveal; the rest go public |
| 3:50 | operator | `settle` | settles and pays out every purchase; payout % shown per claim |
| 4:10 | operator | `slash` | the held claim's bond burns |
| 4:20 | all | `status`, `withdraw` | ledger, payouts, refunds |

`attest <game> [slugs...]` is the manual override: whatever you type becomes ground truth.
`oracle <game>` attests from the fixture feed instead. `unwind <game>` demonstrates the
escape hatch. Every terminal has `status` and `help`.

### Autonomous

`npm run demo` runs the whole lifecycle as one orchestrated process. The four stakeholders
can also run as independent daemons — `auto:manager`, `auto:scraper`, `auto:forecaster`,
`auto:buyer` — sharing no state and coordinating only through `getLogs`. Sellers list the
moment they have an edge; the buyer bids and buys whatever matches.

Every demo is re-runnable: `open` advances to a fresh synthetic week, since `gameId` is
deterministic from `(season, week, teams)`.

## Known gaps

- **No live data adapter.** The oracle is a fixture file and one key (see Trust model).
- **Bond leaks confidence.** Sellers post exactly `bondFor(bucket)` and the bond is public, so the bucket is inferable before reveal. Over-bonding hides it at a capital cost.
- **Fresh wallets outrank burned ones.** Reputation cannot go below "new"; the bond is the only durable deterrent.
- **A seller can deliver a key that decrypts to nothing.** Loss is bounded to `revealFee`; the buyer agent blacklists that seller locally.
- **Contract unverified on Etherscan.** ABI is in `agents/src/lib/abi.ts`; `forge verify-contract` works retroactively.
