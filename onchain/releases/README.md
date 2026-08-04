# Poncho Drifella URI-base release

This branch intentionally starts at historical deployment source commit `bed32b4333b012f3ef36bc626638d8b1359a5572`. That source does not reproduce the currently deployed mainnet ELF with the available toolchain, so the release must not be represented as a verified match for the pre-upgrade executable. The accepted baseline risk is mitigated by two independent pinned container builds, identical ELF hashes, exact IDL compatibility checks, Rust tests, and cloned-mainnet Surfpool tests.

The release workflow publishes the patched ELF, source commit, build-image digest, tool versions, current IDL, historical IDL, and hash manifests. The two build jobs must produce byte-identical ELFs before the aggregate artifact is published.

`npm run archive:poncho-mainnet` records the finalized pre-upgrade ProgramData account and ELF, raw config bytes and decoded fields, authority and slot state, balances, and the collection's DAS URI inventory. It requires `HELIUS_API_KEY` and never reads signing material.

`npm run prepare:poncho-uri-base` is simulation-only by default. It constructs the fixed `set_uri_base` instruction and checks that the config PDA is its only writable account. `--print-only` emits the fixed instruction without RPC access. `--rollback` targets the old metadata root. The client rejects signing-material arguments, never signs, and never sends a transaction.

Mainnet deployment and setter execution are separate approval gates. The release ELF must be deployed using the exact program ID in the external secure signer environment only after the deployment transaction summary and preflight have been reviewed. After deployment verification and an old-box simulation, the setter transaction must be simulated and reviewed separately before external custody signs and sends it.

Rollback order is: set the URI base back to `https://assets.mons.link/drops/poncho`, then redeploy the archived live ELF if executable rollback is also required. The legacy metadata host must remain available indefinitely.

## Existing asset URI migration

The same combined ELF adds three admin-gated migration instructions for the fixed Poncho Drifella collection: collection URI migration, MPL Core asset URI migration, and Bubblegum v2 receipt URI migration. Together with `set_uri_base`, these are the only additions to the ten historical instruction interfaces. Every historical account type and discriminator and errors `6000–6048` remain unchanged; `InvalidMigrationTarget` is added at `6049`.

`npm run prepare:poncho-existing-uri-migration` is read-only. It requires `HELIUS_API_KEY`, verifies finalized mainnet state, enumerates the complete collection, rejects unknown metadata or authorities, and writes an exact target plan. `--simulate` simulates every required instruction; `PONCHO_SIMULATION_RPC_URL` can point those simulations at a cloned-mainnet Surfpool instance containing the candidate ELF. The planner never reads signing material.

`npm run migrate:poncho-existing-uris` is also read-only by default. After the release ELF, setter, and asset plan are separately approved, `--send` prompts for the admin private key using hidden terminal input. It simulates every transaction immediately before sending, batches the full Core target list globally in groups of 16, refreshes every compressed receipt owner and proof, tolerates only newly proven burns, waits for DAS indexing between receipt writes, and keeps an atomic resumable checkpoint. Final verification requires every submitted transaction to finalize, zero live legacy URI to remain, and the config bytes to remain identical.

The planning snapshot contained one collection, 119 live Core NFTs, 88 live compressed receipts, 254 burned Core records, and five burned compressed records. Those counts are observational because reveals stay live; every execution plan is rebuilt from finalized state and bound to its target list and direction by SHA-256. Burned records have no writable accounts and remain immutable historical DAS entries at the legacy base. The instructions are reversible: the config URI selects the target root, and only an exact URI at the opposite recognized root can be changed.
