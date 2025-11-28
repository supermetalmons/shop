# Plan Compliance Findings

Potential gaps between the current implementation and the requirements in `plan_clean.md`.

## 1. No user email capture or meaningful address hints

- The plan expects each profile to store an email plus a human-readable hint (first/last letters) for every saved delivery address.

```50:53:plan_clean.md
- sign in with solana — get existing profile if any, profile will only have a delivery id now, some unencrypted hint for it like first and last letters, unecrupted country, and an email address.
- save an encrpypted delivery address: cloud function only receives a string encrypted on a website with TweetNaCl. it should save it in firebase database then corresponding to passed solana address, and an id should get assigned...
```

- The delivery form never collects an email field and only lets the user input physical address lines.

```42:81:src/components/DeliveryForm.tsx
    <form className="card" onSubmit={handleSubmit}>
      ...
      <label>
        <span className="muted">Country</span>
        <input required value={country} onChange={(e) => setCountry(e.target.value)} />
      </label>
      <label>
        <span className="muted">Label</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home / Studio" />
      </label>
```

- `solanaAuth` auto-creates a Firebase user with a placeholder `${wallet}@mons.shop` email and never stores a real address, and `saveAddress` persists a hint derived from the ciphertext instead of first/last letters of the actual address.

```311:323:functions/src/index.ts
  const userRecord = await admin.auth().getUserByEmail(`${wallet}@mons.shop`).catch(() => null);
  if (!userRecord) {
    await admin.auth().createUser({ uid: wallet, email: `${wallet}@mons.shop` }).catch(() => undefined);
  }
  ...
  const profile = snap.exists ? snap.data() : { wallet };
  if (!snap.exists) await profileRef.set(profile);
```

```343:357:functions/src/index.ts
  const schema = z.object({ encrypted: z.string(), country: z.string(), label: z.string().default('Home') });
  ...
  const hint = body.encrypted.slice(0, 6) + '…';
  await addressRef.set({ ...body, id, hint, createdAt: admin.firestore.FieldValue.serverTimestamp() });
```

_Impact:_ shipping cannot contact the user or identify addresses by human-friendly hints, which is explicitly required.

## 2. Delivery prep never assigns dudes for unopened boxes

- Requirement: when a delivery includes blind boxes, the cloud function must silently assign the dudes that will ship inside those boxes.

```54:57:plan_clean.md
- prepare a delivery tx: ... this tx should burn cnfts ... When there is a blind box in the delivery, this cloud function should silently assign dudes ids that will be sent in that blind box (same way as dudes get assigned for a box on open tx preparation — make sure not to reassign them if they are already there).
```

- Implementation: `prepareDeliveryTx` burns/mints but never calls `assignDudes`, so unopened boxes slated for shipping never receive reserved dude IDs.

```401:430:functions/src/index.ts
export const prepareDeliveryTx = functions.https.onRequest(async (req, res) => {
  ...
  for (let i = 0; i < itemIds.length; i += 1) {
    const id = itemIds[i];
    try {
      instructions.push(await createBurnIx(id, ownerPk));
    } catch (err) {
      instructions.push(memoInstruction(`burn:${id}`));
    }
    instructions.push(...(await buildMintInstructions(ownerPk, 1, 'certificate', i + 1, { boxId: id })));
  }
```

_Impact:_ there is no record of which dudes belong in a sealed box that is shipped without being opened on-chain, so the fulfillment team cannot honor the “3 dudes per box” promise later.

## 3. CNFT burns become optional due to memo fallbacks

- The plan mandates that opening a box deletes the box CNFT and that delivery burns the submitted boxes/dudes.

```36:40:plan_clean.md
- open blind box tx. open 1 specific blind box: blind box cnft gets deleted...
- request delivery tx. pass in blind boxes cnfts and dudes cnfts that need to be deleted. ... give user another unique certificate cnft.
```

- Both `prepareOpenBoxTx` and `prepareDeliveryTx` wrap `createBurnIx` in `try/catch` and, on any error, push a memo instruction instead of failing.

```388:395:functions/src/index.ts
  try {
    instructions.push(await createBurnIx(boxAssetId, ownerPk));
  } catch (err) {
    instructions.push(memoInstruction(`open-box:${boxAssetId}`));
  }
```

```414:421:functions/src/index.ts
    try {
      instructions.push(await createBurnIx(id, ownerPk));
    } catch (err) {
      instructions.push(memoInstruction(`burn:${id}`));
    }
```

_Impact:_ users can mint dudes or certificates even if the corresponding burn proof fails, breaking supply guarantees and diverging from the “burn then mint” sequence spelled out in the plan.

## 4. Claim-code flow is neither bound to a certificate nor single-use

- The plan requires the claim function to check both the secret code and the presence of the matching blind-box certificate so only that owner can mint the stored dudes certificates.

```42:58:plan_clean.md
- claim certificates for irl dudes tx. this will mint specific dudes certificates ... will also check if the blind box certificate is there on an address that is trying to claim ...
```

- Current logic only verifies that the wallet owns whatever certificate ID the user typed, ignores whether that certificate matches the stored `boxId`, and never marks the claim record as redeemed.

```438:462:functions/src/index.ts
  const claimDoc = await db.doc(`claimCodes/${code}`).get();
  ...
  const ownsCertificate = (assets || []).some((a: any) => a.id === blindBoxCertificateId);
  if (!ownsCertificate) {
    res.status(403).json({ error: 'Certificate not found in wallet' });
    return;
  }
  ...
  instructions.push(memoInstruction(`claim:${code}`));
  const dudeIds: number[] = claim.dudeIds || [];
  instructions.push(...(await buildMintInstructions(ownerPk, dudeIds.length, 'certificate', dudeIds[0] || 1, { boxId: claim.boxId, dudeIds })));
```

_Impact:_ a single code can be replayed indefinitely, and someone can pair a valid code with any arbitrary certificate in their wallet, violating the “only that blind box owner can claim” requirement.

## 5. Mint supply counter is decremented before the mint tx executes

- Supply must stay capped at 333 (11 on dev/test) actual boxes minted on-chain.

```29:33:plan_clean.md
- mint tx. 1-20 cnft boxes in a single transaction.
total boxes supply will be 333 boxes. ... during development let's test it with 11 boxes on devnet and then on testnet.
```

- `prepareMintTx` calls `incrementMinted(quantity)` immediately, before the transaction is signed or submitted by the user. If the wallet never sends the tx or it fails, the Firestore counter still consumes supply, so the site may announce “minted out” while boxes remain unminted on-chain.

```365:375:functions/src/index.ts
  const { owner, quantity } = schema.parse(req.body);
  const ownerPk = new PublicKey(owner);
  await incrementMinted(quantity);
  const conn = connection();
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })];
  const mintedSoFar = await getMintedCount();
  instructions.push(...(await buildMintInstructions(ownerPk, quantity, 'box', mintedSoFar - quantity + 1)));
```

_Impact:_ the drop can prematurely reach “sold out” status, contradicting the plan’s requirement that 333/11 actual boxes exist.
