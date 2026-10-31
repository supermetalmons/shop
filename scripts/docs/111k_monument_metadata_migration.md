# 111K monument metadata wording migration

This dedicated migration renames existing container metadata on both CDN network roots while preserving historical URLs and all previously published editions. It updates only token IDs 117172–117201, including legacy editions 19–30. Fresh collections use the separate 18-monument generator and publication workflow.

Use the existing R2 credentials accepted by `ethereum:metadata`, plus Cloudflare access to read the OPS deployment registry and acquire publication leases for unregistered previews. Credentials stay in the invoking environment. The bucket is restricted to `cdn-mons-shop`.

Run the migration before publishing or registering another namespace. Discovery includes both roots, every canonical child namespace returned by paginated R2 listing, and all registered mainnet/Sepolia prefixes. A changed namespace set, object-key coverage, or immutable deployment identity invalidates the saved plan.

```sh
npm run ethereum:metadata:rename-monuments -- plan --directory .cache/111k-metadata/monument-wording-v1
npm run ethereum:metadata:rename-monuments -- apply --directory .cache/111k-metadata/monument-wording-v1 --write
npm run ethereum:metadata:rename-monuments -- verify --directory .cache/111k-metadata/monument-wording-v1
```

`plan` performs no remote writes. Its immutable `plan.json` records each prefix's inventory count and key checksum, deployment identity, and every existing legacy container's original/proposed bodies, byte lengths, MD5s, and SHA-256s. It rejects unexpected names, type traits, malformed metadata, or legacy wording outside the approved name/type fields. Inspect the exact object changes before applying. Existing plans cannot be overwritten; choose a new directory when the scope changes.

`apply` requires `--write`, rechecks the saved scope, and accepts only the saved original or proposed bytes. Each update uses the original ETag as an `If-Match` condition. Missing objects are never created, and no objects are deleted. Preview namespaces use ordinary publication leases, including their 65-second post-write drain. Registered namespaces use only the dedicated legacy-container operation: the reveal publisher can write artwork IDs 1–111111, so its frozen artwork and receipts remain outside this operation. The standard publication/restore guards and OPS ownership triggers remain unchanged.

The append-only `journal.jsonl` binds completions to the plan checksum. Repeating the same apply command resumes interrupted work and skips exact already-renamed bytes. An ambiguous storage failure can be retried the same way. Concurrent unrelated changes stop the operation instead of being overwritten. An incomplete final journal record is truncated on resume; invalid completed records remain errors.

`verify` checks every affected object's exact R2 and public HTTP contents, JSON content type, `Cache-Control: no-store`, wildcard CORS, and absence of cache hits. It also repeats namespace/coverage and registry-identity checks. Save its `verification.json` and `apply-report.json` as additive release evidence before starting the fresh deployment publication.

Historical publication checksums and release manifests describe their original bytes and must remain unchanged. This migration's reports explain the intentional difference. The current collection verifier cannot validate old 30-edition inventories after the canonical cap changes to 18; use this migration's saved-object verifier for historical container changes. Artwork templates and their immutable registry hashes are never changed.

```sh
node --import tsx --test tests/ethereumMonumentMigration.test.ts
npm run typecheck:tools
```
