import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBackgroundPresentation } from '../native-config.mjs';

test('background capture rejects missing diagnostics, focus, activation, or display intersection', () => {
  const state = { mode: 'offscreen', appActive: false, windowKey: false, windowMain: false, intersectsScreen: false };
  assertBackgroundPresentation(state);
  assert.throws(() => assertBackgroundPresentation(undefined), /must remain offscreen/);
  assert.throws(() => assertBackgroundPresentation({ ...state, mode: 'foreground' }), /must remain offscreen/);
  for (const name of ['appActive', 'windowKey', 'windowMain', 'intersectsScreen']) {
    assert.throws(() => assertBackgroundPresentation({ ...state, [name]: true }), /must remain offscreen/);
    assert.throws(() => assertBackgroundPresentation({ ...state, [name]: undefined }), /must remain offscreen/);
  }
});
