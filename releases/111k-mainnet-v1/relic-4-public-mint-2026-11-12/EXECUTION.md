# Relic 4 mint execution — 12 November 2026

Relic **4**, ERC-721 token **117175**, was successfully minted on Ethereum mainnet to deployer `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` for exactly **2.44 ETH**. Exactly one additional public relic was minted. The cumulative public cap is **3**, public issuance is **3**, and no public mint capacity remains.

The collection is `0x08cded8258730bda384ff198001e47a1b50f7f9d`. This record covers the opening and paid mint only; any subsequent transfer is a separate operation.

## Confirmed transactions

Both transactions succeeded in block **26396112**, at adjacent transaction indices **53** and **54**. Both had **5 canonical confirmations** at the final verification snapshot, exceeding the required minimum of 3.

| Action | Transaction | Nonce | Block index | Gas used | Gas fee (ETH) |
|---|---|---:|---:|---:|---:|
| Open one slot with cumulative cap 3 at 2.44 ETH | [0x75e37319ff0901af821d2131368b2383562b40917ce7ed5e8375d1b352dda2a9](https://etherscan.io/tx/0x75e37319ff0901af821d2131368b2383562b40917ce7ed5e8375d1b352dda2a9) | 32 | 53 | 38212 | 0.000193274069195700 |
| Mint relic 4 | [0x698c788d1a05fd31dc907008f24e68267152c0931a0708c817248a0b8d30997f](https://etherscan.io/tx/0x698c788d1a05fd31dc907008f24e68267152c0931a0708c817248a0b8d30997f) | 33 | 54 | 102019 | 0.000516006156842775 |

Total gas cost was **0.000709280226038475 ETH**, within the approved **0.003 ETH** budget. The effective gas price was **5.057941725 gwei** for each transaction. The prepared limits were 60,000 gas for opening and 180,000 gas for minting, with 5 gwei priority and 10 gwei maximum fee.

## Verified outcome

- The opening event set public cap 3 and price 2.44 ETH.
- The paid mint event identifies deployer, relic 4, token 117175, exactly 2.44 ETH, and `freeMint=false`.
- The ERC-721 mint transfer sent token 117175 from the zero address to deployer. The recorded owner at verification block **26396116** was deployer.
- Public sale remains marked active, but its cap is exhausted: `limit=3`, `minted=3`, `mintable=0`. Global sale remains active.
- Reserved allocation remains 12, reserved claims remain 11, and deployer reserved allowance remains fully used at 2 of 2.
- The standby recovery-close transaction was **not submitted**. Deployer nonce was 34 at the verification snapshot.

The final verification snapshot is block **26396116** (`0x0ef87b57aca0b7fa259cc02541aa904ff1c5311b68ddedea79d4cc81c1e78031`), recorded at `2026-11-12T03:17:05.394Z`. Independent read-only verification at block **26396115** confirmed the exact unsigned payloads, independently encoded calldata, all three expected events, and four canonical confirmations.

## Evidence and preservation

- [execution-approved.json](execution-approved.json): user authorization and approved fee bounds.
- [execution-preflight.json](execution-preflight.json): execution-time mainnet snapshot.
- [execution-submission.json](execution-submission.json): public-RPC submission and acknowledgement record.
- [execution-verification.json](execution-verification.json): successful receipts, final state, and gas costs.
- [execution-independent-verification.json](execution-independent-verification.json): independent read-only checks.
- [checksums.json](checksums.json): original eight-file preparation manifest, preserved unchanged; all eight file hashes were reverified exactly.
- [execution-checksums.json](execution-checksums.json): completion evidence hashes and preparation-preservation verification.

The original preparation files, including the unsigned standby recovery transaction and historical simulation, remain unchanged.
