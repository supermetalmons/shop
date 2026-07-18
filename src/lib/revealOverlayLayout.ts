export type PonchoDrifellaFrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PonchoDrifellaPackFrameRect = PonchoDrifellaFrameRect;
export type PonchoDrifellaViewportFrameRect = PonchoDrifellaFrameRect;

type RevealOverlayCssVarName =
  | '--reveal-target-left'
  | '--reveal-target-top'
  | '--reveal-target-width'
  | '--reveal-target-height'
  | '--reveal-start-x'
  | '--reveal-start-y'
  | '--reveal-start-scale-x'
  | '--reveal-start-scale-y'
  | '--poncho-card-left'
  | '--poncho-card-top'
  | '--poncho-card-width'
  | '--poncho-card-height'
  | '--poncho-card-row-left-0'
  | '--poncho-card-row-left-1'
  | '--poncho-card-row-left-2'
  | '--poncho-card-row-top'
  | '--poncho-card-row-width'
  | '--poncho-card-row-height'
  | '--poncho-card-row-start-dx-0'
  | '--poncho-card-row-start-dx-1'
  | '--poncho-card-row-start-dx-2'
  | '--poncho-card-row-start-dy'
  | '--poncho-card-row-start-scale-x'
  | '--poncho-card-row-start-scale-y'
  | '--poncho-pack-discard-delay'
  | '--poncho-pack-discard-duration';

export type RevealOverlayStyleVars = Partial<Record<RevealOverlayCssVarName, string>>;

type PonchoDrifellaCardLayoutRect = Pick<PonchoDrifellaViewportFrameRect, 'top' | 'width' | 'height'>;
type PonchoDrifellaCardRowLayoutRect = PonchoDrifellaCardLayoutRect & Pick<PonchoDrifellaFrameRect, 'left'>;
export type RevealOverlayViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type PonchoDrifellaLayoutViewport = Readonly<RevealOverlayViewport>;
type RevealOverlayStyleMode = 'default' | 'poncho-card';

type PonchoDrifellaCardLayout = {
  packCardRect: PonchoDrifellaPackFrameRect;
  viewportRowSlots: readonly [
    PonchoDrifellaViewportFrameRect,
    PonchoDrifellaViewportFrameRect,
    PonchoDrifellaViewportFrameRect,
  ];
  rowStartDeltas: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  rowStartScale: { x: number; y: number };
};

const PONCHO_DRIFELLA_SOURCE_FRAME_SIZE = 1440;
const PONCHO_DRIFELLA_ROW_GUTTER_X_RATIO = 0.075;
const PONCHO_DRIFELLA_ROW_GUTTER_Y_RATIO = 0.07;
const PONCHO_DRIFELLA_ROW_GAP_RATIO = 0.028;
const PONCHO_DRIFELLA_ROW_MAX_HEIGHT_RATIO = 0.72;
const PONCHO_DRIFELLA_ROW_MIN_SCALE = 0.18;
export const PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT = 3;
const PONCHO_DRIFELLA_ROW_MAX_WIDTH_RATIOS = Object.freeze({
  single: 0.62,
  pair: 0.36,
  trio: 0.21,
});

// Seeded from the previous desktop-only layout at a 738px square reveal target,
// then reduced by 10% while keeping the card centered for pack-relative tuning.
const PONCHO_DRIFELLA_CARD_FRAME_RECT = Object.freeze<PonchoDrifellaFrameRect>({
  left: 460,
  top: 372,
  width: 520,
  height: 728,
});

export function calcPonchoDrifellaRevealTargetRect(
  viewportWidth: number,
  viewportHeight: number,
): PonchoDrifellaViewportFrameRect {
  const portrait = viewportHeight >= viewportWidth;
  const gutter = portrait ? 8 : 16;
  const width = portrait
    ? Math.max(1, Math.floor(Math.min(viewportWidth * 1.4, viewportHeight - gutter * 2)))
    : Math.max(1, Math.floor(viewportHeight * 0.82));
  const height = Math.max(1, width);
  const visualLift = portrait ? Math.min(44, Math.round(height * 0.08)) : Math.min(32, Math.round(height * 0.06));
  const maxTop = Math.max(gutter, viewportHeight - height - gutter);
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.min(maxTop, Math.max(gutter, Math.round((viewportHeight - height) / 2) - visualLift)),
    width,
    height,
  };
}

function calcPonchoDrifellaCardRect(
  targetRect: Readonly<{ width: number; height: number }>,
): PonchoDrifellaPackFrameRect {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const scaleX = safeTargetWidth / PONCHO_DRIFELLA_SOURCE_FRAME_SIZE;
  const scaleY = safeTargetHeight / PONCHO_DRIFELLA_SOURCE_FRAME_SIZE;
  return {
    left: Math.round(PONCHO_DRIFELLA_CARD_FRAME_RECT.left * scaleX),
    top: Math.round(PONCHO_DRIFELLA_CARD_FRAME_RECT.top * scaleY),
    width: Math.max(1, Math.round(PONCHO_DRIFELLA_CARD_FRAME_RECT.width * scaleX)),
    height: Math.max(1, Math.round(PONCHO_DRIFELLA_CARD_FRAME_RECT.height * scaleY)),
  };
}

export function calcPonchoDrifellaAbsoluteCardRect(
  targetRect: Readonly<PonchoDrifellaFrameRect>,
): PonchoDrifellaViewportFrameRect {
  const cardRect = calcPonchoDrifellaCardRect(targetRect);
  return {
    left: targetRect.left + cardRect.left,
    top: targetRect.top + cardRect.top,
    width: cardRect.width,
    height: cardRect.height,
  };
}

export function toRevealOverlayRect(rect: Readonly<PonchoDrifellaFrameRect>): PonchoDrifellaFrameRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function calcAspectLockedRevealOriginRect(
  originRect: DOMRect,
  targetRect: Readonly<Pick<PonchoDrifellaFrameRect, 'width' | 'height'>>,
): DOMRect {
  const safeSourceHeight = Math.max(1, originRect.height);
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const aspectRatio = safeTargetWidth / safeTargetHeight;
  const width = Math.max(1, safeSourceHeight * aspectRatio);
  return new DOMRect(
    originRect.left + (originRect.width - width) / 2,
    originRect.top,
    width,
    safeSourceHeight,
  );
}

export function getRevealOverlayViewport(): RevealOverlayViewport {
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 1, height: 1 };
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return {
      left: 0,
      top: 0,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    };
  }
  return {
    left: Number.isFinite(visualViewport.offsetLeft) ? visualViewport.offsetLeft : 0,
    top: Number.isFinite(visualViewport.offsetTop) ? visualViewport.offsetTop : 0,
    width: Math.max(1, visualViewport.width),
    height: Math.max(1, visualViewport.height),
  };
}

export function offsetRevealOverlayRectForViewport(
  rect: Readonly<PonchoDrifellaFrameRect>,
  viewport: Readonly<Pick<RevealOverlayViewport, 'left' | 'top'>>,
): PonchoDrifellaFrameRect {
  return {
    ...rect,
    left: Math.round(rect.left + viewport.left),
    top: Math.round(rect.top + viewport.top),
  };
}

export function calcPonchoDrifellaRevealTargetRectInViewport(
  viewport: RevealOverlayViewport = getRevealOverlayViewport(),
): PonchoDrifellaViewportFrameRect {
  return offsetRevealOverlayRectForViewport(
    calcPonchoDrifellaRevealTargetRect(viewport.width, viewport.height),
    viewport,
  );
}

export function sameRevealOverlayRect(
  a: Readonly<PonchoDrifellaFrameRect>,
  b: Readonly<PonchoDrifellaFrameRect>,
) {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function clampValue(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizePonchoDrifellaLayoutViewport(
  viewport: PonchoDrifellaLayoutViewport,
) {
  return {
    left: Number.isFinite(viewport.left) ? viewport.left : 0,
    top: Number.isFinite(viewport.top) ? viewport.top : 0,
    width: Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1),
    height: Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 1),
  };
}

function calcPonchoDrifellaCardRowSlots(
  targetRect: Readonly<PonchoDrifellaCardRowLayoutRect>,
  viewport: PonchoDrifellaLayoutViewport,
  cardCount: number,
  packCardRect: Readonly<PonchoDrifellaPackFrameRect>,
): [PonchoDrifellaViewportFrameRect, PonchoDrifellaViewportFrameRect, PonchoDrifellaViewportFrameRect] {
  const normalizedViewport = normalizePonchoDrifellaLayoutViewport(viewport);
  const flooredCardCount = typeof cardCount === 'number' ? Math.floor(cardCount) : Number.NaN;
  const normalizedCardCount = Number.isFinite(flooredCardCount)
    ? flooredCardCount
    : PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT;
  const visibleCount = clampValue(normalizedCardCount, 1, PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT);
  const gutterX = Math.round(clampValue(normalizedViewport.width * PONCHO_DRIFELLA_ROW_GUTTER_X_RATIO, 18, 72));
  const gutterY = Math.round(clampValue(normalizedViewport.height * PONCHO_DRIFELLA_ROW_GUTTER_Y_RATIO, 18, 56));
  const gap = Math.round(clampValue(normalizedViewport.width * PONCHO_DRIFELLA_ROW_GAP_RATIO, 10, 26));
  const availableWidth = Math.max(1, normalizedViewport.width - gutterX * 2);
  const availableHeight = Math.max(1, normalizedViewport.height - gutterY * 2);
  const widthScale = (availableWidth - gap * (visibleCount - 1)) / Math.max(1, packCardRect.width * visibleCount);
  const heightScale =
    Math.min(availableHeight, normalizedViewport.height * PONCHO_DRIFELLA_ROW_MAX_HEIGHT_RATIO) /
    Math.max(1, packCardRect.height);
  const maxCardWidthRatio =
    visibleCount === 1
      ? PONCHO_DRIFELLA_ROW_MAX_WIDTH_RATIOS.single
      : visibleCount === 2
        ? PONCHO_DRIFELLA_ROW_MAX_WIDTH_RATIOS.pair
        : PONCHO_DRIFELLA_ROW_MAX_WIDTH_RATIOS.trio;
  const maxCardWidthScale =
    (normalizedViewport.width * maxCardWidthRatio) / Math.max(1, packCardRect.width);
  const scale = clampValue(Math.min(1, widthScale, heightScale, maxCardWidthScale), PONCHO_DRIFELLA_ROW_MIN_SCALE, 1);
  const rowWidth = Math.max(1, Math.round(packCardRect.width * scale));
  const rowHeight = Math.max(1, Math.round(packCardRect.height * scale));
  const totalWidth = rowWidth * visibleCount + gap * (visibleCount - 1);
  const stackCenterY = targetRect.top + packCardRect.top + packCardRect.height / 2;
  const viewportCenterX = normalizedViewport.left + normalizedViewport.width / 2;
  const rowLeft = clampValue(
    Math.round(viewportCenterX - totalWidth / 2),
    normalizedViewport.left + gutterX,
    normalizedViewport.left + normalizedViewport.width - gutterX - totalWidth,
  );
  const rowTop = clampValue(
    Math.round(stackCenterY - rowHeight / 2),
    normalizedViewport.top + gutterY,
    normalizedViewport.top + normalizedViewport.height - gutterY - rowHeight,
  );
  const createRowSlot = (index: number): PonchoDrifellaViewportFrameRect => ({
    left: rowLeft + index * (rowWidth + gap),
    top: rowTop,
    width: rowWidth,
    height: rowHeight,
  });
  const firstSlot = createRowSlot(0);
  const secondSlot = visibleCount > 1 ? createRowSlot(1) : firstSlot;
  const thirdSlot = visibleCount > 2 ? createRowSlot(2) : secondSlot;
  return [firstSlot, secondSlot, thirdSlot];
}

function calcPonchoDrifellaRowStartDeltas(
  targetRect: Readonly<PonchoDrifellaCardRowLayoutRect>,
  packCardRect: Readonly<PonchoDrifellaPackFrameRect>,
  viewportRowSlots: readonly [
    PonchoDrifellaViewportFrameRect,
    PonchoDrifellaViewportFrameRect,
    PonchoDrifellaViewportFrameRect,
  ],
) {
  const startLeft = targetRect.left + packCardRect.left;
  const startTop = targetRect.top + packCardRect.top;
  return [
    { x: startLeft - viewportRowSlots[0].left, y: startTop - viewportRowSlots[0].top },
    { x: startLeft - viewportRowSlots[1].left, y: startTop - viewportRowSlots[1].top },
    { x: startLeft - viewportRowSlots[2].left, y: startTop - viewportRowSlots[2].top },
  ] as const;
}

function calcPonchoDrifellaCardLayout(
  targetRect: Readonly<PonchoDrifellaCardRowLayoutRect>,
  viewport: PonchoDrifellaLayoutViewport,
  cardCount = PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
): PonchoDrifellaCardLayout {
  const packCardRect = calcPonchoDrifellaCardRect(targetRect);
  const viewportRowSlots = calcPonchoDrifellaCardRowSlots(targetRect, viewport, cardCount, packCardRect);
  return {
    packCardRect,
    viewportRowSlots,
    rowStartDeltas: calcPonchoDrifellaRowStartDeltas(targetRect, packCardRect, viewportRowSlots),
    rowStartScale: {
      x: packCardRect.width / Math.max(1, viewportRowSlots[0].width),
      y: packCardRect.height / Math.max(1, viewportRowSlots[0].height),
    },
  };
}

function ponchoDrifellaCardLayoutCssVars({
  packCardRect,
  rowStartDeltas,
  rowStartScale,
  viewportRowSlots,
}: Readonly<PonchoDrifellaCardLayout>): RevealOverlayStyleVars {
  return {
    '--poncho-card-left': `${packCardRect.left}px`,
    '--poncho-card-top': `${packCardRect.top}px`,
    '--poncho-card-width': `${packCardRect.width}px`,
    '--poncho-card-height': `${packCardRect.height}px`,
    '--poncho-card-row-left-0': `${viewportRowSlots[0].left}px`,
    '--poncho-card-row-left-1': `${viewportRowSlots[1].left}px`,
    '--poncho-card-row-left-2': `${viewportRowSlots[2].left}px`,
    '--poncho-card-row-top': `${viewportRowSlots[0].top}px`,
    '--poncho-card-row-width': `${viewportRowSlots[0].width}px`,
    '--poncho-card-row-height': `${viewportRowSlots[0].height}px`,
    '--poncho-card-row-start-dx-0': `${rowStartDeltas[0].x}px`,
    '--poncho-card-row-start-dx-1': `${rowStartDeltas[1].x}px`,
    '--poncho-card-row-start-dx-2': `${rowStartDeltas[2].x}px`,
    '--poncho-card-row-start-dy': `${rowStartDeltas[0].y}px`,
    '--poncho-card-row-start-scale-x': String(rowStartScale.x),
    '--poncho-card-row-start-scale-y': String(rowStartScale.y),
  };
}

function ponchoDrifellaSingleCardLayoutCssVars(
  cardRect: Readonly<PonchoDrifellaFrameRect>,
): RevealOverlayStyleVars {
  const rowSlot = {
    left: cardRect.left,
    top: cardRect.top,
    width: cardRect.width,
    height: cardRect.height,
  };
  return ponchoDrifellaCardLayoutCssVars({
    packCardRect: rowSlot,
    viewportRowSlots: [rowSlot, rowSlot, rowSlot],
    rowStartDeltas: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    rowStartScale: { x: 1, y: 1 },
  });
}

export function revealOverlayStyleVars({
  originRect,
  targetRect,
  mode = 'default',
}: {
  originRect: Readonly<PonchoDrifellaFrameRect>;
  targetRect: Readonly<PonchoDrifellaFrameRect>;
  mode?: RevealOverlayStyleMode;
}): RevealOverlayStyleVars {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const viewerScale = Math.max(0.01, originRect.height / safeTargetHeight);
  const scaleX = mode === 'poncho-card'
    ? viewerScale
    : Math.max(0.01, originRect.width / safeTargetWidth);
  const scaleY = mode === 'poncho-card'
    ? viewerScale
    : Math.max(0.01, originRect.height / safeTargetHeight);

  return {
    '--reveal-target-left': `${targetRect.left}px`,
    '--reveal-target-top': `${targetRect.top}px`,
    '--reveal-target-width': `${safeTargetWidth}px`,
    '--reveal-target-height': `${safeTargetHeight}px`,
    '--reveal-start-x': `${originRect.left - targetRect.left}px`,
    '--reveal-start-y': `${originRect.top - targetRect.top}px`,
    '--reveal-start-scale-x': String(scaleX),
    '--reveal-start-scale-y': String(scaleY),
  };
}

export function ponchoDrifellaRevealOverlayStyleVars({
  originRect,
  targetRect,
  mode = 'default',
  viewport = getRevealOverlayViewport(),
  cardCount = PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
}: {
  originRect: Readonly<PonchoDrifellaFrameRect>;
  targetRect: Readonly<PonchoDrifellaFrameRect>;
  mode?: RevealOverlayStyleMode;
  viewport?: RevealOverlayViewport;
  cardCount?: number;
}): RevealOverlayStyleVars {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const cardLayoutVars = mode === 'poncho-card'
    ? ponchoDrifellaSingleCardLayoutCssVars(
        {
          left: 0,
          top: 0,
          width: safeTargetWidth,
          height: safeTargetHeight,
        },
      )
    : ponchoDrifellaCardLayoutCssVars(
        calcPonchoDrifellaCardLayout({
          left: targetRect.left,
          top: targetRect.top,
          width: safeTargetWidth,
          height: safeTargetHeight,
        }, viewport, cardCount),
      );

  return {
    ...revealOverlayStyleVars({ originRect, targetRect, mode }),
    ...cardLayoutVars,
  };
}
