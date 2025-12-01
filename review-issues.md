# Implementation Review: Issues & Potential Incompleteness

## 🔴 Critical Issues

### 1. Claim Code Marked Redeemed Before Transaction Confirmation

**Location:** `functions/src/index.ts` lines 778-792

The claim code is marked as `redeemedAt` inside `prepareIrlClaimTx` BEFORE the user actually signs and sends the transaction. If the user:
- Cancels the wallet prompt
- The transaction fails
- Network issues occur

The code is already marked as used and cannot be redeemed again.

**Suggested Fix:** ideally remember tx data in a way that repeated trying to redeem same certificate would simply fail with no need to rely heavily on user reporting claim tx status, just making it try minting same cnft is possible that would fail if it's minted already. if this is not possible to implement like this, come up with a different solution that would reliably allow minting certs while fully protecting from double mints.

---

### 2. No Asset Ownership Pre-Validation

**Location:** `prepareOpenBoxTx` and `prepareDeliveryTx`

The functions fetch asset info but don't explicitly verify `asset.ownership.owner === owner` before building burn instructions. While the burn would fail on-chain, this leads to:
- Wasted transaction fees
- Poor error messages
- Potential dude pool exhaustion if assignment happens before ownership check

**In `prepareOpenBoxTx`:** Dudes get assigned via `assignDudes(boxAssetId)` BEFORE any ownership validation.

---

### 3. Certificate Metadata for Multiple Dudes

**Location:** `functions/src/index.ts` `buildMetadata` function

When delivering a box, `buildMintInstructions` is called with `dudeIds: [all 3 dudes]`, but `buildMetadata` only uses `extra?.dudeId` (singular) for naming:
- Line 111: `const dudeId = extra?.dudeId ?? index;`

This means if a certificate is for a box with 3 dudes, the metadata might not properly reference all three dude IDs.

---

## 🟡 Medium Issues

### 5. Delivery Price Not Confirmed by User

**Location:** `App.tsx` `handleRequestDelivery`

The delivery cost (`resp.deliveryLamports`) is received from the server and immediately sent in a transaction without user confirmation. Users might not realize how much SOL they're paying.

**Suggested Fix:** Show delivery cost estimate BEFORE building the transaction. — make it displayed on the frontend when country is selected from the list.

---

### 8. Helius API Calls Lack Retry Logic

**Location:** `fetchAssetsOwned`, `fetchAssetProof`, `fetchAsset`

No retry mechanism for rate limits (429) or transient failures. This could cause failed transactions during high-traffic periods.

---

## 🟢 Minor Issues / Suggestions

### 10. WalletContext `useMemo` Dependency

**Location:** `WalletContext.tsx` line 36

```tsx
const wallets = useMemo(() => [...], [network]);
```

`network` is a module-level constant that never changes, so this dependency is misleading. Should either be `[]` or just compute inline.

---

### 11. Certificate Sequential Numbers Unused

**Location:** `reserveCertificateNumbers`

The function reserves sequential certificate numbers, but these numbers are only used as `startIndex` for `buildMetadata`. The actual certificate name/URI comes from box/dude IDs, not the sequential certificate number.

Certificate name / uri should in fact come from box / dude ids — so this is correct, let's just clean up unused stuff.

---

### 12. `finalizeMintTx` Lacks Authentication

**Location:** `functions/src/index.ts` `finalizeMintTx`

Anyone can call this endpoint with any signature. While it only records confirmed on-chain mints, it could be called redundantly by malicious actors.

---

### 13. Missing `VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY` Documentation

The frontend requires `VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY` env var for encrypting addresses. There's no documentation about:
- How to generate this keypair
- Where the private key should be stored
- Who decrypts the addresses