import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';

export type OptimisticTextFileWriteIo = {
  close: typeof closeSync;
  write: typeof writeSync;
};

export type OptimisticTextFileWriteArgs = {
  filePath: string;
  expectedContent: string;
  nextContent: string;
  targetLabel?: string;
};

export class OptimisticTextFilePostCommitVerificationError extends Error {
  constructor(filePath: string, targetLabel: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${sentenceCase(targetLabel)} was durably committed, but post-commit verification failed for ${filePath}: ${detail}`,
      { cause },
    );
    this.name = 'OptimisticTextFilePostCommitVerificationError';
  }
}

export function isOptimisticTextFilePostCommitVerificationError(
  error: unknown,
): error is OptimisticTextFilePostCommitVerificationError {
  return error instanceof OptimisticTextFilePostCommitVerificationError;
}

const DEFAULT_OPTIMISTIC_TEXT_FILE_WRITE_IO: OptimisticTextFileWriteIo = {
  close: closeSync,
  write: writeSync,
};

function sentenceCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function readFileDescriptorBytes(
  fd: number,
  targetLabel: string,
): Buffer {
  const fileStat = fstatSync(fd);
  if (!fileStat.isFile()) {
    throw new Error(`${sentenceCase(targetLabel)} target is not a regular file`);
  }
  const size = fileStat.size;
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(
      fd,
      content,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) {
    throw new Error(
      `${sentenceCase(targetLabel)} changed while it was being read (expected ${size} bytes, read ${offset})`,
    );
  }
  return content;
}

function writeFileDescriptorBytes(
  fd: number,
  content: Buffer,
  targetLabel: string,
  io: OptimisticTextFileWriteIo,
): void {
  let offset = 0;
  while (offset < content.length) {
    const bytesWritten = io.write(
      fd,
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesWritten <= 0) {
      throw new Error(
        `Could not make progress writing ${targetLabel} at byte ${offset}`,
      );
    }
    offset += bytesWritten;
  }
  ftruncateSync(fd, content.length);
  fsyncSync(fd);
}

function assertFileDescriptorContent(
  fd: number,
  expected: Buffer,
  filePath: string,
  targetLabel: string,
): void {
  const current = readFileDescriptorBytes(fd, targetLabel);
  if (!current.equals(expected)) {
    throw new Error(
      `${sentenceCase(targetLabel)} changed after it was prepared: ${filePath}`,
    );
  }
}

function assertPathStillReferencesFileDescriptor(
  filePath: string,
  fd: number,
  targetLabel: string,
): void {
  const pathStat = statSync(filePath);
  const descriptorStat = fstatSync(fd);
  if (
    pathStat.dev !== descriptorStat.dev ||
    pathStat.ino !== descriptorStat.ino
  ) {
    throw new Error(
      `${sentenceCase(targetLabel)} target changed after it was opened: ${filePath}`,
    );
  }
}

export function writeOptimisticTextFile(
  args: OptimisticTextFileWriteArgs,
  ioOverrides: Partial<OptimisticTextFileWriteIo> = {},
): void {
  const targetLabel = args.targetLabel || 'text file';
  const io = {
    ...DEFAULT_OPTIMISTIC_TEXT_FILE_WRITE_IO,
    ...ioOverrides,
  };
  const expected = Buffer.from(args.expectedContent, 'utf8');
  const next = Buffer.from(args.nextContent, 'utf8');
  let fd: number | undefined;
  let mutationCommitted = false;
  let operationFailed = false;
  try {
    // r+ deliberately requires an existing writable target and follows
    // symlinks. Mutating the opened inode preserves hard links, ownership,
    // permissions, ACLs, and extended attributes.
    fd = openSync(args.filePath, 'r+');
    assertFileDescriptorContent(
      fd,
      expected,
      args.filePath,
      targetLabel,
    );
    assertPathStillReferencesFileDescriptor(args.filePath, fd, targetLabel);
    assertFileDescriptorContent(
      fd,
      expected,
      args.filePath,
      targetLabel,
    );
    assertPathStillReferencesFileDescriptor(args.filePath, fd, targetLabel);
    if (next.equals(expected)) return;

    try {
      writeFileDescriptorBytes(fd, next, targetLabel, io);
      mutationCommitted = true;
    } catch (writeError) {
      try {
        writeFileDescriptorBytes(fd, expected, targetLabel, io);
      } catch (restoreError) {
        throw new Error(
          `${sentenceCase(targetLabel)} write failed and restoring the prepared bytes also failed: ${
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError)
          }`,
          { cause: writeError },
        );
      }
      throw writeError;
    }
    // Verification happens only after fsync has completed. A failure here
    // reports pathname replacement or post-write interference, but must never
    // restore older bytes over the durable commit.
    try {
      assertPathStillReferencesFileDescriptor(
        args.filePath,
        fd,
        targetLabel,
      );
      assertFileDescriptorContent(
        fd,
        next,
        args.filePath,
        targetLabel,
      );
    } catch (verificationError) {
      throw new OptimisticTextFilePostCommitVerificationError(
        args.filePath,
        targetLabel,
        verificationError,
      );
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (fd != null) {
      try {
        io.close(fd);
      } catch (closeError) {
        // fsync completed before mutationCommitted was set. At that point the
        // new bytes are durable, so a later close error must not make callers
        // treat the write as failed and roll back related files. Likewise,
        // never replace an earlier preparation/write error.
        if (!mutationCommitted && !operationFailed) throw closeError;
      }
    }
  }
}
