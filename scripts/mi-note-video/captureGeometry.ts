const physicalPixelTolerance = 0.075;
const maximumDenominator = 10_000;
const rationalTolerance = 1e-10;

type PixelRect = { x: number; y: number; width: number; height: number };

type LandscapeSnapshot = {
  nativePixels: boolean;
  rotationDegrees: number;
  background: string;
  shadowEnabled: boolean;
  captureScale: number;
  gutterPixels: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  stageDocumentPixels: PixelRect | null;
  rotatorRect: PixelRect | null;
  documentPixels: { width: number; height: number };
  effect?: { shadow?: string } | null;
};

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be finite, positive, and safely representable.`);
  }
  return value;
}

function integer(value: number, label: string, minimum = 0): number {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded < minimum || value < minimum
    || Math.abs(value - rounded) > physicalPixelTolerance) {
    throw new Error(`${label} is not aligned to an integer physical pixel: ${value}`);
  }
  return rounded;
}

function gcd(first: number, second: number): number {
  while (second !== 0) [first, second] = [second, first % second];
  return first;
}

function fraction(value: number, label: string): { numerator: number; denominator: number } {
  positive(value, label);
  for (let denominator = 1; denominator <= maximumDenominator; denominator += 1) {
    const numerator = Math.round(value * denominator);
    if (!Number.isSafeInteger(numerator) || numerator <= 0) continue;
    if (Math.abs(value - numerator / denominator) <= rationalTolerance) {
      const divisor = gcd(numerator, denominator);
      return { numerator: numerator / divisor, denominator: denominator / divisor };
    }
  }
  throw new Error(`${label} must have a rational representation with a denominator at most ${maximumDenominator}.`);
}

function lcm(first: number, second: number): number {
  const result = first / gcd(first, second) * second;
  if (!Number.isSafeInteger(result)) throw new Error('The native scroll quantum exceeds the safe integer range.');
  return result;
}

export function nativeScrollQuantum(captureScale: number, dpr: number): number {
  return lcm(fraction(captureScale, 'Capture scale').numerator, fraction(dpr, 'DPR').numerator);
}

export function unrotateSceneRect(rect: PixelRect, sceneSize: number, rotationDegrees: 0 | 90): PixelRect {
  positive(sceneSize, 'Scene size');
  if (Object.values(rect).some(value => !Number.isFinite(value)) || rect.width < 0 || rect.height < 0) {
    throw new Error('Scene rectangle must have finite coordinates and nonnegative dimensions.');
  }
  if (rotationDegrees === 0) return { ...rect };
  if (rotationDegrees !== 90) throw new Error('Capture rotation must be 0 or 90 degrees.');
  return { x: rect.y, y: sceneSize - rect.x - rect.width, width: rect.height, height: rect.width };
}

export function alignedDocumentExtent({ sceneSize, viewportSize, gutterPixels, dpr, captureScale }: {
  sceneSize: number;
  viewportSize: number;
  gutterPixels: number;
  dpr: number;
  captureScale: number;
}): number {
  positive(sceneSize, 'Scene size');
  const viewport = integer(viewportSize, 'CSS viewport size', 1);
  const gutter = integer(gutterPixels, 'Gutter');
  const scaleFraction = fraction(captureScale, 'Capture scale');
  const dprFraction = fraction(dpr, 'DPR');
  const scale = scaleFraction.numerator / scaleFraction.denominator;
  const pixelRatio = dprFraction.numerator / dprFraction.denominator;
  const nativeSize = integer(sceneSize * scale, 'Native scene size', 1);
  integer(viewport * pixelRatio, 'Physical viewport size', 1);
  const required = Math.ceil((nativeSize + gutter * 2) / pixelRatio);
  integer(required, 'CSS document size', 1);
  if (required <= viewport) return required;
  const cssQuantum = integer(lcm(scaleFraction.numerator, dprFraction.numerator) / pixelRatio, 'CSS scroll quantum', 1);
  const extent = viewport + Math.ceil((required - viewport) / cssQuantum) * cssQuantum;
  integer(extent, 'CSS document size', 1);
  integer(extent * pixelRatio, 'Physical document size', 1);
  return extent;
}

export function tileAxisPositions({ length, viewport, documentLength, gutterPixels, seamBandPixels, scrollQuantum }: {
  length: number;
  viewport: number;
  documentLength: number;
  gutterPixels: number;
  seamBandPixels: number;
  scrollQuantum: number;
}): number[] {
  const size = integer(length, 'Native scene size', 1);
  const viewportSize = integer(viewport, 'Physical viewport size', 1);
  const documentSize = integer(documentLength, 'Physical document size', 1);
  const gutter = integer(gutterPixels, 'Gutter');
  const band = integer(seamBandPixels, 'Seam band', 2);
  const quantum = integer(scrollQuantum, 'Physical scroll quantum', 1);
  if (band % 2 !== 0) throw new Error('The seam band must have an even pixel count.');
  const maxScroll = Math.max(0, documentSize - viewportSize);
  if (maxScroll % quantum !== 0) throw new Error('Maximum scroll is not aligned to the native raster phase.');
  for (let count = 1; count <= 16; count += 1) {
    if (size % count !== 0 || (count === 1 && maxScroll !== 0)) continue;
    const positions = count === 1 ? [0] : Array.from({ length: count }, (_, index) => (
      Math.round(index * (maxScroll / quantum) / (count - 1)) * quantum
    ));
    if (new Set(positions).size !== count) continue;
    const partition = size / count;
    const fits = positions.every((position, index) => {
      const origin = position - gutter;
      const start = index * partition - (index > 0 ? band / 2 : 0);
      const end = (index + 1) * partition + (index + 1 < count ? band / 2 : 0);
      return start - origin >= gutter && end - origin <= viewportSize - gutter;
    });
    if (fits) return positions;
  }
  throw new Error(`Viewport ${viewportSize} cannot cover ${size} pixels with guarded integer tile partitions.`);
}

export function chooseLandscapeViewport(snapshot: LandscapeSnapshot, viewport: { width: number; height: number }) {
  if (!snapshot.nativePixels || snapshot.rotationDegrees !== 90 || snapshot.background !== '#000000'
    || snapshot.shadowEnabled !== false || snapshot.gutterPixels !== 32
    || (snapshot.effect?.shadow !== undefined && snapshot.effect.shadow !== 'none')) {
    throw new Error('Landscape capture requires the rotated black native scene without a shadow and with 32-pixel guards.');
  }
  const stage = snapshot.stageDocumentPixels;
  const rect = snapshot.rotatorRect;
  if (!stage || !rect || Object.values(stage).some(value => !Number.isFinite(value))
    || Object.values(rect).some(value => !Number.isFinite(value)) || rect.width <= 0 || rect.height <= 0
    || !Number.isFinite(snapshot.scrollX) || !Number.isFinite(snapshot.scrollY)) {
    throw new Error('Landscape capture requires measured stage, card, and scroll geometry.');
  }
  const dpr = positive(snapshot.dpr, 'DPR');
  const quantum = nativeScrollQuantum(snapshot.captureScale, dpr);
  const size = integer(1080 * snapshot.captureScale, 'Native scene size', 1);
  const guard = snapshot.gutterPixels;
  const viewportWidth = integer(viewport.width, 'Physical viewport width', 1);
  const viewportHeight = integer(viewport.height, 'Physical viewport height', 1);
  if (Math.abs(stage.x - guard) > physicalPixelTolerance || Math.abs(stage.y - guard) > physicalPixelTolerance
    || Math.abs(stage.width - size) > physicalPixelTolerance || Math.abs(stage.height - size) > physicalPixelTolerance) {
    throw new Error('Landscape stage differs from its fixed native dimensions or gutter.');
  }
  if (size + 2 * guard > viewportWidth || viewportHeight <= 2 * guard) {
    throw new Error('Landscape viewport cannot cover the full canvas width inside its guards.');
  }
  integer(snapshot.documentPixels.width, 'Physical document width', 1);
  const documentHeight = integer(snapshot.documentPixels.height, 'Physical document height', 1);
  const maxScroll = Math.max(0, documentHeight - viewportHeight);
  if (maxScroll % quantum !== 0) throw new Error('Landscape maximum scroll is not aligned to the native raster phase.');
  const antialiasPixels = 2;
  const blackBorderPixels = 8;
  const x = (rect.x + snapshot.scrollX) * dpr - stage.x;
  const y = (rect.y + snapshot.scrollY) * dpr - stage.y;
  const protectedBounds = [
    Math.floor(x) - antialiasPixels, Math.floor(y) - antialiasPixels,
    Math.ceil(x + rect.width * dpr) + antialiasPixels, Math.ceil(y + rect.height * dpr) + antialiasPixels,
  ];
  if (protectedBounds[0] < 0 || protectedBounds[1] < 0 || protectedBounds[2] > size || protectedBounds[3] > size) {
    throw new Error('Landscape card exceeds the native canvas.');
  }
  const usableHeight = viewportHeight - 2 * guard;
  const desired = (protectedBounds[1] + protectedBounds[3] - usableHeight) / 2;
  const lowerStep = Math.max(0, Math.ceil((protectedBounds[3] + blackBorderPixels - usableHeight) / quantum));
  const upperStep = Math.min(maxScroll / quantum, Math.floor((protectedBounds[1] - blackBorderPixels) / quantum));
  const candidates = new Set([0, maxScroll, Math.ceil(Math.max(0, size - usableHeight) / quantum) * quantum]);
  if (lowerStep <= upperStep) candidates.add(Math.min(upperStep, Math.max(lowerStep, Math.round(desired / quantum))) * quantum);
  for (const scrollY of [...candidates].sort((first, second) => Math.abs(first - desired) - Math.abs(second - desired))) {
    if (scrollY < 0 || scrollY > maxScroll || scrollY % quantum !== 0) continue;
    const pasteBox = [0, Math.max(0, scrollY), size, Math.min(size, scrollY + usableHeight)];
    const topClearance = protectedBounds[1] - pasteBox[1];
    const bottomClearance = pasteBox[3] - protectedBounds[3];
    if (topClearance < (pasteBox[1] > 0 ? blackBorderPixels : 0)
      || bottomClearance < (pasteBox[3] < size ? blackBorderPixels : 0)) continue;
    return {
      scroll: { x: 0, y: scrollY }, protectedBounds, pasteBox, scrollQuantum: quantum,
      antialiasPixels, blackBorderPixels, clearance: { top: topClearance, bottom: bottomClearance },
    };
  }
  throw new Error('Landscape viewport cannot contain this pose with aligned pixels and exact-black join clearance.');
}
