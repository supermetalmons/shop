import type { OverlayRect } from '../shop/reveal/types';

export function ethereumRevealTiles(count: number, viewport: OverlayRect): OverlayRect[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const width = Math.max(1, viewport.width * 0.88);
  const height = Math.max(1, viewport.height * 0.76);
  let columns = 1;
  let size = 0;
  for (let candidate = 1; candidate <= count; candidate++) {
    const next = Math.min(width / candidate, height / Math.ceil(count / candidate));
    if (next > size) { size = next; columns = candidate; }
  }
  const rows = Math.ceil(count / columns);
  const tileSize = Math.min(size * 0.82, 220);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const itemsInRow = Math.min(columns, count - row * columns);
    return {
      left: viewport.left + (viewport.width - itemsInRow * size) / 2 + (index % columns) * size + (size - tileSize) / 2,
      top: viewport.top + (viewport.height - rows * size) / 2 + row * size + (size - tileSize) / 2,
      width: tileSize,
      height: tileSize,
    };
  });
}
