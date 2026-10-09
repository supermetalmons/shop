# Mainnet Mi Note preorder conversion

All 176 claimed preorder NFTs were converted in 44 finalized metadata-only
transactions. Completion was recorded at slot `454997436` in the unchanged
[execution verification](verification.json). The [completion record](completion.json)
independently confirms every finalized signature, all 44 preservation checks,
and the permanent exclusion of every preorder ID from the public card pool.

The [manifest](manifest.json) binds the exact original card IDs and NFT addresses.
Each update preserved the owner at execution, collection membership, authorities,
and plugins. The hosted JSON was not changed.

| Field | Original | Target |
| --- | --- | --- |
| On-chain name | `Preorder #N` | `card N` |
| Metadata URI | `https://cdn.lil.org/nft/mi_note_cards/preorder/json/N.json` | `https://cdn.lil.org/nft/mi_note_cards/json/fN.json` |

The card ID remains the permanent claim's original `clean_card_id`. Hosted JSON
keeps its `Card #N` display name, square JPEG, and additional clean PNG.

At the post-launch check, 174 converted cards remained live. Cards 698 and 1092
had subsequently been redeemed and were exact Core-owned burn tombstones. These
later burns do not undo the completed conversion or return either ID to the
public pool. The live pack inventory was conserved at 1,234 available plus 20
assigned cards in its original generation.

## Execution history

The [journal](journal.json) retains 45 signed attempts: 44 finalized and one
expired without landing. Seven batches converted the first 28 cards before the
expired attempt. The remaining 148 cards then completed through the same manifest
and journal, with no replacement of uncertain transactions.

The [unsigned preview](preview.json) simulated all 44 batches. It estimated
220,000 lamports in transaction fees and 11,623,040 lamports of released account
rent. These are preview estimates, not independently audited final balance totals.
The [resume preflight](resume-preflight.json) and
[automatic recovery check](automatic-recovery.json) preserve the intermediate
28-converted / 148-remaining checkpoint. Their counts are historical.

The [compatibility record](compatibility.json) preserves the application versions
and original-preorder inventory checks from before conversion. The subsequent
[mainnet launch](../README.md) enabled public minting and published customs defaults;
its [verification](../launch-verification.json) records the current deployments.

No further migration command is required. Keep the manifest, signed journal, and
execution verification intact. The upgrade command intentionally requires sales
to remain closed, and its strict asset checks reject later burns; do not rerun it
against the now-live drop to recreate or replace redeemed NFTs.

See the [upgrade runbook](../../../scripts/docs/mi_note_preorder_upgrade.md)
for the generic preparation, signing, and recovery workflow.
