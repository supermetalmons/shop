## Potential deviations from `plan_clean.md`

- **Inventory endpoint returns every NFT in the wallet, not just Mons items.**  
  The plan requires the grid to reflect “your minted boxes … fetched via a firebase cloud function that would use helius api” (i.e., only the drop’s blind boxes, dudes, and certificates). The current `inventory` function simply relays the full response from Helius without filtering and even defaults unknown assets to `kind: 'box'`, so unrelated NFTs appear as selectable mons boxes/dudes. Users can then try to “open” or deliver those assets, leading to confusing errors or accidental burns.  
  `functions/src/index.ts` shows the missing filter:

  ```453:463:functions/src/index.ts
  export const inventory = functions.https.onRequest(async (req, res) => {
    const owner = (req.query.owner as string) || '';
    const assets = await fetchAssetsOwned(owner);
    const items = (assets || []).map(transformInventoryItem);
    res.json(items);
  });
  ```

  and `transformInventoryItem` falls back to classifying anything without a `type` trait as a blind box:

  ```339:349:functions/src/index.ts
  function transformInventoryItem(asset: any) {
    const kindAttr = asset?.content?.metadata?.attributes?.find((a: any) => a.trait_type === 'type');
    const kind = (kindAttr?.value || 'box') as 'box' | 'dude' | 'certificate';
    return {
      id: asset.id,
      name: asset.content?.metadata?.name || asset.id,
      kind,
      image: asset.content?.links?.image,
      attributes: asset.content?.metadata?.attributes || [],
      status: asset.compression?.compressed ? 'minted' : 'unknown',
    };
  }
  ```

  We should filter by the configured `collectionMint` (or at least the `type` trait) before exposing assets to the UI.

SOLUTION: use specific collection deployment id from env to filter results