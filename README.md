# mons.shop

React + TypeScript storefront for physically redeemable NFT drops. Solana minting
uses the box-minter program and MPL Core assets. The `/111k_devnet` Ethereum test
collection has its own wallet session, ERC721A crates, artwork, and receipt claims.

## Architecture

- `mons-shop` serves static assets and proxies authenticated `/api/*` requests to
  `mons-shop-api` through a Cloudflare service binding.
- `mons-shop-api` owns inventory, authentication, delivery, claims, Stripe,
  ShipStation, notifications, admin routes, Workflows, and Queue consumers.
- `mons-shop-data` stores public pack-status summaries and events.
- `mons-shop-ops` stores profiles, encrypted saved addresses, session bindings,
  rate limits, and operational controls.
- `mons-shop-commerce` owns orders, assignments, claim codes, checkout state,
  notification outboxes, and delivery recovery journals.
- [`shared/`](shared/README.md) is the runtime-neutral domain core.
  `shared/deploymentRegistry.ts` is the canonical public drop registry;
  `src/config/deployment.ts` and the API's `dropConfig.ts` project it for each runtime.
- [`src/shop/`](src/shop/README.md) contains storefront orchestration.
  `scripts/ops/` contains operational utilities.

Server code shares the root dependency graph. Worker bindings, routes, queues,
schedules, and required secrets are declared in `cloud/workers/api/wrangler.jsonc`.

## Local development

Use Node.js 22.15 or newer and the npm version pinned in `package.json`.

```sh
npm install
npm run dev
```

Development proxies `/api/*` to `https://api.mons.shop`. Set `VITE_MONS_API_ORIGIN`
in the shell or an uncommitted `.env` to use another API. Production release
commands ignore local dotenv overrides. Server secrets must never use `VITE_*`.

For the Ethereum local chain and API, follow [111K setup](scripts/docs/111k_testnet.md).
The [contract project](onchain/ethereum/README.md) contains Solidity dependencies,
contract checks, and gas benchmarks.

## Validation

```sh
npm run check:frontend
npm run check:api
npm run typecheck:tools
npm run check:dead-code
npm run check
npm run check:all
```

`check` is the routine repository gate: generated schema and Worker types,
frontend and API typechecks, TypeScript unit/runtime tests, Rust host tests,
dead-code checks, production bundles, and Worker startup validation.
`dry-run:frontend` and `dry-run:api` validate deployment bundles without publishing.

`check:all` adds Solidity and gas checks, nested Ethereum TypeScript tests,
extended contract invariants, Ethereum E2E, Solana SBF, and native renderer tests.
It requires the pinned root and Ethereum npm dependencies, Cargo, Anchor/Solana
SBF tooling, Foundry (`forge` and `anvil`), and the
[native renderer's pinned macOS runtime](scripts/mi-note-video/README.md#prerequisites).
Ethereum E2E also requires CDN access or its configured local metadata directory.
Missing prerequisites fail the command. Fixture-writing and lockfile-sensitive
checks run in disposable copies of the current source. Public-RPC
[fork tests](onchain/ethereum/README.md#seaport-trading) remain opt-in.

After catalog or schema changes, run `npm run generate:db` and
`npm run check:db-generated`. Keep applied SQL and recorded schema checksums
immutable. Knip discovers supported commands from `package.json`; dynamic
configuration entry points are declared in `knip.ts`.

## Current product state

Mi Note mainnet minting and unpacking are live. Preorder checkout is closed on
mainnet and devnet; existing assets, submitted-order recovery, and permanent card
claims remain supported. The `/wip` routes remain available. See
[Mi Note inventory and recovery](scripts/docs/mi_note_preorders.md).

The active 111K Sepolia configuration and maintenance controls are documented in
[111K setup](scripts/docs/111k_testnet.md); the
[v8 monument release](releases/111k-sepolia-v8/README.md) records its deployment.
Metadata JSONs on public R2 at `cdn.mons.shop` are authoritative for both the shop
and local development, with permissive CORS and `no-store` caching. No local artwork
generator or metadata server is used; see [111K metadata](scripts/docs/111k_metadata.md).
Release evidence describes the recorded verification time, not live service state.

## Operations and reference

| Task | Canonical guide |
| --- | --- |
| Deploy Workers, configure secrets, inspect D1 | [Cloudflare deployment](scripts/docs/cloudflare_deployment.md) |
| Pause/drain, bootstrap, inspect or recover Commerce | [Commerce operations](scripts/docs/commerce_operations.md) |
| Sessions, staff access, address encryption | [Authentication and access](scripts/docs/app_auth.md) |
| Packing, notifications, chargebacks, admin recovery | [Fulfillment operations](scripts/docs/fulfillment_operations.md) |
| Receipt claims and retry recovery | [Receipt claim Workflow](scripts/docs/receipt_claim_workflow.md) |
| Solana deployments and metadata compatibility | [Solana deployment](scripts/docs/solana_deployment.md) |
| New drop configuration | [Typed drop templates](scripts/newDrops/README.md) |
| Mi Note inventory, deployment, pack layouts | [Inventory](scripts/docs/mi_note_public_inventory.md), [deployment](scripts/docs/mi_note_drop_deployment.md), [pack layouts](scripts/docs/mi_note_pack_setups.md) |
| Ethereum checkout | [111K checkout](scripts/docs/111k_checkout.md) |
| Ethereum metadata and CDN | [111K metadata](scripts/docs/111k_metadata.md) |
| Ethereum unpack reveals and VVV integration | [111K reveals](scripts/docs/111k_reveal.md) |
| Ethereum reveal registration and operations | [111K reveal operations](scripts/docs/111k_reveal_ops.md) |
| Metadata fields | [Drop metadata](scripts/docs/drop_metadata.md) |
| One-off Worker-signed transactions | [Worker transactions](scripts/docs/worker_transactions.md) |
| Card video rendering | [Native Mi Note renderer](scripts/mi-note-video/README.md) |
| Completed releases and retired operations | [Release index](releases/README.md) |

API deployment runs checks, applies migrations, verifies remote integrity, and
publishes the Worker. Use the [Commerce maintenance procedure](scripts/docs/commerce_operations.md#pause-and-resume-maintenance)
when a change requires paused consumers. Frontend publication follows the API.
Production rollout is a separate operation from local validation.
