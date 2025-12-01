# Implementation Review - Potential Issues and Incompleteness

This document compares the implementation against `plan_clean.md` and identifies discrepancies, potential bugs, and missing functionality.

---

## 🔴 Critical Issues

### 1. Package Version Mismatch - mpl-bubblegum

- **Frontend** (`package.json`): `@metaplex-foundation/mpl-bubblegum: ^5.0.2`
- **Functions** (`functions/package.json`): `@metaplex-foundation/mpl-bubblegum: ^0.11.0`

This is a **major version difference** (v0.11 vs v5). The API between these versions is significantly different. The functions code uses v0.x API patterns which may not be compatible with newer on-chain state or could cause transaction building issues.

### 2. Package Version Mismatch - spl-account-compression

- **Frontend**: `@solana/spl-account-compression: ^0.4.1`
- **Functions**: `@solana/spl-account-compression: ^0.2.1`

Different versions could lead to incompatible transaction building.

### 3. IRL Claim Mints Wrong Asset Type

**Plan states:** "claim certificates for irl dudes tx. this will mint specific dudes ids cnfts"

**Implementation** (`functions/src/index.ts:652`):

```typescript
instructions.push(...(await buildMintInstructions(ownerPk, dudeIds.length, 'certificate', ...)));
```

## The claim function mints assets of type `'certificate'` instead of `'dude'` certificates. The plan explicitly says it should mint "dudes certificates" - which semantically should be certificates proving authenticity of specific dudes, but the naming/type is ambiguous.

## 🟠 Medium Issues

### 4. Missing Firestore Rule for `mintTxs` Collection

The `mintTxs` collection is used in `functions/src/index.ts` to track processed mint transactions, but it's **not covered** in `firestore.rules`:

```javascript
// Current rules don't include:
match /mintTxs/{signature} {
  allow read, write: if false; // should be backend-only
}
```

This could allow unauthorized read/write access to mint tracking data.

### 5. Certificate Index Collision Risk

In `prepareDeliveryTx`, certificates are numbered starting from `i + 1`:

```typescript
instructions.push(
  ...(await buildMintInstructions(ownerPk, 1, "certificate", i + 1, {
    boxId: id,
  }))
);
```

This means every delivery request starts certificate numbering from 1, potentially causing duplicate certificate names like "mons authenticity #1" across different users/deliveries.

### 6. No Special "3 Dudes Reveal" UI

**Plan states:** "when tx succeeds we show 3 dudes"

Current implementation in `handleOpenBox` just refetches inventory:

```typescript
setStatus(`Opened box · ${sig}`);
await refetchInventory();
```

There's no special reveal animation, modal, or UI highlighting the 3 newly minted dudes. Users see them appear in the grid but there's no celebratory reveal moment.

### 7. IRL Certificate Verification - Type Check May Be Insufficient

**Plan states:** "will also check if the blind box certificate is there on an address"

The implementation checks if the asset is of type `'certificate'`:

```typescript
const kind = getAssetKind(certificate);
if (kind !== 'certificate') { ... }
```

But this doesn't distinguish between:

- A blind box certificate (from delivery)
- A dude certificate (from delivery)
- Any other certificate

There's a `boxId` check but it relies on the `claim.boxId` matching `certificateBoxId`, which may not always be set.

### 9. No Claim Codes Creation Script/Documentation

The `claimCodes/{code}` documents are read by `prepareIrlClaimTx`:

```typescript
const claimDoc = await claimRef.get();
// expects: { boxId, dudeIds: number[], redeemedAt?, ... }
```

---

### 12. Missing COLLECTION_UPDATE_AUTHORITY in Scripts

The `derive-collection.ts` script outputs:

- `COLLECTION_MINT`
- `COLLECTION_METADATA`
- `COLLECTION_MASTER_EDITION`

But the functions also require `COLLECTION_UPDATE_AUTHORITY` which isn't output by any script. Operators need to know the update authority pubkey separately.

## ⚪ Questions / Clarifications Needed

### Q1: Certificate Types

The plan mentions multiple certificate concepts:

- "authenticity certificates cnfts" (from delivery)
- "dudes certificates" (from IRL claim)

Should these be:

- Same `'certificate'` type with different attributes?
- Different types entirely?
- Something else?

2 types of certificates: unopened blind box certificate, specific dude certificate — either claimed from a delivered blind box or specific dude requested for a delivery directly
