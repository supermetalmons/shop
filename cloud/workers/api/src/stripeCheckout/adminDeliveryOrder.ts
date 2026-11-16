import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import {
  decodeAdminDeliveryOrderRecord,
  deriveAdminOrderPda,
  encodeAdminDeliverVariantOrderArgs,
  type DecodedAdminDeliveryOrderRecord,
} from './contract.js';
import { StripeCheckoutFulfillmentError } from './errors.js';

type AdminDeliveryOrderRuntime = {
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  receiptsMerkleTree: PublicKey;
};

export type StripeCheckoutOnchainConfig = {
  admin: PublicKey;
  coreCollection: PublicKey;
};

type StripeCheckoutPrograms = {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  mplCoreCpiSigner: PublicKey;
};

export type AdminDeliveryOrderDependencies<
  Runtime extends AdminDeliveryOrderRuntime,
  Config extends StripeCheckoutOnchainConfig,
> = {
  runRpc: <T>(
    dropRuntime: Runtime,
    operation: (connection: Connection) => Promise<T>,
    timeoutMs: number,
    label: string,
  ) => Promise<T>;
  ensureOnchainCoreConfig: (dropRuntime: Runtime) => Promise<Config>;
  requireStripeCheckoutCollectionMatchesConfig: (
    dropRuntime: Runtime,
    cfg: Config,
    code?: 'failed-precondition' | 'unavailable',
  ) => void;
  cosigner: () => Keypair;
  buildTx: (
    instructions: TransactionInstruction[],
    payer: PublicKey,
    blockhash: string,
    signers: Keypair[],
  ) => VersionedTransaction;
  sendAndConfirmSignedTx: (
    dropRuntime: Runtime,
    tx: VersionedTransaction,
    label: string,
    opts?: { sendTimeoutMs?: number; confirmTimeoutMs?: number },
  ) => Promise<string>;
  programs: StripeCheckoutPrograms;
  rpcTimeoutMs: number;
  txSendTimeoutMs: number;
  txConfirmTimeoutMs: number;
  signal?: AbortSignal;
};

async function fetchAdminDeliveryOrderRecord<Runtime extends AdminDeliveryOrderRuntime>(params: {
  dropRuntime: Runtime;
  adminOrderPda: PublicKey;
  context: string;
  deps: Pick<AdminDeliveryOrderDependencies<Runtime, StripeCheckoutOnchainConfig>, 'runRpc' | 'rpcTimeoutMs'>;
}): Promise<DecodedAdminDeliveryOrderRecord | null> {
  const { dropRuntime, adminOrderPda, context, deps } = params;
  const info = await deps.runRpc(
    dropRuntime,
    async (connection) => (await connection.getAccountInfoAndContext(
      adminOrderPda,
      { commitment: 'confirmed' },
    )).value,
    deps.rpcTimeoutMs,
    context,
  );
  if (!info) return null;
  if (!info.owner.equals(dropRuntime.boxMinterProgramId)) {
    if (info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
      return null;
    }
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order PDA has an unexpected owner', {
      adminOrderPda: adminOrderPda.toBase58(),
      owner: info.owner.toBase58(),
      expectedOwner: dropRuntime.boxMinterProgramId.toBase58(),
    });
  }
  return decodeAdminDeliveryOrderRecord(Buffer.from(info.data));
}

export async function ensureAdminDeliveryOrder<
  Runtime extends AdminDeliveryOrderRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  dropId: string;
  dropRuntime: Runtime;
  orderHash: Buffer;
  variantIndex: number;
  quantity: number;
  deps: AdminDeliveryOrderDependencies<Runtime, Config>;
}): Promise<{
  metadataId: number;
  metadataIds: number[];
  receiptOwner: PublicKey;
  receiptTx: string | null;
}> {
  const { dropId, dropRuntime, orderHash, variantIndex, quantity, deps } = params;
  const cfg = await deps.ensureOnchainCoreConfig(dropRuntime);
  const signer = deps.cosigner();
  if (!signer.publicKey.equals(cfg.admin)) {
    throw new StripeCheckoutFulfillmentError('unavailable', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfg.admin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  deps.requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg, 'unavailable');

  const receiptOwner = cfg.admin;
  const [adminOrderPda, orderBump] = deriveAdminOrderPda(dropRuntime.boxMinterProgramId, dropRuntime.boxMinterConfigPda, orderHash);
  let record = await fetchAdminDeliveryOrderRecord({
    dropRuntime,
    adminOrderPda,
    context: 'getAccountInfo:adminOrder',
    deps,
  });
  let receiptTx: string | null = null;

  if (!record) {
    const treeConfig = PublicKey.findProgramAddressSync([dropRuntime.receiptsMerkleTree.toBuffer()], deps.programs.bubblegumProgramId)[0];
    const ix = new TransactionInstruction({
      programId: dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: receiptOwner, isSigner: false, isWritable: false },
        { pubkey: adminOrderPda, isSigner: false, isWritable: true },
        { pubkey: dropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true },
        { pubkey: treeConfig, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: deps.programs.bubblegumProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplNoopProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplAccountCompressionProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplCoreCpiSigner, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAdminDeliverVariantOrderArgs({
        orderHash,
        variantIndex,
        quantity,
      }),
    });
    const { blockhash } = await deps.runRpc(
      dropRuntime,
      async (connection) => (await connection.getLatestBlockhashAndContext('confirmed')).value,
      deps.rpcTimeoutMs,
      'getLatestBlockhash:stripeCheckoutFulfillment',
    );
    const tx = deps.buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix], signer.publicKey, blockhash, [signer]);
    try {
      receiptTx = await deps.sendAndConfirmSignedTx(dropRuntime, tx, 'adminDeliverVariantOrder', {
        sendTimeoutMs: deps.txSendTimeoutMs,
        confirmTimeoutMs: deps.txConfirmTimeoutMs,
      });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      const maybeRecord = await fetchAdminDeliveryOrderRecord({
        dropRuntime,
        adminOrderPda,
        context: 'getAccountInfo:adminOrderAfterError',
        deps,
      }).catch(() => null);
      if (!maybeRecord) throw err;
      record = maybeRecord;
    }
  }

  if (!record) {
    record = await fetchAdminDeliveryOrderRecord({
      dropRuntime,
      adminOrderPda,
      context: 'getAccountInfo:adminOrderAfterSend',
      deps,
    });
  }
  if (!record) {
    throw new StripeCheckoutFulfillmentError('unavailable', 'Admin order record was not created', {
      adminOrderPda: adminOrderPda.toBase58(),
      dropId,
    });
  }
  if (!record.orderHash.equals(orderHash)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record hash mismatch', { dropId, adminOrderPda: adminOrderPda.toBase58() });
  }
  if (record.variantIndex !== variantIndex) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record variant mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedVariantIndex: variantIndex,
      actualVariantIndex: record.variantIndex,
    });
  }
  if (record.quantity !== quantity) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record quantity mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedQuantity: quantity,
      actualQuantity: record.quantity,
    });
  }
  if (record.bump !== orderBump) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record bump mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedBump: orderBump,
      actualBump: record.bump,
    });
  }
  if (!record.receiptOwner.equals(receiptOwner)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record receipt owner mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedOwner: receiptOwner.toBase58(),
      actualOwner: record.receiptOwner.toBase58(),
    });
  }
  if (record.firstMetadataId < 1) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record metadata id is invalid', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      firstMetadataId: record.firstMetadataId,
    });
  }
  const metadataId = record.firstMetadataId;
  const metadataIds = Array.from({ length: quantity }, (_, index) => metadataId + index);
  return { metadataId, metadataIds, receiptOwner, receiptTx };
}
