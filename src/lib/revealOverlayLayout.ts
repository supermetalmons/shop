export type PonchoDrifellaFrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const PONCHO_DRIFELLA_SOURCE_FRAME_SIZE = 1440;

// Seeded from the previous desktop-only layout at a 738px square reveal target,
// then reduced by 10% while keeping the card centered for pack-relative tuning.
export const PONCHO_DRIFELLA_CARD_FRAME_RECT = Object.freeze<PonchoDrifellaFrameRect>({
  left: 455,
  top: 348,
  width: 530,
  height: 743,
});

export function calcPonchoDrifellaRevealTargetRect(viewportWidth: number, viewportHeight: number) {
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

export function calcPonchoDrifellaCardRect(targetRect: Readonly<{ width: number; height: number }>): PonchoDrifellaFrameRect {
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
