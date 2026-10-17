export async function recoverNativeCapture({ id, committedFrames, cause, retryAllowed = true }, remount) {
  if (!Number.isSafeInteger(committedFrames) || committedFrames < 0) throw new Error('Invalid committed native frame count.');
  if (committedFrames > 0) {
    throw new Error(`Native rest reference mismatch: card ${id} requires a fresh owned session and exact rest proofs before retaining ${committedFrames} native frames after ${cause.message}`, { cause });
  }
  if (!retryAllowed) throw cause;
  return remount();
}
