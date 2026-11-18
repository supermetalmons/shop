# 111k mainnet mixed catalog v10

Mainnet activated v10 on November 17 at 21:33:16 UTC, with sales, reveals and owner hatches enabled. The batch made 424 minted eggs ready and exchanged 6,162 free egg slots for new paintings. The collection retained all 111,111 slots. The registry completed at revision 12 and catalog revision 2. [Rollout](rollout.json) · [Atomic cutover](cutover-proof.json) · [Final registry](registry-final.json)

All 424 token documents passed two public CDN checks across a five-minute scheduler interval. At the post-completion public check at 21:50 UTC, 418 of these eggs were ready and six had been hatched by their owners. Cleanup removed the superseded free-slot rows and temporary candidate lists. [Publication checks](publication-verification.json) · [Ledger verification](ledger-verification.json)

The 40,120 previously frozen artwork identities and their crate and transaction provenance matched the pre-release digest. All 116 public health samples taken from application deployment through the final check passed. Two earlier storefront requests had transient network failures during local validation. Operator reconnects resumed the original journal. [Frozen artwork proof](frozen-verification.json) · [Availability and scheduler observations](health-verification.json) · [Operation journal](mainnet-mixed-20261117.journal.json)

The [frozen definition](definition.json) binds the November 17 release to mainnet's v9 predecessor and the v10 catalog. Its SHA-256, computed on compact JSON, is `1b525589fe52023ae6914e2b6d9d70ca6ded0ce60f19fe4f72c859f649ad5f64`. The [original input](original-input.json) has SHA-256 `e8ae1557e2aa5b4c98b525c1b8211e6aa4122468b421dbcaab078f9f33f9bc60`.

| Collection | New artworks | Owner-ready rewards | Shared reveal pool |
| --- | ---: | ---: | ---: |
| GAN videos | 124 | 124 | 0 |
| DriFPS | 1,500 | 100 | 1,400 |
| ever since i was | 2,289 | 100 | 2,189 |
| Collage Paintings | 2,673 | 100 | 2,573 |
| **Total** | **6,586** | **424** | **6,162** |

The [normalized ordinary source](source.json) reproduces the [v10 manifest](manifest.json), including 37,990 alternate WebPs for existing paintings. The [owner supplement](owner-supplement.json) adds the GAN MP4s and preserves the DROWEE GIFs. [Collection blocks](collection-blocks.json) bind the new labels to v10 and preserve all v5–v9 bindings. The frozen predecessor supplements allow the preparation tool to reproduce this release after promotion.

Reproduce local artifact promotion from the repository root:

```sh
npm run ethereum:promote-mixed -- --source releases/111k-catalog-v10/original-input.json --write
npm run check:ethereum-assets
```

The mainnet operator follows the [mixed allocation runbook](../../scripts/docs/111k_reveal_ops.md). The token draw and reward assignments stay private in the deployment's reveal ledger.

The release retained its public media preflight, exact staged trait checksums, application versions and release gate results. Marketplace refresh calldata remains unsigned. [Preflight](preflight-summary.json) · [Staged traits](traits-audit.json) · [Deployments](deployments.json) · [Validation](release-validation.json) · [Unsigned refresh](metadata-refresh-unsigned.json)
