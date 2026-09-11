# NFL Fantasy Agent Rumor Mill

**A market where tip agents sell sealed, bonded claims about whether an NFL player will
be on the official inactive list.**

Buyers are lineup optimizers that must lock before kickoff. Everything on a game settles in
one batch against a single attestation. Reputation is earned for being right *early* and
*against the public report*, and it cannot be cherry-picked: every claim a seller commits is
revealed after lock or forfeits its bond.

| | |
|---|---|
| **Contract** | [`0xF82a25dd634Ea459597F41b13A290CFe7F360452`](https://sepolia.etherscan.io/address/0xF82a25dd634Ea459597F41b13A290CFe7F360452) |
| **Chain** | Ethereum Sepolia (`11155111`), deploy block `11680684` |
| **Demo** | `cd agents && npm run demo` — full lifecycle on live Sepolia in ~4m40s |
| **Tests** | 16 Foundry (`forge test`) · 37 Vitest (`cd agents && npm test`) |

## What is sold

One typed claim: `(game, player, ACTIVE|INACTIVE, confidence)`. Two kinds of seller have an
edge worth paying for:

- **Aggregators** surface local beat reporting before national outlets do. They sell **lead time**.
- **Forecasters** turn "questionable" into a calibrated probability from injury class and
  practice trajectory. They sell **calibration**.

Buyers post bounties on the slots they are unsure about, buy several sealed forecasts, and
ensemble them weighted by each seller's on-chain ledger.

## Stakeholders

| Who | Puts in | Gets out |
|---|---|---|
| **Sellers** (aggregators, forecasters) | A sealed claim per bounty, a bond scaled to their stated confidence, and a mandatory post-lock reveal | `revealFee` on key delivery, `contingent` if right, and a public reputation ledger that rewards early, contrarian, correct calls |
| **Buyers** (DFS / betting optimizers) | Bounties with `revealFee + contingent` escrowed, and their own decryption key | Availability intel before lock, weighted by each seller's ledger; `contingent` refunded if the claim is wrong |
| **Operator** (scheduler + attester + fee recipient, one key in this deployment) | Games, the public prior snapshot, and the attestation that settles every claim on a game | A fixed cut of each `revealFee` (`protocolFeeBps`, 2.5%), charged on the sale and never on the outcome, so it cannot profit from attesting falsely |
| **Burn sink** | Nothing | Every forfeited bond. Bonds never reach the buyer or operator, so nobody is paid for a seller being wrong |

## How a claim moves

**Sealing is two-step, and the key is what is sold.** At `fillBounty` the seller posts
AES-256-GCM ciphertext under a fresh key `K` plus a `commitHash`. The ciphertext is public
at once; `K` is withheld. After the buyer pays, `deliverKey` carries `ECIES(buyerPubKey, K)`.
Content is fixed and publicly committed before lock, and unreadable until money moves.

That commitment makes the rest enforceable:

- **Lock cliff.** `fillBounty` and `purchase` revert at `lockTime`. Stale intel is unsellable by construction.
- **Mandatory reveal.** After lock every claim is revealed, sold or not, or `slashUnrevealed`
  burns the bond. The ledger is a complete record, not a highlight reel.
- **Bond checked at reveal.** Bond must clear `bondFor(bucket)` (1×/2×/4×/8× base), but the
  bucket stays hidden until reveal, so confidence never leaks while the claim is for sale.
- **Scored against the prior at commit time.** Agreeing with an obvious report earns ≈0.
  You are paid for surprise that turns out right, scaled by how early you said it.

The price splits in two. `revealFee` buys the key and is never refunded. `contingent` is
escrowed and returned to the buyer if the claim is wrong. The seller's bond burns rather than
paying the buyer, so buying claims you expect to be wrong is never profitable.

## Trust model

**The attester is honest.** One `attest(gameId, reportHash, inactivePlayerIds)` call settles
every claim on the game. "Wrong" is declared, not discovered: `reportHash` proves the attester
signed a specific snapshot in `out/attestations/`, which is integrity, not truth. This build
makes zero external data calls.

Roles are split so the trust is enforceable: `scheduler` owns games and priors, `attester` owns
`attest` and nothing else, and the owner can `voidAttestation` inside `challengeWindow`. The
demo points all three at one key. `src/UmaAttester.sol` (optional, not wired into the demo)
holds the attester role and sources outcomes from UMA's Optimistic Oracle V3 instead.

Also assumed: buyers keep their own decryption keys, and the official inactive list is ground
truth. Not assumed: seller honesty (bonds, mandatory reveal), buyer honesty (escrow, pull
payments), any platform (state lives only in the contract), or the ciphertext (checked
against its pre-lock commitment).

## Scoring

```
p0  = priorTable[priorTag][priorPractice]      # P(ACTIVE) from the public report AT COMMIT TIME
q   = bucketMid[bucket]                        # 0.55 / 0.675 / 0.825 / 0.95
qy  = (claimed == actual) ? q : 1 - q
py  = (actual == ACTIVE) ? p0 : 1 - p0
w   = 0.1 + 0.9 * min(1, hoursBeforeLock / 96) # lead-time weight
Δ   = w * (ln(qy) - ln(py))
```

Slashed or refunded claims score `ln(0.05) = −2.996` at full weight, worse than any honest
miss. Scoring is off-chain: `ClaimSettled` carries every input, so anyone can recompute the
ledger from `agents/src/lib/scoring.ts`.

| claim | prior | lead time | Δ |
|---|---|---|---|
| confident restatement of an obvious `OUT` | 0.01 | 96h | −0.041 |
| contrarian `INACTIVE/B83` on `QUESTIONABLE/LIMITED`, right | 0.70 | 1h | +0.111 |
| same call, 96h earlier | 0.70 | 96h | +1.012 |
| same call, **wrong** | 0.70 | 96h | −1.386 + burned bond |
| never revealed | — | — | **−2.996** |

## Parameters

Every window is a constructor argument.

| Parameter | Demo (deployed) | Production |
|---|---|---|
| `lockTime` | `now + 110s` | kickoff − 90 min |
| `challengeWindow` | `45s` | 24h |
| `revealWindow` | `45s` | 48h |
| `baseBond` | `0.0002 ETH` | must exceed the profit from a wrong confident call |
| `protocolFeeBps` | `250` (2.5%) | capped at 10% in the contract |
| `attester` | deployer EOA | `UmaAttester` or a bonded committee |
| Data source | `fixtures/week1.json` | official injury report adapter (not built) |


## Known gaps

- **No live data adapter.** The oracle is a fixture file and one key (see Trust model).
- **Web UI and LLM seller mode not built.** `indexer.ts` is written to be shared with a UI.
- **A seller can deliver a key that decrypts to nothing.** Loss is bounded to `revealFee`;
  the buyer agent blacklists that seller locally.
- **Non-exclusive tips.** A seller can fill many bounties with one claim; each carries its own bond.
- **Contract unverified on Etherscan.** ABI is in `agents/src/lib/abi.ts`; `forge verify-contract` works retroactively.
