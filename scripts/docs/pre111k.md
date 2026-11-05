# pre111k relic reservations

`/111k/relics` uses Ethereum mainnet and `/111k/relics_devnet` uses Sepolia. Each
successful `reserveRelic(uint256 nonce,uint256 deadline,bytes signature)` call
reserves one relic for its caller and holds the payment in `Pre111K`. The backend
sets the price per network, currently 2.22 ETH on mainnet and 0.0023 ETH on Sepolia.
Each deployment has a lifetime maximum of seventeen reservations. The storefront
initially shows `17 / 18 left` because there are eighteen physical relics.
Wallets may reserve multiple times, one call at a time. There is no NFT, transfer, cancellation, refund, or relic-ID selection in
this contract. Existing NFT111K relic claims remain independent.

## Authorization and counts

The API approves a wallet only when its request includes a valid secret code,
that network is enabled, and supply remains. It signs EIP-712
`ReserveRelic(address wallet,uint256 nonce,uint256 deadline,uint256 priceWei)`
using domain name `pre111k`, version `2`, the chain ID, and the deployed contract address. The wallet's `reservedRelics(address)` count is its next nonce.
An authorization must be unexpired and no more than ten minutes in the future.
The contract hashes the actual transaction value into the authorization, so the
call must pay the exact signed amount, including for a zero-wei quote. A price
change affects newly issued quotes. A previous quote remains usable at its original
amount until it expires or its nonce is consumed.

The API does not hold supply offchain. Concurrent quotes can race for the final
slot; only a successful onchain reservation consumes it. Duplicate quotes for
one wallet's current nonce cannot both succeed. Counts are read from the chain,
including reservations submitted outside the storefront, and refresh every three
seconds while an unlocked wallet is connected.

The storefront is busy only during preparation and the wallet request. A returned
hash or wallet error releases the button immediately; an increased verified count
also releases it if the wallet response is delayed. Each new reservation still
fetches and validates a fresh count and authorization. The Reserve button does not
wait for receipt confirmation, and the UI does not show a persistent success claim.

The transaction explorer link appears only for a transaction sent from the current
page. Its hash is checked every three seconds until the confirmation endpoint
reports it confirmed or failed, then the link disappears. Refreshing or leaving
the page clears the link; previously stored hashes are ignored.

The API routes are:

- `POST /ethereum/pre111k/access` with `{ "code": "..." }`; returns `{ "ok": true }` after verification.
- `GET /ethereum/pre111k/status?network=mainnet|devnet&wallet=0x...` (`wallet` is optional).
- `POST /ethereum/pre111k/prepare` with `{ "network": "devnet", "wallet": "0x...", "code": "..." }`.
- `POST /ethereum/pre111k/confirm` with network, wallet, and `transactionHash`.

Use the existing allowed storefront origin and `X-Mons-CSRF: 1` for POST requests.
Preparation is rate limited by IP and wallet and observes commerce maintenance.
Access verification is rate limited by IP and remains available during maintenance.
Both access and preparation trim and uppercase the supplied code before checking
the server allowlist. Missing or invalid codes return `401 unauthenticated`;
missing or invalid server configuration returns `503 unavailable`. No code is
returned in API responses or sent to the chain. Status and confirmation do not
require a code, so submitted reservations remain recoverable.
Confirmation uses the deployed contract and canonical receipt. It remains available
if sales are paused or the current reservation price is missing or malformed.
No wallet login signature is required: authorization is bound to `msg.sender`.
The backend chooses the contract and price; callers cannot override them.

## Withdrawal

Anyone may call `withdraw()` with zero ETH. It sends the entire balance only to
`0x72D0c5623A05033F9eE4495D408BC6c05DF8367d`. The caller cannot redirect funds.
The cap, treasury, and administrator are immutable. Withdrawal has a reentrancy
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
`ENABLED`, `PRICE_WEI`, and `SIGNER_SECRET`. Set `PRICE_WEI` in
`cloud/workers/api/wrangler.jsonc` and the matching `INITIAL_PRICE_WEI` in
`src/ethereum/DirectPaymentPage.tsx` to the same canonical unsigned decimal wei
string (`devnet` for Sepolia). Deploy both the Worker and storefront. The button
shows that price immediately and updates if status reports a different price.
The storefront requires a fresh click if the prepared price changes.
RPC reads reuse `ALCHEMY_MI_NOTE_API_KEY`.
Both network signer secrets are required for the deployed API. Each signer has
its own encrypted local keystore and a password stored in macOS Keychain; the
Worker receives only its corresponding signing key as a secret. To back up a
local signer, preserve its complete keystore and its encryption password.
Deployment records identify the public signer addresses. A disabled network
has no direct-transfer fallback.

`ETHEREUM_PRE111K_ACCESS_CODES` is a required Worker secret shared by both
networks. Its value is a JSON array of nonempty code strings; provision it through
Wrangler's secret input rather than frontend configuration or source files.
Deploy the API requirement before the storefront gate. Authorizations issued
before rollout can remain valid for up to ten minutes; no signer or contract
change is required. The storefront stores the approved code locally, restores
the reservation UI immediately on reload, revalidates in the background, and
includes it with every preparation request. The local
development API uses the fixture code `LOCALRELICS`; production codes must not be
used in test fixtures or committed assets.

The browser bundle validator reads its code scan values from the private
`ETHEREUM_PRE111K_ACCESS_CODES` environment variable. Local release checks also
load the gitignored `cloud/workers/frontend/.env.bundle-scan` file. Keep that
private configuration in sync with the Worker secret when changing codes;
validation errors report only a generic category, never a code value.

Use the dedicated pre111k deployment workflow; do not replace NFT111K, reset its
commerce state, allocate relic claims, or modify its metadata. Validate the
expected chain, constructor values, signer, cap, and deployment bytecode before
activating an address. Estimate gas against the target chain. Preserve the
deployment transaction, block, source verification, and validation evidence in
the release record. Public acceptance must leave all seventeen initial slots
available; purchase and withdrawal transactions run locally, and public-network
reservation acceptance uses simulation.
