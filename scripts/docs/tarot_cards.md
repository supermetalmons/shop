# Tarot Cards

Tarot Cards is a Sepolia-only collection of 777 independently claimable pairs.
The card has token ID `1..777`; its NFC receipt has ID `cardId + 777`. One free
claim mints both NFTs to the connected wallet. The wallet pays Sepolia gas.
Evolution and physical redemption are not part of this release.

## NFC links

The live format is `https://mons.shop/nfc?code=<UUID>&tokenId=<1..777>&testnet=true`.
`/nfc?code=basel` preserves the original video placeholder. The standard shop
header appears immediately; the card and claim content wait for code validation.
After three canonical confirmations, the same link shows one large card artwork
below the header, including after either NFT is transferred. It fits the remaining
viewport without extra page scrolling. The receipt and claim controls are removed.
Invalid links never expose Tarot claim controls.

Temporary initial validation failures retry automatically with bounded backoff
and honor `Retry-After`, without opening a wallet or adding controls. Retries
pause while the page is hidden or suspended, and stop on success or an invalid
link. After the automatic retry budget is exhausted, refocusing the page can
retry after its cooldown. Unrelated shop account errors stay outside NFC pages.

A later 401 or 403 invalidates unclaimed access and cancels queued wallet work
without discarding pending recovery. Claim stays unavailable until validation
succeeds again. Rate-limit cooldowns disable the existing Claim button and
re-enable it at the retry deadline without automatically opening a wallet.

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

Metadata is at `https://cdn.mons.shop/tarot-sepolia/v1/`, with token ID filenames
and `collection.json`. Card artwork uses `https://wip.lil.org/tarot/bases/<id>.webp`;
receipt artwork uses `https://wip.lil.org/tarot/receipts/<id>.webp`. There are 1,554
token records plus collection metadata, with no secrets in any public object.

```sh
npm run tarot:ops -- metadata
npm run tarot:ops -- verify-media
npm run tarot:ops -- publish
npm run tarot:ops -- verify-public
```

Publication uses the existing `cdn-mons-shop` R2 bucket and the dedicated Tarot
prefix. It refuses to overwrite conflicting objects, supports resumption, and
reads every object back. Public verification checks every metadata record.

Use an independent encrypted Tarot authorization keystore, with its password in
Keychain, and provision `ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET` through Wrangler's
standard input. Never pass signer keys or passwords as command arguments. The
existing Sepolia deployment wallet is the administrator; do not reuse a 111K
authorization signer. Configure the API's `ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS`,
`DEPLOYMENT_BLOCK`, and `ENABLED` only after verifying the new deployment.

```sh
npm --prefix onchain/ethereum run tarot:deploy -- prepare --directory <private-release> --quote-signer <public-signer-address>
npm --prefix onchain/ethereum run tarot:deploy -- sign --directory <private-release> --keystore <encrypted-deployer-keystore> --password-file <private-password-file>
npm --prefix onchain/ethereum run tarot:deploy -- broadcast --directory <private-release>
npm --prefix onchain/ethereum run tarot:deploy -- verify --directory <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- submit <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- status <private-release>
npm --prefix onchain/ethereum run tarot:verify-source -- verify <private-release>
```

RPC configuration comes from `ETHEREUM_TAROT_RPC_URL` or `ALCHEMY_API_KEY`. The
runner accepts only Sepolia and freezes source, constructor inputs, bytecode,
nonce, and fees. Resume the same signed journal after interrupted broadcasts.
Never redeploy or replace 111K as part of Tarot work. Mainnet is rejected by the
contract, deployment runner, API, and frontend; local Anvil is test-only.

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
claims. On public Sepolia use signed preparation and `eth_call`/gas estimation
only; do not consume one of the 777 initial pairs during release acceptance.

Deploy the API with `npm run deploy:api`, which applies the OPS migration and
checks OPS integrity. This change does not alter Commerce schemas or rows and
does not need the full Commerce audit. Deploy the storefront with `npm run deploy`.
Verify live NFC headers, Basel behavior, matching signer/configuration, all 777
credentials, and all 777 unclaimed onchain flags. Publish only aggregate
acceptance results, verified source hashes, and public deployment identity.

To stop issuing new authorizations, disable the Tarot API flag. Outstanding
signatures can remain valid for up to ten minutes. The administrator can rotate
`quoteSigner` to revoke outstanding signatures immediately, then update the
Worker secret and verify it matches before reopening. The existing metadata
and already-claimed artwork views remain available while preparation is disabled.
