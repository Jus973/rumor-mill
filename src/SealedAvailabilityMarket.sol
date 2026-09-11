// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title SealedAvailabilityMarket
 * @notice A two-sided market for sealed, bonded claims about NFL player availability.
 *
 * SELLERS list whenever they have something. A listing is a sealed claim on one
 * (game, player): the ciphertext is public from the moment it is listed, the AES key that
 * opens it is withheld until a buyer pays, and a bond scaled to the seller's confidence
 * sits behind it. The seller names its own ask.
 *
 * BUYERS post bounties whenever they want to search. A bounty is a bid: "I want intel on
 * this player in this game, and I will pay up to this much." It is non-binding and escrows
 * nothing; matching a bounty to a listing happens off-chain. Any registered buyer can hit
 * any listing, and one listing can sell to many buyers, each with its own escrow.
 *
 * The mechanism, in the order it resists gaming:
 *   1. Sealed commit      — content is fixed at listing and cannot be edited after a sale.
 *   2. Lock cliff         — listings, purchases and key delivery all close at lineup lock.
 *   3. Mandatory reveal   — every listing, sold or not, is revealed or forfeits its bond.
 *   4. Bond at reveal     — the bond must clear the confidence schedule, checked only when
 *                           the bucket finally becomes public.
 *   5. Batch attestation  — one attestation settles every claim on the game.
 *   6. Priced on surprise — the contingent leg a correct seller collects is scaled by how
 *                           early it committed and by how much it disagreed with the public
 *                           report at that moment. Restating an obvious report earns ~0.
 *   7. Pull payments      — no push transfers anywhere except withdraw().
 *
 * Reputation scoring stays OFF-CHAIN: `ClaimSettled` carries every input the scorer needs.
 */
contract SealedAvailabilityMarket {
    // -----------------------------------------------------------------------
    // Enums (ordering is part of the ABI — agents/src/lib/enums.ts mirrors it)
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
        Listed,
        Revealed,
        SettledCorrect,
        SettledWrong,
        Slashed,
        Unwound
    }

    enum PurchaseState {
        None,
        Paid,
        KeyDelivered,
        Refunded,
        Resolved
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

    /// A buyer's bid. Non-binding; escrows nothing. Matching is off-chain.
    struct Bounty {
        address buyer;
        bytes32 gameId;
        bytes32 playerId;
        uint96 maxRevealFee;
        uint96 maxContingent;
        bool cancelled;
    }

    /// A seller's listing. Independent of any bounty.
    struct Claim {
        address seller;
        bytes32 gameId;
        bytes32 playerId;
        bytes32 commitHash;
        bytes32 ciphertextHash;
        uint96 bond;
        uint96 askRevealFee;
        uint96 askContingent;
        uint64 committedAt;
        uint32 buyers; // number of purchases
        uint16 payoutBps; // share of each escrow the seller earns; set at settle
        ReportTag priorTag;
        Practice priorPractice;
        Bucket bucket;
        Outcome claimed;
        ClaimState state;
    }

    /// One buyer's purchase of one listing.
    struct Purchase {
        uint96 revealFee;
        uint96 contingent;
        PurchaseState state;
    }

    mapping(bytes32 => Game) public games;
    mapping(bytes32 => mapping(bytes32 => Prior)) public priors;
    mapping(bytes32 => mapping(bytes32 => bool)) public inactive;
    mapping(uint64 => Bounty) public bounties;
    mapping(uint64 => Claim) public claims;
    mapping(uint64 => mapping(address => Purchase)) public purchases;
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
     * would pay them to attest falsely. This fee is fixed at the moment the key changes
     * hands, before any outcome exists.
     */
    uint16 public immutable protocolFeeBps;
    uint96 public immutable baseBond;
    uint64 public immutable challengeWindow;
    uint64 public immutable revealWindow;
    /**
     * How long after lock the market waits for an attestation before ANYONE may unwind the
     * game and hand every participant their money back. You trust the operator for
     * CONVENIENCE, never for CUSTODY.
     */
    uint64 public immutable unwindDelay;
    /**
     * Lead time at which the price multiplier saturates. A claim committed this far (or
     * further) before lock earns the full contingent; one committed at lock earns 10%.
     * Production story: 96 hours. Demo: a couple of minutes.
     */
    uint64 public immutable leadSaturation;

    uint256 private _reentrancyLock = 1;

    // -----------------------------------------------------------------------
    // Events (the indexing surface)
    // -----------------------------------------------------------------------

    event GameCreated(bytes32 indexed gameId, uint64 lockTime);
    event PriorSet(bytes32 indexed gameId, bytes32 indexed playerId, ReportTag tag, Practice practice);
    event EncPubKeyRegistered(address indexed who, bytes pubKey);
    event BountyPosted(
        uint64 indexed bountyId,
        address indexed buyer,
        bytes32 indexed gameId,
        bytes32 playerId,
        uint96 maxRevealFee,
        uint96 maxContingent
    );
    event BountyCancelled(uint64 indexed bountyId);
    event ClaimListed(
        uint64 indexed claimId,
        address indexed seller,
        bytes32 indexed gameId,
        bytes32 playerId,
        bytes32 commitHash,
        uint96 bond,
        uint96 askRevealFee,
        uint96 askContingent,
        uint64 committedAt,
        ReportTag priorTag,
        Practice priorPractice,
        bytes ciphertext
    );
    event ClaimPurchased(uint64 indexed claimId, address indexed buyer, uint96 revealFee, uint96 contingent);
    event KeyDelivered(uint64 indexed claimId, address indexed buyer, bytes encKey);
    event ProtocolFeeAccrued(uint64 indexed claimId, address indexed recipient, uint96 amount);
    event PurchaseRefunded(uint64 indexed claimId, address indexed buyer, uint96 amount);
    event Attested(bytes32 indexed gameId, bytes32 reportHash, bytes32[] inactivePlayerIds);
    event AttestationVoided(bytes32 indexed gameId);
    event GameUnwound(bytes32 indexed gameId, address indexed triggeredBy);
    event ClaimUnwound(uint64 indexed claimId, address indexed seller, uint96 bond);
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
        uint16 payoutBps
    );
    event PurchaseResolved(uint64 indexed claimId, address indexed buyer, uint96 toSeller, uint96 toBuyer);
    event ClaimSlashed(uint64 indexed claimId, address indexed seller, uint96 bond);
    event Withdrawn(address indexed who, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotScheduler();
    error NotAttester();
    error NotOwner();
    error NotSeller();
    error NotBuyer();
    error SelfDeal();
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
    error AlreadyPurchased();
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
     * Scheduling and attesting are deliberately SEPARATE roles. Scoring and pricing both
     * read the prior snapshot AND the outcome, so a single key holding both could move any
     * seller's payout two ways. Splitting them means the oracle decides outcomes and
     * nothing else.
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
        uint64 _unwindDelay,
        uint64 _leadSaturation
    ) {
        scheduler = _scheduler;
        attester = _attester;
        owner = _owner;
        burnSink = _burnSink;
        feeRecipient = _feeRecipient;
        if (_protocolFeeBps > 1000) revert BadValue(); // hard cap at 10%
        if (_leadSaturation == 0) revert BadValue();
        protocolFeeBps = _protocolFeeBps;
        baseBond = _baseBond;
        challengeWindow = _challengeWindow;
        revealWindow = _revealWindow;
        unwindDelay = _unwindDelay;
        leadSaturation = _leadSaturation;
    }

    // -----------------------------------------------------------------------
    // Setup (scheduler)
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
    // Buyers: search
    // -----------------------------------------------------------------------

    /// @notice Register the compressed secp256k1 pubkey that sellers wrap K to.
    function registerEncPubKey(bytes calldata compressedPubKey) external {
        if (compressedPubKey.length != 33) revert BadPubKey();
        uint8 prefix = uint8(compressedPubKey[0]);
        if (prefix != 0x02 && prefix != 0x03) revert BadPubKey();
        encPubKeys[msg.sender] = compressedPubKey;
        emit EncPubKeyRegistered(msg.sender, compressedPubKey);
    }

    /**
     * @notice Post a bid: "I want intel on this player, up to this price."
     * @dev Non-binding and escrows nothing. It is the demand signal sellers watch, and the
     *      query the buyer's own agent matches listings against. Money moves at `purchase`.
     */
    function postBounty(bytes32 gameId, bytes32 playerId, uint96 maxRevealFee, uint96 maxContingent)
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
            maxRevealFee: maxRevealFee,
            maxContingent: maxContingent,
            cancelled: false
        });
        emit BountyPosted(bountyId, msg.sender, gameId, playerId, maxRevealFee, maxContingent);
    }

    function cancelBounty(uint64 bountyId) external {
        Bounty storage b = bounties[bountyId];
        if (b.buyer == address(0)) revert NoBounty();
        if (msg.sender != b.buyer) revert NotBuyer();
        b.cancelled = true;
        emit BountyCancelled(bountyId);
    }

    // -----------------------------------------------------------------------
    // Sellers: list
    // -----------------------------------------------------------------------

    /**
     * @notice List a sealed, bonded claim on (game, player) at your own ask.
     * @dev The bucket is NOT supplied here — it is hidden until reveal, so the bond cannot
     *      be schedule-checked yet. Any bond >= baseBond is accepted; `reveal` then enforces
     *      `bond >= bondFor(bucket)`. A seller who under-bonds a high-confidence claim simply
     *      cannot reveal it, and is slashed instead.
     *
     *      The public prior is snapshotted AS OF THIS MOMENT. Pricing and scoring both
     *      measure surprise against what was public when the seller committed, not against
     *      a later revision — so an early call is not punished when the report catches up.
     */
    function listClaim(
        bytes32 gameId,
        bytes32 playerId,
        bytes32 commitHash,
        bytes calldata ciphertext,
        uint96 askRevealFee,
        uint96 askContingent
    ) external payable returns (uint64 claimId) {
        Game storage g = games[gameId];
        if (g.lockTime == 0) revert NoGame();
        if (block.timestamp >= g.lockTime) revert LockPassed();
        if (ciphertext.length == 0) revert EmptyCiphertext();
        if (msg.value < baseBond) revert BondTooLow();
        if (msg.value > type(uint96).max) revert BadValue();

        Prior storage p = priors[gameId][playerId];

        claimId = nextClaimId++;
        claims[claimId] = Claim({
            seller: msg.sender,
            gameId: gameId,
            playerId: playerId,
            commitHash: commitHash,
            ciphertextHash: keccak256(ciphertext),
            bond: uint96(msg.value),
            askRevealFee: askRevealFee,
            askContingent: askContingent,
            committedAt: uint64(block.timestamp),
            buyers: 0,
            payoutBps: 0,
            priorTag: p.tag,
            priorPractice: p.practice,
            bucket: Bucket.B55,
            claimed: Outcome.UNRESOLVED,
            state: ClaimState.Listed
        });

        emit ClaimListed(
            claimId,
            msg.sender,
            gameId,
            playerId,
            commitHash,
            uint96(msg.value),
            askRevealFee,
            askContingent,
            uint64(block.timestamp),
            p.tag,
            p.practice,
            ciphertext
        );
    }

    // -----------------------------------------------------------------------
    // Buyers: buy
    // -----------------------------------------------------------------------

    /// @notice Hit a listing at its ask. The key arrives in a separate seller tx.
    function purchase(uint64 claimId) external payable {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Listed) revert BadState();
        if (msg.sender == c.seller) revert SelfDeal();
        if (encPubKeys[msg.sender].length == 0) revert NoPubKey();
        if (msg.value != uint256(c.askRevealFee) + uint256(c.askContingent)) revert BadValue();

        // The lock cliff: intel cannot be sold once lineups are locked.
        if (block.timestamp >= games[c.gameId].lockTime) revert LockPassed();

        Purchase storage p = purchases[claimId][msg.sender];
        if (p.state != PurchaseState.None) revert AlreadyPurchased();

        p.revealFee = c.askRevealFee;
        p.contingent = c.askContingent;
        p.state = PurchaseState.Paid;
        c.buyers += 1;

        emit ClaimPurchased(claimId, msg.sender, c.askRevealFee, c.askContingent);
    }

    /**
     * @notice Buyer paid but no key arrived before lock: full refund of fee + escrow.
     * @dev The bond is NOT burned here. Non-delivery is scored as a miss off-chain, and the
     *      claim itself still faces mandatory reveal and settlement like any other. Burning
     *      the bond on a single undelivered purchase would let any buyer torch a seller by
     *      purchasing one second before lock.
     */
    function refundUndelivered(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        Purchase storage p = purchases[claimId][msg.sender];
        if (p.state != PurchaseState.Paid) revert BadState();
        if (block.timestamp < games[c.gameId].lockTime) revert LockNotReached();

        uint96 amount = p.revealFee + p.contingent;
        p.state = PurchaseState.Refunded;
        balances[msg.sender] += amount;

        emit PurchaseRefunded(claimId, msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Sellers: deliver, reveal
    // -----------------------------------------------------------------------

    /// @notice Deliver ECIES(buyerPubKey, K) to one buyer. Credits the reveal fee here.
    function deliverKey(uint64 claimId, address buyer, bytes calldata encKeyForBuyer) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (msg.sender != c.seller) revert NotSeller();
        if (block.timestamp >= games[c.gameId].lockTime) revert LockPassed();

        Purchase storage p = purchases[claimId][buyer];
        if (p.state != PurchaseState.Paid) revert BadState();
        p.state = PurchaseState.KeyDelivered;

        // Outcome-independent protocol fee, taken from the seller's proceeds on the sale.
        uint96 fee = uint96((uint256(p.revealFee) * protocolFeeBps) / 10_000);
        if (fee != 0) {
            balances[feeRecipient] += fee;
            emit ProtocolFeeAccrued(claimId, feeRecipient, fee);
        }
        balances[c.seller] += uint256(p.revealFee) - fee;

        emit KeyDelivered(claimId, buyer, encKeyForBuyer);
    }

    /**
     * @notice Mandatory reveal. Every listing is revealed after lock or forfeits its bond.
     * @dev Gated on `block.timestamp >= lockTime` so a reveal cannot leak the claim to
     *      non-buyers while it is still sellable.
     */
    function reveal(uint64 claimId, Outcome claimed, Bucket bucket, bytes calldata evidence, bytes32 salt)
        external
    {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (msg.sender != c.seller) revert NotSeller();
        if (c.state != ClaimState.Listed) revert BadState();
        if (evidence.length > 4096) revert EvidenceTooLarge();

        Game storage g = games[c.gameId];
        if (block.timestamp < g.lockTime) revert LockNotReached();

        // Past the slash deadline a claim is no longer revealable, only slashable.
        if (g.attestedAt != 0 && !g.voided) {
            if (block.timestamp > uint256(g.attestedAt) + challengeWindow + revealWindow) {
                revert RevealWindowOpen();
            }
        }

        bytes32 expected = keccak256(abi.encode(c.gameId, c.playerId, claimed, bucket, keccak256(evidence), salt));
        if (expected != c.commitHash) revert CommitMismatch();

        // The confidence schedule is enforced here, where the bucket finally becomes public.
        if (c.bond < bondFor(bucket)) revert BondTooLow();

        c.claimed = claimed;
        c.bucket = bucket;
        c.state = ClaimState.Revealed;

        emit ClaimRevealed(claimId, claimed, bucket, evidence);
    }

    // -----------------------------------------------------------------------
    // Attester
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

    /**
     * @notice Owner escape hatch, valid only inside the challenge window.
     * @dev A voided game is never final and cannot be re-attested. Its only exit is
     *      `forceUnwind`, which returns every bond and escrow with nobody scored.
     */
    function voidAttestation(bytes32 gameId) external onlyOwner {
        Game storage g = games[gameId];
        if (g.attestedAt == 0) revert NotAttested();
        if (g.voided) revert BadState();
        if (block.timestamp >= uint256(g.attestedAt) + challengeWindow) revert ChallengeWindowClosed();
        g.voided = true;
        emit AttestationVoided(gameId);
    }

    // -----------------------------------------------------------------------
    // Escape hatch — the operator is trusted for liveness, never for custody
    // -----------------------------------------------------------------------

    /**
     * @notice Permissionlessly abandon a game the operator never (validly) attested.
     *
     * Callable by anyone once `lockTime + unwindDelay` has passed with no live attestation.
     * It does not decide any outcome — it simply opens the door for every participant to
     * take their own money back.
     */
    function forceUnwind(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.lockTime == 0) revert NoGame();
        if (g.unwound) revert AlreadyUnwound();
        if (g.attestedAt != 0 && !g.voided) revert AlreadyAttested();
        if (block.timestamp <= uint256(g.lockTime) + unwindDelay) revert UnwindTooEarly();

        g.unwound = true;
        emit GameUnwound(gameId, msg.sender);
    }

    /**
     * @notice Return one listing's bond to its seller. Purchases are returned to their
     *         buyers through `resolvePurchase`.
     * @dev No ClaimSettled is emitted and no bond is burned: the outcome is unknown, so
     *      nobody is scored and nobody is punished. An unwound game is a non-event.
     */
    function unwindClaim(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (!games[c.gameId].unwound) revert NotUnwound();
        if (c.state != ClaimState.Listed && c.state != ClaimState.Revealed) revert BadState();

        c.state = ClaimState.Unwound;
        balances[c.seller] += c.bond;

        emit ClaimUnwound(claimId, c.seller, c.bond);
    }

    // -----------------------------------------------------------------------
    // Permissionless cranks
    // -----------------------------------------------------------------------

    /**
     * @notice Settle one revealed listing against the attested list.
     * @dev Decides correct/wrong once, moves the bond, and fixes `payoutBps` — the share of
     *      each buyer's escrow the seller has earned. Individual escrows then move through
     *      `resolvePurchase`, one per buyer, so a listing with many buyers settles in O(1).
     */
    function settle(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Revealed) revert BadState();

        Game storage g = games[c.gameId];
        if (!isFinal(c.gameId)) revert NotFinal();

        Outcome actual = inactive[c.gameId][c.playerId] ? Outcome.INACTIVE : Outcome.ACTIVE;
        bool correct = (c.claimed == actual);

        uint16 payoutBps;
        if (correct) {
            payoutBps = payoutBpsFor(c.committedAt, g.lockTime, c.priorTag, c.priorPractice, actual);
            c.state = ClaimState.SettledCorrect;
            balances[c.seller] += c.bond;
        } else {
            c.state = ClaimState.SettledWrong;
            balances[burnSink] += c.bond;
        }
        c.payoutBps = payoutBps;

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
            payoutBps
        );
    }

    /**
     * @notice Move one buyer's escrow after the listing reached a terminal state.
     *
     *   never delivered      → fee + contingent back to the buyer, whatever happened
     *   correct              → contingent × payoutBps to the seller, remainder to the buyer
     *   wrong/slashed/unwound → contingent back to the buyer
     */
    function resolvePurchase(uint64 claimId, address buyer) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (
            c.state != ClaimState.SettledCorrect && c.state != ClaimState.SettledWrong
                && c.state != ClaimState.Slashed && c.state != ClaimState.Unwound
        ) revert BadState();

        Purchase storage p = purchases[claimId][buyer];
        if (p.state != PurchaseState.Paid && p.state != PurchaseState.KeyDelivered) revert BadState();

        uint96 toSeller;
        uint96 toBuyer;
        if (p.state == PurchaseState.Paid) {
            // The fee was never credited (no delivery), so both legs return.
            toBuyer = p.revealFee + p.contingent;
        } else if (c.state == ClaimState.SettledCorrect) {
            toSeller = uint96((uint256(p.contingent) * c.payoutBps) / 10_000);
            toBuyer = p.contingent - toSeller;
        } else {
            toBuyer = p.contingent;
        }
        p.state = PurchaseState.Resolved;

        if (toSeller != 0) balances[c.seller] += toSeller;
        if (toBuyer != 0) balances[buyer] += toBuyer;

        emit PurchaseResolved(claimId, buyer, toSeller, toBuyer);
    }

    /// @notice Bond forfeit for any listing that never revealed. Makes misses unhideable.
    function slashUnrevealed(uint64 claimId) external {
        Claim storage c = claims[claimId];
        if (c.seller == address(0)) revert NoClaim();
        if (c.state != ClaimState.Listed) revert BadState();

        Game storage g = games[c.gameId];
        if (!isFinal(c.gameId)) revert NotFinal();
        if (block.timestamp <= uint256(g.attestedAt) + challengeWindow + revealWindow) {
            revert RevealWindowOpen();
        }

        c.state = ClaimState.Slashed;
        balances[burnSink] += c.bond;

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
    // Pricing (pure/view) — agents/src/lib/scoring.ts mirrors the prior table
    // -----------------------------------------------------------------------

    /**
     * P(ACTIVE) in basis points given the public designation and last practice status.
     * Illustrative seed constants, identical to the off-chain scorer's PRIOR_TABLE.
     */
    function priorActiveBps(ReportTag tag, Practice practice) public pure returns (uint16) {
        if (tag == ReportTag.NONE) {
            if (practice == Practice.FULL) return 9800;
            if (practice == Practice.LIMITED) return 9000;
            if (practice == Practice.DNP) return 7000;
            return 9500;
        }
        if (tag == ReportTag.PROBABLE) {
            if (practice == Practice.FULL) return 9500;
            if (practice == Practice.LIMITED) return 8500;
            if (practice == Practice.DNP) return 6500;
            return 8800;
        }
        if (tag == ReportTag.QUESTIONABLE) {
            if (practice == Practice.FULL) return 8500;
            if (practice == Practice.LIMITED) return 7000;
            if (practice == Practice.DNP) return 4500;
            return 7200;
        }
        if (tag == ReportTag.DOUBTFUL) {
            if (practice == Practice.FULL) return 1500;
            if (practice == Practice.LIMITED) return 800;
            if (practice == Practice.DNP) return 300;
            return 800;
        }
        // OUT
        if (practice == Practice.FULL) return 200;
        if (practice == Practice.LIMITED) return 200;
        if (practice == Practice.DNP) return 100;
        return 200;
    }

    /// w = 0.1 + 0.9 * min(1, leadTime / leadSaturation), in basis points.
    function leadWeightBps(uint64 committedAt, uint64 lockTime) public view returns (uint16) {
        uint256 lead = lockTime > committedAt ? lockTime - committedAt : 0;
        if (lead > leadSaturation) lead = leadSaturation;
        return uint16(1000 + (9000 * lead) / leadSaturation);
    }

    /**
     * How surprising the actual outcome was, given the public prior at commit time.
     * Full credit (10000) when the public gave the outcome a coin flip or worse; near zero
     * when the seller merely restated an obvious report.
     *
     *   surprise = min(1, 2 * (1 - P_public(actual)))
     */
    function surpriseBps(ReportTag tag, Practice practice, Outcome actual) public pure returns (uint16) {
        uint256 pActive = priorActiveBps(tag, practice);
        uint256 py = actual == Outcome.ACTIVE ? pActive : 10_000 - pActive;
        uint256 s = 2 * (10_000 - py);
        return uint16(s > 10_000 ? 10_000 : s);
    }

    /// The share of each escrow a correct seller earns: lead weight × surprise.
    function payoutBpsFor(uint64 committedAt, uint64 lockTime, ReportTag tag, Practice practice, Outcome actual)
        public
        view
        returns (uint16)
    {
        return uint16((uint256(leadWeightBps(committedAt, lockTime)) * surpriseBps(tag, practice, actual)) / 10_000);
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
