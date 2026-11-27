# divination machina x (DMX)

The [offchain metadata migration](../../releases/dmx-offchain-v1/README.md) moves
both existing collections to the same `https://cdn.mons.shop/dmx/` JSON files.
The [CDN media migration](../../releases/dmx-cdn-v1/README.md) established the
`cdn.lil.org/nft/dmx/` images: NFT metadata uses PNGs; claim pages use WebPs.
Collection addresses and NFC credentials are unchanged. Use the offchain
release for current renderer identities and activation verification.

The [mainnet v1 release](../../releases/dmx-mainnet-v1/README.md) activates all
777 existing mainnet NFC links against the verified Ethereum mainnet collection.
The original URLs and credentials are unchanged. Each holder claim mints its
initial card and paired NFC receipt; redemption remains paused.

The [Sepolia v3 release](../../releases/dmx-sepolia-v3/README.md) records the
rollout of a fresh renderer, the gas-optimized collection, and a new authorization
signer. The v2-to-v3 replacement retains all 777 existing NFC codes and URLs and
includes retirement of the superseded deployment. Release evidence records
which deployment, acceptance, and cleanup steps have completed.

DMX has 777 initial claimable card/NFC-receipt pairs, recipient minting, signed
redemption into future generations, configurable fee payouts, and a replaceable
metadata renderer. The collection and EIP-712 domain name are
`divination machina x`, the symbol is `DMX`, and the domain version is `1`.
The contract permits Ethereum mainnet, Sepolia, and local chain 31337. NFC links
default to mainnet and support explicit Sepolia links. Both networks are active;
the contract deployment runner supports explicit mainnet releases as well as
Sepolia.

This guide covers mainnet operations and the Sepolia replacement workflow.
For Sepolia replacements, rebind the existing 777
NFC codes and URLs to the verified DMX collection, update the deployment settings
and credential pin, then retire the superseded deployment in the same rollout.
The application supports the DMX contract and renderer only. Existing NFTs are
not migrated; retiring a deployment does not erase its onchain history.

## Contract operations

| Token kind | IDs | Issuance |
| --- | --- | --- |
| Initial cards | `1..777` | Claim or authorized mint, always with an NFC receipt |
| Future cards | `778..999999` | Authorized direct mint or signed redemption |
| Initial NFC receipts | `1000000..1000776` | `999999 + initialCardId` |
| Redemption receipts | `1000777..2000775` | `1000776 + burnedCardId` |

`INITIAL_CARDS` is 777; `MAX_CARDS` is the lifetime ceiling of 999999. Every NFT
ID remains observable through `issued(tokenId)` permanently. A burned card can
never be minted again.
Receipts are transferable proofs and cannot be burned or redeemed. Initial NFC
receipts survive independently when the corresponding card is redeemed.

`claim(tokenId, deadline, signature)` preserves the existing NFC flow.
`claimTo(recipient, tokenId, deadline, signature)` lets anyone pay gas to submit
the same recipient-bound authorization. Both use
`TarotClaim(address wallet,uint256 tokenId,uint256 deadline)`, with `wallet`
equal to the NFT recipient. `TarotClaimed` records that recipient, not a relayer.
API confirmation accepts both direct `claim` and recipient-bound `claimTo`,
including a recipient submitting their own `claimTo` transaction.

The owner can use `mintTo(recipient, cardIds)` without an authorization signature.
`mintToAuthorized(cardIds, quote, signature)` accepts a signed `DMXMint` binding
the recipient, exact card IDs, unique nonzero authorization ID, and deadline.
Both accept 1–50 unique card IDs in any order. Minting initial cards consumes
the same `claimed` state as the NFC flow and mints the paired receipt; future
direct mints create standalone cards. All direct mints start at generation zero.

`redeem(inputCardIds, outputCardIds, quote, signature)` requires the caller to own
all 1–50 input cards; ERC-721 approval alone does not authorize burning. The
signed `DMXRedemption` binds the holder, output recipient, exact input/output and
derived receipt IDs, nonzero order ID, ETH fee, payout configuration, and deadline.
It burns every input and mints one permanent receipt per input plus 0–50 new
cards in IDs `778..999999`. Replacement cards can themselves be redeemed using
fresh quotes. Their generation is one above the highest input generation.

Both authorization types use `keccak256(abi.encode(ids))` for array hashes.
Signatures expire within ten minutes, bind the chain and collection address,
and cannot be reused. Shared types, calldata encoders, and digest helpers live
in `shared/ethereum/dmx.ts`, `shared/ethereum/tarot.ts`, and
`shared/ethereum/tarotCrypto.ts`. These are contract/operator capabilities;
the HTTP API and storefront expose initial NFC claims.

Issuance and provenance are committed, then all selected inputs are burned,
before any output receiver callback. Any failed safe mint rolls back burns,
fees, issuance, and authorization consumption. `generation`, `createdByOrder`,
`redeemedByOrder`, `getTokenInfo`, and `getRedemption` preserve provenance after
burning; `tokenURI` still requires a currently existing NFT.

The current source stores permanent card issuance in an OpenZeppelin bitmap.
`claimed(tokenId)` derives the initial-card claim flag from that issuance bit;
`issued(tokenId)` derives NFC receipt issuance from its initial card and redemption
receipt issuance from its source card's nonzero `redeemedByOrder`. These getters
retain their existing signatures and values, including after transfers and burns.
All issuance and receipt flags are visible before receiver callbacks.

Redemption records pack validated card IDs into `uint32[]` storage arrays, with
eight IDs per slot. Input and output IDs are range-checked before narrowing;
`getRedemption` expands them back to the original ordered `uint256[]` results.
Calldata, events, signed array hashes, order IDs, and generation values keep their
original types. Direct minting leaves fresh generation and creation-order slots
at their default zero values. Permanent issuance prevents those slots from being
reused for a previously minted card.

Minting starts enabled and redemption starts paused. The owner independently
controls `setMintingPaused` and `setRedemptionsPaused`; neither stops transfers
or fee withdrawals. Ownership still transfers in two steps and cannot be
renounced. Rotating `quoteSigner` invalidates pending authorizations.

## Redemption fees

Register immutable payout configurations with
`registerRedemptionConfig(receiver1, receiver2, receiver2Bps)`. A zero secondary
receiver requires zero basis points; otherwise the receivers must differ and
the secondary share must be between 1 and 9999 basis points. Registration has
no lifetime count limit. Configuration zero is reserved for free redemptions;
paid quotes must identify an existing configuration and provide exactly the
quoted ETH amount.

Fees accrue during redemption and are not paid from within the burn/mint flow.
Anyone can call `releaseRedemptionFor(configId, secondary)` for one recipient,
or `releaseRedemption(configIds)` for up to 32 explicitly selected configurations.
Batch payouts bound recipient gas and preserve credit on failure; individual
withdrawals support more expensive receivers. Cumulative accounting gives the
secondary receiver its rounded-down share and the primary receiver the rest,
without moving old balances when new configurations are registered.

## NFC links

### Prelaunch mainnet credentials

The current mainnet batch is already bound and active. The staging commands
below describe prelaunch setup. After an in-place renderer update, use the
activation verification and read-only credential checks; do not repeat
`mainnet-bind`, which intentionally requires the original renderer and reviewed
source revision. `mainnet-verify` only accepts a staged, unbound batch. Do not
generate replacement credentials.

Mainnet links can be prepared before a contract address is known. Apply OPS
migration `0015_dmx_mainnet_claim_staging.sql`, then use:

```sh
npm run tarot:ops -- mainnet-links
npm run tarot:ops -- mainnet-provision
npm run tarot:ops -- mainnet-verify
```

The default private directory is `.operations/dmx-mainnet-v1/` (mode `0700`).
It contains `claim-links.private.json` and `claim-links.private.csv`, both mode
`0600`, ignored and untracked by Git. The CSV has 777 full links, one per line,
without a header or extra columns: `https://mons.shop/nfc?code=<UUID>&tokenId=<1..777>`.
Keep the canonical manifest and CSV for later contract binding. Generation
resumes an existing manifest without changing codes and can restore a missing
CSV; a CSV without its original manifest must be recovered, not overwritten.

Only batch metadata and SHA-256 staging hashes go into
`dmx_mainnet_claim_batches` and `dmx_mainnet_claim_codes` in OPS D1. The hashes
bind the batch, mainnet chain ID, token ID, and credential. Provisioning resumes
matching partial writes and rejects conflicts or revoked credentials. A batch
is marked `staged` only after all 777 rows match the private manifest, with its
contract binding still null. Claim authorization never accepts staging hashes.
The existing Sepolia credential table and release pin remain separate.

Release browser-bundle scans require the private mainnet manifest whenever
mainnet is configured, including while claims are disabled. The manifest must
match the verified fingerprint in `releases/dmx-mainnet-v1/credential-binding.json`.
Local scans keep the manifest optional; use `ETHEREUM_DMX_MAINNET_PRIVATE_MANIFEST`
for a non-default path.
Only generic diagnostics are emitted. Do not add actual credentials, CSVs, or
private manifests to source files, tests, logs, release evidence, or public media.

At a separately authorized mainnet launch, apply OPS migration
`0016_dmx_mainnet_bound_claim_codes.sql`, then bind the retained batch:

```sh
npm run tarot:ops -- mainnet-bind --contract <verified-mainnet-contract> --deployment-block <creation-block> --deployment-transaction <creation-transaction-hash> --deployment-directory <approved-private-collection-release>
```

This uses `ETHEREUM_TAROT_MAINNET_RPC_URL` when supplied, otherwise the public
Ethereum RPC. Only HTTPS and read-only RPC methods are allowed. Binding requires
the approved frozen collection release, including its verified renderer evidence.
It validates the manifest, source and artifact hashes, deployment report, and
chain-1 identity before writing credentials. Binding builds `TarotCards` and its
renderer from the current checkout in a temporary directory and compares the
deployed bytecode with those trusted builds. It also verifies successful direct
creation transactions and receipts against canonical deployment blocks, exact
trusted creation bytecode, and the approved deployer and constructor arguments.
This proves initialization of signing constants that vary in deployed bytecode.
Factory deployments are not accepted. Use the reviewed source revision and compiler
settings that were deployed. No credentials are bound if these checks fail.
Binding also checks chain 1, canonical confirmations, the DMX identity and
signing domain. The current owner, quote signer, and renderer must match the
approved release, with no pending ownership transfer. A correct-code deployment
with different roles is rejected. The credential and deployment operation locks
are held together during binding. It derives contract-scoped
hashes into `dmx_mainnet_bound_claim_codes`, verifies all 777, then marks the batch
`bound` with that address. Partial writes remain inactive; retrying the same
binding verifies or resumes it. A different address or conflicting credential
set is rejected. The private CSV/manifest and original URLs stay unchanged.

Configure `ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS`,
`ETHEREUM_TAROT_MAINNET_DEPLOYMENT_BLOCK`, and the independent
`ETHEREUM_TAROT_MAINNET_SIGNER_SECRET` for the verified deployment before setting
`ETHEREUM_TAROT_MAINNET_ENABLED=true`. The production release configuration
requires this secret even while claims are temporarily disabled; there is no
fallback to the Sepolia key. API access also requires
the matching bound batch. None of these launch actions is performed by preparing
the application source or by staging commands.

### Network selection and prelaunch scans

No `testnet` argument selects mainnet; explicit `testnet=false` also selects
mainnet, and `testnet=true` selects Sepolia. Malformed or repeated network flags
never select a claim flow. The updated application saves the scanned credential
under a network-specific key before removing it from the URL. Mainnet and Sepolia
credentials, rescan candidates, encrypted history, and pending transactions stay
separate. Existing network-scoped saved codes and `sealed2` history remain
readable without changing storage keys or clearing scans. The `sealed1` decoder
is removed. Pending transactions must contain their recorded intent ID and
deadline; the browser no longer invents either field for older records.

While mainnet is unconfigured or its batch is unbound, the API returns unavailable
rather than invalid credentials. The page keeps showing artwork without claim
controls and retains the code for later validation. Deploy the matching API
before the updated frontend. Scans made by older versions that discarded mainnet
codes need the original link again.

### Sepolia NFC flow

The format is `https://mons.shop/nfc?code=<UUID>&tokenId=<1..777>&testnet=true`.
Scanning saves the code in the scanning browser’s local storage for that Sepolia
card and immediately replaces the address with `/nfc?tokenId=<1..777>&testnet=true`.
Reloading or reopening that address in the same browser restores claim access.
Rescanning the same card with a different code updates the saved code only after
the server accepts it. If session storage is unavailable, the browser keeps the
pending rescan encrypted in its own history entry.
Anyone opening the shared address in a fresh browser sees the public artwork.
If local storage is full, session storage keeps the first scan available after a
reload in that tab. If both stores are unavailable, the scan lasts until reload.
A credential-specific 401 removes the matching saved code.
Successful revalidation restores it when no newer code has been saved. A status
response that overlaps another tab’s credential change is revalidated before
promotion.

`/nfc?code=basel` preserves the original video placeholder. The standard shop
header and large card artwork appear immediately for a single canonical token ID,
without waiting for code validation. Missing or incorrect codes, already-claimed
cards, and unavailable claims retain that artwork silently. It fits the remaining
viewport without extra page scrolling. Invalid links never expose claim controls.
Existing mainnet-only staff restrictions still apply to testnet claim links.

Only a verified, enabled, unclaimed link reveals the two-NFT claim layout. The same
card shrinks and moves into its slot while the other content fades in. Reduced
motion skips the animation. If artwork loading or decoding stalls, the eligible
claim layout appears without animation after 1.5 seconds. Wallet dialogs defer
the start of the transition until they close. If a dialog opens during movement,
the card settles into its final frame. After three canonical confirmations, the
view returns to the large artwork, including after either NFT is transferred.

Temporary initial validation failures retry automatically with bounded backoff
and honor `Retry-After`, without opening a wallet or adding controls. Retries
pause while the page is hidden or suspended, and stop on success or an invalid
link. After the automatic retry budget is exhausted, refocusing the page can
retry after its cooldown. Unrelated shop account errors stay outside NFC pages.

A later 401 or 403 invalidates unclaimed access and cancels queued wallet work
without discarding pending recovery. Claim stays unavailable until validation
succeeds again. Rate-limit cooldowns disable the existing Claim button and
show `Please wait…` when no claim is in progress. The button returns to Claim at
the retry deadline without automatically opening a wallet. Wallet cancellations restore the Claim button for retry without adding a message
below it. Temporary confirmation-read failures retain pending recovery until
confirmation polling succeeds.

Wallet submission records a public recovery intent before handing off to the
wallet. A shared window cache preserves it across SPA navigation when browser
storage fails. Disconnects cancel the active wait; uncertain submissions remain tracked
until a receipt arrives or confirmed unclaimed chain state passes the deadline.
Late wallet replies update only their original intent. Failed receipt replies
are ignored if a newer chain observation arrived during their request.

The browser calls `/api/ethereum/tarot/status`, `/prepare`, and `/confirm` using
POST JSON, an explicit boolean `testnet`, and the `X-Mons-CSRF` header. Omitting
`testnet` at the API also defaults to mainnet. Every request
validates the secret against its exact deployment and card. Preparation adds the
wallet; confirmation adds the wallet and transaction hash. No separate wallet
sign-in message is required. The backend signature binds the wallet, card,
deadline, contract, and chain; it expires within ten minutes. Code validation
does not reserve or consume a card. The contract permanently records each claim.

Confirmation responses include the canonical receipt's `blockNumber` and
`blockHash`, or null values while no canonical receipt is available. The page
uses accepted snapshots and confirmed receipt blocks to ignore stale chain
reads while still allowing fresh canonical reorg state. Deploy API changes
before frontend code that requires new confirmation fields.

### Backend-funded address and ENS fallback

The storefront prefers a connected or discoverable Ethereum wallet. Clicking
Claim without an EIP-6963 or legacy provider shows an address/ENS input with OK.
Wallet rejection, locked accounts, and transaction errors do not enable this
fallback. Provider absence is a browser decision; the server authenticates the
NFC code and limits sponsorship independently.

`POST /ethereum/tarot/claim` accepts the normal `code`, `tokenId`, and `testnet`
fields plus `recipient` and a UUIDv4 `requestId`. ENS resolves the Ethereum
address record on mainnet for both claim networks. The resolved recipient is
fixed for that attempt. Both NFTs are issued through the existing `claimTo`
function and current authorization signer, with a separate account paying gas.
The authenticated status response includes `backendClaim` with the request ID,
recipient, state, transaction hash, revision, finality, and any safe failure message. Never expose
these responses through public caches or put NFC credentials in logs.
Status requests may include `requestId` to read one previously accepted attempt
when another tab has since retried the card.

`TAROT_CLAIM_RELAYER` uses one SQLite Durable Object per network, named
`tarot-claims:1` and `tarot-claims:11155111`. It serializes signing and first
broadcast, reserves the nonce only when the complete signed transaction is
persisted, and replays the same bytes after interruption. Repeating a request ID
returns the original attempt. Pre-signing failures can retry with a new request
ID. One finalized paid failure ends sponsorship for that card on that chain and
contract, regardless of request ID or recipient; a connected wallet can retry.
A token cannot have multiple active sponsored attempts.
Preflight rejections are persisted against their request IDs before reporting
that no claim was accepted, so concurrent retries cannot reverse that outcome.

The initial request leaves the form disabled while processing, then replaces it
with View transaction. Refresh reads backend state before exposing Claim, even
without browser storage. Three canonical confirmations enter the existing
single-card view. Pending state wins over newly disabled minting or a newly
connected wallet. Lost responses and absent receipts do not unlock a new claim.
The backend keeps checking successful and failed receipts until Ethereum
finality. A newer revision can restore pending state after a reorg; failed
transactions remain pending in the UI until finalized.

Configure these Worker secrets using the standard private secret provisioning
process, separately from the authorization signer secrets:

- `ETHEREUM_TAROT_MAINNET_RELAYER_SECRET`
- `ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET`

Each secret is a secp256k1 private key. Fund its address with ETH on the matching
network before enabling the frontend release. Relayer addresses must differ
from the authorization signer and must be used exclusively by this service;
manual transactions from those accounts invalidate nonce coordination. Never
put keys in tracked configuration, browser environment variables, or command
arguments. Keep private provisioning records under `.operations/`.

The per-network `ETHEREUM_TAROT_*_SPONSORSHIP_ENABLED` flags control new signing
and rebroadcasting. `ETHEREUM_TAROT_*_MAX_CLAIM_FEE_WEI` defaults to
`1500000000000000` (0.0015 ETH) on both networks. Transactions use estimated gas
plus 20%, with a 600,000-gas maximum. Estimation uses the same EIP-1559 fee caps
as the signed transaction. Fees use twice the latest base fee
plus the median reward from five blocks, clamped to a 0.1–2 gwei priority fee.
Reject before signing if gas limit × maximum gas price exceeds the configured
ceiling, or if the balance cannot cover that attempt plus outstanding signed
commitments. These are limits, not a promise of current network fees.

Alarms inspect receipts every 15 seconds and rebroadcast identical bytes no more
than every 30 seconds while the authorization remains valid. There are no
automatic fee increases, cancellations, or replacement transactions. An expired
transaction without a canonical receipt keeps its hash and becomes `recovery-required`; unsigned
queued requests fail without reserving a nonce. The per-network relayer pauses
new signing while a nonce is missing or requires recovery. An orphaned receipt
reuses the saved bytes while authorization remains valid; expiry requires
operator recovery. Included transactions stay under observation past expiry
until finalized. It continues observing even if sponsorship is disabled or current
signing keys are unavailable. The `tarot_claim_recovery_required` structured log
identifies the network and durable attempt without exposing the NFC code.

A temporary sponsorship pause leaves saved transactions pending. Re-enabling
sponsorship resumes the same signed bytes while their authorization remains
valid. An authorization revoked by quote-signer rotation is rejected before
broadcast and requires recovery.

For recovery, inspect the saved transaction and the relayer's canonical nonce
before doing anything that spends gas. A missing receipt is not proof of a
failed transaction. Restore provider access or funding as appropriate. Fee
replacement or cancellation requires an explicit operator decision; this
version does not reconcile an arbitrary replacement hash automatically. Do not
delete an attempt or reset its nonce to make the claim button reappear. Rotate
relayer keys only after signed unresolved attempts have been settled.

Release the API with `npm run deploy:api`, then the frontend with `npm run deploy`
after provisioning and funding both relayers. This adds a Durable Object binding
and migration, without changing Commerce schemas or rows. Routine bounded
Commerce validation is sufficient. Check both wallet and walletless paths,
refresh while pending, then confirmation in a controlled Sepolia claim before
using sponsored mainnet claims for live holders.

## Private credentials

Codes are random UUIDv4 values. `OPS_DB.tarot_claim_codes` stores only SHA-256
digests of the canonical input returned by `tarotCodeHashInput`, plus deployment,
card ID, creation time, and optional revocation time. Claimed cards retain their
credentials because NFC links remain usable as artwork views.

For the v2-to-v3 replacement, retain the existing codes and URLs through an
explicit rebind after the fresh renderer and collection have been deployed and
verified. Set `TAROT_CREDENTIAL_PIN_PATH` to the v3 pin before rebinding; the old
source pin must remain distinct from the new target pin:

```sh
npm run tarot:ops -- rebind --source-directory .operations/dmx-sepolia-v2 --source-pin releases/dmx-sepolia-v2/credential-set.json --deployment-directory <verified-v3-collection-release> --directory .operations/dmx-sepolia-v3
npm run tarot:ops -- verify-codes --directory .operations/dmx-sepolia-v3
```

The source-directory, source-pin, and deployment-directory flags are required
for `rebind` and are rejected by other commands. The target directory defaults
to `.operations/dmx-sepolia-v3/`. Rebinding validates the old private manifest,
its public pin, and all 777 existing database rows, then checks the verified
collection release with `releaseVersion: 2`. The v3 deployment name does not
change this frozen release format. It preserves every token-ID/code/URL triple while
binding the hashes to the new contract. It provisions and reads back all 777
replacement rows before creating the new public pin. Matching retries resume
the same target; changed sources, deployment evidence, or target contents fail
closed. Keep the source files and pin through replacement verification and live
acceptance, then remove them during retirement cleanup. Do not regenerate codes
for this rollout.

The default operator manifest is
`.operations/dmx-sepolia-v3/claim-links.private.json`, with directory mode 0700
and file mode 0600. Never publish it, paste its contents into logs, or add it to
Git. The original physical tags keep the same URLs; no browser-storage migration
or tag reprogramming is needed. Credential commands lock their private directory.
Provisioning stores hashes only, rejects retired deployments, and verifies all
777 rows. No public endpoint lists codes or imports credentials.

Successful provisioning readback and `verify-codes` record the public aggregate
fingerprint in `releases/dmx-sepolia-v3/credential-set.json`. All 777 database rows
must match first. The fingerprint binds the deployment and ordered token-ID/code-hash
pairs; it contains no codes, URLs, or individual code hashes. Matching repeats
preserve the file. A conflicting existing fingerprint stops verification or
provisioning before database writes. The old source pin is never overwritten
by rebind; remove it only as part of verified retirement cleanup.

Use `ETHEREUM_TAROT_PRIVATE_MANIFEST` to point the browser bundle scanner at a
non-default private manifest; otherwise it scans the default manifest when
present. `deploy` and `dry-run:frontend` require the manifest through
`validate:browser-bundle:release`, which validates its configured Sepolia
contract and 777 unique, ordered IDs and codes before scanning. Ordinary builds
and local scans keep the manifest optional. Release scans also require its
fingerprint to match the repository's fixed release pin, regardless of the
private manifest's location. This comparison is offline; missing or mismatched
pins fail closed. Only the Node validator reads this
private file outside `dist`; never pass its contents to Vite or upload it.
The release must scan against all provisioned codes. Frontend NFC
responses and API requests disable referrers and caching; application logs must
never include query strings or request bodies containing a code.

Separate rate-limit bindings throttle validation/preparation to 30 requests per
minute per IP, signing to five per verified card/wallet, and confirmation to 60
per IP. Cloudflare counters are approximate and local to each location; the
UUID entropy supplies unguessability. Failed guesses do not lock a card globally.
Quota keys use the trusted Cloudflare client IP and operation, independently of
the Origin header. Missing or invalid client IPs fail closed before code lookup.

## Metadata and deployment

`TarotCards` takes `(initialOwner, quoteSigner, initialRenderer)` in its
constructor. The collection delegates `tokenURI` and `contractURI` to
`IDMXRenderer`, passing its own address. A renderer can query token provenance
without tying collection logic to any metadata format or hosting provider.

`DMXOffchainRenderer` has no constructor arguments and returns
`https://cdn.mons.shop/dmx/<tokenId>.json` for every token kind. Both networks use
the same URLs. The collection retains its existence and ownership checks;
unissued and burned NFTs cannot return a collection `tokenURI()`.
`contractURI()` returns `https://cdn.mons.shop/dmx/collection.json`.

The initial publication contains 777 cards (`1.json`–`777.json`), 777 NFC receipts
(`1000000.json`–`1000776.json`), and `collection.json`: 1,555 objects total.
Receipt filenames use ERC-721 token IDs; their displayed Card IDs remain 1–777.
The initial names, descriptions and attributes matched the preceding inline renderer. Card
artwork remains `https://cdn.lil.org/nft/dmx/cards/<cardId>.png`; NFC receipt
artwork remains `https://cdn.lil.org/nft/dmx/receipts/<cardId>.png`.

The [card metadata revision](../../releases/dmx-metadata-v2/README.md) names
these tokens `Card #<cardId>` and `Receipt #<cardId>`, leaves descriptions empty,
and includes only a lowercase `type` trait with value `card` or `receipt`.
It removes the `Kind` and `Card ID` traits. All 777 card and 777 receipt image
URLs are preserved, and `collection.json` is unchanged.

The [collection metadata revision](../../releases/dmx-metadata-v3/README.md)
subsequently sets the collection image to
`https://cdn.lil.org/nft/dmx/receipts/7.png`, with empty `description` and
`external_link` strings. The collection name and symbol remain
`divination machina x` and `DMX`.

Editable authoring templates live under `scripts/tarot/metadata/`. Generate,
publish, and verify from the repository root with the existing R2 credentials
described in [111k metadata publication](111k_metadata.md#generate-and-publish):

```sh
npm run tarot:ops -- metadata-generate --directory .cache/dmx-metadata/<revision>
npm run tarot:ops -- metadata-publish --directory .cache/dmx-metadata/<revision>
npm run tarot:ops -- metadata-verify --directory .cache/dmx-metadata/<revision>
```

Publication is scoped to `cdn-mons-shop/dmx/`, independent of 111k registries and
deployment prefixes. It uses conditional creation, accepts identical existing
objects, and rejects conflicting contents. Resume the original generation and
publication journal after an interruption. All objects use JSON UTF-8 and
`Cache-Control: no-store`; verification checks complete storage and public CDN
contents and headers. Keep generated files in `.cache/` and private journals in
`.operations/`. Reviewed release evidence contains the manifest and aggregate
verification results, never signing material or claim credentials.

To update existing JSONs, edit the authoring templates, generate a new revision,
and review its JSON files and manifest before applying it. Keep the previous
revision unchanged:

```sh
npm run tarot:ops -- metadata-generate --directory .cache/dmx-metadata/<new-revision>
npm run tarot:ops -- metadata-update --directory .cache/dmx-metadata/<new-revision> --previous-manifest releases/dmx-metadata-v3/metadata-manifest.json
```

For later updates, pass the latest successful revision's `manifest.json` as
`--previous-manifest`. The update checks the existing inventory against that
baseline, writes only changed files with matching ETags, and accepts files that
already match the target when resuming. Missing or extra objects and unexpected
contents stop the operation. Updates preserve JSON UTF-8 and `no-store`, then
verify all storage and public CDN contents and save the new verification report.
If interrupted, resume the same command with the same two manifests.

These JSON updates affect both networks and require no onchain transaction or
renderer change. Marketplaces may still need to refresh cached metadata.
Historical deployment and activation evidence retains its original hashes;
use `metadata-verify --directory .cache/dmx-metadata/<new-revision>` to check
current metadata after an update, without rewriting frozen release evidence.

Future cards and redemption receipts use the same offchain URL pattern, but
their metadata and images must be published before issuance. This initial
publisher creates only the 777 initial pairs and collection metadata. Shared
JSON does not automatically reflect network-specific generation or redemption
orders; those values remain available through the collection's `getTokenInfo()`.
Keep redemptions paused until the future publication workflow is ready.

Historical `DMXWebpRenderer` releases return Base64 JSON data URIs and remain
verifiable against their frozen artifacts. Preserve their original evidence.

The owner can call `setRenderer` at any time. The new address must contain code,
must differ from the collection, and must advertise the renderer ERC-165
interface. The collection imposes no URI encoding restriction, so future
renderers may return HTTP/IPFS metadata or inline JSON containing SVG images
or HTML `animation_url` values. Renderer swaps emit `RendererUpdated`, an
ERC-4906 refresh covering all card and receipt IDs, and `ContractURIUpdated`.
Use `refreshMetadata(fromTokenId, toTokenId)` or `refreshContractMetadata()` when
changing data inside a future mutable renderer. Initial NFC receipts also emit
`MetadataUpdate` when their source card is redeemed.

`npm run tarot:ops -- verify-media` checks card PNGs, receipt PNGs,
receipt WEBPs, and clean WEBPs for IDs 1–777 plus layer WEBPs 1–10 under
`https://cdn.lil.org/nft/dmx/`: 3,118 images with format-specific content-type
checks, without publishing metadata. The NFC page uses `clean/<cardId>.webp`,
`receipts/<cardId>.webp`, and `layers/<layerId>.webp`; collection metadata uses
`cards/1.png`.
Preserve these images and the shared `dmx/` metadata during any network-specific
retirement. The v2-to-v3 replacement had no static JSON prefix to delete: v2
used renderer-generated metadata, and the legacy v1 static metadata cleanup is
complete.

Use an independent encrypted Tarot authorization keystore, with its password in
Keychain, and provision `ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET` through Wrangler's
standard input. Never pass signer keys or passwords as command arguments. The
existing Sepolia deployment wallet is the administrator; do not reuse a 111K
authorization signer. Configure the API's `ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS`,
`DEPLOYMENT_BLOCK`, and `ENABLED` only after verifying the new deployment.

Prepare, deploy, and verify the renderer first using its own private directory.
For offchain renderer preparation, use `--contract DMXOffchainRenderer` and
`--metadata-directory <generated-and-verified-directory>`. Publish and verify
the complete metadata set first. The release freezes the publication manifest
and verification proof and pins the collection URL and content hash. Activation
rechecks the published metadata. Original inline releases remain verifiable.

Prepare only the new renderer for an existing collection. Use absolute directory
paths with these commands because `npm --prefix` runs inside the contract project:

```sh
npm --prefix onchain/ethereum run tarot:deploy -- prepare --network sepolia --contract DMXOffchainRenderer --metadata-directory <absolute-generated-directory> --directory <private-sepolia-renderer-release>
npm --prefix onchain/ethereum run tarot:deploy -- prepare --network mainnet --contract DMXOffchainRenderer --metadata-directory <absolute-generated-directory> --directory <private-mainnet-renderer-release> --deployer <deployer-address> --admin <owner-address> --maximum-fee-wei <renderer-fee-ceiling>
```

Use `sign`, `broadcast`, and `verify` with the same explicit network and renderer
directory, then source-verify that release before activation. Every
`--maximum-fee-wei` caps one transaction. Divide a combined migration budget
between renderer deployment and activation; do not give each transaction the
entire combined allowance.

For an in-place media update, the existing collection owner calls
`setRenderer(newRenderer)` after verifying the new renderer's deployment,
runtime bytecode, and media. Re-read the chain ID, owner, and active renderer,
simulate the call, and journal the signed transaction before broadcasting.
Require three canonical confirmations and verify the renderer readback,
collection metadata, and refresh events. Preserve the original deployment
evidence and append the renderer deployment and activation records. The
collection address, credentials, signer, and API deployment block stay unchanged;
this operation does not require collection replacement or retirement.

Use the journaled activation runner after deploying and verifying the new
renderer. Supply the existing collection's frozen release and the new renderer's
verified release, with an explicit network and activation fee ceiling:

```sh
npm --prefix onchain/ethereum run tarot:renderer -- prepare --network <sepolia|mainnet> --directory <private-activation-release> --collection-directory <original-collection-release> --renderer-directory <new-renderer-release> --maximum-fee-wei <activation-fee-ceiling>
npm --prefix onchain/ethereum run tarot:renderer -- sign --network <sepolia|mainnet> --directory <private-activation-release> --keystore <owner-keystore> --password-file <private-password-file>
npm --prefix onchain/ethereum run tarot:renderer -- broadcast --network <sepolia|mainnet> --directory <private-activation-release>
npm --prefix onchain/ethereum run tarot:renderer -- verify --network <sepolia|mainnet> --directory <private-activation-release>
```

Activation freezes the original collection and new renderer evidence, owner,
previous renderer, signer, pause flags, nonce, calldata and fee allowance. Resume
the same activation directory after interruption. Verification reads the chain
and records the three-confirmation proof, renderer readback, collection image,
unchanged controls and all three metadata-refresh events. No separate refresh
transaction is needed. Check actual issued NFTs at a confirmed snapshot; do not
mint test claims on a live network when no NFTs exist yet. Read-only claim status
and credential checks retain their original contract scope and private manifests.

### Historical Sepolia v3 replacement

The completed v3 replacement used a fresh renderer and a fresh collection with a
new, independent Sepolia authorization signer. Do not reuse either v2 renderer
deployment. These commands document that original release; current in-place
offchain migrations use the renderer preparation and activation steps above.
The collection was prepared against the newly verified renderer release.
Both manifests keep `releaseVersion: 2`. Collection preparation freezes the
renderer evidence and verifies its canonical deployment and runtime bytecode;
an arbitrary renderer address is not accepted as a substitute. Use these steps
for the replacement:

```sh
npm --prefix onchain/ethereum run tarot:deploy -- prepare --contract DMXWebpRenderer --directory <private-renderer-release>
```

Every deployment command requires an explicit `--directory`; there is no default
release target. Use the same `sign`, `broadcast`, and `verify` commands below
with the renderer directory first. Once renderer verification has completed:

```sh
npm --prefix onchain/ethereum run tarot:deploy -- prepare --directory <private-release> --quote-signer <public-signer-address> --renderer-directory <private-renderer-release>
npm --prefix onchain/ethereum run tarot:deploy -- sign --directory <private-release> --keystore <encrypted-deployer-keystore> --password-file <private-password-file>
npm --prefix onchain/ethereum run tarot:deploy -- broadcast --directory <private-release>
npm --prefix onchain/ethereum run tarot:deploy -- verify --directory <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- submit <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- status <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- verify <private-release>
```

RPC configuration comes from `ETHEREUM_TAROT_RPC_URL` or `ALCHEMY_API_KEY`. The
runner defaults to Sepolia and freezes source, constructor inputs, bytecode,
nonce, and fees. New manifests also pin `expectedCollectionImage` to the DMX
collection image. Historical manifests with the old explicit image pin, and
original manifests without that field, are verified against their frozen
deployment metadata and bytecode; preserve that evidence unchanged. New releases
pin the CDN PNG image.
Renderer and collection have separate manifests and journals.
The compact-storage source revision changes collection creation and runtime
bytecode. Rebuild and prepare a fresh collection release for that revision;
retain historical deployment sources, artifacts, manifests, and signed journals
unchanged. Mainnet credential binding checks the approved release against the
current local build as well as the deployed code.
Source verification supports `TarotCards`, `DMXWebpRenderer`, and
`DMXOffchainRenderer` and requires release version 2 with an explicit
`contractName`; older manifests are rejected before requests.
Resume the same signed journal after interrupted broadcasts. Preserve the new
renderer and collection release evidence. Remove superseded local release trees
only after retirement verification. Never redeploy or replace 111K as part of
Tarot work. Local Anvil is test-only.

### Mainnet release preparation

The commands below document the original mainnet v1 collection launch. For an
existing collection's offchain migration, prepare and activate only its new
renderer using the preceding instructions.

Mainnet requires `--network mainnet` on every deployment command. Preparation
also requires explicit `--deployer`, `--admin`, and `--maximum-fee-wei` values;
there are no default mainnet wallets or fee ceiling. The quote signer must be a
dedicated address distinct from the deployer and administrator. Prepare the
renderer first, and verify its mainnet deployment before preparing the collection:

```sh
npm --prefix onchain/ethereum run tarot:deploy -- prepare --network mainnet --contract DMXWebpRenderer --directory <private-mainnet-renderer-release> --deployer <deployer-address> --admin <owner-address> --maximum-fee-wei <approved-fee-ceiling>
npm --prefix onchain/ethereum run tarot:deploy -- prepare --network mainnet --directory <private-mainnet-collection-release> --deployer <deployer-address> --admin <owner-address> --maximum-fee-wei <approved-fee-ceiling> --quote-signer <mainnet-quote-signer> --renderer-directory <verified-private-mainnet-renderer-release>
```

These are separate stages: the renderer must be signed, broadcast, and verified
before collection preparation. When deployment is authorized, use the existing
`sign`, `broadcast`, and `verify` commands with `--network mainnet` and the same
release directory. Set `ETHEREUM_TAROT_MAINNET_RPC_URL` to the intended HTTPS
mainnet RPC, or use `ALCHEMY_API_KEY` for the mainnet endpoint. The Sepolia
`ETHEREUM_TAROT_RPC_URL` is not used for mainnet. Preparation does not sign or
broadcast. Later stages use the
frozen roles and fee ceiling; preparation-only flags cannot override them.
The manifest stores the approved cap in `feeCeilingWei` and the transaction's
buffered maximum fee in `maximumFeeWei`. Both renderer and collection evidence
must belong to chain 1. Source verification derives the chain from the frozen
manifest and supports both mainnet and Sepolia.

Review the collection manifest before signing and retain that exact release for
`mainnet-bind --deployment-directory`. Binding, API configuration, and enabling
mainnet claims are separate launch steps; preparing releases does not perform them.

All four deployment commands exclusively own `operation.lock` inside the
release directory, including `verify`, which only reads the chain but records
local evidence. Concurrent commands fail before reading or changing release
files; retry after the current command finishes. Release directories must have
mode 0700 and live under `.operations/`, `.cache/`, `onchain/ethereum/.local/`, or
outside the repository. A crashed lock is recovered automatically only when its
valid owner record identifies this host and its process no longer exists.
Locks owned by a live process, another host, or an unreadable owner are never
stolen. Inspect the owner and establish that no deployment operation is running
before manually removing an unrecognized lock. Recovery never authorizes
replacing an existing manifest or signed journal; resume that release instead.

## Release validation and recovery

Run the isolated DMX gas regression check with
`npm --prefix onchain/ethereum run gas:dmx:check`. To record new snapshots after
an intentional contract change, use
`npm --prefix onchain/ethereum run gas:dmx:update` and review the resulting diff.
The cases cover cold and populated-bucket claims, initial and future mint
batches, sparse IDs across bitmap buckets, redemptions with up to 50 inputs and
50 outputs, and redemption-record reads.
Measurements isolate each contract call from setup and earlier transaction
accesses. Bitmap savings depend on sharing buckets; sparse IDs open more
storage slots than consecutive IDs.
The [compact-storage comparison](../../onchain/ethereum/benchmarks/dmx-gas-optimization.json)
records before/after gas using the same harness and compiler settings, excluding
transaction intrinsic gas. It pins the baseline commit and measured source hashes.

Run the Tarot contract/deployment tests, frontend/API/runtime tests, and
`npm run test:tarot:e2e` and `npm run test:tarot:mainnet:e2e`. The E2E tests deploy locally and submit local
claims, recipient mints, multi-generation redemptions, and fee withdrawals.
They also check receipt provenance, renderer swaps, and pause recovery. The
mainnet variant uses a local chain with ID 1 and a synthetic 777-code batch to
exercise staging, verified binding, signing, and initial-claim confirmation.
On public Sepolia use signed preparation and `eth_call`/gas estimation only;
do not consume one of the 777 initial pairs during release acceptance.

## Sepolia cutover and retirement

Complete the v2-to-v3 replacement and cleanup in one rollout:

1. Verify OPS migration `0017_dmx_sepolia_retirement.sql` and API retirement
   support are deployed; apply the migration with `npm run db:migrate:ops` if
   needed. Verify OPS integrity with
   `npm run check:ops-d1`. Include API retirement checks in the disabled
   replacement deployment below, before enabling claims. This rollout changes
   OPS, not Commerce schemas or rows, so it uses the routine bounded Commerce
   gate.
2. Deploy and verify a fresh renderer, then a fresh gas-optimized collection
   using that renderer and a new dedicated signer. Keep the frozen release
   format at `releaseVersion: 2`. Update the active credential pin and private
   directory defaults to v3, then run the explicit `rebind` above. Verify the
   matching signer, all 777 replacement credentials, exact source verification
   for both contracts, and all 777 unclaimed onchain flags without consuming an
   initial pair. Preserve the source v2 manifest and pin until acceptance.
3. Configure `ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS`,
   `ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK`, and the matching signer secret for
   the verified replacement, with `ETHEREUM_TAROT_SEPOLIA_ENABLED=false`.
   Disable Sepolia sponsorship and drain all signed relayer attempts before
   changing the active deployment or retiring its credentials. Pending relayer
   transactions must reach a canonical receipt; retain their nonce records until
   that is verified.
   Deploy this retirement-aware API configuration with `npm run deploy:api` to
   stop issuing old-contract authorizations while replacement claims remain
   disabled.
4. On the superseded v2 contract, call `setMintingPaused(true)` and
   `setRedemptionsPaused(true)`, then set `quoteSigner` to
   `0x000000000000000000000000000000000000dEaD`. Require three canonical
   confirmations and verify both pause flags and the signer readback. Pausing
   stops old issuance and redemptions; signer rotation revokes outstanding
   authorizations. Disabling the API flag alone would leave signatures valid
   for up to ten minutes. Journal these operations privately under
   `.operations/dmx-sepolia-v3/` and resume the same operations if interrupted.
5. Set the bundle scanner to the replacement private manifest and
   `releases/dmx-sepolia-v3/credential-set.json`, then deploy the storefront with
   `npm run deploy`. Enable replacement claims in the API and deploy it again.
   Check live NFC headers, Basel behavior, saved-code recovery, matching
   signer/configuration, all 777 unclaimed flags, and mainnet prelaunch behavior.
   The 777 physical Sepolia links remain unchanged.
6. After live acceptance, insert the immutable old-to-new marker in
   `dmx_retired_sepolia_deployments`. The OPS triggers fence old-scope credential
   inserts and updates, and the API rejects the retired scope. Leave that marker
   permanently; changing configuration back is not a rollback. Keep the existing
   v1-to-v2 retirement marker unchanged and append the v2-to-v3 marker. Stop
   superseded credential tooling before removing its files.
7. Delete only the superseded v2 contract's `tarot_claim_codes` rows. Remove its
   private credential/release directories, obsolete caches and backups,
   superseded signer material, and `releases/dmx-sepolia-v2/` after preserving a
   minimal aggregate cleanup record with the new release. Remove obsolete
   renderer-update release artifacts once their required provenance is retained
   in the cleanup record. There is no static metadata deletion or CDN purge in
   this replacement. Keep Git history, every retirement marker, the new signed
   renderer and collection evidence, the v3 private manifest and signer, all
   mainnet credentials, shared WEBPs, profiles, pre111k, 111K, and unrelated drops.
8. Verify old credential rows and obsolete artifacts are absent, both old pause
   flags remain set, the old signer remains the burn address, and the replacement
   stays healthy. Repeat absence and health checks after a bounded observation
   period. Tarot relayer alarms can write submission state; verify old-scope
   attempts are drained and cannot rebroadcast. The shared Worker cron is not a
   Tarot cleanup job. Record completion only after the observation
   confirms retired data has not reappeared.

Keep replacement evidence in the
[DMX Sepolia v3 release](../../releases/dmx-sepolia-v3/README.md). Publish only
aggregate acceptance and cleanup results, verified source hashes, and public
deployment identity. These steps are a rollout procedure; the release evidence
records which steps have actually completed.

To stop issuing new authorizations, disable the Tarot API flag. Outstanding
signatures can remain valid for up to ten minutes. On-chain `setMintingPaused`
stops claims and both direct mint paths immediately. `setRedemptionsPaused`
independently stops redemptions; token transfers and fee withdrawals stay enabled.
The administrator can also rotate `quoteSigner` to revoke pending signatures,
then update the Worker secret and verify it matches before reopening. Metadata
and already-claimed artwork views remain available while preparation is disabled.
