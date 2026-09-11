// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title SealedAvailabilityMarket
 * @notice A market for sealed, bonded claims about NFL player availability.
 *
 * Sellers (tipster agents) fill buyer bounties with a committed claim about whether a
 * player will appear on the official inactive list. The claim is sealed: the ciphertext
 * is public from the moment of the fill, but the AES key that opens it is withheld until
 * the buyer pays. Purchases close at a hard lineup lock. When the resolver attests the
 * official list, every claim on that game settles in one batch.
 *
 * The mechanism, in the order it resists gaming:
 *   1. Sealed commit      — content is fixed before lock and cannot be edited after a sale.
 *   2. Lock cliff         — stale intel is unsellable by construction.
 *   3. Mandatory reveal   — every claim, sold or not, is revealed or forfeits its bond,
 *                           so a seller's miss history cannot be cherry-picked.
 *   4. Bond at reveal     — bond must clear the confidence schedule, without leaking
 *                           confidence at fill time.
 *   5. Batch attestation  — one resolver attestation settles the whole game.
 *   6. Pull payments      — no push transfers anywhere except withdraw().
 *
 * Scoring is deliberately OFF-CHAIN. `ClaimSettled` carries every input the scorer needs
 * (the prior snapshot taken at commit time, the bucket, lead time, and the outcome), so
 * reputation is a pure fold over one event type and can be recomputed by anyone.
 */
contract SealedAvailabilityMarket {
    // -----------------------------------------------------------------------
    // Enums (ordering is part of the ABI — agents/src/lib/crypto.ts mirrors it)
    // -----------------------------------------------------------------------

    enum ReportTag {
        NONE,
        PROBABLE,
        QUESTIONABLE,
        DOUBTFUL,
        OUT
    }

    enum Practice {
        UNKNOWN,
        FULL,
        LIMITED,
        DNP
    }

    enum Outcome {
        UNRESOLVED,
        ACTIVE,
        INACTIVE
    }

    enum Bucket {
        B55,
        B68,
        B83,
        B95
    }

    enum ClaimState {
        Committed,
        Purchased,
        KeyDelivered,
        Revealed,
        SettledCorrect,
        SettledWrong,
        Slashed,
        RefundedUndelivered,
        Unwound
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    struct Game {
        uint64 lockTime;
        uint64 attestedAt;
        bytes32 reportHash;
        bool voided;
        bool unwound; // permissionless escape hatch was triggered
    }

    struct Prior {
        ReportTag tag;
        Practice practice;
        uint64 updatedAt;
    }

    struct Bounty {
        address buyer;
        bytes32 gameId;
        bytes32 playerId;
        uint96 revealFee;
        uint96 contingent;
    }

    struct Claim {
        uint64 bountyId;
        address seller;
        bytes32 commitHash;
        bytes32 ciphertextHash;
        uint96 bond;
        uint96 escrow; // contingent actually deposited at purchase; 0 if never sold
        uint64 committedAt;
        ReportTag priorTag;
        Practice priorPractice;
        Bucket bucket;
        Outcome claimed;
        ClaimState state;
    }

    mapping(bytes32 => Game) public games;
    mapping(bytes32 => mapping(bytes32 => Prior)) public priors;
    mapping(bytes32 => mapping(bytes32 => bool)) public inactive;
    mapping(uint64 => Bounty) public bounties;
    mapping(uint64 => Claim) public claims;
    mapping(address => bytes) public encPubKeys;
    mapping(address => uint256) public balances;

    uint64 public nextBountyId = 1;
    uint64 public nextClaimId = 1;

    /// Sets the slate and publishes the public priors. Never decides outcomes.
    address public immutable scheduler;
    /// Decides outcomes, and nothing else. In production this is an oracle adapter.
    address public immutable attester;
    address public immutable owner;
    address public immutable burnSink;
    /// Market operator. Earns the protocol fee; in this deployment also scheduler+attester.
    address public immutable feeRecipient;
    /**
     * Protocol fee, in basis points of the reveal fee, taken when the key is delivered.
     *
     * Deliberately charged on the SALE and never on the settlement outcome. The operator is
     * also the attester, so any fee that varied with whether claims settle correct or wrong
     * would pay them to attest falsely. A cut of burned bonds would be worst of all: it
     * would make the oracle profit from sellers being wrong. This fee is fixed at the moment
     * the key changes hands, before any outcome exists.
     */
    uint16 public immutable protocolFeeBps;
    uint96 public immutable baseBond;
    uint64 public immutable challengeWindow;
    uint64 public immutable revealWindow;
    /**
     * How long after lock the market waits for an attestation before ANYONE may unwind the
     * game and hand every participant their money back.
     *
     * The operator is centralized on the happy path: it is the only party that can attest,
     * and everyone depends on it for speed. But `settle` and `slashUnrevealed` both gate on
     * `isFinal`, which needs an attestation — so without this, an operator that simply went
     * away would freeze every bond and every escrow on the game permanently.
     *
     * This is the escape hatch. You trust the operator for CONVENIENCE, never for CUSTODY.
     */
    uint64 public immutable unwindDelay;

    uint256 private _reentrancyLock = 1;

    // -----------------------------------------------------------------------
    // Events (the indexing surface)
    // -----------------------------------------------------------------------

    event GameCreated(bytes32 indexed gameId, uint64 lockTime);
    event PriorSet(bytes32 indexed gameId, bytes32 indexed playerId, ReportTag tag, Practice practice);
    event BountyPosted(
        uint64 indexed bountyId,
        address indexed buyer,
        bytes32 indexed gameId,
        bytes32 playerId,
        uint96 revealFee,
        uint96 contingent
    );
    event EncPubKeyRegistered(address indexed who, bytes pubKey);
    event ClaimCommitted(
        uint64 indexed claimId,
        uint64 indexed bountyId,
        address indexed seller,
        bytes32 commitHash,
        uint96 bond,
        ReportTag priorTag,
        Practice priorPractice,
        bytes ciphertext
    );
    event ClaimPurchased(uint64 indexed claimId, address indexed buyer);
    event KeyDelivered(uint64 indexed claimId, bytes encKey);
    event ProtocolFeeAccrued(uint64 indexed claimId, address indexed recipient, uint96 amount);
    event Attested(bytes32 indexed gameId, bytes32 reportHash, bytes32[] inactivePlayerIds);
    event AttestationVoided(bytes32 indexed gameId);
    event GameUnwound(bytes32 indexed gameId, address indexed triggeredBy);
    event ClaimUnwound(uint64 indexed claimId, address indexed seller, uint96 bond, uint96 escrow);
    event ClaimRevealed(uint64 indexed claimId, Outcome claimed, Bucket bucket, bytes evidence);
    event ClaimSettled(
        uint64 indexed claimId,
        address indexed seller,
        bool correct,
        Outcome actual,
        Bucket bucket,
        ReportTag priorTag,
        Practice priorPractice,
        uint64 committedAt,
        uint64 lockTime,
        uint96 bond,
        uint96 escrowReleased
    );
    event ClaimSlashed(uint64 indexed claimId, address indexed seller, uint96 bond);
    event ClaimRefunded(uint64 indexed claimId, uint96 bond);
    event Withdrawn(address indexed who, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotScheduler();
    error NotAttester();
    error NotOwner();
    error NotSeller();
    error NotBuyer();
    error GameExists();
    error NoGame();
    error NoBounty();
    error NoClaim();
    error LockPassed();
    error LockNotReached();
    error BadState();
    error BadValue();
    error BondTooLow();
    error BadPubKey();
    error NoPubKey();
    error AlreadyAttested();
    error NotAttested();
    error AlreadyUnwound();
    error UnwindTooEarly();
    error NotUnwound();
    error NotFinal();
    error ChallengeWindowClosed();
    error RevealWindowOpen();
    error CommitMismatch();
    error EvidenceTooLarge();
    error EmptyCiphertext();
    error Reentrancy();
    error NothingToWithdraw();
    error TransferFailed();

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    /**
     * Scheduling and attesting are deliberately SEPARATE roles.
     *
     * Scoring is `Δ = w * (ln(qy) - ln(py))`, where `py` comes from the prior snapshot and
     * `qy` from the outcome. A single key holding both roles could move any seller's
     * reputation by rewriting what was "publicly known" at commit time, not just by lying
     * about who sat out. Splitting them means the oracle decides outcomes and nothing else.
     */
    modifier onlyScheduler() {
        if (msg.sender != scheduler) revert NotScheduler();
        _;
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert Reentrancy();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    constructor(
        address _scheduler,
        address _attester,
        address _owner,
        address _burnSink,
        address _feeRecipient,
        uint16 _protocolFeeBps,
        uint96 _baseBond,
        uint64 _challengeWindow,
        uint64 _revealWindow,
        uint64 _unwindDelay
    ) {
        scheduler = _scheduler;
        attester = _attester;
        owner = _owner;
        burnSink = _burnSink;
        feeRecipient = _feeRecipient;
        if (_protocolFeeBps > 1000) revert BadValue(); // hard cap at 10%
        protocolFeeBps = _protocolFeeBps;
        baseBond = _baseBond;
        challengeWindow = _challengeWindow;
        revealWindow = _revealWindow;
        unwindDelay = _unwindDelay;
    }

    // -----------------------------------------------------------------------
    // Setup (resolver)
    // -----------------------------------------------------------------------

    function createGame(bytes32 gameId, uint64 lockTime) external onlyScheduler {
        if (games[gameId].lockTime != 0) revert GameExists();
        if (lockTime <= block.timestamp) revert LockPassed();
        games[gameId].lockTime = lockTime;
        emit GameCreated(gameId, lockTime);
    }

    function setPrior(bytes32 gameId, bytes32 playerId, ReportTag tag, Practice practice)
        public
        onlyScheduler
    {
        if (games[gameId].lockTime == 0) revert NoGame();
        priors[gameId][playerId] = Prior({tag: tag, practice: practice, updatedAt: uint64(block.timestamp)});
        emit PriorSet(gameId, playerId, tag, practice);
    }

    function setPriorBatch(
        bytes32 gameId,
        bytes32[] calldata playerIds,
        ReportTag[] calldata tags,
        Practice[] calldata practices
    ) external onlyScheduler {
        if (playerIds.length != tags.length || playerIds.length != practices.length) revert BadValue();
        for (uint256 i; i < playerIds.length; ++i) {
            setPrior(gameId, playerIds[i], tags[i], practices[i]);
        }
    }

    // -----------------------------------------------------------------------
    // Buyers
    // -----------------------------------------------------------------------

    /// @notice Register the compressed secp256k1 pubkey that sellers wrap K to.
    function registerEncPubKey(bytes calldata compressedPubKey) external {
        if (compressedPubKey.length != 33) revert BadPubKey();
        uint8 prefix = uint8(compressedPubKey[0]);
        if (prefix != 0x02 && prefix != 0x03) revert BadPubKey();
        encPubKeys[msg.sender] = compressedPubKey;
        emit EncPubKeyRegistered(msg.sender, compressedPubKey);
    }

    function postBounty(bytes32 gameId, bytes32 playerId, uint96 revealFee, uint96 contingent)
        external
        returns (uint64 bountyId)
    {
        Game storage g = games[gameId];
        if (g.lockTime == 0) revert NoGame();
        if (block.timestamp >= g.lockTime) revert LockPassed();

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            buyer: msg.sender,
            gameId: gameId,
            playerId: playerId,
            revealFee: revealFee,
            contingent: contingent
        });
        emit BountyPosted(bountyId, msg.sender, gameId, playerId, revealFee, contingent);
    }

    /// @notice Buy a sealed claim. The key arrives in a separate seller tx (deliverKey).
    function purchase(uint64 claimId) external payable {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Committed) revert BadState();

        Bounty storage b = bounties[c.bountyId];
        if (msg.sender != b.buyer) revert NotBuyer();
        if (encPubKeys[msg.sender].length == 0) revert NoPubKey();
        if (msg.value != uint256(b.revealFee) + uint256(b.contingent)) revert BadValue();

        // The lock cliff: intel cannot be sold once lineups are locked.
        if (block.timestamp >= games[b.gameId].lockTime) revert LockPassed();

        c.state = ClaimState.Purchased;
        c.escrow = b.contingent;
        emit ClaimPurchased(claimId, msg.sender);
    }

    /// @notice Buyer paid but no key arrived before lock: refund fee + escrow, burn the bond.
    function refundUndelivered(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Purchased) revert BadState();

        Bounty storage b = bounties[c.bountyId];
        if (block.timestamp < games[b.gameId].lockTime) revert LockNotReached();

        uint96 escrow = c.escrow;
        c.escrow = 0;
        c.state = ClaimState.RefundedUndelivered;

        // revealFee is only credited to the seller at deliverKey, so both legs return here.
        balances[b.buyer] += uint256(b.revealFee) + uint256(escrow);
        balances[burnSink] += c.bond;

        emit ClaimRefunded(claimId, c.bond);
    }

    // -----------------------------------------------------------------------
    // Sellers
    // -----------------------------------------------------------------------

    /**
     * @notice Fill a bounty with a sealed, bonded claim.
     * @dev The bucket is NOT supplied here — it is hidden until reveal, so the bond cannot
     *      be schedule-checked yet. Any bond >= baseBond is accepted; `reveal` then enforces
     *      `bond >= bondFor(bucket)`. A seller who under-bonds a high-confidence claim simply
     *      cannot reveal it, and is slashed instead. This keeps "bond scales with confidence"
     *      without leaking confidence at fill time.
     */
    function fillBounty(uint64 bountyId, bytes32 commitHash, bytes calldata ciphertext)
        external
        payable
        returns (uint64 claimId)
    {
        Bounty storage b = bounties[bountyId];
        if (b.buyer == address(0)) revert NoBounty();
        if (ciphertext.length == 0) revert EmptyCiphertext();

        Game storage g = games[b.gameId];
        if (block.timestamp >= g.lockTime) revert LockPassed();
        if (msg.value < baseBond) revert BondTooLow();
        if (msg.value > type(uint96).max) revert BadValue();

        // Snapshot the public prior AS OF THIS MOMENT. Scoring measures surprise against
        // what was public when the seller committed, not against a later revision.
        Prior storage p = priors[b.gameId][b.playerId];

        claimId = nextClaimId++;
        claims[claimId] = Claim({
            bountyId: bountyId,
            seller: msg.sender,
            commitHash: commitHash,
            ciphertextHash: keccak256(ciphertext),
            bond: uint96(msg.value),
            escrow: 0,
            committedAt: uint64(block.timestamp),
            priorTag: p.tag,
            priorPractice: p.practice,
            bucket: Bucket.B55,
            claimed: Outcome.UNRESOLVED,
            state: ClaimState.Committed
        });

        emit ClaimCommitted(
            claimId, bountyId, msg.sender, commitHash, uint96(msg.value), p.tag, p.practice, ciphertext
        );
    }

    /// @notice Deliver ECIES(buyerPubKey, K) after purchase. Credits the reveal fee here.
    function deliverKey(uint64 claimId, bytes calldata encKeyForBuyer) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (msg.sender != c.seller) revert NotSeller();
        if (c.state != ClaimState.Purchased) revert BadState();

        Bounty storage b = bounties[c.bountyId];
        if (block.timestamp >= games[b.gameId].lockTime) revert LockPassed();

        c.state = ClaimState.KeyDelivered;

        // Outcome-independent protocol fee, taken from the seller's proceeds on the sale.
        uint96 fee = uint96((uint256(b.revealFee) * protocolFeeBps) / 10_000);
        if (fee != 0) {
            balances[feeRecipient] += fee;
            emit ProtocolFeeAccrued(claimId, feeRecipient, fee);
        }
        balances[c.seller] += uint256(b.revealFee) - fee;

        emit KeyDelivered(claimId, encKeyForBuyer);
    }

    /**
     * @notice Mandatory reveal. Every claim is revealed after lock or forfeits its bond.
     * @dev Gated on `block.timestamp >= lockTime` so a reveal cannot leak the claim to
     *      non-buyers while it is still sellable.
     */
    function reveal(uint64 claimId, Outcome claimed, Bucket bucket, bytes calldata evidence, bytes32 salt)
        external
    {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (msg.sender != c.seller) revert NotSeller();
        if (c.state != ClaimState.Committed && c.state != ClaimState.KeyDelivered) revert BadState();
        if (evidence.length > 4096) revert EvidenceTooLarge();

        Bounty storage b = bounties[c.bountyId];
        Game storage g = games[b.gameId];
        if (block.timestamp < g.lockTime) revert LockNotReached();

        // Past the slash deadline a claim is no longer revealable, only slashable.
        if (g.attestedAt != 0 && !g.voided) {
            if (block.timestamp > uint256(g.attestedAt) + challengeWindow + revealWindow) {
                revert RevealWindowOpen();
            }
        }

        bytes32 expected = keccak256(abi.encode(c.bountyId, claimed, bucket, keccak256(evidence), salt));
        if (expected != c.commitHash) revert CommitMismatch();

        // The confidence schedule is enforced here, where the bucket finally becomes public.
        if (c.bond < bondFor(bucket)) revert BondTooLow();

        c.claimed = claimed;
        c.bucket = bucket;
        c.state = ClaimState.Revealed;

        emit ClaimRevealed(claimId, claimed, bucket, evidence);
    }

    // -----------------------------------------------------------------------
    // Resolver
    // -----------------------------------------------------------------------

    /// @notice One attestation settles every claim on the game.
    function attest(bytes32 gameId, bytes32 reportHash, bytes32[] calldata inactivePlayerIds)
        external
        onlyAttester
    {
        Game storage g = games[gameId];
        if (g.lockTime == 0) revert NoGame();
        if (block.timestamp < g.lockTime) revert LockNotReached();
        if (g.attestedAt != 0) revert AlreadyAttested();
        if (g.unwound) revert AlreadyUnwound();

        g.attestedAt = uint64(block.timestamp);
        g.reportHash = reportHash;
        for (uint256 i; i < inactivePlayerIds.length; ++i) {
            inactive[gameId][inactivePlayerIds[i]] = true;
        }

        emit Attested(gameId, reportHash, inactivePlayerIds);
    }

    /// @notice Owner escape hatch, valid only inside the challenge window.
    function voidAttestation(bytes32 gameId) external onlyOwner {
        Game storage g = games[gameId];
        if (g.attestedAt == 0) revert NotAttested();
        if (block.timestamp >= uint256(g.attestedAt) + challengeWindow) revert ChallengeWindowClosed();
        g.voided = true;
        emit AttestationVoided(gameId);
    }

    // -----------------------------------------------------------------------
    // Escape hatch — the operator is trusted for liveness, never for custody
    // -----------------------------------------------------------------------

    /**
     * @notice Permissionlessly abandon a game the operator never attested.
     *
     * Callable by anyone once `lockTime + unwindDelay` has passed with no attestation. It
     * does not decide any outcome — nobody knows the outcome, which is the whole problem —
     * it simply opens the door for every participant to take their own money back.
     */
    function forceUnwind(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.lockTime == 0) revert NoGame();
        if (g.unwound) revert AlreadyUnwound();
        if (g.attestedAt != 0) revert AlreadyAttested();
        if (block.timestamp <= uint256(g.lockTime) + unwindDelay) revert UnwindTooEarly();

        g.unwound = true;
        emit GameUnwound(gameId, msg.sender);
    }

    /**
     * @notice Return one claim's bond to its seller and its escrow to its buyer.
     * @dev No ClaimSettled is emitted and no bond is burned: the outcome is unknown, so
     *      nobody is scored and nobody is punished. An unwound game is a non-event.
     */
    function unwindClaim(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();

        Bounty storage b = bounties[c.bountyId];
        if (!games[b.gameId].unwound) revert NotUnwound();
        if (
            c.state == ClaimState.SettledCorrect || c.state == ClaimState.SettledWrong
                || c.state == ClaimState.Slashed || c.state == ClaimState.RefundedUndelivered
                || c.state == ClaimState.Unwound
        ) revert BadState();

        uint96 escrow = c.escrow;
        c.escrow = 0;
        c.state = ClaimState.Unwound;

        balances[c.seller] += c.bond;
        if (escrow != 0) balances[b.buyer] += escrow;

        emit ClaimUnwound(claimId, c.seller, c.bond, escrow);
    }

    // -----------------------------------------------------------------------
    // Permissionless cranks
    // -----------------------------------------------------------------------

    function settle(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Revealed) revert BadState();

        Bounty storage b = bounties[c.bountyId];
        Game storage g = games[b.gameId];
        if (!isFinal(b.gameId)) revert NotFinal();

        Outcome actual = inactive[b.gameId][b.playerId] ? Outcome.INACTIVE : Outcome.ACTIVE;
        bool correct = (c.claimed == actual);

        // Escrow is whatever was actually deposited at purchase — 0 for an unsold claim.
        // It must be read before the state transition, and zeroed to prevent double release.
        uint96 escrow = c.escrow;
        c.escrow = 0;

        uint96 escrowReleased;
        if (correct) {
            c.state = ClaimState.SettledCorrect;
            escrowReleased = escrow;
            balances[c.seller] += uint256(c.bond) + uint256(escrow);
        } else {
            c.state = ClaimState.SettledWrong;
            balances[burnSink] += c.bond;
            balances[b.buyer] += escrow;
        }

        emit ClaimSettled(
            claimId,
            c.seller,
            correct,
            actual,
            c.bucket,
            c.priorTag,
            c.priorPractice,
            c.committedAt,
            g.lockTime,
            c.bond,
            escrowReleased
        );
    }

    /// @notice Bond forfeit for any claim that never revealed. Makes misses unhideable.
    function slashUnrevealed(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (
            c.state != ClaimState.Committed && c.state != ClaimState.Purchased
                && c.state != ClaimState.KeyDelivered
        ) revert BadState();

        Bounty storage b = bounties[c.bountyId];
        Game storage g = games[b.gameId];
        if (!isFinal(b.gameId)) revert NotFinal();
        if (block.timestamp <= uint256(g.attestedAt) + challengeWindow + revealWindow) {
            revert RevealWindowOpen();
        }

        uint96 escrow = c.escrow;
        c.escrow = 0;

        c.state = ClaimState.Slashed;
        balances[burnSink] += c.bond;
        balances[b.buyer] += escrow;

        emit ClaimSlashed(claimId, c.seller, c.bond);
    }

    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function isFinal(bytes32 gameId) public view returns (bool) {
        Game storage g = games[gameId];
        return g.attestedAt != 0 && !g.voided && !g.unwound
            && block.timestamp >= uint256(g.attestedAt) + challengeWindow;
    }

    /// @dev bond = baseBond << bucket  →  1x, 2x, 4x, 8x for B55/B68/B83/B95.
    function bondFor(Bucket bucket) public view returns (uint96) {
        return uint96(uint256(baseBond) << uint256(bucket));
    }

}
