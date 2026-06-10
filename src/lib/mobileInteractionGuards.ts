export const MIN_TIME_BETWEEN_TOUCHSTARTS = 555;
export const MOBILE_TAP_MOVE_CANCEL_PX = 12;

type TouchstartGuardInput = {
  currentTime: number;
  isMobile: boolean;
  lastTouchStartTime: number | null;
};

type TouchstartPreventableEvent = {
  timeStamp: number;
  target?: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type MobileActivationEvent = {
  preventDefault: () => void;
};

export type TouchstartGuardResult = {
  nextLastTouchStartTime: number | null;
  shouldPrevent: boolean;
};

export type MobileTapCandidate = {
  identifier: number;
  startX: number;
  startY: number;
  canceled: boolean;
};

export function isMobileUserAgent(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Android|Windows Phone|IEMobile|Mobile|Opera Mini/i.test(userAgent);
}

export function isMobileBrowser(): boolean {
  return typeof navigator !== 'undefined' && isMobileUserAgent(navigator.userAgent);
}

export function isEditableMobileInteractionTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;

  const targetElement = target as Element & { parentElement?: Element | null };
  const closestSource = typeof targetElement.closest === 'function'
    ? targetElement
    : targetElement.parentElement;
  const editableElement = closestSource && typeof closestSource.closest === 'function'
    ? closestSource.closest('input, textarea, select, [contenteditable]')
    : null;
  if (!editableElement) return false;

  const tagName = editableElement.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;

  if (typeof HTMLElement !== 'undefined' && editableElement instanceof HTMLElement) {
    return editableElement.isContentEditable;
  }

  const contentEditable = editableElement.getAttribute('contenteditable');
  return contentEditable !== null && contentEditable.toLowerCase() !== 'false';
}

export function shouldPreventMobileContextMenu(target: EventTarget | null): boolean {
  return !isEditableMobileInteractionTarget(target);
}

export function getTouchstartGuardResult({
  currentTime,
  isMobile,
  lastTouchStartTime,
}: TouchstartGuardInput): TouchstartGuardResult {
  if (!isMobile || lastTouchStartTime === null) {
    return {
      shouldPrevent: false,
      nextLastTouchStartTime: isMobile ? currentTime : lastTouchStartTime,
    };
  }

  if (currentTime - lastTouchStartTime < MIN_TIME_BETWEEN_TOUCHSTARTS) {
    return {
      shouldPrevent: true,
      nextLastTouchStartTime: lastTouchStartTime,
    };
  }

  return {
    shouldPrevent: false,
    nextLastTouchStartTime: currentTime,
  };
}

let installed = false;
let lastTouchStartTime: number | null = null;

export function preventTouchstartIfNeeded(event: TouchstartPreventableEvent): boolean {
  if (!isMobileBrowser()) return false;
  if (isEditableMobileInteractionTarget(event.target ?? null)) return false;

  const result = getTouchstartGuardResult({
    currentTime: event.timeStamp,
    isMobile: true,
    lastTouchStartTime,
  });
  lastTouchStartTime = result.nextLastTouchStartTime;

  if (result.shouldPrevent) {
    event.preventDefault();
    event.stopPropagation();
  }

  return result.shouldPrevent;
}

export function prepareMobileTouchActivation(event: MobileActivationEvent): boolean {
  if (!isMobileBrowser()) return false;

  event.preventDefault();
  return true;
}

export function findTouchByIdentifier(touchList: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touchList.length; index += 1) {
    const touch = touchList.item(index);
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

export function createMobileTapCandidate(touch: Pick<Touch, 'identifier' | 'clientX' | 'clientY'>): MobileTapCandidate {
  return {
    identifier: touch.identifier,
    startX: touch.clientX,
    startY: touch.clientY,
    canceled: false,
  };
}

export function updateMobileTapCandidateForMove<T extends MobileTapCandidate>(
  candidate: T | null,
  touch: Pick<Touch, 'identifier' | 'clientX' | 'clientY'> | null,
  moveCancelPx = MOBILE_TAP_MOVE_CANCEL_PX,
): T | null {
  if (!candidate || !touch || touch.identifier !== candidate.identifier) return candidate;
  const deltaX = touch.clientX - candidate.startX;
  const deltaY = touch.clientY - candidate.startY;
  if (Math.hypot(deltaX, deltaY) <= moveCancelPx) return candidate;
  return {
    ...candidate,
    canceled: true,
  };
}

export function shouldCompleteMobileTapCandidate(
  candidate: MobileTapCandidate | null,
  touch: Pick<Touch, 'identifier'> | null,
): boolean {
  return Boolean(candidate && touch && touch.identifier === candidate.identifier && !candidate.canceled);
}

export function installMobileInteractionGuards(): boolean {
  if (installed || typeof document === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  if (!isMobileBrowser()) {
    return false;
  }

  installed = true;
  lastTouchStartTime = null;

  document.addEventListener(
    'touchstart',
    (event) => {
      preventTouchstartIfNeeded(event);
    },
    { passive: false },
  );

  document.addEventListener(
    'contextmenu',
    (event) => {
      if (shouldPreventMobileContextMenu(event.target)) {
        event.preventDefault();
      }
    },
    false,
  );

  return true;
}
