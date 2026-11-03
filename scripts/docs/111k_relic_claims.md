# 111K relic claims — VVV

## Display

Show **Relic #1–#18** using `https://wip.lil.org/111k/relics/{id}.webp`. Always show all eighteen choices; the allocated supply limits total claims, not selectable IDs. No metadata, stats, or inventory API is needed for this page.

## Read availability and wallet allowance

```text
GET https://api.mons.shop/ethereum/111k/relics?chainId=11155111&contractAddress=0x6d194e6cc762424e408b84907c25d60f0db29d12&owner=0xYOUR_WALLET
```

`chainId` and `contractAddress` are required. Omit `owner` before connecting. Mainnet uses `chainId=1` and the registered contract supplied by Mons; the example is Sepolia.

Allowed origins: `https://vvv.so`, `https://www.vvv.so`. Browsers set `Origin`; backend callers must supply it. No API key, session, signature, or CSRF header is required.

The JSON response has no wrapper:

- `chainId`, `contractAddress`, `owner`: verify these match the request.
- `saleActive`, `relicsAllocated`, `relicsMinted`, `remainingRelics`: sale state and supply.
- `claimedMask`: ID `id` is claimed when `(claimedMask & (1 << (id - 1))) !== 0`; dim and disable it.
- `relicLimit`, `relicsUsed`, `remainingAllowance`: wallet claim allowance. Without `owner`, do not infer eligibility.
- `observedBlock`, `blockHash`: the shared onchain snapshot.

Poll every four seconds while visible; refresh on wallet changes and before claiming. Disable claims on loading/errors or data older than eight seconds. `429`: honor `Retry-After` seconds; `5xx`: back off up to 30 seconds. `400`: fix parameters; `404`: confirm collection with Mons.

## Claim

Enable Claim with fresh data when the wallet is connected, `saleActive`, both remaining counts are positive, and the selected ID is unclaimed.

On the requested chain, call the collection directly from that wallet:

```text
function claimRelic(uint256 relicId)
```

Pass **1–18**, send **zero ETH value**; the wallet pays gas. One relic per transaction. Its ERC-721 token ID is `117171 + relicId`. Availability is not a reservation; concurrent claims can revert. Wait for a successful receipt, then refresh status.

For later crate unpacking, use the [reveal API](111k_reveal.md).
