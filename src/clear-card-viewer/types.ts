import type { ClearCardLightingConfig } from '../clearCardLighting';
import type { ClearCardRenderQualityByStage } from '../lib/clearCardCanvas';
import type { ClearCardPreviewModel } from '../lib/clearCardPreviewLayout';

export type ViewerStatus = 'loading' | 'ready' | 'error';
export type ClearCardModelLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ClearCardViewMode = 'tilt' | 'free' | 'orbit';
type InteractionFrameRateMode = 'unrestricted' | 'throttled' | 'adaptive';
type ClearCardHitProgressionMode = 'fixed' | 'reveal-gated';

export type ClearCardDisplayStage = 'pack' | 'breaking' | 'revealed';

export type ClearCardSnapshot = {
  blob: Blob;
  objectKind: 'pack' | 'card';
  cropSize: {
    width: number;
    height: number;
  };
};

export type ClearCardSnapshotOptions = {
  longestEdge?: number;
};

export type ClearCardThreeViewerHandle = {
  reset: () => void;
  hit: () => void;
  isClientPointOnObject: (clientX: number, clientY: number) => boolean | undefined;
  retryCardModel: () => void;
  captureSnapshot: (options?: ClearCardSnapshotOptions) => Promise<ClearCardSnapshot>;
};

export type ClearCardThreeViewerProps = {
  ready: boolean;
  cardModelUrl?: string;
  packModelUrl?: string;
  lightingConfig: ClearCardLightingConfig;
  renderQualityByStage?: ClearCardRenderQualityByStage;
  unrestrictedMovement: boolean;
  axisLockedOrbit: boolean;
  snapBackOnRelease?: boolean;
  interactionFrameRateMode?: InteractionFrameRateMode;
  interactionEnabled?: boolean;
  interactionBounds?: 'canvas' | 'parent';
  pointerActivationEnabled?: boolean;
  keyboardActivationEnabled?: boolean;
  keyboardRotationEnabled?: boolean;
  hitProgressionMode?: ClearCardHitProgressionMode;
  revealReady?: boolean;
  initiallyRevealed: boolean;
  ariaLabel?: string;
  onStatusChange: (status: ViewerStatus) => void;
  onFrameRendered?: () => void;
  onPreviewFrame?: (frame: ClearCardPreviewModel | null) => void;
  onCardModelLoadStatusChange?: (status: ClearCardModelLoadStatus) => void;
  onStageChange?: (stage: ClearCardDisplayStage) => void;
  onPackHit?: (hitIndex: number) => void;
  onPackBreak?: () => void;
};
