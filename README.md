# Sealed Availability Market

**A market where tipster agents sell sealed, bonded claims about whether an NFL player will
be on the official inactive list — to lineup-optimizer agents that must lock before kickoff.**

Everything on a game settles in one batch against a single resolver attestation. Reputation
is earned for being right *early* and *against the public report*, and it is impossible to
cherry-pick: every claim a seller commits is revealed after lock or forfeits its bond.

| | |
|---|---|
| **Contract** | [`0x7D228e488Ff5A9069e019A7AB68558d26fA0A138`](https://sepolia.etherscan.io/address/0x7D228e488Ff5A9069e019A7AB68558d26fA0A138) |
| **Chain** | Ethereum Sepolia (`11155111`) |
| **Deploy block** | `11680305` |
| **Demo** | `cd agents && npm run demo` — full lifecycle on live Sepolia in ~4m40s |
| **Tests** | 14 Foundry (`forge test`) · 37 Vitest (`cd agents && npm test`) |

---

## The vertical

NFL player availability, sold as a single typed claim: `(game, player, ACTIVE|INACTIVE, confidence)`.

Nothing else is sold. Two kinds of seller have an edge worth paying for:

- **Aggregators** surface local beat reporting, practice observations, and travel news before
  national outlets republish it. They sell **lead time**.
- **Forecasters** model injury class, practice trajectory, and recovery base rates to resolve
  "questionable" into a calibrated probability. They sell **calibration** — information that
  exists on no feed at all.

Buyers are DFS and betting optimizers with specific players in specific slots and a hard lock
time. They post bounties on the slots they're uncertain about, buy several sealed forecasts,
and ensemble them weighted by each seller's on-chain ledger.

The counterparty is the league itself, which actively withholds availability information.
That obfuscation is precisely why lead time and calibration are scarce enough to price.

## Trust assumptions

**1. The resolver is honest. This is the real one.**

A single key decides what the official inactive list said. It calls
`attest(gameId, reportHash, inactivePlayerIds)`, and that one call settles every claim on the
game. In this deployment the resolver is also the owner and the deployer — one key, three hats.

It is bounded, but only weakly: `settle` cannot run until `attestedAt + challengeWindow`, and
the owner can `voidAttestation` inside that window. With `resolver == owner`, that is a
timelock with no independent challenger behind it.

The resolver also writes the **priors** (`setPrior`/`setPriorBatch`). Since scoring is
`Δ = w · (ln qy − ln py)`, where `py` comes from the prior snapshot and `qy` from the outcome,
the resolver controls *both* inputs to every seller's score. It can move reputation by
rewriting what was "publicly known" at commit time, not only by lying about who sat out.

**2. Buyers keep their own keys.** Sellers deliver `ECIES(buyerPubKey, K)`. A buyer who loses
that key cannot read anything it paid for; the contract cannot help.

**3. The official inactive list is ground truth.** The protocol settles against what the
resolver attests the league published, not against who actually took the field.

What is *not* assumed: no seller honesty (bonds and mandatory reveal), no buyer honesty (pull
payments, escrow), no platform (state lives only in the contract), and no trust in the
ciphertext (every payload is checked against its pre-lock commitment).

## The biggest design decision

**Sealing is two-step, and the key is what's sold.**

At `fillBounty` the seller emits AES-256-GCM ciphertext under a fresh key `K`, plus
`commitHash`. The ciphertext is public immediately. `K` is withheld. Only after the buyer
pays does the seller send `deliverKey` carrying `ECIES(buyerPubKey, K)`.

Encrypting directly to the buyer at fill time — the obvious design — would let them read the
claim without paying. Publishing the plaintext would destroy the product. Withholding the
*ciphertext* would let the seller swap the content after seeing who bought. Only the split
gets all three: the content is fixed and publicly committed before lock, and it stays
unreadable until money moves.

That commitment is what makes the rest enforceable:

- **Lock cliff.** `fillBounty` and `purchase` revert at `lockTime`. Stale intel is unsellable
  by construction, not by policy.
- **Mandatory reveal.** After lock, *every* claim is revealed — sold or not — or
  `slashUnrevealed` burns the bond. A seller cannot quietly drop the calls that went badly, so
  the ledger is a complete record rather than a highlight reel. In the demo this scores
  `ln(0.05) = −2.996`, worse than any honest miss can possibly be.
- **Bond checked at reveal, not at fill.** Bond must clear `bondFor(bucket)` (1×/2×/4×/8× base),
  but the bucket is hidden until reveal — so confidence never leaks while the claim is still
  being sold. Under-bond a high-confidence claim and you simply cannot reveal it; you get
  slashed instead.
- **Scoring against the prior snapshot taken at commit time.** `ClaimCommitted` freezes the
  public prior as it stood at the fill. Agreeing with an obvious report earns ≈0 no matter how
  confident you sound; a confident restatement of an obvious `OUT` scores *negative*. You are
  paid for surprise that turns out to be right, scaled by how early you said it.

## One important limitation

**The oracle is a fixture file and one private key.**

Everything above is genuinely trustless — commitments, escrow, slashing, settlement. None of
it fixes the fact that `bool correct = (c.claimed == actual)` resolves through
`inactive[gameId][playerId]`, a mapping written only by `attest`. "Wrong" is not discovered,
it is *declared*. The `reportHash` lets anyone rehash the published snapshot in
`out/attestations/` and prove the resolver attested that exact document — that is **integrity,
not truth**. There is no feed to check it against, and this build makes zero external data
calls.

A production version needs a bonded multi-attester with a real challenge game, an optimistic
oracle, or signed league feeds. The contract's shape already accommodates it: `attest` is one
`onlyResolver` call behind a timelock, so replacing the single key with a committee is a
resolver-side change, not a redesign.

*(Runner-up limitation, documented but not fixed: a seller can deliver a well-formed key that
decrypts to nothing. The contract cannot verify decryption. Loss is bounded to the `revealFee`
— the `contingent` only releases on a correct **revealed** claim, and mandatory reveal forces
the true payload public anyway — and the buyer agent blacklists that seller locally.)*

---

## What the buyer actually gets

The price splits in two, and only half is contingent on being right:

| | paid at | refunded if the claim is wrong |
|---|---|---|
| `revealFee` | credited to seller on `deliverKey` | **No** — it buys the key, not the truth |
| `contingent` | escrowed on `purchase` | **Yes** — returned to the buyer |
| seller's `bond` | posted on `fillBounty` | Burned, **not** paid to the buyer |

The bond burns rather than paying the buyer on purpose: if wrong claims paid out, buying
claims you expect to be wrong would be profitable, and the market would start pricing
misinformation. Burning keeps the buyer's incentive pointed at wanting correct information.

## Scoring

```
p0  = priorTable[priorTag][priorPractice]      # P(ACTIVE) from the public report AT COMMIT TIME
q   = bucketMid[bucket]                        # 0.55 / 0.675 / 0.825 / 0.95
qy  = (claimed == actual) ? q : 1 - q          # what the seller assigned to what happened
py  = (actual == ACTIVE) ? p0 : 1 - p0         # what the public prior assigned to it
w   = 0.1 + 0.9 * min(1, hoursBeforeLock / 96) # lead-time weight
Δ   = w * (ln(qy) - ln(py))
```

Slashed or refunded claims score `ln(0.05)` at full weight. Scoring is **off-chain only** —
`ClaimSettled` carries every input, so reputation is a pure fold over one event type that
anyone can recompute. The prior table is illustrative seed constants, not measurements;
backtest against a real season of injury reports and replace them.

The gradient this produces (from `agents/src/lib/scoring.ts`, all covered by tests):

| claim | prior | lead time | Δ |
|---|---|---|---|
| late `ACTIVE/B55` on `PROBABLE/FULL`, right | 0.95 | 0h | −0.055 |
| confident restatement of an obvious `OUT` | 0.01 | 96h | −0.041 |
| contrarian `INACTIVE/B83` on `QUESTIONABLE/LIMITED`, right | 0.70 | 1h | +0.111 |
| same call, 48h earlier | 0.70 | 48h | +0.556 |
| same call, 96h earlier | 0.70 | 96h | +1.012 |
| same call, **wrong** | 0.70 | 96h | −1.386 + burned bond |
| never revealed | — | — | **−2.996** |

## Parameters: demo vs production

Every window is a constructor argument, so one contract serves both.

| Parameter | Demo (deployed) | Production story | Why they differ |
|---|---|---|---|
| `lockTime` | `now + 110s` | kickoff − 90 min | Real lineups lock well before kickoff; the demo has to fit a video. 110s is the floor for ~25 pre-lock txs at Sepolia's ~13s confirmations. |
| `challengeWindow` | `45s` | 24h | Time for a challenger to dispute an attestation before settlement is irreversible. A real one needs a business day. |
| `revealWindow` | `45s` | 48h | Grace period for sellers to honour mandatory reveal before being slashed. |
| `baseBond` | `0.0002 ETH` | economically meaningful | Bond scales `1×/2×/4×/8×` by confidence bucket. Demo value is a rounding error; production must exceed the expected profit from a wrong confident call. |
| `burnSink` | `0x…dEaD` | protocol treasury / insurance fund | Burning is the simplest credible sink. A treasury needs governance this design doesn't have. |
| `resolver` | deployer EOA | bonded attester committee | The limitation above. |
| Data source | `fixtures/week1.json` | official injury report adapter | LLD §4.1 specifies `getPriors()` / `getInactives()`; not built. |

## Repo layout

```
src/SealedAvailabilityMarket.sol   the only stateful component
test/SAM.t.sol                     14 tests, incl. a TS/Solidity commit-hash cross-check
script/Deploy.s.sol                every window is a constructor arg
agents/src/lib/crypto.ts           AES-256-GCM + ECIES over @noble; the two-step seal
agents/src/lib/scoring.ts          pure fold over ClaimSettled — used by agents AND the UI
agents/src/lib/indexer.ts          rebuilds all state from getLogs; no database anywhere
agents/src/resolver.ts             createGame / setPriorBatch / attest
agents/src/seller-aggregator.ts    rules over beat reporting (sells lead time)
agents/src/seller-forecaster.ts    base rates over practice trajectory (sells calibration)
agents/src/buyer.ts                bounties, purchase, decrypt+verify, logit-pool ensemble
agents/src/demo.ts                 the orchestrator
```

The contract is the only stateful component. Agents are stateless scripts that replay from
`getLogs(fromBlock: deployBlock)` on startup. No database, no indexer service, no relay.

## Running it

```bash
forge test                                  # 14 contract tests
cd agents && npm install && npm test        # 37 crypto + scoring tests
```

For the live demo you need a funded Sepolia key:

```bash
cp .env.example .env        # add PRIVATE_KEY and SEPOLIA_RPC_URL
cd agents
npm run keys                # generates .agent-keys.json (gitignored, mode 0600)
# fund the three printed addresses with ~0.05 Sepolia ETH each
npm run demo
```

`npm run demo` is self-contained and re-runnable: it advances to a fresh synthetic week if the
current one is already used on-chain, and scopes settlement and the ledger to its own run.

## Known gaps

- **Web UI not built.** LLD §5 specifies read-only routes over `getLogs`; `agents/src/lib/indexer.ts`
  is written to be shared with it, but the Next.js app was the first cut line.
- **LLM seller mode not built.** `seller-aggregator.ts` ships the rules implementation that
  §4.2 specifies as the fallback; the Claude-backed variant was a documented cut line.
- **No live data adapter.** See the limitation above.
- **Contract is unverified on Etherscan** — deployed without an `ETHERSCAN_API_KEY`. The ABI
  is in `agents/src/lib/abi.ts` and `forge verify-contract` will work retroactively.
- **Non-exclusive tips.** A seller can fill many bounties with the same claim; each carries its
  own bond, so the cost scales, but exclusivity is not enforced.
