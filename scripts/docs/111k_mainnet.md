# 111k mainnet deployment and recovery

The registered Ethereum mainnet collection uses internal deployment ID `mainnet-v1`, contract `0x08cded8258730bda384ff198001e47a1b50f7f9d`, and base URI `https://cdn.mons.shop/111k/`. Token JSONs are flat decimal filenames, such as `1.json`, `111112.json`, and `117172.json`. Collection metadata remains `https://cdn.mons.shop/111k/collection.json`. The root belongs permanently to this contract.

## Current operations

The [15 November ownership handover](../../releases/111k-mainnet-v1/ownership-transfer-2026-11-15/README.md) nominated treasury Safe `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` and is awaiting its `acceptOwnership()` transaction. Read `owner()` and `pendingOwner()` before preparing owner actions. After acceptance, owner-only administration must execute through the Safe. The original deployment manifests retain the initial owner as historical evidence.

For artwork additions to the registered collection, use the [catalog expansion workflow](111k_reveal_ops.md#mixed-allocation). Discover the deployment's current catalog and registry revisions before preparing an operation, and resume matching bundles with their original journal revision. Preserve registration, publication, and transaction evidence. Generic metadata upload and restore reject registered prefixes.

The [mainnet release record](../../releases/111k-mainnet-v1/README.md) documents the original deployment and subsequent operations; each record describes its verification time. Read current sale settings, allowances, and prices through the [scoped mainnet APIs](111k_mainnet_vvv.md). The [v10 mixed release](../../releases/111k-catalog-v10/README.md) expanded the live v9 pool and preserved its metadata prefix and contract. The [November 19 duplicate painting correction](../../releases/111k-mainnet-duplicate-correction-2026-11-19/README.md) exchanged 268 free painting slots for eggs at allocation revision 3. Future API releases must retain the correction mappings when resolving mainnet slots.

Additional mainnet collections require a new globally unique deployment ID and a fresh `111k/<deploymentId>/` metadata prefix. Follow [metadata publication](111k_metadata.md#generate-and-publish), the [contract deployment guide](../../onchain/ethereum/README.md), and [reveal registration](111k_reveal_ops.md#operator-setup). Mainnet transactions and activation require explicit instructions.

## Existing transaction recovery

Preserve the original private release directory and encrypted keystore. Existing frozen release trees retain their original locations and bound paths; store new evidence according to the [local artifact policy](local_artifacts.md). An uncertain broadcast must be reconciled against its saved signed transaction; do not prepare a second deployment or replace its nonce, constructor settings, or metadata evidence. The `nft111k:mainnet` runner retains read-only verification and reconciliation of an already broadcast transaction after registration. Preparation, new signing, and first broadcast reject a registered deployment ID or metadata root.

The original closed-state verification checks the initial zero-issuance configuration. Subsequent issuance and owner configuration are recorded separately; use the applicable current operation's verification for live state. Private signed payloads, passwords, RPC credentials, and publication recovery snapshots stay outside public release artifacts.

## Completed root bootstrap

The one-time root bootstrap completed on 10 November 2026 with origin catalog `111k-v8`, 344,984 published token objects, and an original 344,948-object recovery snapshot. The contract was then registered and provisioned with minting closed and reveal inactive. These are historical deployment conditions, not current sale or reveal status.

The `bootstrap-mainnet-root` command and its exclusive implementation have been retired. Its [final source](https://github.com/supermetalmons/shop/blob/9735a11014183651d8a7ac982ca4e0cf30b87df1/scripts/ethereum-metadata/remote.ts), [original procedure](https://github.com/supermetalmons/shop/blob/9735a11014183651d8a7ac982ca4e0cf30b87df1/scripts/docs/111k_mainnet.md), and [matching lockfile](https://github.com/supermetalmons/shop/blob/9735a11014183651d8a7ac982ca4e0cf30b87df1/package-lock.json) remain pinned to `9735a11014183651d8a7ac982ca4e0cf30b87df1`. The release record links the same revision for historical inspection. Do not rerun the bootstrap against the registered root.

Keep the completed publication journal and original snapshot with the private release evidence. The bootstrap snapshot has a smaller original inventory and cannot be passed to generic `restore`. Retiring the command does not remove this recovery evidence or change ownership and publication fences.
