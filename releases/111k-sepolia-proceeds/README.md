# 111K Sepolia proceeds release

The proceeds-splitting collection is deployed on Ethereum Sepolia, chain `11155111`, at [`0x3fc9f53200d3f025dfd046490b744747749a7b54`](https://sepolia.etherscan.io/address/0x3fc9f53200d3f025dfd046490b744747749a7b54#code), block `11963848`. The sale is paused during application cutover, with zero supply and zero recorded proceeds at deployment verification.

The collection reuses renderer `0x08cded8258730bda384ff198001e47a1b50f7f9d`, owner `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`, and authorization signer `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`. Both [previous collections](../111k-sepolia-discounts/README.md) remain active onchain.

Mint recipients are the four configured placeholder addresses ending in repeated `1`, `2`, `3`, and `4` digits, at 50% / 25% / 15% / 10%. The separate shipping receiver is `0x5555555555555555555555555555555555555555`. The exact addresses are in [proceeds.json](../../onchain/ethereum/config/proceeds.json). These are testnet placeholders; mint recipients and shares are fixed for this deployment, while the owner can rotate the shipping receiver.

The deployment transaction is [`0xc390a1456b0fd3ab17255ab3d4a3b405d7d99247e1655ec7131b0d0549723aba`](https://sepolia.etherscan.io/tx/0xc390a1456b0fd3ab17255ab3d4a3b405d7d99247e1655ec7131b0d0549723aba). Deployment and sale-pause transactions reached three canonical confirmations. The frozen build uses Solidity `0.8.30`, Prague bytecode, the legacy pipeline, and 1,000 optimizer runs. Etherscan reports **Source Code Verified (Exact Match)**; [verification evidence](etherscan-verification.json) and its [screenshot](etherscan-exact-match.png) are included.

Final source attribution, application versions, reset acceptance, and activation evidence are recorded after the scoped cutover completes. Private transaction journals, credentials, and database backups remain outside Git.
