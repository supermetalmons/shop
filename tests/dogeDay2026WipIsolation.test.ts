import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { getDrifCardByFigureId } from '../src/drifCards.ts';
import { PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE } from '../src/lib/interactiveCardPackReveal.ts';
import { calcPonchoDrifellaRevealTargetRectInViewport, ponchoDrifellaRevealOverlayStyleVars } from '../src/lib/revealOverlayLayout.ts';
import { getDogeDay2026StarterCard } from '../src/dogeDay2026/starterCards.ts';
import { DOGE_DAY_2026_PACK_REVEAL_SEQUENCE } from '../src/dogeDay2026/revealSequence.ts';
import { DOGE_DAY_2026_WIP_CONFIG, DOGE_DAY_2026_WIP_SOUNDS } from '../src/dogeDay2026/starterConfig.ts';
import { calcDogeDay2026RevealTargetRectInViewport, dogeDay2026RevealOverlayStyleVars } from '../src/dogeDay2026/revealLayout.ts';

const scope = (value: string) => value
  .replaceAll('reveal-', 'doge-day-2026-reveal-')
  .replaceAll('wip-', 'doge-day-2026-wip-')
  .replaceAll('poncho-', 'doge-day-2026-');

test('Doge WIP starts with independent copies of all 207 Poncho cards', () => {
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.collectionName, 'Doge Day 2026');
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.cardCount, 207);
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.itemsPerPack, 1);
  for (let id = 1; id <= 207; id += 1) {
    const doge = getDogeDay2026StarterCard(id)!;
    const poncho = getDrifCardByFigureId(id)!;
    assert.deepEqual(doge, poncho);
    assert.notEqual(doge, poncho);
    assert.notEqual(doge.effect, poncho.effect);
  }
  for (const id of [0, -1, 208, NaN]) assert.equal(getDogeDay2026StarterCard(id), undefined);

  const doge = getDogeDay2026StarterCard(1)!;
  const poncho = getDrifCardByFigureId(1)!;
  const original = doge.effect.number;
  try {
    doge.effect.number = 'doge-independent-edit';
    assert.equal(poncho.effect.number, original);
  } finally {
    doge.effect.number = original;
  }
});

test('Doge frame sequences and sounds preserve the starting experience without shared mutable frame data', () => {
  const doge = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
  const poncho = PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE;
  assert.deepEqual(doge, poncho);
  assert.notEqual(doge, poncho);
  assert.notEqual(doge.revealFrameSequence, poncho.revealFrameSequence);
  assert.notEqual(doge.revealFrameSequence.frames, poncho.revealFrameSequence.frames);
  for (let variant = 0; variant < doge.punchFrameUrlsByVariant.length; variant += 1) {
    assert.notEqual(doge.punchFrameUrlsByVariant[variant], poncho.punchFrameUrlsByVariant[variant]);
  }
  assert.equal(DOGE_DAY_2026_WIP_SOUNDS.click.length, 3);
  assert.equal(DOGE_DAY_2026_WIP_SOUNDS.reveal, 'https://cdn.lil.org/nft/poncho_drifella/sounds/crash.mp3');
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.clickVolume, 0.42);
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.revealVolume, 0.3);
});

test('Doge layout preserves desktop, mobile and visual viewport positioning with its own variables', () => {
  for (const viewport of [
    { left: 0, top: 0, width: 1440, height: 900 },
    { left: 0, top: 0, width: 390, height: 844 },
    { left: 12, top: 48, width: 720, height: 340 },
  ]) {
    const targetRect = calcDogeDay2026RevealTargetRectInViewport(viewport);
    assert.deepEqual(targetRect, calcPonchoDrifellaRevealTargetRectInViewport(viewport));
    const options = { originRect: targetRect, targetRect, viewport, cardCount: 1 };
    const expected = Object.fromEntries(Object.entries(ponchoDrifellaRevealOverlayStyleVars(options))
      .map(([key, value]) => [scope(key), value]));
    assert.deepEqual(dogeDay2026RevealOverlayStyleVars(options), expected);
  }
});

test('Doge styles and source imports remain isolated from original Poncho page behavior', () => {
  const folder = new URL('../src/dogeDay2026/', import.meta.url);
  const css = readFileSync(new URL('wip.css', folder), 'utf8');
  for (const block of css.split('{').slice(0, -1)) {
    const selector = block.slice(block.lastIndexOf('}') + 1).trim();
    if (!selector || selector.startsWith('@') || /^(?:\d+%|from|to)(?:\s*,\s*\d+%)*$/.test(selector)) continue;
    for (const part of selector.split(',')) assert.match(part, /\.doge-day-2026-/, part);
  }
  for (const match of css.matchAll(/@keyframes\s+(\S+)/g)) assert.match(match[1], /^doge-day-2026-/);
  assert.doesNotMatch(css, /--(?:poncho|reveal|wip)-/);
  for (const filename of readdirSync(folder).filter(name => /\.tsx?$/.test(name))) {
    const source = readFileSync(new URL(filename, folder), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.\/(?:config\/|WipApp|components\/PonchoRevealOverlay|lib\/(?:dropContent|ponchoDrifellaReveal|interactiveCardPackReveal|revealOverlayLayout))/);
  }
});
