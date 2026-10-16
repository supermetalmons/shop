export type RecordingLightPath = 'orbit';

const FLOAT_RADIUS_X = 22;
const FLOAT_RADIUS_Y = 16;

export const RECORDING_MOTIONS = ['original', 'vertical-swing', 'breathing-swing'] as const;

export const RECORDING_MOTION_LOOPS = [
  { id: 'vertical-swing', name: 'Vertical swing', description: 'A broad, gentle yaw pendulum with a small counterbalancing pitch.' },
  { id: 'breathing-swing', name: 'Breathing swing', description: 'An elliptical rocking motion that gently opens and contracts through the loop.' },
] as const;

export type RecordingMotionLoop = (typeof RECORDING_MOTION_LOOPS)[number]['id'];

export type RecordingMotionPose = {
  normalizedX: number;
  normalizedY: number;
  pointerX: number;
  pointerY: number;
  rotateX: number;
  rotateY: number;
};

function normalizedMotion(angle: number, motionLoop: RecordingMotionLoop) {
  switch (motionLoop) {
    case 'vertical-swing':
      return { x: 0.94 * Math.sin(angle), y: 0.22 * Math.cos(angle) };
    case 'breathing-swing': {
      const radius = 0.81 - 0.12 * Math.cos(angle);
      const swing = angle + 0.18 * Math.sin(angle);
      return { x: radius * Math.sin(swing), y: radius * 0.65 * Math.cos(swing) };
    }
  }
}

export function computeRecordingMotionPose(
  frameIndex: number,
  totalFrames: number,
  motionLoop: RecordingMotionLoop,
): RecordingMotionPose {
  if (!Number.isFinite(frameIndex) || !Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new RangeError('Motion frames must be finite and totalFrames must be positive.');
  }
  const phase = ((frameIndex / totalFrames) % 1 + 1) % 1;
  const { x, y } = normalizedMotion(phase * Math.PI * 2, motionLoop);
  return {
    normalizedX: x,
    normalizedY: y,
    pointerX: 50 + x * FLOAT_RADIUS_X,
    pointerY: 50 + y * FLOAT_RADIUS_Y,
    rotateX: -(x * FLOAT_RADIUS_X) / 3.5,
    rotateY: (y * FLOAT_RADIUS_Y) / 2,
  };
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, precision = 3) {
  return Number(value.toFixed(precision));
}

function adjust(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
  return round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
}

export function computeRecordingFrameStyle(
  frameIndex: number,
  totalFrames: number,
  {
    effectOpacity = 1,
    tilt = true,
    motionLoop,
  }: { effectOpacity?: number; tilt?: boolean; lightPath?: RecordingLightPath; motionLoop?: RecordingMotionLoop } = {},
) {
  const phase = frameIndex / totalFrames;
  const angle = phase * Math.PI * 2;
  const radius = 1;
  const pose = motionLoop ? computeRecordingMotionPose(frameIndex, totalFrames, motionLoop) : undefined;
  const px = pose ? pose.pointerX : 50 + Math.cos(angle) * FLOAT_RADIUS_X * radius;
  const py = pose ? pose.pointerY : 50 + Math.sin(angle) * FLOAT_RADIUS_Y * radius;
  const percentX = clamp(round(px));
  const percentY = clamp(round(py));
  const centerX = percentX - 50;
  const centerY = percentY - 50;
  const bgX = adjust(percentX, 0, 100, 37, 63);
  const bgY = adjust(percentY, 0, 100, 33, 67);
  const rotX = tilt ? round(-(centerX / 3.5)) : 0;
  const rotY = tilt ? round(centerY / 2) : 0;
  const glareX = round(percentX);
  const glareY = round(percentY);
  const pointerFromCenter = clamp(Math.sqrt((glareY - 50) ** 2 + (glareX - 50) ** 2) / 50, 0, 1);

  return [
    `--pointer-x:${clamp(glareX)}%`,
    `--pointer-y:${clamp(glareY)}%`,
    `--pointer-from-center:${pointerFromCenter}`,
    `--pointer-from-top:${glareY / 100}`,
    `--pointer-from-left:${glareX / 100}`,
    `--card-opacity:${effectOpacity}`,
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
