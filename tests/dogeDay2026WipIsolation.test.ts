import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { getDrifCardByFigureId } from '../src/drifCards.ts';
import { getDogeDay2026StarterCard } from '../src/dogeDay2026/starterCards.ts';
import { DOGE_DAY_2026_WIP_CONFIG, DOGE_DAY_2026_WIP_SOUNDS } from '../src/dogeDay2026/starterConfig.ts';

test('Doge WIP retains independent copies of all 207 Poncho cards', () => {
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.collectionName, 'Doge Day 2026');
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.cardCount, 207);
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.itemsPerPack, 2);
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

test('Doge WIP preserves its hit and reveal sounds', () => {
  assert.equal(DOGE_DAY_2026_WIP_SOUNDS.click.length, 3);
  assert.equal(DOGE_DAY_2026_WIP_SOUNDS.reveal, 'https://cdn.lil.org/nft/poncho_drifella/sounds/crash.mp3');
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.clickVolume, 0.42);
  assert.equal(DOGE_DAY_2026_WIP_CONFIG.revealVolume, 0.3);
});

test('Doge 3D unpacking no longer imports stop-frame loading or the DOM card renderer', () => {
  for (const filename of ['DogeDay2026WipApp.tsx', 'DogeDay2026RevealOverlay.tsx']) {
    const source = readFileSync(new URL(`../src/dogeDay2026/${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /revealPlayer|revealSequence|revealLayout|WipInteractiveCard|ImageCache|preloadDogeDay2026/);
  }
  const overlay = readFileSync(new URL('../src/dogeDay2026/DogeDay2026RevealOverlay.tsx', import.meta.url), 'utf8');
  assert.match(overlay, /createDogeFoilScene/);
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
