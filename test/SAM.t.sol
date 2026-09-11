// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SealedAvailabilityMarket as SAM} from "../src/SealedAvailabilityMarket.sol";

contract SAMTest is Test {
    SAM market;

    address scheduler = makeAddr("scheduler");
    address attester = makeAddr("attester");
    address operator = makeAddr("operator");
    address owner = makeAddr("owner");
    address burnSink = address(0xdEaD);
    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");

    uint16 constant FEE_BPS = 250; // 2.5%
    uint96 constant BASE_BOND = 0.0005 ether;
    uint64 constant CHALLENGE = 60;
    uint64 constant REVEAL_W = 240;

    bytes32 constant GAME = keccak256("NFL2026W1SFSEA");
    bytes32 constant PLAYER = keccak256("NFLSFcmc");

    uint96 constant FEE = 0.001 ether;
    uint96 constant CONTINGENT = 0.004 ether;

    uint64 lockTime;

    // A valid compressed secp256k1 pubkey (0x02 prefix + 32 bytes).
    bytes constant PUBKEY = hex"02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    function setUp() public {
        vm.warp(1_000_000);
        market = new SAM(scheduler, attester, owner, burnSink, operator, FEE_BPS, BASE_BOND, CHALLENGE, REVEAL_W);

        lockTime = uint64(block.timestamp + 1 days);
        vm.prank(scheduler);
        market.createGame(GAME, lockTime);
        vm.prank(scheduler);
        market.setPrior(GAME, PLAYER, SAM.ReportTag.QUESTIONABLE, SAM.Practice.LIMITED);

        vm.deal(buyer, 10 ether);
        vm.deal(seller, 10 ether);

        vm.prank(buyer);
        market.registerEncPubKey(PUBKEY);
    }

    // ---------------------------------------------------------------- helpers

    function _commit(uint64 bountyId, SAM.Outcome claimed, SAM.Bucket bucket, bytes memory evidence, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(bountyId, claimed, bucket, keccak256(evidence), salt));
    }

    function _postBounty() internal returns (uint64) {
        vm.prank(buyer);
        return market.postBounty(GAME, PLAYER, FEE, CONTINGENT);
    }

    function _fill(uint64 bountyId, bytes32 commitHash, uint96 bond) internal returns (uint64) {
        vm.prank(seller);
        return market.fillBounty{value: bond}(bountyId, commitHash, hex"deadbeef");
    }

    function _purchase(uint64 claimId) internal {
        vm.prank(buyer);
        market.purchase{value: uint256(FEE) + CONTINGENT}(claimId);
    }

    function _deliver(uint64 claimId) internal {
        vm.prank(seller);
        market.deliverKey(claimId, hex"c0ffee");
    }

    function _attestInactive(bool isInactive) internal {
        bytes32[] memory ids;
        if (isInactive) {
            ids = new bytes32[](1);
            ids[0] = PLAYER;
        } else {
            ids = new bytes32[](0);
        }
        vm.prank(attester);
        market.attest(GAME, keccak256("snapshot"), ids);
    }

    function _state(uint64 claimId) internal view returns (SAM.ClaimState) {
        (,,,,,,,,,,, SAM.ClaimState st) = market.claims(claimId);
        return st;
    }

    // ---------------------------------------------------------------- §7 tests

    /// fill -> purchase -> deliverKey -> lock -> attest -> challenge -> reveal -> settle
    function test_HappyPath() public {
        bytes memory evidence = "cmc ran routes at full speed";
        bytes32 salt = keccak256("salt1");
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B83, evidence, salt);

        uint96 bond = market.bondFor(SAM.Bucket.B83);
        uint64 c = _fill(b, ch, bond);

        _purchase(c);
        _deliver(c);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.KeyDelivered));
        // revealFee is credited at key delivery, not at purchase.
        uint96 protocolFee = uint96((uint256(FEE) * FEE_BPS) / 10_000);
        assertEq(market.balances(seller), FEE - protocolFee, "seller nets reveal fee minus protocol fee");
        assertEq(market.balances(operator), protocolFee, "operator accrues the fee");

        vm.warp(lockTime);
        _attestInactive(false); // player is ACTIVE -> claim is correct

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B83, evidence, salt);

        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
        assertEq(market.balances(seller), uint256(FEE) - protocolFee + bond + CONTINGENT);
        assertEq(market.balances(buyer), 0);

        uint256 before = seller.balance;
        vm.prank(seller);
        market.withdraw();
        assertEq(seller.balance, before + FEE - protocolFee + bond + CONTINGENT);
    }

    function test_WrongClaim() public {
        bytes memory evidence = "ruled out";
        bytes32 salt = keccak256("salt2");
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        uint96 bond = market.bondFor(SAM.Bucket.B83);
        uint64 c = _fill(b, ch, bond);

        _purchase(c);
        _deliver(c);

        vm.warp(lockTime);
        _attestInactive(false); // actually ACTIVE -> claim was wrong

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledWrong));
        assertEq(market.balances(burnSink), bond, "bond burned");
        assertEq(market.balances(buyer), CONTINGENT, "escrow returned to buyer");
        assertEq(market.balances(seller), FEE - uint96((uint256(FEE) * FEE_BPS) / 10_000), "seller keeps only the reveal fee, net of protocol fee");
    }

    /// Mandatory reveal: a claim nobody bought still settles and still scores.
    function test_UnsoldClaimStillScored() public {
        bytes memory evidence = "no buyer";
        bytes32 salt = keccak256("salt3");
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        uint96 bond = market.bondFor(SAM.Bucket.B55);
        uint64 c = _fill(b, ch, bond);

        vm.warp(lockTime);
        _attestInactive(false);

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);

        vm.recordLogs();
        market.settle(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256(
                "ClaimSettled(uint64,address,bool,uint8,uint8,uint8,uint8,uint64,uint64,uint96,uint96)"
            )) {
                found = true;
                (,,,,,,,, uint96 escrowReleased) = abi.decode(
                    logs[i].data, (bool, uint8, uint8, uint8, uint8, uint64, uint64, uint96, uint96)
                );
                assertEq(escrowReleased, 0, "unsold claim releases no escrow");
            }
        }
        assertTrue(found, "ClaimSettled emitted for unsold claim");
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
        // Only the bond comes back — there was never any escrow.
        assertEq(market.balances(seller), bond);
    }

    function test_UnrevealedSlashed() public {
        bytes memory evidence = "never revealed";
        bytes32 salt = keccak256("salt4");
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        uint96 bond = market.bondFor(SAM.Bucket.B55);
        uint64 c = _fill(b, ch, bond);
        _purchase(c);
        _deliver(c);

        vm.warp(lockTime);
        _attestInactive(false);

        // Too early on two distinct grounds, checked at their respective boundaries.
        // (a) challenge window still open -> the game is not final yet
        vm.expectRevert(SAM.NotFinal.selector);
        market.slashUnrevealed(c);

        // (b) game final, but the seller still has the whole reveal window left
        vm.warp(block.timestamp + CHALLENGE);
        assertTrue(market.isFinal(GAME));
        vm.expectRevert(SAM.RevealWindowOpen.selector);
        market.slashUnrevealed(c);

        // the seller could still honour the mandatory reveal right up to the deadline
        vm.warp(block.timestamp + REVEAL_W);
        vm.expectRevert(SAM.RevealWindowOpen.selector);
        market.slashUnrevealed(c);

        vm.warp(block.timestamp + 1);
        market.slashUnrevealed(c);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Slashed));
        assertEq(market.balances(burnSink), bond);
        assertEq(market.balances(buyer), CONTINGENT);

        // reveal is dead afterwards
        vm.prank(seller);
        vm.expectRevert(SAM.BadState.selector);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
    }

    function test_UndeliveredRefund() public {
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint96 bond = market.bondFor(SAM.Bucket.B55);
        uint64 c = _fill(b, ch, bond);
        _purchase(c);
        // seller never delivers the key

        vm.warp(lockTime);
        market.refundUndelivered(c);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.RefundedUndelivered));
        assertEq(market.balances(buyer), uint256(FEE) + CONTINGENT, "fee + escrow refunded");
        assertEq(market.balances(burnSink), bond, "bond burned");
        assertEq(market.balances(seller), 0, "seller earns nothing");
    }

    /// Bond must clear the confidence schedule at reveal, or the claim cannot be revealed.
    function test_UnderBondedReveal() public {
        bytes memory evidence = "high confidence, low bond";
        bytes32 salt = keccak256("salt5");
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B95, evidence, salt);

        uint64 c = _fill(b, ch, BASE_BOND); // 1x, but B95 needs 8x

        vm.warp(lockTime);
        _attestInactive(false);

        vm.prank(seller);
        vm.expectRevert(SAM.BondTooLow.selector);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B95, evidence, salt);

        // ... and it is therefore slashable.
        vm.warp(block.timestamp + CHALLENGE + REVEAL_W + 1);
        market.slashUnrevealed(c);
        assertEq(market.balances(burnSink), BASE_BOND);
    }

    function test_LockCliff() public {
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint64 c = _fill(b, ch, BASE_BOND);

        // reveal is not allowed before lock (would leak to non-buyers while still sellable)
        vm.prank(seller);
        vm.expectRevert(SAM.LockNotReached.selector);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));

        vm.warp(lockTime); // exactly at lock

        vm.prank(buyer);
        vm.expectRevert(SAM.LockPassed.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);

        vm.prank(seller);
        vm.expectRevert(SAM.LockPassed.selector);
        market.fillBounty{value: BASE_BOND}(b, ch, hex"aa");

        vm.prank(buyer);
        vm.expectRevert(SAM.LockPassed.selector);
        market.postBounty(GAME, PLAYER, FEE, CONTINGENT);
    }

    function test_AttestOrdering() public {
        // attest before lock reverts
        vm.prank(attester);
        vm.expectRevert(SAM.LockNotReached.selector);
        market.attest(GAME, keccak256("s"), new bytes32[](0));

        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint64 c = _fill(b, ch, BASE_BOND);

        vm.warp(lockTime);
        _attestInactive(false);

        // second attest reverts
        vm.prank(attester);
        vm.expectRevert(SAM.AlreadyAttested.selector);
        market.attest(GAME, keccak256("s2"), new bytes32[](0));

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));

        // settle before the challenge window closes reverts
        vm.expectRevert(SAM.NotFinal.selector);
        market.settle(c);

        // non-resolver cannot attest
        vm.expectRevert(SAM.NotAttester.selector);
        market.attest(GAME, keccak256("s3"), new bytes32[](0));

        vm.warp(block.timestamp + CHALLENGE);
        // voidAttestation after the window reverts
        vm.prank(owner);
        vm.expectRevert(SAM.ChallengeWindowClosed.selector);
        market.voidAttestation(GAME);

        market.settle(c);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
    }

    /// Any single altered field breaks the commitment.
    function testFuzz_CommitBinding(
        uint8 claimedRaw,
        uint8 bucketRaw,
        bytes memory evidence,
        bytes32 salt,
        uint8 mutateField
    ) public {
        vm.assume(evidence.length <= 4096);
        SAM.Outcome claimed = SAM.Outcome(uint8(bound(claimedRaw, 1, 2)));
        SAM.Bucket bucket = SAM.Bucket(uint8(bound(bucketRaw, 0, 3)));
        mutateField = uint8(bound(mutateField, 0, 3));

        uint64 b = _postBounty();
        bytes32 ch = _commit(b, claimed, bucket, evidence, salt);
        uint64 c = _fill(b, ch, market.bondFor(SAM.Bucket.B95)); // over-bond so only the hash can fail

        vm.warp(lockTime);

        SAM.Outcome wrongClaimed = claimed;
        SAM.Bucket wrongBucket = bucket;
        bytes memory wrongEvidence = evidence;
        bytes32 wrongSalt = salt;

        if (mutateField == 0) {
            wrongClaimed = claimed == SAM.Outcome.ACTIVE ? SAM.Outcome.INACTIVE : SAM.Outcome.ACTIVE;
        } else if (mutateField == 1) {
            wrongBucket = SAM.Bucket(uint8((uint8(bucket) + 1) % 4));
        } else if (mutateField == 2) {
            wrongEvidence = bytes.concat(evidence, hex"00");
        } else {
            wrongSalt = keccak256(abi.encode(salt));
        }

        vm.prank(seller);
        vm.expectRevert(SAM.CommitMismatch.selector);
        market.reveal(c, wrongClaimed, wrongBucket, wrongEvidence, wrongSalt);

        // the honest reveal still works
        vm.prank(seller);
        market.reveal(c, claimed, bucket, evidence, salt);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Revealed));
    }

    function test_PullPaymentsReentrancy() public {
        Reenterer bad = new Reenterer(market);
        vm.deal(address(bad), 1 ether);

        uint64 b = _postBounty();
        bytes memory evidence = "x";
        bytes32 salt = keccak256("s");
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);

        uint64 c = bad.fill{value: BASE_BOND}(b, ch);
        vm.warp(lockTime);
        _attestInactive(false);
        bad.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);

        assertEq(market.balances(address(bad)), BASE_BOND);
        vm.expectRevert(); // re-entrant withdraw bubbles up
        bad.withdraw();
        // balance is untouched because the whole tx reverted
        assertEq(market.balances(address(bad)), BASE_BOND);
    }

    // ------------------------------------------------------- extra guardrails

    function test_PurchaseRequiresRegisteredPubKey() public {
        address freshBuyer = makeAddr("freshBuyer");
        vm.deal(freshBuyer, 1 ether);
        vm.prank(freshBuyer);
        uint64 b = market.postBounty(GAME, PLAYER, FEE, CONTINGENT);

        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint64 c = _fill(b, ch, BASE_BOND);

        vm.prank(freshBuyer);
        vm.expectRevert(SAM.NoPubKey.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);
    }

    function test_OnlyBountyBuyerCanPurchase() public {
        uint64 b = _postBounty();
        bytes32 ch = _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint64 c = _fill(b, ch, BASE_BOND);

        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(SAM.NotBuyer.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);
    }

    /**
     * Cross-implementation vector: this exact tuple is hashed by agents/src/lib/crypto.ts
     * (see its test suite). If the TS ABI encoding and the Solidity one ever drift, sellers
     * would commit hashes they can never reveal against — so pin it here.
     */
    function test_CommitHashMatchesTypeScriptVector() public {
        bytes memory evidence =
            hex"5b7b22736f75726365223a226c6f63616c2d62656174222c2274657874223a22434d4320616273656e742c207365636f6e6420737472616967687420646179222c227473223a313735373030303030307d5d";
        bytes32 salt = 0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff;
        bytes32 expected = 0x4dbf492e0779203775b9439a1eda79be11ec7573d551dda902b300d106a612c5;

        assertEq(
            keccak256(abi.encode(uint64(7), SAM.Outcome.INACTIVE, SAM.Bucket.B83, keccak256(evidence), salt)),
            expected,
            "TS and Solidity commit hashes diverged"
        );

        // And it is accepted by a real reveal. The vector fixes bountyId = 7, so advance
        // the counter to it (ids are sequential from 1).
        uint64 b;
        for (uint256 i; i < 7; ++i) {
            vm.prank(buyer);
            b = market.postBounty(GAME, PLAYER, FEE, CONTINGENT);
        }
        assertEq(b, 7, "vector assumes bountyId 7");
        uint64 c = _fill(b, expected, market.bondFor(SAM.Bucket.B83));
        vm.warp(lockTime);
        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Revealed));
    }

    /**
     * The operator is also the attester, so their revenue must not depend on which way
     * claims resolve. This pins that: identical fee whether the claim settles correct or
     * wrong, and the operator never receives any part of a burned bond.
     */
    function test_ProtocolFeeIsOutcomeIndependent() public {
        uint96 expectedFee = uint96((uint256(FEE) * FEE_BPS) / 10_000);

        // --- claim that settles CORRECT ---
        uint64 b1 = _postBounty();
        bytes32 s1 = keccak256("ok");
        uint64 c1 = _fill(b1, _commit(b1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", s1), BASE_BOND);
        _purchase(c1);
        _deliver(c1);
        uint256 feeAfterCorrectDelivery = market.balances(operator);

        // --- claim that settles WRONG ---
        uint64 b2 = _postBounty();
        bytes32 s2 = keccak256("bad");
        uint64 c2 = _fill(b2, _commit(b2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e", s2), BASE_BOND);
        _purchase(c2);
        _deliver(c2);

        assertEq(feeAfterCorrectDelivery, expectedFee, "fee accrues once per delivered key");
        assertEq(market.balances(operator), expectedFee * 2, "same fee regardless of eventual outcome");

        vm.warp(lockTime);
        _attestInactive(false); // c1 correct, c2 wrong

        vm.prank(seller);
        market.reveal(c1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", s1);
        vm.prank(seller);
        market.reveal(c2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e", s2);
        vm.warp(block.timestamp + CHALLENGE);

        uint256 feeBeforeSettlement = market.balances(operator);
        market.settle(c1);
        market.settle(c2);

        // Settlement must move nothing to the operator — not from escrow, not from bonds.
        assertEq(market.balances(operator), feeBeforeSettlement, "settlement pays the operator nothing");
        assertEq(market.balances(burnSink), BASE_BOND, "burned bond goes to the sink, not the operator");
    }

    /// A claim whose key is never delivered generates no fee — the operator is paid for a
    /// completed sale, not for a posted bounty.
    function test_NoFeeWithoutDelivery() public {
        uint64 b = _postBounty();
        uint64 c = _fill(b, _commit(b, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);
        _purchase(c);
        vm.warp(lockTime);
        market.refundUndelivered(c);
        assertEq(market.balances(operator), 0, "no delivery, no fee");
        assertEq(market.balances(buyer), uint256(FEE) + CONTINGENT, "buyer fully refunded incl. the fee");
    }

    function test_ContractSolvency() public {
        // Two claims: one settles correct (sold), one settles wrong (sold).
        uint64 b1 = _postBounty();
        uint64 b2 = _postBounty();
        bytes32 s1 = keccak256("a");
        bytes32 s2 = keccak256("b");
        bytes32 ch1 = _commit(b1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e1", s1);
        bytes32 ch2 = _commit(b2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e2", s2);

        uint64 c1 = _fill(b1, ch1, BASE_BOND);
        uint64 c2 = _fill(b2, ch2, BASE_BOND);
        _purchase(c1);
        _deliver(c1);
        _purchase(c2);
        _deliver(c2);

        vm.warp(lockTime);
        _attestInactive(false);
        vm.prank(seller);
        market.reveal(c1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e1", s1);
        vm.prank(seller);
        market.reveal(c2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e2", s2);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c1);
        market.settle(c2);

        uint256 owed = market.balances(seller) + market.balances(buyer) + market.balances(burnSink)
            + market.balances(operator);
        assertEq(address(market).balance, owed, "credited balances exactly match held ETH");
    }
}

/// Malicious seller that tries to re-enter withdraw().
contract Reenterer {
    SAM public market;
    bool private entered;

    constructor(SAM _m) {
        market = _m;
    }

    function fill(uint64 bountyId, bytes32 commitHash) external payable returns (uint64) {
        return market.fillBounty{value: msg.value}(bountyId, commitHash, hex"aa");
    }

    function reveal(uint64 claimId, SAM.Outcome o, SAM.Bucket b, bytes calldata e, bytes32 s) external {
        market.reveal(claimId, o, b, e, s);
    }

    function withdraw() external {
        market.withdraw();
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            market.withdraw(); // should revert the whole tx
        }
    }
}
