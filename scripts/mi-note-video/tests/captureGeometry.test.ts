import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignedDocumentExtent,
  chooseLandscapeViewport,
  nativeScrollQuantum,
  tileAxisPositions,
  unrotateSceneRect,
} from '../captureGeometry.ts';

const standardExtent = { sceneSize: 1080, viewportSize: 918, gutterPixels: 32, dpr: 2 };
const standardTiles = { length: 2430, viewport: 1836, documentLength: 2502, gutterPixels: 32, seamBandPixels: 128, scrollQuantum: 18 };

function landscapeSnapshot() {
  return {
    nativePixels: true, rotationDegrees: 90, background: '#000000', shadowEnabled: false,
    captureScale: 2.75, gutterPixels: 32, dpr: 2, scrollX: 0, scrollY: 0,
    stageDocumentPixels: { x: 32, y: 32, width: 2970, height: 2970 },
    rotatorRect: { x: 133.77197265625, y: 317.98563385009766, width: 1142.2149505615234, height: 888.6176681518555 },
    documentPixels: { width: 3328, height: 3050 }, effect: { shadow: 'none' },
  };
}

const landscapeViewport = { width: 3328, height: 1884 };

test('scroll quanta preserve physical, CSS, and scene pixel phases at supported scales and DPRs', () => {
  for (const [scale, dpr, expected] of [[1.5, 2, 6], [2.25, 2, 18], [3, 2, 6], [2.25, 1.5, 9]]) {
    const quantum = nativeScrollQuantum(scale, dpr);
    assert.equal(quantum, expected);
    assert.ok(Number.isInteger(quantum / dpr));
    assert.ok(Number.isInteger(quantum / scale));
  }
  assert.equal(nativeScrollQuantum(2.2500000000000004, 2), 18);
});

test('2430 native pixels receive integer CSS padding and a shared phase at both vertical tiles', () => {
  const extent = alignedDocumentExtent({ ...standardExtent, captureScale: 2.25 });
  assert.equal(extent, 1251);
  assert.equal(extent * 2, 2502);
  assert.deepEqual(tileAxisPositions({ ...standardTiles, documentLength: extent * 2 }), [0, 666]);
  assert.equal(666 / 2, 333);
  assert.equal(666 / 2.25, 296);
  assert.equal((2430 / 2) * (1620 / 2430), 810);
});

test('the established 3240 capture retains its document extent and tile positions', () => {
  const extent = alignedDocumentExtent({ ...standardExtent, captureScale: 3 });
  assert.equal(extent, 1653);
  assert.deepEqual(tileAxisPositions({ ...standardTiles, length: 3240, documentLength: extent * 2, scrollQuantum: 6 }), [0, 1470]);
});

test('an axis that fits keeps the required document extent and needs only one tile', () => {
  assert.equal(alignedDocumentExtent({ ...standardExtent, captureScale: 1.5 }), 842);
  assert.equal(alignedDocumentExtent({ ...standardExtent, viewportSize: 1664, captureScale: 2.25 }), 1247);
  assert.deepEqual(tileAxisPositions({ ...standardTiles, length: 1620, documentLength: 1836, scrollQuantum: 6 }), [0]);
});

test('three tiles quantize the interior scroll while preserving guarded seam coverage', () => {
  const extent = alignedDocumentExtent({ ...standardExtent, viewportSize: 554, captureScale: 2.25 });
  assert.equal(extent, 1247);
  const positions = tileAxisPositions({ ...standardTiles, viewport: 1108, documentLength: extent * 2 });
  assert.deepEqual(positions, [0, 702, 1386]);
  assert.ok(positions.every(position => Number.isInteger(position / 18)));
  assert.notEqual(positions[1], positions[2] / 2);
  for (const [index, seam] of [810, 1620].entries()) {
    const leftOrigin = positions[index] - 32;
    const rightOrigin = positions[index + 1] - 32;
    assert.ok(seam - 64 >= rightOrigin + 32);
    assert.ok(seam + 64 <= leftOrigin + 1108 - 32);
  }
});

test('fractional DPR uses an integer CSS extent and integer physical scroll', () => {
  const extent = alignedDocumentExtent({ ...standardExtent, dpr: 1.5, captureScale: 2.25 });
  assert.equal(extent, 1668);
  assert.equal((extent - 918) * 1.5, 1125);
  assert.equal(1125 % nativeScrollQuantum(2.25, 1.5), 0);
});

test('unsafe scales, fractional pixels, and phase mismatches are rejected', () => {
  for (const value of [0, -1, NaN, Infinity, Math.PI, 1 / 10001]) {
    assert.throws(() => nativeScrollQuantum(value, 2));
    assert.throws(() => nativeScrollQuantum(2.25, value));
  }
  assert.throws(() => alignedDocumentExtent({ ...standardExtent, sceneSize: 1, captureScale: 2.25 }), /integer physical pixel/);
  assert.throws(() => alignedDocumentExtent({ ...standardExtent, viewportSize: 0, captureScale: 2.25 }));
  assert.throws(() => tileAxisPositions({ ...standardTiles, documentLength: 2498 }), /raster phase/);
  assert.throws(() => tileAxisPositions({ ...standardTiles, viewport: 1836.5 }), /integer physical pixel/);
  assert.throws(() => tileAxisPositions({ ...standardTiles, seamBandPixels: 127 }), /even/);
});

test('physical pixel measurement noise is tolerated without accepting fractional geometry', () => {
  assert.deepEqual(tileAxisPositions({ ...standardTiles, length: 2430.01, viewport: 1835.99, documentLength: 2502.01 }), [0, 666]);
  assert.throws(() => tileAxisPositions({ ...standardTiles, length: 2430.08 }), /integer physical pixel/);
});

test('a viewport too small for guarded seam bands is rejected', () => {
  assert.throws(() => tileAxisPositions({ ...standardTiles, viewport: 160, documentLength: 2500 }), /cannot cover/);
});

test('quarter-turn scene rectangles recover their upright native geometry', () => {
  const rotated = { x: 200, y: 300, width: 1000, height: 600 };
  assert.deepEqual(unrotateSceneRect(rotated, 2970, 90), { x: 300, y: 1770, width: 600, height: 1000 });
  assert.deepEqual(unrotateSceneRect(rotated, 2970, 0), rotated);
  assert.throws(() => unrotateSceneRect({ ...rotated, width: -1 }, 2970, 90), /nonnegative/);
});

test('1980 delivery aligns its native 2970 scene to the 22-pixel raster phase', () => {
  assert.equal(nativeScrollQuantum(2.75, 2), 22);
  assert.equal(alignedDocumentExtent({ ...standardExtent, viewportSize: 942, captureScale: 2.75 }), 1525);
  const choice = chooseLandscapeViewport(landscapeSnapshot(), landscapeViewport);
  assert.deepEqual(choice.scroll, { x: 0, y: 572 });
  assert.deepEqual(choice.protectedBounds, [233, 601, 2522, 2384]);
  assert.deepEqual(choice.pasteBox, [0, 572, 2970, 2392]);
  assert.deepEqual(choice.clearance, { top: 29, bottom: 8 });
  assert.equal(choice.antialiasPixels, 2);
  assert.equal(choice.blackBorderPixels, 8);
  assert.equal(choice.scrollQuantum, 22);
});

test('landscape framing is invariant to the viewport scroll used for measuring the pose', () => {
  const atOrigin = landscapeSnapshot();
  const scrolled = landscapeSnapshot();
  scrolled.scrollY = 286;
  scrolled.rotatorRect.y -= 286;
  assert.deepEqual(chooseLandscapeViewport(scrolled, landscapeViewport), chooseLandscapeViewport(atOrigin, landscapeViewport));
});

test('a taller 2000 delivery is rejected when its 50-pixel phase cannot preserve black join strips', () => {
  const snapshot = landscapeSnapshot();
  const scale = 3000 / 2160;
  snapshot.captureScale = 3000 / 1080;
  snapshot.stageDocumentPixels = { x: 32, y: 32, width: 3000, height: 3000 };
  snapshot.documentPixels.height = 3084;
  snapshot.rotatorRect = {
    x: ((2160 - 328.5166015625 - 1659.3564453125) * scale + 32) / 2,
    y: (438.33868408203125 * scale + 32) / 2,
    width: 1659.3564453125 * scale / 2, height: 1293.246337890625 * scale / 2,
  };
  assert.equal(nativeScrollQuantum(snapshot.captureScale, 2), 50);
  assert.throws(() => chooseLandscapeViewport(snapshot, landscapeViewport), /exact-black join clearance/);
});

test('landscape viewport selection rejects incompatible scene settings and unaligned documents', () => {
  for (const patch of [
    { rotationDegrees: 0 }, { background: '#ffffff' }, { shadowEnabled: true }, { nativePixels: false },
    { gutterPixels: 4 }, { effect: { shadow: '0 1px 3px black' } },
  ]) {
    assert.throws(() => chooseLandscapeViewport({ ...landscapeSnapshot(), ...patch }, landscapeViewport), /rotated black native scene/);
  }
  const snapshot = landscapeSnapshot();
  snapshot.documentPixels.height += 2;
  assert.throws(() => chooseLandscapeViewport(snapshot, landscapeViewport), /raster phase/);
  assert.throws(() => chooseLandscapeViewport(landscapeSnapshot(), { width: 3020, height: 1884 }), /full canvas width/);
  assert.throws(() => chooseLandscapeViewport(landscapeSnapshot(), { width: 3328, height: 1884.5 }), /integer physical pixel/);
});

test('landscape protection includes the antialiasing margin at canvas edges', () => {
  const snapshot = landscapeSnapshot();
  snapshot.rotatorRect.x = 16.5;
  assert.throws(() => chooseLandscapeViewport(snapshot, landscapeViewport), /exceeds the native canvas/);
});
