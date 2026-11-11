# Closed 111k mainnet deployment

The first Ethereum mainnet collection uses internal deployment ID `mainnet-v1` and base URI `https://cdn.mons.shop/111k/`. Token JSONs are flat decimal filenames, such as `1.json`, `111112.json`, and `117172.json`. Collection metadata remains `https://cdn.mons.shop/111k/collection.json`. Registering the root permanently assigns it to this contract.

This runbook records the initial bootstrap with origin catalog `111k-v8`. For an existing registered mainnet deployment, use the [catalog expansion workflow](111k_reveal_ops.md#adding-artworks-and-cutting-off-eggs) to apply the current catalog. Preserve the original registration and publication evidence; do not rerun the bootstrap.

This workflow ends with minting closed, zero relic allocation, zero issuance, and reveal provisioning ready but inactive. It does not switch the storefront from Sepolia. Do not run the Sepolia replacement runner, reserve/open commands, or live mint/unpack QA for this release.

## Frozen constructor configuration

- Chain ID: `1`.
- Deployer, owner, and initial delivery receiver: `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`.
- Quote signer: existing pre111k mainnet signer `0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea`.
- Proceeds: exact fourteen-recipient split from `onchain/ethereum/config/proceeds.json`.
- Discounted-mint lifetime cap: `500`, from the mainnet entry in `config/discount-caps.json`.
- Initial free allocations: empty generic `config/free-mints.json`; never use the Sepolia preset.
- Discount root: current 318-wallet `src/ethereum/discounts/111k.json`; allowance starts at one.
- Initial prices: 0.0001 ETH per crate, 0.0011 ETH per warehouse, and 0.00005 ETH per discounted crate.
- Deployment fee ceiling: `2000000000000000` wei (0.002 ETH), with zero transaction value.

The proceeds split and discount cap cannot change after deployment. Owner settings, including prices and allowances, can be configured later while the sale remains closed.

## Metadata preparation

Generate and validate one fresh revision directory. Inventory the mainnet root and confirm that neither it nor `mainnet-v1` is registered. Historical root metadata can have older templates and lack the 36 relic and relic-receipt files.

Use the explicit `bootstrap-mainnet-root` metadata command. It snapshots the existing token files under the publication lease, creates missing approved files, conditionally updates observed files, and preserves collection metadata and child namespaces. Resume interrupted publication with the original directory and snapshot. Unexpected changes stop publication. Ordinary root upload is not a substitute for this operation.

```sh
metadata_dir="$PWD/.cache/111k-mainnet-v1-release/published-metadata"
npm run ethereum:metadata -- generate --directory "$metadata_dir"
npm run ethereum:metadata -- validate --directory "$metadata_dir"
npm run ethereum:metadata -- bootstrap-mainnet-root --network mainnet --directory "$metadata_dir"
npm run ethereum:metadata -- verify --network mainnet --directory "$metadata_dir"
```

Generate only once; retries reuse the completed revision. Supply the existing R2 and OPS credentials through the environment as described in the [metadata runbook](111k_metadata.md#generate-and-publish).

Verify all 344984 token objects and public boundary URLs against the generated manifest. Check the shared collection JSON separately. Observe the 65-second publication drain before registration, including after interrupted writes. Keep the original snapshot and resumable journal with the private release evidence.

The bootstrap snapshot can contain fewer files than the new collection. It is recovery evidence for this operation and cannot be passed to generic `restore`.

## Prepare, sign, broadcast, verify

Use one dedicated private release directory and keep the encrypted keystore outside it. Commands run from the repository root:

```sh
release_dir="$PWD/.cache/111k-mainnet-v1-release/contract"
npm --prefix onchain/ethereum run nft111k:mainnet -- prepare --directory "$release_dir" --deployment-id mainnet-v1
npm --prefix onchain/ethereum run nft111k:mainnet -- sign --directory "$release_dir" --keystore /path/to/encrypted-keystore --password-file /path/to/temporary-password
npm --prefix onchain/ethereum run nft111k:mainnet -- broadcast --directory "$release_dir"
npm --prefix onchain/ethereum run nft111k:mainnet -- verify --directory "$release_dir"
```

Supply RPC credentials through the environment. Recover the existing keystore password through the established Keychain workflow into a private temporary file, delete that file after signing, and never place keys or passwords in command arguments or reports. Preparation freezes sources, compiler settings, constructor arguments, configuration hashes, nonce, predicted address, and gas allowance. Sign only after complete metadata verification. If funding is insufficient or the buffered offer exceeds 0.002 ETH, wait for funding or a qualifying estimate; never raise the ceiling automatically.

Preparation, new signing, and first broadcast also require OPS read credentials and reject an already registered deployment ID or metadata root. An unavailable registry blocks these actions. Read-only verification and reconciliation of an already broadcast transaction remain available after registration.

Signing saves the exact transaction before broadcasting. Reuse the same directory after an uncertain response; reconcile that transaction instead of deploying a second contract. Verification requires three canonical confirmations, exact runtime and constructor values, correct mainnet EIP-712 domain, clean metadata URLs, disabled public relic minting, and zero issuance, reservation, usage, and revenue. Verify sources on mainnet Etherscan and Sourcify using the frozen compiler input.

## Reveal registration and completion

Create the registration manifest with `deploymentId: "mainnet-v1"`, `dropId: "111k"`, `chainId: 1`, the receipt's contract address and deployment block, `metadataBaseUri: "https://cdn.mons.shop/111k/"`, catalog `111k-v8`, and the complete publication directory. Dry-run registration before writing it. Observe the scheduler and provisioning until status is `ready`; do not activate reveal or open the sale.

Record the contract address, transaction, block, constructor configuration, metadata checksums, source verification, and final closed-state checks in a sanitized release record. Private transaction bytes, keystores, passwords, RPC credentials, and publication recovery snapshots stay outside public artifacts. No testnet retirement or storefront cutover belongs to this task.
