# Mi Note preorders and inventory

Mainnet `/mi_note_cards` minting and unpacking are live. The mainnet drop has
627 two-card packs at 0.5 SOL; devnet has 704 two-card packs at 0.25 SOL. Stripe
is disabled for both. The separate `/wip` routes remain available. The canonical
configuration is `shared/deploymentRegistry.ts`.

Preorder checkout is closed on both networks. Completed preorder conversions
retain their original card IDs, asset addresses, ownership, and permanent public
inventory exclusions. See [the mainnet release](../../releases/mi-note-cards/README.md)
and [conversion evidence](../../releases/mi-note-cards/preorder-upgrade/README.md).
Public metadata uses `/nft/mi_note_cards/json/` on mainnet and `/json/pre/` on
devnet; the [metadata record](../../releases/mi-note-cards-mainnet/README.md)
defines filenames and source mappings.

## Existing-order recovery

Both configurations in `shared/preorders.ts` have `checkoutEnabled: false`
while keeping `enabled: true` for inventory recognition and recovery. The API
rejects new preparations and initial submissions of prepared orders with HTTP
409, `failed-precondition`, and "Preorders are closed for this collection."
It does so before preparing or cosigning transactions. Status, cancellation,
and reconciliation remain available; submitted retries use their stored signed
transactions, and unsigned reservations expire normally. Existing purchases,
order history, and permanent card claims remain intact. Closure requires no
database migration or on-chain changes.

Signed-in buyers still discover submitted orders without local recovery data.
While checkout is closed, a successful status check clears unsigned local
preparations instead of keeping them alive for a checkout that cannot resume.

The storefront has no preorder purchase gallery, availability flow, or signing
UI. Recovery does not require Ethereum verification. The server retains its
preorder protocol, stored signed transactions, and scheduled reconciliation.
Submitted transactions retain reservations until finalized success, failure,
or verified expiry. Confirmed assets appear in inventory while finalization
continues in the background. A finalized successful card ID remains permanently
claimed even if its NFT is later transferred or burned.

Each confirmed order has its own recovery record, scoped to its Solana buyer,
network, collection, and order ID. Recovery continues across shop routes and resumes
after reloads and while a restored signed-in owner has no wallet connection;
server discovery restores outstanding confirmations if local storage
is cleared. Discovery reads the foreground order and recovery page from one database
snapshot without waiting for foreground RPC
checks. Foreground submissions are checked every second, background recoveries
every three seconds while the page is visible, with bounded concurrency and backoff
after provider errors. Finalization does not repeat the success notification.
Only a verified failure or expiry reverses the affected order's artwork and inventory
and displays an error. Slow finalization and RPC timeouts never release card claims
or undo a confirmed purchase. Historical errors are not replayed after local storage
has been cleared.

Status, cancellation, and recovery use Solana authentication and remain
available after Ethereum verification expires or the Ethereum account changes.
Failed status lookups preserve local markers. A marker indicating a possible
submission remains until the server resolves its outcome. Recovery rejects late
results from a previous wallet, collection, or newer order in another tab.
Unsigned orders created before Ethereum verification was introduced must be
cancelled or expire. Already-submitted orders keep recovering normally.

For devnet testing only, the authenticated Solana buyer
`A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz` gets the following inventory
instead of real holdings after verifying the corresponding Ethereum wallet:

| Ethereum wallet | Eligible card IDs |
| --- | --- |
| `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE` | 1–10 |
| `0x5BFce4149F520FE0823Dc8C0aFaF979121e824EC` | 11–20 |

These fixtures remain available through the server ownership endpoints. Other
wallet combinations and all mainnet requests use real holdings. They do not
reopen preorder checkout.

Preorder configuration lives in `shared/preorders.ts`; the catalog's
`clean_card_id` remains the permanent identity. Converted assets appear as normal
cards. Unconverted assets retain preorder metadata and their existing visibility
rules. Inventory previews use the hosted catalog assets.

Optimistic inventory entries use the actual asset addresses and remain separate
from cached inventory. Owned assets stay visible and recoverable until both a
finalized account read and the collection index confirm them. Finalized reads can
remove transferred or burned assets immediately. Stale indexer results cannot
restore them without a newer finalized ownership check. Recovery records retain
each account read's slot and reject older or conflicting same-slot evidence. Older
successful orders without a stored mint slot retain indexed items; direct account
recovery can still add verified owned assets. Finalized receipts apply even while
local order status is catching up, including when the owner is signed out. Unsupported browser storage versions are
discarded. Current-format recovery records retain their ownership evidence; no
legacy importer runs. Tab-local fallback records incorporate newer shared
ownership evidence and terminal outcomes while keeping their writes isolated.
Inventory is installed before its
overlay is retired, preserving selections. Preorder and ordinary mint recovery
share the bounded lookup budget; unresolved preorders do not depend on a fixed TTL.

Apply all checked-in migrations and release the API before the frontend, following
[the Cloudflare deployment runbook](cloudflare_deployment.md). Fresh databases use
[Commerce bootstrap](commerce_operations.md#initialize-an-empty-database).
The existing `COSIGNER_SECRET` must match the collection authority; no additional signing secret is required.
Preorder expiry atomically releases an unsigned reservation's claims when its
order expires. Availability is a read-only view that ignores expired unsigned
reservations in enabled collections. Preparation and scheduled reconciliation
expire stored reservations and release their claims.
Both existing collections remain enabled for recognition and recovery, with
checkout disabled separately. Preparation, broadcasting, blockhash validation,
and reconciliation verify the RPC genesis
hash against the configured devnet or mainnet cluster.

If an old submitted preorder stays unresolved after the RPC prunes its history,
use the recovery command with a trusted archive for that order's devnet or
mainnet cluster. Set
`PREORDER_ARCHIVE_RPC_URL` in your shell (keep any RPC credentials out of command
arguments), then preview and apply the verified result:

```bash
npm run recover-preorder -- <order-id>
npm run recover-preorder -- <order-id> --write
```

Recovery validates the stored collection and cluster against the enabled
configuration and checks the archive RPC's genesis hash. It verifies the exact
finalized transaction, or proves expiry by checking
absent assets and complete, linked finalized blocks across its possible landing
window. Missing history, RPC errors, or an uncertain outcome preserve the
reservation. Successful purchases keep their permanent card claims. The command
does not sign or broadcast transactions, and has no force-unlock option. If a
database write is interrupted, rerun the same command to finish claim cleanup.
Normal status polling does not invalidate verified recovery; a change to the
submission or its confirmation evidence still blocks an outdated recovery write.

## Ethereum ownership and catalog

The root `mi_note_cards.json` is the shared catalog. Its `ethereumCollections`
contains the three existing Ethereum collections used by server ownership
checks and eligibility. Partial provider failures cannot authorize cards whose
ownership could not be checked. The devnet test inventory is restricted to its
configured admin buyer.

Its `specialCards` list contains IDs 1401–1408, which are excluded from preorder
eligibility. The generated preorder
IDs are 1–1400 and 1409–1430, totaling 1422 cards; the next
unallocated card ID is 1431. Shared validation and the database exclude the
reserved special IDs from preorder eligibility.

For catalog additions, edit `mi_note_cards.json`, then run:

```bash
npm run generate:db
npm run check:db-generated
```

Generation extracts ordinary `clean_card_id` values into
`shared/preorderCardIds.generated.ts` and appends an insert-only Commerce migration.
It rejects duplicate IDs, special-card overlap, and removals. Existing migrations
are immutable; repeated generation without catalog changes produces no changes.
The catalog table and its foreign key preserve permanent claims and reservation
guards.
Review the generated files, run the API and frontend checks, then release the
database and API before the frontend.

Holdings and preorder availability endpoints require Ethereum verification,
derive the address from its session, and scope results to that wallet. The
holdings endpoint is `GET /mi-note-cards?preorderId=...`; verification uses
`POST /mi-note-cards/auth/challenge`, `/verify`, and `/logout`. Availability uses
`GET /preorders/availability?preorderId=...` for Ethereum-only browsing and
`POST /preorders/availability` with `{ preorderId }` for signed-in Solana
sessions, preserving the usual Origin and CSRF checks. Challenges are single-use,
expire after five minutes, and bind the wallet, origin, collection, nonce, and
expiration. A valid `personal_sign` signature establishes a one-hour session sent
through `X-Mi-Note-Session`; Ops D1 stores only its secret's hash. These endpoints
remain server interfaces and are not used by the recovery-only storefront.
The Worker reuses these concurrent ownership lookups:

- Alchemy NFT API v3 on Ethereum Mainnet queries Mi Note 2 contract
  `0x8ffc6bfbce284b508f0e53b8599f8f03ffeb452f` and Mi Note 3 contract
  `0xc22bd85e6d6c058226f46a693f0df4054496db5b` in one paginated lookup.
- OpenSea queries the `minote` collection for original Mi Note on the shared
  ERC-1155 contract `0x495f947276749ce646f68ac8c248420045cb7b5e`, retaining only
  the 166 original catalog IDs.

The JSON envelope contains `ok`, `tokenIdsByContract`, and `resultsByContract`,
with all three contract keys. Token IDs are distinct within each contract; the
same ID can belong to several collections. Successful results identify their
provider and include `visibilityLimited`: false for Mi Note 2 and 3 from
Alchemy, true for original Mi Note from OpenSea. OpenSea's account index can
omit hidden NFTs even when auto-hidden items are requested. Collection
failures have an empty token list and an error result. If every collection
fails, the endpoint returns 502 or 504.

Successful collection results, including empty lists and provider metadata,
are cached separately for 60 seconds per normalized address and contract using
cache version 4. Cached results must match the collection's assigned provider.
Browser responses use `no-store`. Failures are never cached. All collection
lookups share a 30-second deadline; provider pages are limited to 256 KiB,
100 pages, and 10,000 returned token IDs overall. Client cancellation propagates
to unfinished lookups.

Use the Alchemy app `mons.shop` (app ID `ypzq1to6uyb32l8q`) with Ethereum Mainnet
enabled and configure its key as the `ALCHEMY_MI_NOTE_API_KEY` Worker secret
using [the Worker secret procedure](cloudflare_deployment.md#worker-secrets). Configure the OpenSea key as `OPENSEA_API_KEY`
on the same Worker. Both keys belong only in the API Worker.
For local live verification, provide them through the process environment or
an ignored `.dev.vars` file in `cloud/workers/api/`, start the API Worker
locally, and set `VITE_MONS_API_ORIGIN=http://localhost:8787` for the frontend.
Apply the database migrations and deploy the API Worker before the frontend so
the authentication endpoints and ownership enforcement match the current schema.
