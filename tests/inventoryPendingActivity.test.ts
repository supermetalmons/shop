import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { InventoryItem } from '../src/types.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { InventoryGrid } = await import('../src/components/InventoryGrid.tsx');
dom.window.close();
beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); dom.window.close(); });

const pending: InventoryItem = { id: 'pending', dropId: '111k_devnet', kind: 'box', name: 'Pending crate', status: 'pending' };
const available: InventoryItem = { id: 'available', dropId: 'mi_note_cards', kind: 'box', name: 'Available box' };

test('busy inventory tiles have activity indicators and reject click, keyboard, reveal and view while other items remain usable', () => {
  const actions: string[] = [];
  const view = render(createElement(InventoryGrid, {
    items: [pending, available], selected: new Set<string>(), onToggle: id => actions.push(`select:${id}`),
    onViewItem: item => actions.push(`view:${item.id}`), onReveal: id => actions.push(`reveal:${id}`),
    pendingRevealIds: new Set([pending.id]), busyItemIds: new Set([pending.id]),
  }));
  const tile = view.container.querySelector('[data-inventory-id="pending"]')!;
  assert.equal(tile.getAttribute('aria-busy'), 'true');
  assert.equal(tile.getAttribute('aria-disabled'), 'true');
  assert.equal(tile.getAttribute('tabindex'), null);
  assert.equal(tile.getAttribute('role'), null);
  assert.ok(tile.querySelector('.inventory__activity'));
  fireEvent.click(tile);
  fireEvent.keyDown(tile, { key: 'Enter' });
  fireEvent.keyDown(tile, { key: ' ' });
  assert.deepEqual(actions, []);
  const live = view.container.querySelector('[data-inventory-id="available"]')!;
  fireEvent.click(live);
  fireEvent.keyDown(live, { key: 'Enter' });
  assert.deepEqual(actions, ['select:available', 'select:available']);
});

test('busy tiles stay inert in a view-only grid', () => {
  const viewed: string[] = [];
  const view = render(createElement(InventoryGrid, {
    items: [pending, available], interactionMode: 'view-only',
    onViewItem: item => viewed.push(item.id), busyItemIds: new Set([pending.id]),
  }));
  fireEvent.click(view.container.querySelector('[data-inventory-id="pending"]')!);
  fireEvent.click(view.container.querySelector('[data-inventory-id="available"]')!);
  assert.deepEqual(viewed, ['available']);
});

test('existing Solana pending-item viewing is unchanged when no busy IDs are supplied', () => {
  const viewed: string[] = [];
  const view = render(createElement(InventoryGrid, {
    items: [{ ...pending, dropId: 'mi_note_cards' }], selected: new Set<string>(), onToggle() {},
    onViewItem: item => viewed.push(item.id),
  }));
  fireEvent.click(view.getByRole('button', { name: 'View Pending crate' }));
  assert.deepEqual(viewed, ['pending']);
  assert.equal(view.container.querySelector('.inventory__activity'), null);
});

function touch(target: Element, name: string) {
  const point = { identifier: 1, clientX: 20, clientY: 20 };
  const list = { length: 1, item: () => point };
  act(() => target.dispatchEvent(Object.assign(new dom.window.Event(name, { bubbles: true, cancelable: true }), {
    changedTouches: list, touches: name === 'touchend' ? { length: 0, item: () => null } : list,
  })));
}

test('mobile touch activation reads current item locks and does not block unrelated taps', () => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone Mobile' });
  const selected: string[] = [];
  const props = { items: [available, { ...available, id: 'other' }], selected: new Set<string>(), onToggle: (id: string) => selected.push(id) };
  const view = render(createElement(InventoryGrid, props));
  const tile = view.container.querySelector('[data-inventory-id="available"]')!;
  touch(tile, 'touchstart');
  view.rerender(createElement(InventoryGrid, { ...props, busyItemIds: new Set([available.id]) }));
  touch(tile, 'touchend');
  assert.deepEqual(selected, []);
  touch(tile, 'touchstart');
  touch(tile, 'touchend');
  assert.deepEqual(selected, []);
  const other = view.container.querySelector('[data-inventory-id="other"]')!;
  touch(other, 'touchstart');
  touch(other, 'touchend');
  assert.deepEqual(selected, ['other']);
});
