import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_IO = { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync };
export type DurableFileIo = typeof DEFAULT_IO;

export function writeDurableFile(args: {
  filePath: string;
  source: string;
  mode: 'create' | 'replace';
  permissions?: number;
  verificationMessage: string;
}, ioOverrides: Partial<DurableFileIo> = {}): string {
  const io = { ...DEFAULT_IO, ...ioOverrides };
  const temporary = `${args.filePath}.${randomUUID()}.tmp`;
  const descriptor = io.openSync(temporary, 'wx', args.permissions ?? 0o600);
  try {
    try { io.writeFileSync(descriptor, args.source, 'utf8'); io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
    if (args.mode === 'create') io.linkSync(temporary, args.filePath);
    else io.renameSync(temporary, args.filePath);
    const parent = io.openSync(dirname(args.filePath), 'r');
    try { io.fsyncSync(parent); } finally { io.closeSync(parent); }
  } finally {
    io.rmSync(temporary, { force: true });
  }
  if (io.readFileSync(args.filePath, 'utf8') !== args.source) throw new Error(args.verificationMessage);
  return args.source;
}
