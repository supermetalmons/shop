import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type LocalFileSnapshot =
  | Readonly<{ exists: false }>
  | Readonly<{
      exists: true;
      kind: 'file';
      contentBase64: string;
      mode: number;
      device: number;
      inode: number;
    }>
  | Readonly<{
      exists: true;
      kind: 'symlink';
      target: string;
      mode: number;
      device: number;
      inode: number;
    }>;

export function localPathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

export function snapshotLocalFile(filePath: string): LocalFileSnapshot {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
  if (fileStat.isSymbolicLink()) {
    return {
      exists: true,
      kind: 'symlink',
      target: readlinkSync(filePath),
      mode: fileStat.mode & 0o7777,
      device: fileStat.dev,
      inode: fileStat.ino,
    };
  }
  if (!fileStat.isFile()) {
    throw new Error(`Expected a regular file or symlink: ${filePath}`);
  }
  return {
    exists: true,
    kind: 'file',
    contentBase64: readFileSync(filePath).toString('base64'),
    mode: fileStat.mode & 0o7777,
    device: fileStat.dev,
    inode: fileStat.ino,
  };
}

export function sha256LocalSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): string {
  return createHash('sha256')
    .update(
      snapshot.kind === 'symlink'
        ? Buffer.from(snapshot.target, 'utf8')
        : readFileSync(filePath),
    )
    .digest('hex');
}

export function localFileMatchesSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const mode = fileStat.mode & 0o7777;
  if (snapshot.kind === 'symlink') {
    return (
      fileStat.isSymbolicLink() &&
      mode === snapshot.mode &&
      readlinkSync(filePath) === snapshot.target
    );
  }
  return (
    fileStat.isFile() &&
    mode === snapshot.mode &&
    readFileSync(filePath).equals(
      Buffer.from(snapshot.contentBase64, 'base64'),
    )
  );
}

export function localFileHasSnapshotIdentity(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  return (
    fileStat.dev === snapshot.device &&
    fileStat.ino === snapshot.inode &&
    (snapshot.kind === 'symlink'
      ? fileStat.isSymbolicLink()
      : fileStat.isFile())
  );
}

export function localFileMatchesPreparedSnapshot(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): boolean {
  return (
    localFileHasSnapshotIdentity(filePath, snapshot) &&
    localFileMatchesSnapshot(filePath, snapshot)
  );
}

export function localPathMatchesSnapshot(
  filePath: string,
  snapshot: LocalFileSnapshot,
): boolean {
  if (!snapshot.exists) return !localPathEntryExists(filePath);
  return localFileMatchesPreparedSnapshot(filePath, snapshot);
}

export function restoreLocalFile(filePath: string, snapshot: LocalFileSnapshot): void {
  if (!snapshot.exists) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot.kind === 'symlink') {
    try {
      symlinkSync(snapshot.target, filePath);
      if (!localFileMatchesSnapshot(filePath, snapshot)) {
        throw new Error(
          `Restored symlink does not match the original target and mode: ${filePath}`,
        );
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)?.code === 'EEXIST' &&
        localFileMatchesSnapshot(filePath, snapshot)
      ) {
        return;
      }
      throw error;
    }
    return;
  }
  try {
    writeFileSync(filePath, Buffer.from(snapshot.contentBase64, 'base64'), {
      mode: snapshot.mode,
      flag: 'wx',
    });
    chmodSync(filePath, snapshot.mode);
    if (!localFileMatchesSnapshot(filePath, snapshot)) {
      throw new Error(
        `Restored file does not match the original bytes and mode: ${filePath}`,
      );
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'EEXIST' &&
      localFileMatchesSnapshot(filePath, snapshot)
    ) {
      return;
    }
    throw error;
  }
}

export function restoreLocalFileExclusively(
  filePath: string,
  snapshot: Exclude<LocalFileSnapshot, { exists: false }>,
): Exclude<LocalFileSnapshot, { exists: false }> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot.kind === 'symlink') {
    symlinkSync(snapshot.target, filePath);
  } else {
    writeFileSync(
      filePath,
      Buffer.from(snapshot.contentBase64, 'base64'),
      {
        mode: snapshot.mode,
        flag: 'wx',
      },
    );
    chmodSync(filePath, snapshot.mode);
  }
  const restoredSnapshot = snapshotLocalFile(filePath);
  if (
    !restoredSnapshot.exists ||
    !localFileMatchesSnapshot(filePath, snapshot)
  ) {
    throw new Error(
      `Exclusively restored file does not match its prepared snapshot: ${filePath}`,
    );
  }
  return restoredSnapshot;
}
