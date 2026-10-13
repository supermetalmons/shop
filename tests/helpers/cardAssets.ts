import type { TestContext } from 'node:test';

class ControlledCardImage {
  src = '';
  decoding = '';
  fetchPriority = '';
  complete: boolean;
  naturalWidth: number;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  resolveDecode!: () => void;
  rejectDecode!: (error: Error) => void;
  decodeCalls = 0;
  private decoded = new Promise<void>((resolve, reject) => {
    this.resolveDecode = resolve;
    this.rejectDecode = reject;
  });

  constructor(cached: boolean) {
    this.complete = cached;
    this.naturalWidth = cached ? 1000 : 0;
  }

  decode() {
    this.decodeCalls += 1;
    return this.decoded;
  }

  load() {
    this.complete = true;
    this.naturalWidth = 1000;
    this.onload?.();
  }
}

export function mockCardAssetImages(t: TestContext, cached = false) {
  const images: ControlledCardImage[] = [];
  t.mock.method(globalThis, 'Image', function () {
    const image = new ControlledCardImage(cached);
    images.push(image);
    return image as unknown as HTMLImageElement;
  });
  return images;
}
