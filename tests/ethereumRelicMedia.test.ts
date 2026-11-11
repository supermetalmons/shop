import assert from 'node:assert/strict';
import test from 'node:test';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { ETHEREUM_CONTAINER_MEDIA } from '../src/ethereum/containerMedia.ts';
import { buildEthereumInventoryItems } from '../src/ethereum/inventory.ts';
import { relicDisplayMedia } from '../src/ethereum/relicMedia.ts';
import { ethereumInventoryView } from '../src/ethereum/state.ts';

const root = 'https://cdn.lil.org/nft/111k/relics/';

function relic(displayId: number): EthereumInventoryItem {
  const contractAddress = `0x${'33'.repeat(20)}`;
  const tokenId = String(117171 + displayId);
  return { id: `eip155:11155111:${contractAddress}:${tokenId}`, tokenId, kind: 'relic', displayId,
    name: `Relic #${displayId}`, image: `${root}${displayId}.png`, owner: `0x${'11'.repeat(20)}`,
    chainId: 11155111, contractAddress };
}

test('all eighteen canonical relic images resolve to the same mid preview across publication revisions', () => {
  for (let id = 1; id <= 18; id++) {
    const media = relicDisplayMedia(`${root}${id}.png`)!;
    assert.equal(media.src, `${root}mid/${id}.webp`);
    assert.ok(media.width > 0 && media.height > 0);
    assert.equal(media.aspectRatio, media.width / media.height);
    assert.deepEqual(relicDisplayMedia(`${root}${id}.webp`), media);
    assert.deepEqual(relicDisplayMedia(media.src), media);
  }
});

test('relic preview matching leaves unrelated, malformed, and out-of-range images alone', () => {
  for (const image of [undefined, '', `${root}0.png`, `${root}19.png`, `${root}01.png`, `${root}1.PNG`,
    `${root}mid/1.png`, `${root}mid/1.webp?version=1`, `${root}1.png#preview`, `${root}1.png\n`,
    `${root}../1.png`, `${root}%31.png`, `${root}1.png/`, `${root}1.jpg`,
    'https://cdn.lil.org/nft/111k/placeholder.png', 'https://cdn.lil.org/nft/111k/paintings/1.png',
    'https://wip.lil.org/111k/relics/1.webp', 'https://elsewhere.example/relics/1.png']) {
    assert.equal(relicDisplayMedia(image), undefined, image);
  }
});

test('inventory display uses mid previews without changing canonical metadata or receipt images', () => {
  for (const [id, width, height] of [[1, 1320, 1858], [18, 1320, 750]]) {
    const item = Object.freeze({ ...relic(id), aspectRatio: { width: 1, height: 1 } });
    const view = ethereumInventoryView(item);
    assert.equal(view.image, `${root}mid/${id}.webp`);
    assert.deepEqual(view.imageDimensions, { width, height });
    assert.equal(view.ethereum, item);
    assert.equal(view.ethereum.image, `${root}${id}.png`);
    assert.deepEqual(view.ethereum.aspectRatio, { width: 1, height: 1 });
  }
  for (const kind of ['artwork', 'artwork_receipt', 'crate_receipt', 'relic_receipt'] as const) {
    const item = { ...relic(1), kind };
    assert.equal(ethereumInventoryView(item).image, item.image);
  }
  const item = { ...relic(1), image: 'https://elsewhere.example/relics/1.png' };
  assert.equal(ethereumInventoryView(item).image, item.image);
  assert.equal(ethereumInventoryView(item).imageDimensions, undefined);
});

test('pending relics use their own mid dimensions and the static preview uses relic one', () => {
  const pendingMints = [1, 18].map(id => ({ id: String(id), kind: 'relic' as const, quantity: 1,
    submittedAt: id, image: `${root}${id}.png` }));
  const inventory = buildEthereumInventoryItems({ items: [], solanaItems: [], dropId: '111k', pendingMints });
  assert.deepEqual(inventory.items.map(item => [item.image, item.imageDimensions]), [
    [`${root}mid/18.webp`, { width: 1320, height: 750 }],
    [`${root}mid/1.webp`, { width: 1320, height: 1858 }],
  ]);
  assert.deepEqual(pendingMints.map(mint => mint.image), [`${root}1.png`, `${root}18.png`]);
  assert.equal(ETHEREUM_CONTAINER_MEDIA.relic.src, `${root}mid/1.webp`);
  assert.equal(ETHEREUM_CONTAINER_MEDIA.relic.width, 1320);
  assert.equal(ETHEREUM_CONTAINER_MEDIA.relic.height, 1858);
});
