let running = 0;
const waiting: { start: () => void; priority: 'foreground' | 'background' }[] = [];

export async function runPreorderStatus<T>(request: () => Promise<T>, priority: 'foreground' | 'background' = 'foreground'): Promise<T> {
  if (running >= 2) await new Promise<void>(start => waiting.push({ start, priority }));
  else running += 1;
  try { return await request(); }
  finally {
    const firstForeground = waiting.findIndex(entry => entry.priority === 'foreground');
    const next = waiting.splice(firstForeground >= 0 ? firstForeground : 0, 1)[0];
    if (next) next.start(); else running -= 1;
  }
}
