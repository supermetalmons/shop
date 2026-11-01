# 111K Sepolia v10 — registered delivery configurations

Release preparation is complete; deployment and activation evidence will be added after the guarded cutover.

The constructor creates configuration 1 with 100% to `0x5555555555555555555555555555555555555555`. The backend signs immutable configuration IDs; public `releaseDelivery()` takes no arguments and distributes pending redemption proceeds across registered configurations. Capacity is 32, with no additional configurations at launch.

[Validation](validation.json) records the contract, API, frontend, local lifecycle, gas, and compiler checks. The metadata baseline contains 344984 objects under `https://cdn.mons.shop/111k-sepolia/v10/`; [publication](metadata-publication.json) and [verification](metadata-verification.json) record its exact checksum. Historical metadata and reveal state remain preserved.
