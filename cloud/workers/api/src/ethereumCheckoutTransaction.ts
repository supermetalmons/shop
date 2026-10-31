import { decodeEventLogs, decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumReceiptIdsHash } from '../../../../shared/ethereum/crypto.js';
import { ethereumReceiptTokenId, isEthereumDeliveryKind } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumAddress, ethereumRpc, rpcInteger, type EthereumContext } from './ethereumRuntime.js';
import { ethereumReceipt, type EthereumTokenInfo } from './ethereumRead.js';
import { requireMatchingDelivery, type EthereumDeliveryRow } from './ethereumCommerce.js';
import type { EthereumCheckoutAttemptRow } from './ethereumCheckout.js';

export type CheckoutTransaction = { hash: string; from: string; to: string; data: string; value: string; nonce: string };

async function readCheckoutTransaction(context: EthereumContext, hash: string): Promise<CheckoutTransaction | null> {
  const raw = await ethereumRpc(context, 'eth_getTransactionByHash', [hash]);
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw new EthereumApiError('unavailable', 'Invalid Ethereum transaction.');
  const row = raw as Record<string, unknown>;
  const input = row.input ?? row.data;
  if (typeof row.hash !== 'string' || row.hash.toLowerCase() !== hash || typeof input !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(input) || typeof row.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.value) ||
    typeof row.nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.nonce) ||
    row.chainId !== undefined && rpcInteger(row.chainId) !== context.config.chainId) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum transaction.');
  }
  return { hash, from: ethereumAddress(row.from), to: ethereumAddress(row.to), data: input.toLowerCase(),
    value: `0x${BigInt(row.value).toString(16)}`, nonce: `0x${BigInt(row.nonce).toString(16)}` };
}

function matchesDeliveryIntent(transaction: CheckoutTransaction, quote: EthereumDeliveryRow, deadline: number): boolean {
  if (transaction.to !== quote.contract_address || BigInt(transaction.value) !== BigInt(quote.fee_wei) ||
    transaction.data.slice(0, 10) !== encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)', [], [])) return false;
  try {
    const [ids, fields] = decodeReturn(['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], `0x${transaction.data.slice(10)}`) as
      [bigint[], [bigint, string, bigint, bigint, string], string];
    const [orderId, wallet, fee, expires, receiptIdsHash] = fields;
    const items = JSON.parse(quote.items_json) as EthereumTokenInfo[];
    return orderId === BigInt(quote.order_id) && wallet === quote.wallet && fee === BigInt(quote.fee_wei) &&
      expires === BigInt(deadline) && JSON.stringify(ids.map(String)) === quote.token_ids_json &&
      receiptIdsHash === ethereumReceiptIdsHash(items.map(item => {
        if (!isEthereumDeliveryKind(item.kind)) throw new Error('Invalid delivery item.');
        return ethereumReceiptTokenId(item.kind, item.displayId);
      }));
  } catch { return false; }
}

function cannotRecover(message: string): never { throw new EthereumApiError('failed-precondition', message); }

async function matchingReceipt(context: EthereumContext, quote: EthereumDeliveryRow, hash: string): Promise<boolean> {
  const { receipt } = await ethereumReceipt(context, hash, true);
  if (!receipt || receipt.status !== '0x1') return false;
  const events = decodeEventLogs(receipt.logs, quote.contract_address).filter(event => event.name === 'DeliveryRedeemed' && event.orderId === quote.order_id);
  if (events.length !== 1 || events[0].name !== 'DeliveryRedeemed') return false;
  requireMatchingDelivery(events[0], quote);
  return true;
}

export async function verifyCheckoutTransaction(context: EthereumContext, quote: EthereumDeliveryRow,
  attempt: EthereumCheckoutAttemptRow, hash: string, recovering: boolean): Promise<CheckoutTransaction> {
  const candidate = await readCheckoutTransaction(context, hash);
  if (!candidate) return cannotRecover('That transaction is not visible yet. Check the hash and try again shortly.');
  if (candidate.from !== quote.wallet) {
    const code = await ethereumRpc(context, 'eth_getCode', [quote.wallet, 'latest']);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || !await matchingReceipt(context, quote, hash)) {
      return cannotRecover('Wait for the contract-wallet transaction to land, then recover its matching redemption hash.');
    }
    return candidate;
  }
  const intended = matchesDeliveryIntent(candidate, quote, attempt.quote_deadline);
  const cancellation = candidate.to === quote.wallet && candidate.data === '0x' && BigInt(candidate.value) === 0n;
  if (!intended && !cancellation) return cannotRecover('That transaction changes the saved checkout request.');
  if (!recovering) {
    if (!intended && !(attempt.transaction_sender === quote.wallet && attempt.transaction_nonce === candidate.nonce)) {
      return cannotRecover('That transaction does not match this checkout.');
    }
    if (attempt.expected_nonce !== null && BigInt(candidate.nonce) < BigInt(attempt.expected_nonce)) {
      return cannotRecover('That transaction is older than this checkout attempt.');
    }
    return candidate;
  }
  if (attempt.transaction_hash) {
    let nonce = attempt.transaction_nonce;
    let sender = attempt.transaction_sender;
    if (nonce === null || sender === null) {
      const original = await readCheckoutTransaction(context, attempt.transaction_hash);
      if (!original || original.from !== quote.wallet || !matchesDeliveryIntent(original, quote, attempt.quote_deadline)) {
        return cannotRecover('The original transaction is unavailable, so this replacement cannot be verified yet.');
      }
      nonce = original.nonce;
      sender = original.from;
    }
    if (sender !== quote.wallet || candidate.nonce !== nonce) return cannotRecover('That transaction does not replace this checkout transaction.');
  } else if (!intended || attempt.expected_nonce === null || BigInt(candidate.nonce) < BigInt(attempt.expected_nonce)) {
    return cannotRecover('That transaction does not match the saved checkout request and nonce.');
  }
  return candidate;
}
