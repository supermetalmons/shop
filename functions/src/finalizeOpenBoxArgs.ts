import { HttpsError } from 'firebase-functions/v2/https';
import type { PendingOpenBoxLayout } from './pendingOpenBox.js';

// Anchor discriminator = sha256("global:finalize_open_box")[0..8]
const IX_FINALIZE_OPEN_BOX = Buffer.from('cf5e6dfd1544ed16', 'hex');

type FinalizeOpenBoxArgsOptions = {
  itemsPerBox: number;
  maxDudeId: number;
  pendingLayout: PendingOpenBoxLayout;
};

function u16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(Math.floor(n), 0);
  return b;
}

function u32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Math.floor(n), 0);
  return b;
}

export function encodeFinalizeOpenBoxArgs(dudeIds: number[], options: FinalizeOpenBoxArgsOptions): Buffer {
  const itemsPerBox = Number(options.itemsPerBox);
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < 1) {
    throw new HttpsError('failed-precondition', 'This drop does not support opening.');
  }
  if (!Array.isArray(dudeIds) || dudeIds.length !== itemsPerBox) {
    throw new HttpsError('invalid-argument', `dudeIds must have length ${itemsPerBox}`);
  }
  const ids = dudeIds.map((n) => Number(n));
  ids.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > options.maxDudeId) {
      throw new HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new HttpsError('invalid-argument', 'Duplicate dude ids');
  }

  if (options.pendingLayout === 'legacyFixed') {
    return Buffer.concat([IX_FINALIZE_OPEN_BOX, ...ids.map(u16LE)]);
  }
  return Buffer.concat([IX_FINALIZE_OPEN_BOX, u32LE(ids.length), ...ids.map(u16LE)]);
}
