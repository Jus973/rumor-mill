// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title UmaAttester
 * @notice Holds the `attester` role on SealedAvailabilityMarket and sources the outcome
 *         from UMA's Optimistic Oracle V3 instead of from a trusted key.
 *
 * The market's own `attest` is a single privileged call. That was the honest weak point:
 * "wrong" was declared, not discovered. This contract replaces the declaration with a
 * BONDED ASSERTION that anyone can dispute:
 *
 *   1. A proposer asserts "these players were on the official inactive list", posting a bond.
 *   2. For `liveness`, anyone may dispute by posting a matching bond.
 *   3. Undisputed  → UMA calls back, and the attestation lands on the market.
 *      Disputed    → UMA's DVM votes; a losing asserter forfeits the bond and nothing lands.
 *
 * The market never learns UMA exists; it only sees its `attester` calling `attest`. Swapping
 * this for a multi-attester committee or a different oracle is a redeployment of THIS
 * contract, not of the market.
 *
 * Note the role split on the market side: this contract can attest outcomes and nothing
 * else. The scheduler — a separate address — sets the slate and the public priors. Scoring
 * reads both, so concentrating them in one key would let it move reputation two ways.
 */
interface IOptimisticOracleV3 {
    function assertTruth(
        bytes calldata claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        address currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);

    function settleAssertion(bytes32 assertionId) external;
    function getMinimumBond(address currency) external view returns (uint256);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISealedAvailabilityMarket {
    function attest(bytes32 gameId, bytes32 reportHash, bytes32[] calldata inactivePlayerIds) external;
}

contract UmaAttester {
    /// keccak-free constant: UMA's whitelisted identifier for free-form assertions.
    bytes32 public constant ASSERT_TRUTH = "ASSERT_TRUTH";

    IOptimisticOracleV3 public immutable oo;
    IERC20 public immutable bondToken;
    ISealedAvailabilityMarket public immutable market;
    uint64 public immutable liveness;
    uint256 public immutable bond;

    struct Pending {
        bytes32 gameId;
        bytes32 reportHash;
        address proposer;
        bool resolved;
        bytes32[] inactivePlayerIds;
    }

    /// assertionId => the attestation it would produce
    mapping(bytes32 => Pending) private _pending;
    /// gameId => assertionId, so a game cannot be asserted twice concurrently
    mapping(bytes32 => bytes32) public assertionForGame;

    event InactiveListAsserted(
        bytes32 indexed gameId,
        bytes32 indexed assertionId,
        address indexed proposer,
        bytes32 reportHash,
        bytes claim
    );
    event AttestationLanded(bytes32 indexed gameId, bytes32 indexed assertionId);
    event AssertionRejected(bytes32 indexed gameId, bytes32 indexed assertionId);
    event AssertionDisputed(bytes32 indexed gameId, bytes32 indexed assertionId);

    error NotOracle();
    error AlreadyAsserted();
    error UnknownAssertion();
    error BondTransferFailed();

    constructor(
        IOptimisticOracleV3 _oo,
        IERC20 _bondToken,
        ISealedAvailabilityMarket _market,
        uint64 _liveness,
        uint256 _bond
    ) {
        oo = _oo;
        bondToken = _bondToken;
        market = _market;
        liveness = _liveness;
        bond = _bond;
    }

    /**
     * @notice Assert the official inactive list for a game. Permissionless — anyone willing
     *         to post the bond may propose, which is the point: the market no longer depends
     *         on one privileged key being honest.
     * @param claim Human-readable statement UMA voters would adjudicate, e.g.
     *        "As of 2026-09-11, the official NFL inactive list for SF vs SEA (week 1)
     *         contained exactly: Christian McCaffrey (GSIS 00-0033280). Source: nfl.com/inactives".
     */
    function assertInactiveList(
        bytes32 gameId,
        bytes32 reportHash,
        bytes32[] calldata inactivePlayerIds,
        bytes calldata claim
    ) external returns (bytes32 assertionId) {
        if (assertionForGame[gameId] != bytes32(0)) revert AlreadyAsserted();

        // Pull the proposer's bond, then let the oracle pull it from us.
        if (!bondToken.transferFrom(msg.sender, address(this), bond)) revert BondTransferFailed();
        bondToken.approve(address(oo), bond);

        assertionId = oo.assertTruth(
            claim,
            msg.sender, // asserter — the bond and any reward are theirs
            address(this), // callbackRecipient
            address(0), // no escalation manager
            liveness,
            address(bondToken),
            bond,
            ASSERT_TRUTH,
            bytes32(0)
        );

        Pending storage p = _pending[assertionId];
        p.gameId = gameId;
        p.reportHash = reportHash;
        p.proposer = msg.sender;
        p.inactivePlayerIds = inactivePlayerIds;
        assertionForGame[gameId] = assertionId;

        emit InactiveListAsserted(gameId, assertionId, msg.sender, reportHash, claim);
    }

    /// @notice Anyone can crank settlement once liveness expires; UMA calls back into us.
    function settle(bytes32 assertionId) external {
        oo.settleAssertion(assertionId);
    }

    /**
     * @notice UMA callback. Only an assertion that survived its challenge window (or won a
     *         dispute vote) reaches the market.
     */
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external {
        if (msg.sender != address(oo)) revert NotOracle();
        Pending storage p = _pending[assertionId];
        if (p.gameId == bytes32(0)) revert UnknownAssertion();
        if (p.resolved) return;
        p.resolved = true;

        if (assertedTruthfully) {
            market.attest(p.gameId, p.reportHash, p.inactivePlayerIds);
            emit AttestationLanded(p.gameId, assertionId);
        } else {
            // Rejected: clear the slot so a corrected list can be asserted.
            assertionForGame[p.gameId] = bytes32(0);
            emit AssertionRejected(p.gameId, assertionId);
        }
    }

    /// @notice UMA callback on dispute. Nothing lands until the DVM votes.
    function assertionDisputedCallback(bytes32 assertionId) external {
        if (msg.sender != address(oo)) revert NotOracle();
        emit AssertionDisputed(_pending[assertionId].gameId, assertionId);
    }

    function pendingFor(bytes32 assertionId)
        external
        view
        returns (bytes32 gameId, bytes32 reportHash, address proposer, bool resolved, bytes32[] memory inactive)
    {
        Pending storage p = _pending[assertionId];
        return (p.gameId, p.reportHash, p.proposer, p.resolved, p.inactivePlayerIds);
    }
}
