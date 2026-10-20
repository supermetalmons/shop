# 111K Sepolia discount release

The discount collection is deployed and open on Ethereum Sepolia, chain `11155111`. Its [source](https://sepolia.etherscan.io/address/0x4b3a94a144fe99954c5d55f870081e40b360cfbf#code) is verified on Etherscan with an exact match. The [previous collection](../111k-sepolia/README.md) remains active and its renderer is reused.

Contract source revision: `48b7a57311a5089f5ea105c75ad663e80e9bc8df`. The [source manifest](source-manifest.json) records byte-identical frozen Solidity sources, compiler-input/artifact hashes, five constructor arguments, and allowlist provenance. The earlier freeze-time HEAD is recorded separately as `4415c1a4616727980f9353accce7ccd73a4cdd19`.

| Contract | Address | Deployment block |
| --- | --- | --- |
| Discount collection | [`0x4b3a94a144fe99954c5d55f870081e40b360cfbf`](https://sepolia.etherscan.io/address/0x4b3a94a144fe99954c5d55f870081e40b360cfbf) | 11957341 |
| Reused renderer | [`0x08cded8258730bda384ff198001e47a1b50f7f9d`](https://sepolia.etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d) | See the previous release |

The owner and treasury are `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`; the quote signer is `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`. The discount root is `0x8f11db52cdc1977aaf2417edf0e40f2ac9e4adebef100b84aeda2bb705790f3b`, with 318 eligible wallets and one discounted crate per wallet at 0.00005 test ETH. Public crate and warehouse prices remain 0.0001 and 0.0011 test ETH.

The [deployment record](deployment.json) includes deployment, pause and opening receipts with at least three canonical confirmations. [Open-sale verification](deployment-open.json) observed zero supply at block 11957406, the expected owner/signer/treasury/renderer, all ten wallet stats, and all five metadata types. The prior sale was still active. [Explorer verification](etherscan-verification.json) records the exact source match.

## Application rollout

| Service | Version | Source revision |
| --- | --- | --- |
| API | `3d115092-be08-4b08-86e6-f22d0cad8ef6` | `48b7a57311a5089f5ea105c75ad663e80e9bc8df` |
| Frontend | `e90f533e-2845-4285-b12e-61a3798d26e2` | `48b7a57311a5089f5ea105c75ad663e80e9bc8df` |

The [application release record](application-release.json) contains deployment evidence and live API checks. During maintenance, new-collection reads remained available while all four fulfillment mutation endpoints returned 503. After cutover, the API reported the new contract enabled, sale open, the correct discount configuration, and empty inventory. Health and the unrelated `card_nft_2` endpoint passed both checks.

Commerce migration `0041_ethereum_111k_control.sql` was applied. The full Commerce deployment gate checked 15982 authoritative records. The scoped reset `28fa6ce8-9032-4b5e-8e87-6404287ec20f` completed for the old Sepolia collection and `111k_devnet`. Its database update at 2026-10-20T19:31:16.000Z followed the recorded drain deadline of 2026-10-20T19:30:58Z. The [reset verification](reset-verification.json) records cleared old-scope counts, unchanged shared profiles/addresses, preservation of existing authentication rows, retained tombstones, unchanged unrelated drops/native scopes, and active global Commerce authority. Final Ethereum control points to the new collection with maintenance disabled.

The initial authentication comparison failed because the anonymous-session table gained new guest sessions. The independent audit preserved in the reset report found all 1456 baseline anonymous sessions byte-identical, plus 3 sessions created after the baseline. Other authentication tables were unchanged. The literal full-table digest changed; the corrected acceptance check verifies preservation of existing authentication rows.


## Acceptance

The [read-only mint simulations](mint-simulation.json) passed five cases: one discounted crate for the explicit extra wallet, allowance rejection for two discounted crates, rejection of a tampered proof, and public crate/warehouse purchases by a wallet outside the allowlist. The helper signed and broadcast no transactions; stats, supply, sender balances and nonces remained unchanged.

Validation passed 115 non-gas contract tests, 108 gas cases, 10 gas regressions, 6 snapshot-generator tests, 4082 root tests, 2442 API tests, 36 native Worker tests and 35 Rust tests, plus the Anvil lifecycle suite. Type checks, generated schema/ABI checks, dead-code checks, build, credential scan, API dry run/startup and frontend dry run passed.

The browser acceptance checks passed; their observed details are recorded in the application release record.

The scheduler verification passed; its observed details are recorded in the application release record.

The deployed proof asset matched the local release asset; the comparison is recorded in the application release record.
