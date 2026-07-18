import type { DropRevealFrameSourceSequence } from '../config/dropsExtraContent';

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinBaseAndPath(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
}

function clampFrameIndex(frameSequence: DropRevealFrameSourceSequence, frameIndex: number): number {
  const normalizedFrameIndex = Math.floor(Number(frameIndex));
  if (!Number.isFinite(normalizedFrameIndex)) return 1;
  return Math.min(Math.max(normalizedFrameIndex, 1), frameSequence.frameCount);
}

export function resolveRevealFrameSrc(
  frameSequence: DropRevealFrameSourceSequence | undefined,
  frameIndex: number,
): string | undefined {
  if (!frameSequence) return undefined;
  const safeFrameIndex = clampFrameIndex(frameSequence, frameIndex);
  if (frameSequence.frames?.length) {
    return frameSequence.frames[safeFrameIndex - 1];
  }
  if (!frameSequence.baseUrl || !frameSequence.ext) return undefined;
  return joinBaseAndPath(frameSequence.baseUrl, `${safeFrameIndex}.${frameSequence.ext}`);
}

function preloadRevealFrameSrc(
  frameSrc: string | undefined,
  loadedFrames: Set<string>,
  pendingFrames: Map<string, HTMLImageElement>,
  fetchPriority: 'high' | 'low' | 'auto' = 'auto',
) {
  const normalizedFrameSrc = String(frameSrc || '').trim();
  if (!normalizedFrameSrc) return;
  if (loadedFrames.has(normalizedFrameSrc)) {
    const pendingImage = pendingFrames.get(normalizedFrameSrc);
    if (pendingImage && fetchPriority === 'high') {
      pendingImage.fetchPriority = 'high';
    }
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  img.fetchPriority = fetchPriority;
  img.onload = () => {
    pendingFrames.delete(normalizedFrameSrc);
  };
  img.onerror = () => {
    pendingFrames.delete(normalizedFrameSrc);
    loadedFrames.delete(normalizedFrameSrc);
  };
  pendingFrames.set(normalizedFrameSrc, img);
  loadedFrames.add(normalizedFrameSrc);
  img.src = normalizedFrameSrc;
}

export function preloadRevealFrames(
  frameSequence: DropRevealFrameSourceSequence | undefined,
  loadedFrames: Set<string>,
  pendingFrames: Map<string, HTMLImageElement>,
  fromFrame = 1,
  toFrame = frameSequence?.frameCount ?? 0,
  fetchPriority: 'high' | 'low' | 'auto' = 'auto',
) {
  if (!frameSequence) return;
  const safeFrom = Math.max(1, Math.floor(Number(fromFrame) || 1));
  const safeTo = Math.min(frameSequence.frameCount, Math.floor(Number(toFrame) || frameSequence.frameCount));
  for (let frameIndex = safeFrom; frameIndex <= safeTo; frameIndex += 1) {
    preloadRevealFrameSrc(resolveRevealFrameSrc(frameSequence, frameIndex), loadedFrames, pendingFrames, fetchPriority);
  }
}
