import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { mockMethod } from './helpers/mockMethod.ts';

const { dom } = setupFrontendDom();
const { cleanup, renderHook } = await import('@testing-library/react');
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
const { useSoundReadiness } = await import('../src/hooks/useSoundReadiness.ts');

beforeEach(() => {
  soundPlayer.isInitialized = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => cleanup());
after(() => dom.window.close());

test('sound readiness starts within the gesture and shares a pending initialization', async t => {
  const pending = Promise.withResolvers<void>();
  const initialize = mockMethod(t, soundPlayer, 'initializeOnUserInteraction', async force => {
    assert.equal(force, true);
    await pending.promise;
    soundPlayer.isInitialized = true;
  });
  const { result } = renderHook(useSoundReadiness);
  const first = result.current.ensureSoundReady();
  assert.equal(initialize.mock.callCount(), 1);
  assert.equal(result.current.ensureSoundReady(), first);
  assert.equal(result.current.soundInitPromiseRef.current, first);
  pending.resolve();
  await first;
  assert.equal(result.current.soundInitPromiseRef.current, null);
  assert.equal(soundPlayer.isInitialized, true);
});

test('failed optional initialization does not reject its consumer and can retry', async t => {
  let attempts = 0;
  mockMethod(t, soundPlayer, 'initializeOnUserInteraction', async () => {
    if (++attempts === 1) throw new Error('Audio is unavailable');
    soundPlayer.isInitialized = true;
  });
  const { result } = renderHook(useSoundReadiness);
  let continued = false;
  await assert.doesNotReject(result.current.ensureSoundReady().then(() => { continued = true; }));
  assert.equal(continued, true);
  assert.equal(result.current.soundInitPromiseRef.current, null);
  assert.equal(soundPlayer.isInitialized, false);
  await result.current.ensureSoundReady();
  assert.equal(attempts, 2);
  assert.equal(soundPlayer.isInitialized, true);
});

test('a hidden attempt that did not initialize audio can retry when visible', async t => {
  const initialize = mockMethod(t, soundPlayer, 'initializeOnUserInteraction', async () => {
    if (document.visibilityState === 'visible') soundPlayer.isInitialized = true;
  });
  const { result } = renderHook(useSoundReadiness);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await result.current.ensureSoundReady();
  assert.equal(soundPlayer.isInitialized, false);
  assert.equal(result.current.soundInitPromiseRef.current, null);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await result.current.ensureSoundReady();
  assert.equal(initialize.mock.callCount(), 2);
  assert.equal(soundPlayer.isInitialized, true);
});

test('already initialized audio does not start another initialization', async t => {
  soundPlayer.isInitialized = true;
  const initialize = mockMethod(t, soundPlayer, 'initializeOnUserInteraction', async () => {
    throw new Error('Unexpected initialization');
  });
  const { result } = renderHook(useSoundReadiness);
  await result.current.ensureSoundReady();
  assert.equal(initialize.mock.callCount(), 0);
  assert.equal(result.current.soundInitPromiseRef.current, null);
});

test('settlement of an invalidated attempt cannot clear its replacement', async t => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  let attempts = 0;
  mockMethod(t, soundPlayer, 'initializeOnUserInteraction', () => ++attempts === 1 ? first.promise : second.promise);
  const { result } = renderHook(useSoundReadiness);
  const oldAttempt = result.current.ensureSoundReady();
  result.current.soundInitPromiseRef.current = null;
  const replacement = result.current.ensureSoundReady();
  assert.notEqual(replacement, oldAttempt);
  first.resolve();
  await oldAttempt;
  assert.equal(result.current.soundInitPromiseRef.current, replacement);
  second.resolve();
  await replacement;
  assert.equal(result.current.soundInitPromiseRef.current, null);
  assert.equal(attempts, 2);
});
