# 111k public API

This reference covers public configuration, statistics, inventory, metadata, transaction confirmation, relic availability, and artwork reveal. Start with the [VVV mainnet checklist](111k_mainnet_vvv.md) for the mainnet request changes. Public API readiness does not open the onchain sale or enable hosted checkout, physical redemption, or wallet authentication.

## Connection and collection selection

Base URL: `https://api.mons.shop`.

VVV may call from exactly `https://vvv.so` or `https://www.vvv.so`. Browsers supply `Origin`; backend callers must set it. Public requests require no API key, session, or wallet signature. Send `Content-Type: application/json` and `X-Mons-CSRF: 1` on POSTs. GETs do not require those headers. CORS preflight supports the endpoint's method and exposes `Retry-After`.

The mainnet collection is:

| Field | Value |
| --- | --- |
| `chainId` | `1` |
| `contractAddress` | `0x08cded8258730bda384ff198001e47a1b50f7f9d` |
| `deploymentId` | `mainnet-v1` |
| `dropId` | `111k` |
| Metadata base URI | `https://cdn.mons.shop/111k/` |

Select a collection with **both** `chainId` and `contractAddress`: query parameters for GETs, JSON fields for POSTs. VVV must supply the pair. An incomplete pair, duplicate query parameter, malformed address, unsupported chain, or local-chain selector in production is rejected. Scoped config, stats, inventory, and metadata reject query parameters not listed below. The registered chain/contract selects the deployment; clients cannot override its metadata URI, catalog, or deployment ID.

Approved Mons callers may continue omitting selectors on the existing config, stats, inventory, metadata, and confirmation endpoints. That legacy behavior uses the configured storefront and retains its existing response shape and Commerce readiness rules. It is not a mainnet fallback. Relic and reveal requests always require explicit collection identity.

Scoped config, stats, inventory, metadata, and transaction-confirmation responses include collection identity:

```json
{
  "deploymentId": "mainnet-v1",
  "dropId": "111k",
  "chainId": 1,
  "contractAddress": "0x08cded8258730bda384ff198001e47a1b50f7f9d",
  "catalogRevision": 0
}
```

These fields accompany the endpoint's data at the top level; there is no success wrapper. Check them against the request. The existing reveal responses already include this identity; relic responses retain their existing `chainId` and `contractAddress` fields without adding deployment or catalog fields. `catalogRevision` can advance while the deployment and token IDs stay unchanged. Cache collection data by chain and contract, and token data by `(chainId, contractAddress, deploymentId, tokenId)`. Retain `metadataRevision` per token, treating omission as `0`, and do not replace newer metadata with an older revision.

## Public GET endpoints

Every example below uses this query prefix:

```text
?chainId=1&contractAddress=0x08cded8258730bda384ff198001e47a1b50f7f9d
```

| Path | Additional parameters | Result |
| --- | --- | --- |
| `/ethereum/111k/config` | None | Public readiness, sale state, network information, prices, and transaction limits. |
| `/ethereum/111k/stats` | Optional `owner=<wallet>` | Supply, live prices, discount root, and wallet discount usage. |
| `/ethereum/111k/inventory` | Required `owner=<wallet>`; optional `cursor`, `expectedTokenIds` | Owned items, pagination cursor, and observed block. |
| `/ethereum/111k/metadata` | Required `kind`, `displayId` | Metadata for one item plus collection identity. |
| `/ethereum/111k/relics` | Optional `owner=<wallet>` | Relic supply, selected-ID availability, wallet allowance, and public relic sale state. |

For example:

```text
GET https://api.mons.shop/ethereum/111k/stats?chainId=1&contractAddress=0x08cded8258730bda384ff198001e47a1b50f7f9d&owner=0xYOUR_WALLET
```

### Configuration and readiness

Scoped config returns the identity fields above and:

- `enabled`: the registered collection is provisioned for public API use. This is independent of Commerce checkout controls and the onchain sale flag.
- `revealEnabled`: the collection is ready and active for new reveal work.
- `saleActive`: the current onchain mint-sale flag.
- `chainName`, `testnet`, `explorerUrl`, `walletRpcUrl`, `metadataBaseUri`, and `deploymentBlock`.
- Live `cratePriceWei` and `warehousePriceWei`, plus `confirmationBlocks`, `maxMintQuantity`, and `maxUnboxQuantity`.

Treat the three flags separately. A closed sale can have working public reads and active reveal processing. A paused reveal deployment can still serve reads and previously available results while declining new reveal work. Scoped config does not include delivery settings or authorize redemption.

### Statistics and discount proofs

Stats includes `owner`, `saleActive`, `allocatedCrates`, `warehousesMinted`, `artworksMinted`, `relicsAllocated`, `relicsMinted`, `publicRelicsMinted`, `remainingCrates`, `remainingWarehouses`, and `remainingRelics`. Reserved relics already consume crate allocation; wallet allowances are not themselves minted tokens.

Prices are decimal wei strings: `cratePriceWei`, `warehousePriceWei`, and `discountCratePriceWei`. Discount fields are `discountMerkleRoot`, `discountAllowance`, `discountUsed`, and, on the current mainnet contract, `maxDiscountedMints` and `totalDiscountedMints`. Pass `owner` for wallet-specific usage. The usable discount quantity is limited by both the remaining wallet allowance and the remaining global cap.

Discount proofs are distributed as a static [mainnet JSON file](../../src/ethereum/discounts/111k-mainnet.json), not a proof API endpoint. It includes `chainId`, `contractAddress`, `root`, and `proofs`, whose keys are lowercased wallet addresses. Require its identity and root to match the chosen collection and the live stats response before using a proof. A missing wallet key means the file has no proof for that wallet. A root mismatch means the file is stale or for another collection; obtain the current file from Mons. Do not substitute the Sepolia `111k.json` dataset.

### Inventory and metadata

Inventory returns `items`, `nextCursor`, and `observedBlock`, with collection identity. Each item includes its onchain `tokenId`, `kind`, item `displayId`, `owner`, collection identity, and metadata. An empty inventory does not remove a free-mint or relic-claim allowance.

Pass the returned opaque `nextCursor` unchanged to fetch another page, retaining the same owner and collection. On the first page, `expectedTokenIds` may contain up to 100 comma-separated onchain token IDs from a recent transaction. These IDs are checked against current onchain ownership to bridge indexer lag; they do not bypass ownership checks and are not used on subsequent cursor pages.

Metadata uses an item kind and its **display ID**:

```text
GET https://api.mons.shop/ethereum/111k/metadata?chainId=1&contractAddress=0x08cded8258730bda384ff198001e47a1b50f7f9d&kind=relic&displayId=1
```

Kinds are `artwork`, `crate`, `warehouse`, `artwork_receipt`, `crate_receipt`, `relic`, and `relic_receipt`. Their display numbers differ from onchain token IDs for some kinds; for example, relic display ID `1` has token ID `117172`. Metadata lookup can return a prepublished placeholder before minting and does not prove existence, ownership, or reveal completion. Use inventory for ownership and the reveal endpoints for reveal status.

## Confirm a transaction

```text
POST /ethereum/111k/transactions/confirm
```

```json
{
  "chainId": 1,
  "contractAddress": "0x08cded8258730bda384ff198001e47a1b50f7f9d",
  "transactionHash": "<0x-prefixed 64-hex-digit transaction hash>"
}
```

Supply only the three JSON fields shown and no query parameters. The response contains collection identity, `status`, `confirmations`, `items`, and `burnedTokenIds`. A successful mined receipt also includes `logs` filtered to the selected contract. An unknown or noncanonical receipt returns `status: "pending"`; a canonical successful receipt returns `status: "confirmed"` with the observed confirmation count. A reverted receipt returns HTTP `409`.

`confirmed` means a successful canonical receipt was found. It does **not** guarantee a particular confirmation threshold, an intended mint/unpack, or even an event from the selected collection. An unrelated successful transaction can return empty items and logs. Inspect the expected contract events and token IDs and apply your required confirmation threshold. This endpoint does not submit a transaction or trigger artwork reveal.

## Reveal and relic APIs

The [reveal guide](111k_reveal.md) defines `/ethereum/111k/reveal/transaction` and `/ethereum/111k/reveal/tokens`. Both are POSTs with the explicit identity pair and either `transactionHash` or 1–500 onchain artwork `tokenIds`. Mainnet uses the same request and response format as Sepolia. Render available results immediately and follow `retryAfterMs` for pending work; metadata publication and marketplace refresh may finish later.

The [relic guide](111k_relic_claims.md) defines the scoped GET, claimed-ID mask, reserved claims, and public relic sale fields. Claims and mints are wallet transactions to the selected contract, not writes performed by the public API. Read live flags and allowances before enabling those actions.

## Errors and retry behavior

Errors contain `error.code` and `error.message`.

| HTTP status | Meaning and action |
| --- | --- |
| `400` | Correct malformed, missing, duplicate, or unsupported selectors or endpoint arguments. VVV requests require explicit scope. |
| `403` | Correct the origin or missing POST `X-Mons-CSRF: 1` header. |
| `404` | The chain/contract is not registered; check collection identity with Mons. |
| `405` | Use the endpoint's supported method. |
| `409` | The deployment is retired or its catalog is unsupported; new reveals can also be inactive. Confirmation can report a reverted transaction. Inspect the error; do not blindly retry a terminal condition. |
| `429` | Honor `Retry-After` in seconds and retry the same request. |
| `503` / other `5xx` | Public data is not ready or a dependency is temporarily unavailable. Retry with exponential backoff capped at 30 seconds. |

Scoped config can report `enabled: false` before provisioning completes; other scoped public reads require a provisioned collection. Preserve successful results when another request fails. HTTP `Retry-After` uses seconds; reveal response `retryAfterMs` uses milliseconds.
