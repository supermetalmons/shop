type DogeDay2026FrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type DogeDay2026PackFrameRect = DogeDay2026FrameRect;
type DogeDay2026ViewportFrameRect = DogeDay2026FrameRect;

type RevealOverlayCssVarName =
  | '--doge-day-2026-reveal-target-left'
  | '--doge-day-2026-reveal-target-top'
  | '--doge-day-2026-reveal-target-width'
  | '--doge-day-2026-reveal-target-height'
  | '--doge-day-2026-reveal-start-x'
  | '--doge-day-2026-reveal-start-y'
  | '--doge-day-2026-reveal-start-scale-x'
  | '--doge-day-2026-reveal-start-scale-y'
  | '--doge-day-2026-card-left'
  | '--doge-day-2026-card-top'
  | '--doge-day-2026-card-width'
  | '--doge-day-2026-card-height'
  | '--doge-day-2026-card-row-left-0'
  | '--doge-day-2026-card-row-left-1'
  | '--doge-day-2026-card-row-left-2'
  | '--doge-day-2026-card-row-top'
  | '--doge-day-2026-card-row-width'
  | '--doge-day-2026-card-row-height'
  | '--doge-day-2026-card-row-start-dx-0'
  | '--doge-day-2026-card-row-start-dx-1'
  | '--doge-day-2026-card-row-start-dx-2'
  | '--doge-day-2026-card-row-start-dy'
  | '--doge-day-2026-card-row-start-scale-x'
  | '--doge-day-2026-card-row-start-scale-y'
  | '--doge-day-2026-pack-discard-delay'
  | '--doge-day-2026-pack-discard-duration';

type RevealOverlayStyleVars = Partial<Record<RevealOverlayCssVarName, string>>;

type DogeDay2026CardLayoutRect = Pick<DogeDay2026ViewportFrameRect, 'top' | 'width' | 'height'>;
type DogeDay2026CardRowLayoutRect = DogeDay2026CardLayoutRect & Pick<DogeDay2026FrameRect, 'left'>;
type RevealOverlayViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type DogeDay2026LayoutViewport = Readonly<RevealOverlayViewport>;
type RevealOverlayStyleMode = 'default' | 'doge-day-2026-card';

type DogeDay2026CardLayout = {
  packCardRect: DogeDay2026PackFrameRect;
  viewportRowSlots: readonly [
    DogeDay2026ViewportFrameRect,
    DogeDay2026ViewportFrameRect,
    DogeDay2026ViewportFrameRect,
  ];
  rowStartDeltas: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  rowStartScale: { x: number; y: number };
};

const DOGE_DAY_2026_SOURCE_FRAME_SIZE = 1440;
const DOGE_DAY_2026_ROW_GUTTER_X_RATIO = 0.075;
const DOGE_DAY_2026_ROW_GUTTER_Y_RATIO = 0.07;
const DOGE_DAY_2026_ROW_GAP_RATIO = 0.028;
const DOGE_DAY_2026_ROW_MAX_HEIGHT_RATIO = 0.72;
const DOGE_DAY_2026_ROW_MIN_SCALE = 0.18;
export const DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT = 3;
const DOGE_DAY_2026_ROW_MAX_WIDTH_RATIOS = Object.freeze({
  single: 0.62,
  pair: 0.36,
  trio: 0.21,
});

const DOGE_DAY_2026_CARD_FRAME_RECT = Object.freeze<DogeDay2026FrameRect>({
  left: 460,
  top: 372,
  width: 520,
  height: 728,
});

function calcDogeDay2026RevealTargetRect(
  viewportWidth: number,
  viewportHeight: number,
): DogeDay2026ViewportFrameRect {
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

function calcDogeDay2026CardRect(
  targetRect: Readonly<{ width: number; height: number }>,
): DogeDay2026PackFrameRect {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const scaleX = safeTargetWidth / DOGE_DAY_2026_SOURCE_FRAME_SIZE;
  const scaleY = safeTargetHeight / DOGE_DAY_2026_SOURCE_FRAME_SIZE;
  return {
    left: Math.round(DOGE_DAY_2026_CARD_FRAME_RECT.left * scaleX),
    top: Math.round(DOGE_DAY_2026_CARD_FRAME_RECT.top * scaleY),
    width: Math.max(1, Math.round(DOGE_DAY_2026_CARD_FRAME_RECT.width * scaleX)),
    height: Math.max(1, Math.round(DOGE_DAY_2026_CARD_FRAME_RECT.height * scaleY)),
  };
}

function getRevealOverlayViewport(): RevealOverlayViewport {
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

function offsetRevealOverlayRectForViewport(
  rect: Readonly<DogeDay2026FrameRect>,
  viewport: Readonly<Pick<RevealOverlayViewport, 'left' | 'top'>>,
): DogeDay2026FrameRect {
  return {
    ...rect,
    left: Math.round(rect.left + viewport.left),
    top: Math.round(rect.top + viewport.top),
  };
}

export function calcDogeDay2026RevealTargetRectInViewport(
  viewport: RevealOverlayViewport = getRevealOverlayViewport(),
): DogeDay2026ViewportFrameRect {
  return offsetRevealOverlayRectForViewport(
    calcDogeDay2026RevealTargetRect(viewport.width, viewport.height),
    viewport,
  );
}

export function sameRevealOverlayRect(
  a: Readonly<DogeDay2026FrameRect>,
  b: Readonly<DogeDay2026FrameRect>,
) {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function clampValue(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeDogeDay2026LayoutViewport(
  viewport: DogeDay2026LayoutViewport,
) {
  return {
    left: Number.isFinite(viewport.left) ? viewport.left : 0,
    top: Number.isFinite(viewport.top) ? viewport.top : 0,
    width: Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1),
    height: Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 1),
  };
}

function calcDogeDay2026CardRowSlots(
  targetRect: Readonly<DogeDay2026CardRowLayoutRect>,
  viewport: DogeDay2026LayoutViewport,
  cardCount: number,
  packCardRect: Readonly<DogeDay2026PackFrameRect>,
): [DogeDay2026ViewportFrameRect, DogeDay2026ViewportFrameRect, DogeDay2026ViewportFrameRect] {
  const normalizedViewport = normalizeDogeDay2026LayoutViewport(viewport);
  const flooredCardCount = typeof cardCount === 'number' ? Math.floor(cardCount) : Number.NaN;
  const normalizedCardCount = Number.isFinite(flooredCardCount)
    ? flooredCardCount
    : DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT;
  const visibleCount = clampValue(normalizedCardCount, 1, DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT);
  const gutterX = Math.round(clampValue(normalizedViewport.width * DOGE_DAY_2026_ROW_GUTTER_X_RATIO, 18, 72));
  const gutterY = Math.round(clampValue(normalizedViewport.height * DOGE_DAY_2026_ROW_GUTTER_Y_RATIO, 18, 56));
  const gap = Math.round(clampValue(normalizedViewport.width * DOGE_DAY_2026_ROW_GAP_RATIO, 10, 26));
  const availableWidth = Math.max(1, normalizedViewport.width - gutterX * 2);
  const availableHeight = Math.max(1, normalizedViewport.height - gutterY * 2);
  const widthScale = (availableWidth - gap * (visibleCount - 1)) / Math.max(1, packCardRect.width * visibleCount);
  const heightScale =
    Math.min(availableHeight, normalizedViewport.height * DOGE_DAY_2026_ROW_MAX_HEIGHT_RATIO) /
    Math.max(1, packCardRect.height);
  const maxCardWidthRatio =
    visibleCount === 1
      ? DOGE_DAY_2026_ROW_MAX_WIDTH_RATIOS.single
      : visibleCount === 2
        ? DOGE_DAY_2026_ROW_MAX_WIDTH_RATIOS.pair
        : DOGE_DAY_2026_ROW_MAX_WIDTH_RATIOS.trio;
  const maxCardWidthScale =
    (normalizedViewport.width * maxCardWidthRatio) / Math.max(1, packCardRect.width);
  const scale = clampValue(Math.min(1, widthScale, heightScale, maxCardWidthScale), DOGE_DAY_2026_ROW_MIN_SCALE, 1);
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
  const createRowSlot = (index: number): DogeDay2026ViewportFrameRect => ({
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

function calcDogeDay2026RowStartDeltas(
  targetRect: Readonly<DogeDay2026CardRowLayoutRect>,
  packCardRect: Readonly<DogeDay2026PackFrameRect>,
  viewportRowSlots: readonly [
    DogeDay2026ViewportFrameRect,
    DogeDay2026ViewportFrameRect,
    DogeDay2026ViewportFrameRect,
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

function calcDogeDay2026CardLayout(
  targetRect: Readonly<DogeDay2026CardRowLayoutRect>,
  viewport: DogeDay2026LayoutViewport,
  cardCount = DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT,
): DogeDay2026CardLayout {
  const packCardRect = calcDogeDay2026CardRect(targetRect);
  const viewportRowSlots = calcDogeDay2026CardRowSlots(targetRect, viewport, cardCount, packCardRect);
  return {
    packCardRect,
    viewportRowSlots,
    rowStartDeltas: calcDogeDay2026RowStartDeltas(targetRect, packCardRect, viewportRowSlots),
    rowStartScale: {
      x: packCardRect.width / Math.max(1, viewportRowSlots[0].width),
      y: packCardRect.height / Math.max(1, viewportRowSlots[0].height),
    },
  };
}

function dogeDay2026CardLayoutCssVars({
  packCardRect,
  rowStartDeltas,
  rowStartScale,
  viewportRowSlots,
}: Readonly<DogeDay2026CardLayout>): RevealOverlayStyleVars {
  return {
    '--doge-day-2026-card-left': `${packCardRect.left}px`,
    '--doge-day-2026-card-top': `${packCardRect.top}px`,
    '--doge-day-2026-card-width': `${packCardRect.width}px`,
    '--doge-day-2026-card-height': `${packCardRect.height}px`,
    '--doge-day-2026-card-row-left-0': `${viewportRowSlots[0].left}px`,
    '--doge-day-2026-card-row-left-1': `${viewportRowSlots[1].left}px`,
    '--doge-day-2026-card-row-left-2': `${viewportRowSlots[2].left}px`,
    '--doge-day-2026-card-row-top': `${viewportRowSlots[0].top}px`,
    '--doge-day-2026-card-row-width': `${viewportRowSlots[0].width}px`,
    '--doge-day-2026-card-row-height': `${viewportRowSlots[0].height}px`,
    '--doge-day-2026-card-row-start-dx-0': `${rowStartDeltas[0].x}px`,
    '--doge-day-2026-card-row-start-dx-1': `${rowStartDeltas[1].x}px`,
    '--doge-day-2026-card-row-start-dx-2': `${rowStartDeltas[2].x}px`,
    '--doge-day-2026-card-row-start-dy': `${rowStartDeltas[0].y}px`,
    '--doge-day-2026-card-row-start-scale-x': String(rowStartScale.x),
    '--doge-day-2026-card-row-start-scale-y': String(rowStartScale.y),
  };
}

function dogeDay2026SingleCardLayoutCssVars(
  cardRect: Readonly<DogeDay2026FrameRect>,
): RevealOverlayStyleVars {
  const rowSlot = {
    left: cardRect.left,
    top: cardRect.top,
    width: cardRect.width,
    height: cardRect.height,
  };
  return dogeDay2026CardLayoutCssVars({
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

function revealOverlayStyleVars({
  originRect,
  targetRect,
  mode = 'default',
}: {
  originRect: Readonly<DogeDay2026FrameRect>;
  targetRect: Readonly<DogeDay2026FrameRect>;
  mode?: RevealOverlayStyleMode;
}): RevealOverlayStyleVars {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const viewerScale = Math.max(0.01, originRect.height / safeTargetHeight);
  const scaleX = mode === 'doge-day-2026-card'
    ? viewerScale
    : Math.max(0.01, originRect.width / safeTargetWidth);
  const scaleY = mode === 'doge-day-2026-card'
    ? viewerScale
    : Math.max(0.01, originRect.height / safeTargetHeight);

  return {
    '--doge-day-2026-reveal-target-left': `${targetRect.left}px`,
    '--doge-day-2026-reveal-target-top': `${targetRect.top}px`,
    '--doge-day-2026-reveal-target-width': `${safeTargetWidth}px`,
    '--doge-day-2026-reveal-target-height': `${safeTargetHeight}px`,
    '--doge-day-2026-reveal-start-x': `${originRect.left - targetRect.left}px`,
    '--doge-day-2026-reveal-start-y': `${originRect.top - targetRect.top}px`,
    '--doge-day-2026-reveal-start-scale-x': String(scaleX),
    '--doge-day-2026-reveal-start-scale-y': String(scaleY),
  };
}

export function dogeDay2026RevealOverlayStyleVars({
  originRect,
  targetRect,
  mode = 'default',
  viewport = getRevealOverlayViewport(),
  cardCount = DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT,
}: {
  originRect: Readonly<DogeDay2026FrameRect>;
  targetRect: Readonly<DogeDay2026FrameRect>;
  mode?: RevealOverlayStyleMode;
  viewport?: RevealOverlayViewport;
  cardCount?: number;
}): RevealOverlayStyleVars {
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const cardLayoutVars = mode === 'doge-day-2026-card'
    ? dogeDay2026SingleCardLayoutCssVars(
        {
          left: 0,
          top: 0,
          width: safeTargetWidth,
          height: safeTargetHeight,
        },
      )
    : dogeDay2026CardLayoutCssVars(
        calcDogeDay2026CardLayout({
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
