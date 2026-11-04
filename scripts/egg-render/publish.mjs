import { constants, lstatSync } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function publishStudy(staging, output, ids, signal) {
  signal?.throwIfAborted();
  const finishes = (await readdir(staging, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const frames = finishes.flatMap(({ name }) => ids.map(id => join(name, `${id}.png`)));
  const backup = join(output, '.egg-publish');
  try {
    await mkdir(backup);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another publication or recovery directory exists: ${backup}`);
    throw error;
  }

  const created = [];
  const installed = [];
  let keepBackup = false;
  try {
    const missingFolders = [];
    for (const { name } of finishes) {
      const folder = join(output, name);
      const stat = lstatSync(folder, { throwIfNoEntry: false });
      if (!stat) missingFolders.push(folder);
      else {
        if (!stat.isDirectory()) throw new Error(`Expected a finish directory: ${folder}`);
        await access(folder, constants.W_OK | constants.X_OK);
      }
      await mkdir(join(backup, name));
    }

    const files = [];
    for (const relative of [...frames, 'comparison.png']) {
      signal?.throwIfAborted();
      const source = join(staging, relative);
      const target = join(output, relative);
      const prior = lstatSync(target, { throwIfNoEntry: false });
      if (!lstatSync(source).isFile()) throw new Error(`Expected a staged image file: ${source}`);
      if (prior && !prior.isFile()) throw new Error(`Expected a regular destination file: ${target}`);
      const saved = prior ? join(backup, relative) : null;
      if (saved) await copyFile(target, saved, constants.COPYFILE_FICLONE);
      files.push({ source, target, saved });
    }

    for (const folder of missingFolders) {
      await mkdir(folder);
      created.push(folder);
    }
    for (const file of files) {
      signal?.throwIfAborted();
      await rename(file.source, file.target);
      installed.push(file);
    }
    signal?.throwIfAborted();
    return frames.length;
  } catch (failure) {
    const errors = [];
    for (const { target, saved } of installed.reverse()) {
      try {
        if (saved) await rename(saved, target);
        else await unlink(target);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const folder of created.reverse()) {
      try {
        await rmdir(folder);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) errors.push(error);
      }
    }
    if (errors.length) {
      keepBackup = true;
      throw new AggregateError([failure, ...errors], `${failure.message}; rollback failed (${errors[0].message}). Recovery files: ${backup}`);
    }
    throw failure;
  } finally {
    if (!keepBackup) await rm(backup, { recursive: true, force: true });
  }
}
