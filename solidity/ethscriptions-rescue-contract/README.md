# ethscriptions-rescue-contract

The [EthscriptionsProtocol](https://etherscan.io/address/0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f) contract on Ethereum mainnet. A compromised wallet delegates to it with [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702), so that a second wallet can pay the gas to move the compromised wallet's ethscriptions out. The compromised wallet never receives ETH, so a sweeper bot has nothing to take.

Read [docs/rescue-flow.md](docs/rescue-flow.md) for how the flow works and its risks. The [`ethscriptions-rescue`](../../packages/ethscriptions-rescue) npm package is the CLI that runs the rescue.

## Build & Testing

Project is managed by Pnpm and Foundry.

From the root of the monorepo:

```
turbo run check --filter=ethscriptions-rescue-contract
turbo run test --filter=ethscriptions-rescue-contract
```

From this project's folder:

```
pnpm run fmt
pnpm run lint
pnpm run test
pnpm run build

# the delegation flow against the contract deployed on mainnet; RPC_URL overrides the public RPC
pnpm run test:fork
```

## License

Apache-2.0
