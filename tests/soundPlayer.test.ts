import assert from 'node:assert/strict';
import test, { after, beforeEach, type TestContext } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
type DecodedBuffer = { duration: number };
type Gain = { gain: { value: number }; connect(): void };
let decodes: AudioContextMock[] = [];
let detachedDecodes = 0;
let starts: Array<{ context: AudioContextMock; volume: number }> = [];
let decode: () => Promise<DecodedBuffer> = async () => ({ duration: 1.4 });

class AudioContextMock {
  static instances: AudioContextMock[] = [];
  state: AudioContextState = 'running';
  destination = {};
  sampleRate = 48_000;
  constructor() { AudioContextMock.instances.push(this); }
  addEventListener() {}
  async resume() { this.state = 'running'; }
  createBuffer() { return { duration: 1 / this.sampleRate }; }
  createBufferSource() {
    let gain: Gain | undefined;
    const context = this;
    const source = {
      buffer: null as DecodedBuffer | null,
      connect(node: object) { if ('gain' in node) gain = node as Gain; },
      start() {
        if (context.state !== 'closed' && (source.buffer?.duration ?? 0) > 0.001) {
          starts.push({ context, volume: gain?.gain.value ?? 1 });
        }
      },
    };
    return source;
  }
  createGain(): Gain { return { gain: { value: 1 }, connect() {} }; }
  async decodeAudioData(data: ArrayBuffer) {
    decodes.push(this);
    if (!data.byteLength) {
      detachedDecodes++;
      throw new DOMException('Audio data is detached', 'DataCloneError');
    }
    structuredClone(data, { transfer: [data] });
    return decode();
  }
}

Object.defineProperty(window, 'AudioContext', { configurable: true, value: AudioContextMock });
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');

beforeEach(() => {
  for (const context of AudioContextMock.instances) context.state = 'closed';
  soundPlayer.isInitialized = false;
  decodes = [];
  detachedDecodes = 0;
  starts = [];
  decode = async () => ({ duration: 1.4 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
after(() => dom.window.close());

function soundUrl(t: TestContext): string { return `https://example.com/${encodeURIComponent(t.name)}.mp3`; }
function mockFetch(t: TestContext) {
  return t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
}
function holdDecode() {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<DecodedBuffer>();
  decode = () => { started.resolve(); return result.promise; };
  return { started: started.promise, finish: () => result.resolve({ duration: 1.4 }) };
}

test('concurrent plays share decoding without losing either requested clip', async t => {
  const fetch = mockFetch(t);
  await soundPlayer.initializeOnUserInteraction(true);
  const pending = holdDecode();
  const plays = [soundPlayer.playSound(soundUrl(t), 0.2), soundPlayer.playSound(soundUrl(t), 0.7)];
  await pending.started;
  pending.finish();
  await Promise.all(plays);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(decodes.length, 1);
  assert.equal(detachedDecodes, 0);
  assert.deepEqual(starts.map(start => start.volume), [0.2, 0.7]);
});

test('preloading and playback share a pending decode and the completed cache', async t => {
  const fetch = mockFetch(t);
  await soundPlayer.initializeOnUserInteraction(true);
  const pending = holdDecode();
  const preload = soundPlayer.preloadSound(soundUrl(t));
  await pending.started;
  const playing = soundPlayer.playSound(soundUrl(t), 0.42);
  pending.finish();
  await Promise.all([preload, playing]);
  await soundPlayer.playSound(soundUrl(t), 0.6);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(decodes.length, 1);
  assert.equal(detachedDecodes, 0);
  assert.deepEqual(starts.map(start => start.volume), [0.42, 0.6]);
});

test('raw preloads before unlock remain reusable by the first decode', async t => {
  const fetch = mockFetch(t);
  await Promise.all([soundPlayer.preloadSound(soundUrl(t)), soundPlayer.preloadSound(soundUrl(t))]);
  assert.equal(decodes.length, 0);
  assert.equal(fetch.mock.callCount(), 1);
  await soundPlayer.initializeOnUserInteraction(true);
  await soundPlayer.playSound(soundUrl(t));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(decodes.length, 1);
  assert.equal(starts.length, 1);
});

test('a failed raw fetch can retry after unlock', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? new Response('Unavailable', { status: 503 }) : new Response(new Uint8Array([1, 2, 3])));
  await assert.rejects(soundPlayer.preloadSound(soundUrl(t)), /Failed to fetch sound/);
  await soundPlayer.initializeOnUserInteraction(true);
  await soundPlayer.playSound(soundUrl(t));
  assert.equal(attempts, 2);
  assert.equal(decodes.length, 1);
  assert.equal(starts.length, 1);
});

test('a shared fetch failure does not block later decoding attempts', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? new Response('Unavailable', { status: 503 }) : new Response(new Uint8Array([1, 2, 3])));
  await soundPlayer.initializeOnUserInteraction(true);
  await Promise.all([soundPlayer.playSound(soundUrl(t)), soundPlayer.preloadSound(soundUrl(t))]);
  assert.equal(attempts, 1);
  assert.equal(decodes.length, 0);
  assert.equal(starts.length, 0);
  await soundPlayer.playSound(soundUrl(t));
  assert.equal(attempts, 2);
  assert.equal(decodes.length, 1);
  assert.equal(starts.length, 1);
});

test('a shared decoding failure is evicted so the next play can retry', async t => {
  const fetch = mockFetch(t);
  await soundPlayer.initializeOnUserInteraction(true);
  decode = async () => { throw new Error('Temporary decoder failure'); };
  await Promise.all([soundPlayer.playSound(soundUrl(t)), soundPlayer.preloadSound(soundUrl(t))]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(decodes.length, 1);
  assert.equal(starts.length, 0);
  decode = async () => ({ duration: 1.4 });
  await soundPlayer.playSound(soundUrl(t));
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(decodes.length, 2);
  assert.equal(detachedDecodes, 0);
  assert.equal(starts.length, 1);
});

test('activity guards remain independent when clips share decoding', async t => {
  mockFetch(t);
  await soundPlayer.initializeOnUserInteraction(true);
  const pending = holdDecode();
  let active = true;
  const expired = soundPlayer.playSound(soundUrl(t), 0.2, () => active);
  const live = soundPlayer.playSound(soundUrl(t), 0.7, () => true);
  await pending.started;
  active = false;
  pending.finish();
  await Promise.all([expired, live]);
  assert.equal(decodes.length, 1);
  assert.deepEqual(starts.map(start => start.volume), [0.7]);
});

test('a hidden tab suppresses every play waiting for shared decoding', async t => {
  mockFetch(t);
  await soundPlayer.initializeOnUserInteraction(true);
  const pending = holdDecode();
  const plays = [soundPlayer.playSound(soundUrl(t)), soundPlayer.playSound(soundUrl(t))];
  await pending.started;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  pending.finish();
  await Promise.all(plays);
  assert.equal(decodes.length, 1);
  assert.equal(starts.length, 0);
});

test('a context replacement during fetching does not redirect or duplicate pending decoding', async t => {
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { requested.resolve(); return response.promise; });
  await soundPlayer.initializeOnUserInteraction(true);
  const original = AudioContextMock.instances.at(-1);
  assert.ok(original);
  const first = soundPlayer.playSound(soundUrl(t));
  await requested.promise;
  original.state = 'closed';
  soundPlayer.isInitialized = false;
  await soundPlayer.initializeOnUserInteraction(true);
  const current = AudioContextMock.instances.at(-1);
  assert.ok(current && current !== original);
  const second = soundPlayer.playSound(soundUrl(t));
  response.resolve(new Response(new Uint8Array([1, 2, 3])));
  await Promise.all([first, second]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(decodes, [original]);
  assert.equal(detachedDecodes, 0);
  assert.deepEqual(starts.map(start => start.context), [current]);
});
