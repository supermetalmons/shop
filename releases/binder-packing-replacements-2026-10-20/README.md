# Binder packing replacements — completed 2026-10-20

The fixed operation `card-nft-binder-packing-2026-10-20` issued receipts 21 and 22
into the existing mainnet receipt collection and tree. The normal minter remains
15/15 with sales closed. Existing receipts, codes, and orders were preserved.

## Completed issuance

- Delivery order: `card_nft_binder:660215303`, containing receipts 21 and 22.
- Mainnet transaction: `U5TGLJufEyNa2Tv8ZsJEcYQieo71LLWS8bPQ6w94WNvxbkgrTwinvfPQaqHhvZ5EcK9YMJw8BVCsXGePgF32H5K`, finalized at slot `459348480`.
- API version: `ec07e4d5-e355-46d2-ad50-0490f288f2c9`; frontend version: `b87f5c65-8707-496b-91c2-963b06b3c336`.
- Live verification confirmed two unclaimed codes, valid receipt transfer proofs, packing-list visibility, and both code exports. All 20 original code mappings are unchanged.
- The private Worker preview used the existing signer without exporting its key. Its signing handler was replaced with HTTP 410 and the preview process stopped afterward.
- Public transaction, metadata, deployment, and validation evidence is in [issuance.json](issuance.json). Claim codes remain only in the commerce database and private operator journal/export.

## Current packing and claims

The order remains visible in Fulfillment as **Packing replacements**. Use its
individual code PNG downloads or **Download Secret Codes ZIP** for displayed
orders. [Fulfillment operations](../../scripts/docs/fulfillment_operations.md#packing-replacement-receipts)
describes the supported export path. Existing codes use the normal receipt claim
Workflow; they are not reissued or reset.

The private operator journal and `packing-codes.json` remain under
`~/Library/Application Support/mons-shop/binder-receipt-issuance/card-nft-binder-packing-2026-10-20/`.
They contain claim credentials and must remain outside this repository.

## Historical tooling

The completed issuance CLI, fixed-operation helpers, tests, and npm command were
removed from active tooling. Their matched source and dependencies remain in
commit `abb1e8b84fadae8d59af363e6b4a8117343f2dba`:

```sh
git worktree add --detach ../shop-binder-issuance-history abb1e8b84fadae8d59af363e6b4a8117343f2dba
```

Use that checkout only for historical investigation or exact private JSON export
reconstruction from the preserved journal. The current Fulfillment exports do not
need the old signing or database-publication code. Do not rerun issuance as a new
operation or discard an uncertain transaction journal.
