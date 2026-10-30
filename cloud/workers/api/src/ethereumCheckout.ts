import { z } from 'zod';
import {
  ETHEREUM_CHECKOUT_ID, ETHEREUM_CHECKOUT_PATHS, checkoutReturnUrl, normalizeCheckoutCallback,
  normalizeCheckoutState, normalizeCheckoutTokenIds, type EthereumCheckoutStatusResponse,
  type EthereumCheckoutSubmissionResponse,
} from '../../../../shared/ethereum/checkout.js';
import { decodeEventLogs, decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.js';
import { ETHEREUM_111K_DROP_ID, ethereumHexQuantity, type EthereumInventoryItem } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import { ethereumRequestOrigin, limitEthereumRequest, verifyEthereumSession } from './ethereumAuth.js';
import { isAllowedProfileOrigin } from './profileReadSupport.js';
import { requireEthereum111kWrites } from './ethereumControl.js';
import {
  confirmEthereumDelivery, loadEthereumDelivery, prepareEthereumDeliveryQuote, requireMatchingDelivery,
  retireEthereumDelivery, type EthereumDeliveryRow,
} from './ethereumCommerce.js';
import {
  ethereumBlockSnapshot, ethereumCall, ethereumRpc, ethereumTransactionHash, requireEthereumContract,
  rpcInteger, verifyEthereumBlockSnapshot, type EthereumContext,
} from './ethereumRuntime.js';
import { ethereumInventoryItems, ethereumReceipt, ethereumTokenInfos, parseEthereumLog } from './ethereumRead.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { verifyCheckoutTransaction, type CheckoutTransaction } from './ethereumCheckoutTransaction.js';
import { blockingEthereumCheckout, inspectEthereumCheckoutFailures, requireResolvedEthereumCheckoutFailures } from './ethereumCheckoutAttempts.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const idSchema = z.string().regex(ETHEREUM_CHECKOUT_ID);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
type CheckoutReceiptReader = (hash: string) => ReturnType<typeof ethereumReceipt>;

export type EthereumCheckoutRow = {
  checkout_id: string; request_id: string; origin: string; drop_id: typeof ETHEREUM_111K_DROP_ID;
  chain_id: number; contract_address: string; token_ids_json: string; items_json: string;
  callback_url: string; callback_state: string | null; created_block: number; created_at_ms: number; expires_at_ms: number;
};

export type EthereumCheckoutAttemptRow = {
  attempt_id: string; checkout_id: string; order_id: number; wallet: string;
  status: 'started' | 'submitted' | 'rejected' | 'reverted' | 'failed' | 'superseded' | 'expired';
  transaction_hash: string | null; quote_deadline: number; expected_nonce: string | null;
  transaction_nonce: string | null; transaction_sender: string | null;
  block_number: number | null; block_hash: string | null; verified_at_block: number | null; checked_at_ms: number;
  created_at_ms: number; updated_at_ms: number;
};

async function loadCheckout(context: EthereumContext, checkoutId: string): Promise<EthereumCheckoutRow> {
  const checkout = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_checkouts
    WHERE checkout_id = ? AND chain_id = ? AND contract_address = ?`)
    .bind(checkoutId, context.config.chainId, context.config.contractAddress).first<EthereumCheckoutRow>();
  if (!checkout) throw new EthereumApiError('not-found', 'Checkout not found.');
  return checkout;
}

async function checkoutQuote(context: EthereumContext, checkoutId: string): Promise<EthereumDeliveryRow | null> {
  return context.env.COMMERCE_DB.prepare('SELECT * FROM ethereum_delivery_quotes WHERE checkout_id = ?')
    .bind(checkoutId).first<EthereumDeliveryRow>();
}

async function latestCheckoutAttempt(context: EthereumContext, checkoutId: string): Promise<EthereumCheckoutAttemptRow | null> {
  const latest = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_checkout_attempts
    WHERE checkout_id = ? ORDER BY CASE WHEN status = 'expired' THEN 0
      WHEN status IN ('started', 'submitted') THEN 1 ELSE 2 END, rowid DESC LIMIT 1`)
    .bind(checkoutId).first<EthereumCheckoutAttemptRow>();
  if (!latest || ['expired', 'started', 'submitted'].includes(latest.status)) return latest;
  return (await inspectEthereumCheckoutFailures(context, { checkoutId })).unresolved ?? latest;
}

async function checkoutAttempt(context: EthereumContext, attemptId: string): Promise<EthereumCheckoutAttemptRow | null> {
  return context.env.COMMERCE_DB.prepare('SELECT * FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
    .bind(attemptId).first<EthereumCheckoutAttemptRow>();
}

function checkoutItems(checkout: EthereumCheckoutRow): EthereumInventoryItem[] {
  return JSON.parse(checkout.items_json) as EthereumInventoryItem[];
}

function checkoutError(error: unknown): never {
  throw error instanceof EthereumApiError ? error : new EthereumApiError('invalid-argument', error instanceof Error ? error.message : 'Invalid checkout.');
}

async function checkoutStatus(context: EthereumContext, checkout: EthereumCheckoutRow, includeReturn: boolean,
  readOwnership = true, readReceipt: CheckoutReceiptReader = hash => ethereumReceipt(context, hash, true)): Promise<EthereumCheckoutStatusResponse> {
  const [quote, attempt] = await Promise.all([
    checkoutQuote(context, checkout.checkout_id), latestCheckoutAttempt(context, checkout.checkout_id),
  ]);
  const transactionHash = quote?.transaction_hash ?? attempt?.transaction_hash ?? null;
  let confirmations = 0;
  let failureCanonical = false;
  const verified = quote && transactionHash ? await readReceipt(transactionHash) : null;
  if (quote && verified) {
    const matching = verified.receipt?.status === '0x1' ? decodeEventLogs(verified.receipt.logs, quote.contract_address)
      .filter(event => event.name === 'DeliveryRedeemed' && event.orderId === quote.order_id) : [];
    if (matching.length === 1 && matching[0].name === 'DeliveryRedeemed') {
      requireMatchingDelivery(matching[0], quote);
      confirmations = verified.confirmations;
    }
    failureCanonical = Boolean(attempt && (attempt.status === 'failed' || attempt.status === 'reverted') &&
      verified.receipt?.transactionHash === attempt.transaction_hash && verified.receipt.blockHash === attempt.block_hash &&
      verified.confirmations >= context.config.confirmationBlocks &&
      await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_delivery_checkout_attempts AS saved
        JOIN ethereum_delivery_quotes AS quote ON quote.order_id = saved.order_id
        WHERE saved.attempt_id = ? AND saved.checkout_id = ? AND saved.status = ?
          AND saved.transaction_hash IS ? AND saved.block_number IS ? AND saved.block_hash IS ? AND saved.updated_at_ms = ?
          AND quote.status = ? AND quote.transaction_hash IS ? AND quote.block_number IS ? AND quote.block_hash IS ?
          AND quote.updated_at_ms = ? AND quote.published_at_ms IS ?
          AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS other
            WHERE other.checkout_id = saved.checkout_id
              AND (other.rowid > saved.rowid OR other.status IN ('started', 'submitted', 'expired')))`)
        .bind(attempt.attempt_id, attempt.checkout_id, attempt.status, attempt.transaction_hash,
          attempt.block_number, attempt.block_hash, attempt.updated_at_ms,
          quote.status, quote.transaction_hash, quote.block_number, quote.block_hash, quote.updated_at_ms, quote.published_at_ms).first());
  }
  const success = Boolean(quote && quote.status === 'confirmed' && quote.published_at_ms !== null &&
    verified?.receipt?.transactionHash === quote.transaction_hash && verified.receipt.blockHash === quote.block_hash &&
    rpcInteger(verified.receipt.blockNumber) === quote.block_number && confirmations >= context.config.confirmationBlocks &&
    await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_delivery_quotes
      WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = 'confirmed'
        AND transaction_hash = ? AND block_hash = ? AND block_number = ? AND updated_at_ms = ? AND published_at_ms = ?`)
      .bind(quote.chain_id, quote.contract_address, quote.order_id, quote.transaction_hash, quote.block_hash,
        quote.block_number, quote.updated_at_ms, quote.published_at_ms).first());
  const pending = quote?.status === 'pending' || quote?.status === 'confirmed' || attempt?.status === 'submitted' ||
    attempt && (attempt.status === 'failed' || attempt.status === 'reverted') && !failureCanonical;
  const submitting = attempt?.status === 'started';
  const failed = attempt?.status === 'expired' || failureCanonical || !quote && checkout.expires_at_ms <= context.nowMs;
  const status = success ? 'success' : pending ? 'pending' : submitting ? 'submitting' : failed ? 'failed' : quote ? 'prepared' : 'ready';
  const tokenIds = JSON.parse(checkout.token_ids_json) as string[];
  let items = checkoutItems(checkout);
  if (readOwnership && (status === 'ready' || status === 'prepared')) {
    const current = new Map((await ethereumTokenInfos(context, tokenIds)).map(item => [item.tokenId, item]));
    items = items.flatMap(item => {
      const live = current.get(item.tokenId);
      return live && live.kind === item.kind && live.displayId === item.displayId ? [{ ...item, owner: live.owner }] : [];
    });
  }
  const available = new Set(items.map(item => item.tokenId));
  return {
    checkoutId: checkout.checkout_id, dropId: checkout.drop_id, chainId: checkout.chain_id,
    contractAddress: checkout.contract_address, config: context.config, tokenIds, items,
    unavailableTokenIds: tokenIds.filter(id => !available.has(id)), wallet: quote?.wallet ?? null,
    status, orderId: quote?.order_id ?? null, transactionHash, confirmations,
    requiredConfirmations: context.config.confirmationBlocks, quoteExpiresAtMs: quote ? quote.deadline * 1000 : null,
    attempt: attempt ? { attemptId: attempt.attempt_id,
      status: attempt.status === 'reverted' || attempt.status === 'superseded' || attempt.status === 'expired' ? 'failed' : attempt.status,
      transactionHash: attempt.transaction_hash } : null,
    ...(includeReturn ? { returnUrl: checkoutReturnUrl({ callbackUrl: checkout.callback_url, state: checkout.callback_state,
      checkoutId: checkout.checkout_id, chainId: checkout.chain_id, transactionHash,
      result: success ? 'success' : pending || submitting ? 'pending' : failed ? 'failed' : 'canceled' }) } : {}),
  };
}

async function createCheckout(request: Request, context: EthereumContext): Promise<EthereumCheckoutStatusResponse> {
  await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  const body = await readEthereumBody(request, context.signal, z.object({ requestId: idSchema,
    dropId: z.literal(ETHEREUM_111K_DROP_ID), tokenIds: z.array(z.string()).min(1).max(50),
    callbackUrl: z.string().max(2048).optional(), state: z.string().max(512).optional() }).strict());
  const origin = ethereumRequestOrigin(request);
  let tokenIds: string[], callbackUrl: string, state: string | undefined;
  try {
    tokenIds = normalizeCheckoutTokenIds(body.tokenIds);
    callbackUrl = normalizeCheckoutCallback(body.callbackUrl, origin);
    state = normalizeCheckoutState(body.state);
  } catch (error) { return checkoutError(error); }
  const matches = (row: EthereumCheckoutRow) => row.origin === origin && row.drop_id === body.dropId &&
    row.chain_id === context.config.chainId && row.contract_address === context.config.contractAddress &&
    row.token_ids_json === JSON.stringify(tokenIds) && row.callback_url === callbackUrl && row.callback_state === (state ?? null);
  const load = () => context.env.COMMERCE_DB.prepare('SELECT * FROM ethereum_delivery_checkouts WHERE request_id = ?')
    .bind(body.requestId).first<EthereumCheckoutRow>();
  let checkout = await load();
  if (checkout) {
    if (!matches(checkout)) throw new EthereumApiError('failed-precondition', 'This checkout request was already used for different details.');
    return checkoutStatus(context, checkout, true);
  }
  const snapshot = await ethereumBlockSnapshot(context);
  const infos = (await ethereumTokenInfos(context, tokenIds, snapshot.blockHash)).filter(item => item.kind === 'artwork' || item.kind === 'crate');
  const items = await ethereumInventoryItems(context, infos);
  await verifyEthereumBlockSnapshot(context, snapshot);
  const itemsJson = JSON.stringify(items);
  if (new TextEncoder().encode(itemsJson).length > MAX_PREVIEW_BYTES) throw new EthereumApiError('invalid-argument', 'This selection is too large to preview. Choose fewer items.');
  await context.env.COMMERCE_DB.prepare(`INSERT OR IGNORE INTO ethereum_delivery_checkouts
    (checkout_id, request_id, origin, drop_id, chain_id, contract_address, token_ids_json, items_json,
      callback_url, callback_state, created_block, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), body.requestId, origin, body.dropId, context.config.chainId, requireEthereumContract(context),
      JSON.stringify(tokenIds), itemsJson, callbackUrl, state ?? null, snapshot.blockNumber, context.nowMs, context.nowMs + DRAFT_TTL_MS).run();
  checkout = await load();
  if (!checkout || !matches(checkout)) throw new EthereumApiError('failed-precondition', 'This checkout request was already used for different details.');
  return checkoutStatus(context, checkout, true, false);
}

async function prepareCheckout(request: Request, context: EthereumContext) {
  await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  const authentication = await verifyEthereumSession(request, context);
  await limitEthereumRequest(request, context, `checkout-prepare:${authentication.wallet}`, context.env.STAFF_AUTH_SESSION_RATE_LIMITER);
  const body = await readEthereumBody(request, context.signal, z.object({ checkoutId: idSchema,
    addressId: z.string().regex(/^[A-Za-z0-9]{20}$/).optional() }).strict());
  const checkout = await loadCheckout(context, body.checkoutId);
  const [existing, attempt] = await Promise.all([checkoutQuote(context, checkout.checkout_id), latestCheckoutAttempt(context, checkout.checkout_id)]);
  if (!existing && checkout.expires_at_ms <= context.nowMs) throw new EthereumApiError('failed-precondition', 'This checkout expired. Start a new checkout.');
  if (existing && existing.wallet !== authentication.wallet) throw new EthereumApiError('permission-denied', 'Connect the wallet that started this checkout.');
  if (attempt?.status === 'expired') throw new EthereumApiError('failed-precondition', 'This checkout expired without a redemption. Start a new checkout.');
  if (attempt && ['started', 'submitted'].includes(attempt.status)) throw new EthereumApiError('failed-precondition', 'Your earlier transaction is still being checked.');
  const addressId = body.addressId ?? existing?.address_id;
  if (!addressId) throw new EthereumApiError('invalid-argument', 'Enter a shipping address first.');
  return prepareEthereumDeliveryQuote(context, authentication.wallet,
    { tokenIds: JSON.parse(checkout.token_ids_json), addressId, requestId: checkout.checkout_id },
    { checkoutId: checkout.checkout_id, items: checkoutItems(checkout) });
}

async function assertCheckoutOwner(request: Request, context: EthereumContext, checkoutId: string) {
  const authentication = await verifyEthereumSession(request, context);
  await limitEthereumRequest(request, context, `checkout-submission:${authentication.wallet}`, context.env.STAFF_AUTH_SESSION_RATE_LIMITER);
  const checkout = await loadCheckout(context, checkoutId);
  const quote = await checkoutQuote(context, checkoutId);
  if (!quote) throw new EthereumApiError('failed-precondition', 'Prepare this checkout before submitting a transaction.');
  if (quote.wallet !== authentication.wallet) throw new EthereumApiError('permission-denied', 'This checkout belongs to a different wallet.');
  return { checkout, quote };
}

async function submissionCheckout(request: Request, context: EthereumContext): Promise<EthereumCheckoutSubmissionResponse> {
  await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  const body = await readEthereumBody(request, context.signal, z.discriminatedUnion('action', [
    z.object({ checkoutId: idSchema, attemptId: idSchema, action: z.literal('start'), quoteDeadline: z.number().int().positive() }).strict(),
    z.object({ checkoutId: idSchema, attemptId: idSchema, action: z.literal('reject') }).strict(),
    z.object({ checkoutId: idSchema, attemptId: idSchema, action: z.literal('report'), transactionHash: hashSchema }).strict(),
    z.object({ checkoutId: idSchema, attemptId: idSchema, action: z.literal('recover'), transactionHash: hashSchema }).strict(),
  ]));
  const { checkout, quote } = await assertCheckoutOwner(request, context, body.checkoutId);
  const existing = await checkoutAttempt(context, body.attemptId);
  if (existing && (existing.checkout_id !== checkout.checkout_id || existing.wallet !== quote.wallet || existing.order_id !== quote.order_id)) {
    throw new EthereumApiError('failed-precondition', 'This transaction attempt belongs to another checkout.');
  }
  let canSend = false;
  if (body.action === 'start') {
    if (body.quoteDeadline !== quote.deadline || existing && body.quoteDeadline !== existing.quote_deadline) {
      throw new EthereumApiError('failed-precondition', 'The checkout quote changed. Refresh it before sending this transaction.');
    }
    if (!existing) {
      if (quote.status !== 'prepared' || quote.deadline <= Math.floor(context.nowMs / 1000)) {
        throw new EthereumApiError('failed-precondition', 'Refresh the checkout before sending this transaction.');
      }
      const failures = await inspectEthereumCheckoutFailures(context, { wallet: quote.wallet, tokenIdsJson: quote.token_ids_json });
      requireResolvedEthereumCheckoutFailures(failures);
      const [used] = decodeReturn(['bool'], await ethereumCall(context, encodeCall('usedDeliveryOrders(uint256)', ['uint256'], [quote.order_id])));
      if (used) throw new EthereumApiError('failed-precondition', 'This redemption is already onchain. Wait for confirmation.');
      const selected = checkoutItems(checkout);
      const current = await ethereumTokenInfos(context, JSON.parse(quote.token_ids_json));
      if (current.length !== selected.length || current.some((item, index) => item.owner !== quote.wallet ||
        item.tokenId !== selected[index].tokenId || item.kind !== selected[index].kind || item.displayId !== selected[index].displayId)) {
        throw new EthereumApiError('failed-precondition', 'Your selected items changed ownership or are no longer available. Refresh this checkout.');
      }
      const nonce = await ethereumRpc(context, 'eth_getTransactionCount', [quote.wallet, 'pending']);
      if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(nonce)) throw new EthereumApiError('unavailable', 'The transaction nonce is unavailable. Try again.');
      const inserted = await context.env.COMMERCE_DB.prepare(`INSERT OR IGNORE INTO ethereum_delivery_checkout_attempts
        (attempt_id, checkout_id, order_id, wallet, status, quote_deadline, expected_nonce, created_at_ms, updated_at_ms)
        SELECT ?, ?, quote.order_id, quote.wallet, 'started', quote.deadline, ?, ?, ? FROM ethereum_delivery_quotes AS quote
        WHERE quote.checkout_id = ? AND quote.order_id = ? AND quote.wallet = ? AND quote.status = 'prepared' AND quote.deadline = ?
          AND quote.updated_at_ms = ? AND quote.transaction_hash IS NULL
          AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS terminal
            WHERE terminal.checkout_id = quote.checkout_id AND terminal.status = 'expired')
          AND ${failures.sql}`)
        .bind(body.attemptId, checkout.checkout_id, `0x${BigInt(nonce).toString(16)}`, context.nowMs, context.nowMs,
          checkout.checkout_id, quote.order_id, quote.wallet, body.quoteDeadline, quote.updated_at_ms, ...failures.values).run();
      canSend = inserted.meta.changes === 1;
      if (!canSend) {
        const concurrent = await checkoutAttempt(context, body.attemptId);
        if (concurrent?.checkout_id !== checkout.checkout_id || concurrent.quote_deadline !== body.quoteDeadline) {
          const blockingCheckoutId = await blockingEthereumCheckout(context, { wallet: quote.wallet, tokenIdsJson: quote.token_ids_json });
          throw new EthereumApiError('failed-precondition', blockingCheckoutId
            ? 'Some selected items already have a pending redemption. Return to that checkout to track or recover it.'
            : 'The checkout changed before sending. Refresh it and try again.',
          blockingCheckoutId ? { blockingCheckoutId } : undefined);
        }
      }
    }
  } else if (body.action === 'reject') {
    if (!existing) throw new EthereumApiError('not-found', 'Transaction attempt not found.');
    if (existing.transaction_hash) throw new EthereumApiError('failed-precondition', 'A submitted transaction cannot be canceled here.');
    await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'rejected',
      updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND status = 'started' AND transaction_hash IS NULL`)
      .bind(context.nowMs, existing.attempt_id).run();
  } else if (body.action === 'report') {
    if (!existing) throw new EthereumApiError('not-found', 'Transaction attempt not found.');
    const hash = ethereumTransactionHash(body.transactionHash);
    if (existing.transaction_hash && existing.transaction_hash !== hash) throw new EthereumApiError('failed-precondition', 'This attempt already has a transaction. Recover a replacement instead.');
    if (existing.status === 'rejected' || existing.status === 'superseded' || existing.status === 'expired') throw new EthereumApiError('failed-precondition', 'This transaction attempt is no longer active. Recover its hash instead.');
    await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'submitted', transaction_hash = ?,
      updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND status = 'started' AND transaction_hash IS NULL`)
      .bind(hash, context.nowMs, existing.attempt_id).run();
    const reported = await checkoutAttempt(context, body.attemptId);
    if (reported?.transaction_hash !== hash) throw new EthereumApiError('failed-precondition', 'The attempt changed before its hash was saved. Recover this transaction hash.');
  } else {
    await recoverCheckoutAttempt(context, checkout, quote, body.attemptId, ethereumTransactionHash(body.transactionHash), existing);
  }
  return { checkout: await checkoutStatus(context, checkout, true, false), canSend };
}

async function recoverCheckoutAttempt(context: EthereumContext, checkout: EthereumCheckoutRow, quote: EthereumDeliveryRow,
  attemptId: string, hash: string, existing: EthereumCheckoutAttemptRow | null): Promise<void> {
  if (existing) {
    if (existing.transaction_hash !== hash) throw new EthereumApiError('failed-precondition', 'This attempt already belongs to another transaction.');
    return;
  }
  const previous = await latestCheckoutAttempt(context, checkout.checkout_id);
  if (!previous) throw new EthereumApiError('failed-precondition', 'There is no transaction attempt to recover.');
  if (previous.status === 'expired') throw new EthereumApiError('failed-precondition', 'This checkout expired without a redemption. Start a new checkout.');
  const proof = await verifyCheckoutTransaction(context, quote, previous, hash, true);
  const updatedAtMs = Math.max(context.nowMs, previous.updated_at_ms + 1);
  try {
    await context.env.COMMERCE_DB.batch([
      context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'superseded', updated_at_ms = ?
        WHERE attempt_id = ? AND updated_at_ms = ? AND status = ? AND transaction_hash IS ?`)
        .bind(updatedAtMs, previous.attempt_id, previous.updated_at_ms, previous.status, previous.transaction_hash),
      context.env.COMMERCE_DB.prepare(`INSERT INTO ethereum_delivery_checkout_attempts
        (attempt_id, checkout_id, order_id, wallet, status, transaction_hash, quote_deadline, expected_nonce,
          transaction_nonce, transaction_sender, created_at_ms, updated_at_ms)
        SELECT ?, checkout_id, order_id, wallet, 'submitted', ?, quote_deadline, expected_nonce, ?, ?, ?, ?
        FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ? AND status = 'superseded' AND updated_at_ms = ?`)
        .bind(attemptId, hash, proof.nonce, proof.from, context.nowMs, updatedAtMs, previous.attempt_id, updatedAtMs),
    ]);
  } catch (error) {
    const concurrent = await checkoutAttempt(context, attemptId);
    if (!concurrent || concurrent.checkout_id !== checkout.checkout_id || concurrent.transaction_hash !== hash) throw error;
  }
  const recovered = await checkoutAttempt(context, attemptId);
  if (!recovered || recovered.checkout_id !== checkout.checkout_id || recovered.transaction_hash !== hash) {
    throw new EthereumApiError('failed-precondition', 'The transaction changed while recovering it. Refresh this checkout.');
  }
}

async function saveAttemptProof(context: EthereumContext, attempt: EthereumCheckoutAttemptRow, proof: CheckoutTransaction): Promise<void> {
  await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts
    SET transaction_nonce = ?, transaction_sender = ? WHERE attempt_id = ? AND transaction_hash = ? AND status = 'submitted'`)
    .bind(proof.nonce, proof.from, attempt.attempt_id, attempt.transaction_hash).run();
}

async function expireUnusedCheckoutAttempt(context: EthereumContext, quote: EthereumDeliveryRow, attempt: EthereumCheckoutAttemptRow): Promise<void> {
  if (!['started', 'submitted'].includes(attempt.status) || quote.status !== 'prepared' || quote.transaction_hash !== null) return;
  let snapshot: { blockNumber: number; blockHash: string };
  try {
    const block = await ethereumRpc(context, 'eth_getBlockByNumber', ['finalized', false]);
    if (!block || typeof block !== 'object' || !('number' in block) || !('hash' in block) || !('timestamp' in block) ||
      typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      rpcInteger(block.timestamp) <= Math.max(quote.deadline, attempt.quote_deadline)) return;
    snapshot = { blockNumber: rpcInteger(block.number), blockHash: block.hash.toLowerCase() };
    if (snapshot.blockNumber < context.config.deploymentBlock) return;
    const raw = await ethereumRpc(context, 'eth_call', [{ to: quote.contract_address,
      data: encodeCall('usedDeliveryOrders(uint256)', ['uint256'], [quote.order_id]) },
    { blockHash: snapshot.blockHash, requireCanonical: true }]);
    if (typeof raw !== 'string' || decodeReturn(['bool'], raw)[0] !== false) return;
    await verifyEthereumBlockSnapshot(context, snapshot);
  } catch {
    context.signal.throwIfAborted();
    return;
  }
  await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'expired',
    block_number = ?, block_hash = ?, verified_at_block = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE attempt_id = ? AND status = ? AND transaction_hash IS ? AND updated_at_ms = ?
      AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE order_id = ? AND checkout_id = ?
        AND chain_id = ? AND contract_address = ? AND status = 'prepared' AND transaction_hash IS NULL
        AND deadline = ? AND updated_at_ms = ?)`)
    .bind(snapshot.blockNumber, snapshot.blockHash, snapshot.blockNumber, context.nowMs,
      attempt.attempt_id, attempt.status, attempt.transaction_hash, attempt.updated_at_ms,
      quote.order_id, attempt.checkout_id, quote.chain_id, quote.contract_address, quote.deadline, quote.updated_at_ms).run();
}

export async function reconcileEthereumCheckoutAttempt(context: EthereumContext, attempt: EthereumCheckoutAttemptRow,
  readReceipt: CheckoutReceiptReader = hash => ethereumReceipt(context, hash, true)): Promise<boolean> {
  if (await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_delivery_checkout_attempts
    WHERE checkout_id = ? AND status = 'expired' LIMIT 1`).bind(attempt.checkout_id).first()) return false;
  const quote = await loadEthereumDelivery(context, attempt.order_id);
  if (!attempt.transaction_hash) {
    await expireUnusedCheckoutAttempt(context, quote, attempt);
    return false;
  }
  const verified = await readReceipt(attempt.transaction_hash);
  if (verified.receipt?.status === '0x1') {
    const events = decodeEventLogs(verified.receipt.logs, quote.contract_address).filter(event =>
      event.name === 'DeliveryRedeemed' && event.orderId === quote.order_id);
    if (events.length === 1 && events[0].name === 'DeliveryRedeemed') {
      requireMatchingDelivery(events[0], quote);
      await confirmEthereumDelivery(context, quote.order_id, attempt.transaction_hash, { ...verified, row: quote });
      return true;
    }
  }
  if (!verified.receipt) {
    if (attempt.status === 'reverted' || attempt.status === 'failed') {
      await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'submitted',
        block_number = NULL, block_hash = NULL, verified_at_block = NULL, updated_at_ms = MAX(updated_at_ms + 1, ?)
        WHERE attempt_id = ? AND status = ? AND transaction_hash = ? AND updated_at_ms = ?
          AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS active
            WHERE active.checkout_id = ? AND active.status IN ('started', 'submitted', 'expired'))`)
        .bind(context.nowMs, attempt.attempt_id, attempt.status, attempt.transaction_hash, attempt.updated_at_ms, attempt.checkout_id).run();
    }
    if (attempt.status === 'submitted') {
      try { await saveAttemptProof(context, attempt, await verifyCheckoutTransaction(context, quote, attempt, attempt.transaction_hash, false)); }
      catch (error) { if (!(error instanceof EthereumApiError && error.code === 'failed-precondition')) throw error; }
      await expireUnusedCheckoutAttempt(context, quote, attempt);
    }
    return false;
  }
  if (verified.confirmations < context.config.confirmationBlocks) return false;
  try { await verifyCheckoutTransaction(context, quote, attempt, attempt.transaction_hash, false); }
  catch (error) {
    if (!(error instanceof EthereumApiError && error.code === 'failed-precondition')) throw error;
    await expireUnusedCheckoutAttempt(context, quote, attempt);
    return false;
  }
  const blockNumber = rpcInteger(verified.receipt.blockNumber);
  await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = ?, block_number = ?, block_hash = ?,
    verified_at_block = ?, updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND transaction_hash = ?
      AND status IN ('submitted', 'reverted', 'failed')`)
    .bind(verified.receipt.status === '0x0' ? 'reverted' : 'failed', blockNumber, verified.receipt.blockHash,
      blockNumber + verified.confirmations - 1, context.nowMs, attempt.attempt_id, attempt.transaction_hash).run();
  return false;
}

async function discoverCheckoutDelivery(context: EthereumContext, checkout: EthereumCheckoutRow, quote: EthereumDeliveryRow,
  readReceipt: CheckoutReceiptReader): Promise<void> {
  const [used] = decodeReturn(['bool'], await ethereumCall(context, encodeCall('usedDeliveryOrders(uint256)', ['uint256'], [quote.order_id])));
  if (!used) return;
  const head = rpcInteger(await ethereumRpc(context, 'eth_blockNumber', []));
  const start = Math.max(checkout.created_block, head - 1999);
  const raw = await ethereumRpc(context, 'eth_getLogs', [{ address: quote.contract_address,
    fromBlock: ethereumHexQuantity(start), toBlock: ethereumHexQuantity(head),
    topics: [ETHEREUM_EVENT_TOPICS.DeliveryRedeemed, encodeAbi(['uint256'], [quote.order_id])] }]);
  if (!Array.isArray(raw) || raw.length > 50) throw new EthereumApiError('unavailable', 'Checkout confirmation is temporarily unavailable.');
  const events = decodeEventLogs(raw.map(parseEthereumLog), quote.contract_address).filter(event =>
    event.name === 'DeliveryRedeemed' && event.orderId === quote.order_id);
  for (const event of events) {
    if (event.name !== 'DeliveryRedeemed') continue;
    requireMatchingDelivery(event, quote);
    if (!event.log.transactionHash) throw new EthereumApiError('unavailable', 'The redemption event is missing its transaction.');
    const verified = await readReceipt(event.log.transactionHash);
    if (verified.receipt?.status === '0x0') throw new EthereumApiError('failed-precondition',
      'The Ethereum transaction reverted.', { kind: 'transaction-reverted' });
    await confirmEthereumDelivery(context, quote.order_id, event.log.transactionHash,
      { ...verified, row: await loadEthereumDelivery(context, quote.order_id) });
  }
}

async function refreshCheckout(request: Request, context: EthereumContext): Promise<EthereumCheckoutStatusResponse> {
  const body = await readEthereumBody(request, context.signal, z.object({ checkoutId: idSchema }).strict());
  const checkout = await loadCheckout(context, body.checkoutId);
  const quote = await checkoutQuote(context, checkout.checkout_id);
  const receipts = new Map<string, ReturnType<typeof ethereumReceipt>>();
  const readReceipt: CheckoutReceiptReader = hash => {
    if (!receipts.has(hash)) receipts.set(hash, ethereumReceipt(context, hash, true));
    return receipts.get(hash)!;
  };
  if (quote) {
    await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
    let observedHash: string | null = null;
    if (quote.transaction_hash) {
      const verified = await readReceipt(quote.transaction_hash);
      const hasDelivery = verified.receipt?.status === '0x1' && decodeEventLogs(verified.receipt.logs, quote.contract_address)
        .some(event => event.name === 'DeliveryRedeemed' && event.orderId === quote.order_id);
      if (hasDelivery) {
        await confirmEthereumDelivery(context, quote.order_id, quote.transaction_hash, { ...verified, row: quote });
        observedHash = quote.transaction_hash;
      }
      else await retireEthereumDelivery(context, quote);
    }
    const attempt = await latestCheckoutAttempt(context, checkout.checkout_id);
    if (attempt && (!observedHash || attempt.transaction_hash && attempt.transaction_hash !== observedHash)) {
      if (await reconcileEthereumCheckoutAttempt(context, attempt, readReceipt)) observedHash = attempt.transaction_hash;
    }
    const current = await loadEthereumDelivery(context, quote.order_id);
    if (!observedHash && (current.status !== 'confirmed' || current.published_at_ms === null)) {
      await discoverCheckoutDelivery(context, checkout, current, readReceipt);
    }
  }
  return checkoutStatus(context, checkout, true, true, readReceipt);
}

export async function ethereumCheckout(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  if (path === ETHEREUM_CHECKOUT_PATHS.status) {
    const params = new URL(request.url).searchParams;
    const checkoutId = params.get('checkoutId');
    if (!checkoutId || !ETHEREUM_CHECKOUT_ID.test(checkoutId) || params.size !== 1) throw new EthereumApiError('invalid-argument', 'Invalid checkout ID.');
    await limitEthereumRequest(request, context, 'checkout-status', context.env.PUBLIC_SHOP_RATE_LIMITER, isAllowedEthereumCheckoutStatusOrigin);
    return checkoutStatus(context, await loadCheckout(context, checkoutId), isAllowedProfileOrigin(ethereumRequestOrigin(request, isAllowedEthereumCheckoutStatusOrigin)));
  }
  if (path === ETHEREUM_CHECKOUT_PATHS.prepare) return prepareCheckout(request, context);
  if (path === ETHEREUM_CHECKOUT_PATHS.submission) return submissionCheckout(request, context);
  await limitEthereumRequest(request, context, path, path === ETHEREUM_CHECKOUT_PATHS.create
    ? context.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER : context.env.PUBLIC_SHOP_RATE_LIMITER);
  if (path === ETHEREUM_CHECKOUT_PATHS.create) return createCheckout(request, context);
  return refreshCheckout(request, context);
}
