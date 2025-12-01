# Implementation Review: Potential Issues & Incompleteness

This document compares the implementation against `plan_clean.md` and identifies areas that may need attention.

---

## Critical Issues

### 1. No Delivery Order Tracking / Missing `finalizeDeliveryTx`

**Plan says:**
> request delivery tx. pass in blind boxes cnfts and dudes cnfts that need to be deleted...

**Issue:**
Unlike minting and claiming which both have "finalize" endpoints (`finalizeMintTx`, `finalizeClaimTx`) that record successful transactions in Firestore, **there is no `finalizeDeliveryTx`** function.

When a delivery tx succeeds on-chain:
- Items are burned and certificates minted
- Nothing is recorded in Firestore about the delivery
- No order tracking exists for fulfillment

**Impact:**
- No way to know what has been delivered
- No list of pending shipments for fulfillment team
- No way to link a certificate back to a delivery record

**Suggested fix:** Create a `deliveryOrders` collection and `finalizeDeliveryTx` endpoint that records:
- delivery ID
- items burned (asset IDs)
- certificates minted
- shipping address ID
- owner wallet
- timestamp
- fulfillment status

---

### 2. Claim Code Accessibility for Physical Fulfillment

**Plan says:**
> entering a code for claiming dudes certificates found in an irl blind box

**Issue:**
Claim codes are created in `ensureClaimCode()` during `prepareDeliveryTx`, stored in `claimCodes/{code}` collection. However:

- There is **no admin interface** to retrieve claim codes
- There is **no way** for the fulfillment team to get the code to print and include in physical boxes
- The code is in Firestore but inaccessible without direct database access

**Suggested fix:** Create admin dashboard for fulfillment.

---

### 3. RPC URL Falls Back to Devnet for Mainnet

**Location:** `src/wallet/WalletContext.tsx:20` and `functions/src/index.ts:56`

**Code:**
```typescript
// Client
const rpcEndpoint = import.meta.env.VITE_RPC_URL || clusterApiUrl(network === 'testnet' ? 'testnet' : 'devnet');

// Functions
const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl(cluster === 'testnet' ? 'testnet' : 'devnet');
```

**Issue:**
If `SOLANA_CLUSTER` is set to `'mainnet-beta'` but no custom RPC URL is provided, the ternary falls through to `'devnet'` instead of `'mainnet-beta'`.

**Impact:** Mainnet deployments without explicit RPC URL would connect to devnet.

**Suggested fix:**
```typescript
clusterApiUrl(cluster as any)
// or explicit handling for mainnet-beta
```

---

## Logic Issues

### 4. Certificate Index Collision Risk

**Location:** `functions/src/index.ts` - `prepareDeliveryTx`

**Code:**
```typescript
for (let i = 0; i < itemIds.length; i += 1) {
  // ...
  const certIndex = i + 1;
  // ...
  instructions.push(...(await buildMintInstructions(ownerPk, 1, 'certificate', certIndex, {...})));
}
```

**Issue:**
Certificate index uses loop index (1, 2, 3...) per delivery. This means:
- Delivery A with 2 items creates certificates with indices 1, 2
- Delivery B with 2 items also creates certificates with indices 1, 2

While assets have unique on-chain IDs, the metadata naming could be confusing: `mons authenticity #1` appears multiple times.

**Suggested fix:** derive index from dudeId/boxId.

---

## Missing Features Per Plan

### 7. No Admin Interface for Fulfillment

**Plan says:**
> only one team member will have a key to decrypt these and send to these addresses

**Issue:**
There is no admin dashboard or tooling for:
- Viewing pending delivery orders
- Decrypting shipping addresses
- Getting claim codes to include in boxes
- Marking orders as shipped/fulfilled

The plan mentions encryption with TweetNaCl where only one team member has the decryption key, but there's no tooling to use that key.

---

### 11. Collection Verification in Metadata

**Location:** `functions/src/index.ts:159`

**Code:**
```typescript
collection: { key: collectionMint, verified: false }
```

**Issue:**
All minted NFTs have `verified: false` for collection. While cNFTs work differently than regular NFTs, this may affect marketplace recognition.

**Note:** This may be intentional since Bubblegum handles collection verification differently.

---

### 12. UI Allows Selecting Certificates for Delivery

**Location:** `src/components/InventoryGrid.tsx`

**Issue:**
All inventory items (boxes, dudes, certificates) can be selected for delivery. Certificates are rejected server-side in `prepareDeliveryTx` with error "Certificates are already delivery outputs".

**Suggested improvement:** Disable checkbox or hide selection for certificates in UI.

---

# Potential Issues and Discrepancies

After reviewing the codebase and comparing it with `plan_clean.md`, the following potential issues and observations were identified.

## 1. Spoiler in Blind Box Delivery Certificates (Critical)
The plan states that when a blind box is delivered, the system should "silently assign dudes ids". This implies the user should not know which dudes are inside the box until they receive the physical box and open it (using the claim code).

**Current Implementation:**
In `functions/src/index.ts`, `prepareDeliveryTx` calls `buildMintInstructions` for the box certificate. The `buildMetadata` function (lines 110-162) explicitly includes the assigned `dudeIds` in both the certificate's **name** and **attributes**:

```typescript
// functions/src/index.ts
if (certificateTarget === 'box') {
  const dudesSuffix = dudes.length > 1 ? ` · dudes ${dudes.map((d) => `#${d}`).join('/')}` : '';
  return `mons certificate · box ${extra?.boxId?.slice(0, 6) || index}${dudesSuffix}`;
}
// ...
dudes.length > 1 ? { trait_type: 'dude_ids', value: dudes.join(',') } : null,
```

**Impact:** The user will see exactly which dudes they are getting immediately after the delivery transaction is confirmed, defeating the purpose of a "blind" box and "silent" assignment.

## 2. Helius API Endpoint for cNFTs
The `inventory` cloud function uses the Helius V0 NFT API endpoint:
`https://api.helius.xyz/v0/addresses/${owner}/nfts`

**Potential Issue:**
While Helius provides various APIs, compressed NFTs (cNFTs) are typically retrieved using the Digital Asset Standard (DAS) RPC method `getAssetsByOwner` or the Helius `searchAssets` API. The standard `v0/addresses/.../nfts` endpoint might not include compressed assets by default or at all.

**Recommendation:** Verify that this specific endpoint returns cNFTs (Bubblegum trees). If not, switch to the DAS API or Helius `searchAssets` endpoint to ensure inventory loads correctly.

## 3. Claim Form UX
The `ClaimForm` component requires the user to manually input the `Blind box certificate ID`.
`src/components/ClaimForm.tsx`:
```typescript
<input value={certificateId} onChange={(e) => setCertificateId(e.target.value)} required />
```
**Observation:** Users might find it difficult to locate and copy the asset ID of their certificate. While functionally correct according to the plan (requiring the certificate), a dropdown or selector of owned certificates would improve usability.

SOLUTION: entering a secret code from the physical box should be enough, there should be no certificate id enterence required

## 7. Delivery Cost Calculation
The country detection for shipping cost is a simple string match.
`functions/src/index.ts`:
```typescript
const isUS = compact === 'us' || ... || normalized.includes('united states');
```
**Observation:** This is fragile. Users might enter "USA " or other variations that strictly fall into "US" logic, but typos could default them to the "International" (higher) rate.

SOLUTION: enforce selection from a list of countries with flags