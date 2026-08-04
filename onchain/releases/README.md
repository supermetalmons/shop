# Mainnet program releases

The Card NFT 2 URI migration upgrades the active shared mainnet program. The live ProgramData payload is archived before deployment, but the historical executable is not reproducible because its deployment generated and deleted a temporary Cargo lock. This accepted baseline risk is mitigated by exact live-byte archival, IDL compatibility checks, two independent pinned-container builds, cloned-mainnet tests, and regression coverage for every sibling config.

The release workflow builds with the committed `mainnet-program-id` feature and the committed lockfile. It publishes the ELF, current and historical IDLs, compatibility manifest, source commit, build image digest, tool versions, and both independent build manifests. No deploy helper rewrites source or dependency locks.

All Card operators are read-only unless an explicit `--send` flag is present. Program deployment, the config setter, and asset migration are separate approval gates. Mainnet send paths prompt for the authority through hidden terminal input and reject signing material in arguments or environment variables.

Existing assets are updated directly through their Metaplex authorities. The planner strictly validates the fixed collection, raw Core accounts, exact compact paths and IDs, receipt tree, ownership, and fresh proofs before producing a checksummed plan. Burned records remain immutable at the legacy root, so the old host must stay available indefinitely.

Direct Core updates use the existing Card address lookup table and batches of ten. A live serialized-transaction gate showed that ten updates occupy 1,198 bytes, while eleven occupy 1,296 bytes and exceed Solana's 1,232-byte packet limit. The earlier 16-asset estimate is superseded; the pre-freeze snapshot's corrected maximum is 1,746 transactions, and the live planner always derives the final count from current targets.
