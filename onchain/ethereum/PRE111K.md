# pre111k relic reservations

`Pre111K` is a separate, non-upgradeable reservation contract. It does not mint NFTs or change the existing `NFT111K` collection or its relic claim allowances. Each successful `reserveRelic(nonce, deadline, signature)` pays the immutable `price`, permanently increments `reservedRelics(msg.sender)` by one and increments `totalReserved`. At most eighteen reservations can succeed across all wallets.

The backend signs EIP-712 domain `pre111k`, version `1`, with the deployment's chain ID and contract address. The message type is `ReserveRelic(address wallet,uint256 nonce,uint256 deadline)`. The wallet must be the transaction sender, and the nonce must equal its current reservation count. The deadline must be strictly later than the block timestamp and no more than 600 seconds ahead. Signatures cannot be replayed for another wallet, contract, chain or reservation. Successful calls emit `RelicReserved(wallet, nonce, totalReserved)`; wallet and nonce are indexed.

The immutable `admin` alone can call `setQuoteSigner(address)`. Signer rotation invalidates outstanding authorizations signed by the previous key. Admin, treasury and price cannot change. There is no transfer of administration, ownership-renunciation endpoint, refund, general-purpose external call or alternate payout endpoint.

Anyone can call `withdraw()` to forward the entire contract ETH balance to immutable `treasury`. A low-level value call forwards gas to support the existing Safe proxy; transfer failure reverts and retains the funds for retry. Reservation and withdrawal share a reentrancy lock. Withdrawal does not change reservation counts. Empty withdrawals are harmless. Ordinary ETH transfers without reservation calldata revert; forcibly received ETH is included in the next withdrawal.

## Network configuration

| Setting | Ethereum mainnet | Sepolia |
| --- | --- | --- |
| Price | 2.3 ETH | 0.0023 ETH |
| Treasury | `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` | Same address |
| Admin | Treasury Safe | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |

The treasury is Safe 1.5.0 on mainnet. The same address has no deployed code on Sepolia; retaining that testnet destination is intentional. Sepolia's initial backend signer is `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca`.

## Checks

From this directory:

```sh
npm run test:pre111k
npm run test:pre111k-deployment
forge test --offline --match-contract '^Pre111KSafeForkTest$' --fork-url https://ethereum-rpc.publicnode.com --fork-block-number 26326516 --gas-snapshot-emit=false
```

The fork test pays the complete 41.4 ETH sellout balance to the actual mainnet Safe in a local fork and checks its `SafeReceived` event and balance increase. No mainnet transaction is broadcast. Ordinary offline runs explicitly skip that fork-only test. Other tests cover signature scopes and expiry, exact payments, sequential nonces, the lifetime supply cap, signer rotation, failed payouts, gas-intensive receivers, reentrancy and reservation/payment conservation. `fixtures/pre111k.json` is a deterministic Solidity authorization and calldata vector for application tests.

## Sepolia deployment

The dedicated JavaScript deployment tool only permits Sepolia and pins the configuration above. It uses the existing encrypted deployer keystore and a temporary password file. Provide either `ETHEREUM_PRE111K_RPC_URL` or `ALCHEMY_API_KEY` to select the Sepolia RPC. Credentials are never written to public reports.

```sh
forge build --offline
npm run pre111k:deploy -- prepare --directory .local/pre111k-sepolia-v1
npm run pre111k:deploy -- sign --directory .local/pre111k-sepolia-v1 --keystore /path/to/encrypted-keystore --password-file /path/to/temporary-password
npm run pre111k:deploy -- broadcast --directory .local/pre111k-sepolia-v1
npm run pre111k:deploy -- verify --directory .local/pre111k-sepolia-v1
```

Preparation freezes the compiler input, artifact, constructor arguments, predicted address, nonce and live RPC gas estimate. Local Prague gas simulations do not determine the deployment limit. Signing validates the encrypted wallet, pending nonce, chain, transaction body and fee ceiling, then durably journals the signed transaction before broadcasting. Broadcast resumes the same transaction; never prepare another release merely because a broadcast response was lost. Verification requires three confirmations, canonical receipt, matching creation input/runtime and all immutable configuration getters. It writes a public `deployment.json` while the signed transaction remains only in `transactions.private.json` under the ignored local directory. Never publish the private journal.

Publish the frozen source to Sourcify and compare its published compiler input and bytecode to the release:

```sh
node scripts/pre111k-sourcify.mjs submit .local/pre111k-sepolia-v1
node scripts/pre111k-sourcify.mjs status .local/pre111k-sepolia-v1
node scripts/pre111k-sourcify.mjs verify .local/pre111k-sepolia-v1
```

The submission is asynchronous; run `verify` after the status reports completion. `Pre111K.sourcify-verification.json` records matching sources, creation/runtime bytecode and constructor arguments. Since the compiler omits its source metadata hash, Sourcify reports `match` rather than `exact_match`. `Pre111K.standard-input.json` and the constructor arguments also support explorer verification with the exact Solidity 0.8.38 compiler version. Connect the verified address to the backend only after these deployment checks pass. The release's reservation count starts at zero; acceptance tests use local chain or RPC simulation and must not consume public reservation slots.

`script/DeployPre111K.s.sol` provides a separate Foundry deployment path for a future explicitly authorized mainnet release. It selects the exact network price and fixed admin/treasury and reads `ETHEREUM_PRE111K_DEPLOYER_KEY` and `ETHEREUM_PRE111K_QUOTE_SIGNER`. Mainnet deployment is not part of the Sepolia JavaScript tool.
