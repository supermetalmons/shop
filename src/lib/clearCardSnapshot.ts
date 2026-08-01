export type SnapshotPixelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SnapshotPixelSize = {
  width: number;
  height: number;
};

export function findOpaquePixelBounds(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): SnapshotPixelBounds | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Snapshot dimensions must be positive integers.');
  }
  if (pixels.length < width * height * 4) {
    throw new Error('Snapshot pixel data is incomplete.');
  }

  let minX = width;
  let maxX = -1;
  let minSourceY = height;
  let maxSourceY = -1;

  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(sourceY * width + x) * 4 + 3];
      if (alpha <= 0) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minSourceY = Math.min(minSourceY, sourceY);
      maxSourceY = Math.max(maxSourceY, sourceY);
    }
  }

  if (maxX < minX || maxSourceY < minSourceY) return null;

  return {
    x: minX,
    y: height - 1 - maxSourceY,
    width: maxX - minX + 1,
    height: maxSourceY - minSourceY + 1,
  };
}

export function padPixelBounds(
  bounds: SnapshotPixelBounds,
  imageWidth: number,
  imageHeight: number,
  paddingRatio: number,
): SnapshotPixelBounds {
  if (!Number.isFinite(paddingRatio) || paddingRatio < 0) {
    throw new Error('Snapshot padding must be non-negative.');
  }

  const paddingX = Math.ceil(bounds.width * paddingRatio);
  const paddingY = Math.ceil(bounds.height * paddingRatio);
  const x = Math.max(0, bounds.x - paddingX);
  const y = Math.max(0, bounds.y - paddingY);
  const right = Math.min(imageWidth, bounds.x + bounds.width + paddingX);
  const bottom = Math.min(imageHeight, bounds.y + bounds.height + paddingY);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function resolveSnapshotOutputSize(
  bounds: SnapshotPixelBounds,
  longestEdge: number,
): SnapshotPixelSize {
  if (!Number.isInteger(longestEdge) || longestEdge <= 0) {
    throw new Error('Snapshot longest edge must be a positive integer.');
  }
  if (bounds.width >= bounds.height) {
    return {
      width: longestEdge,
      height: Math.max(1, Math.round((longestEdge * bounds.height) / bounds.width)),
    };
  }
  return {
    width: Math.max(1, Math.round((longestEdge * bounds.width) / bounds.height)),
    height: longestEdge,
  };
}
