# Shop features

`App.tsx` composes the shop and coordinates modal priority and shared wallet/owner resets.

- `account`: sign-in, profile viewing, and shipment recovery/readiness.
- `purchase`: mint queries, discounts, and Solana/Stripe purchase actions.
- `inventory`: server queries, optimistic records, persistence, metadata, and selection.
- `reveal`: frozen snapshots, request/session guards, assets, animations, and viewers.
- `commerce`: delivery/claim coordination and receipt transfer/redemption.
- `ui`: page sections, modal shells, header actions, and feedback.

Compose purchase queries before Stripe recovery, then resolve the account owner before subscribing to inventory. Keep each query and the metadata loader single-instance.

Inventory source state precedes reveal; inventory presentation consumes reveal's frozen views afterward. Viewer commands take explicit items. Mint actions capture the displayed inventory snapshot, while receipt ownership checks and claim recovery use raw inventory.

Delivery and numeric claims share the prepared-transaction ledger. Receipt transfers and admin redemption share a separate receipt-operation ledger. Preserve wallet generations, persistence keys, and pending-submission recovery when changing those boundaries.
