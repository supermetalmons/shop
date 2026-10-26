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

## Retained checkout and recovery

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

The retained preorder protocol supports up to three eligible cards in one
transaction when checkout is enabled. Each costs 0.25 SOL, split equally between
the two configured recipients; the buyer also pays NFT creation and network costs.

When checkout is enabled, buyers connect an Ethereum wallet and sign the
server-issued message with `personal_sign` before viewing eligible cards.
Each challenge is single-use, expires
after five minutes, and binds the wallet, shop origin, preorder collection,
nonce, and expiration. Verification lasts one hour. The browser stores the
session in `sessionStorage` and sends it with `X-Mi-Note-Session`; Ops D1 stores
only the session secret's hash. Ethereum verification is independent of the
shop's Solana sign-in. Cached browsing results never authorize a purchase:
the API checks fresh Ethereum ownership both when preparing the order and
before adding the collection signature.

Preorder checkout uses the shop's Solana wallet sign-in and requires a buyer
wallet different from the collection authority. The wallet signs the prepared
transaction without broadcasting it; the API adds the collection signature,
records the fully signed transaction, and broadcasts it. Reservations start at
checkout, last at most 120 seconds before submission, and cannot be extended by
retrying. Each order records its verified Ethereum wallet, and one unconfirmed
checkout is allowed per Solana buyer and preorder collection. Preparation and initial
submission require both the recorded Ethereum identity and the Solana buyer.
Submitted transactions retain their reservations until finalized
success, failure, or verified expiry. Once the server verifies successful
`confirmed` execution, the shop shows its normal Preordered success, updates the
artwork and inventory, and allows another preorder when checkout is enabled.
The order remains submitted internally while finalization continues in the background. Status polling
and scheduled reconciliation recover interrupted purchases. A finalized successful card ID can never be purchased again,
even if its NFT is later transferred or burned.

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
An active order for another Ethereum wallet can be cancelled or resumed after
switching back; its card thumbnails are hidden from the current wallet.
An unresolved preparation offers **Abandon preparation**, which rechecks the
server before clearing the local request. Any recovered order stays available
for cancellation or confirmation; possible submissions are never discarded.
Unsigned orders created before Ethereum verification was introduced must be
cancelled or expire. Already-submitted orders keep recovering normally.

For devnet testing only, the authenticated Solana buyer
`A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz` gets the following inventory
instead of real holdings after verifying the corresponding Ethereum wallet:

| Ethereum wallet | Eligible card IDs |
| --- | --- |
| `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE` | 1–10 |
| `0x5BFce4149F520FE0823Dc8C0aFaF979121e824EC` | 11–20 |

These test wallets offer admin Solana sign-in when needed. Other wallet
combinations and all mainnet requests use real holdings. Test inventory keeps
normal pricing, reservations, and permanent duplicate-preorder protection.

Preorder configuration lives in `shared/preorders.ts`; the catalog's
`clean_card_id` remains the permanent identity. Converted assets appear as normal
cards. Unconverted assets retain preorder metadata and their existing visibility
rules. Gallery artwork and inventory previews use the hosted catalog assets.

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

Multiple Ethereum wallets appear in an inline picker, using EIP-6963 discovery
with a legacy `window.ethereum` fallback. The selected wallet is remembered
locally; later visits quietly check its authorized accounts before restoring a
matching verification session. Connect requests wallet access, and Verify
requests the signature. Disconnect clears the remembered choice.

The root `mi_note_cards.json` is the shared catalog. Its `ethereumCollections`
contains the three existing Ethereum collections used by the gallery, ownership
checks, and preorder eligibility. Cards with images appear in catalog order:
Mi Note 3, Mi Note 2, then original Mi Note. Loading, empty, and retryable error states
cover ownership lookup failures. Partial provider failures can leave cards
from successfully read collections visible, but cannot authorize cards whose
ownership could not be checked. Account changes clear obsolete cards,
selections, and pending asynchronous results. Solana sign-in changes refresh
eligibility so the devnet test inventory appears only for the admin buyer.

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
sessions, preserving the usual Origin and CSRF checks. The Worker reuses
these concurrent ownership lookups:

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
the authentication endpoints and ownership enforcement are ready for checkout.
