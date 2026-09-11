// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SealedAvailabilityMarket} from "../src/SealedAvailabilityMarket.sol";

/**
 * Deploy with demo parameters (LLD §8). Every window is a constructor arg so one
 * deployment can serve both the 5-minute demo and the "production story" in the README.
 *
 *   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
 */
contract Deploy is Script {
    /// Accepts PRIVATE_KEY with or without the 0x prefix.
    function _privateKey() internal view returns (uint256) {
        string memory raw = vm.envString("PRIVATE_KEY");
        bytes memory b = bytes(raw);
        bool prefixed = b.length >= 2 && b[0] == 0x30 && (b[1] == 0x78 || b[1] == 0x58);
        return vm.parseUint(prefixed ? raw : string.concat("0x", raw));
    }

    function run() external {
        uint256 pk = _privateKey();
        address deployer = vm.addr(pk);

        // Demo params. Overridable by env so the same script can deploy prod-ish windows.
        uint96 baseBond = uint96(vm.envOr("BASE_BOND", uint256(0.0002 ether)));
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(60)));
        uint64 revealWindow = uint64(vm.envOr("REVEAL_WINDOW", uint256(240)));
        address burnSink = vm.envOr("BURN_SINK", address(0x000000000000000000000000000000000000dEaD));
        // Operator take rate on the reveal fee (outcome-independent). 250 bps = 2.5%.
        uint16 protocolFeeBps = uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(250)));

        // The attester defaults to the deployer so the market can be deployed before the
        // oracle adapter exists (the adapter needs the market's address). Set ATTESTER to
        // the UmaAttester address to source outcomes from UMA instead.
        address attester = vm.envOr("ATTESTER", deployer);

        vm.startBroadcast(pk);
        SealedAvailabilityMarket market = new SealedAvailabilityMarket(
            deployer, attester, deployer, burnSink, deployer, protocolFeeBps, baseBond,
            challengeWindow, revealWindow
        );
        vm.stopBroadcast();

        console.log("=====================================================");
        console.log("SealedAvailabilityMarket:", address(market));
        console.log("deployBlock:            ", block.number);
        console.log("chainId:                ", block.chainid);
        console.log("scheduler:              ", deployer);
        console.log("attester:               ", attester);
        console.log("owner:                  ", deployer);
        console.log("burnSink:               ", burnSink);
        console.log("feeRecipient:           ", deployer);
        console.log("protocolFeeBps:         ", protocolFeeBps);
        console.log("baseBond (wei):         ", baseBond);
        console.log("challengeWindow (s):    ", challengeWindow);
        console.log("revealWindow (s):       ", revealWindow);
        console.log("=====================================================");
    }
}
