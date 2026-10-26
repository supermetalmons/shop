# Authentication and access

The frontend creates fresh anonymous identities through `mons-shop-api`. The
opaque credential stays in an HttpOnly, host-only cookie; local storage contains
only non-secret subject and expiry metadata. Authenticated browser requests use
the frontend Worker's same-origin `/api/*` gateway and a fixed CSRF header.

Identity and wallet authorization are D1-only. The permanent provider-retirement
record remains in Ops D1; bearer tokens from that provider are rejected.
[The retirement record](../../releases/legacy-auth-retirement/README.md) preserves
the historical project-deletion details.

Commerce documents, profiles, saved addresses, wallet sessions, and operational
controls are D1-only.

## Wallet sessions

The mapping from each anonymous auth subject to its signed Solana wallet is
D1-only in `mons-shop-ops` and keyed by `auth_subject`. Different-wallet
rebinding is temporarily blocked while profile reconciliation holds its
bounded D1 lease, while same-wallet renewal remains available.

Allowlisted fulfillment and admin wallets use a separate wallet-only staff
session and do not depend on anonymous authentication. The API issues a
five-minute, one-time Solana signing challenge, stores only the resulting
opaque session secret hash in `mons-shop-ops`, and requires that staff session
for every `/admin/*` and `/fulfillment/*` request. The browser restores the
session under `monsStaffWalletSession:v1` and refreshes its 30-day inactivity
window once per day. Removing a wallet from the committed staff access
inventory invalidates its sessions immediately. Unsupported browser session
records are discarded; a fresh staff challenge restores access when no current
session exists. Active challenges are reused, while Cloudflare Worker bindings
rate-limit challenge and signature requests without storing caller counters in D1.

## Staff grants

[shared/fulfillmentAccess.ts](../../shared/fulfillmentAccess.ts) is the canonical
wallet and permission inventory shared by the frontend and API. Mainnet shipper
grants automatically include registered `mainnet-beta` drops. Address access,
address editing, customer profile access, admin IRL redemption, and Ethereum test
fulfillment remain separate grants; treasury membership alone does not grant them.

Address editing changes the delivery order snapshot, retains ShipStation state
restrictions, and leaves the customer's address book unchanged. Mainnet-only
staff do not see devnet inventory or test routes. Update the shared inventory
when changing staff access, then publish the API and frontend together.

## Address encryption

Generate a TweetNaCl-compatible Curve25519 keypair and place only the base64
public key in `src/config/addressEncryption.ts` as
`ADDRESS_ENCRYPTION_PUBLIC_KEY`:

```bash
node -e "const nacl=require('tweetnacl');const kp=nacl.box.keyPair();console.log('pub',Buffer.from(kp.publicKey).toString('base64'));console.log('secret',Buffer.from(kp.secretKey).toString('base64'));"
```

Keep the private key only in the API Worker's
`ADDRESS_DECRYPTION_SECRET`. Never ship it to the frontend or any public
configuration.
