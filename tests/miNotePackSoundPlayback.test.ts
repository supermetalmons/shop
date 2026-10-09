import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
let audibleStarts = 0;
class AudioContextMock {
  state = 'running';
  destination = {};
  sampleRate = 48000;
  addEventListener() {}
  async resume() { this.state = 'running'; }
  createBuffer() { return { duration: 1 / this.sampleRate }; }
  createBufferSource() {
    const source = {
      buffer: null as { duration: number } | null,
      connect() {},
      start() { if ((source.buffer?.duration ?? 0) > 0.001) audibleStarts += 1; },
    };
    return source;
  }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  async decodeAudioData() { return { duration: 1.4 }; }
}
Object.defineProperty(window, 'AudioContext', { configurable: true, value: AudioContextMock });
const { soundPlayer } = await import('../src/lib/SoundPlayer.ts');
const { unlockMiNotePackSounds, preloadMiNotePackSounds, playMiNotePackSound } = await import('../src/lib/miNotePackSounds.ts');

beforeEach(() => {
  audibleStarts = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
after(() => dom.window.close());

test('a Mi Note clip retried after a failed preload stays silent if its viewer closes', { timeout: 2000 }, async t => {
  const retryStarted = Promise.withResolvers<void>();
  const retryResponse = Promise.withResolvers<Response>();
  let targetFetches = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).endsWith('/folder_tap.mp3')) {
      if (++targetFetches === 1) return new Response('Temporary failure', { status: 503 });
      retryStarted.resolve();
      return retryResponse.promise;
    }
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const unlocking = unlockMiNotePackSounds();
  let viewerOpen = true;
  const playing = playMiNotePackSound('folderTap', () => viewerOpen);
  await retryStarted.promise;
  viewerOpen = false;
  retryResponse.resolve(new Response(new Uint8Array([1, 2, 3])));
  await Promise.all([unlocking, playing]);
  await preloadMiNotePackSounds();
  assert.equal(targetFetches, 2);
  assert.equal(audibleStarts, 0);
  viewerOpen = true;
  await playMiNotePackSound('folderTap', () => viewerOpen);
  assert.equal(audibleStarts, 1);
});

test('a clip stays silent if the tab becomes hidden while decoding', { timeout: 2000 }, async t => {
  const decoding = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<{ duration: number }>();
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
  t.mock.method(AudioContextMock.prototype, 'decodeAudioData', () => {
    decoding.resolve();
    return decoded.promise;
  });
  await soundPlayer.initializeOnUserInteraction(true);
  const playing = soundPlayer.playSound('https://example.com/late-decode.mp3', 0.42);
  await decoding.promise;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  decoded.resolve({ duration: 1.4 });
  await playing;
  assert.equal(audibleStarts, 0);
});
