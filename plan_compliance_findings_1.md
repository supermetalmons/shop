# Plan Compliance Findings

1. **Burn steps silently downgrade to memos instead of deleting NFTs**

   - _Plan_: “blind box cnft gets deleted” during open box tx, and delivery tx “should burn cnfts … and mint certificates.”
   - _Implementation_: `prepareOpenBoxTx` and `prepareDeliveryTx` catch any error produced while building the burn instruction and replace it with a memo (`memoInstruction("open-box:…")` / `memoInstruction("burn:…")`), which means the box or dude cNFT can remain on-chain while new assets are minted.
   - _Impact_: Users could duplicate assets (keep the box/dude and still receive the new dudes/certificates), breaking the intended supply logic.

2. **Delivery transactions never assign dudes to sealed boxes**

   - _Plan_: When a blind box is included in a delivery request, “cloud function should silently assign dudes ids that will be sent in that blind box … make sure not to reassign them if they are already there.”
   - _Implementation_: `prepareDeliveryTx` iterates over `itemIds` and only burns + mints certificates. There is no call to `assignDudes`, nor any persistence of which dudes belong to a shipped-but-unopened box.
   - _Impact_: Physical shipments of sealed boxes will not have predetermined dude IDs, so later IRL claims cannot know which certificates to mint for that box.

3. **Profiles cannot store the required email address**

   - _Plan_: Solana sign-in should return “a profile … with … an email address,” and only one email should exist per profile.
   - _Implementation_: Neither the frontend nor the cloud functions collect or persist a user-provided email. `solanaAuth` simply returns `{ wallet }` plus saved addresses, and there is no form for editing email.
   - _Impact_: The team cannot contact users about deliveries via the intended per-profile email, and the plan’s data contract is unmet.

4. **Delivery address hints are not persisted in cleartext**

   - _Plan_: Stored addresses should expose “some unencrypted hint for it like first and last letters” so users can recognize saved entries.
   - _Implementation_: `saveAddress` stores `hint` as the first six characters of the ciphertext; the plaintext-derived hint (`plaintext.slice(0, 1) + '...' + plaintext.slice(-2)`) only lives in React state until the page reloads.
   - _Impact_: After signing in again, the UI can only show garbage-looking hints (e.g., `Q2xM1…`), defeating the usability requirement.

5. **Mint progress can be exhausted without on-chain mints**
   - _Plan_: The progress bar and “minted out” behaviors depend on the real count of minted boxes.
   - _Implementation_: `prepareMintTx` increments the Firestore `minted` counter before the user signs/broadcasts the transaction, and there’s no rollback if the user abandons the request. A malicious user can repeatedly call the endpoint to drive the counter to 333 even if zero boxes were minted.
   - _Impact_: The site can display “sold out,” disable minting, and show the post-mint UI while supply still exists, diverging from the plan’s intended behavior.
