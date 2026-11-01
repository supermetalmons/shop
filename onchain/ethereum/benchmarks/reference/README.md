# Frozen gas-study references

These contracts are historical benchmark inputs, excluded from the canonical contract build and application runtime.

- `signed-address.sol`: signed-address implementation before registered configurations; SHA-256 `584193b2e5ba87983b35c694c2bd8cc51c972b9ae553e454d217a916e871d436`.
- `registered-prototype.sol`: the original unseeded registered-config experiment at 500 optimizer runs; SHA-256 `c423cc59f57b700516f8f302e8f546949dacf44605e76babf17d547e913d1b43`.

The original global-receiver source remains pinned to Git commit `d37e03bc17db5fb6b08463f6a61c84c6a7335c2c`. Historical reports are not rewritten to describe later sources. Run `npm --prefix onchain/ethereum run gas:delivery:history` for the original three-way comparison; `gas:delivery` measures the canonical constructor-seeded registered contract.
