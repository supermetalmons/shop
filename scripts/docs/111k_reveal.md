# 111K Reveal API

Display artwork after an unpack's first canonical Ethereum confirmation. Use API results immediately; CDN metadata and marketplaces may update later.

## Connection

- Base URL: `https://api.mons.shop`
- Send `POST` with `Content-Type: application/json` and `X-Mons-CSRF: 1`.
- Allowed VVV origins: `https://vvv.so` and `https://www.vvv.so`. Browsers set `Origin` automatically; backend callers must supply it.
- No API key, wallet session, or signature is required.

Examples use the current Sepolia collection. Mons supplies the chain ID and contract for other collections. Send only the fields shown.

## Unrevealed artwork

The **placeholder** is the shared image for unrevealed artwork. An unrevealed token's metadata has this `image` URL:

[`https://wip.lil.org/111k/artwork_placeholder.png`](https://wip.lil.org/111k/artwork_placeholder.png)

Show this image while waiting, then replace it with the returned artwork. Pending responses contain `artworks: []`, not an artwork object containing the placeholder URL.

## 1. Reveal an unpack transaction

Save the transaction hash after broadcast and call:

```text
POST /ethereum/111k/reveal/transaction
```

```json
{
  "chainId": 11155111,
  "contractAddress": "0x8b4044dbd10c05d84d067208980de58e9d5fe915",
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

## 2. Recover artwork by token ID

Use this when the unpack hash is unavailable or inventory still shows the placeholder:

```text
POST /ethereum/111k/reveal/tokens
```

```json
{
  "chainId": 11155111,
  "contractAddress": "0x8b4044dbd10c05d84d067208980de58e9d5fe915",
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

Display successful results immediately and retry only unresolved IDs.

## Response fields and media

Both responses include `deploymentId`, `dropId`, `chainId`, `contractAddress`, `artworks`, and `retryAfterMs` (milliseconds), without a wrapper. Check the returned chain and contract.

Each artwork has this shape (illustrative values):

```json
{
  "tokenId": "1",
  "crateTokenId": "111112",
  "category": "video",
  "name": "1",
  "image": "https://wip.lil.org/111k/videos/1.webp",
  "animation_url": "https://wip.lil.org/111k/videos/1.mp4",
  "aspectRatio": { "width": 16, "height": 9 },
  "observation": {
    "transactionHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "blockNumber": 12005468,
    "blockHash": "0x2222222222222222222222222222222222222222222222222222222222222222"
  }
}
```

- `category`: `egg`, `painting`, or `video`.
- `image`: the image or video poster. Videos also include an MP4 `animation_url`.
- `aspectRatio`: proportions, **not pixel dimensions**. Use CSS `aspect-ratio: width / height`.
- Optional `description` and `attributes`; each attribute has `trait_type` and a string or number `value`.
- `observation`: the first transaction/block that authorized reveal; it does not prove ownership or finality.

Cache media by `(chainId, contractAddress, tokenId)`. Revealed artwork stays unchanged through reorgs and remints. Use inventory data for ownership.

## Errors and retries

Errors contain `error.code` and `error.message`. For normal polling, follow `retryAfterMs`.

| HTTP status | Action |
| --- | --- |
| `400` / `405` | Correct the request body / use `POST`. |
| `403` | Check `Origin` and `X-Mons-CSRF`. |
| `404` | Confirm the chain and contract with Mons. |
| `409` | New reveal admission is paused or unavailable. Previously admitted work continues. |
| `429` | Wait for `Retry-After` (seconds) before sending more requests. |
| `5xx` / network error | Retry with exponential backoff, capped at 30 seconds. |

Limits: **10,000 new admissions / 120,000 total requests per minute** per origin/IP pair, approximately per Cloudflare location. A token batch counts as one request. Keep successful results when another request fails.
