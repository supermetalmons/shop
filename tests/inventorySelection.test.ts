import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleInventorySelection } from '../src/lib/inventorySelection.ts';
import type { InventoryItem } from '../src/types.ts';

const items: InventoryItem[] = [
  { id: 'clear-pack-1', dropId: 'clear_cards_devnet', name: 'Pack 1', kind: 'box' },
  { id: 'clear-pack-2', dropId: 'clear_cards_devnet', name: 'Pack 2', kind: 'box' },
  { id: 'clear-card-1', dropId: 'clear_cards_devnet', name: 'Card 1', kind: 'dude' },
  { id: 'clear-card-2', dropId: 'clear_cards_devnet', name: 'Card 2', kind: 'dude' },
  { id: 'other-pack', dropId: 'card_nft_2', name: 'Pack 1', kind: 'box' },
  { id: 'other-pack-2', dropId: 'card_nft_2', name: 'Pack 2', kind: 'box' },
];
const inventoryIndex = new Map(items.map((item) => [item.id, item]));

function toggle(selected: Set<string>, itemId: string): Set<string> {
  return toggleInventorySelection({ selected, itemId, inventoryIndex, maxSelected: 24 });
}

test('clear cards packs remain a one-at-a-time open-only selection', () => {
  assert.deepEqual(toggle(new Set(['clear-pack-1']), 'clear-pack-2'), new Set(['clear-pack-2']));
  assert.deepEqual(
    toggle(new Set(['clear-card-1', 'clear-card-2']), 'clear-pack-1'),
    new Set(['clear-pack-1']),
  );
});

test('clear cards cannot mix packs and cards while cards retain multi-select', () => {
  assert.deepEqual(toggle(new Set(['clear-pack-1']), 'clear-card-1'), new Set(['clear-card-1']));
  assert.deepEqual(toggle(new Set(['clear-card-1']), 'clear-card-2'), new Set(['clear-card-1', 'clear-card-2']));
});

test('other drop families retain multi-pack selection', () => {
  assert.deepEqual(
    toggle(new Set(['other-pack']), 'other-pack-2'),
    new Set(['other-pack', 'other-pack-2']),
  );
});
