# LLD — Sealed Availability Market (Black Box Bazaar, sports vertical)

Companion to `HLD_sealed_availability_market.md`. This document fixes the architecture, contract interface, state machines, off-chain components, data formats, test plan, and a time-boxed build order with explicit cut lines.

**Scope anchor.** Submission is due 9/11 at 2 pm — roughly one working day from now. The brief says a passing project is 1–2 hours and judges weight mechanism credibility and product judgment over code volume. Every choice below optimizes for: (a) one contract, (b) one testnet, (c) a scripted end-to-end demo that fits inside a 5-minute video, (d) nothing that requires a server running after the video is recorded.

---

## 0. Assumptions (explicit, with how to falsify)

| # | Assumption | Falsify by |
|---|---|---|
| A1 | Base Sepolia (chainId 84532) is up, has a working faucet, and Basescan verifies Foundry deployments. | Try the faucet + `forge verify-contract` in the first 20 minutes. Fallback: Arbitrum Sepolia, then Sepolia. |
| A2 | Native ETH is acceptable as the settlement asset (no ERC-20). | Re-read brief — it says "on-chain", not "stablecoin". Confirmed acceptable. |
| A3 | A single bonded resolver key (= deployer in the demo) is an acceptable trust root for a take-home. | The HLD names it as the primary trust assumption; README must say so. If judges push on it, the challenge-window timelock is the answer. |
| A4 | Fixture data (synthetic Week 1 games with a scripted lock a few minutes out) is acceptable for the demo instead of live NFL data. | Real Week 1 games lock before/around the deadline; a live game cannot be settled inside the video. Fixture mode is the only way to show settlement end-to-end. A live-data adapter is a stretch goal, not a requirement. |
| A5 | Storing large blobs (ciphertext, evidence) in **events** rather than storage is sufficient because all readers (agents, UI) index from logs. | If the UI needs a value that only exists in a log and RPC log range limits bite, fall back to storing the keccak in state and the blob in the event (already the plan) plus a fixed `deployBlock` in the client config. |
| A6 | Parameterizing every time window in the constructor lets one deployment serve both the demo (minutes) and a "production" story (days). | If a judge asks "why 4-minute lock?", the answer is in the README parameter table. |

---

## 1. System overview

```
┌────────────────────────── Off-chain (TypeScript, run by operators) ──────────────────────────┐
│                                                                                               │
│  Seller agent: Aggregator      Seller agent: Forecaster       Buyer agent (optimizer)        │
│  (news/practice → claim)       (base rates → calibrated p)    (lineup → bounties → ensemble)  │
│          │  fill / deliverKey / reveal      │                          │ post / purchase       │
│          └──────────────┬───────────────────┘                          │                       │
│                         ▼                                              ▼                       │
│               ┌──────────────────────────── viem client ────────────────────────────┐          │
│               └──────────────────────────────────────────────────────────────────────┘          │
│  Resolver script (fixture | live adapter) ── createGame / setPrior / attest                   │
│  Scorer lib (pure fn over ClaimSettled events) ─── used by buyer agent AND web UI            │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │  JSON-RPC (Base Sepolia)
                                          ▼
┌──────────────────────────── On-chain (Solidity 0.8.x, Foundry) ───────────────────────────────┐
│  SealedAvailabilityMarket.sol  — single contract                                              │
│    games · priors · bounties · claims · attestations · pull-payment balances                   │
│    events carry all blobs (ciphertext, encrypted key, evidence)                               │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                          ▲
                                          │  reads (viem getLogs + view calls)
┌───────────────────────────── Web (Next.js on Vercel, read-mostly) ────────────────────────────┐
│  /games  /games/[id]  /claims/[id]  /sellers/[addr]  — wallet connect only for `purchase`      │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Design rule:** the contract is the only stateful component. Agents are stateless scripts that replay from events on startup. The web app is a viewer over the same events. No database, no indexer service, no relay server.

---

## 2. Chain, stack, and repo

| Concern | Choice | Why (scope) |
|---|---|---|
| Testnet | Base Sepolia | Cheap, 2s blocks, Coinbase/Alchemy faucets, Basescan explorer link satisfies the brief. |
| Contract tooling | Foundry (`forge`, `cast`, `forge script`) | Fastest test/deploy loop; `vm.warp` makes time-window tests trivial. |
| Off-chain lang | TypeScript, `viem` | One language for agents and web; viem has typed ABI + `getLogs`. |
| Crypto | `@noble/ciphers` (AES-256-GCM), `@noble/secp256k1` + HKDF for ECIES (or `eciesjs`) | Audited primitives, no native deps, runs in Node and browser. |
| Web | Next.js (app router) + wagmi + RainbowKit, Vercel | Public URL in ~10 minutes. |
| LLM (optional) | Anthropic API in the Aggregator seller | Cut line — rule-based fallback exists. |
| Package mgmt | pnpm workspaces | |

```
black-box-bazaar/
├── README.md                     # vertical, trust assumptions, biggest decision, one limitation, links
├── contracts/                    # Foundry
│   ├── src/SealedAvailabilityMarket.sol
│   ├── src/Scoring.sol           # (optional) pure view helpers; scoring truth lives in TS
│   ├── test/SAM.t.sol
│   └── script/Deploy.s.sol
├── agents/
│   ├── src/lib/chain.ts          # viem clients, ABI, contract address, deployBlock
│   ├── src/lib/crypto.ts         # keygen, AES-GCM, ECIES, commit hash
│   ├── src/lib/scoring.ts        # prior table, lead-time weight, ledger reducer
│   ├── src/lib/fixtures.ts       # fixture loader + simulated clock
│   ├── src/resolver.ts           # createGame / setPrior / attest
│   ├── src/seller-aggregator.ts
│   ├── src/seller-forecaster.ts
│   ├── src/buyer.ts
│   └── src/demo.ts               # orchestrates the whole 5-minute scenario
│   └── fixtures/week1.json
└── web/                          # Next.js
```

---

## 3. On-chain design

### 3.1 Identifiers and enums

```solidity
// gameId   = keccak256(abi.encodePacked("NFL", season, week, homeAbbr, awayAbbr))
// playerId = keccak256(abi.encodePacked("NFL", teamAbbr, playerSlug))   // gsis id if available

enum ReportTag  { NONE, PROBABLE, QUESTIONABLE, DOUBTFUL, OUT }   // official designation
enum Practice   { UNKNOWN, FULL, LIMITED, DNP }                    // last practice status
enum Outcome    { UNRESOLVED, ACTIVE, INACTIVE }                   // what the claim predicts / what settles
enum Bucket     { B55, B68, B83, B95 }                             // 50–60, 60–75, 75–90, 90–100 % confidence
enum ClaimState { Committed, Purchased, KeyDelivered, Revealed, SettledCorrect, SettledWrong, Slashed, RefundedUndelivered }
```

Binary outcome (ACTIVE/INACTIVE) is deliberate: the official inactive list is binary, scoring is clean, and the HLD's single typed claim `(game, player, status, confidence)` maps directly.

### 3.2 Storage

```solidity
struct Game {
    uint64  lockTime;        // purchases and fills close here
    uint64  attestedAt;      // 0 until resolver attests
    bytes32 reportHash;      // keccak of the official inactive-list snapshot
    bool    voided;          // owner escape hatch during challenge window
}
struct Prior { ReportTag tag; Practice practice; uint64 updatedAt; }

struct Bounty {
    address buyer;
    bytes32 gameId;
    bytes32 playerId;
    uint96  revealFee;        // paid to seller on key delivery
    uint96  contingent;       // escrowed at purchase, released on correct settlement
}

struct Claim {
    uint64     bountyId;
    address    seller;
    bytes32    commitHash;      // keccak256(abi.encode(bountyId, outcome, bucket, evidenceHash, salt))
    bytes32    ciphertextHash;  // blob emitted in ClaimCommitted event
    uint96     bond;
    uint64     committedAt;
    ReportTag  priorTag;        // snapshot of public prior at commit time
    Practice   priorPractice;
    Bucket     bucket;          // set on reveal
    Outcome    claimed;         // set on reveal
    ClaimState state;
}

mapping(bytes32 => Game)                      games;
mapping(bytes32 => mapping(bytes32 => Prior)) priors;      // gameId => playerId => prior
mapping(bytes32 => mapping(bytes32 => bool))  inactive;    // gameId => playerId => on inactive list
mapping(uint64  => Bounty)                    bounties;    uint64 nextBountyId;
mapping(uint64  => Claim)                     claims;      uint64 nextClaimId;
mapping(address => bytes)                     encPubKeys;  // buyer secp256k1 compressed pubkey
mapping(address => uint256)                   balances;    // pull payments

// Parameters (constructor, immutable)
address resolver; address owner; address burnSink;
uint96  baseBond;              // bond = baseBond << uint(bucket)  → 1x, 2x, 4x, 8x
uint64  challengeWindow;       // demo: 60 s   | prod story: 24 h
uint64  revealWindow;          // demo: 240 s  | prod story: 48 h
```

Storage is intentionally small: every large blob (ciphertext, encrypted key, evidence) is **emitted, not stored**; only its keccak is stored so the contract can bind it.

### 3.3 Interface

```solidity
// --- setup (resolver/owner) ---
function createGame(bytes32 gameId, uint64 lockTime) external onlyResolver;
function setPrior(bytes32 gameId, bytes32 playerId, ReportTag tag, Practice practice) external onlyResolver;
function setPriorBatch(bytes32 gameId, bytes32[] playerIds, ReportTag[] tags, Practice[] practices) external onlyResolver;

// --- buyers ---
function registerEncPubKey(bytes calldata compressedPubKey) external;                 // 33 bytes
function postBounty(bytes32 gameId, bytes32 playerId, uint96 revealFee, uint96 contingent) external returns (uint64 bountyId);
function purchase(uint64 claimId) external payable;                                  // msg.value == revealFee + contingent
function refundUndelivered(uint64 claimId) external;                                 // after lock, if no key

// --- sellers ---
function fillBounty(uint64 bountyId, bytes32 commitHash, bytes calldata ciphertext) external payable returns (uint64 claimId); // msg.value == bond
function deliverKey(uint64 claimId, bytes calldata encKeyForBuyer) external;          // ECIES(K) to buyer pubkey
function reveal(uint64 claimId, Outcome claimed, Bucket bucket, bytes calldata evidence, bytes32 salt) external;

// --- resolver ---
function attest(bytes32 gameId, bytes32 reportHash, bytes32[] calldata inactivePlayerIds) external onlyResolver; // after lock
function voidAttestation(bytes32 gameId) external onlyOwner;                          // within challengeWindow only

// --- anyone (permissionless crank) ---
function settle(uint64 claimId) external;            // after finality, claim Revealed
function slashUnrevealed(uint64 claimId) external;   // after reveal deadline
function withdraw() external;

// --- views ---
function isFinal(bytes32 gameId) view returns (bool);
function bondFor(Bucket) pure returns (uint96);
```

### 3.4 Events (the indexing surface)

```solidity
event GameCreated(bytes32 indexed gameId, uint64 lockTime);
event PriorSet(bytes32 indexed gameId, bytes32 indexed playerId, ReportTag tag, Practice practice);
event BountyPosted(uint64 indexed bountyId, address indexed buyer, bytes32 indexed gameId, bytes32 playerId, uint96 revealFee, uint96 contingent);
event ClaimCommitted(uint64 indexed claimId, uint64 indexed bountyId, address indexed seller, bytes32 commitHash, uint96 bond, ReportTag priorTag, Practice priorPractice, bytes ciphertext);
event ClaimPurchased(uint64 indexed claimId, address indexed buyer);
event KeyDelivered(uint64 indexed claimId, bytes encKey);
event Attested(bytes32 indexed gameId, bytes32 reportHash, bytes32[] inactivePlayerIds);
event AttestationVoided(bytes32 indexed gameId);
event ClaimRevealed(uint64 indexed claimId, Outcome claimed, Bucket bucket, bytes evidence);
event ClaimSettled(uint64 indexed claimId, address indexed seller, bool correct, Outcome actual, Bucket bucket, ReportTag priorTag, Practice priorPractice, uint64 committedAt, uint64 lockTime, uint96 bond, uint96 escrowReleased);
event ClaimSlashed(uint64 indexed claimId, address indexed seller, uint96 bond);
event ClaimRefunded(uint64 indexed claimId, uint96 bond);
event Withdrawn(address indexed who, uint256 amount);
```

`ClaimSettled` carries every input the scorer needs, so reputation is a pure fold over that one event type.

### 3.5 Claim state machine

```
                fillBounty (seller, bond)
                        │
                        ▼
   ┌──────────── Committed ──────────────┐
   │ purchase (buyer,                    │ no purchase
   │  revealFee+contingent)              │
   ▼                                     │
Purchased                                │
   │ deliverKey (seller)  ── lock passes without key ──► RefundedUndelivered  (buyer refunded; bond → burnSink)
   ▼                                     │
KeyDelivered                             │
   │                                     │
   └──────────────┬──────────────────────┘
                  │  reveal (seller; allowed once now ≥ lockTime; hash must match)
                  ▼
              Revealed
                  │ settle (anyone; game final)
        ┌─────────┴──────────┐
        ▼                    ▼
 SettledCorrect        SettledWrong
 bond+escrow+          bond → burnSink
 revealFee → seller    escrow → buyer

 Any pre-Revealed state, once now > attestedAt + challengeWindow + revealWindow:
   slashUnrevealed → Slashed (bond → burnSink; escrow → buyer if purchased)
```

Invariants enforced by `require`s:

- `fillBounty`, `purchase`: `block.timestamp < game.lockTime` (the lock cliff).
- `deliverKey`: state == Purchased, sender == seller, `block.timestamp < lockTime`. Credits `revealFee` to seller balance here, not at purchase.
- `reveal`: `block.timestamp ≥ lockTime` (prevents leaking to non-buyers pre-lock), state ∈ {Committed, KeyDelivered}, `keccak256(abi.encode(bountyId, claimed, bucket, keccak256(evidence), salt)) == commitHash`, `evidence.length ≤ 4096`.
- `attest`: `block.timestamp ≥ lockTime`, `attestedAt == 0`.
- `settle`: `isFinal(gameId)` = `attestedAt != 0 && !voided && block.timestamp ≥ attestedAt + challengeWindow`; state == Revealed. `actual = inactive[gameId][playerId] ? INACTIVE : ACTIVE`.
- `slashUnrevealed`: `isFinal` and `block.timestamp > attestedAt + challengeWindow + revealWindow`, state ∉ {Revealed, Settled*, Slashed, RefundedUndelivered}.
- All value movement via `balances[...] += x` then `withdraw()` (pull pattern, `nonReentrant` on withdraw). No `.call` anywhere except `withdraw`.
- Bond schedule is committed to at fill time via `bondFor(bucket)`? — **No.** Bucket is hidden until reveal, so the bond must be posted without revealing the bucket. Resolution: seller posts any bond ≥ `baseBond`; on reveal, `require(claim.bond ≥ bondFor(bucket))`. A seller who under-bonds for a high-confidence claim cannot reveal it and gets slashed. This preserves "bond scales with confidence" without leaking confidence.

### 3.6 Commit and encryption scheme

```
payload    = JSON { v:1, bountyId, claimed, bucket, evidence:[...], rationale, salt }
commitHash = keccak256(abi.encode(bountyId, claimed, bucket, keccak256(evidenceBytes), salt))
K          = random 32 bytes
ciphertext = AES-256-GCM(K, nonce, payload)              // emitted in ClaimCommitted
encKey     = ECIES(buyerPubKey, K)                       // emitted in KeyDelivered after purchase
```

Why a symmetric key plus a second seller transaction, rather than encrypting straight to the buyer's key at fill time: anything posted at fill time is readable by the buyer before paying. The key is the thing that is sold; the ciphertext is public and pre-committed so the seller cannot swap content after seeing the purchase.

Buyer verification after decrypt: recompute `commitHash` from the payload and compare to on-chain — this proves the plaintext is what the seller committed to before lock.

Residual hole (documented, not fixed): a seller can deliver a garbage key. The contract cannot verify decryption. Damage is bounded to `revealFee` (the escrowed `contingent` still only releases on a correct *revealed* claim, and mandatory reveal forces the true payload public). Buyer agents blacklist the seller locally. This is the "one important limitation" candidate for the README, alongside resolver trust.

---

## 4. Off-chain components

All agents share `lib/chain.ts` (clients, ABI, `deployBlock`) and rebuild state on startup from `getLogs(fromBlock: deployBlock)`.

### 4.1 Resolver (`resolver.ts`)

| Mode | Source | Notes |
|---|---|---|
| `fixture` (demo) | `fixtures/week1.json` | Deterministic; lock times relative to `now` at demo start. |
| `live` (stretch) | Official injury-report page for each game | Adapter interface: `getPriors(gameId) → Prior[]`, `getInactives(gameId) → playerId[]`. Do not build unless everything else is done. |

Actions: `createGame`, `setPriorBatch` at start (and again on any fixture "update" tick), `attest(gameId, keccak(snapshotJSON), inactiveIds)` once `now ≥ lockTime`. Snapshot JSON is written to `out/attestations/<gameId>.json` so anyone can rehash it against `reportHash`.

### 4.2 Seller: Aggregator (`seller-aggregator.ts`)

- Subscribes to `BountyPosted`. For each open bounty on a game before lock, looks at fixture "local news items" whose `ts ≤ simulatedNow` for that player.
- Produces `(claimed, bucket, evidence[])`. Two implementations behind one function signature:
  - `llm`: prompt Claude with the items and the current public prior, require JSON `{claimed, bucket, evidenceRefs, rationale}`. Bucket is validated and clamped.
  - `rules`: keyword map (`"limited"`→ lower, `"full go"`/`"expected to play"` → ACTIVE/B83, `"ruled out"` → INACTIVE/B95). Default when `ANTHROPIC_API_KEY` is unset.
- Posts `fillBounty` with `bond = bondFor(bucket)`, persists `{claimId, payload, K}` to `out/seller-<addr>.json` (needed for `deliverKey` and `reveal`).
- Watches `ClaimPurchased` for its claims → `deliverKey`.
- After lock → `reveal` for **every** claim it committed, sold or not (mandatory reveal).

### 4.3 Seller: Forecaster (`seller-forecaster.ts`)

Same skeleton, different `decide()`:

```
p = priorTable[tag][practice]                       // start from public prior
p = adjust(p, practiceTrajectory)                   // DNP→LIM→FULL over the week: +; FULL→LIM: −
p = adjust(p, injuryType, daysSinceInjury)          // fixture supplies base-rate table by injury class
claimed = p ≥ 0.5 ? ACTIVE : INACTIVE
bucket  = bucketFor(max(p, 1-p))
```

Only fills when `|p − prior|` exceeds a margin — otherwise the expected score is ~0 and the bond is dead capital. This is the calibration story in one line: the forecaster sells disagreement with the report, not agreement.

### 4.4 Buyer (`buyer.ts`)

1. `registerEncPubKey` once (keypair persisted to `out/buyer-keys.json`).
2. Loads `lineup.json` → for each uncertain slot (prior tag ∈ {QUESTIONABLE, DOUBTFUL}) posts a bounty `(gameId, playerId, revealFee, contingent)`.
3. On `ClaimCommitted` for its bounties: ranks candidate sellers by ledger score (from `scoring.ts`); purchases the top `k` (default 2) per slot, subject to a per-slot budget.
4. On `KeyDelivered`: decrypt K, decrypt payload, verify `commitHash`. If verification fails → log, blacklist seller in-memory, do not count it.
5. Ensemble at lock: logit-pool `[prior] ∪ purchased claims`, weights `w_i = 1 + max(0, rep_i)`, prior weight 1. Emit `decision.json`: `{playerId, p_active, decision: START|BENCH, sources:[claimIds]}`.
6. After lock, if any purchased claim has no key → `refundUndelivered`.
7. After finality → `withdraw` any refunded escrow.

Step 5's output is what the video shows as "the buyer got something it could act on."

### 4.5 Scorer (`lib/scoring.ts`) — the reputation truth

Pure function `ledger(events: ClaimSettled[] ∪ ClaimSlashed[] ∪ ClaimRefunded[]) → Map<seller, {score, n, hits, bondBurned}>`. Used by the buyer agent and the web UI so both show identical numbers.

```
p0  = priorTable[priorTag][priorPractice]              // P(ACTIVE) from the public report at commit time
q   = bucketMid[bucket]                                // 0.55, 0.675, 0.825, 0.95 — confidence in `claimed`
y   = actual == ACTIVE
qy  = (claimed == actual) ? q : 1 - q
py  = y ? p0 : 1 - p0
w   = 0.1 + 0.9 * min(1, hoursBeforeLock / 96)         // lead-time weight; committedAt vs lockTime
Δ   = w * ( ln(qy) - ln(py) )                          // log-score improvement over the public prior
score[seller] += Δ ;  slashed/refunded claims add ln(0.05)*1.0 (a maximal miss)
```

Seed prior table (P(ACTIVE)); columns = last practice status:

| tag \ practice | FULL | LIMITED | DNP | UNKNOWN |
|---|---|---|---|---|
| NONE | 0.98 | 0.90 | 0.70 | 0.95 |
| PROBABLE | 0.95 | 0.85 | 0.65 | 0.88 |
| QUESTIONABLE | 0.85 | 0.70 | 0.45 | 0.72 |
| DOUBTFUL | 0.15 | 0.08 | 0.03 | 0.08 |
| OUT | 0.02 | 0.02 | 0.01 | 0.02 |

These are seed constants, not measurements. Falsifiable: backtest against any public season of injury reports; the README should say "illustrative; replace with empirical base rates." The formula's shape is the point: a late `ACTIVE/B55` on a `PROBABLE/FULL` player scores ≈ 0.1 × (ln 0.55 − ln 0.95) ≈ −0.05 (worthless-safe); an early `INACTIVE/B83` on `QUESTIONABLE/LIMITED` that resolves inactive scores ≈ 1.0 × (ln 0.825 − ln 0.30) ≈ +1.01; the same call wrong scores ≈ 1.0 × (ln 0.175 − ln 0.70) ≈ −1.39 plus the burned bond.

### 4.6 Demo orchestrator (`demo.ts`)

One command, runs against the real testnet, fits in 5 minutes with demo parameters:

```
t=0:00  resolver: createGame ×2, setPriorBatch            (lockTime = now + 240 s)
t=0:10  buyer: registerEncPubKey, postBounty ×3
t=0:20  aggregator + forecaster: fillBounty (5 claims total, mixed buckets)
t=0:40  buyer: purchase top-2 per slot
t=0:50  sellers: deliverKey; buyer decrypts + verifies + prints ensemble decision
t=4:00  LOCK — demo attempts a late purchase → reverts (show it)
t=4:05  resolver: attest (fixture outcome makes one contrarian claim right, one wrong)
t=4:10  sellers: reveal all (incl. one unsold claim); one seller deliberately does not reveal one claim
t=5:05  challengeWindow(60 s) elapsed: settle ×n, slashUnrevealed ×1, withdraw
        print ledger table; open web UI on /sellers/<addr>
```

Console output is structured (`[t+mm:ss] ACTOR action → txHash`) so the video can just be a terminal plus the explorer and the UI.

---

## 5. Web UI (read-mostly)

| Route | Content | Data |
|---|---|---|
| `/` | Games with lock countdown, open-bounty count, settled/not | `GameCreated`, `BountyPosted`, `Attested` |
| `/games/[id]` | Priors per player, bounties, claims per bounty with state badges; after finality shows inactive list + `reportHash` | `PriorSet`, `ClaimCommitted`, `ClaimSettled` |
| `/claims/[id]` | State timeline; if wallet == buyer and key delivered: **decrypt in browser** (buyer key pasted/loaded) and show payload + commit-hash check; after reveal: evidence | logs + `claims(id)` view |
| `/sellers/[addr]` | Ledger: score, n, hit rate, bond burned, per-claim Δ table | `scoring.ts` over events |
| Write actions | `purchase(claimId)` via wagmi (only write in the UI); everything else is agent-driven | |

Implementation: a single `lib/indexer.ts` in `web/` that calls `getLogs` from `deployBlock` on the server (route handler, `revalidate: 10`) and returns a normalized JSON snapshot; pages render from that. No subgraph.

---

## 6. Data formats

**`fixtures/week1.json`**

```json
{
  "season": 2026, "week": 1,
  "games": [{
    "home": "SF", "away": "SEA", "lockOffsetSec": 240,
    "players": [{
      "team": "SF", "slug": "cmc", "name": "Christian McCaffrey",
      "prior": { "tag": "QUESTIONABLE", "practice": "LIMITED" },
      "practiceTrajectory": ["DNP", "LIMITED", "LIMITED"],
      "injury": { "class": "soft-tissue", "daysSince": 9 },
      "news": [
        { "tsOffsetSec": -3600, "source": "local-beat", "text": "CMC ran routes at full speed in the open portion of practice" }
      ],
      "actual": "ACTIVE"
    }]
  }]
}
```

**Claim payload (encrypted)**

```json
{ "v": 1, "bountyId": 3, "claimed": "INACTIVE", "bucket": 2,
  "evidence": [{ "source": "local-beat", "ts": 1757..., "text": "..." }],
  "rationale": "…", "salt": "0x…32 bytes" }
```

**`lineup.json` (buyer input)** — `{ "gameId": "...", "slots": [{ "playerId": "...", "revealFeeWei": "...", "contingentWei": "..." }] }`

---

## 7. Test plan (Foundry)

| Test | Asserts |
|---|---|
| `test_HappyPath` | fill → purchase → deliverKey → warp(lock) → attest → warp(+challenge) → reveal → settle → seller `balances` == bond + contingent + revealFee; buyer paid exactly revealFee + contingent. |
| `test_WrongClaim` | bond in `burnSink` balance; buyer `balances` == contingent; seller keeps revealFee. |
| `test_UnsoldClaimStillScored` | reveal + settle on a never-purchased claim emits `ClaimSettled` with `escrowReleased == 0`. |
| `test_UnrevealedSlashed` | after reveal deadline `slashUnrevealed` burns bond, refunds escrow; `reveal` reverts afterwards. |
| `test_UndeliveredRefund` | purchase, no key, warp(lock) → buyer refund of fee + contingent; bond burned. |
| `test_UnderBondedReveal` | bond = baseBond, reveal with `B95` reverts; then slashable. |
| `test_LockCliff` | `fillBounty`/`purchase` revert at `lockTime`; `reveal` reverts before it. |
| `test_AttestOrdering` | `attest` before lock reverts; second `attest` reverts; `settle` before challenge window reverts; `voidAttestation` after window reverts. |
| `testFuzz_CommitBinding` | random `(claimed, bucket, evidence, salt)`: reveal with any single field changed reverts. |
| `test_PullPaymentsReentrancy` | malicious receiver cannot re-enter `withdraw`. |

Off-chain: a Vitest for `scoring.ts` on the three worked examples in §4.5, and a round-trip test for `crypto.ts` (encrypt → deliverKey → decrypt → hash check).

---

## 8. Deployment and submission artifacts

1. `forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify` with demo params: `baseBond = 0.0005 ether`, `challengeWindow = 60`, `revealWindow = 240`, `resolver = owner = deployer`, `burnSink = 0x…dEaD`.
2. Write `address` + `deployBlock` into `agents/src/lib/chain.ts` and `web/lib/config.ts`.
3. Fund three agent keys (buyer, aggregator, forecaster) from the deployer: ~0.05 ETH each on testnet.
4. `vercel --prod` for `web/`.
5. README sections (matching the brief exactly): Vertical · Trust assumptions (resolver honesty bounded by timelock; buyer key custody; official list as ground truth) · Biggest design decision (sealed commit + mandatory reveal + scoring surprise against an attested public prior — the thing that makes cherry-picking impossible) · One limitation (single-key resolver / garbage-key delivery bounded to reveal fee — pick one, mention the other) · Contract address + Basescan link · Demo command · Parameter table (demo vs "production story").

---

## 9. Build order and cut lines

Total budget ≈ 8 hours of work, in this order. Each block ends in something demoable.

| Block | Hours | Deliverable | If running late, cut… |
|---|---|---|---|
| 1 | 0–2 | Contract + the first 6 tests green | `voidAttestation` (keep `challengeWindow` as a pure timelock); `setPriorBatch` |
| 2 | 2–2.5 | Deployed + verified on Base Sepolia, address in README | nothing — this is a hard requirement |
| 3 | 2.5–5 | `resolver.ts`, both sellers (rules mode), `buyer.ts`, `scoring.ts`, `demo.ts` runs end-to-end on testnet | LLM mode in Aggregator; Forecaster becomes a second config of the rules seller; `k=1` purchases |
| 4 | 5–7 | Web: `/`, `/games/[id]`, `/sellers/[addr]` read-only on Vercel | `/claims/[id]` in-browser decrypt; the `purchase` button (agents do all writes) |
| 5 | 7–8 | README, record video, submit | — |

**Never cut** (these are the mechanism): sealed commit, bond ≥ schedule at reveal, lock cliff, batch attest, mandatory reveal + slash, pull-payment settlement, scoring against the prior snapshot. Everything a judge could call "a generic marketplace with themed labels" lives outside this list.

---

## 10. Threat model and edge cases (LLD-level)

| Threat | Handling |
|---|---|
| Resolver attests a false list | Bounded by `challengeWindow` timelock + owner void; in v2 a bonded challenge with a second attester. Stated in README as the primary trust assumption. |
| Seller delivers garbage key | Loss bounded to `revealFee`; payload still forced public at reveal; buyer-side blacklist. |
| Seller under-bonds a high-confidence claim | Cannot reveal → slashed. |
| Seller copies another seller's revealed claim | Impossible pre-lock (nothing is revealed before `lockTime`); post-lock fills revert. |
| Buyer never purchases (bounty spam) | Bounties are free to post; sellers' cost is a locked bond until settlement. Mitigation deferred (v2: small bounty deposit refunded on any purchase). |
| Non-exclusive tips | By design (HLD known limitation); one claim can fill many bounties only by re-committing per bounty, so each carries its own bond. |
| Sequencer downtime near lock | Testnet risk only; production story would set `lockTime = kickoff − 90 min` to leave slack. |
| Stale prior at commit | `priorTag/priorPractice` snapshot is taken from the on-chain prior at fill time; if the resolver updates the prior later, earlier claims are scored against what was public when they committed — this is the intended "surprise" semantics. |
| Evidence blob size | `≤ 4096` bytes enforced; larger evidence should be a URI inside the JSON. |
| Timestamp manipulation | L2 sequencer timestamps; windows are minutes-to-days, so second-level drift is immaterial. |

---

## 11. Open decisions (pick during Block 1, do not deliberate longer than 5 minutes each)

1. **Base Sepolia vs Arbitrum Sepolia** — decided by whichever faucet works first (A1).
2. **`eciesjs` vs hand-rolled `@noble` ECIES** — use `eciesjs` if it installs clean in both Node and the Next.js bundle; otherwise `@noble` with a 40-line wrapper.
3. **Bond in reveal vs at fill** — decided above (min bond at fill, schedule enforced at reveal). Revisit only if a judge argues the bucket should be public; it should not be, since confidence is part of what is sold.
