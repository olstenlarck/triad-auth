// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {NekoRenderer} from "../src/NekoRenderer.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {ISeaDrop, ISeaDropTokenContractMetadata} from "../src/seadrop/SeaDropInterfaces.sol";

contract Deploy is Script {
    error InvalidConfiguration();
    error InvalidDeployerKey();

    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant TRANSFER_VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant DEPLOYER = 0x6C22d03544609Db5128736706d90D66fC7f45388;

    // PRIVATE_KEY and GENESIS_SEED_COMMITMENT are loaded from the project's .env file.
    // Configure the sale in OpenSea Studio.
    function run() external returns (NekoRenderer renderer, NekoSeaDrop neko) {
        bytes32 commitment = vm.envBytes32("GENESIS_SEED_COMMITMENT");
        if (block.chainid != 4663) {
            revert InvalidConfiguration();
        }
        _startBroadcast();
        renderer = new NekoRenderer();
        neko = new NekoSeaDrop(commitment, renderer, ISeaDrop(SEA_DROP));
        neko.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(DEPLOYER, 0));
        neko.setTransferValidator(TRANSFER_VALIDATOR);
        vm.stopBroadcast();
    }

    function _startBroadcast() internal virtual {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        if (privateKey == 0 || vm.addr(privateKey) != DEPLOYER) {
            revert InvalidDeployerKey();
        }
        vm.startBroadcast(privateKey);
    }
}
