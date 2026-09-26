import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection } from '@solana/web3.js';
import { z } from 'zod';
import { getPreorderConfig, isPreorderCardId } from '../../shared/preorders.ts';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { probePreorderTransaction } from '../../cloud/workers/api/src/preorderTransaction.ts';
import { COMMERCE_D1_NOW_MS_SQL, queryRemoteCommerceD1, sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { verifyArchivedPreorderAbsence } from '../shared/preorderArchive.ts';

const publicKey = z.string().refine((value) => isBase58Bytes(value, 32));
const orderSchema = z.object({
  order_id: z.string(), preorder_id: z.string(), cluster: z.enum(['devnet', 'mainnet-beta']), collection: publicKey, buyer: publicKey,
  status: z.enum(['prepared', 'submitted', 'succeeded', 'failed', 'expired', 'cancelled']),
  signature: z.string().refine((value) => isBase58Bytes(value, 64)).nullable(),
  signed_transaction: z.string().min(1).max(4096).nullable(),
  assets_json: z.string(), blockhash_context_slot: z.number().int().nonnegative(),
  last_valid_block_height: z.number().int().nonnegative(),
  confirmed_slot: z.number().int().nonnegative().nullable(),
});
const assetsSchema = z.array(z.object({
  id: z.number().refine(isPreorderCardId), address: publicKey,
})).min(1).max(3);
type RecoveryOrder = z.infer<typeof orderSchema>;
type RecoveryOutcome = Awaited<ReturnType<typeof probePreorderTransaction>>;
type Options = { orderId: string; write: boolean };
type Dependencies = { query: CommerceAuthorityQuery; probe: (order: RecoveryOrder) => Promise<RecoveryOutcome> };

const usage = 'Usage: npm run recover-preorder -- <order-id> [--write]\nSet PREORDER_ARCHIVE_RPC_URL to a trusted archival RPC for the order\'s cluster (devnet or mainnet-beta). Without --write, verification is read-only.';

export function parsePreorderRecoveryArgs(argv: string[]): Options {
  const [orderId, ...flags] = argv;
  if (!orderId || !/^[a-zA-Z0-9_-]{1,128}$/.test(orderId) || flags.length > 1 || flags.some((flag) => flag !== '--write')) {
    throw new Error(usage);
  }
  return { orderId, write: flags.includes('--write') };
}

async function readOrder(query: CommerceAuthorityQuery, orderId: string): Promise<RecoveryOrder> {
  const rows = await query(`SELECT order_id, preorder_id, cluster, collection, buyer, status, signature, signed_transaction,
    assets_json, blockhash_context_slot, last_valid_block_height, confirmed_slot FROM commerce_preorder_orders WHERE order_id = ${sqlString(orderId)}`);
  if (rows.length !== 1) throw new Error('Preorder not found.');
  const parsed = orderSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error('Preorder recovery record is invalid.');
  const order = parsed.data;
  let assets: z.infer<typeof assetsSchema>;
  try { assets = assetsSchema.parse(JSON.parse(order.assets_json)); }
  catch { throw new Error('Preorder asset records are invalid.'); }
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length || new Set(assets.map((asset) => asset.address)).size !== assets.length) {
    throw new Error('Preorder asset records are invalid.');
  }
  const config = getPreorderConfig(order.preorder_id);
  if (order.order_id !== orderId || !config?.enabled || config.cluster !== order.cluster || config.collection !== order.collection) {
    throw new Error('Preorder collection does not match its enabled cluster configuration.');
  }
  if (order.status === 'prepared') throw new Error('This preorder is not submitted; use normal checkout cancellation or expiry.');
  return order;
}

async function probeArchive(order: RecoveryOrder): Promise<RecoveryOutcome> {
  const rpcUrl = process.env.PREORDER_ARCHIVE_RPC_URL;
  if (!rpcUrl) throw new Error(`Set PREORDER_ARCHIVE_RPC_URL to a trusted ${order.cluster} archival RPC.`);
  let endpoint: URL;
  try { endpoint = new URL(rpcUrl); } catch { throw new Error('PREORDER_ARCHIVE_RPC_URL is invalid.'); }
  if (endpoint.protocol !== 'https:') throw new Error('PREORDER_ARCHIVE_RPC_URL must use HTTPS.');
  const signal = AbortSignal.timeout(5 * 60_000);
  const connection = new Connection(rpcUrl, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }),
  });
  try {
    return await probePreorderTransaction({
      config: getPreorderConfig(order.preorder_id)!, apiKey: '', fetch, signal,
      signature: order.signature!, transactionBase64: order.signed_transaction!,
      assets: assetsSchema.parse(JSON.parse(order.assets_json)),
      lastValidBlockHeight: order.last_valid_block_height, blockhashContextSlot: order.blockhash_context_slot,
    }, {
      createConnection: () => connection,
      verifyArchivedAbsence: (args) => verifyArchivedPreorderAbsence(connection, args),
    });
  } catch {
    throw new Error(`Archive verification failed. Use a trusted ${order.cluster} RPC with complete finalized block history; no recovery writes were made.`);
  }
}

export async function recoverPreorder(options: Options, dependencies: Dependencies = { query: queryRemoteCommerceD1, probe: probeArchive }) {
  let order = await readOrder(dependencies.query, options.orderId);
  let outcome: RecoveryOutcome | null = null;
  if (order.status === 'submitted') {
    if (!order.signature || !order.signed_transaction) throw new Error('Submitted preorder has no signed transaction.');
    outcome = await dependencies.probe(order);
    if (outcome.status === 'pending' || outcome.status === 'confirmed') {
      throw new Error('Outcome remains uncertain. Reservation preserved; wait for finalization or use an archive with complete history.');
    }
    if (options.write) {
      const status = outcome.status === 'finalized' ? 'succeeded' : outcome.status;
      await dependencies.query(`UPDATE commerce_preorder_orders SET status = ${sqlString(status)},
        ${outcome.status === 'finalized' ? `confirmed_slot = MAX(COALESCE(confirmed_slot, ${outcome.slot}), ${outcome.slot}),` : ''}
        updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL}, revision = revision + 1
        WHERE order_id = ${sqlString(order.order_id)} AND status = 'submitted'
          AND confirmed_slot IS ${order.confirmed_slot === null ? 'NULL' : order.confirmed_slot}
          AND signature = ${sqlString(order.signature)} AND signed_transaction = ${sqlString(order.signed_transaction)}
        RETURNING order_id`);
      order = await readOrder(dependencies.query, options.orderId);
      if (order.status === 'submitted') throw new Error('Preorder changed during recovery. Rerun to verify its outcome.');
    }
  }
  if (options.write && ['failed', 'expired', 'cancelled'].includes(order.status)) {
    await dependencies.query(`DELETE FROM commerce_preorder_claims WHERE order_id = ${sqlString(order.order_id)} AND EXISTS (
      SELECT 1 FROM commerce_preorder_orders WHERE order_id = ${sqlString(order.order_id)} AND status IN ('failed', 'expired', 'cancelled'))
      RETURNING card_id`);
  }
  return {
    orderId: order.order_id, buyer: order.buyer, signature: order.signature,
    status: order.status, verifiedOutcome: outcome?.status ?? order.status, write: options.write,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) console.log(usage);
  else {
    Promise.resolve().then(() => recoverPreorder(parsePreorderRecoveryArgs(process.argv.slice(2))))
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => { console.error(error instanceof Error ? error.message : 'Preorder recovery failed.'); process.exitCode = 1; });
  }
}
