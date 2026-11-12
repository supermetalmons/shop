# Relic 4 — unsigned mainnet transaction package

**Prepared only. Nothing signed or broadcast.** Open exactly one additional public relic slot, then purchase **Relic 4**, token **117175**, with the deployer wallet for **2.44 ETH**.

| Field | Value |
| --- | --- |
| Network | Ethereum mainnet, chain ID 1 |
| Collection | `0x08cded8258730bda384ff198001e47a1b50f7f9d` |
| Deployer / recipient | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Priority / maximum gas fee | 5 / 10 gwei, EIP-1559 |
| Maximum primary gas fees | 0.0024 ETH |
| Maximum gas fees including standby recovery | 0.003 ETH |
| Minimum balance including purchase and recovery budget | 2.443 ETH |

## Unsigned payloads

| Use | File | Nonce | Contract call | ETH value | Gas limit |
| --- | --- | ---: | --- | ---: | ---: |
| First | [Open one slot](01-open-public-relic-sale.unsigned.json) | 32 | `setPublicRelicSale(3, 2440000000000000000, true)` | 0 | 60,000 |
| Second | [Mint Relic 4](02-mint-relic-4.unsigned.json) | 33 | `mintRelic(4)` | 2.44 | 180,000 |
| Standby only | [Recovery close](recovery/close-public-relic-sale.unsigned.json) | 34 | `setPublicRelicSale(3, 2440000000000000000, false)` | 0 | 60,000 |

The public sale is active but exhausted at **2 minted / 2 limit**. Its current price is 2.402 ETH. Raising the lifetime limit to **3**, with the new price of **2.44 ETH**, permits exactly one additional public mint. Successful minting leaves `mintable=0` and the public active flag true. Global sale settings and reserved claim allowances remain unchanged.

Files contain unsigned transaction requests with hexadecimal RPC quantities. [operation.json](operation.json) includes decoded calls and constraints. The primary sequence contains only the opening and mint payloads; recovery is stored separately.

## Verification and future execution

The [source snapshot](source-snapshot.json) records the real mainnet state. [Simulation evidence](simulation.json) covers the purchase, exhausted-cap rejection, competing claims/purchases, and recovery on an isolated local fork. Simulated transactions are not mainnet receipts. [Checksums](checksums.json) cover the package artifacts.

Immediately before any future signing, run this read-only check from the repository root:

```sh
node --env-file=.env.local releases/111k-mainnet-v1/relic-4-public-mint-2026-11-12/preflight.mjs
```

It checks the exact payloads, chain, runtime, owner, public-sale baseline, Relic 4 availability, reserved allocation, deployer allowance, remaining crate capacity, balance, fees, and latest/pending nonce. It never signs, broadcasts, or writes files. If relevant state changes, reconcile and re-prepare the package.

Sending requires a separate user instruction. The selected future route remains public RPC: sign both primary transactions first, save their exact bytes privately, then submit opening and minting back-to-back after RPC acknowledgement, without waiting for the opening receipt. Reconcile uncertain responses using the saved hashes.

High fees cannot prevent another wallet from taking the public slot or an eligible reserved claimant from taking Relic 4. Never raise the cap beyond **3**, substitute another relic, or change the global sale flag automatically. Reserved claims remain independent of the public cap.

If the mint fails and leaves a public slot open, the standby transaction disables public relic minting. Its nonce **34** is valid only after nonce **33** has been consumed and the next nonce has been verified. It cannot bypass or cancel a pending mint. Unplanned replacement transactions and fee increases are outside this package.

Future success requires three canonical confirmations, deployer ownership of token 117175, exactly one paid `PublicRelicMinted` event for Relic 4 with payment 2.44 ETH, public issuance 3, and zero remaining public capacity. The purchase must allocate 111 crates and credit 2.44 ETH without consuming reserved allowances. Concurrent unrelated sales may also affect aggregate counters. This preparation makes no live contract changes.
