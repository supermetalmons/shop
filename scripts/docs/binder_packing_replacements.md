# Binder packing replacements, 2026-10-20

The fixed operation `card-nft-binder-packing-2026-10-20` issues binder receipts 21 and 22 into the existing mainnet receipt collection and tree. It keeps the normal minter at 15/15 and sales closed. Existing receipts, codes, and orders are never changed.

Prerequisites are published `rb21.json` and `rb22.json` metadata, deployed frontend and API recognition of `receiptMaxId: 22`, and deployed `admin_receipt_issuance` source support. Replacement orders appear in the normal packing list with the label “Packing replacements.” They have no customer shipment, shipping-label actions, or customer notifications.

Run the read-only chain/database preflight and transaction simulation:

```sh
npm run issue:binder-packing
```

This creates a private local journal with the two reserved codes and delivery ID. After prerequisites are deployed, the interactive command prompts for the receipt pool authority key without writing it to disk:

```sh
npm run issue:binder-packing -- --execute
```

Alternatively, `--signer-url http://127.0.0.1:8797` uses a private remote Worker preview whose fixed-purpose signer constructs only this exact two-receipt transaction. Supply the preview authorization token through `BINDER_ISSUANCE_AUTH_TOKEN`; the worker’s existing signing secret stays inside Cloudflare. The CLI verifies the complete message and authority signature before saving the signed transaction and submitting it.

The journal and `packing-codes.json` are stored under `~/Library/Application Support/mons-shop/binder-receipt-issuance/card-nft-binder-packing-2026-10-20/`. They contain claim credentials and must not be committed. Preserve the journal for retries. A saved transaction is always reconciled before publication; uncertain expired transactions are never replaced automatically. Once finalized and indexed, one atomic D1 import adds the packing order, both linked claims, and required recovery state. Repeating the command verifies the existing publication and recreates the packing export without minting or resetting codes.

Validation covers fixed mint instructions and signature rejection, real claim-store admission, packing exports, atomic rollback, concurrent database writes, lost publication acknowledgment, and preservation of existing codes.
