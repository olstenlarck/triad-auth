# Rescuing ethscriptions with EIP-7702

## The problem

A wallet whose private key leaked usually has a sweeper bot attached. The bot watches the wallet and moves out any ETH the moment it arrives. The owner still holds the ethscriptions, but a plain ethscription transfer is a transaction sent from the owner, and that transaction needs ETH for gas. Any ETH sent to pay for it is swept first.

## The contract

[EthscriptionsProtocol](https://etherscan.io/address/0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f) on Ethereum mainnet emits the protocol events and holds no state. Its `escapeEthscriptions(bytes32[] ids, address newOwner)` function emits one [ESIP-1](https://docs.ethscriptions.com/esips/accepted-esips/esip-1-smart-contract-ethscription-transfers) `ethscriptions_protocol_TransferEthscription(newOwner, id)` event per id. The source is in [src/EthscriptionsProtocol.sol](../src/EthscriptionsProtocol.sol).

Under ESIP-1, the event moves an ethscription only when the address that emits it is the current owner. Called directly, the contract owns nothing, so its events move nothing.

## The flow

[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) lets an EOA sign an authorization that sets its code to a pointer to a contract. Signing the authorization is free and offline. Any other account can put that authorization in a type-4 transaction and pay the gas.

1. The compromised wallet signs an authorization for chain 1 that delegates to `0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f`, with the compromised wallet's current nonce.
2. A sponsor wallet, which the attacker does not control, sends one type-4 transaction. The authorization list holds the signed authorization. The `to` field is the compromised wallet, and the calldata is `escapeEthscriptions(ids, safeWallet)`.
3. The EVM first applies the authorization, so the compromised wallet now runs the EthscriptionsProtocol code. Then it runs the call in the context of the compromised wallet.
4. Each event has the compromised wallet as its log address. That address owns the ethscriptions, so the indexer moves each one to the safe wallet.

The sponsor pays all gas. No ETH goes to the compromised wallet, so the sweeper has nothing to take. One ethscription costs about 2.4k gas, so 1000 cost about 2.4M gas. The delegation stays after the first transaction, so later batches call the wallet without a new authorization.

## Risks

- The attacker has the same key. If they send any transaction from the compromised wallet before the rescue lands, its nonce changes and the signed authorization becomes invalid. They can also sign their own delegation. Send the rescue through a private RPC so that it does not wait in the public mempool.
- The `escapeEthscriptions` function has no access control. While the delegation is active, anyone can call the compromised wallet and move what it owns. Rescue everything in one run, with the `--all` flag of the [`ethscriptions-rescue`](../../../packages/ethscriptions-rescue) CLI. Anything sent to the compromised wallet later is open to anyone.
- An event for an ethscription that the compromised wallet does not own moves nothing and only wastes gas. The CLI checks the current owner of each id or number before it sends.
