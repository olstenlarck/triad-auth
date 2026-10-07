# ethscriptions-rescue

A CLI that moves ethscriptions out of a compromised wallet with [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702), while a second wallet pays the gas. The compromised wallet never receives ETH, so a sweeper bot has nothing to take.

## How it works

1. The compromised wallet signs an authorization that delegates its code to the [EthscriptionsProtocol](https://etherscan.io/address/0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f) contract.
2. The sponsor wallet sends a type-4 transaction with that authorization and calls `escapeEthscriptions(ids, safeWallet)` on the compromised wallet itself.
3. The compromised wallet emits one [ESIP-1](https://docs.ethscriptions.com/esips/accepted-esips/esip-1-smart-contract-ethscription-transfers) transfer event per ethscription. It owns them, so the events move them to the safe wallet.

Read [the rescue flow](https://github.com/tunnckoCoreHQ/monarch/blob/master/solidity/ethscriptions-rescue-contract/docs/rescue-flow.md) for the details and the risks.

## Usage

The CLI reads the keys and the RPC URL from the environment, so they stay out of shell history:

- `COMPROMISED_KEY` is the private key of the compromised wallet.
- `SPONSOR_KEY` is the private key of a funded wallet that pays the gas.
- `RPC_URL` is an Ethereum mainnet RPC. Use a private one, so that the attacker does not see the transaction in the public mempool.

```
# rescue ethscriptions by id (creation transaction hash) or by ethscription number
npx ethscriptions-rescue --to 0xSafeWallet 0x533c...c92b 1234 56789

# rescue every ethscription the compromised wallet owns, found through https://api.calldata.space
npx ethscriptions-rescue --to 0xSafeWallet --all

# list what would move, without sending anything
npx ethscriptions-rescue --to 0xSafeWallet --all --dry-run
```

The CLI skips ids and numbers that the compromised wallet does not own. It sends 1000 ethscriptions per transaction, about 2.4M gas each. Only the first transaction carries the authorization, because the delegation stays after it.

## Risks

- The attacker has the same key. If they send any transaction from the compromised wallet before the rescue lands, the authorization becomes invalid.
- While the delegation is active, anyone can call the compromised wallet and move what it owns. Rescue everything in one run with `--all`.

## Testing

The test starts anvil, sets the deployed EthscriptionsProtocol code at its mainnet address, mocks the calldata.space API, and runs the CLI against both. It needs [Foundry](https://getfoundry.sh) for `anvil`.

```
turbo run test --filter=ethscriptions-rescue
```

## License

Apache-2.0
