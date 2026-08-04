# Little Swag Boxes URI-base release

This branch intentionally starts at historical source commit `02075c7723544cf5619257b27b97a3297b05b0b4`. That source does not reproduce the currently deployed mainnet ELF, so the release must not be represented as a verified match for the pre-upgrade executable. The accepted baseline risk is mitigated by two independent pinned container builds, identical ELF hashes, exact IDL compatibility checks, Rust tests, and cloned-mainnet Surfpool tests.

The release workflow publishes the patched ELF, source commit, build-image digest, tool versions, current IDL, historical IDL, and hash manifests. The two build jobs must produce byte-identical ELFs before the aggregate artifact is published.

`npm run archive:lsb-mainnet` records the finalized pre-upgrade ProgramData account and ELF, raw config bytes and decoded fields, authority and slot state, balances, and the collection's DAS URI inventory. It requires `HELIUS_API_KEY` and never reads signing material.

`npm run prepare:lsb-uri-base` is simulation-only by default. It constructs the fixed `set_uri_base` instruction and checks that the config PDA is its only writable account. `--print-only` emits the fixed instruction without RPC access. `--rollback` targets the old metadata root. The client rejects signing-material arguments, never signs, and never sends a transaction.

Mainnet deployment and setter execution are separate approval gates. The release ELF must be deployed using the exact program ID in the external secure signer environment only after the deployment transaction summary and preflight have been reviewed. After deployment verification and an old-box simulation, the setter transaction must be simulated and reviewed separately before external custody signs and sends it.

Rollback order is: set the URI base back to `https://assets.mons.link/drops/lsb`, then redeploy the archived live ELF if executable rollback is also required. The legacy metadata host must remain available indefinitely.
