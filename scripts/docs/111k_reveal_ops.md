# 111K reveal operations

This runbook covers Mons deployment and maintenance. Share the standalone [VVV integration guide](111k_reveal.md) with partners.

## Operator setup

Each registered chain/contract has an independent 111111-asset pool and permanently owns one metadata prefix. New prefixes are `111k-sepolia/<deploymentId>/` and `111k/<deploymentId>/`; the existing Sepolia collection retains `111k-sepolia/`. Never reuse a registered prefix for a replacement contract. Apply OPS migrations before publication or reveal operations.

For a fresh prefix, publish and verify the complete generated, validated placeholder collection:

```sh
npm run ethereum:metadata -- upload --network sepolia --prefix 111k-sepolia/sepolia-test-2/ --directory <generated-directory>
npm run ethereum:metadata -- verify --network sepolia --prefix 111k-sepolia/sepolia-test-2/ --directory <generated-directory>
```

Initialization creates missing objects with conditional writes and rejects differing contents. Resume with the same revision directory. Legacy publication commands still support the original bare prefixes before reveal registration. After any upload or restore that attempted writes, wait 65 seconds before another mutation or registration for that prefix, including after a failed command.

Deploy the contract with the exact deployment-specific `ETHEREUM_111K_METADATA_BASE_URI`, then record its address and deployment block from the receipt. Registration checks the chain, creation block, deployed code, and exact onchain `baseURI()` before permanent ownership is recorded. Provisioning repeats those checks before marking the deployment ready.

Reveal registrations are independent of the API's global `ETHEREUM_111K_*` storefront configuration. Keep those variables on the current Sepolia or local collection when registering an additional deployment, including mainnet. Change the global contract, chain, metadata URL, and deployment block together only when replacing the supported storefront collection. Mainnet reveal registration does not enable a mainnet storefront configuration.

## Registration and credentials

The operator needs the existing Cloudflare D1/R2 credentials for registry and publication access. New registration also needs `ALCHEMY_MI_NOTE_API_KEY` for read-only chain verification. The CLI resolves that key from the invoking environment, then repository-root `.env.local`, then `.env`. It selects the Alchemy network from the manifest's chain ID and does not change storefront configuration or print the key. Status, state transitions, and unchanged registrations do not require RPC credentials.

Create a private local manifest:

```json
{
  "deploymentId": "sepolia-test-2",
  "dropId": "111k_devnet",
  "chainId": 11155111,
  "contractAddress": "<deployed contract address>",
  "metadataBaseUri": "https://cdn.mons.shop/111k-sepolia/sepolia-test-2/",
  "deploymentBlock": 12005467,
  "catalogVersion": "111k-v1",
  "publicationDirectory": "./published-metadata"
}
```

Replace the address and deployment block with the actual receipt values. `publicationDirectory` is required for new registrations and is relative to the manifest. It must contain the complete generated and validated publication, including `templates/artwork.json`. Registration verifies the entire remote inventory and public samples against that snapshot. An optional `templateFile` must match the snapshot exactly. Mainnet uses chain ID `1`, its own contract, and its own `111k/<deploymentId>/` prefix.

```sh
npm run ethereum-reveal-control -- register --manifest <manifest.json>
npm run ethereum-reveal-control -- register --manifest <manifest.json> --write
npm run ethereum-reveal-control -- status --deployment-id sepolia-test-2
npm run ethereum-reveal-control -- activate --deployment-id sepolia-test-2 --expected-revision <revision> --write
```

The dry run verifies both publication and onchain identity without changing registry, leases, or remote metadata; publication verification can update its local report. The write path acquires a read-only publication lease, verifies publication and chain identity, then retires and atomically checks that exact lease owner when inserting the permanent record. Any validation failure leaves the prefix unregistered. An unchanged existing registration returns idempotently without requiring publication or RPC verification; changed immutable settings are rejected.

Registration transfers the entire prefix to the reveal publisher permanently. Generic metadata upload and restore subsequently refuse writes, including receipt files and paused deployments. Registration preserves the template and checksum. The scheduled watchdog starts provisioning within its five-minute cycle; Durable Object alarms continue it from `provisioning` to `ready`. There is no separate provision command. Activate only after status reports `ready`, using its current revision. Registration does not reveal historical tokens automatically; requests admit that work.

## Publication and recovery

Generic publishers renew OPS leases through bounded asynchronous queries. Every write and SDK retry checks the lease deadline; failed renewal aborts outstanding writes. A write lease retains a 65-second drain marker on close because an aborted storage request can still complete remotely. A crashed publisher's lease expires after two minutes, followed by the same drain period. Read-only registration verification transfers its lease without a write drain. Registry failures block publication.

Confirmed assignments and metadata bytes are frozen before publication. The publisher uses conditional writes, retries temporary failures through durable jobs, and keeps publication separate from chain polling. Bounded batches continue through alarms without requiring a browser to remain open. An existing object must match either the approved placeholder or the exact frozen metadata; other content is quarantined as a conflict.

Each publication run drains successive batches of eight until five seconds or 512 jobs have been processed, then schedules any remaining work. There is no alarm delay between batches within a run. The ledger's one-time recovery repair rechecks previously admitted work and preserves frozen assignments and publication records; it reconstructs crate scope only from retained transaction-associated evidence.

The status command's `lastError` reports `publication-unavailable` while retryable writes remain, and clears after recovery. `metadata-conflict` requires investigation without overwriting the object or ledger. Logs contain deployment/token identities and retry counts, not private assignments or media URLs. API responses can show artwork before its CDN JSON or marketplace copy updates.

The Worker guardrails allow 10,000 new-work admissions and 120,000 total reveal requests per minute per origin/IP pair. Cloudflare applies approximate per-location counters. Keep `Retry-After` exposed through CORS; no partner key is required.

Transaction tracking without unpack evidence is capped at 10,000 entries per collection and expires after 15 minutes; polling does not renew that lifetime. Already tracked recent failed receipts remain watched until 64 confirmations and count toward the same cap. Verified crate recovery and frozen artwork are retained. At capacity, the API verifies new hashes before saving them: verified unpacks still proceed, while unresolved hashes return `pending` for the client to retry. Cleanup runs in bounded batches, including for older ledgers.

## Pausing, replacement, and local development

```sh
npm run ethereum-reveal-control -- pause --deployment-id <id> --expected-revision <revision> --write
npm run ethereum-reveal-control -- activate --deployment-id <id> --expected-revision <new-revision> --write
```

Pausing stops new admission while previously admitted recovery/publication continues. Frozen results remain readable. Preserve retired deployment records, private reservations, frozen assignments, and metadata objects. Commerce reset does not delete reveal state. Never reset a production reveal object or restore an older ledger without reconciling every published immutable assignment. Use a fresh contract and prefix for a replacement collection.

`npm run dev:ethereum:api` provisions local Anvil reveal inventory automatically. Local bindings use isolated SQLite and R2; public CDN baseline metadata reads remain read-only. Restarting the local API discards its local reveal state, so restart Anvil and redeploy the contract together. Custom local prefixes must be canonical and have published baseline metadata. Local artwork is checked against its local ledger even if another collection has already revealed the shared CDN metadata.
