# 111K Sepolia release

The first public testnet deployment was created on October 18, 2026 from
`972d74785b28e7e3e9d1c329439c94dfe0ea766a`. It uses test ETH and creates test
fulfillment orders; physical shipping, ShipStation and customer emails remain
disabled for this collection.

## Contracts

| Contract | Address | Deployment block | Gas used |
| --- | --- | --- | --- |
| 111K | [`0x6acc38d2ab61a06882be5d964a69efefe23058b3`](https://sepolia.etherscan.io/address/0x6acc38d2ab61a06882be5d964a69efefe23058b3) | 11,943,221 | 27,828,140 |
| Renderer | [`0x08cded8258730bda384ff198001e47a1b50f7f9d`](https://sepolia.etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d) | 11,943,218 | 18,396,617 |

The [deployment record](deployment.json) contains transaction hashes, runtime
hashes, compiler settings, and the failed initial deployment attempt. Both
successful transactions reached three confirmations before verification.

- Chain: Ethereum Sepolia, `11155111`.
- Owner and treasury: `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`.
- Authorization signer: `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`.
- Solidity `0.8.30`, Prague bytecode, legacy pipeline, 1,000 optimizer runs.
- Initial crate and warehouse prices: `0.0001` and `0.0011` test ETH.
- Delivery fee: `0.0001` test ETH; fulfillment requires three confirmations.

The owner and signer use separate encrypted keystores with passwords held in
macOS Keychain. Only the authorization key is provisioned to the API Worker as
`ETHEREUM_111K_SIGNER_SECRET`; no private keys are included in this release.

## Gas estimation and recovery

Sepolia activated [Glamsterdam](https://blog.ethereum.org/en/2026/09/17/glamsterdam-testnet-announcement)
on October 6, 2026. Its increased state-creation costs make the repository's
Prague gas benchmarks unsuitable as Sepolia deployment limits.

The first renderer attempt exhausted its 3,352,776 gas limit and created no
contract. Recovery verified the failed receipt and empty code, preserved the
broadcast journal, and used the next nonce. The live node estimated 18,543,789
gas for the renderer and 28,050,166 for the collection. Each exact creation
payload passed `eth_call` before signing with 20% headroom plus 50,000 gas.
Compiler settings and bytecode were preserved; the collection constructor used
the successfully deployed renderer address.

Future Sepolia deployments must estimate each creation against an upgraded live
RPC, simulate that exact payload with the resulting gas limit, and use the
confirmed renderer address in the collection constructor. Do not use a local
Prague Forge simulation's gas estimate for broadcasting. Preserve signed
transaction journals and resolve their receipts before retrying an uncertain
broadcast.

## Verification

The deployed runtime matches the compiled artifacts, accounting for the
collection's constructor immutables. Owner, treasury, signer, renderer, initial
supply, prices, sale status, redemption pause and all five SVG metadata types
were checked onchain.

Before deployment, the merged revision passed `npm run check`, the Ethereum
contract/frontend suite, the Anvil lifecycle suite, the native renderer suite,
and 512 extended invariant sequences with 65,536 calls and zero reverts.

Application rollout uses OPS migration `0008` and Commerce migrations
`0037`–`0040`, followed by the API Worker and frontend through the normal
release commands. Database recovery follows the repository's fix-forward
policy; deployed contracts are non-upgradeable.
