import type { RefObject } from 'react';
import type { DrifCardConfig } from '../drifCards';
import type { MiNotePackStar } from '../lib/miNotePackStars';
import type { MiNoteStickerEffectSettings } from '../lib/miNoteStickerEffects';
import type { MiNoteRevealEvent, MiNoteRevealState } from '../lib/miNoteCardReveal';

export type MiNotePackControls = {
  activate: () => void;
  navigate: (direction: -1 | 1) => void;
  escape: () => boolean;
  selectCard: (index: 0 | 1) => void;
  returnCard: () => void;
};

export type MiNotePackViewerProps = {
  color: string;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  verticalPosition?: number;
  sizeScale?: number;
  effectSettings?: MiNoteStickerEffectSettings;
  inspectSticker?: boolean;
  cards?: readonly [DrifCardConfig, DrifCardConfig];
  cardEffect: DrifCardConfig['effect'];
  onCardsReadyChange: (ready: boolean) => void;
  onCardsError: (error: Error | null) => void;
  state: MiNoteRevealState;
  interactionEnabled: boolean;
  previewVisible?: boolean;
  activationEnabled?: boolean;
  onReadyChange: (ready: boolean) => void;
  onFrameRendered?: () => void;
  onError: (error: Error) => void;
  onEvent: (event: MiNoteRevealEvent) => void;
  onBackgroundTap?: () => void;
  controlsRef: RefObject<MiNotePackControls | null>;
};
