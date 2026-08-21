import type { PendingOpenBoxLayout } from './pendingOpenCodec.js';

const IX_FINALIZE_OPEN_BOX = Uint8Array.from([0xcf, 0x5e, 0x6d, 0xfd, 0x15, 0x44, 0xed, 0x16]);

export type FinalizeOpenBoxArgsOptions = {
  itemsPerBox: number;
  maxDudeId: number;
  pendingLayout: PendingOpenBoxLayout;
};

class FinalizeOpenBoxArgsError extends Error {
  constructor(readonly reason: 'unsupported-drop' | 'invalid-length' | 'invalid-id' | 'duplicate-id') {
    super(reason);
    this.name = 'FinalizeOpenBoxArgsError';
  }
}

function writeU16LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

export function encodeFinalizeOpenBoxArgs(
  dudeIds: readonly number[],
  options: FinalizeOpenBoxArgsOptions,
): Uint8Array {
  const itemsPerBox = Number(options.itemsPerBox);
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < 1) {
    throw new FinalizeOpenBoxArgsError('unsupported-drop');
  }
  if (!Array.isArray(dudeIds) || dudeIds.length !== itemsPerBox) {
    throw new FinalizeOpenBoxArgsError('invalid-length');
  }
  const ids = dudeIds.map((value) => Number(value));
  if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > options.maxDudeId)) {
    throw new FinalizeOpenBoxArgsError('invalid-id');
  }
  if (new Set(ids).size !== ids.length) {
    throw new FinalizeOpenBoxArgsError('duplicate-id');
  }

  const vectorPrefixBytes = options.pendingLayout === 'legacyFixed' ? 0 : 4;
  const data = new Uint8Array(IX_FINALIZE_OPEN_BOX.length + vectorPrefixBytes + ids.length * 2);
  data.set(IX_FINALIZE_OPEN_BOX, 0);
  let offset = IX_FINALIZE_OPEN_BOX.length;
  if (vectorPrefixBytes) {
    writeU32LE(data, offset, ids.length);
    offset += 4;
  }
  for (const id of ids) {
    writeU16LE(data, offset, id);
    offset += 2;
  }
  return data;
}
