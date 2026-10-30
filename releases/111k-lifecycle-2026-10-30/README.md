# 111K lifecycle fixes — October 30, 2026

This API release preserves accepted transaction capacity during token discovery, disables empty receipt wakeups, closes obsolete token receipt interests, and enforces discovery retry cooldowns. Pending token-only results wait for matching confirmed receipt IDs before creating crate work. Existing transaction and crate admissions remain valid.

- Source commit: `962e326577b8438cf81c64f89a5fc81146b5e29e`.
- API version: `f47aaa80-e867-4f67-817d-3d36573447e0`, serving 100% of traffic at `api.mons.shop`.
- Registry: `sepolia-8b4044db`, active, revision 3, with no reported error.

The release workflow passed 2,819 API tests, 42 native runtime tests, generated-schema/type/bundle/startup checks, and remote database integrity checks. No remote D1 migrations were pending. A native regression verified bounded repair of 129 watches while preserving frozen data with no repair RPC calls.

The deployed Worker reported the lifecycle repair ready: 240 frozen artworks were published, 12 crate jobs were observed, and no recovery work was due in the captured health snapshot. Live transaction and token requests agreed on the 20 already-revealed artworks numbered 241–260. Repeated reads and token 260's metadata checksum were unchanged. Mixed frozen/unminted results, non-unpack responses, VVV CORS/preflight, and denied origins passed. Token 1 remained a placeholder.

[release.json](release.json) records the verified deployment and live results. [local-load-test.json](local-load-test.json) contains the local 200-request/4,000-artwork measurements. No frontend or contract deployment, or historical reveal backfill, was performed. The accepted rare recovery-delay limitation from the preceding release remains unchanged.
