import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { link, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_IO = { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync };

export function writeDurableJsonJournal(args: {
  filePath: string;
  value: unknown;
  expectedSource?: string;
  changedMessage: string;
  verificationMessage: string;
}, ioOverrides: Partial<typeof DEFAULT_IO> = {}): string {
  const io = { ...DEFAULT_IO, ...ioOverrides };
  const source = `${JSON.stringify(args.value, null, 2)}\n`;
  const directory = dirname(args.filePath);
  io.mkdirSync(directory, { recursive: true });
  if (args.expectedSource !== undefined &&
    (!io.existsSync(args.filePath) || io.readFileSync(args.filePath, 'utf8') !== args.expectedSource)) {
    throw new Error(args.changedMessage);
  }
  const temporary = `${args.filePath}.${randomUUID()}.tmp`;
  const descriptor = io.openSync(temporary, 'wx', 0o600);
  try {
    try { io.writeFileSync(descriptor, source, 'utf8'); io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
    if (args.expectedSource === undefined) io.linkSync(temporary, args.filePath);
    else io.renameSync(temporary, args.filePath);
    const parent = io.openSync(directory, 'r');
    try { io.fsyncSync(parent); } finally { io.closeSync(parent); }
  } finally {
    io.rmSync(temporary, { force: true });
  }
  if (io.readFileSync(args.filePath, 'utf8') !== source) throw new Error(args.verificationMessage);
  return source;
}

async function openJournalFile(path: string, flags: string, mode?: number): Promise<Pick<FileHandle, 'writeFile' | 'sync' | 'close'>> {
  return open(path, flags, mode);
}

export async function writeDurableJsonJournalAsync(args: {
  filePath: string;
  value: unknown;
  mode: 'create' | 'replace';
  verificationMessage?: string;
}, ioOverrides: Partial<{
  open: typeof openJournalFile;
  link: typeof link;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  rename: typeof rename;
  rm: typeof rm;
}> = {}): Promise<string> {
  const io = { open: openJournalFile, link, readFile, rename, rm, ...ioOverrides };
  const source = `${JSON.stringify(args.value, null, 2)}\n`;
  const directory = dirname(args.filePath);
  const temporary = `${args.filePath}.${randomUUID()}.tmp`;
  const handle = await io.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(source, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (args.mode === 'create') await io.link(temporary, args.filePath);
    else await io.rename(temporary, args.filePath);
    const parent = await io.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await io.rm(temporary, { force: true });
  }
  if (await io.readFile(args.filePath, 'utf8') !== source) {
    throw new Error(args.verificationMessage ?? `Journal persistence could not be verified: ${args.filePath}.`);
  }
  return source;
}
