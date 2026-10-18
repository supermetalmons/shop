# 111K benchmark history

The records below remain unchanged in commit `4aa970f95b42def9df35e743bbbfbbe09f9b8645`. They describe the original sources, compiler settings and harnesses. They were removed from the active tree when the collection was renamed; their hashes and measurements have not been rewritten.

| Evidence | Path at that commit | Git blob ID |
| --- | --- | --- |
| Original 14-configuration compiler comparison | `onchain/ethereum/benchmarks/compiler-settings.json` | `9f2ca987a8998618874723067b349d2323a66da2` |
| Delivery ordering and burn-first comparison | `onchain/ethereum/benchmarks/delivery-order.json` | `df7ce1364d6aa2a813f7ec0e995bd6a9445462db` |
| Ownership lookup and counter-packing comparison | `onchain/ethereum/benchmarks/ownership-counters.json` | `cddef6aa5aad793853df99ac2bb58b5cfd0c8422` |
| Rejected counter-packing candidate | `onchain/ethereum/benchmarks/counter-packing.patch` | `ae717af7ad732676f49cc12257887b9b61ce2f7c` |
| Historical delivery benchmark runner | `onchain/ethereum/scripts/benchmark-delivery.mjs` | `44aa5220bfbae842f6b5bd78a93b8d489d26d1bd` |
| Original methodology and reproduction instructions | `onchain/ethereum/README.md` | `0661bed27b0a660a8f551b411b61c61173b0f2a6` |

Read any original artifact with `git show <blob-id>`, or use its commit and path:

```sh
git show 4aa970f95b42def9df35e743bbbfbbe09f9b8645:onchain/ethereum/README.md
```

Use the exact revision and dependency/compiler versions named in each record to reproduce it in a separate checkout. Historical records may use former identifiers and domains. The current [compiler comparison](compiler-settings.json), [legacy/200 baseline](compiler-legacy-200.json) and [gas snapshots](../snapshots/NFT111KGasTest.json) describe the renamed collection.
