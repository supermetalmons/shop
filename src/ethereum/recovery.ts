import type { Ethereum111kConfig, EthereumPreparedTransaction } from '../../shared/ethereum/api';
import { decodeEventLogs, decodeReturn, encodeCall, type EthereumLog } from '../../shared/ethereum/abi';
import { ethereumReceiptIdsHash, ethereumTokenIdsHash } from '../../shared/ethereum/crypto';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_UNBOX_QUANTITY } from '../../shared/ethereum/protocol';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { EIP1193Provider } from '../wallet/injectedEthereumProviders';
import { ethereumAddress, ethereumChainId } from './wallet';
import type { EthereumPendingTransaction, EthereumSubmission } from './state';

type WalletTransaction = { hash: string; from: string; to: string; data: string; value: string; nonce: string };

async function readTransaction(provider: EIP1193Provider, hash: string, chainId: number): Promise<WalletTransaction | null> {
  const value = await provider.request({ method: 'eth_getTransactionByHash', params: [hash] });
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Your wallet returned an invalid transaction.');
  const row = value as Record<string, unknown>;
  const input = row.input ?? row.data;
  if (typeof row.hash !== 'string' || row.hash.toLowerCase() !== hash.toLowerCase() || !ethereumAddress(row.from) ||
    !ethereumAddress(row.to) || typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input) ||
    typeof row.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.value) ||
    typeof row.nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.nonce) ||
    row.chainId !== undefined && ethereumChainId(row.chainId) !== chainId) {
    throw new Error('This transaction does not match your Ethereum wallet or network.');
  }
  return { hash: row.hash.toLowerCase(), from: ethereumAddress(row.from)!, to: ethereumAddress(row.to)!, data: input.toLowerCase(),
    value: `0x${BigInt(row.value).toString(16)}`, nonce: `0x${BigInt(row.nonce).toString(16)}` };
}

async function readEthereumWalletTransaction(provider: EIP1193Provider, hash: string, chainId: number, owner: string): Promise<WalletTransaction | null> {
  const transaction = await readTransaction(provider, hash, chainId);
  if (transaction && transaction.from !== owner) throw new Error('This transaction does not match your Ethereum wallet or network.');
  return transaction;
}

async function deployedWallet(provider: EIP1193Provider, owner: string): Promise<boolean> {
  const code = await provider.request({ method: 'eth_getCode', params: [owner, 'latest'] });
  return typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code);
}

function transactionCallHash(transaction: WalletTransaction): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(JSON.stringify([transaction.to, transaction.data, transaction.value]))))}`;
}

export async function readEthereumSubmittedTransaction(provider: EIP1193Provider, hash: string, chainId: number, owner: string,
  intent: Pick<EthereumPreparedTransaction, 'to' | 'data' | 'value'>): Promise<{ nonce: string; transactionSender: string; transactionCallHash: string } | null> {
  const transaction = await readTransaction(provider, hash, chainId);
  if (!transaction) return null;
  if (transaction.from === owner) {
    if (!ethereumTransactionMatchesIntent(transaction, intent)) throw new Error('The transaction changes the saved Ethereum request.');
  } else if (!await deployedWallet(provider, owner)) throw new Error('This transaction does not match your Ethereum wallet or network.');
  return { nonce: transaction.nonce, transactionSender: transaction.from, transactionCallHash: transactionCallHash(transaction) };
}

function ethereumTransactionMatchesIntent(actual: Pick<WalletTransaction, 'to' | 'data' | 'value'>, intended: Pick<EthereumPreparedTransaction, 'to' | 'data' | 'value'>): boolean {
  return ethereumAddress(actual.to) === ethereumAddress(intended.to) && actual.data.toLowerCase() === intended.data.toLowerCase() &&
    BigInt(actual.value) === BigInt(intended.value);
}

async function ethereumReplacement(args: {
  provider: EIP1193Provider; config: Ethereum111kConfig; owner: string; pending: EthereumPendingTransaction;
  replacementHash: string; assertCurrent: () => void;
}): Promise<EthereumPendingTransaction> {
  const { provider, config, owner, pending, assertCurrent } = args;
  if (pending.transactionSender && pending.transactionSender !== owner) throw new Error('This transaction does not match the original Ethereum transaction sender.');
  const hash = args.replacementHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash) || hash === pending.hash) throw new Error('Paste the replacement transaction hash from your wallet.');
  let nonce = pending.nonce;
  let intent = pending.intent;
  if (!nonce || !intent) {
    const original = await readEthereumWalletTransaction(provider, pending.hash, config.chainId, owner);
    assertCurrent();
    if (!original || original.to !== config.contractAddress || intent && !ethereumTransactionMatchesIntent(original, intent)) {
      throw new Error('The original transaction is no longer available, so its replacement cannot be verified. Check your wallet before stopping tracking.');
    }
    nonce = original.nonce;
    intent = { to: original.to, data: original.data, value: original.value };
  }
  const replacement = await readEthereumWalletTransaction(provider, hash, config.chainId, owner);
  assertCurrent();
  if (!replacement) throw new Error('That transaction is not visible yet. Check the hash and try again shortly.');
  if (BigInt(replacement.nonce) !== BigInt(nonce)) throw new Error('That transaction does not replace the pending transaction.');
  const cancellation = replacement.to === owner && replacement.data === '0x' && BigInt(replacement.value) === 0n;
  if (!cancellation && !ethereumTransactionMatchesIntent(replacement, intent)) {
    throw new Error('The replacement changes the original transaction. Check your wallet before stopping tracking.');
  }
  const originalAction = pending.action === 'cancel' ? pending.actionBeforeCancellation : pending.action;
  if (!originalAction) throw new Error('The original action could not be identified. Check your wallet before stopping tracking.');
  return { ...pending, hash, nonce, intent, action: cancellation ? 'cancel' : originalAction,
    ...(cancellation ? { actionBeforeCancellation: originalAction } : {}),
  };
}

const recoveryEventTopics = Object.fromEntries([
  'CratesPurchased(address,uint256,uint256,uint256)',
  'WarehousesPurchased(address,uint256,uint256,uint256)',
  'WarehouseUnboxed(uint256,address,uint256,uint256)',
  'CrateUnboxed(uint256,address,uint256,uint256)',
  'CratesUnboxed(address,bytes32,uint256,uint256)',
].map(signature => [signature.slice(0, signature.indexOf('(')), `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`]));

function intentArguments(intent: NonNullable<EthereumSubmission['intent']>, signature: string, types: string[]): unknown[] | null {
  return intent.data.slice(0, 10).toLowerCase() === encodeCall(signature, [], [])
    ? decodeReturn(types, `0x${intent.data.slice(10)}`) : null;
}

export function matchesEthereumOperationEvent(pending: EthereumSubmission, owner: string, contract: string, log: EthereumLog): boolean {
  const intent = pending.intent;
  if (!intent || ethereumAddress(log.address) !== contract || log.removed) return false;
  if (pending.action !== 'mint' && pending.action !== 'delivery' && BigInt(intent.value) !== 0n) return false;
  const topic = log.topics[0]?.toLowerCase();
  if (pending.action === 'mint') {
    for (const [signature, event] of [[ETHEREUM_FUNCTIONS.mintCrates, 'CratesPurchased'], [ETHEREUM_FUNCTIONS.mintWarehouses, 'WarehousesPurchased']]) {
      const args = intentArguments(intent, signature, ['uint256']);
      if (!args || topic !== recoveryEventTopics[event] || log.topics.length !== 2) continue;
      const [, quantity, paid] = decodeReturn(['uint256', 'uint256', 'uint256'], log.data);
      return decodeReturn(['address'], log.topics[1])[0] === owner && quantity === args[0] && paid === BigInt(intent.value);
    }
    return false;
  }
  if (pending.action === 'unbox') {
    const batchArgs = intentArguments(intent, ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]']);
    if (batchArgs) {
      const ids = batchArgs[0] as bigint[];
      if (!ids.length || ids.length > ETHEREUM_MAX_UNBOX_QUANTITY || new Set(ids).size !== ids.length ||
        ids.some(id => id < 111112n || id > 116666n) || topic !== recoveryEventTopics.CratesUnboxed || log.topics.length !== 3) return false;
      const [firstArtToken, artworkCount] = decodeReturn(['uint256', 'uint256'], log.data) as bigint[];
      const expectedCount = BigInt(ids.length * 20 + (ids.includes(116666n) ? 11 : 0));
      return decodeReturn(['address'], log.topics[1])[0] === owner && log.topics[2].toLowerCase() === ethereumTokenIdsHash(ids) &&
        artworkCount === expectedCount && firstArtToken > 0n && firstArtToken + artworkCount - 1n <= 111111n;
    }
    for (const [signature, event] of [[ETHEREUM_FUNCTIONS.unboxCrate, 'CrateUnboxed'], [ETHEREUM_FUNCTIONS.unboxWarehouse, 'WarehouseUnboxed']]) {
      const args = intentArguments(intent, signature, ['uint256']);
      if (!args || topic !== recoveryEventTopics[event] || log.topics.length !== 3) continue;
      decodeReturn(['uint256', 'uint256'], log.data);
      return decodeReturn(['uint256'], log.topics[1])[0] === args[0] && decodeReturn(['address'], log.topics[2])[0] === owner;
    }
    return false;
  }
  const event = decodeEventLogs([log], contract)[0];
  if (pending.action === 'delivery' && event?.name === 'DeliveryRedeemed') {
    const args = intentArguments(intent, ETHEREUM_FUNCTIONS.redeemForDelivery, ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes']);
    if (!args) return false;
    const [ids, [orderId, wallet, fee, , receiptIdsHash]] = args as [bigint[], [bigint, string, bigint, bigint, string], string];
    return event.wallet === owner && wallet === owner && event.orderId === pending.orderId && BigInt(event.orderId) === orderId &&
      BigInt(event.fee) === fee && fee === BigInt(intent.value) && JSON.stringify(event.tokenIds) === JSON.stringify(ids.map(String)) &&
      ethereumReceiptIdsHash(event.receiptIds) === receiptIdsHash;
  }
  if (pending.action === 'claim' && event?.name === 'CrateReceiptClaimed') {
    const args = intentArguments(intent, ETHEREUM_FUNCTIONS.claimCrateReceipt, ['uint256', 'bytes32', 'uint256', 'bytes']);
    return Boolean(args && event.wallet === owner && event.receiptId === String(args[0]) && event.claimId === args[1] && event.claimId === pending.claimId);
  }
  if (pending.action === 'transfer' && event?.name === 'Transfer') {
    const args = intentArguments(intent, ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256']);
    return Boolean(args && args[0] === owner && event.from === owner && event.to === args[1] && event.tokenId === String(args[2]));
  }
  return false;
}

async function wrappedTransactionProof(provider: EIP1193Provider, hash: string, pending: EthereumSubmission,
  owner: string, contract: string, assertCurrent: () => void): Promise<void> {
  const raw = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  assertCurrent();
  if (raw === null) throw new Error('Wait until the contract-wallet transaction is mined, then try its transaction hash again.');
  if (!raw || typeof raw !== 'object') throw new Error('Your wallet returned an invalid transaction receipt.');
  const receipt = raw as Record<string, unknown>;
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash ||
    typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber) ||
    typeof receipt.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) || !Array.isArray(receipt.logs)) {
    throw new Error('Your wallet returned an invalid transaction receipt.');
  }
  if (receipt.status !== '0x1') throw new Error('The contract-wallet transaction did not succeed.');
  const canonical = await provider.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
  assertCurrent();
  if (!canonical || typeof canonical !== 'object' || !('hash' in canonical) || canonical.hash !== receipt.blockHash) {
    throw new Error('The contract-wallet transaction is no longer in the canonical chain. Wait for it to be mined again.');
  }
  const logs = receipt.logs.filter((value): value is EthereumLog => Boolean(value && typeof value === 'object' &&
    typeof value.address === 'string' && Array.isArray(value.topics) && value.topics.every((topic: unknown) => typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic)) &&
    typeof value.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value.data)));
  if (logs.filter(log => matchesEthereumOperationEvent(pending, owner, contract, log)).length !== 1) {
    throw new Error('That transaction does not contain the saved Ethereum operation for your wallet.');
  }
}

export async function recoverEthereumTransaction(args: {
  provider: EIP1193Provider; config: Ethereum111kConfig; owner: string; pending: EthereumSubmission | EthereumPendingTransaction;
  transactionHash: string; assertCurrent: () => void;
}): Promise<EthereumPendingTransaction> {
  const { provider, config, owner, pending, assertCurrent } = args;
  const hash = args.transactionHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Paste the transaction hash from your wallet.');
  let directError: unknown;
  try {
    if ('hash' in pending) return await ethereumReplacement({ provider, config, owner, pending, replacementHash: hash, assertCurrent });
    const actual = await readEthereumWalletTransaction(provider, hash, config.chainId, owner);
    assertCurrent();
    if (!actual || !pending.intent || !ethereumTransactionMatchesIntent(actual, pending.intent)) throw new Error('That transaction does not match the saved Ethereum request.');
    if (!pending.nonce || BigInt(actual.nonce) < BigInt(pending.nonce)) throw new Error('That transaction does not match the saved Ethereum request nonce.');
    return { ...pending, hash, nonce: actual.nonce };
  } catch (error) { directError = error; }
  assertCurrent();
  if ('hash' in pending && hash === pending.hash) throw directError;
  const candidate = await readTransaction(provider, hash, config.chainId);
  assertCurrent();
  if (candidate?.from === owner) throw directError;
  let deployed = false;
  try { deployed = await deployedWallet(provider, owner); } catch {}
  assertCurrent();
  if (!deployed) throw directError;
  if (!candidate) throw new Error('That transaction is not visible yet. Check the hash and try again shortly.');
  if (!pending.intent || ethereumAddress(pending.intent.to) !== config.contractAddress || pending.action === 'cancel') {
    throw new Error('This contract-wallet request cannot be safely recovered. Check your wallet before stopping tracking.');
  }
  const repeatable = pending.action === 'mint' || pending.action === 'transfer';
  if (!('hash' in pending) && repeatable) {
    throw new Error('Cannot safely recover this contract-wallet mint or transfer without its original transaction hash. Check your wallet before stopping tracking.');
  }
  if ('hash' in pending && repeatable) {
    let sender = pending.transactionSender, nonce = pending.nonce, callHash = pending.transactionCallHash;
    if (!sender || !nonce || !callHash) {
      const original = await readTransaction(provider, pending.hash, config.chainId);
      assertCurrent();
      if (!original) throw new Error('The original transaction is no longer available, so its replacement cannot be verified. Check your wallet before stopping tracking.');
      sender = original.from;
      nonce = original.nonce;
      callHash = transactionCallHash(original);
    }
    if (candidate.from !== sender || BigInt(candidate.nonce) !== BigInt(nonce)) {
      throw new Error('That transaction does not replace the pending contract-wallet transaction.');
    }
    if (transactionCallHash(candidate) !== callHash) throw new Error('The replacement changes the original contract-wallet transaction.');
  }
  await wrappedTransactionProof(provider, hash, pending, owner, config.contractAddress!, assertCurrent);
  return { ...pending, hash, nonce: candidate.nonce, transactionSender: candidate.from, transactionCallHash: transactionCallHash(candidate) };
}
