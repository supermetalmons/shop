import assert from 'node:assert/strict';
import test from 'node:test';

import { solanaExplorerAddressUrl } from '../src/lib/solanaExplorer';

const ADDRESS = 'So11111111111111111111111111111111111111112';

test('Solana Explorer address links use the default mainnet cluster', () => {
  assert.equal(
    solanaExplorerAddressUrl(ADDRESS, 'mainnet-beta'),
    `https://explorer.solana.com/address/${ADDRESS}`,
  );
});

test('Solana Explorer address links preserve non-mainnet clusters', () => {
  assert.equal(
    solanaExplorerAddressUrl(ADDRESS, 'devnet'),
    `https://explorer.solana.com/address/${ADDRESS}?cluster=devnet`,
  );
  assert.equal(
    solanaExplorerAddressUrl(ADDRESS, 'testnet'),
    `https://explorer.solana.com/address/${ADDRESS}?cluster=testnet`,
  );
});

test('Solana Explorer address links reject synthetic or malformed asset IDs', () => {
  assert.equal(solanaExplorerAddressUrl('claimed-receipt-preview', 'devnet'), null);
  assert.equal(solanaExplorerAddressUrl('', 'mainnet-beta'), null);
});
