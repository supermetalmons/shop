/// <reference types="dom-webcodecs" />
/// <reference types="wicg-file-system-access" />

import {
  ArrayBufferTarget as Mp4ArrayBufferTarget,
  FileSystemWritableFileStreamTarget as Mp4FileSystemWritableFileStreamTarget,
  Muxer as Mp4Muxer,
} from 'mp4-muxer';
import {
  ArrayBufferTarget as WebMArrayBufferTarget,
  FileSystemWritableFileStreamTarget as WebMFileSystemWritableFileStreamTarget,
  Muxer as WebMMuxer,
} from 'webm-muxer';

const VIDEO_SIZE = 1080;
const FRAME_RATE = 60;
const CYCLE_DURATION_MS = 4_600;
const FLOAT_RADIUS_X = 22;
const FLOAT_RADIUS_Y = 16;
const DEFAULT_CARD_WIDTH_PX = 560;
const RELATIVE_CARD_WIDTH_RATIO_669 = 669.49 / 1600;
const RELATIVE_CARD_WIDTH_RATIO_551 = 551.72 / 1600;
const VIDEO_BITRATE = 20_000_000;
const KEYFRAME_INTERVAL = FRAME_RATE;
const ENCODER_QUEUE_LIMIT = 4;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const URL_RE = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;

const WEBM_ENCODER_CANDIDATES = [
  { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9' },
  { codec: 'vp8', muxerCodec: 'V_VP8' },
] as const;

const MP4_ENCODER_CANDIDATES = [
  {
    codec: 'avc1.64002a',
    muxerCodec: 'avc',
    extraConfig: { avc: { format: 'avc' } },
  },
  {
    codec: 'avc1.640028',
    muxerCodec: 'avc',
    extraConfig: { avc: { format: 'avc' } },
  },
  {
    codec: 'avc1.42001f',
    muxerCodec: 'avc',
    extraConfig: { avc: { format: 'avc' } },
  },
] as const;

type RenderPhase = 'preparing' | 'capturing' | 'encoding' | 'done';

export type RecordProgress = {
  phase: RenderPhase;
  current: number;
  total: number;
};

type CreateWritable = (name: string) => Promise<FileSystemWritableFileStream>;
type SaveBlob = (blob: Blob, name: string) => Promise<void> | void;

export type RecordCardOptions = {
  filename?: string;
  createWritable?: CreateWritable | null;
  saveBlob?: SaveBlob | null;
  canvasBackground?: string | null;
  cardSize?: 'default' | 'ratio_669' | 'ratio_551' | 'custom';
  customCardWidth?: number;
  verticalOffset?: number;
  speed?: number;
};

type EncoderSupport = {
  encoderConfig: VideoEncoderConfig;
  muxerCodec: string;
};

type OutputTarget = {
  target: unknown;
  finalize: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
};

type OutputContainer = 'mp4' | 'webm';

let embeddedCssSnapshotPromise: Promise<{ embeddedCSS: string; rootVarsInline: string }> | null = null;
let mp4EncoderSupportPromise: Promise<EncoderSupport | null> | null = null;
let webmEncoderSupportPromise: Promise<EncoderSupport | null> | null = null;
const recordingBackgroundPromises = new Map<string, Promise<string | null>>();

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, precision = 3) {
  return Number(value.toFixed(precision));
}

function adjust(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
  return round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function getCanvasColorSpace(): PredefinedColorSpace {
  if (!window.matchMedia('(color-gamut: p3)').matches) return 'srgb';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    if (ctx?.getContextAttributes().colorSpace === 'display-p3') return 'display-p3';
  } catch {
    // Fall back to sRGB below.
  }
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

function getBaseOutputName(filename?: string | null) {
  if (!filename) return 'holo-card';
  return filename.replace(/\.(webm|mp4)$/i, '');
}

async function getSupportedMp4Encoder(): Promise<EncoderSupport | null> {
  if (!mp4EncoderSupportPromise) {
    mp4EncoderSupportPromise = (async () => {
      if (
        typeof VideoEncoder === 'undefined' ||
        typeof VideoFrame === 'undefined' ||
        typeof VideoEncoder.isConfigSupported !== 'function'
      ) {
        return null;
      }

      for (const candidate of MP4_ENCODER_CANDIDATES) {
        const config: VideoEncoderConfig = {
          codec: candidate.codec,
          width: VIDEO_SIZE,
          height: VIDEO_SIZE,
          bitrate: VIDEO_BITRATE,
          framerate: FRAME_RATE,
          latencyMode: 'realtime',
          ...candidate.extraConfig,
        };

        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported && support.config) {
            return {
              encoderConfig: support.config,
              muxerCodec: candidate.muxerCodec,
            };
          }
        } catch {
          // Try the next codec.
        }
      }

      return null;
    })();
  }

  try {
    return await mp4EncoderSupportPromise;
  } catch (error) {
    mp4EncoderSupportPromise = null;
    throw error;
  }
}

async function getSupportedWebmEncoder(): Promise<EncoderSupport | null> {
  if (!webmEncoderSupportPromise) {
    webmEncoderSupportPromise = (async () => {
      if (
        typeof VideoEncoder === 'undefined' ||
        typeof VideoFrame === 'undefined' ||
        typeof VideoEncoder.isConfigSupported !== 'function'
      ) {
        return null;
      }

      for (const candidate of WEBM_ENCODER_CANDIDATES) {
        const config: VideoEncoderConfig = {
          codec: candidate.codec,
          width: VIDEO_SIZE,
          height: VIDEO_SIZE,
          bitrate: VIDEO_BITRATE,
          framerate: FRAME_RATE,
          latencyMode: 'realtime',
        };

        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported && support.config) {
            return {
              encoderConfig: support.config,
              muxerCodec: candidate.muxerCodec,
            };
          }
        } catch {
          // Try the next codec.
        }
      }

      return null;
    })();
  }

  try {
    return await webmEncoderSupportPromise;
  } catch (error) {
    webmEncoderSupportPromise = null;
    throw error;
  }
}

function getFrameTimestampUs(frameIndex: number) {
  return Math.round((frameIndex * 1_000_000) / FRAME_RATE);
}

function getFrameDurationUs(frameIndex: number) {
  return getFrameTimestampUs(frameIndex + 1) - getFrameTimestampUs(frameIndex);
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

function normalizeRelativeVerticalOffset(relativeOffset = 0) {
  const numeric = Number(relativeOffset);
  if (!Number.isFinite(numeric)) return 0;
  return clamp(numeric, -1, 1);
}

function getCardWidthPx(cardSize: RecordCardOptions['cardSize'] = 'default', customCardWidth = RELATIVE_CARD_WIDTH_RATIO_669) {
  if (cardSize === 'ratio_669') return VIDEO_SIZE * RELATIVE_CARD_WIDTH_RATIO_669;
  if (cardSize === 'ratio_551') return VIDEO_SIZE * RELATIVE_CARD_WIDTH_RATIO_551;
  if (cardSize === 'custom') return VIDEO_SIZE * normalizeRelativeCardWidth(customCardWidth);
  return DEFAULT_CARD_WIDTH_PX;
}

function getCardOffsetYPx(relativeOffset = 0) {
  return VIDEO_SIZE * normalizeRelativeVerticalOffset(relativeOffset);
}

async function createOutputTarget(
  outputName: string,
  {
    container,
    createWritable,
    saveBlob,
  }: {
    container: OutputContainer;
    createWritable?: CreateWritable | null;
    saveBlob?: SaveBlob | null;
  },
): Promise<OutputTarget> {
  const targetConfig =
    container === 'mp4'
      ? {
          arrayBufferTarget: Mp4ArrayBufferTarget,
          fileTarget: Mp4FileSystemWritableFileStreamTarget,
          mimeType: 'video/mp4',
        }
      : {
          arrayBufferTarget: WebMArrayBufferTarget,
          fileTarget: WebMFileSystemWritableFileStreamTarget,
          mimeType: 'video/webm',
        };

  if (typeof createWritable === 'function') {
    const writable = await createWritable(outputName);
    let closed = false;
    return {
      target: new targetConfig.fileTarget(writable),
      async finalize() {
        if (closed) return;
        closed = true;
        await writable.close();
      },
      async abort(reason?: unknown) {
        if (closed) return;
        closed = true;
        if (typeof writable.abort === 'function') {
          try {
            await writable.abort(reason);
            return;
          } catch {
            // Fall through to a normal close.
          }
        }
        try {
          await writable.close();
        } catch {
          // Best effort cleanup.
        }
      },
    };
  }

  const target = new targetConfig.arrayBufferTarget();
  return {
    target,
    async finalize() {
      const buffer = target.buffer;
      const videoBlob = new Blob([buffer], { type: targetConfig.mimeType });
      if (saveBlob) {
        await saveBlob(videoBlob, outputName);
      } else {
        downloadBlob(videoBlob, outputName);
      }
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

export async function fetchAsDataUrl(absUrl: string) {
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
        cache.set(abs, await fetchAsDataUrl(abs));
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
        dataUrl = await fetchAsDataUrl(abs);
        cache.set(abs, dataUrl);
      } catch (error) {
        console.warn('Failed to embed card image:', abs, error);
        continue;
      }
    }
    img.setAttribute('src', dataUrl);
  }
}

function createRecordingViewport(cardClone: Element, backgroundDataUrl: string | null, cardWidthPx: number, cardOffsetYPx = 0) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(1, (Math.min(vw, vh) * 0.82) / VIDEO_SIZE);

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
    width: `${VIDEO_SIZE}px`,
    height: `${VIDEO_SIZE}px`,
    backgroundColor: '#000',
    backgroundImage: backgroundDataUrl ? `url("${backgroundDataUrl}")` : 'none',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'cover',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    transform: `scale(${scale})`,
    transformOrigin: 'center',
    borderRadius: '12px',
    boxShadow: '0 0 80px rgba(0,0,0,0.9)',
  });

  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    width: `${cardWidthPx}px`,
    transform: `translateY(${cardOffsetYPx}px)`,
  });
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
  cardWidthPx: number,
  cardOffsetYPx = 0,
) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(VIDEO_SIZE));
  svg.setAttribute('height', String(VIDEO_SIZE));
  svg.setAttribute('color-interpolation', 'sRGB');
  svg.setAttribute('color-interpolation-filters', 'sRGB');

  const foreignObject = document.createElementNS(SVG_NS, 'foreignObject');
  foreignObject.setAttribute('x', '0');
  foreignObject.setAttribute('y', '0');
  foreignObject.setAttribute('width', String(VIDEO_SIZE));
  foreignObject.setAttribute('height', String(VIDEO_SIZE));

  const container = document.createElementNS(XHTML_NS, 'div');
  container.setAttribute(
    'style',
    `width:${VIDEO_SIZE}px;height:${VIDEO_SIZE}px;background-color:#000;` +
      (backgroundDataUrl
        ? `background-image:url("${backgroundDataUrl}");background-position:center;background-repeat:no-repeat;background-size:cover;`
        : '') +
      'display:flex;align-items:center;justify-content:center;overflow:hidden;' +
      'color:white;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
      rootVarsInline,
  );

  const styleEl = document.createElementNS(XHTML_NS, 'style');
  styleEl.textContent = embeddedCSS;
  container.appendChild(styleEl);

  const wrapper = document.createElementNS(XHTML_NS, 'div');
  wrapper.setAttribute('style', `width:${cardWidthPx}px;transform:translateY(${cardOffsetYPx}px);`);
  wrapper.appendChild(cardClone);
  container.appendChild(wrapper);

  foreignObject.appendChild(container);
  svg.appendChild(foreignObject);
  return svg;
}

async function svgToImage(svgElement: SVGSVGElement): Promise<ImageBitmap | HTMLImageElement> {
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

  const img = new Image(VIDEO_SIZE, VIDEO_SIZE);
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
  return {
    filename: options.filename || null,
    saveBlob: options.saveBlob || null,
    createWritable: options.createWritable || null,
    canvasBackground: options.canvasBackground || null,
    cardSize: options.cardSize || 'default',
    customCardWidth: normalizeRelativeCardWidth(options.customCardWidth),
    verticalOffset: normalizeRelativeVerticalOffset(options.verticalOffset),
    speed: normalizePlaybackSpeed(options.speed),
  };
}

function createMuxer(container: OutputContainer, output: OutputTarget, encoderSupport: EncoderSupport) {
  if (container === 'mp4') {
    return new Mp4Muxer({
      target: output.target as Mp4ArrayBufferTarget | Mp4FileSystemWritableFileStreamTarget,
      fastStart: false,
      video: {
        codec: encoderSupport.muxerCodec as 'avc' | 'hevc' | 'vp9' | 'av1',
        width: VIDEO_SIZE,
        height: VIDEO_SIZE,
        frameRate: FRAME_RATE,
      },
    });
  }

  return new WebMMuxer({
    target: output.target as WebMArrayBufferTarget | WebMFileSystemWritableFileStreamTarget,
    video: {
      codec: encoderSupport.muxerCodec,
      width: VIDEO_SIZE,
      height: VIDEO_SIZE,
      frameRate: FRAME_RATE,
    },
  });
}

export async function recordCard(
  cardElement: HTMLElement,
  onProgress: (progress: RecordProgress) => void = () => {},
  options: RecordCardOptions = {},
) {
  if (!cardElement) throw new Error('No card element provided');

  const normalizedOptions = normalizeRecordOptions(options);
  const mp4EncoderSupport = await getSupportedMp4Encoder();
  const webmEncoderSupport = mp4EncoderSupport ? null : await getSupportedWebmEncoder();
  if (!mp4EncoderSupport && !webmEncoderSupport) {
    throw new Error('This browser does not support the WebCodecs encoder required for stable batch recording');
  }

  const useWebmFallbackForMp4 = !mp4EncoderSupport && webmEncoderSupport?.muxerCodec === 'V_VP9';
  const outputContainer: OutputContainer = mp4EncoderSupport || useWebmFallbackForMp4 ? 'mp4' : 'webm';
  const encoderSupport = mp4EncoderSupport || webmEncoderSupport!;
  const outputBaseName = getBaseOutputName(normalizedOptions.filename);
  const outputName = `${outputBaseName}.${outputContainer}`;
  const cardWidthPx = getCardWidthPx(normalizedOptions.cardSize, normalizedOptions.customCardWidth);
  const cardOffsetYPx = getCardOffsetYPx(normalizedOptions.verticalOffset);
  const totalFrames = getTotalFrames(normalizedOptions.speed);

  onProgress({ phase: 'preparing', current: 0, total: 0 });

  const { embeddedCSS, rootVarsInline } = await getEmbeddedCssSnapshot();
  const recordingBackgroundDataUrl = await getRecordingBackgroundDataUrl(normalizedOptions.canvasBackground);
  const cache = new Map<string, string>();

  const clone = cardElement.cloneNode(true) as HTMLElement;
  clone.classList.add('interacting');
  clone.classList.remove('loading', 'active', 'is-scaled');
  clone.querySelectorAll('img[loading="lazy"]').forEach((img) => img.removeAttribute('loading'));
  await embedImagesInElement(clone, cache);

  const origStyle = cardElement.getAttribute('style') || '';
  const embeddedOrigStyle = await embedUrlsInText(origStyle, cache);
  const staticStyle = extractStaticStyle(embeddedOrigStyle);
  const { viewport } = createRecordingViewport(clone, recordingBackgroundDataUrl, cardWidthPx, cardOffsetYPx);

  let output: OutputTarget | null = null;
  let finalized = false;
  let encoderError: Error | null = null;
  let encoder: VideoEncoder | null = null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_SIZE;
    canvas.height = VIDEO_SIZE;
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
    const muxer = createMuxer(outputContainer, output, encoderSupport);

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (error) {
          encoderError = toError(error);
        }
      },
      error: (error) => {
        encoderError = toError(error);
      },
    });
    encoder.configure(encoderSupport.encoderConfig);

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    onProgress({ phase: 'capturing', current: 0, total: totalFrames });

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (encoderError) throw encoderError;

      clone.setAttribute('style', `${staticStyle};${computeFrameOverrides(frameIndex, totalFrames)}`);
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const svgClone = clone.cloneNode(true) as HTMLElement;
      const svgDoc = buildSVGDocument(
        embeddedCSS,
        rootVarsInline,
        svgClone,
        recordingBackgroundDataUrl,
        cardWidthPx,
        cardOffsetYPx,
      );
      const renderedFrame = await svgToImage(svgDoc);

      try {
        ctx.clearRect(0, 0, VIDEO_SIZE, VIDEO_SIZE);
        ctx.drawImage(renderedFrame, 0, 0, VIDEO_SIZE, VIDEO_SIZE);
      } finally {
        if ('close' in renderedFrame) renderedFrame.close();
      }

      const frame = new VideoFrame(canvas, {
        timestamp: getFrameTimestampUs(frameIndex),
        duration: getFrameDurationUs(frameIndex),
      });

      try {
        encoder.encode(frame, {
          keyFrame: frameIndex === 0 || frameIndex % KEYFRAME_INTERVAL === 0,
        });
      } finally {
        frame.close();
      }

      if (encoder.encodeQueueSize > ENCODER_QUEUE_LIMIT) {
        await encoder.flush();
      }

      if (encoderError) throw encoderError;
      onProgress({ phase: 'capturing', current: frameIndex + 1, total: totalFrames });
    }

    onProgress({ phase: 'encoding', current: 0, total: 1 });
    await encoder.flush();
    if (encoderError) throw encoderError;

    muxer.finalize();
    finalized = true;
    await output.finalize();

    onProgress({ phase: 'encoding', current: 1, total: 1 });
    onProgress({ phase: 'done', current: 0, total: 0 });

    return {
      filename: outputName,
      container: outputContainer,
      frameCount: totalFrames,
      durationMs: CYCLE_DURATION_MS,
      frameRate: FRAME_RATE,
      size: VIDEO_SIZE,
    };
  } catch (error) {
    if (!finalized) {
      await output?.abort(error);
    }
    throw error;
  } finally {
    encoder?.close();
    viewport.remove();
  }
}
