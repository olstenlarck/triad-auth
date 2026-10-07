# ethscriptions-rescue

Moves ethscriptions out of a compromised wallet with [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) and the [EthscriptionsProtocol](https://etherscan.io/address/0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f) contract, while a second wallet pays the gas. The compromised wallet never receives ETH, so a sweeper bot has nothing to take.

Read [docs/rescue-flow.md](docs/rescue-flow.md) for how the flow works and its risks.

## Rescue

The script reads the keys and the RPC URL from the environment. `COMPROMISED_KEY` is the private key of the compromised wallet. `SPONSOR_KEY` is the private key of a funded wallet that pays the gas. `RPC_URL` is an Ethereum mainnet RPC; use a private one.

From this project's folder:

```
# rescue ethscriptions by id (creation transaction hash) or by ethscription number
pnpm run rescue --to 0xSafeWallet 0x533c...c92b 1234 56789

# rescue every ethscription the compromised wallet owns, found through https://api.calldata.space
pnpm run rescue --to 0xSafeWallet --all

# list what would move, without sending anything
pnpm run rescue --to 0xSafeWallet --all --dry-run
```

The script skips ids and numbers that the compromised wallet does not own. It sends 1000 ethscriptions per transaction and adds the authorization only while the wallet is not delegated yet.

## Build & Testing

Project is managed by Pnpm and Foundry.

From the root of the monorepo:

```
turbo run check --filter=ethscriptions-rescue
turbo run test --filter=ethscriptions-rescue
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

The `test` script runs the Forge tests, then [scripts/rescue.test.ts](scripts/rescue.test.ts). That Vitest file starts anvil, sets the compiled contract code at the mainnet address, mocks the calldata.space API, and runs the CLI against both.

## License

Apache-2.0
