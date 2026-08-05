import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  type Target,
} from 'mediabunny';
import {
  createRecordingFileStream,
  deliverRecordingBuffer,
  getRecordingBaseName,
  RECORDING_FRAME_RATE as FRAME_RATE,
  RECORDING_VIDEO_BITRATE as VIDEO_BITRATE,
  resolveRecordingEncoder,
  type RecordingOutputContainer,
} from './recordCardOutput';

const DEFAULT_OUTPUT_SIZE = {
  width: 1080,
  height: 1080,
} as const;
const CYCLE_DURATION_MS = 4_600;
const FLOAT_RADIUS_X = 22;
const FLOAT_RADIUS_Y = 16;
const DEFAULT_CARD_WIDTH_PX = 560;
const RELATIVE_CARD_WIDTH_RATIO_669 = 669.49 / 1600;
const RELATIVE_CARD_WIDTH_RATIO_551 = 551.72 / 1600;
const KEYFRAME_INTERVAL = FRAME_RATE;
const DEFAULT_RECORDING_BACKGROUND_COLOR = '#000';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const URL_RE = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;

type RenderPhase = 'preparing' | 'capturing' | 'encoding' | 'done';

export type RecordProgress = {
  phase: RenderPhase;
  current: number;
  total: number;
};

type CreateWritable = (name: string) => Promise<FileSystemWritableFileStream>;
type SaveBlob = (blob: Blob, name: string) => Promise<void> | void;

type OutputSize = {
  width: number;
  height: number;
};

type CardPosition = {
  x: number;
  y: number;
};

export type RecordCardOptions = {
  filename?: string;
  createWritable?: CreateWritable | null;
  saveBlob?: SaveBlob | null;
  resourceCache?: Map<string, string> | null;
  canvasBackground?: string | null;
  backgroundColor?: string | null;
  cardSize?: 'default' | 'ratio_669' | 'ratio_551' | 'custom';
  customCardWidth?: number;
  outputSize?: OutputSize;
  cardPosition?: CardPosition | null;
  requireMp4?: boolean;
  verticalOffset?: number;
  speed?: number;
};

type OutputTarget = {
  target: Target;
  finalize: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
};

let embeddedCssSnapshotPromise: Promise<{ embeddedCSS: string; rootVarsInline: string }> | null = null;
const recordingBackgroundPromises = new Map<string, Promise<string | null>>();
const dataUrlPendingPromises = new WeakMap<Map<string, string>, Map<string, Promise<string>>>();

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, precision = 3) {
  return Number(value.toFixed(precision));
}

function adjust(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
  return round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
}

function getCanvasColorSpace(): PredefinedColorSpace {
  if (!window.matchMedia('(color-gamut: p3)').matches) return 'srgb';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    if (ctx?.getContextAttributes().colorSpace === 'display-p3') return 'display-p3';
  } catch {}
  return 'srgb';
}

const CANVAS_COLOR_SPACE = getCanvasColorSpace();

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function normalizePlaybackSpeed(speed = 1) {
  const numeric = Number(speed);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return numeric;
}

function getTotalFrames(speed = 1) {
  return Math.max(1, Math.ceil((FRAME_RATE * CYCLE_DURATION_MS) / 1000 / normalizePlaybackSpeed(speed)));
}

function normalizeRelativeCardWidth(relativeWidth = RELATIVE_CARD_WIDTH_RATIO_669) {
  const numeric = Number(relativeWidth);
  if (!Number.isFinite(numeric) || numeric <= 0) return RELATIVE_CARD_WIDTH_RATIO_669;
  return numeric;
}

function normalizeOutputDimension(value: number | undefined, fallback: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function normalizeOutputSize(size?: OutputSize) {
  return {
    width: normalizeOutputDimension(size?.width, DEFAULT_OUTPUT_SIZE.width),
    height: normalizeOutputDimension(size?.height, DEFAULT_OUTPUT_SIZE.height),
  };
}

function normalizeRelativePosition(value: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(numeric, 0, 1);
}

function normalizeCardPosition(cardPosition?: CardPosition | null) {
  if (!cardPosition) return null;
  return {
    x: normalizeRelativePosition(cardPosition.x, 0.5),
    y: normalizeRelativePosition(cardPosition.y, 0.5),
  };
}

function normalizeRelativeVerticalOffset(relativeOffset = 0) {
  const numeric = Number(relativeOffset);
  if (!Number.isFinite(numeric)) return 0;
  return clamp(numeric, -1, 1);
}

function getCardWidthPx(
  outputSize: OutputSize,
  cardSize: RecordCardOptions['cardSize'] = 'default',
  customCardWidth = RELATIVE_CARD_WIDTH_RATIO_669,
) {
  if (cardSize === 'ratio_669') return outputSize.width * RELATIVE_CARD_WIDTH_RATIO_669;
  if (cardSize === 'ratio_551') return outputSize.width * RELATIVE_CARD_WIDTH_RATIO_551;
  if (cardSize === 'custom') return outputSize.width * normalizeRelativeCardWidth(customCardWidth);
  return DEFAULT_CARD_WIDTH_PX;
}

function getCardOffsetYPx(outputSize: OutputSize, relativeOffset = 0) {
  return outputSize.height * normalizeRelativeVerticalOffset(relativeOffset);
}

function getCardWrapperStyle(cardWidthPx: number, cardOffsetYPx: number, cardPosition?: CardPosition | null) {
  const x = cardPosition ? round(cardPosition.x * 100, 4) : 50;
  const y = cardPosition ? round(cardPosition.y * 100, 4) : 50;
  return [
    'position:absolute',
    `width:${round(cardWidthPx)}px`,
    `left:${x}%`,
    `top:calc(${y}% + ${round(cardOffsetYPx)}px)`,
    'transform:translate(-50%,-50%)',
  ].join(';');
}

async function createOutputTarget(
  outputName: string,
  {
    container,
    createWritable,
    saveBlob,
  }: {
    container: RecordingOutputContainer;
    createWritable?: CreateWritable | null;
    saveBlob?: SaveBlob | null;
  },
): Promise<OutputTarget> {
  const mimeType = container === 'mp4' ? 'video/mp4' : 'video/webm';

  if (typeof createWritable === 'function') {
    const writable = await createWritable(outputName);
    const fileStream = createRecordingFileStream(writable);
    return {
      target: new StreamTarget(fileStream.stream),
      finalize: fileStream.commit,
      abort: fileStream.abort,
    };
  }

  const target = new BufferTarget();
  return {
    target,
    async finalize() {
      await deliverRecordingBuffer(target.buffer, mimeType, outputName, saveBlob || null, downloadBlob);
    },
    async abort() {},
  };
}

function computeFrameOverrides(frameIndex: number, totalFrames: number) {
  const angle = (frameIndex / totalFrames) * Math.PI * 2;
  const px = 50 + Math.cos(angle) * FLOAT_RADIUS_X;
  const py = 50 + Math.sin(angle) * FLOAT_RADIUS_Y;
  const percentX = clamp(round(px));
  const percentY = clamp(round(py));
  const centerX = percentX - 50;
  const centerY = percentY - 50;
  const bgX = adjust(percentX, 0, 100, 37, 63);
  const bgY = adjust(percentY, 0, 100, 33, 67);
  const rotX = round(-(centerX / 3.5));
  const rotY = round(centerY / 2);
  const glareX = round(percentX);
  const glareY = round(percentY);
  const pointerFromCenter = clamp(Math.sqrt((glareY - 50) ** 2 + (glareX - 50) ** 2) / 50, 0, 1);

  return [
    `--pointer-x:${clamp(glareX)}%`,
    `--pointer-y:${clamp(glareY)}%`,
    `--pointer-from-center:${pointerFromCenter}`,
    `--pointer-from-top:${glareY / 100}`,
    `--pointer-from-left:${glareX / 100}`,
    '--card-opacity:1',
    `--rotate-x:${rotX}deg`,
    `--rotate-y:${rotY}deg`,
    `--background-x:${clamp(bgX)}%`,
    `--background-y:${clamp(bgY)}%`,
    '--rotate-delta:0deg',
    '--card-scale:1',
    '--translate-x:0px',
    '--translate-y:0px',
  ].join(';');
}

function extractStaticStyle(style: string) {
  const names = ['seedx', 'seedy', 'cosmosbg', 'birthdaybg', 'mask', 'foil'];
  const parts: string[] = [];

  for (const name of names) {
    const idx = style.indexOf(`--${name}:`);
    if (idx === -1) continue;

    let depth = 0;
    let end = idx;
    for (let i = idx; i < style.length; i += 1) {
      const ch = style[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ';' && depth === 0) {
        end = i + 1;
        break;
      }
      end = i + 1;
    }

    parts.push(style.slice(idx, end).trim().replace(/;?$/, ';'));
  }

  return parts.join(' ');
}

async function fetchAsDataUrl(absUrl: string) {
  const response = await fetch(absUrl);
  if (!response.ok) throw new Error(`Failed to load ${absUrl}: ${response.status}`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${absUrl}`));
    reader.readAsDataURL(blob);
  });
}

function getDataUrlPendingPromises(cache: Map<string, string>) {
  let pending = dataUrlPendingPromises.get(cache);
  if (!pending) {
    pending = new Map<string, Promise<string>>();
    dataUrlPendingPromises.set(cache, pending);
  }
  return pending;
}

async function fetchCachedDataUrl(absUrl: string, cache: Map<string, string>) {
  const cached = cache.get(absUrl);
  if (cached) return cached;

  const pending = getDataUrlPendingPromises(cache);
  let promise = pending.get(absUrl);
  if (!promise) {
    promise = fetchAsDataUrl(absUrl)
      .then((dataUrl) => {
        cache.set(absUrl, dataUrl);
        pending.delete(absUrl);
        return dataUrl;
      })
      .catch((error) => {
        pending.delete(absUrl);
        throw error;
      });
    pending.set(absUrl, promise);
  }
  return promise;
}

async function embedUrlsInText(text: string, cache: Map<string, string>, baseUrl = location.href) {
  const toFetch = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(URL_RE.source, 'g');
  while ((match = re.exec(text))) {
    const url = match[1];
    if (!url.startsWith('data:')) {
      const abs = new URL(url, baseUrl).href;
      if (!cache.has(abs)) toFetch.add(abs);
    }
  }

  await Promise.all(
    Array.from(toFetch).map(async (abs) => {
      try {
        await fetchCachedDataUrl(abs, cache);
      } catch (error) {
        console.warn('Failed to embed renderer resource:', abs, error);
      }
    }),
  );

  return text.replace(new RegExp(URL_RE.source, 'g'), (fullMatch, url: string) => {
    if (url.startsWith('data:')) return fullMatch;
    const abs = new URL(url, baseUrl).href;
    const dataUrl = cache.get(abs);
    return dataUrl ? `url("${dataUrl}")` : fullMatch;
  });
}

async function gatherAndEmbedCSS(cache: Map<string, string>) {
  let result = '';

  for (const sheet of Array.from(document.styleSheets)) {
    const base = sheet.href || location.href;
    let sheetText = '';

    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.IMPORT_RULE) continue;
        sheetText += `${rule.cssText}\n`;
      }
    } catch {
      if (sheet.href) {
        try {
          const response = await fetch(sheet.href);
          sheetText = await response.text();
        } catch {
          continue;
        }
      }
    }

    result += await embedUrlsInText(sheetText, cache, base);
  }

  return result;
}

function extractRootVarsFromCSS(css: string) {
  const rootBlockRe = /:root\s*\{([^}]+)\}/g;
  let vars = '';
  let match: RegExpExecArray | null;
  while ((match = rootBlockRe.exec(css))) {
    const propRe = /(--[\w-]+\s*:[^;]+;?)/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRe.exec(match[1]))) {
      vars += propMatch[1].endsWith(';') ? `${propMatch[1]} ` : `${propMatch[1]}; `;
    }
  }
  return vars.trim();
}

async function getEmbeddedCssSnapshot() {
  if (!embeddedCssSnapshotPromise) {
    embeddedCssSnapshotPromise = (async () => {
      const cache = new Map<string, string>();
      const embeddedCSS = await gatherAndEmbedCSS(cache);
      return {
        embeddedCSS,
        rootVarsInline: extractRootVarsFromCSS(embeddedCSS),
      };
    })();
  }

  try {
    return await embeddedCssSnapshotPromise;
  } catch (error) {
    embeddedCssSnapshotPromise = null;
    throw error;
  }
}

async function getRecordingBackgroundDataUrl(src?: string | null) {
  if (!src || src === 'none') return null;
  if (src.startsWith('data:')) return src;

  if (!recordingBackgroundPromises.has(src)) {
    recordingBackgroundPromises.set(
      src,
      fetchAsDataUrl(new URL(src, location.href).href).catch((error) => {
        console.warn('Failed to load recording background image:', error);
        recordingBackgroundPromises.delete(src);
        return null;
      }),
    );
  }

  return recordingBackgroundPromises.get(src)!;
}

async function embedImagesInElement(el: Element, cache: Map<string, string>) {
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    const abs = new URL(src, location.href).href;
    let dataUrl = cache.get(abs);
    if (!dataUrl) {
      try {
        dataUrl = await fetchCachedDataUrl(abs, cache);
      } catch (error) {
        console.warn('Failed to embed card image:', abs, error);
        continue;
      }
    }
    img.setAttribute('src', dataUrl);
  }
}

function createRecordingViewport(
  cardClone: Element,
  backgroundDataUrl: string | null,
  backgroundColor: string,
  outputSize: OutputSize,
  cardWidthPx: number,
  cardOffsetYPx = 0,
  cardPosition?: CardPosition | null,
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(1, (vw * 0.9) / outputSize.width, (vh * 0.82) / outputSize.height);

  const viewport = document.createElement('div');
  Object.assign(viewport.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '100000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.85)',
    pointerEvents: 'none',
  });

  const stage = document.createElement('div');
  Object.assign(stage.style, {
    width: `${outputSize.width}px`,
    height: `${outputSize.height}px`,
    backgroundColor,
    backgroundImage: backgroundDataUrl ? `url("${backgroundDataUrl}")` : 'none',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'cover',
    position: 'relative',
    overflow: 'hidden',
    transform: `scale(${scale})`,
    transformOrigin: 'center',
    borderRadius: '12px',
    boxShadow: '0 0 80px rgba(0,0,0,0.9)',
  });

  const wrapper = document.createElement('div');
  wrapper.setAttribute('style', getCardWrapperStyle(cardWidthPx, cardOffsetYPx, cardPosition));
  wrapper.appendChild(cardClone);
  stage.appendChild(wrapper);
  viewport.appendChild(stage);
  document.body.appendChild(viewport);

  return { viewport };
}

function buildSVGDocument(
  embeddedCSS: string,
  rootVarsInline: string,
  cardClone: Element,
  backgroundDataUrl: string | null,
  backgroundColor: string,
  outputSize: OutputSize,
  cardWidthPx: number,
  cardOffsetYPx = 0,
  cardPosition?: CardPosition | null,
) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(outputSize.width));
  svg.setAttribute('height', String(outputSize.height));
  svg.setAttribute('color-interpolation', 'sRGB');
  svg.setAttribute('color-interpolation-filters', 'sRGB');

  const foreignObject = document.createElementNS(SVG_NS, 'foreignObject');
  foreignObject.setAttribute('x', '0');
  foreignObject.setAttribute('y', '0');
  foreignObject.setAttribute('width', String(outputSize.width));
  foreignObject.setAttribute('height', String(outputSize.height));

  const container = document.createElementNS(XHTML_NS, 'div');
  container.setAttribute(
    'style',
    `width:${outputSize.width}px;height:${outputSize.height}px;background-color:${backgroundColor};` +
      (backgroundDataUrl
        ? `background-image:url("${backgroundDataUrl}");background-position:center;background-repeat:no-repeat;background-size:cover;`
        : '') +
      'position:relative;overflow:hidden;' +
      'color:white;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
      rootVarsInline,
  );

  const styleEl = document.createElementNS(XHTML_NS, 'style');
  styleEl.textContent = embeddedCSS;
  container.appendChild(styleEl);

  const wrapper = document.createElementNS(XHTML_NS, 'div');
  wrapper.setAttribute('style', getCardWrapperStyle(cardWidthPx, cardOffsetYPx, cardPosition));
  wrapper.appendChild(cardClone);
  container.appendChild(wrapper);

  foreignObject.appendChild(container);
  svg.appendChild(foreignObject);
  return svg;
}

async function svgToImage(svgElement: SVGSVGElement, outputSize: OutputSize): Promise<ImageBitmap | HTMLImageElement> {
  const svgString = new XMLSerializer().serializeToString(svgElement);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

  if (typeof createImageBitmap === 'function') {
    const timeout = Symbol('createImageBitmap timeout');
    let timedOut = false;
    const bitmapPromise = createImageBitmap(svgBlob)
      .then((bitmap) => {
        if (timedOut) {
          bitmap.close();
          return null;
        }
        return bitmap;
      })
      .catch(() => null);
    const result = await Promise.race<ImageBitmap | null | typeof timeout>([
      bitmapPromise,
      new Promise<typeof timeout>((resolve) =>
        window.setTimeout(() => {
          timedOut = true;
          resolve(timeout);
        }, 5_000),
      ),
    ]);
    if (result && result !== timeout) {
      return result;
    }
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Failed to serialize frame SVG'));
    reader.readAsDataURL(svgBlob);
  });

  const img = new Image(outputSize.width, outputSize.height);
  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error('Timed out decoding frame SVG')), 5_000);
    img.onload = () => {
      window.clearTimeout(timeoutId);
      resolve();
    };
    img.onerror = () => {
      window.clearTimeout(timeoutId);
      reject(new Error('Failed to decode frame SVG'));
    };
    img.src = dataUrl;
  }).finally(() => {
    img.onload = null;
    img.onerror = null;
  });
  return img;
}

function normalizeRecordOptions(options: RecordCardOptions = {}) {
  const outputSize = normalizeOutputSize(options.outputSize);
  return {
    filename: options.filename || null,
    saveBlob: options.saveBlob || null,
    createWritable: options.createWritable || null,
    resourceCache: options.resourceCache || null,
    canvasBackground: options.canvasBackground || null,
    backgroundColor: options.backgroundColor || DEFAULT_RECORDING_BACKGROUND_COLOR,
    cardSize: options.cardSize || 'default',
    customCardWidth: normalizeRelativeCardWidth(options.customCardWidth),
    outputSize,
    cardPosition: normalizeCardPosition(options.cardPosition),
    requireMp4: Boolean(options.requireMp4),
    verticalOffset: normalizeRelativeVerticalOffset(options.verticalOffset),
    speed: normalizePlaybackSpeed(options.speed),
  };
}

export async function recordCard(
  cardElement: HTMLElement,
  onProgress: (progress: RecordProgress) => void = () => {},
  options: RecordCardOptions = {},
) {
  if (!cardElement) throw new Error('No card element provided');

  const normalizedOptions = normalizeRecordOptions(options);
  const outputSize = normalizedOptions.outputSize;
  const encoderSupport = await resolveRecordingEncoder(outputSize, normalizedOptions.requireMp4);
  const outputContainer = encoderSupport.container;
  const outputBaseName = getRecordingBaseName(normalizedOptions.filename);
  const outputName = `${outputBaseName}.${outputContainer}`;
  const cardWidthPx = getCardWidthPx(outputSize, normalizedOptions.cardSize, normalizedOptions.customCardWidth);
  const cardOffsetYPx = getCardOffsetYPx(outputSize, normalizedOptions.verticalOffset);
  const totalFrames = getTotalFrames(normalizedOptions.speed);

  onProgress({ phase: 'preparing', current: 0, total: 0 });

  const { embeddedCSS, rootVarsInline } = await getEmbeddedCssSnapshot();
  const recordingBackgroundDataUrl = await getRecordingBackgroundDataUrl(normalizedOptions.canvasBackground);
  const cache = normalizedOptions.resourceCache || new Map<string, string>();

  const baseClone = cardElement.cloneNode(true) as HTMLElement;
  baseClone.classList.add('interacting');
  baseClone.classList.remove('loading', 'active', 'is-scaled');
  baseClone.querySelectorAll('img[loading="lazy"]').forEach((img) => img.removeAttribute('loading'));
  await embedImagesInElement(baseClone, cache);

  const origStyle = cardElement.getAttribute('style') || '';
  const embeddedOrigStyle = await embedUrlsInText(origStyle, cache);
  const staticStyle = extractStaticStyle(embeddedOrigStyle);
  const viewportClone = baseClone.cloneNode(true) as HTMLElement;
  const frameClone = baseClone.cloneNode(true) as HTMLElement;
  const svgDoc = buildSVGDocument(
    embeddedCSS,
    rootVarsInline,
    frameClone,
    recordingBackgroundDataUrl,
    normalizedOptions.backgroundColor,
    outputSize,
    cardWidthPx,
    cardOffsetYPx,
    normalizedOptions.cardPosition,
  );
  const { viewport } = createRecordingViewport(
    viewportClone,
    recordingBackgroundDataUrl,
    normalizedOptions.backgroundColor,
    outputSize,
    cardWidthPx,
    cardOffsetYPx,
    normalizedOptions.cardPosition,
  );

  let output: OutputTarget | null = null;
  let mediaOutput: Output | null = null;
  let finalized = false;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      colorSpace: CANVAS_COLOR_SPACE,
    });
    if (!ctx) throw new Error('Failed to create recording canvas');

    output = await createOutputTarget(outputName, {
      container: outputContainer,
      createWritable: normalizedOptions.createWritable,
      saveBlob: normalizedOptions.saveBlob,
    });
    const format = outputContainer === 'mp4'
      ? new Mp4OutputFormat({ fastStart: false })
      : new WebMOutputFormat();
    mediaOutput = new Output({
      format,
      target: output.target,
    });
    const videoSource = new CanvasSource(canvas, {
      codec: encoderSupport.codec,
      quality: new Quality({ bitrate: VIDEO_BITRATE }),
      keyFrameInterval: KEYFRAME_INTERVAL / FRAME_RATE,
      latencyMode: 'realtime',
      fullCodecString: encoderSupport.fullCodecString,
    });
    mediaOutput.addVideoTrack(videoSource, { frameRate: FRAME_RATE });
    await mediaOutput.start();

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    onProgress({ phase: 'capturing', current: 0, total: totalFrames });

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      frameClone.setAttribute('style', `${staticStyle};${computeFrameOverrides(frameIndex, totalFrames)}`);
      const renderedFrame = await svgToImage(svgDoc, outputSize);

      try {
        ctx.clearRect(0, 0, outputSize.width, outputSize.height);
        ctx.drawImage(renderedFrame, 0, 0, outputSize.width, outputSize.height);
      } finally {
        if ('close' in renderedFrame) renderedFrame.close();
      }

      await videoSource.add(frameIndex / FRAME_RATE, 1 / FRAME_RATE, {
        keyFrame: frameIndex === 0 || frameIndex % KEYFRAME_INTERVAL === 0,
      });
      onProgress({ phase: 'capturing', current: frameIndex + 1, total: totalFrames });
    }

    onProgress({ phase: 'encoding', current: 0, total: 1 });
    videoSource.close();
    await mediaOutput.finalize();
    await output.finalize();
    finalized = true;

    onProgress({ phase: 'encoding', current: 1, total: 1 });
    onProgress({ phase: 'done', current: 0, total: 0 });

    return {
      filename: outputName,
      container: outputContainer,
      frameCount: totalFrames,
      durationMs: CYCLE_DURATION_MS,
      frameRate: FRAME_RATE,
      size: outputSize.width,
      width: outputSize.width,
      height: outputSize.height,
    };
  } catch (error) {
    if (!finalized) {
      try {
        await mediaOutput?.cancel();
      } catch {}
      await output?.abort(error);
    }
    throw error;
  } finally {
    viewport.remove();
  }
}
