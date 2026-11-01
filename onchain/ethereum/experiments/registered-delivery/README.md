# Registered delivery configuration experiment

This records the isolated comparison used to select registered configurations. The canonical implementation is now in `../../src/NFT111K.sol`; the original experimental source is frozen in `../../benchmarks/reference/registered-prototype.sol`. The tables describe the original study, whose signed-address implementation was current at the time. All study transactions used disposable local Anvil instances.

## Design

- The existing owner calls `registerDeliveryConfig(receiver1, receiver2, receiver2Bps)` before use. Configurations are immutable, have IDs starting at 1, and are capped at 32. A single receiver uses zero receiver2 and zero basis points; splits use distinct receivers and 1–9,999 basis points. Existing receiver restrictions remain.
- A delivery quote signs `configId` instead of two addresses and an amount. Redemption validates that ID and increments one full-width cumulative revenue counter. No packed counters, sentinel values, extra admin role, or mutable global delivery totals are used.
- `releaseDelivery()` is public and takes no arguments. It scans all configurations and pays both receivers' unpaid cumulative entitlements. The secondary receives `floor(totalReceived * receiver2Bps / 10000)` and the primary receives the remainder, less their respective previous payouts.
- Failed transfers retain their entitlements and do not block other receivers. The batch uses the same bounded-call pattern as mint payouts. `releaseDeliveryFor(configId, secondary)` is an optional permissionless fallback for a receiver requiring more callback gas; normal withdrawals require no arguments.
- Mint proceeds remain separate and retain `releaseAllMint()`. Registration and payout events identify the configuration. `deliveryConfigs(id)` exposes recipients, percentage, cumulative receipts, and paid totals; aggregate delivery reporting can be calculated offchain.

Fractional secondary entitlements carry across redemptions. For example, a 50% configuration receiving one wei twice ultimately assigns one wei to each receiver, whereas rounding each payment separately assigns both wei to the primary. Configuration changes require a new ID; existing signed quotes and funds cannot be redirected.

## Gas comparison

The [full report](../../benchmarks/registered-delivery.json) reruns the original global-receiver contract at commit `d37e03bc17db5fb6b08463f6a61c84c6a7335c2c`, the current uncommitted signed-address contract, and this prototype with Solidity 0.8.30, 500 optimizer runs, and Prague. All numbers are actual transaction receipt gas, including calldata and refunds. Every scenario repeats identically twice. Small differences from the earlier signed-address report reflect changed signature/calldata bytes in this run.

| Redemption | Original single | Current signed single | Current signed split | Registered single or split |
| --- | ---: | ---: | ---: | ---: |
| One crate, first redemption | 151,040 | 178,434 | 203,958 | 153,721 |
| One crate, pending proceeds | 116,840 | 127,146 | 135,570 | 119,521 |
| One crate, after withdrawal | 116,828 | 144,258 | 169,770 | 119,521 |
| 50 mixed items, first redemption | 2,467,066 | 2,494,502 | 2,520,014 | 2,469,752 |
| 50 mixed items, pending proceeds | 2,449,954 | 2,460,302 | 2,468,714 | 2,452,652 |

The original contract cannot split payments. Its column is a single-receiver baseline, not equivalent split functionality. Registered single and split redemption execute the same accounting path; split arithmetic happens during payout.

Registration is separate: the first single-receiver configuration costs 75,754 gas, and the first split configuration costs 98,124 gas. Collection deployment costs are 5,652,926 original / 5,710,607 current / 5,862,180 registered, using the report's constructor inputs.

| Full payout | Original single | Current implementation | Registered no-argument call |
| --- | ---: | ---: | ---: |
| One single configuration, first payout | 84,450 | 80,754 | 92,509 |
| One single configuration, repeat payout | 42,350 | 38,654 | 50,409 |
| One split configuration, first payout | Not supported | 144,408 (two transactions) | 149,327 |
| One split configuration, repeat payout | Not supported | 77,308 (two transactions) | 65,127 |
| Four split configurations sharing both receivers, first payout | Not supported | 144,408 (two transactions) | 360,305 |
| Four split configurations sharing both receivers, repeat payout | Not supported | 77,308 (two transactions) | 173,505 |

The current implementation combines credits by receiver across all orders. The prototype accounts and pays per configuration, so shared beneficiaries may receive several transfers in one batch. The report also covers distinct receivers, partially funded configurations, failures, and empty scans. With 32 split configurations and 64 distinct receivers, a first successful payout costs 4,034,433 gas; 64 callbacks consuming their full allowances cost 7,731,105 gas while preserving unpaid entitlements. Scanning 32 never-funded configurations costs 398,363 gas.

Derived first-cycle projections include one registration, repeated redemptions, and one complete payout, excluding collection deployment and NFT mint/unbox setup. For one reused configuration, the prototype overtakes the current implementation at approximately 10 single-receiver or 5 split redemptions per first payout. Including the additional collection deployment cost moves those estimates to approximately 30 and 14. These are projections from measured first/repeat operations, not executions of those entire sequences, and do not apply unchanged to multiple configurations sharing receivers.

## Limits and validation

The prototype runtime is **24,532 bytes**, leaving only **44 bytes** below EIP-170. The current implementation has 744 bytes of headroom. Maximum supported constructor data plus creation code is 35,506 bytes. Code-size enforcement remained enabled throughout the experiment. The tight runtime budget is a material maintenance constraint before adopting this design.

The 32-configuration lifetime cap keeps the no-argument payout loop bounded. The practical benefit is strongest for a small set of frequently reused configurations; one-off configurations and many shared-recipient routes can cost more overall. No packing or further idle-route optimization was attempted.

Seventeen isolated contract tests passed, including 256 fuzz cases, maximum-uint256 split arithmetic, cumulative rounding, owner registration and immutable IDs, signature tampering/replay/expiry, zero-fee redemption, failure/reentrancy handling, normal-gas fallback, mint separation, and the 32-configuration/64-callback bound. The comparison recorded 858 operation receipts and 746 registration receipts across repeated scenarios and verified beneficiary balances and existing-source hashes.

Run from the repository root:

```sh
npm --prefix onchain/ethereum run gas:delivery:history
npm --prefix onchain/ethereum run check
npm --prefix onchain/ethereum run gas:delivery
```

The experimental tests have been integrated into the canonical contract suite, including constructor configuration 1. The historical runner uses frozen references and writes a separate reproduction report. The active delivery benchmark uses the canonical registered contract, including its constructor-initialized configuration.
