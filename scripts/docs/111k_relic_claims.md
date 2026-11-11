# 111K relic claims — VVV

For mainnet identity and request changes, use the [VVV mainnet checklist](111k_mainnet_vvv.md). The [public API reference](111k_public_api.md) covers the other scoped read and confirmation endpoints; the examples below retain their explicit Sepolia scope.

## Display

Show **Relic #1–#18** using the storefront images `https://cdn.lil.org/nft/111k/relics/mid/{id}.webp`. Canonical NFT metadata uses `https://cdn.lil.org/nft/111k/relics/{id}.png`. Always show all eighteen choices; the allocated supply limits total claims, not selectable IDs. No metadata, stats, or inventory API is needed for this page.

## Read availability and wallet allowance

```text
GET https://api.mons.shop/ethereum/111k/relics?chainId=11155111&contractAddress=0xaca342968965ddb20badb1943b99ee6523658619&owner=0xYOUR_WALLET
```

`chainId` and `contractAddress` are required. Omit `owner` before connecting. Mainnet uses `chainId=1` and the registered contract supplied by Mons; the example is Sepolia.

The example targets the live [v17 release](../../releases/111k-sepolia-v17/README.md), with seven reserved claims and one unused claim per test wallet at acceptance. Public relic minting remains disabled; always use the returned live state when enabling actions.

Allowed origins: `https://vvv.so`, `https://www.vvv.so`. Browsers set `Origin`; backend callers must supply it. No API key, session, signature, or CSRF header is required.

The JSON response has no wrapper:

- `chainId`, `contractAddress`, `owner`: verify these match the request.
- `saleActive`, `relicsAllocated`, `relicsMinted`, `remainingRelics`: sale state and supply.
- `claimedMask`: ID `id` is claimed when `(claimedMask & (1 << (id - 1))) !== 0`; dim and disable it.
- `relicLimit`, `relicsUsed`, `remainingAllowance`: wallet claim allowance. Without `owner`, do not infer eligibility.
- `publicRelicsMinted`: lifetime public issuance, including paid and free mints; zero for earlier contracts. Reserved claim counts and allowances above exclude these mints.
- `publicSale`: `null` for earlier contracts; otherwise `{ limit, minted, priceWei, active, mintable, freeLimit, freeUsed, remainingFreeAllowance }`. `limit` is cumulative released public supply; `active` is the public sale flag. `mintable` is zero while either sale gate is closed, otherwise the lesser of unused public quota and `floor(remainingCrates / 111)`. Free allowance limits are lifetime totals and can be revoked without resetting usage.
- `observedBlock`, `blockHash`: the shared onchain snapshot.

The claimed mask includes both reserved claims and public mints, including relics later unpacked or redeemed. Both paths permanently consume their selected ID. Reserved `remainingRelics` stays independent of public availability. Public sale data and the existing claim fields are read from the same block; unavailable public reads fail the request rather than falling back to legacy values.

Poll every four seconds while visible; refresh on wallet changes and before claiming. Disable claims on loading/errors or data older than eight seconds. `429`: honor `Retry-After` seconds; `5xx`: back off up to 30 seconds. `400`: fix parameters; `404`: confirm collection with Mons.

## Claim

Enable Claim with fresh data when the wallet is connected, `saleActive`, both remaining counts are positive, and the selected ID is unclaimed.

On the requested chain, call the collection directly from that wallet:

```text
function claimRelic(uint256 relicId)
```

Pass **1–18**, send **zero ETH value**; the wallet pays gas. One relic per transaction. Its ERC-721 token ID is `117171 + relicId`. Availability is not a reservation; concurrent claims can revert. Wait for a successful receipt, then refresh status.

For later crate unpacking, use the [reveal API](111k_reveal.md).

## Public relic minting

New collection versions also support `mintRelic(uint256 relicId)` with transaction `value: BigInt(publicSale.priceWei)` in wei, and `mintFreeRelic(uint256 relicId)` with zero ETH when the wallet has remaining public free allowance. Both require `saleActive`, `publicSale.active`, positive `publicSale.mintable`, and an unused ID from 1–18. Each successful public mint consumes 111 available crates. Preorder claims continue to use their pre-reserved crates and `claimRelic` unchanged.

Owner controls are `setPublicRelicSale(uint256 limit, uint256 priceWei, bool active)` and `setPublicRelicFreeMintAllowances(address[] wallets, uint16 limit)`. Raising the sale limit from 2 to 5 releases three more public relics; configuring limits or allowances reserves no crates. The limit cannot exceed `18 - relicsAllocated` or fall below public issuance. `publicRelicStats(address wallet)` reads the sale limit, public minted count, price, public flag, mintable count, free limit and free used count directly from the contract. This release adds the contract and read interfaces; the existing Mons claim UI continues to submit preorder claims.
