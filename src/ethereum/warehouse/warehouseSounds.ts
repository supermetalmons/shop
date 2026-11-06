import { soundPlayer } from '../../lib/SoundPlayer';

const IMPACT = '/111k/sounds/ice-impact.wav';
const CRITICAL = '/111k/sounds/ice-critical.wav';
const preparations = new Map<string, Promise<void>>();
let initialization: Promise<void> | null = null;

function prepare(url: string): Promise<void> {
  const previous = preparations.get(url);
  if (previous) return previous;
  const pending = soundPlayer.preloadSound(url).catch(() => undefined);
  preparations.set(url, pending);
  void pending.then(() => { if (preparations.get(url) === pending) preparations.delete(url); });
  return pending;
}

export async function preloadWarehouseSounds(): Promise<void> {
  await Promise.all([prepare(IMPACT), prepare(CRITICAL)]);
}

export function unlockWarehouseSounds(): Promise<void> {
  if (initialization) return initialization;
  const pending = soundPlayer.initializeOnUserInteraction(true).catch(() => undefined);
  initialization = pending;
  void pending.then(() => {
    if (initialization === pending) initialization = null;
    void preloadWarehouseSounds();
  });
  return pending;
}

export async function playWarehouseImpactSound(critical: boolean, isActive: () => boolean): Promise<void> {
  const expiresAt = performance.now() + 180;
  const canPlay = () => isActive() && document.visibilityState === 'visible' && performance.now() <= expiresAt;
  if (!canPlay()) return;
  await initialization;
  if (!soundPlayer.isInitialized || !canPlay()) return;
  const url = critical ? CRITICAL : IMPACT;
  await prepare(url);
  if (canPlay()) await soundPlayer.playSound(url, critical ? 0.36 : 0.3, canPlay).catch(() => undefined);
}
