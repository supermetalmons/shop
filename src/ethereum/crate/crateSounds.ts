import { soundPlayer } from '../../lib/SoundPlayer';

const HITS = ['/111k/sounds/wood-hit-1.wav', '/111k/sounds/wood-hit-2.wav', '/111k/sounds/wood-hit-3.wav'];
const OPEN = '/111k/sounds/wood-open.wav';
const preparations = new Map<string, Promise<void>>();
let initialization: Promise<void> | null = null;

function prepare(url: string): Promise<void> {
  const previous = preparations.get(url);
  if (previous) return previous;
  const promise = soundPlayer.preloadSound(url).catch(() => undefined);
  preparations.set(url, promise);
  void promise.then(() => { if (preparations.get(url) === promise) preparations.delete(url); });
  return promise;
}

export async function preloadCrateSounds(): Promise<void> {
  await Promise.all([...HITS, OPEN].map(prepare));
}

async function play(url: string, volume: number, isActive: () => boolean, unlock: boolean): Promise<void> {
  const expiresAt = performance.now() + 250;
  const canPlay = () => isActive() && performance.now() <= expiresAt && document.visibilityState === 'visible';
  if (!canPlay()) return;
  if (unlock && !initialization) {
    const pending = soundPlayer.initializeOnUserInteraction(true).catch(() => undefined);
    initialization = pending;
    void pending.then(() => {
      if (initialization === pending) initialization = null;
      void preloadCrateSounds();
    });
  }
  await initialization;
  if (!soundPlayer.isInitialized || !canPlay()) return;
  await prepare(url);
  if (canPlay()) await soundPlayer.playSound(url, volume, canPlay).catch(() => undefined);
}

export function playCrateHitSound(hitNumber: number, isActive: () => boolean): Promise<void> {
  const index = Number.isFinite(hitNumber) ? Math.max(0, Math.floor(hitNumber) - 1) % HITS.length : 0;
  return play(HITS[index], 0.38, isActive, true);
}

export function playCrateOpenSound(isActive: () => boolean): Promise<void> {
  return play(OPEN, 0.32, isActive, false);
}
