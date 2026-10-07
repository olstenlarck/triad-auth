// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EthscriptionsProtocol} from "../src/EthscriptionsProtocol.sol";

contract EthscriptionsProtocolTest is Test {
    event ethscriptions_protocol_TransferEthscription(
        address indexed recipient, bytes32 indexed ethscriptionId
    );

    uint256 internal constant COMPROMISED_KEY = 0xC0FFEE;

    EthscriptionsProtocol internal protocol;
    address internal compromised;
    address internal sponsor;
    address internal safe;

    function setUp() public {
        protocol = new EthscriptionsProtocol();
        compromised = vm.addr(COMPROMISED_KEY);
        sponsor = makeAddr("sponsor");
        safe = makeAddr("safe");
    }

    function test_SponsorEscapesThroughDelegatedWallet() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("first");
        ids[1] = keccak256("second");

        vm.signAndAttachDelegation(address(protocol), COMPROMISED_KEY);

        // The compromised wallet emits the events, so ESIP-1 sees its owner transferring.
        for (uint256 i = 0; i < ids.length; i++) {
            vm.expectEmit(true, true, false, false, compromised);
            emit ethscriptions_protocol_TransferEthscription(safe, ids[i]);
        }

        vm.prank(sponsor);
        EthscriptionsProtocol(compromised).escapeEthscriptions(ids, safe);

        assertEq(compromised.code, abi.encodePacked(hex"ef0100", address(protocol)));
        assertEq(compromised.balance, 0);
    }
}
