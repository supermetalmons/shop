# pre111k relic reservations

`Pre111K` is a separate, non-upgradeable reservation contract. It does not mint NFTs or change the existing `NFT111K` collection or its relic claim allowances. Each successful `reserveRelic(nonce, deadline, signature)` pays the amount quoted by the backend, permanently increments `reservedRelics(msg.sender)` by one and increments `totalReserved`. At most seventeen reservations can succeed across all wallets.

The backend signs EIP-712 domain `pre111k`, version `2`, with the deployment's chain ID and contract address. The message type is `ReserveRelic(address wallet,uint256 nonce,uint256 deadline,uint256 priceWei)`. The contract uses the transaction’s `msg.value` for `priceWei` when verifying the signature. Changing the value invalidates the signature. A quote may authorize any amount, including zero. The wallet must be the transaction sender, and the nonce must equal its current reservation count. The deadline must be strictly later than the block timestamp and no more than 600 seconds ahead. Signatures cannot be replayed for another wallet, contract, chain or reservation. Successful calls emit `RelicReserved(wallet, nonce, totalReserved)`; wallet and nonce are indexed.

The immutable `admin` alone can call `setQuoteSigner(address)`. Signer rotation invalidates outstanding authorizations signed by the previous key. Admin and treasury are fixed at deployment. There is no transfer of administration, ownership-renunciation endpoint, refund, general-purpose external call or alternate payout endpoint.

Anyone can call `withdraw()` to forward the entire contract ETH balance to immutable `treasury`. A low-level value call forwards gas to support the existing Safe proxy; transfer failure reverts and retains the funds for retry. Reservation and withdrawal share a reentrancy lock. Withdrawal does not change reservation counts. Empty withdrawals are harmless. Ordinary ETH transfers without reservation calldata revert; forcibly received ETH is included in the next withdrawal.

## Network configuration

| Setting | Ethereum mainnet | Sepolia |
| --- | --- | --- |
| Initial backend price | 2.3 ETH | 0.0023 ETH |
| Treasury | `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` | Same address |
| Admin | Treasury Safe | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |

The treasury is Safe 1.5.0 on mainnet. The same address has no deployed code on Sepolia; retaining that testnet destination is intentional. The initial backend signers are `0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea` on mainnet and `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca` on Sepolia.

## Checks

From this directory:

```sh
npm run test:pre111k
npm run test:pre111k-deployment
forge test --offline --match-contract '^Pre111KSafeForkTest$' --fork-url https://ethereum-rpc.publicnode.com --fork-block-number 26326516 --gas-snapshot-emit=false
```

The fork test pays a simulated 39.1 ETH sellout balance at the initial mainnet price to the actual mainnet Safe in a local fork and checks its `SafeReceived` event and balance increase. No mainnet transaction is broadcast. Ordinary offline runs explicitly skip that fork-only test. Other tests cover signature scopes and expiry, quote-bound payments, sequential nonces, the lifetime supply cap, signer rotation, failed payouts, gas-intensive receivers, reentrancy and reservation/payment conservation. `fixtures/pre111k.json` is a deterministic Solidity authorization and calldata vector for application tests.

## Deployment

The dedicated JavaScript deployment tool supports Ethereum mainnet and Sepolia and encodes only the admin, treasury and initial quote signer in the constructor. The deploying wallet is `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` on both networks; mainnet assigns administration directly to the treasury Safe. It uses the existing encrypted deployer keystore and a temporary password file. Provide either `ETHEREUM_PRE111K_RPC_URL` or `ALCHEMY_API_KEY`; the RPC must match the selected network. Credentials are never written to public reports.

Mainnet preparation requires an explicit authorization signer, separate from the Sepolia signer. Subsequent steps use the frozen signer in the manifest. The transaction fee ceiling is 0.001 ETH on mainnet and 0.005 ETH on Sepolia; preparation also requires enough deployer balance for the actual buffered fee. Omitting `--network` selects Sepolia.

```sh
forge build --offline
npm run pre111k:deploy -- prepare --network mainnet --directory .local/pre111k-mainnet-v2 --quote-signer 0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea
npm run pre111k:deploy -- sign --network mainnet --directory .local/pre111k-mainnet-v2 --keystore /path/to/encrypted-keystore --password-file /path/to/temporary-password
npm run pre111k:deploy -- broadcast --network mainnet --directory .local/pre111k-mainnet-v2
npm run pre111k:deploy -- verify --network mainnet --directory .local/pre111k-mainnet-v2
```

Run the same workflow for Sepolia:

```sh
forge build --offline
npm run pre111k:deploy -- prepare --directory .local/pre111k-sepolia-v2
npm run pre111k:deploy -- sign --directory .local/pre111k-sepolia-v2 --keystore /path/to/encrypted-keystore --password-file /path/to/temporary-password
npm run pre111k:deploy -- broadcast --directory .local/pre111k-sepolia-v2
npm run pre111k:deploy -- verify --directory .local/pre111k-sepolia-v2
```

Preparation freezes the compiler input, artifact, constructor arguments, predicted address, nonce and live RPC gas estimate. Local Prague gas simulations do not determine the deployment limit. Signing validates the encrypted wallet, pending nonce, chain, transaction body and fee ceiling, then durably journals the signed transaction before broadcasting. Broadcast resumes the same transaction; never prepare another release merely because a broadcast response was lost. Verification requires three confirmations, canonical receipt, matching creation input/runtime and the admin, treasury, signer, cap of 17, ten-minute authorization lifetime, zero starting reservations and zero starting balance. It writes a public `deployment.json` while the signed transaction remains only in `transactions.private.json` under the ignored local directory. Never publish the private journal.

Publish the frozen source to Sourcify and compare its published compiler input and bytecode to the release:

```sh
node scripts/pre111k-sourcify.mjs submit .local/pre111k-sepolia-v2
node scripts/pre111k-sourcify.mjs status .local/pre111k-sepolia-v2
node scripts/pre111k-sourcify.mjs verify .local/pre111k-sepolia-v2
```

For mainnet, use `.local/pre111k-mainnet-v2` instead. The verifier reads the chain from the frozen manifest and rejects a mismatched deployment report. The submission is asynchronous; run `verify` after the status reports completion. `Pre111K.sourcify-verification.json` records matching sources, creation/runtime bytecode and constructor arguments. Since the compiler omits its source metadata hash, Sourcify reports `match` rather than `exact_match`. `Pre111K.standard-input.json` and the constructor arguments also support explorer verification with the exact Solidity 0.8.38 compiler version. Connect the verified address to the backend only after these deployment checks pass. The release's reservation count starts at zero; acceptance tests use local chain or RPC simulation and must not consume public reservation slots.

`script/DeployPre111K.s.sol` also provides a Foundry deployment path. It selects the network’s admin and treasury and reads `ETHEREUM_PRE111K_DEPLOYER_KEY` and `ETHEREUM_PRE111K_QUOTE_SIGNER`. The JavaScript workflow above preserves the encrypted-keystore signing and resumable transaction journal used by the releases.

## Replacing v1

Use fresh v2 deployment directories. Deploy and verify Sepolia first, then simulate a signed reservation there. Stop issuing v1 quotes on both networks and wait for all outstanding quotes to expire onchain. Before broadcasting the mainnet deployment, check mainnet v1 `totalReserved()` and its ETH balance at a confirmed block after expiry. Proceed only if both are zero. Sepolia’s test reservations and test ETH stay at the v1 address.

Activate the verified addresses and deployment blocks together with the v2 API and storefront. Keep each network’s signer, access policy, treasury and initial backend price. Verify the public status and simulate a backend quote at the new address using `eth_call` on each network. Changing the transaction value must cause the simulation to revert. Confirm all seventeen slots are still available on each new contract.
