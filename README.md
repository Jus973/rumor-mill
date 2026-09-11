# NFL Fantasy Agent Rumor Mill

**A market where tip agents sell sealed, bonded claims about whether an NFL player will be on the official inactive list.**

Sellers have information on who will be standing/sitting before the NFL official reports:
- Aggregator agents (those who scrape the internet to report from niche sources faster than mainstream sources)
- Forecaster agents (those trying to make money off this system by selling predictions)
- Humans with insider knowledge 

Buyers are those who will use this information for personal benefit
- Fantasy football agents (lineup optimizers)
- Prediction market agents (trying to bet before the curve)



Reputation is earned for being right *early* and
*against the public report*, and it cannot be cherry-picked: every claim a seller commits is
revealed after lock or forfeits its bond.

| | |
|---|---|
| **Contract** | [`0x303B63C53cB0ce16b6DbD0a74040E66090156793`](https://sepolia.etherscan.io/address/0x303B63C53cB0ce16b6DbD0a74040E66090156793) |
| **Chain** | Ethereum Sepolia (`11155111`), deploy block `11680855` |
| **Demo** | `cd agents && npm run demo` — full lifecycle on live Sepolia in ~4m40s |
| **Tests** | 19 Foundry (`forge test`) · 37 Vitest (`cd agents && npm test`) |

## Stakeholders

| Who | Puts in | Gets out |
|---|---|---|
| **Sellers** (aggregators, forecasters) | A sealed claim per bounty, a bond scaled to their stated confidence, and a mandatory post-lock reveal | `revealFee` on key delivery, `contingent` if right, and a public reputation ledger that rewards early, contrarian, correct calls |
| **Buyers** (DFS / betting optimizers) | Bounties with `revealFee + contingent` escrowed, and their own decryption key | Availability intel before lock, weighted by each seller's ledger; `contingent` refunded if the claim is wrong |
| **Operator** (scheduler + attester + fee recipient, one key in this deployment) | Games, the public prior snapshot, and the attestation that settles every claim on a game | A fixed cut of each `revealFee` (`protocolFeeBps`, 2.5%), charged on the sale and never on the outcome, so it cannot profit from attesting falsely |
| **Burn sink** | Nothing | Every forfeited bond. Bonds never reach the buyer or operator, so nobody is paid for a seller being wrong |

## How a claim moves

**Sealing is two-step. We sell the key** At `fillBounty` the seller posts
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

The operator is centralized on the happy path, in the shape a rollup sequencer is: **trusted
for liveness and speed, never for custody.** It is the only party that can attest, everyone
depends on it to be fast, and it is the single biggest assumption in the design.

What keeps that honest:

| Failure | What stops it |
|---|---|
| **Operator profits from a wrong claim** | It cannot. The fee is a fixed cut of `revealFee`, charged on the sale before any outcome exists. Forfeited bonds go to the burn sink — never to the operator or the buyer. |
| **Operator rewrites reputation** | `scheduler` (slate + priors) and `attester` (outcome) are separate roles. Scoring reads both `py` (prior) and `qy` (outcome), so one key holding both could move a seller's score two ways. |
| **Operator attests a false list** | Publicly detectable — the inactive list is on nfl.com, and `reportHash` lets anyone rehash the published snapshot in `out/attestations/`. `settle` is timelocked behind `challengeWindow`, and `voidAttestation` can cancel inside it. ⚠️ Today only the owner can void, and owner == operator, so this is a timelock without an independent challenger. |
| **Operator disappears** | `forceUnwind` + `unwindClaim`. After `lockTime + unwindDelay` with no attestation, **anyone** can unwind the game and every participant takes their own money back — bonds to sellers, escrow to buyers, nothing burned, nobody scored. This is the force-inclusion analogue: the operator can be slow or absent, but it can never hold funds hostage. |

The remaining gap is the third row: detection is free, punishment is not yet automatic. The
next step is an operator bond slashable by an independent challenger — either a small
multisig of named parties, or `src/UmaAttester.sol`, which sources outcomes from UMA's
Optimistic Oracle V3 so a bonded proposer can be disputed by anyone. Because `attester` is
its own role, swapping it in is a redeployment of that adapter, not of the market or its
reputation ledger.

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

## Known gaps

- **No live data adapter.** The oracle is a fixture file and one key (see Trust model).
- **Web UI and LLM seller mode not built.** `indexer.ts` is written to be shared with a UI.
- **A seller can deliver a key that decrypts to nothing.** Loss is bounded to `revealFee`;
  the buyer agent blacklists that seller locally.
- **Non-exclusive tips.** A seller can fill many bounties with one claim; each carries its own bond.
- **Contract unverified on Etherscan.** ABI is in `agents/src/lib/abi.ts`; `forge verify-contract` works retroactively.
