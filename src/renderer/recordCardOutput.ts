import {
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';

export const RECORDING_FRAME_RATE = 60;
export const RECORDING_VIDEO_BITRATE = 20_000_000;

const MP4_ENCODER_CANDIDATES = [
  'avc1.64002a',
  'avc1.640028',
  'avc1.42001f',
  'avc1.640033',
  'avc1.4d0033',
] as const;

const WEBM_ENCODER_CANDIDATES = [
  { codec: 'vp9', fullCodecString: 'vp09.00.10.08' },
  { codec: 'vp8', fullCodecString: 'vp8' },
] as const;

export type RecordingOutputContainer = 'mp4' | 'webm';

export type RecordingOutputSize = {
  width: number;
  height: number;
};

type RecordingEncoderSupport = {
  container: RecordingOutputContainer;
  codec: VideoCodec;
  fullCodecString: string;
};

type EncodeProbeOptions = {
  width: number;
  height: number;
  bitrate: number;
  frameRate: number;
  latencyMode: 'realtime';
  fullCodecString: string;
};

type EncodeProbe = (codec: VideoCodec, options: EncodeProbeOptions) => Promise<boolean>;

type RecordingWritable = Pick<FileSystemWritableFileStream, 'write' | 'close' | 'abort'>;

const supportPromises = new Map<string, Promise<RecordingEncoderSupport | null>>();

function getSupportKey(container: RecordingOutputContainer, outputSize: RecordingOutputSize) {
  return `${container}:${outputSize.width}x${outputSize.height}`;
}

function needsEncoderSmokeTest() {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
}

async function smokeTestVideoEncoder(config: VideoEncoderConfig) {
  let encoder: VideoEncoder | null = null;
  let encoderFailed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    encoder = new VideoEncoder({
      output() {},
      error() {
        encoderFailed = true;
      },
    });
    encoder.configure(config);
    const frame = new VideoFrame(new Uint8Array(config.width * config.height * 4), {
      format: 'RGBA',
      codedWidth: config.width,
      codedHeight: config.height,
      timestamp: 0,
      duration: Math.trunc(1_000_000 / RECORDING_FRAME_RATE),
    });
    try {
      encoder.encode(frame, { keyFrame: true });
    } finally {
      frame.close();
    }

    const flushed = await Promise.race([
      encoder.flush().then(() => true, () => false),
      new Promise<false>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    return flushed && !encoderFailed;
  } catch {
    return false;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (encoder && encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch {}
    }
  }
}

async function canEncodeRecordingVideo(codec: VideoCodec, options: EncodeProbeOptions) {
  if (
    typeof VideoEncoder === 'undefined'
    || typeof VideoFrame === 'undefined'
    || typeof VideoEncoder.isConfigSupported !== 'function'
  ) return false;

  const config: VideoEncoderConfig = {
    codec: options.fullCodecString,
    width: options.width,
    height: options.height,
    displayWidth: options.width,
    displayHeight: options.height,
    bitrate: options.bitrate,
    bitrateMode: 'variable',
    alpha: 'discard',
    framerate: options.frameRate,
    latencyMode: options.latencyMode,
  };
  if (codec === 'avc') config.avc = { format: 'avc' };

  const support = await VideoEncoder.isConfigSupported(config);
  if (support.supported !== true) return false;
  if (!needsEncoderSmokeTest()) return true;
  return smokeTestVideoEncoder(config);
}

async function probeEncoder(
  container: RecordingOutputContainer,
  outputSize: RecordingOutputSize,
  probe: EncodeProbe,
): Promise<RecordingEncoderSupport | null> {
  const candidates = container === 'mp4'
    ? MP4_ENCODER_CANDIDATES.map((fullCodecString) => ({ codec: 'avc' as const, fullCodecString }))
    : WEBM_ENCODER_CANDIDATES;

  for (const candidate of candidates) {
    if (
      candidate.codec === 'avc'
      && (outputSize.width % 2 !== 0 || outputSize.height % 2 !== 0)
    ) continue;

    try {
      const supported = await probe(candidate.codec, {
        width: outputSize.width,
        height: outputSize.height,
        bitrate: RECORDING_VIDEO_BITRATE,
        frameRate: RECORDING_FRAME_RATE,
        latencyMode: 'realtime',
        fullCodecString: candidate.fullCodecString,
      });
      if (supported) return { container, ...candidate };
    } catch {}
  }

  return null;
}

async function getEncoderSupport(
  container: RecordingOutputContainer,
  outputSize: RecordingOutputSize,
  probe: EncodeProbe,
) {
  if (probe !== canEncodeRecordingVideo) return probeEncoder(container, outputSize, probe);

  const key = getSupportKey(container, outputSize);
  if (!supportPromises.has(key)) {
    supportPromises.set(key, probeEncoder(container, outputSize, probe));
  }

  try {
    return await supportPromises.get(key)!;
  } catch (error) {
    supportPromises.delete(key);
    throw error;
  }
}

export async function resolveRecordingEncoder(
  outputSize: RecordingOutputSize,
  requireMp4: boolean,
  probe: EncodeProbe = canEncodeRecordingVideo,
) {
  const mp4 = await getEncoderSupport('mp4', outputSize, probe);
  if (mp4) return mp4;
  if (requireMp4) {
    throw new Error(`This browser does not support MP4/H.264 encoding at ${outputSize.width}x${outputSize.height}`);
  }

  const webm = await getEncoderSupport('webm', outputSize, probe);
  if (webm) return webm;
  throw new Error('This browser does not support the WebCodecs encoder required for stable batch recording');
}

export function getRecordingBaseName(filename?: string | null) {
  if (!filename) return 'holo-card';
  return filename.replace(/\.(webm|mp4)$/i, '');
}

export function createRecordingFileStream(writable: RecordingWritable) {
  let state: 'pending' | 'committed' | 'aborted' = 'pending';

  const commit = async () => {
    if (state !== 'pending') return;
    await writable.close();
    state = 'committed';
  };

  const abort = async (reason?: unknown) => {
    if (state !== 'pending') return;
    state = 'aborted';
    try {
      await writable.abort(reason);
    } catch {}
  };

  const stream = new WritableStream<StreamTargetChunk>({
    write: (chunk) => writable.write(chunk),
    close() {},
    abort,
  });

  return {
    stream,
    commit,
    abort,
  };
}

export async function deliverRecordingBuffer(
  buffer: ArrayBuffer | null,
  mimeType: string,
  outputName: string,
  saveBlob: ((blob: Blob, name: string) => Promise<void> | void) | null,
  download: (blob: Blob, name: string) => void,
) {
  if (!buffer) throw new Error('Recording output did not produce a buffer');
  const blob = new Blob([buffer], { type: mimeType });
  if (saveBlob) {
    await saveBlob(blob, outputName);
  } else {
    download(blob, outputName);
  }
}
