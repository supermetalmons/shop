import registry from './miNotePackRenderSetups.json' with { type: 'json' };

type RegistrySetup = (typeof registry.setups)[keyof typeof registry.setups];
type PreviewSetup = {
  readonly camera: Readonly<Pick<RegistrySetup['camera'], 'fov' | 'zoom'>> & {
    readonly position: Readonly<RegistrySetup['camera']['position']>;
  };
};
type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;
type ProjectionCamera = PreviewSetup['camera'] & { readonly quaternion?: readonly number[] };
type PlanePose = { rotation: readonly number[]; position: readonly number[]; scale: readonly number[] };
const CLOSED_COVER_DEPTH = 0.0158 + 0.0018 / 2;

function rotatePoint(point: readonly number[], rotation: readonly number[]): number[] {
  const [x, y, z] = point;
  const [pitch, yaw, roll] = rotation;
  const rolledX = x * Math.cos(roll) - y * Math.sin(roll);
  const rolledY = x * Math.sin(roll) + y * Math.cos(roll);
  const yawedX = rolledX * Math.cos(yaw) + z * Math.sin(yaw);
  const yawedZ = -rolledX * Math.sin(yaw) + z * Math.cos(yaw);
  return [yawedX, rolledY * Math.cos(pitch) - yawedZ * Math.sin(pitch),
    rolledY * Math.sin(pitch) + yawedZ * Math.cos(pitch)];
}

function cameraPoint(point: readonly number[], camera: ProjectionCamera): number[] {
  const [x, y, z] = point.map((value, index) => value - camera.position[index]);
  if (!camera.quaternion) return [x, y, z];
  const [qx, qy, qz, qw] = camera.quaternion;
  const tx = 2 * (-qy * z + qz * y);
  const ty = 2 * (-qz * x + qx * z);
  const tz = 2 * (-qx * y + qy * x);
  return [x + qw * tx - qy * tz + qz * ty,
    y + qw * ty - qz * tx + qx * tz,
    z + qw * tz - qx * ty + qy * tx];
}

function planeProjection(width: number, height: number, camera: ProjectionCamera, pose: PlanePose): number[] {
  const projected = [[0, 0], [1, 0], [0, 1]].map(([x, y]) => {
    const point = rotatePoint([x * pose.scale[0], y * pose.scale[1], CLOSED_COVER_DEPTH * pose.scale[2]], pose.rotation)
      .map((value, index) => value + pose.position[index]);
    return cameraPoint(point, camera);
  });
  const origin = projected[0];
  const horizontal = projected[1].map((value, index) => value - origin[index]);
  const vertical = projected[2].map((value, index) => value - origin[index]);
  const focalLength = height * camera.zoom / (2 * Math.tan(camera.fov * Math.PI / 360));
  const depth = [-horizontal[2], -vertical[2], -origin[2]];
  return [
    ...[horizontal[0], vertical[0], origin[0]].map((value, index) => focalLength * value + width / 2 * depth[index]),
    ...[horizontal[1], vertical[1], origin[1]].map((value, index) => -focalLength * value + height / 2 * depth[index]),
    ...depth,
  ];
}

function invertMatrix(matrix: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d].map(value => value / determinant);
}

function multiplyMatrices(left: readonly number[], right: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3) * 3;
    const column = index % 3;
    return left[row] * right[column] + left[row + 1] * right[column + 3] + left[row + 2] * right[column + 6];
  });
}

export function getMiNotePackPreviewRect(
  setup: PreviewSetup,
  width: number,
  height: number,
  output: Readonly<typeof registry.shared.output> = registry.shared.output,
): Rect {
  const worldViewHeight = Math.max(1.82 / 0.52, 1.29 / (width / height * 0.68));
  const pixelsPerWorldUnit = height / worldViewHeight;
  const [cameraX, cameraY, cameraZ] = setup.camera.position;
  const sourceWorldHeight = 2 * cameraZ * Math.tan(setup.camera.fov * Math.PI / 360) / setup.camera.zoom;
  const imageHeight = sourceWorldHeight * pixelsPerWorldUnit;
  const imageWidth = imageHeight * output.width / output.height;
  return {
    left: (width - imageWidth) / 2 + cameraX * pixelsPerWorldUnit,
    top: (height - imageHeight) / 2 - cameraY * pixelsPerWorldUnit,
    width: imageWidth,
    height: imageHeight,
  };
}

export function getMiNotePackPreviewOriginRect(originRect: Rect, targetRect: Rect, previewRect: Rect): Rect {
  const scale = Math.min(originRect.width / previewRect.width, originRect.height / previewRect.height);
  const containedLeft = originRect.left + (originRect.width - previewRect.width * scale) / 2;
  const containedTop = originRect.top + (originRect.height - previewRect.height * scale) / 2;
  return {
    left: containedLeft - previewRect.left * scale,
    top: containedTop - previewRect.top * scale,
    width: targetRect.width * scale,
    height: targetRect.height * scale,
  };
}

export function getMiNotePackPreviewTransform(
  setup: Readonly<Pick<RegistrySetup, 'camera' | 'model'>>,
  width: number,
  height: number,
  reducedMotion: boolean,
): string {
  const preview = getMiNotePackPreviewRect(setup, width, height);
  const source = planeProjection(preview.width, preview.height, setup.camera, {
    rotation: setup.model.rotationDegrees.map(value => value * Math.PI / 180),
    position: setup.model.position,
    scale: setup.model.scale,
  });
  const worldViewHeight = Math.max(1.82 / 0.52, 1.29 / (width / height * 0.68));
  const target = planeProjection(width, height, {
    position: [0, 0, worldViewHeight / (2 * Math.tan(17 * Math.PI / 180))],
    fov: 34,
    zoom: 1,
  }, { rotation: reducedMotion ? [0, 0, 0] : [0.055, -0.12, -0.016], position: [0, 0, 0], scale: [1, 1, 1] });
  const localTarget = multiplyMatrices([1, 0, -preview.left, 0, 1, -preview.top, 0, 0, 1], target);
  const homography = multiplyMatrices(localTarget, invertMatrix(source));
  const normalized = homography.map(value => value / homography[8]);
  return `matrix3d(${[normalized[0], normalized[3], 0, normalized[6],
    normalized[1], normalized[4], 0, normalized[7], 0, 0, 1, 0,
    normalized[2], normalized[5], 0, 1].join(',')})`;
}
