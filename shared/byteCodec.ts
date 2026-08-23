export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function hasAnyNonZeroByte(data: Uint8Array): boolean {
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0) return true;
  }
  return false;
}

export function readU32LE(data: Uint8Array, offset: number): number {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(offset, true);
}

export function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(offset, true);
}
