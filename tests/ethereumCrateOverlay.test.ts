import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect } from 'react';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import type { CrateSceneProps } from '../src/ethereum/crate/CrateScene.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const environment = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
let sceneProps: CrateSceneProps | null = null;
const bridge = '__ethereumCrateOverlayTest';
Object.defineProperty(globalThis, bridge, { configurable: true, value: function Scene(props: CrateSceneProps) {
  sceneProps = props;
  useLayoutEffect(() => { props.onReady(); }, []);
  useLayoutEffect(() => { if (props.assets) props.onAssetsReady(); }, [props.assets]);
  return createElement('div', { 'data-crate-scene': true });
} });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/crate/CrateRevealOverlay.tsx') && specifier.endsWith('/CrateScene')) {
      return { url: 'test:crate-overlay-scene', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:crate-overlay-scene') return { format: 'module', shortCircuit: true,
      source: `export default globalThis.${bridge};` };
    return nextLoad(url, context);
  },
});
const { useEthereumInventoryPresentation } = await import('../src/ethereum/useEthereumInventoryPresentation.ts');
const { EthereumInventoryOverlays } = await import('../src/ethereum/EthereumInventoryOverlays.tsx');

const sources: HTMLCanvasElement[] = [];
beforeEach(t => {
  sceneProps = null;
  sources.length = 0;
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: function () {} });
  const originalImage = globalThis.Image;
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: function () {
    const image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 640 }, naturalHeight: { value: 480 }, complete: { value: false },
      src: { set: value => { if (value) queueMicrotask(() => image.dispatchEvent(new window.Event('load'))); } },
    });
    image.decode = async () => {};
    return image;
  } });
  t.after(() => Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage }));
  t.mock.method(environment.dom.window.HTMLCanvasElement.prototype, 'getContext', (function (this: HTMLCanvasElement) {
    const canvas = this;
    return { drawImage(source: CanvasImageSource) {
      if (source instanceof HTMLImageElement) sources.push(canvas);
      else if (source instanceof environment.dom.window.HTMLCanvasElement && (!source.width || !source.height)) {
        throw new DOMException('The source canvas has no pixels.', 'InvalidStateError');
      }
    } };
  }) as never);
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
});
afterEach(() => cleanup());
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, bridge); environment.dom.window.close(); });

const hash = `0x${'ab'.repeat(32)}`;
function item(tokenId: string, kind: EthereumInventoryItem['kind']): EthereumInventoryItem {
  return { id: `eip155:11155111:0x${'33'.repeat(20)}:${tokenId}`, tokenId, name: `${kind} ${tokenId}`, kind,
    owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`,
    displayId: Number(tokenId), image: `https://wip.lil.org/reveal-test/${tokenId}.webp` };
}
async function opening() {
  let presentation!: ReturnType<typeof useEthereumInventoryPresentation>;
  let sends = 0;
  const results = Array.from({ length: 20 }, (_, index) => item(String(index + 1), 'artwork'));
  const options = { scope: 'crate-overlay-test', onUnpack: async () => { sends++; return hash; },
    unpackResults: { [hash]: results }, unpackErrors: {} };
  function Harness({ suspended = false }: { suspended?: boolean }) {
    presentation = useEthereumInventoryPresentation({ ...options, suspended });
    return createElement('main', null, createElement('p', null, 'Inventory remains'),
      createElement(EthereumInventoryOverlays, { presentation, suspended }));
  }
  const view = render(createElement(Harness));
  await act(async () => { presentation.openUnpack([item('111112', 'crate')]); });
  const button = view.getByRole('button', { name: 'Reveal crate 111112' });
  for (let hit = 0; hit < 3; hit++) fireEvent.click(button);
  await waitFor(() => assert.equal(sceneProps?.opening, true));
  assert.equal(sources.length, 20);
  assert.ok(sources.every(canvas => canvas.width > 0 && canvas.height > 0));
  return { ...view, get presentation() { return presentation; }, get sends() { return sends; },
    suspend(value: boolean) { view.rerender(createElement(Harness, { suspended: value })); } };
}

test('context loss during closing cannot mount previews from released source canvases', async () => {
  const view = await opening();
  act(() => sceneProps!.onComplete());
  assert.equal(view.presentation.overlay?.resultsVisible, true);
  const dialog = view.getByRole('dialog');
  act(() => view.presentation.close());
  assert.equal(view.presentation.overlay?.closing, true);
  assert.ok(sources.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.doesNotThrow(() => act(() => sceneProps!.onError(new Error('WebGL context lost'))));
  assert.ok(dialog.isConnected);
  assert.equal(dialog.querySelector('.crate-reveal__results'), null);
  await waitFor(() => assert.equal(view.presentation.overlay, null));
  assert.equal(dialog.isConnected, false);
  assert.ok(view.getByText('Inventory remains'));
});

for (const suspended of [false, true]) test(`context loss ${suspended ? 'while suspended' : 'while active'} preserves the prepared-preview fallback`, async () => {
  const view = await opening();
  const dialog = view.getByRole('dialog');
  if (suspended) view.suspend(true);
  act(() => sceneProps!.onError(new Error('WebGL context lost')));
  assert.ok(dialog.classList.contains('crate-reveal--fallback'));
  assert.equal(dialog.querySelectorAll('[data-reveal-item]').length, 20);
  assert.ok(sources.every(canvas => canvas.width > 0 && canvas.height > 0));
  assert.equal(view.presentation.overlay?.resultsVisible, false);
  if (suspended) view.suspend(false);
  await waitFor(() => assert.equal(view.presentation.overlay?.resultsVisible, true));
  assert.equal(view.sends, 1);
});
