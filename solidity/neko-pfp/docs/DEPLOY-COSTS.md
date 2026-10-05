# Deploy costs: Ethereum mainnet vs Robinhood Chain

Measured 2026-10-05. Deploy gas comes from the `forge test` gas report. Call gas is execution gas measured in `forge test` against the deployed SeaDrop and transfer validator bytecode fixtures; add the 21k intrinsic cost for a wallet quote. Execution gas is the same on both chains. Mint gas comes from `script/MintGasProbe.s.sol` on forks of both chains. Prices are spot: ETH $2,705.42 (CoinGecko API), gas prices read live with `cast gas-price` from `ethereum-rpc.publicnode.com` and `rpc.mainnet.chain.robinhood.com`. Recompute before launch; all three numbers move.

## Gas per transaction

| #   | Transaction                                  | Gas                    |
| --- | -------------------------------------------- | ---------------------- |
| 1   | deploy `NekoRenderer`                        | 5,120,788              |
| 2   | deploy `NekoSeaDrop`                         | 12,263,987             |
| 3   | `setRoyaltyInfo` (deployer, 0%)              | 25,550 exec, ~47k tx   |
| 4   | `setTransferValidator`                       | 24,690 exec, ~46k tx   |
|     | **deploy total**                             | **~17,477,000**        |
| 5   | Studio `multiConfigure` (payout, fee)        | 967,585 exec, ~989k tx |
| 6   | Studio `multiConfigure` (allowlist, later)   | 899,095 exec           |
| 7   | Studio `multiConfigure` (public drop, later) | 899,795 exec           |
| 8   | `reveal` (after mint-out)                    | 73,343 exec            |

The two deploys are 99% of the deploy total. The renderer carries ~23.4kB of runtime code (SVG palettes, matrix background, toys). The NFT carries ~21.2kB, and its constructor mints the 20 team cats and renders the unrevealed image on-chain into a 9.3kB `contractURI`.

Each Studio `multiConfigure` call writes the hardcoded collection metadata again, as in Mews. That renders the placeholder image and rewrites the same `contractURI` bytes, which is most of the ~900k gas per call.

SeaDrop (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`) and the transfer validator (`0xA000027A9B2802E1ddf7000061001e5c005A0000`) are deployed at the same addresses on both chains, verified with `cast codesize`.

## Ethereum mainnet (chain id 1)

Gas price at measurement: 0.098 gwei.

| Gas price            | Deploy total (ETH) | Deploy total (USD) | Each `multiConfigure` (USD) |
| -------------------- | ------------------ | ------------------ | --------------------------- |
| 0.05 gwei            | 0.000874           | $2.36              | $0.13                       |
| 0.098 gwei (spot)    | 0.00172            | $4.65              | $0.26                       |
| 0.15 gwei            | 0.00262            | $7.09              | $0.40                       |
| 0.5 gwei             | 0.00874            | $23.64             | $1.34                       |
| 2 gwei (busy day)    | 0.03495            | $94.57             | $5.35                       |

## Robinhood Chain mainnet (chain id 4663)

The chain id equals the collection supply. Not a coincidence: 4663 was picked as the supply with this chain id in mind. Verified against chainid.network.

Gas token is ETH. Gas price at measurement: 0.020266 gwei.

| Gas price             | Deploy total (ETH) | Deploy total (USD) | Each `multiConfigure` (USD) |
| --------------------- | ------------------ | ------------------ | --------------------------- |
| 0.020266 gwei (spot)  | 0.000354           | $0.96              | $0.05                       |
| 0.1 gwei              | 0.00175            | $4.73              | $0.27                       |

Two caveats:

- Robinhood Chain is an Arbitrum Orbit rollup, so every tx also pays a small L1 data-posting fee on top of the execution gas above. For the one-time deploy this adds cents, not dollars. The forge simulation of `script/Deploy.s.sol` against the chain, which includes that fee and forge's default buffer, estimated 0.000914 ETH.
- SeaDrop being deployed there makes the contracts work. Whether OpenSea Studio offers Robinhood Chain in its drop UI is a separate product question; confirm in Studio before committing to the chain.

## Mint cost

Minting is light. The heavy machinery (seed sampling, trait derivation, SVG rendering) sits behind `tokenURI` and the other view functions, which cost nothing to call off-chain. A mint is a standard SeaDrop `mintPublic`: config reads, payment split, and an ERC721A batch mint. Mints skip the transfer validator.

Measured against the real deployed SeaDrop on a mainnet fork; the Robinhood Chain fork is within 100 gas:

| Mint                  | Execution gas | ~Tx gas | Mainnet @0.098 gwei | Mainnet @1 gwei | Robinhood @spot |
| --------------------- | ------------- | ------- | ------------------- | --------------- | --------------- |
| qty 1, wallet's first | 134,014       | ~156k   | $0.04               | $0.42           | < $0.01         |
| qty 1, repeat         | 58,214        | ~100k   | $0.03               | $0.27           | < $0.01         |
| qty 5, one tx         | 65,928        | ~105k   | $0.03               | $0.28           | < $0.01         |

Tx gas adds the 21k intrinsic cost plus warm-up of accounts the probe had already touched; treat the tx column as the wallet-quote ballpark. ERC721A batching means five cats cost barely more than one. The mint price itself is the only number a minter feels.

## Reproduce

```
# deploy and call gas
forge test --match-contract 'DeployTest|NekoSeaDropTest' --gas-report

# mint gas: probe the real SeaDrop on a fork
forge script script/MintGasProbe.s.sol --rpc-url https://ethereum-rpc.publicnode.com
forge script script/MintGasProbe.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com

# prices
cast gas-price --rpc-url https://ethereum-rpc.publicnode.com
cast gas-price --rpc-url https://rpc.mainnet.chain.robinhood.com
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
```
