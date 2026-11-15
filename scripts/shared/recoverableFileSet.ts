import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FileSetRecoveryEntry = { path: string; previous: Buffer | null; nextSha256: string };
type OutputFile = { path: string; bytes: Buffer; previous: Buffer | null };

export async function readOptionalFile(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const equal = (left: Buffer | null, right: Buffer | null) => left === null ? right === null : right !== null && left.equals(right);

export function createRecoverableFileSet(options: {
  stateDirectory: string;
  decodeJournal: (value: unknown) => FileSetRecoveryEntry[];
  encodeJournal: (entries: FileSetRecoveryEntry[]) => unknown;
  conflictMessage: (path: string, phase: 'write' | 'recovery') => string;
  staging: 'directory' | 'flat';
  restoreUnchanged?: boolean;
}) {
  const state = options.stateDirectory;
  const journalPath = join(state, 'recovery.json');
  const stage = options.staging === 'directory' ? join(state, 'staging') : state;
  const stagedPath = (index: number) => join(stage, options.staging === 'directory' ? String(index) : `${index}.tmp`);

  async function recover(): Promise<void> {
    const bytes = await readOptionalFile(journalPath);
    if (!bytes) return;
    const entries = options.decodeJournal(JSON.parse(bytes.toString('utf8')));
    const pending: FileSetRecoveryEntry[] = [];
    for (const entry of entries) {
      const current = await readOptionalFile(entry.path);
      if (equal(current, entry.previous)) continue;
      if (current === null || sha256(current) !== entry.nextSha256) {
        throw new Error(options.conflictMessage(entry.path, 'recovery'));
      }
      pending.push(entry);
    }
    for (const entry of options.restoreUnchanged ? entries : pending) {
      if (entry.previous === null) await rm(entry.path, { force: options.restoreUnchanged === true });
      else {
        const temporary = join(state, 'restore.tmp');
        await writeFile(temporary, entry.previous);
        await rename(temporary, entry.path);
      }
    }
    await rm(journalPath);
  }

  async function write(outputs: OutputFile[]): Promise<void> {
    if (options.staging === 'directory') await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    try {
      for (const [index, output] of outputs.entries()) {
        await mkdir(dirname(output.path), { recursive: true });
        await writeFile(stagedPath(index), output.bytes, { flag: options.staging === 'directory' ? 'wx' : 'w' });
        if (!equal(await readOptionalFile(output.path), output.previous)) {
          throw new Error(options.conflictMessage(output.path, 'write'));
        }
      }
      const journal = options.encodeJournal(outputs.map(output => ({
        path: output.path, previous: output.previous, nextSha256: sha256(output.bytes),
      })));
      await writeFile(join(state, 'recovery.tmp'), JSON.stringify(journal));
      await rename(join(state, 'recovery.tmp'), journalPath);
      for (const [index, output] of outputs.entries()) await rename(stagedPath(index), output.path);
      await rm(journalPath);
    } catch (error) {
      await recover();
      throw error;
    } finally {
      if (options.staging === 'directory') await rm(stage, { recursive: true, force: true });
      else await Promise.all([...outputs.map((_, index) => stagedPath(index)), join(state, 'recovery.tmp')]
        .map(file => rm(file, { force: true })));
    }
  }

  return { recover, write };
}
