# 111K Reveal API

Display artwork after an unpack's first canonical Ethereum confirmation. Use API results immediately; CDN metadata and marketplaces may update later.

For the relic selection and claim page, use the [relic claims guide](111k_relic_claims.md).

## Connection

- Base URL: `https://api.mons.shop`
- Send `POST` with `Content-Type: application/json` and `X-Mons-CSRF: 1`.
- Allowed VVV origins: `https://vvv.so` and `https://www.vvv.so`. Browsers set `Origin` automatically; backend callers must supply it.
- No API key, wallet session, or signature is required.

Examples target the Sepolia [v17 release](../../releases/111k-sepolia-v17/README.md), using catalog `111k-v5`. The collection was deployed at block `12092412`; the release record tracks activation, opening, and acceptance. Mons supplies the chain ID and contract address for other deployments. Send only the fields shown.

## Unrevealed artwork

The **placeholder** is the shared image for unrevealed artwork. An unrevealed token's metadata has this `image` URL:

[`https://cdn.lil.org/nft/111k/placeholder.png`](https://cdn.lil.org/nft/111k/placeholder.png)

The placeholder is 932 × 1006 pixels; metadata includes `"aspectRatio": { "width": 466, "height": 503 }`. Artwork, crate, and relic receipts share this placeholder. Crates use `https://cdn.lil.org/nft/111k/crate.webp` at 4:3 and warehouses use `https://cdn.lil.org/nft/111k/warehouse.webp` at 3:2.

Show the placeholder while waiting, then replace it with the returned artwork and its assigned aspect ratio. Pending responses contain `artworks: []`, not an artwork object containing the placeholder URL.

## 1. Reveal an unpack transaction

Save the transaction hash after broadcast and call:

```text
POST /ethereum/111k/reveal/transaction
```

```json
{
  "chainId": 11155111,
  "contractAddress": "0xaca342968965ddb20badb1943b99ee6523658619",
  "transactionHash": "<wallet-returned 0x-prefixed 64-hex-digit hash>"
}
```

| Response `status` | What to do |
| --- | --- |
| `pending` | Show the placeholder. Retry after `retryAfterMs`. |
| `revealed` | Render every item in `artworks` and stop polling. |
| `reverted` | The transaction failed. Stop polling this hash. |
| `not_unpack` | No crate unpack was found for this collection. Stop polling. |

Other statuses have empty `artworks`. Non-pending responses use `retryAfterMs: 0`. Optional `observedBlock` contains `{ "number": 123, "hash": "0x…" }`.

Requests are idempotent. Resume pending hashes after reload; submit replacement hashes when provided by the wallet. Bundled transactions can include several wallets' unpacks. For a wallet's gallery, save its intended crate IDs and show only artworks with matching `crateTokenId`, regardless of current ownership.

Available results are read from the reveal ledger. When verification is needed, the request waits for up to two seconds of chain work before returning the current result. This is an inline work budget, not a network latency guarantee. Admitted work continues in the background after the response or a disconnect. Once RPC has confirmed that a pending transaction exists, including a wrapped transaction, it has no tracking expiry merely because it remains pending.

Independent unpacks are verified concurrently with bounded capacity. A busy collection can return `pending` while admitted work waits for a slot; keep polling the same hash at the supplied interval. Metadata publication has separate capacity and does not delay an available API result.

## 2. Recover artwork by token ID

Use this when the unpack hash is unavailable or inventory still shows the placeholder:

```text
POST /ethereum/111k/reveal/tokens
```

```json
{
  "chainId": 11155111,
  "contractAddress": "0xaca342968965ddb20badb1943b99ee6523658619",
  "tokenIds": ["1", "21"]
}
```

Send **1–500 onchain artwork IDs** as decimal strings from `"1"` to `"111111"`, not crate or receipt IDs.

The response contains available `artworks` and an `unresolved` array:

```json
[
  { "tokenId": "1", "status": "recovering" },
  { "tokenId": "21", "status": "unminted" }
]
```

- `recovering`: retry this ID after `retryAfterMs`.
- `unminted`: no mint has been established. Recheck after a mint or inventory update; do not loop immediately when `retryAfterMs` is `0`.

Display successful results immediately and retry only unresolved IDs. Token recovery uses the same bounded inline wait and continues in the background; a slow lookup must not prevent displaying artwork already returned.

Mixed requests can include revealed and unminted IDs. When a previously unminted result needs refreshing, the API waits within its existing two-second budget for that check before returning the current status. A slow or failed check remains `recovering`; it never substitutes an expired `unminted` result for fresh mint evidence.

## Response fields and media

Both responses include `deploymentId`, `dropId`, `chainId`, `contractAddress`, `artworks`, and `retryAfterMs` (milliseconds), without a wrapper. Check the returned chain and contract. Catalog-update support adds `catalogRevision`, a nonnegative integer; treat an omitted revision as `0` during rollout.

Each artwork has this shape (illustrative values):

```json
{
  "tokenId": "1",
  "crateTokenId": "111112",
  "category": "video",
  "name": "1",
  "image": "https://cdn.lil.org/nft/111k/videos/1.webp",
  "animation_url": "https://cdn.lil.org/nft/111k/videos/1.mp4",
  "aspectRatio": { "width": 16, "height": 9 },
  "observation": {
    "transactionHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "blockNumber": 12087016,
    "blockHash": "0x2222222222222222222222222222222222222222222222222222222222222222"
  }
}
```

- `category`: `egg`, `painting`, `video`, `3d`, or `animated`.
- `image`: the artwork image, video or animated poster, or square 3D preview.
- `animation_url`: present for videos and animated artworks (MP4), and 3D models (GLB). Choose the renderer from `category`; a GLB URL is not a video source. Eggs and paintings have no `animation_url`.
- `aspectRatio`: proportions, **not pixel dimensions**. Use CSS `aspect-ratio: width / height`.
- Optional `description` and `attributes`; each attribute has `trait_type` and a string or number `value`.
- `observation`: the first transaction/block that authorized reveal; it does not prove ownership or finality.

For a 3D artwork, the media fields are:

```json
{
  "category": "3d",
  "image": "https://cdn.lil.org/nft/111k/3d/1.png",
  "animation_url": "https://cdn.lil.org/nft/111k/3d/1.glb",
  "aspectRatio": { "width": 1, "height": 1 },
  "attributes": [{ "trait_type": "type", "value": "3d" }]
}
```

This fragment uses the same `tokenId`, `crateTokenId`, `name`, and `observation`
fields as the complete artwork example. Use the PNG in grids and as the loading
or error fallback; load the GLB in an interactive model viewer when opening the
artwork. The 1:1 ratio describes the preview frame, not the model's geometry.
Media IDs are local to each category and do not have to match the onchain token ID.

For an animated artwork, the media fields are:

```json
{
  "category": "animated",
  "image": "https://cdn.lil.org/nft/111k/animated/1.png",
  "animation_url": "https://cdn.lil.org/nft/111k/animated/1.mp4",
  "aspectRatio": { "width": 466, "height": 503 },
  "attributes": [{ "trait_type": "type", "value": "animated" }]
}
```

Animated artworks use MP4 playback with a PNG poster and a distinct `animated`
category and type trait. IDs 1–421 currently have a 932 × 1006
frame, represented by the reduced ratio 466:503. Always use the returned
`aspectRatio`: animated artworks, paintings, and videos support per-asset ratios, and
future assets may differ. The fragment has the same surrounding artwork fields
as the complete example above.

The v5 catalog contains 76,642 eggs, 30,990 paintings, 58 videos, 3,000 3D
models, and 421 animated artworks: 111,111 artworks total. The token-ID range
and request limits are unchanged. Painting alts and video posters are variants
of those artworks, not extra tokens. Videos include 16:9, 427:240, and 54:31
ratios; use the returned ratio instead of assuming a fixed widescreen frame.

New assignments use a soft cap of eight eggs per crate, including the final
31-artwork crate. Once the current allocation reaches eight eggs, additional
draws use non-egg categories while any have free inventory. Eggs can exceed the
cap when free non-egg inventory is exhausted; assets reserved by other crates
are unavailable. Eligible categories retain their original catalog weights.
Existing reservations and revealed artwork are preserved, even if they already
exceed the cap. Historical frozen assignments outside the current unpack's token
range do not count toward its limit.

Cache media by `(chainId, contractAddress, deploymentId, tokenId)` and retain each
item's `metadataRevision`; omitted legacy revisions mean `0`. Replace metadata
only with the same or a higher token revision. Revisions encode the assignment
revision and publication stage, so delayed base metadata cannot replace newer
artwork or enriched traits. Use current inventory data for ownership.

An online catalog update replaces cutoff eggs using a frozen random mapping,
without changing token IDs or stopping reads and reveals. Config and inventory
envelopes retain `catalogRevision` as a refresh signal. On advancement, keep the
visible inventory and pending transaction tracking while refreshing owned tokens
in the background. A pagination boundary crossing activation can be retried
internally; per-token revisions remain authoritative across mixed responses.
Catalog activation does not introduce a maintenance `503` response.

The API serves canonical artwork from the coordinator immediately after activation.
The public token URI and marketplace copy may still show the previous metadata
until conditional background publication and external refresh finish. Do not tag
CDN metadata with a newer API revision or let it replace a newer cached token.

Metadata JSON addresses follow the collection's configured base URI plus the decimal token ID and `.json`. The JSON address itself is predictable before minting; it contains only the placeholder until reveal. Use the methods above to establish reveal status and obtain media immediately, without waiting for CDN or marketplace refreshes.

After initial media publication, the token’s CDN JSON receives its artwork traits in a background update. Paintings, videos, 3D models and animated works list `collection block` first, then their original attributes, then the source traits. Eggs keep their original attributes. The reveal response continues to serve the frozen artwork immediately. Read the token URI for the enriched attributes.

Published revealed metadata also contains `revealStatus: "revealed"`, which the
shop uses to skip redundant recovery requests. Baseline placeholder metadata
omits this field. It is a shop-specific metadata field, not an OpenSea requirement
or an extra field on each artwork returned by these API endpoints. Transaction
responses use their top-level `status`; token responses use `artworks` and `unresolved`.

## Errors and retries

Errors contain `error.code` and `error.message`. For normal polling, follow `retryAfterMs`.

| HTTP status | Action |
| --- | --- |
| `400` / `405` | Correct the request body / use `POST`. |
| `403` | Check `Origin` and `X-Mons-CSRF`. |
| `404` | Confirm the chain and contract with Mons. |
| `409` | The collection is paused or uses a retired catalog. For a paused current catalog, admitted work continues. A retired catalog is no longer served; stop polling it and use the current collection configuration. |
| `429` | Rate or tracking capacity was reached. Wait for `Retry-After` (seconds), then retry the same request. |
| `5xx` / network error | Retry with exponential backoff, capped at 30 seconds. |

Limits: **10,000 new admissions / 120,000 total requests per minute** per origin/IP pair, approximately per Cloudflare location. A token batch counts as one request. Keep successful results when another request fails.

There is also a separate collection limit of **10,000 unresolved transaction hashes whose crate scope is not yet known**. A new hash refused at this limit is not queued. Previously admitted work continues; retry the same hash after `Retry-After` rather than submitting another wallet transaction.
