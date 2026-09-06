import {
  type CSSProperties,
  type TransitionEvent
} from 'react';
import {
  InventoryItem
} from '../../types';
import {
  type RevealOverlayPhase
} from '../reveal';

export type ReceiptViewerSource = Pick<InventoryItem, 'id' | 'dropId' | 'name' | 'image'>;

export type ReceiptViewerImage = {
  key: string;
  name: string;
  image?: string;
};

export type ReceiptViewerImageShellStyle = CSSProperties & { '--receipt-viewer-count'?: string; };

export type OverlayRect = { left: number; top: number; width: number; height: number; };

export type ImageViewerSize = 'receipt' | 'shipment' | 'shipment-figure';

export type RevealOverlayState = {
  id: string;
  dropId: string;
  name: string;
  image?: string;
  originRect: OverlayRect;
  targetRect: OverlayRect;
  phase: RevealOverlayPhase;
  frame: number;
  advanceClicks: number;
  revealedIds?: number[];
  packMediaId?: number;
  interactiveRevealCardId?: number;
  viewerMode?: 'poncho-card' | 'clear-card' | 'clear-pack' | 'receipt-image';
  imageViewerSize?: ImageViewerSize;
  receiptImages?: ReceiptViewerImage[];
  adminIrlRedeemReceipt?: InventoryItem;
  viewerFigureId?: number;
  hasRevealAttempted?: boolean;
  autoOpening?: boolean;
  autoMode?: 'normal' | 'fast';
};

export type EarlyClearCardRevealGate = {
  boxAssetId: string;
  dropId: string;
  owner: string | undefined;
  revealSession: number;
  wallet: string;
  confirmation: Promise<boolean>;
  settleConfirmation: (confirmed: boolean) => void;
};

export type ReceiptImageViewerOverlayProps = {
  dropId: string;
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  suspended?: boolean;
  images?: readonly ReceiptViewerImage[];
  imageSrc?: string;
  alt: string;
  viewerSize?: ImageViewerSize;
  explorerHref?: string;
  onDismiss?: () => void;
  transfer?: {
    unavailable?: boolean;
    disabled?: boolean;
    busy?: boolean;
    label?: string;
    onClick: (opener: HTMLButtonElement) => void;
  };
  adminIrlRedeem?: {
    loading: boolean;
    onClick: () => void;
  };
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};
