# Deploy costs on Robinhood Chain

Measured 2026-10-05. Deploy gas comes from the `forge test` gas report. Call gas is execution gas measured in `forge test` against the deployed SeaDrop and transfer validator bytecode fixtures; add the 21k intrinsic cost for a wallet quote. Mint gas comes from `script/MintGasProbe.s.sol` on a Robinhood Chain fork. Prices are spot: ETH $2,705.42 (CoinGecko API), gas price 0.020266 gwei read with `cast gas-price` from `rpc.mainnet.chain.robinhood.com`. Recompute before launch; both numbers move.

## Gas per transaction

| #   | Transaction                                 | Gas                       |
| --- | ------------------------------------------- | ------------------------- |
| 1   | deploy `NekoRenderer`                       | 5,120,788                 |
| 2   | deploy `NekoSeaDrop`                        | 12,263,987                |
| 3   | `setRoyaltyInfo` (deployer, 0%)             | 25,550 exec, ~47k tx      |
| 4   | `setTransferValidator`                      | 24,690 exec, ~46k tx      |
|     | **deploy total**                            | **~17,477,000**           |
| 5   | Studio `multiConfigure` (payout, fee)       | 967,585 exec, ~989k tx    |
| 6   | Studio `multiConfigure` (allowlist, later)  | 899,095 exec              |
| 7   | Studio `multiConfigure` (public drop, later) | 899,795 exec              |
| 8   | `reveal` (after mint-out)                   | 73,343 exec               |

The two deploys are 99% of the deploy total. The renderer carries ~23.4kB of runtime code (SVG palettes, matrix background, toys). The NFT carries ~21.2kB, and its constructor mints the 20 team cats and renders the unrevealed image on-chain into a 9.3kB `contractURI`.

Each Studio `multiConfigure` call writes the hardcoded collection metadata again, as in Mews. That renders the placeholder image and rewrites the same `contractURI` bytes, which is most of the ~900k gas per call.

## Cost

Gas token is ETH. SeaDrop and the transfer validator are deployed at their canonical addresses (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` and `0xA000027A9B2802E1ddf7000061001e5c005A0000`, verified with `cast codesize`).

| Gas price             | Deploy total (ETH) | Deploy total (USD) |
| --------------------- | ------------------ | ------------------ |
| 0.020266 gwei (spot)  | 0.000354           | $0.96              |
| 0.1 gwei              | 0.00175            | $4.73              |

Each Studio `multiConfigure` call costs about $0.05 at spot. The forge simulation of `script/Deploy.s.sol` against the chain estimated 0.000914 ETH for the deploy with its default buffer; fund the deployer with at least that.

Robinhood Chain is an Arbitrum Orbit rollup, so every tx also pays a small L1 data-posting fee on top of the execution gas above. For the one-time deploy this adds cents, not dollars.

## Mint cost

Minting is light. The heavy machinery (seed sampling, trait derivation, SVG rendering) sits behind `tokenURI` and the other view functions, which cost nothing to call off-chain. A mint is a standard SeaDrop `mintPublic`: config reads, payment split, and an ERC721A batch mint. Mints skip the transfer validator.

| Mint                  | Execution gas | ~Tx gas | USD at spot |
| --------------------- | ------------- | ------- | ----------- |
| qty 1, wallet's first | 133,929       | ~156k   | < $0.01     |
| qty 1, repeat         | 58,129        | ~100k   | < $0.01     |
| qty 5, one tx         | 65,843        | ~105k   | < $0.01     |

Tx gas adds the 21k intrinsic cost plus warm-up of accounts the probe had already touched; treat the tx column as the wallet-quote ballpark. ERC721A batching means five cats cost barely more than one. The mint price itself is the only number a minter feels.

## Reproduce

```
# deploy and call gas
forge test --match-contract 'DeployTest|NekoSeaDropTest' --gas-report

# deploy simulation against the chain, no broadcast
pnpm run deploy --rpc-url https://rpc.mainnet.chain.robinhood.com

# mint gas: probe the real SeaDrop on a fork
forge script script/MintGasProbe.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com

# prices
cast gas-price --rpc-url https://rpc.mainnet.chain.robinhood.com
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
```
