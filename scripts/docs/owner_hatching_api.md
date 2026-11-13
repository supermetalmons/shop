# Owner hatching API

Base URL: `https://api.mons.shop`. Use `Origin: https://vvv.so` or `https://www.vvv.so` (browsers set it). POST also requires `Content-Type: application/json` and `X-Mons-CSRF: 1`. Supply the collection's `chainId` and `contractAddress` on every request.

**Ready eggs**

`GET /ethereum/111k/hatching/ready?chainId=<chainId>&contractAddress=<contractAddress>`

Returns collection identity (`deploymentId`, `dropId`, `chainId`, `contractAddress`, `catalogRevision`) and `tokenIds`, an array of decimal strings. Hatched eggs leave this list.

**Hatch one egg**

Sign this exact text using `personal_sign` once, and reuse the signature for subsequent eggs:

```text
I authorize 111k egg hatching.
```

`POST /ethereum/111k/hatching/hatch`

```json
{
  "chainId": 1,
  "contractAddress": "0x08cded8258730bda384ff198001e47a1b50f7f9d",
  "tokenId": "123",
  "signature": "<0x-prefixed signature>"
}
```

The signer must currently own the token. Contract wallets may use ERC-1271 signatures. No wallet session, nonce, or expiry is required.

Returns collection identity and the [existing reveal artwork format](111k_reveal.md#response-fields-and-media): `artworks: [artwork]`, `unresolved: []`, `retryAfterMs: 0`. Render the returned artwork immediately; CDN metadata may update shortly afterward. Repeating a successful request returns the same artwork after checking current ownership.

Errors use `error.code` and `error.message`: `400` invalid input, `403` invalid owner authorization/origin/headers, `404` unknown collection, `409` egg unavailable, `429` rate limited, `503` temporarily unavailable. Retry `429` after `Retry-After`; retry `503` with backoff using the same signature and token ID.
