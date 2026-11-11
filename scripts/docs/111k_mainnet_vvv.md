# 111k mainnet — VVV integration

API: `https://api.mons.shop`. Mainnet: `chainId: 1`, `contractAddress: "0x08cded8258730bda384ff198001e47a1b50f7f9d"`, deployment `mainnet-v1`.

- Put `chainId` and `contractAddress` in every public GET query and confirm/reveal POST body. Unscoped VVV requests are rejected.
- Allowed origins: `https://vvv.so`, `https://www.vvv.so`. Browsers supply `Origin`; backend callers must set it.
- POSTs require `Content-Type: application/json` and `X-Mons-CSRF: 1`. No API key, session, or wallet signature is required; GETs need no CSRF header.
- Before mint opens, scoped config should report `enabled: true`, `revealEnabled: true`, `saleActive: false`. API readiness does not mean minting is open. Read live prices/allowances from stats.
- Use the [mainnet proof file](../../src/ethereum/discounts/111k-mainnet.json), matching its chain, contract, and `root` against live `stats.discountMerkleRoot`; never reuse Sepolia proofs.
- Confirmation reports a canonical receipt, not proof that the intended mint/unpack occurred. Inspect the returned collection logs/items; confirmation does not trigger reveal.
- After crate unpacking, call `/ethereum/111k/reveal/transaction`; render available artwork and poll using `retryAfterMs`. Recover with `/ethereum/111k/reveal/tokens`. Honor `429` `Retry-After` seconds; back off on network/`5xx` errors.
- Verify response identity; scope caches by chain, contract, deployment, and token. Preserve catalog/token revisions. See the [full reference](111k_public_api.md), [reveal guide](111k_reveal.md), and [relic guide](111k_relic_claims.md). Mainnet checkout/redemption/authentication are excluded.
