export function createMiNoteFrameLoop(
  active: () => boolean,
  render: (now: number, deltaSeconds: number) => boolean | void,
) {
  let disposed = false;
  let frameId = 0;
  let lastTime = 0;
  let lastRenderTime = 0;

  const invalidate = () => {
    if (!disposed && active() && !frameId && !document.hidden) frameId = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(frameId);
    frameId = 0;
  };

  function frame(now: number) {
    frameId = 0;
    if (disposed || !active() || document.hidden) return;
    const elapsed = lastTime ? now - lastTime : Math.min(now - lastRenderTime, 16.67);
    const deltaSeconds = Math.min(elapsed / 1000, 0.05);
    lastTime = lastRenderTime = now;
    const moving = render(now, deltaSeconds);
    if (moving) invalidate();
    else if (moving === false) lastTime = 0;
  }

  return {
    invalidate,
    stop,
    resetClock: () => { lastTime = 0; },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
