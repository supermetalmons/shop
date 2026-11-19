# Mainnet revealed twin metadata

On November 19, 2026, publication completed by 09:30:54 UTC for **94 NFTs in 47 revealed duplicate painting groups**. The lowest numeric ERC-721 token ID in each group received one `{"trait_type":"good twin","value":true}` attribute. Each other revealed copy received one `{"trait_type":"evil twin","value":true}` attribute.

| Collection block | Good twins | Evil twins |
|---|---:|---:|
| little swag | 32 | 32 |
| Drilady 2 | 14 | 14 |
| Paint Me Like Your Old Models | 1 | 1 |
| **Total** | **47** | **47** |

The group input comes from the [mainnet painting correction](../111k-mainnet-duplicate-correction-2026-11-19/README.md). The private cohort manifest binds the original CDN checksums and ETags. Roles are recorded in the reveal ledger and survive retries and later canonical reads. Publication retained the metadata prefix, assignment identities, collection blocks and registry revision.

Verification covered every affected R2 object, every public CDN and scoped metadata API result, and all 153 previously published singleton controls. Each target differed from its original bytes only by its appended boolean attribute. All singleton controls retained their original bytes. The checks were repeated after a successful scheduled Worker run. [Aggregate verification](verification.json) · [Operator runbook](../../scripts/docs/111k_reveal_ops.md#mainnet-twin-metadata)
