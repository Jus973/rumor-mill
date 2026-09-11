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
    address buyer2 = makeAddr("buyer2");
    address seller = makeAddr("seller");

    uint16 constant FEE_BPS = 250; // 2.5%
    uint96 constant BASE_BOND = 0.0005 ether;
    uint64 constant CHALLENGE = 60;
    uint64 constant REVEAL_W = 240;
    uint64 constant UNWIND = 3 days;
    uint64 constant LEAD_SAT = 96 hours;

    bytes32 constant GAME = keccak256("NFL2026W1SFSEA");
    bytes32 constant PLAYER = keccak256("NFLSFcmc");

    uint96 constant FEE = 0.001 ether;
    uint96 constant CONTINGENT = 0.004 ether;

    uint64 lockTime;

    // A valid compressed secp256k1 pubkey (0x02 prefix + 32 bytes).
    bytes constant PUBKEY = hex"02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    function setUp() public {
        vm.warp(1_000_000);
        market = new SAM(
            scheduler, attester, owner, burnSink, operator, FEE_BPS, BASE_BOND, CHALLENGE, REVEAL_W, UNWIND, LEAD_SAT
        );

        lockTime = uint64(block.timestamp + 1 days);
        vm.prank(scheduler);
        market.createGame(GAME, lockTime);
        // QUESTIONABLE/LIMITED: P(ACTIVE) = 0.70 in the seed table.
        vm.prank(scheduler);
        market.setPrior(GAME, PLAYER, SAM.ReportTag.QUESTIONABLE, SAM.Practice.LIMITED);

        vm.deal(buyer, 10 ether);
        vm.deal(buyer2, 10 ether);
        vm.deal(seller, 10 ether);

        vm.prank(buyer);
        market.registerEncPubKey(PUBKEY);
        vm.prank(buyer2);
        market.registerEncPubKey(PUBKEY);
    }

    // ---------------------------------------------------------------- helpers

    function _commit(SAM.Outcome claimed, SAM.Bucket bucket, bytes memory evidence, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(GAME, PLAYER, claimed, bucket, keccak256(evidence), salt));
    }

    function _list(bytes32 commitHash, uint96 bond) internal returns (uint64) {
        vm.prank(seller);
        return market.listClaim{value: bond}(GAME, PLAYER, commitHash, hex"deadbeef", FEE, CONTINGENT);
    }

    function _purchase(address who, uint64 claimId) internal {
        vm.prank(who);
        market.purchase{value: uint256(FEE) + CONTINGENT}(claimId);
    }

    function _deliver(uint64 claimId, address to) internal {
        vm.prank(seller);
        market.deliverKey(claimId, to, hex"c0ffee");
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
        (,,,,,,,,,,,,,,, SAM.ClaimState st) = market.claims(claimId);
        return st;
    }

    function _payout(uint64 claimId) internal view returns (uint16) {
        (,,,,,,,,,, uint16 p,,,,,) = market.claims(claimId);
        return p;
    }

    function _pstate(uint64 claimId, address who) internal view returns (SAM.PurchaseState) {
        (,, SAM.PurchaseState st) = market.purchases(claimId, who);
        return st;
    }

    function _netFee() internal pure returns (uint256) {
        return uint256(FEE) - (uint256(FEE) * FEE_BPS) / 10_000;
    }

    /// Full lead time, contrarian and right on a 0.70 prior -> surprise saturates at 1.0.
    function _fullPayout() internal pure returns (uint96) {
        return CONTINGENT; // 10000 bps
    }

    // ---------------------------------------------------------------- lifecycle

    /// list -> purchase -> deliverKey -> lock -> attest -> challenge -> reveal -> settle -> resolve
    function test_HappyPath() public {
        bytes memory evidence = "team source: will not travel";
        bytes32 salt = keccak256("salt1");
        bytes32 ch = _commit(SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);

        uint96 bond = market.bondFor(SAM.Bucket.B83);
        uint64 c = _list(ch, bond);

        _purchase(buyer, c);
        _deliver(c, buyer);
        assertEq(uint8(_pstate(c, buyer)), uint8(SAM.PurchaseState.KeyDelivered));
        // revealFee is credited at key delivery, not at purchase.
        assertEq(market.balances(seller), _netFee(), "seller nets reveal fee minus protocol fee");
        assertEq(market.balances(operator), FEE - _netFee(), "operator accrues the fee");

        vm.warp(lockTime);
        _attestInactive(true); // contrarian call was right

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);

        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
        // Committed 24h before lock with a 96h saturation: w = 0.1 + 0.9 * 0.25 = 0.325.
        // Prior gave INACTIVE 0.30, so surprise = min(1, 2*0.7) = 1.0. payout = 3250 bps.
        assertEq(_payout(c), 3250, "payout = lead weight x surprise");

        market.resolvePurchase(c, buyer);
        uint256 toSeller = (uint256(CONTINGENT) * 3250) / 10_000;
        assertEq(market.balances(seller), _netFee() + bond + toSeller, "fee + bond + earned share of escrow");
        assertEq(market.balances(buyer), CONTINGENT - toSeller, "buyer keeps the unearned remainder");

        uint256 before = seller.balance;
        vm.prank(seller);
        market.withdraw();
        assertEq(seller.balance, before + _netFee() + bond + toSeller);
    }

    function test_WrongClaim() public {
        bytes memory evidence = "ruled out";
        bytes32 salt = keccak256("salt2");
        bytes32 ch = _commit(SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        uint96 bond = market.bondFor(SAM.Bucket.B83);
        uint64 c = _list(ch, bond);

        _purchase(buyer, c);
        _deliver(c, buyer);

        vm.warp(lockTime);
        _attestInactive(false); // actually ACTIVE -> claim was wrong

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);
        market.resolvePurchase(c, buyer);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledWrong));
        assertEq(_payout(c), 0);
        assertEq(market.balances(burnSink), bond, "bond burned");
        assertEq(market.balances(buyer), CONTINGENT, "escrow returned to buyer");
        assertEq(market.balances(seller), _netFee(), "seller keeps only the reveal fee");
    }

    /// Mandatory reveal: a listing nobody bought still settles and still scores.
    function test_UnsoldClaimStillScored() public {
        bytes memory evidence = "no buyer";
        bytes32 salt = keccak256("salt3");
        bytes32 ch = _commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        uint64 c = _list(ch, BASE_BOND);

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
                "ClaimSettled(uint64,address,bool,uint8,uint8,uint8,uint8,uint64,uint64,uint96,uint16)"
            )) {
                found = true;
                (bool correct,,,,,,,, uint16 payoutBps) = abi.decode(
                    logs[i].data, (bool, uint8, uint8, uint8, uint8, uint64, uint64, uint96, uint16)
                );
                assertTrue(correct);
                // Agreeing with a 0.70 prior: surprise = 2 * 0.3 = 0.6; w = 0.325 -> 1950.
                assertEq(payoutBps, 1950, "restating the report earns a fraction");
            }
        }
        assertTrue(found, "ClaimSettled emitted for unsold claim");
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
        // Only the bond comes back — there was never any escrow.
        assertEq(market.balances(seller), BASE_BOND);
    }

    function test_UnrevealedSlashed() public {
        bytes memory evidence = "never revealed";
        bytes32 salt = keccak256("salt4");
        bytes32 ch = _commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        uint64 c = _list(ch, BASE_BOND);
        _purchase(buyer, c);
        _deliver(c, buyer);

        vm.warp(lockTime);
        _attestInactive(false);

        // (a) challenge window still open -> the game is not final yet
        vm.expectRevert(SAM.NotFinal.selector);
        market.slashUnrevealed(c);

        // (b) game final, but the seller still has the whole reveal window left
        vm.warp(block.timestamp + CHALLENGE);
        assertTrue(market.isFinal(GAME));
        vm.expectRevert(SAM.RevealWindowOpen.selector);
        market.slashUnrevealed(c);

        vm.warp(block.timestamp + REVEAL_W);
        vm.expectRevert(SAM.RevealWindowOpen.selector);
        market.slashUnrevealed(c);

        vm.warp(block.timestamp + 1);
        market.slashUnrevealed(c);
        market.resolvePurchase(c, buyer);

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Slashed));
        assertEq(market.balances(burnSink), BASE_BOND);
        assertEq(market.balances(buyer), CONTINGENT, "escrow returned on slash");

        // reveal is dead afterwards
        vm.prank(seller);
        vm.expectRevert(SAM.BadState.selector);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
    }

    /// Buyer paid, no key: full refund, and the bond is NOT burned (anti-griefing).
    function test_UndeliveredRefund() public {
        bytes memory evidence = "x";
        bytes32 salt = keccak256("s");
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt), BASE_BOND);
        _purchase(buyer, c);
        // seller never delivers the key

        vm.prank(buyer);
        vm.expectRevert(SAM.LockNotReached.selector);
        market.refundUndelivered(c);

        vm.warp(lockTime);
        vm.prank(buyer);
        market.refundUndelivered(c);

        assertEq(uint8(_pstate(c, buyer)), uint8(SAM.PurchaseState.Refunded));
        assertEq(market.balances(buyer), uint256(FEE) + CONTINGENT, "fee + escrow refunded");
        assertEq(market.balances(burnSink), 0, "bond is not burned by a refund");
        assertEq(market.balances(seller), 0, "seller earns nothing");

        // The listing itself is untouched: it still faces mandatory reveal and settles.
        _attestInactive(false);
        vm.prank(seller);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.SettledCorrect));
        assertEq(market.balances(seller), BASE_BOND, "bond returned on a correct settle");

        // A refunded purchase cannot be resolved a second time.
        vm.expectRevert(SAM.BadState.selector);
        market.resolvePurchase(c, buyer);
    }

    /// An undelivered purchase the buyer never refunded still returns both legs at resolve.
    function test_UndeliveredResolvesAtSettlement() public {
        bytes memory evidence = "x";
        bytes32 salt = keccak256("s");
        uint64 c = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, salt), BASE_BOND);
        _purchase(buyer, c);

        vm.warp(lockTime);
        _attestInactive(true); // seller was right...
        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);
        market.resolvePurchase(c, buyer);

        // ...but never delivered, so it earns nothing from this buyer.
        assertEq(market.balances(buyer), uint256(FEE) + CONTINGENT);
        assertEq(market.balances(seller), BASE_BOND);
        assertEq(market.balances(operator), 0, "no delivery, no fee");
    }

    /// Bond must clear the confidence schedule at reveal, or the claim cannot be revealed.
    function test_UnderBondedReveal() public {
        bytes memory evidence = "high confidence, low bond";
        bytes32 salt = keccak256("salt5");
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B95, evidence, salt), BASE_BOND); // B95 needs 8x

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
        bytes32 ch = _commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));
        uint64 c = _list(ch, BASE_BOND);
        _purchase(buyer, c);

        // reveal is not allowed before lock (would leak to non-buyers while still sellable)
        vm.prank(seller);
        vm.expectRevert(SAM.LockNotReached.selector);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));

        vm.warp(lockTime); // exactly at lock

        vm.prank(buyer2);
        vm.expectRevert(SAM.LockPassed.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);

        vm.prank(seller);
        vm.expectRevert(SAM.LockPassed.selector);
        market.listClaim{value: BASE_BOND}(GAME, PLAYER, ch, hex"aa", FEE, CONTINGENT);

        vm.prank(seller);
        vm.expectRevert(SAM.LockPassed.selector);
        market.deliverKey(c, buyer, hex"c0ffee");

        vm.prank(buyer);
        vm.expectRevert(SAM.LockPassed.selector);
        market.postBounty(GAME, PLAYER, FEE, CONTINGENT);
    }

    function test_AttestOrdering() public {
        // attest before lock reverts
        vm.prank(attester);
        vm.expectRevert(SAM.LockNotReached.selector);
        market.attest(GAME, keccak256("s"), new bytes32[](0));

        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);

        vm.warp(lockTime);
        _attestInactive(false);

        vm.prank(attester);
        vm.expectRevert(SAM.AlreadyAttested.selector);
        market.attest(GAME, keccak256("s2"), new bytes32[](0));

        vm.prank(seller);
        market.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s"));

        vm.expectRevert(SAM.NotFinal.selector);
        market.settle(c);

        vm.expectRevert(SAM.NotAttester.selector);
        market.attest(GAME, keccak256("s3"), new bytes32[](0));

        vm.warp(block.timestamp + CHALLENGE);
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

        uint64 c = _list(_commit(claimed, bucket, evidence, salt), market.bondFor(SAM.Bucket.B95));

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

        vm.prank(seller);
        market.reveal(c, claimed, bucket, evidence, salt);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Revealed));
    }

    function test_PullPaymentsReentrancy() public {
        Reenterer bad = new Reenterer(market);
        vm.deal(address(bad), 1 ether);

        bytes memory evidence = "x";
        bytes32 salt = keccak256("s");
        bytes32 ch = _commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);

        uint64 c = bad.list{value: BASE_BOND}(GAME, PLAYER, ch);
        vm.warp(lockTime);
        _attestInactive(false);
        bad.reveal(c, SAM.Outcome.ACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);

        assertEq(market.balances(address(bad)), BASE_BOND);
        vm.expectRevert();
        bad.withdraw();
        assertEq(market.balances(address(bad)), BASE_BOND);
    }

    // ---------------------------------------------------------------- the open market

    function test_PurchaseRequiresRegisteredPubKey() public {
        address freshBuyer = makeAddr("freshBuyer");
        vm.deal(freshBuyer, 1 ether);
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);

        vm.prank(freshBuyer);
        vm.expectRevert(SAM.NoPubKey.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);
    }

    /// A listing sells to many buyers, each with its own escrow and its own key.
    function test_ManyBuyersOneListing() public {
        bytes memory evidence = "e";
        bytes32 salt = keccak256("s");
        uint64 c = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, salt), BASE_BOND);

        _purchase(buyer, c);
        _purchase(buyer2, c);
        (,,,,,,,,, uint32 buyers,,,,,,) = market.claims(c);
        assertEq(buyers, 2);

        _deliver(c, buyer);
        _deliver(c, buyer2);
        assertEq(market.balances(seller), 2 * _netFee(), "one reveal fee per buyer");

        vm.warp(lockTime);
        _attestInactive(true);
        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, salt);
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c);
        market.resolvePurchase(c, buyer);
        market.resolvePurchase(c, buyer2);

        uint256 share = (uint256(CONTINGENT) * 3250) / 10_000;
        assertEq(market.balances(seller), 2 * _netFee() + BASE_BOND + 2 * share);
        assertEq(market.balances(buyer), CONTINGENT - share);
        assertEq(market.balances(buyer2), CONTINGENT - share);

        // Double resolve is rejected.
        vm.expectRevert(SAM.BadState.selector);
        market.resolvePurchase(c, buyer);
    }

    function test_CannotBuyTwiceOrFromYourself() public {
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);
        _purchase(buyer, c);

        vm.prank(buyer);
        vm.expectRevert(SAM.AlreadyPurchased.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);

        vm.prank(seller);
        market.registerEncPubKey(PUBKEY);
        vm.prank(seller);
        vm.expectRevert(SAM.SelfDeal.selector);
        market.purchase{value: uint256(FEE) + CONTINGENT}(c);

        // Wrong price is rejected too.
        vm.prank(buyer2);
        vm.expectRevert(SAM.BadValue.selector);
        market.purchase{value: uint256(FEE)}(c);
    }

    /// A bounty is a bid, not a contract: it escrows nothing and gates nothing.
    function test_BountyIsNonBinding() public {
        vm.prank(buyer);
        uint64 b = market.postBounty(GAME, PLAYER, FEE, CONTINGENT);
        assertEq(address(market).balance, 0, "posting a bounty moves no money");

        vm.prank(buyer2);
        vm.expectRevert(SAM.NotBuyer.selector);
        market.cancelBounty(b);
        vm.prank(buyer);
        market.cancelBounty(b);
        (,,,,, bool cancelled) = market.bounties(b);
        assertTrue(cancelled);

        // Listings and purchases never reference a bounty.
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);
        _purchase(buyer2, c);
        assertEq(uint8(_pstate(c, buyer2)), uint8(SAM.PurchaseState.Paid));
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
        bytes32 expected = VECTOR_COMMIT;

        assertEq(
            keccak256(abi.encode(GAME, PLAYER, SAM.Outcome.INACTIVE, SAM.Bucket.B83, keccak256(evidence), salt)),
            expected,
            "TS and Solidity commit hashes diverged"
        );

        uint64 c = _list(expected, market.bondFor(SAM.Bucket.B83));
        vm.warp(lockTime);
        vm.prank(seller);
        market.reveal(c, SAM.Outcome.INACTIVE, SAM.Bucket.B83, evidence, salt);
        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Revealed));
    }

    bytes32 constant VECTOR_COMMIT = 0x8d52a90768cbf26fa1da1f49c8438ba19159cbda2eb62df99d92048629d1155d;

    // ---------------------------------------------------------------- pricing

    function test_PricingCurve() public {
        // Lead-time weight: 10% at lock, 100% at saturation, linear between.
        assertEq(market.leadWeightBps(lockTime, lockTime), 1000);
        assertEq(market.leadWeightBps(lockTime - LEAD_SAT, lockTime), 10_000);
        assertEq(market.leadWeightBps(lockTime - 2 * LEAD_SAT, lockTime), 10_000, "saturates");
        assertEq(market.leadWeightBps(lockTime - LEAD_SAT / 2, lockTime), 5500);

        // Surprise: contrarian and right on QUESTIONABLE/LIMITED (0.70) -> full credit.
        assertEq(market.surpriseBps(SAM.ReportTag.QUESTIONABLE, SAM.Practice.LIMITED, SAM.Outcome.INACTIVE), 10_000);
        // Agreeing with it -> 2 * 0.30 = 0.60.
        assertEq(market.surpriseBps(SAM.ReportTag.QUESTIONABLE, SAM.Practice.LIMITED, SAM.Outcome.ACTIVE), 6000);
        // Restating an obvious OUT -> 2 * 0.01 = 0.02.
        assertEq(market.surpriseBps(SAM.ReportTag.OUT, SAM.Practice.DNP, SAM.Outcome.INACTIVE), 200);
        // A coin-flip prior (QUESTIONABLE/DNP = 0.45) pays in full either way.
        assertEq(market.surpriseBps(SAM.ReportTag.QUESTIONABLE, SAM.Practice.DNP, SAM.Outcome.ACTIVE), 10_000);
        assertEq(market.surpriseBps(SAM.ReportTag.QUESTIONABLE, SAM.Practice.DNP, SAM.Outcome.INACTIVE), 9000);

        // Combined: an obvious call made at the last second is worth almost nothing.
        assertEq(
            market.payoutBpsFor(lockTime, lockTime, SAM.ReportTag.OUT, SAM.Practice.DNP, SAM.Outcome.INACTIVE), 20
        );
        // ...and an early contrarian hit is worth everything.
        assertEq(
            market.payoutBpsFor(
                lockTime - LEAD_SAT, lockTime, SAM.ReportTag.QUESTIONABLE, SAM.Practice.LIMITED, SAM.Outcome.INACTIVE
            ),
            10_000
        );
    }

    /// The same correct claim earns more the earlier it was listed.
    function test_EarlierEarnsMore() public {
        bytes memory evidence = "e";
        bytes32 saltEarly = keccak256("early");
        bytes32 saltLate = keccak256("late");

        vm.warp(lockTime - LEAD_SAT); // full lead
        uint64 early = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, saltEarly), BASE_BOND);
        _purchase(buyer, early);
        _deliver(early, buyer);

        vm.warp(lockTime - 1); // one second of lead
        uint64 late = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, saltLate), BASE_BOND);
        _purchase(buyer2, late);
        _deliver(late, buyer2);

        vm.warp(lockTime);
        _attestInactive(true);
        vm.startPrank(seller);
        market.reveal(early, SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, saltEarly);
        market.reveal(late, SAM.Outcome.INACTIVE, SAM.Bucket.B55, evidence, saltLate);
        vm.stopPrank();
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(early);
        market.settle(late);

        assertEq(_payout(early), 10_000, "full lead time, full surprise");
        assertEq(_payout(late), 1000, "no lead time: the 10% floor");
    }

    // ---------------------------------------------------------------- operator

    function test_ProtocolFeeIsOutcomeIndependent() public {
        uint96 expectedFee = uint96((uint256(FEE) * FEE_BPS) / 10_000);

        bytes32 s1 = keccak256("ok");
        uint64 c1 = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", s1), BASE_BOND);
        _purchase(buyer, c1);
        _deliver(c1, buyer);
        uint256 feeAfterCorrectDelivery = market.balances(operator);

        bytes32 s2 = keccak256("bad");
        uint64 c2 = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e", s2), BASE_BOND);
        _purchase(buyer, c2);
        _deliver(c2, buyer);

        assertEq(feeAfterCorrectDelivery, expectedFee, "fee accrues once per delivered key");
        assertEq(market.balances(operator), expectedFee * 2, "same fee regardless of eventual outcome");

        vm.warp(lockTime);
        _attestInactive(false); // c1 correct, c2 wrong

        vm.startPrank(seller);
        market.reveal(c1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", s1);
        market.reveal(c2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e", s2);
        vm.stopPrank();
        vm.warp(block.timestamp + CHALLENGE);

        uint256 feeBeforeSettlement = market.balances(operator);
        market.settle(c1);
        market.settle(c2);
        market.resolvePurchase(c1, buyer);
        market.resolvePurchase(c2, buyer);

        assertEq(market.balances(operator), feeBeforeSettlement, "settlement pays the operator nothing");
        assertEq(market.balances(burnSink), BASE_BOND, "burned bond goes to the sink, not the operator");
    }

    function test_NoFeeWithoutDelivery() public {
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "x", keccak256("s")), BASE_BOND);
        _purchase(buyer, c);
        vm.warp(lockTime);
        vm.prank(buyer);
        market.refundUndelivered(c);
        assertEq(market.balances(operator), 0, "no delivery, no fee");
        assertEq(market.balances(buyer), uint256(FEE) + CONTINGENT, "buyer fully refunded incl. the fee");
    }

    function test_OperatorVanishes_FundsAreStillRecoverable() public {
        bytes32 salt = keccak256("gone");
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", salt), BASE_BOND);
        _purchase(buyer, c);
        _deliver(c, buyer);

        vm.warp(lockTime);
        vm.expectRevert(SAM.BadState.selector);
        market.settle(c);

        vm.expectRevert(SAM.UnwindTooEarly.selector);
        market.forceUnwind(GAME);

        vm.warp(lockTime + UNWIND + 1);

        address stranger = makeAddr("passerby");
        vm.startPrank(stranger);
        market.forceUnwind(GAME);
        market.unwindClaim(c);
        market.resolvePurchase(c, buyer);
        vm.stopPrank();

        assertEq(uint8(_state(c)), uint8(SAM.ClaimState.Unwound));
        assertEq(market.balances(seller), _netFee() + BASE_BOND, "bond returned to seller");
        assertEq(market.balances(buyer), CONTINGENT, "escrow returned to buyer");
        assertEq(market.balances(burnSink), 0, "nothing is burned: the outcome is unknown");

        uint256 owed = market.balances(seller) + market.balances(buyer) + market.balances(burnSink)
            + market.balances(operator);
        assertEq(address(market).balance, owed, "every wei is accounted for after an unwind");
    }

    /// A voided attestation leaves the game with no valid outcome; the hatch is its exit.
    function test_VoidedGameCanUnwind() public {
        uint64 c = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", keccak256("s")), BASE_BOND);
        vm.warp(lockTime);
        _attestInactive(false);
        vm.prank(owner);
        market.voidAttestation(GAME);
        assertFalse(market.isFinal(GAME));

        vm.warp(lockTime + UNWIND + 1);
        market.forceUnwind(GAME);
        market.unwindClaim(c);
        assertEq(market.balances(seller), BASE_BOND);
    }

    function test_CannotUnwindAnAttestedGame() public {
        _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", keccak256("s")), BASE_BOND);
        vm.warp(lockTime);
        _attestInactive(false);

        vm.warp(lockTime + UNWIND + 1);
        vm.expectRevert(SAM.AlreadyAttested.selector);
        market.forceUnwind(GAME);
    }

    function test_AttestCannotRaceAnUnwind() public {
        _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e", keccak256("s")), BASE_BOND);
        vm.warp(lockTime + UNWIND + 1);
        market.forceUnwind(GAME);

        bytes32[] memory ids = new bytes32[](0);
        vm.prank(attester);
        vm.expectRevert(SAM.AlreadyUnwound.selector);
        market.attest(GAME, keccak256("late"), ids);

        assertFalse(market.isFinal(GAME), "an unwound game is never final");
    }

    function test_ContractSolvency() public {
        bytes32 s1 = keccak256("a");
        bytes32 s2 = keccak256("b");
        uint64 c1 = _list(_commit(SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e1", s1), BASE_BOND);
        uint64 c2 = _list(_commit(SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e2", s2), BASE_BOND);
        _purchase(buyer, c1);
        _purchase(buyer2, c1);
        _purchase(buyer, c2);
        _deliver(c1, buyer);
        _deliver(c1, buyer2);
        _deliver(c2, buyer);

        vm.warp(lockTime);
        _attestInactive(false);
        vm.startPrank(seller);
        market.reveal(c1, SAM.Outcome.ACTIVE, SAM.Bucket.B55, "e1", s1);
        market.reveal(c2, SAM.Outcome.INACTIVE, SAM.Bucket.B55, "e2", s2);
        vm.stopPrank();
        vm.warp(block.timestamp + CHALLENGE);
        market.settle(c1);
        market.settle(c2);
        market.resolvePurchase(c1, buyer);
        market.resolvePurchase(c1, buyer2);
        market.resolvePurchase(c2, buyer);

        uint256 owed = market.balances(seller) + market.balances(buyer) + market.balances(buyer2)
            + market.balances(burnSink) + market.balances(operator);
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

    function list(bytes32 gameId, bytes32 playerId, bytes32 commitHash) external payable returns (uint64) {
        return market.listClaim{value: msg.value}(gameId, playerId, commitHash, hex"aa", 0, 0);
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
            market.withdraw();
        }
    }
}
