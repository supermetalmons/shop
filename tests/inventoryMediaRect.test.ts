import assert from 'node:assert/strict';
import test, { after, afterEach, type TestContext } from 'node:test';
import { getInventoryRevealRect } from '../src/lib/inventoryMediaRect.ts';
import {
  calcContainedMediaRevealOriginRect,
  revealOverlayStyleVars,
} from '../src/lib/revealOverlayLayout.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: dom.window.DOMRect });
const reset = document.createElement('style');
reset.textContent = '* { padding: 0; border: 0; }';
document.head.append(reset);
afterEach(() => document.body.replaceChildren());
after(() => dom.window.close());

type Rect = { left: number; top: number; width: number; height: number };

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: expected ${expected}, received ${actual}`);
}

function equalRect(actual: Rect, expected: Rect) {
  for (const key of ['left', 'top', 'width', 'height'] as const) close(actual[key], expected[key], key);
}

function dimensions(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
}

function bounds(t: TestContext, element: Element, rect: Rect) {
  t.mock.method(element, 'getBoundingClientRect', () => new DOMRect(rect.left, rect.top, rect.width, rect.height));
}

function imageTile(t: TestContext, width: number, height: number, rect: Rect) {
  const tile = document.createElement('div');
  tile.className = 'figure-tile shipment-item-tile';
  tile.innerHTML = '<img class="figure-image" style="object-fit: contain" alt="Drop preview">';
  document.body.append(tile);
  const image = tile.querySelector('img')!;
  dimensions(image, width, height);
  bounds(t, tile, { left: rect.left - 10, top: rect.top - 20, width: rect.width + 20, height: rect.height + 40 });
  bounds(t, image, rect);
  return { tile, image };
}

const drops = [
  { name: 'shirt', width: 1585, height: 1242 },
  { name: 'hoodie', width: 1445, height: 877 },
  { name: 'future landscape drop', width: 2100, height: 700 },
  { name: 'future portrait drop', width: 600, height: 1600 },
] as const;

for (const drop of drops) {
  test(`${drop.name} measures the contained shipment image instead of its square frame`, (t) => {
    const source = { left: 47, top: 109, width: 180, height: 180 };
    const { tile } = imageTile(t, drop.width, drop.height, source);
    const pixelScale = 180 / Math.max(drop.width, drop.height);
    const width = drop.width * pixelScale;
    const height = drop.height * pixelScale;
    equalRect(getInventoryRevealRect(tile), {
      left: source.left + (180 - width) / 2,
      top: source.top + (180 - height) / 2,
      width,
      height,
    });
  });
}

test('padded figure images exclude asymmetric padding and borders from the transition bounds', (t) => {
  const { tile, image } = imageTile(t, 600, 300, { left: 100, top: 200, width: 210, height: 180 });
  image.style.padding = '6px 12px 10px 8px';
  image.style.border = '2px solid black';
  equalRect(getInventoryRevealRect(tile), { left: 110, top: 241.5, width: 186, height: 93 });
});

test('contained background previews use the hidden sizing image without measuring its hidden box', (t) => {
  const tile = document.createElement('article');
  tile.innerHTML = '<div class="inventory__media"><img hidden alt=""><div class="inventory__image" style="background-size: contain"></div></div>';
  document.body.append(tile);
  const image = tile.querySelector('img')!;
  const background = tile.querySelector<HTMLElement>('.inventory__image')!;
  dimensions(image, 500, 700);
  bounds(t, image, { left: 0, top: 0, width: 0, height: 0 });
  bounds(t, background, { left: 25, top: 35, width: 210, height: 210 });
  equalRect(getInventoryRevealRect(tile), { left: 55, top: 35, width: 150, height: 210 });
});

test('cover backgrounds preserve their cropped display box', (t) => {
  const tile = document.createElement('article');
  tile.innerHTML = '<div class="inventory__media"><img hidden alt=""><div class="inventory__image" style="background-size: cover"></div></div>';
  document.body.append(tile);
  dimensions(tile.querySelector('img')!, 1600, 900);
  const source = { left: 18, top: 29, width: 150, height: 210 };
  bounds(t, tile.querySelector('.inventory__image')!, source);
  equalRect(getInventoryRevealRect(tile), source);
});

test('nested video posters measure their contained image inside the stack', (t) => {
  const tile = document.createElement('article');
  tile.innerHTML = '<div class="inventory__media"><div class="inventory__video-stack"><img class="inventory__video-poster" style="object-fit: contain" alt=""><video hidden></video></div></div>';
  document.body.append(tile);
  dimensions(tile.querySelector('img')!, 1920, 1080);
  bounds(t, tile.querySelector('.inventory__video-stack')!, { left: 40, top: 60, width: 180, height: 220 });
  equalRect(getInventoryRevealRect(tile), { left: 40, top: 119.375, width: 180, height: 101.25 });
});

for (const drop of drops) {
  test(`${drop.name} opening and return transforms project the viewer image onto the measured source`, (t) => {
    const sourceFrame = { left: 37.25, top: 128.5, width: 183, height: 171 };
    const { tile } = imageTile(t, drop.width, drop.height, sourceFrame);
    const source = getInventoryRevealRect(tile);
    const sourcePixelScale = Math.min(sourceFrame.width / drop.width, sourceFrame.height / drop.height);
    const sourceMedia = {
      left: sourceFrame.left + (sourceFrame.width - drop.width * sourcePixelScale) / 2,
      top: sourceFrame.top + (sourceFrame.height - drop.height * sourcePixelScale) / 2,
      width: drop.width * sourcePixelScale,
      height: drop.height * sourcePixelScale,
    };
    for (const target of [
      { left: 81, top: 96, width: 357, height: 491 },
      { left: 315, top: 42, width: 633, height: 307 },
    ]) {
      const origin = calcContainedMediaRevealOriginRect(source, target, drop.width / drop.height);
      const style = revealOverlayStyleVars({ originRect: origin, targetRect: target });
      const scaleX = Number(style['--reveal-start-scale-x']);
      const scaleY = Number(style['--reveal-start-scale-y']);
      close(scaleX, scaleY, 'uniform image scale');
      const targetPixelScale = Math.min(target.width / drop.width, target.height / drop.height);
      const width = drop.width * targetPixelScale;
      const height = drop.height * targetPixelScale;
      const localLeft = (target.width - width) / 2;
      const localTop = (target.height - height) / 2;
      const sourceEndpoint = {
        left: target.left + parseFloat(style['--reveal-start-x']!) + localLeft * scaleX,
        top: target.top + parseFloat(style['--reveal-start-y']!) + localTop * scaleY,
        width: width * scaleX,
        height: height * scaleY,
      };
      equalRect(sourceEndpoint, sourceMedia);
      const targetEndpoint = { left: target.left + localLeft, top: target.top + localTop, width, height };
      const targetCenter = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
      close(targetEndpoint.left + targetEndpoint.width / 2, targetCenter.x, 'expanded image center x');
      close(targetEndpoint.top + targetEndpoint.height / 2, targetCenter.y, 'expanded image center y');
      assert.ok(targetEndpoint.width <= target.width && targetEndpoint.height <= target.height);
    }
  });
}
