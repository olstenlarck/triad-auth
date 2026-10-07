// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

contract EthscriptionsProtocol {
    // ESIP-1
    // https://docs.ethscriptions.com/esips/accepted-esips/esip-1-smart-contract-ethscription-transfers
    event ethscriptions_protocol_TransferEthscription(
        address indexed recipient, bytes32 indexed ethscriptionId
    );

    // ESIP-2
    // https://docs.ethscriptions.com/esips/accepted-esips/esip-2-safe-trustless-smart-contract-ethscription-escrow
    event ethscriptions_protocol_TransferEthscriptionForPreviousOwner(
        address indexed previousOwner, address indexed recipient, bytes32 indexed ethscriptionId
    );

    // ESIP-3
    // https://docs.ethscriptions.com/esips/accepted-esips/esip-3-smart-contract-ethscription-creations
    event ethscriptions_protocol_CreateEthscription(
        address indexed initialOwner, string contentURI
    );

    // Eventual ESIP, similar to ESIP-3 but respecting the `msg.sender` as creator not the contract
    // https://github.com/ethscriptions-protocol/ESIP-Discussion/issues/25
    event ethscriptions_protocol_CreateEthscriptionFrom(
        address indexed initialOwner, string contentURI
    );

    function transferEthscription(address recipient, bytes32 ethscriptionId) external {
        emit ethscriptions_protocol_TransferEthscription(recipient, ethscriptionId);
    }

    function transferEthscriptionForPreviousOwner(
        address previousOwner,
        address recipient,
        bytes32 ethscriptionId
    ) external {
        emit ethscriptions_protocol_TransferEthscriptionForPreviousOwner(
            previousOwner, recipient, ethscriptionId
        );
    }

    function createEthscription(string memory dataURI, address initialOwner) external {
        emit ethscriptions_protocol_CreateEthscription(initialOwner, dataURI);
    }

    function createEthscriptionFrom(string memory dataURI, address initialOwner) external {
        emit ethscriptions_protocol_CreateEthscriptionFrom(initialOwner, dataURI);
    }

    // Useful for escaping multiple ethscriptions at once, if a wallet has attached some sort of drainer.
    // This would only work if drained EOA has this account as EIP-7702.
    function escapeEthscriptions(bytes32[] memory ids, address newOwner) external payable {
        for (uint256 i = 0; i < ids.length; i++) {
            emit ethscriptions_protocol_TransferEthscription(newOwner, ids[i]);
        }
    }
}

