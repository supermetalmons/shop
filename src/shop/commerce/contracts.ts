import type { RefObject } from 'react';
import type { Connection, PublicKey } from '@solana/web3.js';
import type { InventoryItem, RecoverDeliveryOrdersArgs } from '../../types';
import type { useWalletTransactions } from './useWalletTransactions';

export type CommerceWalletContext = {
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  connectedWalletRef: RefObject<string | null>;
  owner: string | undefined;
  ownerRef: RefObject<string | undefined>;
  ensureSignedIn: () => Promise<boolean>;
  blockViewerModeAction: () => boolean;
};

export type CommerceInventoryRefresh = () => Promise<{ data?: InventoryItem[]; error?: unknown }>;
export type DeliveryRecovery = (request?: RecoverDeliveryOrdersArgs) => Promise<unknown>;
export type PreparedTransactionSender = ReturnType<typeof useWalletTransactions>['signAndSendPreparedViaConnection'];
export type DropConnection = (dropId: string) => Connection;
