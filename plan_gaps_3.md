# Project Audit Report

This document outlines the findings from a deep review of the codebase against the requirements in `plan_clean.md`.

## 1. Missing Features & Incomplete Logic

### 1.1. IRL Claim Code Generation
- **Issue:** The plan requires an IRL claim flow where users enter a secret code. The backend (`prepareIrlClaimTx`) validates this code against a `claimCodes` collection in Firestore.
- **Missing:** There is no script or tool in the repository to **generate these codes** and populate the Firestore database. Without this, the claim feature is operationally unusable.
- **Recommendation:** Create a script (e.g., `scripts/generate-claim-codes.ts`) that generates unique codes, assigns them to specific box IDs (optional) or dude IDs, and writes them to Firestore.

### 1.2. Collection NFT Creation
- **Issue:** The `scripts/derive-collection.ts` script calculates PDAs for an *existing* collection mint, but there is no script to actually **create/mint** the Collection NFT itself on-chain.
- **Missing:** A script to mint the top-level Collection NFT that will verify the compressed NFTs.
- **Recommendation:** Add a `scripts/create-collection.ts` script using Metaplex SDK to mint the collection NFT.

### 1.3. Visual Variety of Dudes
- **Issue:** The `functions/src/index.ts` assigns the same metadata URI (`.../dude.json`) to all "dude" NFTs.
- **Impact:** Unless the `metadataBase` endpoint is a dynamic server that serves different content based on some hidden parameter (which isn't passed in the static URL), **all dudes will look identical**. The plan implies a collection of unique items (999 total).
- **Recommendation:**
    - If using static hosting: The URI should be constructed as `${metadataBase}/dude/${dudeId}.json`.
    - If using the current single JSON: Ensure the image endpoint returns random images (unlikely for a static JSON).
    - Update `buildMetadata` to include the `dudeId` in the URI path.

## 2. Plan Deviations & Clarifications

### 2.1. Email Subscription Form
- **Observation:** The plan mentions using an "email subscribtion form that is used in index.html currently".
- **Status:** Implemented in `EmailSubscribe.tsx` by loading an external script. The `FORM_ID` is hardcoded. Ensure this ID is correct for the production environment.

### 2.2. Secondary Market Links
- **Observation:** Implemented in `App.tsx` (lines 209-214).
- **Status:** **Correct.** Links are controlled via environment variables.

### 2.3. Delivery Encryption
- **Observation:** Plan requires TweetNaCl encryption on the frontend.
- **Status:** **Correct.** Implemented in `App.tsx` using `encryptAddressPayload` before sending to the backend.

### 2.4. Claim Form UX
- **Observation:** The `ClaimForm` requires the user to manually copy-paste their `Certificate ID`.
- **Status:** Functional but poor UX. Ideally, the form should list the user's "Certificate" assets (fetched via the inventory hook) and let them select one to claim against, similar to how the Delivery panel works.

## 3. Operational & Security Considerations

### 3.1. Metadata Hosting
- **Observation:** `metadataBase` defaults to `https://assets.mons.link/metadata`.
- **Action:** Ensure this host is active and serves the required `box.json`, `dude.json` (or `dude/*.json`), and `certificate.json` files with appropriate CORS headers.

### 3.2. Firestore Rules
- **Observation:** `firestore.rules` are strict and generally look good.
    - `boxAssignments`, `meta`, `claimCodes` are read/write `false` (backend only).
    - `profiles` are user-writable for their own data.
- **Status:** **Good.**

### 3.3. Environment Variables
- **Observation:** The project relies on numerous environment variables across Frontend and Functions.
- **Action:** A `.env.example` file is missing. It would be helpful to document:
    - `VITE_FIREBASE_PROJECT_ID`
    - `VITE_FUNCTIONS_BASE_URL`
    - `VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY`
    - `HELIUS_API_KEY`
    - `TREE_AUTHORITY_SECRET`
    - `COSIGNER_SECRET` (optional)
    - `COLLECTION_*` keys

## 4. Summary
The codebase is **90% complete** regarding the logic and flow described in the plan. The main gaps are **operational scripts** (generating claim codes, creating collection NFT) and **metadata structure** (ensuring dudes are visually unique). The core on-chain and backend logic aligns well with the requirements.


