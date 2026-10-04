// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {NekoRenderer} from "../src/NekoRenderer.sol";
import {ISeaDrop, PublicDrop} from "../src/seadrop/SeaDropInterfaces.sol";

// Exercise deployment without needing the real wallet's signing key in tests.
contract DeploySimulation is Deploy {
    function _startBroadcast() internal override {
        vm.startBroadcast(DEPLOYER);
    }
}

contract DeployTest is Test {
    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant FEE = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address internal constant VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant BUYER = address(0xA11CE);
    address internal constant OWNER = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    address internal constant COLLABORATOR = 0x9D9db340778139774cF73DFB7Bf27498Fa67978F;
    bytes32 internal constant COMMITMENT = keccak256("Neko deploy test commitment");
    ISeaDrop internal seaDrop = ISeaDrop(SEA_DROP);
    NekoRenderer internal renderer;
    NekoSeaDrop internal neko;

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1000);
        vm.setEnv("GENESIS_SEED_COMMITMENT", vm.toString(COMMITMENT));
        string memory encoded = vm.readFile("test/fixtures/SeaDrop.hex");
        vm.etch(SEA_DROP, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        vm.store(SEA_DROP, bytes32(0), bytes32(uint256(1)));
        encoded = vm.readFile("test/fixtures/TransferValidator.hex");
        vm.etch(VALIDATOR, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        Deploy deploy = Deploy(deployCode("Deploy.t.sol:DeploySimulation"));
        (renderer, neko) = deploy.run();
        vm.deal(BUYER, 1 ether);
    }

    function testDeploymentSetsAllocationAndRoyalties() public view {
        assertEq(neko.owner(), OWNER);
        assertEq(address(neko.renderer()), address(renderer));
        assertEq(neko.provenanceHash(), COMMITMENT);
        assertEq(neko.totalSupply(), 20);
        assertEq(neko.balanceOf(COLLABORATOR), 5);
        assertEq(neko.balanceOf(OWNER), 15);
        assertEq(neko.ownerOf(5), COLLABORATOR);
        assertEq(neko.ownerOf(6), OWNER);
        assertEq(neko.ownerOf(20), OWNER);
        assertEq(neko.royaltyAddress(), OWNER);
        assertEq(neko.royaltyBasisPoints(), 0);
        assertEq(neko.getTransferValidator(), VALIDATOR);
    }

    function testDeploymentLeavesSeaDropUnconfiguredAndMintClosed() public {
        assertEq(seaDrop.getCreatorPayoutAddress(address(neko)), address(0));
        assertEq(seaDrop.getAllowListMerkleRoot(address(neko)), bytes32(0));
        assertFalse(seaDrop.getFeeRecipientIsAllowed(address(neko), FEE));
        PublicDrop memory stage = seaDrop.getPublicDrop(address(neko));
        assertEq(stage.startTime, 0);
        assertEq(stage.endTime, 0);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 1000, 0, 0));
        seaDrop.mintPublic{value: 0.001 ether}(address(neko), FEE, address(0), 1);
    }

    function testDeploymentRejectsWrongSigningKey() public {
        vm.setEnv("PRIVATE_KEY", "1");
        Deploy deploy = Deploy(deployCode("Deploy.s.sol:Deploy"));
        vm.expectRevert(Deploy.InvalidDeployerKey.selector);
        deploy.run();
    }

    function testDeploymentRejectsOtherChains() public {
        vm.chainId(8453);
        Deploy deploy = Deploy(deployCode("Deploy.t.sol:DeploySimulation"));
        vm.expectRevert(Deploy.InvalidConfiguration.selector);
        deploy.run();
    }
}
