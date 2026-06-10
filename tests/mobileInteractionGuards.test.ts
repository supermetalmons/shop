import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TIME_BETWEEN_TOUCHSTARTS,
  createMobileTapCandidate,
  findTouchByIdentifier,
  getTouchstartGuardResult,
  isEditableMobileInteractionTarget,
  isMobileUserAgent,
  prepareMobileTouchActivation,
  shouldCompleteMobileTapCandidate,
  shouldPreventMobileContextMenu,
  updateMobileTapCandidateForMove,
} from '../src/lib/mobileInteractionGuards.ts';

type FakeElement = {
  tagName: string;
  parentElement?: FakeElement | null;
  closest?: (selector: string) => FakeElement | null;
  getAttribute?: (name: string) => string | null;
};

function fakeTarget(editableElement: FakeElement | null): EventTarget {
  return {
    closest: () => editableElement,
  } as unknown as EventTarget;
}

function fakeContentEditableTarget(value: string | null): EventTarget {
  return fakeTarget({
    tagName: 'DIV',
    getAttribute: (name: string) => (name === 'contenteditable' ? value : null),
  });
}

function fakeTouchList(touches: Array<Pick<Touch, 'identifier' | 'clientX' | 'clientY'>>): TouchList {
  return {
    length: touches.length,
    item: (index: number) => (touches[index] ?? null) as Touch | null,
  } as TouchList;
}

function withNavigatorUserAgent<T>(userAgent: string, callback: () => T): T {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent },
  });

  try {
    return callback();
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  }
}

test('mobile touchstart guard allows the first touch', () => {
  const result = getTouchstartGuardResult({
    currentTime: 1,
    isMobile: true,
    lastTouchStartTime: null,
  });

  assert.equal(result.shouldPrevent, false);
  assert.equal(result.nextLastTouchStartTime, 1);
});

test('mobile touchstart guard prevents rapid repeated touchstarts without advancing timestamp', () => {
  const result = getTouchstartGuardResult({
    currentTime: 1 + MIN_TIME_BETWEEN_TOUCHSTARTS - 1,
    isMobile: true,
    lastTouchStartTime: 1,
  });

  assert.equal(result.shouldPrevent, true);
  assert.equal(result.nextLastTouchStartTime, 1);
});

test('mobile touchstart guard allows touchstarts after the suppression window', () => {
  const result = getTouchstartGuardResult({
    currentTime: 1 + MIN_TIME_BETWEEN_TOUCHSTARTS,
    isMobile: true,
    lastTouchStartTime: 1,
  });

  assert.equal(result.shouldPrevent, false);
  assert.equal(result.nextLastTouchStartTime, 1 + MIN_TIME_BETWEEN_TOUCHSTARTS);
});

test('touchstart guard is a no-op for non-mobile targets', () => {
  const result = getTouchstartGuardResult({
    currentTime: 2,
    isMobile: false,
    lastTouchStartTime: 1,
  });

  assert.equal(result.shouldPrevent, false);
  assert.equal(result.nextLastTouchStartTime, 1);
});

test('mobile user agent detection matches iOS and Android mobile browsers', () => {
  assert.equal(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), true);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36'), true);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15'), false);
});

test('mobile touch activation prevents default for allowed mobile events', () => {
  let prevented = false;
  const activated = withNavigatorUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', () =>
    prepareMobileTouchActivation({
      preventDefault: () => {
        prevented = true;
      },
    }),
  );

  assert.equal(activated, true);
  assert.equal(prevented, true);
});

test('mobile touch activation ignores events already prevented by the global guard', () => {
  let prevented = false;
  const activated = withNavigatorUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', () =>
    prepareMobileTouchActivation({
      defaultPrevented: true,
      preventDefault: () => {
        prevented = true;
      },
    }),
  );

  assert.equal(activated, false);
  assert.equal(prevented, false);
});

test('mobile tap candidate completes without meaningful movement', () => {
  const candidate = createMobileTapCandidate({ identifier: 7, clientX: 100, clientY: 200 });

  assert.equal(shouldCompleteMobileTapCandidate(candidate, { identifier: 7 }), true);
});

test('mobile tap candidate cancels after movement exceeds threshold', () => {
  const candidate = createMobileTapCandidate({ identifier: 7, clientX: 100, clientY: 200 });
  const moved = updateMobileTapCandidateForMove(candidate, {
    identifier: 7,
    clientX: 113,
    clientY: 200,
  });

  assert.equal(moved?.canceled, true);
  assert.equal(shouldCompleteMobileTapCandidate(moved, { identifier: 7 }), false);
});

test('mobile tap candidate ignores unrelated touch identifiers', () => {
  const candidate = createMobileTapCandidate({ identifier: 7, clientX: 100, clientY: 200 });
  const moved = updateMobileTapCandidateForMove(candidate, {
    identifier: 8,
    clientX: 200,
    clientY: 300,
  });

  assert.equal(moved, candidate);
  assert.equal(shouldCompleteMobileTapCandidate(candidate, { identifier: 8 }), false);
});

test('touch lookup returns only the matching identifier', () => {
  const touch = findTouchByIdentifier(fakeTouchList([
    { identifier: 1, clientX: 100, clientY: 200 },
    { identifier: 7, clientX: 300, clientY: 400 },
  ]), 7);

  assert.equal(touch?.identifier, 7);
  assert.equal(findTouchByIdentifier(fakeTouchList([{ identifier: 1, clientX: 0, clientY: 0 }]), 7), null);
});

test('mobile tap candidate does not complete after touchcancel-style clearing', () => {
  assert.equal(shouldCompleteMobileTapCandidate(null, { identifier: 7 }), false);
});

test('editable mobile interaction detection includes form controls', () => {
  const inputTarget = fakeTarget({ tagName: 'INPUT' });
  const selectTarget = fakeTarget({ tagName: 'SELECT' });

  assert.equal(isEditableMobileInteractionTarget(inputTarget), true);
  assert.equal(isEditableMobileInteractionTarget(selectTarget), true);
  assert.equal(shouldPreventMobileContextMenu(inputTarget), false);
  assert.equal(shouldPreventMobileContextMenu(selectTarget), false);
});

test('editable mobile interaction detection includes editable content', () => {
  const editableTarget = fakeContentEditableTarget('plaintext-only');

  assert.equal(isEditableMobileInteractionTarget(editableTarget), true);
  assert.equal(shouldPreventMobileContextMenu(editableTarget), false);
});

test('non-editable mobile interaction targets still suppress context menus', () => {
  const nonEditableTarget = fakeTarget(null);
  const explicitNonEditableTarget = fakeContentEditableTarget('false');

  assert.equal(isEditableMobileInteractionTarget(nonEditableTarget), false);
  assert.equal(shouldPreventMobileContextMenu(nonEditableTarget), true);
  assert.equal(isEditableMobileInteractionTarget(explicitNonEditableTarget), false);
  assert.equal(shouldPreventMobileContextMenu(explicitNonEditableTarget), true);
});
