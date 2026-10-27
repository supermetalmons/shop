import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

async function removeOwner(path: string, marker: string): Promise<void> {
  await rm(join(path, marker), { force: true });
  try { await rmdir(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function recoverLock(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error(`Legacy or invalid metadata lock at ${path}. Confirm no metadata operation is running, then remove this lock and retry.`);
    }
    const entries = await readdir(path);
    if (entries.length === 0) return;
    if (entries.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(entries[0])) {
      throw new Error(`Unrecognized metadata lock at ${path}. Confirm no metadata operation is running, then remove this lock and retry.`);
    }
    let owner: { pid?: number; host?: string; id?: string };
    try { owner = JSON.parse(await readFile(join(path, entries[0]), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Unreadable metadata lock at ${path}. Confirm no metadata operation is running, then remove this lock and retry.`, { cause: error });
    }
    if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid! < 1 ||
      `${owner.id}.json` !== entries[0]) throw new Error(`Another metadata operation owns ${path}`);
    try { process.kill(owner.pid!, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await removeOwner(path, entries[0]);
      return;
    }
    throw new Error(`Another metadata operation owns ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function withMetadataLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const path = resolve(lockPath);
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
  const id = randomUUID();
  const marker = `${id}.json`;
  let acquired = false;
  try {
    await writeFile(join(temporary, marker), JSON.stringify({ id, pid: process.pid, host: hostname() }), { flag: 'wx' });
    while (!acquired) {
      try {
        await rename(temporary, path);
        acquired = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await recoverLock(path);
      }
    }
    return await work();
  } finally {
    if (acquired) await removeOwner(path, marker);
    else await rm(temporary, { recursive: true, force: true });
  }
}
