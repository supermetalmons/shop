import type { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import type { resolveDropContent } from '../../lib/dropContent';
import type { FigureMetadataRecord, FigureMetadataTarget } from '../../lib/figureMetadata';
import type { InventoryItem, PendingOpenBox } from '../../types';
import type { SendViaConnectionOptions } from '../commerce/transactionSupport';

export type RevealDropContext = {
  routeDrop: FrontendDeploymentConfig | null;
  getDropConfig: (dropId?: string) => FrontendDeploymentConfig | undefined;
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  getDropContent: (dropId?: string) => ReturnType<typeof resolveDropContent>;
  getDropConnection: (dropId: string) => Connection;
  boxLabelForDropId: (dropId?: string, count?: number, options?: { capitalize?: boolean }) => string;
  figureLabelForDropId: (dropId?: string, count?: number, options?: { capitalize?: boolean }) => string;
  figureReferenceForDropId: (dropId: string | undefined, reference: string | number) => string;
  openGerundForDropId: (dropId?: string) => string;
  canOpenBoxesForDropId: (dropId?: string) => boolean;
};

export type ShopRevealOptions = RevealDropContext & {
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  owner: string | undefined;
  localAccountWallet: string | undefined;
  isViewerMode: boolean;
  suspended: boolean;
  walletModalVisible: boolean;
  receiptTransferOpen: boolean;
  inventory: InventoryItem[];
  pendingOpenBoxes: PendingOpenBox[];
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  queueFigureMetadataFetch: (targets: FigureMetadataTarget[]) => void;
  addLocalPendingReveal: (item: InventoryItem) => void;
  removeLocalPendingReveal: (id: string) => void;
  rememberRecentReveal: (id: string) => void;
  addLocalRevealedDudes: (ids: number[], dropId: string) => void;
  markAssetsHidden: (ids: string[]) => void;
  refetchInventory: () => Promise<unknown>;
  refetchPendingOpenBoxes: () => Promise<unknown>;
  clearSelection: () => void;
  ensureSignedIn: () => Promise<boolean>;
  openWalletModal: () => void;
  showToast: (message: string) => void;
  blockViewerModeAction: () => boolean;
  sendAndConfirmViaConnection: (
    tx: VersionedTransaction,
    connection: Connection,
    options?: SendViaConnectionOptions,
  ) => Promise<string | null>;
  retryAfterBlockhashExpiry: <T>(sendOnce: () => Promise<T>, expiredMessage: string) => Promise<T>;
};
