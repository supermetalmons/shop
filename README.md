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
```

`check` is the full repository gate: generated schema and Worker types, frontend
and API typechecks, unit/runtime/on-chain tests, dead-code checks, production
bundles, and Worker startup validation. `dry-run:frontend` and `dry-run:api`
validate deployment bundles without publishing.

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
[Seaport release](releases/111k-sepolia-seaport/README.md) records its deployment.
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
| Metadata fields | [Drop metadata](scripts/docs/drop_metadata.md) |
| One-off Worker-signed transactions | [Worker transactions](scripts/docs/worker_transactions.md) |
| Card video rendering | [Native Mi Note renderer](scripts/mi-note-video/README.md) |
| Completed releases and retired operations | [Release index](releases/README.md) |

API deployment runs checks, applies migrations, verifies remote integrity, and
publishes the Worker. The frozen-metadata cleanup requires the previous checker
preflight, completed Commerce pause/drain, guarded deployment, and then resume;
follow the [cleanup rollout procedure](scripts/docs/commerce_operations.md#frozen-metadata-cleanup-rollout).
Frontend publication follows the API. Production rollout is a separate operation
from local validation.
