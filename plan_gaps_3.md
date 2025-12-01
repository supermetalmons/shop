# Project Audit Report

This document outlines the findings from a deep review of the codebase against the requirements in `plan_clean.md`.

## 1. Missing Features & Incomplete Logic

### 1.1. IRL Claim Code Generation

- **Issue:** The plan requires an IRL claim flow where users enter a secret code. The backend (`prepareIrlClaimTx`) validates this code against a `claimCodes` collection in Firestore.

— these should be created when blind box is requested for a delivery

### 1.2. Collection NFT Creation

- **Issue:** The `scripts/derive-collection.ts` script calculates PDAs for an _existing_ collection mint, but there is no script to actually **create/mint** the Collection NFT itself on-chain.
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

## 3. Operational & Security Considerations

### 3.1. Metadata Hosting

- **Observation:** `metadataBase` defaults to `https://assets.mons.link/metadata`.
- **Action:** Ensure this host is active and serves the required `box.json`, `dude.json` (or `dude/*.json`), and `certificate.json` files with appropriate CORS headers.
