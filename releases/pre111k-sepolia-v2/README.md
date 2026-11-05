# Pre111K Sepolia v2

The Sepolia reservation contract accepts at most seventeen reservations. Each successful call pays the exact amount authorized by the backend’s EIP-712 signature. The signed message includes the caller, wallet nonce, deadline and price in wei.

| Deployment | Value |
| --- | --- |
| Contract | [`0x9e4d1fa72f669e273ef6244295b398b7594430ad`](https://sepolia.etherscan.io/address/0x9e4d1fa72f669e273ef6244295b398b7594430ad) |
| Transaction | [`0x9ae84a9b0108601b9b1b0866be6b6e00922b8077b6f53d097e3d3ecd5cb4a762`](https://sepolia.etherscan.io/tx/0x9ae84a9b0108601b9b1b0866be6b6e00922b8077b6f53d097e3d3ecd5cb4a762) |
| Block | 12,069,118 |
| Administrator and deployer | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Treasury | `0x72d0c5623a05033f9ee4495d408bc6c05df8367d` |
| Authorization signer | `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca` |
| Deployment fee | 0.000000005725003 Sepolia ETH |

The deployment verifier checked the canonical receipt, creation input, runtime, roles, cap, maximum quote lifetime and initial state after three confirmations. The verified runtime is 3,485 bytes. [Deployment record](deployment.json)

The published source, constructor arguments and bytecode matched the frozen release. Etherscan verified an exact match. Sourcify reports a match with the compiler’s metadata hash disabled. [Etherscan report](Pre111K.etherscan-verification.json) · [Sourcify report](Pre111K.sourcify-verification.json) · [Source manifest](source-manifest.json)

A simulation with the configured signer succeeded at 0.0023 ETH, 0.001 ETH and zero ETH. Substituting a value one wei away reverted in every case. All seventeen slots were available and the contract balance was zero after the checks. [Simulation report](reservation-simulation.json) · [Validation](validation.json)

The v1 contract had eight test reservations and 0.0184 Sepolia ETH at block 12,069,078. Those reservations and funds remain at the v1 address. [Sepolia v1 deployment](../pre111k-sepolia-v1/deployment.json)

The [live storefront](https://mons.shop/111k/relics_devnet) showed `17 / 18 left` at activation and a reservation price of 0.0023 ETH. A simulated call with an authorization issued by the live Worker succeeded at that price and reverted when the value increased by one wei. [Worker cutover](application-release.json) · [Live authorization](live-acceptance.json) · [Browser acceptance](browser-acceptance.json)

## Receipt confirmation update

The shared API Worker version `cca61863-3d29-4ea0-9468-a997a67dd2b1` reads receipts even if the current sale price is missing or invalid. After rollout, the live API confirmed reservation nonce 0 with 53 confirmations. [Sepolia transaction](https://sepolia.etherscan.io/tx/0xa8e4797cc83a2eb583ea4f6f009d0a30563cf54a5e9fde6e31807227c9998039)
