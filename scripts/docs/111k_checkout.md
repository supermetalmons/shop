# 111K hosted checkout

The hosted checkout accepts crates and artworks from `111k_devnet`. It creates test delivery orders; no physical shipment is made. Other drops retain their existing redemption flow. Mainnet, additional wallet connectors, and partner webhooks are not enabled by this change.

## Open checkout

Navigate the browser to:

```text
https://mons.shop/checkout?drop=111k_devnet&ids=332,553,214&callback_url=https%3A%2F%2Fvvv.so%2Fcallback&state=YOUR_CORRELATION_VALUE
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `drop` | Exactly `111k_devnet`. |
| `ids` | Between 1 and 50 distinct, positive decimal **onchain token IDs**. Artwork numbers and crate display numbers are not interchangeable with token IDs. |
| `callback_url` | Optional; exactly `https://vvv.so/callback` or the Mons `/111k_devnet` return route. No query, fragment, credentials, or alternate port. Defaults to Mons. |
| `state` | Optional opaque correlation value, up to 512 characters without control characters. Use a fresh random value associated with the initiating request. Never put personal data or authentication credentials here. |

Mons validates the request, resolves the NFTs from the configured deployment, and replaces the URL with `/checkout/<checkout-id>`. This URL can be reopened without reconnecting a wallet. Selection and return destination are immutable for that checkout.

The visitor connects the wallet that owns every selected NFT, enters a shipping address, and confirms the Ethereum transaction. Connecting on VVV does not automatically connect or authenticate the same wallet on Mons. Checkout provides provider/account switching and revalidates ownership before preparing the transaction.

Preparing a delivery binds the checkout to its wallet and an immutable address snapshot. Changing the address after preparation requires a new checkout. The original signed quote remains valid until its deadline and is still reconciled if it executes.

## Browser return

The Return button navigates to the registered callback with:

| Parameter | Meaning |
| --- | --- |
| `checkout_id` | Opaque Mons checkout identifier. |
| `state` | Original correlation value, if supplied. |
| `result` | `canceled`, `pending`, `success`, or `failed`. |
| `chain_id` | Ethereum chain ID for this checkout. |
| `tx_hash` | Transaction hash when known. |

These parameters are advisory. `pending` can become `success` after the user returns. `canceled` means the visitor left before a known submission; it is not an onchain cancellation and does not revoke an issued quote. Wallet/network timeouts and missing transaction hashes are unresolved rather than definitive failures.

`success` means the transaction has the required confirmations and Mons has durably recorded the fulfillment order. It does not mean a parcel has shipped.

The caller must match `state` to its initiating request, then fetch the authoritative result and compare the drop, chain, contract, token IDs, and bound wallet against its expected selection. Never accept `result=success` from a URL as proof. Treat `state` as a correlation nonce, not as authorization.

## Read the result

VVV can read the sanitized result from its browser or backend:

```text
GET https://api.mons.shop/ethereum/111k/checkout/status?checkoutId=<checkout-id>
```

The response includes `checkoutId`, `dropId`, `chainId`, `contractAddress`, `tokenIds`, item previews, `wallet`, `status`, `orderId`, `transactionHash`, confirmation counts, and the current attempt. The state is one of:

- `ready`: no signed delivery has been prepared.
- `prepared`: the delivery quote and address snapshot have been saved.
- `submitting`: a wallet submission was started; its outcome is unresolved.
- `pending`: a reported or observed transaction is awaiting confirmation/publication.
- `success`: canonical confirmation and fulfillment publication completed.
- `failed`: the attempt failed, the draft expired, or finalized chain state proved the authorization expired unused.

The endpoint exposes no shipping addresses, email, profile data, claim codes, authentication tokens, or quote signatures. The VVV response omits the Mons browser's return URL. Checkout IDs do not authorize mutations. Responses are not cached; clients must handle rate limits and transient service errors without treating them as transaction failures.

Browsers on VVV send `Origin: https://vvv.so` automatically. Server-side requests must include that same header; it selects the public response policy and is not an authentication credential.

Only this read endpoint permits VVV browser access. Authentication, address storage, preparation, submission reports, and refresh remain Mons-origin operations. There is no partner webhook in this version. A caller using only an entry link learns the checkout ID on return; if the visitor never returns, Mons still completes the order, but the caller cannot rely on receiving a browser notification.

## Recovery and deployment

The backend persists the checkout/quote link before returning a signature and persists a submission marker before asking the wallet to send. Reported transaction hashes are stored separately from verified chain receipts. The existing event scanner can recover an order even when the browser closes before reporting the hash.

An open checkout refreshes promptly. After departure, the existing five-minute reconciliation schedule completes outstanding work; chain congestion, provider outages, and processing backlogs can take longer. No completion logic relies on unload handlers or the callback page.

Apply the additive checkout commerce migration and deploy the backward-compatible API before enabling the frontend. Keep the existing deliberate maintenance controls. Disabling new checkout entry must not remove persisted attempts or stop normal reconciliation.

Unprepared checkout drafts expire after 24 hours. Expired drafts without a quote or submission attempt are deleted in bounded scheduled batches; their URLs then return not found. Prepared orders and submission attempts remain available for recovery. Anonymous creation has a separate rate limit from status polling. If another checkout already has an active submission for any of the same NFTs, Mons blocks preparation or another send and provides a link to resume the pending checkout.

Abandoned submissions and unverified contract-wallet failures release their reservations only after a finalized block is past the authorization deadline and proves the order was never redeemed. Until then they remain pending; a timeout alone does not release them. An expired attempt reports `failed`, and the visitor can start a new checkout. Mons also retains pending item reservations across local navigation and tabs so those crates cannot be opened while redemption is unresolved.

For local development, the internal callback is the same allowed localhost/127.0.0.1 origin at `/111k_devnet`. Production external returns remain restricted to `https://vvv.so/callback`. Callback registration is centralized in `shared/ethereum/checkout.ts`.
