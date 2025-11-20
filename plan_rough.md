# Solana Box Project - Implementation Plan

## 1. System Overview

The system consists of an Anchor-based Solana program, a Cloud Backend (Oracle/Cosigner), and a Frontend.
All assets (Boxes, Dudes, Certificates) are **Compressed NFTs (cNFTs)** using Metaplex Bubblegum.

### Key Flows

1.  **Mint Box**: User pays SOL -> Receives "Box" cNFT.
2.  **Digital Open**: User burns "Box" -> Program selects 3 "Dude" IDs (Pseudo-random) -> User receives 3 "Dude" cNFTs.
3.  **Item Delivery**: User burns "Dude" cNFTs -> Pays Shipping -> Receives "Certificate".
4.  **Blind Box Delivery (Physical Open)**:
    - User burns "Box" -> Program selects 3 "Dude" IDs (Hidden on-chain) -> User receives "Blind Box Certificate".
    - User receives Physical Box -> Enters Code -> Mints the specific "Dude" cNFTs assigned to that box.

---

## 2. On-Chain Data Structures (Anchor)

### 2.1 Global State PDA

Stores configuration and global counters.

```rust
#[account]
pub struct GlobalState {
    pub admin: Pubkey,
    pub cosigner: Pubkey,          // Cloud function public key
    pub merkle_tree: Pubkey,       // The Bubblegum Tree

    // Supply Config
    pub total_boxes_minted: u64,
    pub total_dudes_minted: u64,
    pub max_dudes_supply: u64,
}
```

### 2.2 Supply Tracker PDA (Bitmap)

To ensure unique "Dude" IDs are minted from the pool without duplicates.

```rust
#[account]
pub struct SupplyBitmap {
    // Bitmask: 1 = Minted/Assigned, 0 = Available.
    // Size: 999 items -> ~125 bytes.
    pub map: [u8; 128],
}
```

### 2.3 Delivery Content Registry PDA

Stores the pre-assigned contents of **Blind Boxes** in a specific delivery.

```rust
#[account]
pub struct DeliveryContentRegistry {
    pub delivery_id: u64,
    // List of assigned contents for each Blind Box in this delivery.
    // Each entry is an array of 3 Dude IDs.
    pub blind_box_contents: Vec<[u16; 3]>,
    pub claimed_mask: Vec<bool>, // Track which boxes in the delivery have been physically claimed
}
```

---

## 3. On-Chain Randomness Strategy (Pseudo-Random)

To keep the UX fast and simple, we will use **Pseudo-Randomness** derived from the recent blockhash.
_Note: This is "random enough" for this use case but technically manipulatable by validators (though unlikely for low-value items)._

### 3.1 The Logic

1.  **Source**: `RecentBlockhashes` sysvar or `SlotHash`.
2.  **Seed**: `hash(SlotHash + UserPubkey + CurrentTime)`.
3.  **Selection**: Use the seed to generate 3 indices.
4.  **Collision**: Linear probing on the `SupplyBitmap`.

---

## 4. Detailed Instruction Logic

### 4.1 `mint_box`

- **Inputs**: Amount (e.g., 11).
- **Logic**:
  - Transfer `Price * Amount` SOL to Treasury.
  - Loop `Amount` times:
    - CPI Bubblegum Mint "Box" cNFT.
  - _Note: Limited by block compute units (approx 5-10 per tx)._

### 4.2 `open_box_digital` (Burn Box -> Get Dudes)

- **Inputs**: None (besides accounts).
- **Single Transaction**:
  - **Verify**: Check ownership of Box cNFT.
  - **Burn**: CPI to Bubblegum to burn the Box.
  - **Selection Logic**:
    1.  Calculate pseudo-random index `i` (using SlotHash).
    2.  **Search**: Check `SupplyBitmap[i]`. If free, take it.
    3.  **Collision**: If taken, linear probe (check next bit).
    4.  **Fail**: If we check e.g. 50 bits and all are taken, fail tx. (With 999 supply, this is rare until the very end).
  - **Mint**: CPI to Bubblegum to mint 3 "Dude" cNFTs.

### 4.3 `request_delivery` (Unified Delivery Request)

- **Inputs**:
  - `dude_assets`: List of Dude cNFTs.
  - `box_assets`: List of Blind Box cNFTs.
  - `hints`: List of available IDs (for the blind boxes).
  - `shipping_cost`: u64.
  - `delivery_id`: u64.
  - `signature`: Cloud Signature.
- **Limits**: Max 5 Blind Boxes, 20 Dudes per tx.
- **Logic**:
  - **Verify Signature**: `hash(user + delivery_id + shipping_cost + asset_ids + hints + timestamp)`.
  - **Check Timestamp**: Ensure signature is recent (< 10 mins).
  - **Process Dudes**:
    - Loop through `dude_assets`:
      - CPI Burn Dude cNFT.
      - **Mint**: CPI Mint 1 "Dude Delivery Certificate" cNFT (Attributes: `DeliveryID: X`, `OriginalDudeID: Y`).
  - **Process Blind Boxes**:
    - Loop through `box_assets`:
      - CPI Burn Box cNFT.
      - **Selection**: Random search -> Fallback to `hints`.
      - **Push** `[id1, id2, id3]` to `DeliveryContentRegistry`.
      - **Mint**: CPI Mint 1 "Blind Box Delivery Certificate" cNFT (Attributes: `DeliveryID: X`, `BoxIndex: i`).

### 4.4 `claim_blind_box_content` (Physical Reveal)

- **Inputs**:
  - `delivery_id`: u64.
  - `box_index`: Index of the box in the delivery (0, 1, 2...).
  - `certificate_asset_id`: The specific "Blind Box Certificate" cNFT.
  - `code_hash`: Hash of the physical code.
  - `signature`: Cloud Signature.
- **Logic**:
  - Verify Cloud Signature.
  - **Verify & Burn**: Check user owns `certificate_asset_id` and **Burn it**.
  - Read `DeliveryContentRegistry`.
  - Check `claimed_mask[box_index]` is false.
  - **Mint**: CPI Bubblegum Mint the 3 Dudes stored at `blind_box_contents[box_index]`.
  - Set `claimed_mask[box_index]` = true.

---

## 5. Off-Chain Architecture

### 5.1 Encryption (Delivery Address)

- **Algorithm**: TweetNaCl (Curve25519).
- **Flow**: Frontend Encrypts -> Cloud Stores -> Logistics Decrypts (Local Key).

### 5.2 Cloud Function (Cosigner)

- **Role**:
  - Provide `hints` (available IDs) for opening/delivery to prevent collisions.
  - Sign transactions to authorize actions and validate business logic.
  - **Replay Protection**: Signatures include a timestamp (valid for 10 mins).
- **Endpoints**:
  - `POST /shipping-quote`: Returns `cost` + `hints` + `signature`.
  - `POST /verify-irl-code`: Validates code -> Returns signature.

### 5.3 Logistics & Metadata

- **Warehouse Ops**: Strict flow. Packer scans Physical Box QR -> Scans Delivery Certificate -> Cloud links Box ID to `DeliveryID`.
- **Metadata**: Hosted on your API (Dynamic). Allows instant updates/reveals.
