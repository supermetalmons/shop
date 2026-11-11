# Relic 17 — unsigned mainnet transaction package

**Prepared only. No transactions have been signed or broadcast.** This package opens exactly one additional public relic slot and purchases Relic 17 for **2.402 ETH**. The separate recovery payload is not part of the normal sequence.

| Field | Value |
| --- | --- |
| Network | Ethereum mainnet, chain ID 1 |
| Collection | `0x08cded8258730bda384ff198001e47a1b50f7f9d` |
| Deployer / recipient | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Relic / ERC-721 token | 17 / 117188 |
| Transaction type | EIP-1559 (`0x2`) |
| Priority / maximum gas fee | 5 / 10 gwei |
| Maximum primary gas fees | 0.0024 ETH |
| Maximum gas fees including recovery | 0.003 ETH |
| Required purchase plus gas balance | 2.405 ETH |

## Payloads

The JSON files contain unsigned Ethereum transaction request fields. Numeric RPC quantities are hexadecimal. They contain no signatures and cannot be submitted as signed raw transactions.

| Use | File | Nonce | Call | Value | Gas limit |
| --- | --- | ---: | --- | ---: | ---: |
| First | [Open](01-open-public-relic-sale.unsigned.json) | 26 | `setPublicRelicSale(2, 2402000000000000000, true)` | 0 ETH | 60,000 |
| Second | [Mint](02-mint-relic-17.unsigned.json) | 27 | `mintRelic(17)` | 2.402 ETH | 180,000 |
| Standby only | [Recovery close](recovery/close-public-relic-sale.unsigned.json) | 28 | `setPublicRelicSale(2, 2402000000000000000, false)` | 0 ETH | 60,000 |

Public issuance was already **1** when prepared. The limit is cumulative, so **2** releases one additional slot. A successful purchase exhausts the cap; the public active flag stays true but `mintable` becomes zero. Global sales remain active. Existing reserved claims remain available independently.

[operation.json](operation.json) contains decoded calls and execution constraints. [source-snapshot.json](source-snapshot.json) records the read-only mainnet checks. [simulation.json](simulation.json) records execution on an isolated local fork, including competing buyers and recovery. Local simulated transactions are not mainnet receipts. [checksums.json](checksums.json) records SHA-256 file digests.

## Read-only preflight

From the repository root, using the existing RPC environment:

```sh
node --env-file=.env.local releases/111k-mainnet-v1/relic-17-public-mint-2026-11-11/preflight.mjs
```

This command prints a fresh JSON snapshot. It validates the exact unsigned payloads, runtime, owner, global sale flag, public-sale baseline, target availability, reserved allocation, deployer allowance, crate capacity, balance, current fees, and both latest and pending nonces. It never signs, sends transactions, or writes files. RPC credentials are read from the environment and are not printed.

Run it immediately before any future signing. A failed check requires reconciliation and re-preparation. Passing preflight does not reserve the relic or guarantee transaction ordering against other wallets. Preserve this package as a preparation record rather than silently changing its nonces or fee limits.

## Future submission and recovery

Sending requires a separate user instruction. The selected route is **public RPC**. Sign both primary payloads before submission; submit the opening and then the mint immediately after the RPC acknowledges the opening, without waiting for its receipt. Save exact signed bytes privately before any future broadcast and reconcile uncertain responses by transaction hash. Do not build a new nonce sequence after a timeout.

High gas does not prevent third-party interleaving. Another public buyer can consume the one slot, and an eligible reserved claimant can take Relic 17. In either case, do not raise the limit above **2**, substitute another relic, change the global sale flag, or spend above the selected gas budget automatically.

The recovery payload at nonce **28** is usable only after nonce **27** has been mined or otherwise consumed and the next nonce is verified as 28. If the mint failed and the public slot remains open, close it with this standby call. It does not cancel or bypass a pending mint. Reconcile pending or uncertain transactions before further action; replacement transactions and higher fee limits are not included in this package.

Future execution succeeds only after both primary receipts succeed, token 117188 belongs to the deployer, the `PublicRelicMinted` event identifies Relic 17 with a 2.402 ETH payment and `freeMint=false`, public issuance is 2, and `mintable` is zero. Require at least three canonical confirmations and verify that the intended transaction reserved 111 crates and credited exactly 2.402 ETH. Concurrent unrelated sales may also change aggregate counters. Preparation is complete without executing any of these transactions.
