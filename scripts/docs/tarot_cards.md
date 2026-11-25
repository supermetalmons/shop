# divination machina x (DMX)

The current source revision is not deployed. It retains 777 initial claimable
card/NFC-receipt pairs and adds recipient minting, signed redemption into future
generations, configurable fee payouts, and a replaceable metadata renderer.
The collection and EIP-712 domain name are `divination machina x`, the symbol is
`DMX`, and the domain version is `1`. The contract permits Ethereum mainnet,
Sepolia, and local chain 31337; the current application and release runner remain
Sepolia-only.

The application code targets this new revision only. Its next deployment must
be coordinated with the new collection and renderer, new deployment-scoped
credentials, and updated release pins. Current live addresses, credentials,
published metadata, and `releases/tarot-sepolia-v1/` describe the old deployment
and are not changed by this source update. No migration of its NFTs is implied.

## Contract operations

| Token kind | IDs | Issuance |
| --- | --- | --- |
| Initial cards | `1..777` | Claim or authorized mint, always with an NFC receipt |
| Future cards | `778..999999` | Authorized direct mint or signed redemption |
| Initial NFC receipts | `1000000..1000776` | `999999 + initialCardId` |
| Redemption receipts | `1000777..2000775` | `1000776 + burnedCardId` |

`INITIAL_CARDS` is 777; `MAX_CARDS` is the lifetime ceiling of 999999. Every NFT
ID is recorded in `issued` permanently. A burned card can never be minted again.
Receipts are transferable proofs and cannot be burned or redeemed. Initial NFC
receipts survive independently when the corresponding card is redeemed.

`claim(tokenId, deadline, signature)` preserves the existing NFC flow.
`claimTo(recipient, tokenId, deadline, signature)` lets anyone pay gas to submit
the same recipient-bound authorization. Both use
`TarotClaim(address wallet,uint256 tokenId,uint256 deadline)`, with `wallet`
equal to the NFT recipient. `TarotClaimed` records that recipient, not a relayer.

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

Both new authorization types use `keccak256(abi.encode(ids))` for array hashes.
Signatures expire within ten minutes, bind the chain and collection address,
and cannot be reused. Shared types, calldata encoders, and digest helpers live
in `shared/ethereum/dmx.ts`, `shared/ethereum/tarot.ts`, and
`shared/ethereum/tarotCrypto.ts`. These are contract/operator capabilities;
there are no new HTTP endpoints or user interfaces.

Issuance and provenance are committed, then all selected inputs are burned,
before any output receiver callback. Any failed safe mint rolls back burns,
fees, issuance, and authorization consumption. `generation`, `createdByOrder`,
`redeemedByOrder`, `getTokenInfo`, and `getRedemption` preserve provenance after
burning; `tokenURI` still requires a currently existing NFT.

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

The live format is `https://mons.shop/nfc?code=<UUID>&tokenId=<1..777>&testnet=true`.
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
the retry deadline without automatically opening a wallet. Wallet and transaction
failures retain their feedback; temporary confirmation-read errors clear once
confirmation polling recovers.

Wallet submission records a public recovery intent before handing off to the
wallet. A shared window cache preserves it across SPA navigation when browser
storage fails. Disconnects cancel the active wait; uncertain submissions remain tracked
until a receipt arrives or confirmed unclaimed chain state passes the deadline.
Late wallet replies update only their original intent. Failed receipt replies
are ignored if a newer chain observation arrived during their request.

The browser calls `/api/ethereum/tarot/status`, `/prepare`, and `/confirm` using
POST JSON, explicit `testnet: true`, and the `X-Mons-CSRF` header. Every request
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

## Private credentials

Codes are random UUIDv4 values. `OPS_DB.tarot_claim_codes` stores only SHA-256
digests of the canonical input returned by `tarotCodeHashInput`, plus deployment,
card ID, creation time, and optional revocation time. Claimed cards retain their
credentials because NFC links remain usable as artwork views.

Generate and import credentials only after freezing the deployment address:

```sh
npm run tarot:ops -- links --contract <verified-Sepolia-contract>
npm run tarot:ops -- provision
npm run tarot:ops -- verify-codes
```

The default operator export is
`.operations/tarot-sepolia-v1/claim-links.private.json`, with directory mode 0700
and file mode 0600. Back up this private file before programming NFC cards. Never
publish it, paste its contents into logs, or add it to Git. Re-running generation
uses the same manifest; conflicting credentials or a different deployment fail
closed. Provisioning imports hashes only and verifies all 777 rows. No public
endpoint lists codes or imports credentials.

Successful provisioning readback and `verify-codes` record the public aggregate
fingerprint in `releases/tarot-sepolia-v1/credential-set.json`. All 777 database
rows must match first. The fingerprint binds the deployment and ordered
token-ID/code-hash pairs; it contains no codes, URLs, or individual code hashes.
Matching repeats preserve the file. A conflicting existing fingerprint stops
verification or provisioning before database writes. Changing the credential
set or deployment requires an explicit reviewed release-pin change.

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

The initial `DMXWebpRenderer` has no constructor arguments and returns Base64
JSON data URIs. Initial card and NFC-receipt names, descriptions, and artwork
remain the same. Card artwork is `https://wip.lil.org/tarot/bases/<cardId>.webp`;
both receipt kinds use `https://wip.lil.org/tarot/receipts/<sourceCardId>.webp`,
with distinct descriptions for NFC authentication and redemption. Future card
and redemption-receipt metadata also includes generation and order references.
Order references are decimal strings so JSON consumers preserve the full uint256 value.
Future WEBP files are not generated by this revision; prepare artwork or swap
the renderer before using IDs whose media is not yet available.

The owner can call `setRenderer` at any time. The new address must contain code,
must differ from the collection, and must advertise the renderer ERC-165
interface. The collection imposes no URI encoding restriction, so future
renderers may return HTTP/IPFS metadata or inline JSON containing SVG images
or HTML `animation_url` values. Renderer swaps emit `RendererUpdated`, an
ERC-4906 refresh covering all card and receipt IDs, and `ContractURIUpdated`.
Use `refreshMetadata(fromTokenId, toTokenId)` or `refreshContractMetadata()` when
changing data inside a future mutable renderer. Initial NFC receipts also emit
`MetadataUpdate` when their source card is redeemed.

The old static metadata at `https://cdn.mons.shop/tarot-sepolia/v1/` belongs only
to the frozen v1 release. These legacy utilities intentionally retain the old
receipt offset of 777 and must not be used to publish this new collection:

```sh
npm run tarot:ops -- metadata
npm run tarot:ops -- verify-media
npm run tarot:ops -- publish
npm run tarot:ops -- verify-public
```

Legacy publication uses `cdn-mons-shop`, refuses conflicting overwrites, and
reads every object back. The new renderer requires no metadata publication.

Use an independent encrypted Tarot authorization keystore, with its password in
Keychain, and provision `ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET` through Wrangler's
standard input. Never pass signer keys or passwords as command arguments. The
existing Sepolia deployment wallet is the administrator; do not reuse a 111K
authorization signer. Configure the API's `ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS`,
`DEPLOYMENT_BLOCK`, and `ENABLED` only after verifying the new deployment.

For a separately authorized future release, prepare, deploy, and verify the
renderer first using its own private directory. Then prepare the collection
against that verified renderer release. Collection preparation freezes the
renderer evidence and verifies its canonical deployment and runtime bytecode;
an arbitrary renderer address is not accepted as a substitute. The following
commands describe that future workflow, not actions performed for this change:

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
runner accepts only Sepolia and freezes source, constructor inputs, bytecode,
nonce, and fees. Renderer and collection have separate manifests and journals.
Source verification supports both contract types. Resume the same signed
journal after interrupted broadcasts. New manifests use release version 2;
old release directories remain frozen. Never redeploy or replace 111K as part
of Tarot work. Mainnet is supported by the collection source but remains outside
the current deployment runner, API, and frontend. Local Anvil is test-only.

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

Run the Tarot contract/deployment tests, frontend/API/runtime tests, and
`npm run test:tarot:e2e`. The E2E test deploys locally and submits real local
claims, recipient mints, multi-generation redemptions, and fee withdrawals.
It also checks receipt provenance, renderer swaps, and pause recovery. On public
Sepolia use signed preparation and `eth_call`/gas estimation only; do not consume
one of the 777 initial pairs during release acceptance.

At the separately authorized cutover, deploy the API with `npm run deploy:api`,
which applies OPS migrations and checks OPS integrity. This change does not alter
Commerce schemas or rows and does not need the full Commerce audit. Deploy the
storefront with `npm run deploy` only against the matching new contract revision.
Verify live NFC headers, Basel behavior, matching signer/configuration, all 777
credentials, and all 777 unclaimed onchain flags. Publish only aggregate
acceptance results, verified source hashes, and public deployment identity.

To stop issuing new authorizations, disable the Tarot API flag. Outstanding
signatures can remain valid for up to ten minutes. On-chain `setMintingPaused`
stops claims and both direct mint paths immediately. `setRedemptionsPaused`
independently stops redemptions; token transfers and fee withdrawals stay enabled.
The administrator can also rotate `quoteSigner` to revoke pending signatures,
then update the Worker secret and verify it matches before reopening. Metadata
and already-claimed artwork views remain available while preparation is disabled.
