import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverNativeCapture } from '../captureRecovery.mjs';

test('pixel and screenshot recovery cannot remount after any native frame is committed', async () => {
  for (const committedFrames of [1, 20, 165, 276]) {
    for (const reason of ['Tile overlap/seam QA failed', 'Static exterior QA failed', 'Rejected native PNG header']) {
      const cause = new Error(reason);
      let remounted = false;
      await assert.rejects(recoverNativeCapture({ id: 166, committedFrames, cause }, () => { remounted = true; }), error => {
        assert.match(error.message, /^Native rest reference mismatch:/);
        assert.match(error.message, new RegExp(`retaining ${committedFrames} native frames`));
        assert.equal(error.cause, cause);
        return true;
      });
      assert.equal(remounted, false);
    }
  }
});

test('an initial capture can remount within its retry limit before establishing rest proofs', async () => {
  const stages = [];
  const cause = new Error('Tile overlap/seam QA failed');
  const result = await recoverNativeCapture({ id: 166, committedFrames: 0, cause }, async () => {
    stages.push('remount');
    return { cardId: 166, frame: 0 };
  });
  assert.deepEqual(result, { cardId: 166, frame: 0 });
  assert.deepEqual(stages, ['remount']);
  await assert.rejects(recoverNativeCapture({ id: 166, committedFrames: 0, cause, retryAllowed: false }, () => {
    stages.push('unexpected-remount');
  }), error => error === cause);
  assert.deepEqual(stages, ['remount']);
});

test('committed-frame recovery always requires rest verification even at the inline retry limit', async () => {
  const cause = new Error('Tile overlap/seam QA failed');
  await assert.rejects(recoverNativeCapture({ id: 166, committedFrames: 165, cause, retryAllowed: false }, () => {
    assert.fail('Committed capture must not remount inline');
  }), error => /^Native rest reference mismatch:/.test(error.message) && error.cause === cause);
});

test('invalid checkpoint counts fail before attempting a remount', async () => {
  for (const committedFrames of [undefined, null, -1, 0.5, Infinity]) {
    await assert.rejects(recoverNativeCapture({ id: 166, committedFrames, cause: new Error('Rejected capture') }, () => {
      assert.fail('Unverified checkpoint counts must not permit a remount');
    }), /Invalid committed native frame count/);
  }
});
