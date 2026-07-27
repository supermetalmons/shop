let activeBodyScrollLocks = 0;
let previousBodyOverflow: string | undefined;

export function acquireBodyScrollLock() {
  if (activeBodyScrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
  }
  activeBodyScrollLocks += 1;
  document.body.style.overflow = 'hidden';
}

export function releaseBodyScrollLock() {
  if (activeBodyScrollLocks === 0) return;
  activeBodyScrollLocks -= 1;
  if (activeBodyScrollLocks !== 0) return;
  document.body.style.overflow = previousBodyOverflow ?? '';
  previousBodyOverflow = undefined;
}
