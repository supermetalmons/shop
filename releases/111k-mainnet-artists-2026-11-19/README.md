# 111k mainnet artist credits

The API Worker now writes one `artist` trait per credited name immediately after `collection block` when a mainnet artwork first publishes. The ordered [artist mapping](../../shared/ethereum/mainnet111kArtists.json) covers 32 collection blocks and 10 artists. Enrichment preserves the credits recorded at reveal.

The resumable live backfill published credits for 30,273 artworks. The final ledger and public CDN pass verified all 41,100 published token files, including 30,275 artworks and 10,825 eggs. The two additional artworks were holder hatches that received credits through the live reveal path. Both matched their canonical R2 bytes. Checks also confirmed preservation of each backfilled artwork's identity and other traits, the 94 boolean twin traits, and the original bytes of the 10,825 remaining eggs.

The rollout and backfill ran without a maintenance pause. Of 1,340 public availability checks, four returned HTTP 503 from config and stats in two rounds during verification. Both endpoints recovered on each following check. The storefront and ready-egg checks passed in every round, and all 24 observed scheduler runs succeeded. The full Commerce D1 audit passed after the backfill.

[Aggregate verification](verification.json) · [Operator runbook](../../scripts/docs/111k_reveal_ops.md#mainnet-artwork-artist-credits)
