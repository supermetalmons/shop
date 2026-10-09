# New drop configuration

This directory holds configurations for new deployments. Existing deployments are recorded in `shared/deploymentRegistry.ts`; their original creation recipes are available in Git history.

Choose an input template from `scripts/templates/newDrops`:

| Template | Sales and receipt configuration |
| --- | --- |
| `dedicatedPack.ts` | Multi-item packs, a dedicated collection/tree, and split mint proceeds |
| `directVariants.ts` | Direct-delivery items with three size ranges, a dedicated collection/tree, and one treasury |
| `pooledReceiptOnly.ts` | Stripe-only sales using an existing receipt pool |

The templates export raw `NEW_DROP_INPUT` data and perform no normalization or deployment when imported. The CLI only discovers `scripts/newDrops/<dropId>.ts`; templates are not selectable deployment configurations.

1. Copy the chosen template here as `<dropId>.ts`, using a new lowercase drop ID.
2. Replace the type import with `import { defineNewDropConfig, type NewDropConfigInput } from '../shared/newDropConfig.ts';` and append `export const NEW_DROP = defineNewDropConfig(NEW_DROP_INPUT);`.
3. Replace every `REPLACE_*` value and example URL. Set `onchain.dropId` to the filename without `.ts`, choose the drop family, and publish its metadata. Review prices, supply, labels, royalties, payment recipients, and receipt capacity.
4. Keep `shared.isMainnet: false` for the devnet rehearsal. Templates create a fresh program by default. To reuse a compatible compact-format program, set `reuseProgramId: true` and explicitly set `reuseProgramIdFromDropId` to its canonical deployment entry on the same cluster.
5. Run `npm run typecheck:tools` before the documented deployment workflow.

Templates start without discounts: keep `discountPriceSol` equal to `priceSol` and omit `discountWhitelistCsvRelativePath`. Both deployment commands automatically generate the nonzero SystemProgram stub root required by the deployed initializer. An existing empty CSV or an explicit SystemProgram-only CSV produces the same stub. No placeholder file needs to be created.

To offer a lower price, set `discountWhitelistCsvRelativePath` to an existing CSV containing the eligible wallet addresses, one per line. A lower price with no real whitelist is rejected before deployment. An explicitly named missing file always fails, so a typo cannot silently disable discounts. Real whitelists retain their existing Merkle proofs and family/root restrictions; only the fixed no-discount stub root may be shared by different families.

For size variants, use exactly three contiguous ID ranges covering `1..maxSupply` and retain `itemsPerBox: 0`. For split proceeds, use distinct valid recipient addresses with positive percentages totaling 100 and a valid delivery receiver.

For pooled receipts, choose a pool from `scripts/shared/receiptPoolConfig.ts` with a deployment on the target cluster. Keep `salesMode: 'stripe_receipt_only'`, Stripe enabled, `itemsPerBox: 0`, `maxPerTx: 1`, and both SOL sentinel prices at `1_000_000`. Set the Stripe amount and tax code for the new product. Symbol, royalties, collection, and tree come from the pool; do not add dedicated collection/tree fields.

After deployment, the canonical registry remains the source for runtime configuration and existing-drop operations. Retire the creation recipe from this directory when its deployment work is complete.
