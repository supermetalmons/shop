export async function runCaptureOverlap({ frames, acquire, complete, commit, check = () => {} }) {
  const iterator = frames[Symbol.iterator]();
  let current = iterator.next();
  if (current.done) return;
  check();
  let acquired = await acquire(current.value, { check });
  while (!current.done) {
    check();
    const next = iterator.next();
    let completionError;
    const checkAcquisition = () => {
      check();
      if (completionError) throw completionError;
    };
    const completion = Promise.resolve().then(() => complete(current.value, acquired)).catch(error => {
      completionError = error;
      throw error;
    });
    const acquisition = next.done ? Promise.resolve() : Promise.resolve().then(() => {
      checkAcquisition();
      return acquire(next.value, { check: checkAcquisition });
    });
    const [completed, following] = await Promise.allSettled([completion, acquisition]);
    if (completed.status === 'rejected') throw completed.reason;
    check();
    await commit(current.value, completed.value);
    if (following.status === 'rejected') throw following.reason;
    current = next;
    acquired = following.value;
  }
}
