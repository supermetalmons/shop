# Pre111K mainnet v2

Each reservation consumes one of seventeen slots. The backend selects the ETH amount and signs it with the buyer’s address, wallet nonce and deadline. The contract verifies that signature against the ETH sent with the call.

| Deployment | Value |
| --- | --- |
| Contract | [`0xd1432dd5ec5dba6861bd4c6a56212f54abcbc0b9`](https://etherscan.io/address/0xd1432dd5ec5dba6861bd4c6a56212f54abcbc0b9) |
| Transaction | [`0xae829ff1a323a0cabb96ae4812567ba93a9f59c12190d6d44294ec49bc96ef74`](https://etherscan.io/tx/0xae829ff1a323a0cabb96ae4812567ba93a9f59c12190d6d44294ec49bc96ef74) |
| Block | 26,348,338 |
| Administrator and treasury | `0x72d0c5623a05033f9ee4495d408bc6c05df8367d` |
| Deployer | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Authorization signer | `0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea` |
| Deployment fee | 0.000108203985290159 ETH for 846,679 gas |

The deployment used the same compiled artifact and frozen compiler input as Sepolia v2. After three confirmations, the verifier checked the canonical receipt, creation input, 3,485-byte runtime, admin, treasury, signer, cap, ten-minute quote lifetime, zero reservation count and zero balance. [Preparation](preparation.json) · [Deployment](deployment.json)

Etherscan published an exact match. Sourcify verified both creation and runtime bytecode against the frozen sources. The compiler omits the metadata hash, which gives a Sourcify result of `match`. [Etherscan report](Pre111K.etherscan-verification.json) · [Sourcify report](Pre111K.sourcify-verification.json) · [Source manifest](source-manifest.json)

Simulated calls at the deployment block accepted quotes for 2.3 ETH, 1 ETH and zero ETH. Changing the payment by one wei invalidated each signature. All seventeen slots were available at the end of these checks. [Simulation](reservation-simulation.json) · [Validation](validation.json)

After v1 admission closed and outstanding quotes expired, mainnet v1 had zero reservations and zero balance at block 26,348,331. [Mainnet v1 deployment](../pre111k-mainnet-v1/deployment.json)

The [live storefront](https://mons.shop/111k/relics) showed `17 / 18 left` at activation and a reservation price of 2.3 ETH. A simulated call with an authorization issued by the live Worker succeeded at that price and reverted when the value increased by one wei. [Worker cutover](application-release.json) · [Live authorization](live-acceptance.json) · [Browser acceptance](browser-acceptance.json)
