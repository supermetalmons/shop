export const MI_NOTE_STICKER_EDGE_DISTANCE = 48;
export const MI_NOTE_STICKER_OUTLINE_SUPPORT = 30;
const MI_NOTE_STICKER_BASE_RADIUS = 5;

function smoothstep(value: number) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function squaredDistances(source: Uint8ClampedArray, width: number, height: number, direction: 'backing' | 'inward' | 'outward' = 'backing') {
  const distances = new Float64Array(width * height);
  const size = Math.max(width, height);
  const input = new Float64Array(size);
  const output = new Float64Array(size);
  const sites = new Int32Array(size);
  const boundaries = new Float64Array(size + 1);
  const transform = (length: number) => {
    let last = -1;
    for (let index = 0; index < length; index += 1) {
      if (!Number.isFinite(input[index])) continue;
      let boundary = -Infinity;
      while (last >= 0) {
        const previous = sites[last];
        boundary = (input[index] + index * index - input[previous] - previous * previous) / (2 * (index - previous));
        if (boundary > boundaries[last]) break;
        last -= 1;
      }
      last += 1;
      sites[last] = index;
      boundaries[last] = last === 0 ? -Infinity : boundary;
      boundaries[last + 1] = Infinity;
    }
    if (last < 0) {
      output.fill(Infinity, 0, length);
      return;
    }
    let site = 0;
    for (let index = 0; index < length; index += 1) {
      while (boundaries[site + 1] < index) site += 1;
      const delta = index - sites[site];
      output[index] = delta * delta + input[sites[site]];
    }
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = source[(y * width + x) * 4 + 3] / 255;
      if (direction === 'inward') input[x] = alpha < 0.5 ? 0 : Infinity;
      else if (direction === 'outward') input[x] = alpha >= 0.5 ? 0 : Infinity;
      else input[x] = alpha > 0 ? (1 - alpha) ** 2 : Infinity;
    }
    transform(width);
    distances.set(output.subarray(0, width), y * width);
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) input[y] = distances[y * width + x];
    transform(height);
    for (let y = 0; y < height; y += 1) {
      const boundaryDistance = Math.min(x + 1, width - x, y + 1, height - y);
      distances[y * width + x] = direction === 'inward' ? Math.min(output[y], boundaryDistance * boundaryDistance) : output[y];
    }
  }
  return distances;
}

export function createMiNoteStickerFinish(source: Uint8ClampedArray, width: number, height: number, radius = MI_NOTE_STICKER_BASE_RADIUS) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || source.length !== width * height * 4) {
    throw new RangeError('Sticker artwork dimensions must match its pixels.');
  }
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Sticker rim radius must be finite and nonnegative.');
  const pixels = new Uint8ClampedArray(source.length);
  const finish = new Uint8ClampedArray(source.length);
  const distances = radius > 0 ? squaredDistances(source, width, height) : undefined;
  const inwardDistances = squaredDistances(source, width, height, 'inward');
  const outwardDistances = squaredDistances(source, width, height, 'outward');
  const silver = [208, 220, 231];
  const outerSilver = [236, 242, 248];
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const artworkAlpha = source[offset + 3] / 255;
    const distance = distances ? Math.max(0, Math.sqrt(distances[index]) - 0.5) : Infinity;
    const backingAlpha = radius > 0 ? smoothstep(radius + 0.5 - distance) : 0;
    const metalAlpha = backingAlpha * (1 - artworkAlpha);
    const alpha = artworkAlpha + metalAlpha;
    const inside = artworkAlpha >= 0.5;
    const edgeDistance = Math.max(0, Math.sqrt(inside ? inwardDistances[index] : outwardDistances[index]) - 0.5);
    const signedDistance = Math.min(MI_NOTE_STICKER_EDGE_DISTANCE, edgeDistance) * (inside ? 1 : -1);
    finish[offset + 2] = (0.5 + signedDistance / (2 * MI_NOTE_STICKER_EDGE_DISTANCE)) * 255;
    finish[offset + 3] = source[offset + 3];
    if (alpha === 0) continue;
    const t = radius > 0 ? Math.min(1, distance / radius) : 0;
    const crown = Math.sin(Math.PI * t);
    const lip = smoothstep(t);
    for (let channel = 0; channel < 3; channel += 1) {
      const metal = silver[channel] + (outerSilver[channel] - silver[channel]) * lip;
      pixels[offset + channel] = (source[offset + channel] * artworkAlpha + metal * metalAlpha) / alpha;
    }
    pixels[offset + 3] = alpha * 255;
    const taper = 1 - smoothstep((distance - radius + 1.5) / 1.5);
    const bevelHeight = artworkAlpha * 0.3 + metalAlpha * (0.3 + crown * 0.06) * taper;
    finish[offset] = bevelHeight * 255;
    finish[offset + 1] = metalAlpha * 255;
  }
  return { pixels, finish };
}
