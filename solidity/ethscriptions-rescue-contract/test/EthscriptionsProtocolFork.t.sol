// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EthscriptionsProtocol} from "../src/EthscriptionsProtocol.sol";

// Runs against the contract deployed on Ethereum mainnet: `pnpm run test:fork`.
contract EthscriptionsProtocolForkTest is Test {
    event ethscriptions_protocol_TransferEthscription(
        address indexed recipient, bytes32 indexed ethscriptionId
    );

    address internal constant PROTOCOL = 0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f;
    uint256 internal constant COMPROMISED_KEY = 0xC0FFEE;

    function test_SponsorEscapesThroughDeployedContract() public {
        address compromised = vm.addr(COMPROMISED_KEY);
        address sponsor = makeAddr("sponsor");
        address safe = makeAddr("safe");
        assertGt(PROTOCOL.code.length, 0);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("first");
        ids[1] = keccak256("second");

        vm.signAndAttachDelegation(PROTOCOL, COMPROMISED_KEY);

        for (uint256 i = 0; i < ids.length; i++) {
            vm.expectEmit(true, true, false, false, compromised);
            emit ethscriptions_protocol_TransferEthscription(safe, ids[i]);
        }

        vm.prank(sponsor);
        EthscriptionsProtocol(compromised).escapeEthscriptions(ids, safe);

        assertEq(compromised.code, abi.encodePacked(hex"ef0100", PROTOCOL));
    }
}
