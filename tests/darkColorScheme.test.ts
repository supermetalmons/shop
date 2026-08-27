import assert from 'node:assert/strict';
import test from 'node:test';
import { createDarkColorSchemeStore } from '../src/hooks/useDarkColorScheme.ts';

type ListenerMode = 'modern' | 'legacy';

function createMediaQueryFixture(mode: ListenerMode, initialMatches = false) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const methods = mode === 'modern'
    ? {
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }
    : {
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
      };
  const media = {
    get matches() {
      return matches;
    },
    ...methods,
  } as unknown as MediaQueryList;

  return {
    media,
    listenerCount: () => listeners.size,
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    },
  };
}

for (const mode of ['modern', 'legacy'] as const) {
  test(`dark color-scheme store reacts through ${mode} media-query listeners`, () => {
    const fixture = createMediaQueryFixture(mode);
    const store = createDarkColorSchemeStore(() => fixture.media);
    const snapshots: boolean[] = [];
    const firstUnsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
    const secondUnsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

    assert.equal(store.getSnapshot(), false);
    assert.equal(fixture.listenerCount(), 1);

    fixture.setMatches(true);
    assert.deepEqual(snapshots, [true, true]);

    firstUnsubscribe();
    assert.equal(fixture.listenerCount(), 1);
    secondUnsubscribe();
    assert.equal(fixture.listenerCount(), 0);
  });
}

test('dark color-scheme store safely falls back to light without matchMedia', () => {
  const store = createDarkColorSchemeStore(() => undefined);
  const unsubscribe = store.subscribe(() => assert.fail('Unavailable media should not notify'));

  assert.equal(store.getSnapshot(), false);
  assert.doesNotThrow(unsubscribe);
});
