import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveClearCardRenderSize,
  resolveClearCardRevealRenderQuality,
  shouldDeferClearCardRevealQualityRestore,
} from '../src/lib/clearCardCanvas.ts';

test('clear card reveal quality reduces only the break stage before restoring card detail', () => {
  assert.deepEqual(resolveClearCardRevealRenderQuality(false), {
    pack: {
      maxPixelRatio: 3,
      transmissionResolutionScale: 1,
    },
    breaking: {
      maxPixelRatio: 1.5,
      transmissionResolutionScale: 0.65,
    },
    revealed: {
      maxPixelRatio: 2,
      transmissionResolutionScale: 1,
    },
  });
  assert.equal(resolveClearCardRevealRenderQuality(true), undefined);
});

test('clear card reveal defers only the animated post-break quality restoration', () => {
  assert.equal(shouldDeferClearCardRevealQualityRestore('breaking', 'revealed'), true);
  assert.equal(shouldDeferClearCardRevealQualityRestore('pack', 'revealed'), false);
  assert.equal(shouldDeferClearCardRevealQualityRestore('revealed', 'pack'), false);
  assert.equal(shouldDeferClearCardRevealQualityRestore('pack', 'breaking'), false);
});

test('resolveClearCardRenderSize keeps canvases that fit within the viewport unchanged', () => {
  assert.deepEqual(resolveClearCardRenderSize(600, 800, 1200, 900), {
    width: 600,
    height: 800,
  });
});

test('resolveClearCardRenderSize caps oversized canvases without changing their aspect ratio', () => {
  assert.deepEqual(resolveClearCardRenderSize(1500, 900, 1000, 800), {
    width: 1000,
    height: 600,
  });
  assert.deepEqual(resolveClearCardRenderSize(900, 1500, 1000, 800), {
    width: 480,
    height: 800,
  });
});

test('resolveClearCardRenderSize keeps every dimension renderable', () => {
  assert.deepEqual(resolveClearCardRenderSize(0, 0, 0, 0), {
    width: 1,
    height: 1,
  });
});
