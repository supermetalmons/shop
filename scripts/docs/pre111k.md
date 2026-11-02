# pre111k relic reservations

`/111k/relics` uses Ethereum mainnet and `/111k/relics_devnet` uses Sepolia. Each
successful `reserveRelic(uint256 nonce,uint256 deadline,bytes signature)` call
reserves one relic for its caller and holds the payment in `Pre111K`. The exact
price is 2.3 ETH on mainnet or 0.0023 ETH on Sepolia. Each deployment has a lifetime
maximum of eighteen reservations. Wallets may reserve multiple times, one call at
a time. There is no NFT, transfer, cancellation, refund, or relic-ID selection in
this contract. Existing NFT111K relic claims remain independent.

## Authorization and counts

The API automatically approves any wallet while that network is enabled and
supply remains. It signs EIP-712 `ReserveRelic(address wallet,uint256 nonce,uint256
deadline)` using domain name `pre111k`, version `1`, the chain ID, and the deployed
contract address. The wallet's `reservedRelics(address)` count is its next nonce.
An authorization must be unexpired and no more than ten minutes in the future.
The contract verifies the caller, nonce, signer, price, and remaining supply.

The API does not hold supply offchain. Concurrent quotes can race for the final
slot; only a successful onchain reservation consumes it. Duplicate quotes for
one wallet's current nonce cannot both succeed. Counts are read from the chain,
including reservations submitted outside the storefront. The storefront retains
a submitted hash and resumes confirmation after reload.

The API routes are:

- `GET /ethereum/pre111k/status?network=mainnet|devnet&wallet=0x...` (`wallet` is optional).
- `POST /ethereum/pre111k/prepare` with `{ "network": "devnet", "wallet": "0x..." }`.
- `POST /ethereum/pre111k/confirm` with network, wallet, and `transactionHash`.

Use the existing allowed storefront origin and `X-Mons-CSRF: 1` for POST requests.
Preparation is rate limited by IP and wallet and observes commerce maintenance.
No wallet login signature is required: authorization is bound to `msg.sender`.
The backend chooses the contract and price; callers cannot override them.

## Withdrawal

Anyone may call `withdraw()` with zero ETH. It sends the entire balance only to
`0x72D0c5623A05033F9eE4495D408BC6c05DF8367d`. The caller cannot redirect funds.
Price, cap, treasury, and administrator are immutable. Withdrawal has a reentrancy
guard and forwards gas to the receiver; failure reverts and retains the balance
for a retry. No fixed 2,300-gas transfer is used. An empty withdrawal is a no-op.

The mainnet recipient is an existing Safe. The same address is deliberately used
on Sepolia, where no Safe was deployed when this flow was introduced. Test ETH
sent there may not be recoverable. The mainnet-fork regression exercises the
actual Safe and checks the full balance transfer.

```sh
cast call "$PRE111K_ADDRESS" 'treasury()(address)' --rpc-url "$PRE111K_RPC_URL"
cast balance "$PRE111K_ADDRESS" --rpc-url "$PRE111K_RPC_URL"
cast send "$PRE111K_ADDRESS" 'withdraw()' --account YOUR_WITHDRAWAL_CALLER --rpc-url "$PRE111K_RPC_URL"
```

## Signer rotation and admission

The immutable administrator may call `setQuoteSigner(address)` with a nonzero
new signer. Sepolia uses the existing deployment wallet as administrator;
mainnet deployment uses the treasury Safe. The administrator has no alternate
funds-transfer capability.

1. Disable the affected network's `ETHEREUM_PRE111K_*_ENABLED` variable and deploy
   the API configuration.
2. Provision the replacement signing key securely. From the administrator, call
   `setQuoteSigner(address)` and wait for confirmation.
3. Update the corresponding Worker signer secret using Wrangler's prompt or
   standard input. Never pass its value as a command argument or commit it.
4. Verify the onchain signer matches the backend key and check preparation with
   a non-broadcast simulation. Re-enable admission and deploy the API.

Disabling admission stops new quotes. Existing quotes can remain valid for up to
ten minutes; replacing the onchain signer invalidates quotes from the old signer.
Withdrawal remains permissionless regardless of backend availability.

## Deployment configuration

The API has independent `ETHEREUM_PRE111K_MAINNET_*` and
`ETHEREUM_PRE111K_SEPOLIA_*` settings: `CONTRACT_ADDRESS`, `DEPLOYMENT_BLOCK`,
`ENABLED`, and `SIGNER_SECRET`. RPC reads reuse `ALCHEMY_MI_NOTE_API_KEY`.
Only the Sepolia signer secret is required while mainnet is undeployed.
Mainnet status remains disabled, with no direct-transfer fallback.

Use the dedicated pre111k deployment workflow; do not replace NFT111K, reset its
commerce state, allocate relic claims, or modify its metadata. Validate the
expected chain, constructor values, price, signer, and deployment bytecode before
activating an address. Estimate gas against the target chain. Preserve the
deployment transaction, block, source verification, and validation evidence in
the release record. Public acceptance must leave all eighteen initial slots
available; purchase and withdrawal transactions run locally, and Sepolia
reservation acceptance uses simulation.
