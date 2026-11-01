import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { RelicClaimGrid } = await import('../src/ethereum/RelicClaimGrid.tsx');
dom.window.close();

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); dom.window.close(); });

for (const [width, height, viewport] of [[288, 188, 320], [343, 240, 375], [900, 350, 1280], [700, 200, 1024]]) {
  test(`all eighteen relic tiles fit inside ${width}×${height} without setting a larger preview height`, () => {
    const view = render(createElement(RelicClaimGrid, { claimedMask: 0, selectedId: null, disabled: false, onSelect() {} }));
    const preview = view.container.querySelector('.mint-panel__preview') as HTMLElement;
    Object.defineProperty(preview, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(preview, 'clientHeight', { configurable: true, value: height });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport });
    act(() => window.dispatchEvent(new dom.window.Event('resize')));
    const grid = view.getByRole('radiogroup', { name: 'Choose a relic' });
    const size = Number.parseFloat(grid.style.getPropertyValue('--relic-size'));
    const columns = Number(grid.style.getPropertyValue('--relic-columns'));
    const gap = Number.parseFloat(grid.style.getPropertyValue('--relic-gap'));
    const rows = Math.ceil(18 / columns);
    assert.ok(columns * size + (columns - 1) * gap <= width);
    assert.ok(rows * size + (rows - 1) * gap <= height);
    assert.ok(size >= 44);
    assert.equal(grid.querySelectorAll('input').length, 18);
    assert.equal(preview.style.height, '');
    assert.equal(preview.style.minHeight, '');
  });
}

test('claimed images remain in the grid and only available radio inputs can select an ID', () => {
  const ids: number[] = [];
  const props = { claimedMask: 1 << 3, selectedId: 18, disabled: false, onSelect: (id: number) => ids.push(id) };
  const view = render(createElement(RelicClaimGrid, props));
  const claimed = view.getByRole('radio', { name: 'Relic #4, claimed' }) as HTMLInputElement;
  assert.equal(claimed.disabled, true);
  assert.equal(claimed.closest('label')!.getAttribute('data-claimed'), 'true');
  const available = view.getByRole('radio', { name: 'Relic #2' }) as HTMLInputElement;
  assert.equal(available.disabled, false);
  fireEvent.click(available);
  assert.deepEqual(ids, [2]);
  view.rerender(createElement(RelicClaimGrid, { ...props, disabled: true }));
  assert.ok(view.getAllByRole('radio').every(input => (input as HTMLInputElement).disabled));
  assert.equal(view.getAllByRole('radio').length, 18);
  assert.equal(view.container.querySelectorAll('a').length, 0);
});
