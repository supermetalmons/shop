import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { requireEthereumAddress, type Hex } from './protocol.ts';

export type AbiType = string;
type AbiNode = { type: string; children?: AbiNode[]; item?: AbiNode; length?: number };
const MAX_ELEMENTS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;

function splitTypes(value: string): string[] {
  if (!value) return [];
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (depth < 0) throw new Error('Invalid ABI type');
    if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0) throw new Error('Invalid ABI type');
  result.push(value.slice(start));
  return result;
}

function parseType(value: string, depth = 0): AbiNode {
  if (depth > 8 || value.length > 512) throw new Error('ABI type is too complex');
  const type = value.replace(/\s/g, '');
  const array = /^(.*)\[([0-9]*)\]$/.exec(type);
  if (array) {
    const length = array[2] ? Number(array[2]) : undefined;
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > MAX_ELEMENTS)) throw new Error('Invalid ABI array size');
    return { type: 'array', item: parseType(array[1], depth + 1), length };
  }
  if (type.startsWith('(') && type.endsWith(')')) {
    return { type: 'tuple', children: splitTypes(type.slice(1, -1)).map(child => parseType(child, depth + 1)) };
  }
  if (['address', 'bool', 'bytes', 'string'].includes(type)) return { type };
  const integer = /^(u?int)([0-9]*)$/.exec(type);
  if (integer) {
    const bits = Number(integer[2] || 256);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new Error('Invalid ABI integer');
    return { type: `${integer[1]}${bits}` };
  }
  const fixedBytes = /^bytes([0-9]+)$/.exec(type);
  if (fixedBytes && Number(fixedBytes[1]) >= 1 && Number(fixedBytes[1]) <= 32) return { type };
  throw new Error(`Unsupported ABI type: ${type}`);
}

function dynamic(node: AbiNode): boolean {
  return node.type === 'bytes' || node.type === 'string' ||
    node.type === 'array' && (node.length === undefined || dynamic(node.item!)) ||
    node.type === 'tuple' && node.children!.some(dynamic);
}

function staticSize(node: AbiNode): number {
  if (dynamic(node)) return 32;
  if (node.type === 'array') return node.length! * staticSize(node.item!);
  if (node.type === 'tuple') return node.children!.reduce((sum, child) => sum + staticSize(child), 0);
  return 32;
}

function integer(value: unknown): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe ABI integer');
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') throw new Error('Invalid ABI integer');
  if (typeof value === 'string' && !/^-?(0|[1-9][0-9]*)$|^0x[0-9a-fA-F]+$/.test(value)) throw new Error('Invalid ABI integer');
  return BigInt(value);
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new Error('ABI integer outside uint256');
  return value.toString(16).padStart(64, '0');
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Invalid ABI bytes');
  return hexToBytes(value.slice(2));
}

function sequence(nodes: AbiNode[], values: unknown[]): string {
  if (nodes.length !== values.length || values.length > MAX_ELEMENTS) throw new Error('Invalid ABI argument count');
  const headBytes = nodes.reduce((sum, node) => sum + staticSize(node), 0);
  const heads: string[] = [];
  const tails: string[] = [];
  let tailBytes = 0;
  for (let index = 0; index < nodes.length; index++) {
    const encoded = encodeNode(nodes[index], values[index]);
    if (dynamic(nodes[index])) {
      heads.push(word(BigInt(headBytes + tailBytes)));
      tails.push(encoded);
      tailBytes += encoded.length / 2;
    } else heads.push(encoded);
  }
  if (headBytes + tailBytes > MAX_BYTES) throw new Error('ABI payload is too large');
  return heads.join('') + tails.join('');
}

function encodeNode(node: AbiNode, value: unknown): string {
  if (node.type === 'tuple') {
    if (!Array.isArray(value)) throw new Error('ABI tuple must be an array');
    return sequence(node.children!, value);
  }
  if (node.type === 'array') {
    if (!Array.isArray(value) || value.length > MAX_ELEMENTS || node.length !== undefined && value.length !== node.length) throw new Error('Invalid ABI array');
    return (node.length === undefined ? word(BigInt(value.length)) : '') + sequence(value.map(() => node.item!), value);
  }
  if (node.type === 'address') return requireEthereumAddress(value).slice(2).padStart(64, '0');
  if (node.type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('Invalid ABI boolean');
    return word(value ? 1n : 0n);
  }
  if (node.type === 'bytes' || node.type === 'string') {
    if (node.type === 'string' && typeof value !== 'string') throw new Error('Invalid ABI string');
    const encoded = node.type === 'string' ? utf8ToBytes(value as string) : bytes(value);
    if (encoded.length > MAX_BYTES) throw new Error('ABI payload is too large');
    return word(BigInt(encoded.length)) + bytesToHex(encoded).padEnd(Math.ceil(encoded.length / 32) * 64, '0');
  }
  if (node.type.startsWith('bytes')) {
    const encoded = bytes(value);
    if (encoded.length !== Number(node.type.slice(5))) throw new Error('Invalid fixed ABI bytes');
    return bytesToHex(encoded).padEnd(64, '0');
  }
  const signed = node.type.startsWith('int');
  const bits = BigInt(Number(node.type.slice(signed ? 3 : 4)));
  const parsed = integer(value);
  const limit = 1n << (signed ? bits - 1n : bits);
  if (parsed >= limit || parsed < (signed ? -limit : 0n)) throw new Error('ABI integer outside range');
  return word(parsed < 0n ? (1n << 256n) + parsed : parsed);
}

export function encodeAbi(types: readonly AbiType[], args: readonly unknown[]): Hex {
  return `0x${sequence(types.map(type => parseType(type)), [...args])}`;
}

function functionSelector(signature: string): Hex {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}`;
}

function eventTopic(signature: string): Hex {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;
}

export function encodeCall(signature: string, types: readonly AbiType[], args: readonly unknown[]): Hex {
  return `${functionSelector(signature)}${encodeAbi(types, args).slice(2)}`;
}

function readWord(data: Uint8Array, offset: number): bigint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > data.length) throw new Error('Truncated ABI payload');
  return BigInt(`0x${bytesToHex(data.subarray(offset, offset + 32))}`);
}

function safeSize(value: bigint, maximum = MAX_BYTES): number {
  if (value < 0n || value > BigInt(maximum)) throw new Error('Invalid ABI length or offset');
  return Number(value);
}

function decodeSequence(nodes: AbiNode[], data: Uint8Array, start: number): unknown[] {
  const headSize = nodes.reduce((sum, node) => sum + staticSize(node), 0);
  if (start + headSize > data.length) throw new Error('Truncated ABI head');
  let offset = start;
  return nodes.map(node => {
    const relative = dynamic(node) ? safeSize(readWord(data, offset)) : null;
    if (relative !== null && (relative % 32 !== 0 || relative < headSize)) throw new Error('Invalid ABI data offset');
    const result = decodeNode(node, data, relative === null ? offset : start + relative);
    offset += staticSize(node);
    return result;
  });
}

function decodeNode(node: AbiNode, data: Uint8Array, offset: number): unknown {
  if (node.type === 'tuple') return decodeSequence(node.children!, data, offset);
  if (node.type === 'array') {
    const length = node.length ?? safeSize(readWord(data, offset), MAX_ELEMENTS);
    const start = offset + (node.length === undefined ? 32 : 0);
    return decodeSequence(Array.from({ length }, () => node.item!), data, start);
  }
  const raw = readWord(data, offset);
  if (node.type === 'address') {
    if (raw >= 1n << 160n) throw new Error('Invalid ABI address padding');
    return `0x${raw.toString(16).padStart(40, '0')}`;
  }
  if (node.type === 'bool') {
    if (raw !== 0n && raw !== 1n) throw new Error('Invalid ABI boolean');
    return raw === 1n;
  }
  if (node.type === 'bytes' || node.type === 'string') {
    const length = safeSize(raw);
    if (offset + 32 + Math.ceil(length / 32) * 32 > data.length) throw new Error('Truncated ABI bytes');
    const result = data.subarray(offset + 32, offset + 32 + length);
    return node.type === 'string' ? new TextDecoder('utf-8', { fatal: true }).decode(result) : `0x${bytesToHex(result)}`;
  }
  if (node.type.startsWith('bytes')) {
    const length = Number(node.type.slice(5));
    if (data.subarray(offset + length, offset + 32).some(byte => byte !== 0)) throw new Error('Invalid ABI bytes padding');
    return `0x${bytesToHex(data.subarray(offset, offset + length))}`;
  }
  const signed = node.type.startsWith('int');
  const bits = BigInt(Number(node.type.slice(signed ? 3 : 4)));
  const result = signed && raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const limit = 1n << (signed ? bits - 1n : bits);
  if (result >= limit || result < (signed ? -limit : 0n)) throw new Error('Invalid ABI integer padding');
  return result;
}

export function decodeReturn(types: readonly AbiType[], value: string): unknown[] {
  const data = bytes(value);
  if (data.length > MAX_BYTES || data.length % 32 !== 0) throw new Error('Invalid ABI result length');
  return decodeSequence(types.map(type => parseType(type)), data, 0);
}

export type EthereumLog = {
  address: string; topics: string[]; data: string; logIndex?: string;
  blockNumber?: string; blockHash?: string; transactionHash?: string; removed?: boolean;
};

export type EthereumDecodedEvent =
  | { name: 'Transfer'; from: string; to: string; tokenId: string; log: EthereumLog }
  | { name: 'DeliveryRedeemed'; orderId: number; wallet: string; fee: string; tokenIds: string[]; receiptIds: string[]; log: EthereumLog }
  | { name: 'CrateReceiptClaimed'; claimId: string; wallet: string; receiptId: string; receiptIds: string[]; log: EthereumLog };

export const ETHEREUM_EVENT_TOPICS = {
  Transfer: eventTopic('Transfer(address,address,uint256)'),
  DeliveryRedeemed: eventTopic('DeliveryRedeemed(uint256,address,uint256,uint256[],uint256[])'),
  CrateReceiptClaimed: eventTopic('CrateReceiptClaimed(bytes32,address,uint256,uint256[])'),
} as const;

export function decodeEventLogs(logs: readonly EthereumLog[], contractAddress?: string): EthereumDecodedEvent[] {
  const expected = contractAddress ? requireEthereumAddress(contractAddress) : null;
  return logs.flatMap<EthereumDecodedEvent>(log => {
    if (log.removed || expected && log.address.toLowerCase() !== expected) return [];
    const topic = log.topics[0]?.toLowerCase();
    if (topic === ETHEREUM_EVENT_TOPICS.Transfer) {
      if (log.topics.length !== 4 || log.data !== '0x') throw new Error('Invalid Transfer event');
      return [{ name: 'Transfer', from: decodeReturn(['address'], log.topics[1])[0] as string,
        to: decodeReturn(['address'], log.topics[2])[0] as string,
        tokenId: String(decodeReturn(['uint256'], log.topics[3])[0]), log } satisfies EthereumDecodedEvent];
    }
    if (topic === ETHEREUM_EVENT_TOPICS.DeliveryRedeemed) {
      if (log.topics.length !== 3) throw new Error('Invalid delivery event');
      const orderId = safeSize(decodeReturn(['uint256'], log.topics[1])[0] as bigint, Number.MAX_SAFE_INTEGER);
      const wallet = decodeReturn(['address'], log.topics[2])[0] as string;
      const [fee, tokenIds, receiptIds] = decodeReturn(['uint256', 'uint256[]', 'uint256[]'], log.data);
      return [{ name: 'DeliveryRedeemed', orderId, wallet, fee: String(fee),
        tokenIds: (tokenIds as bigint[]).map(String), receiptIds: (receiptIds as bigint[]).map(String), log } satisfies EthereumDecodedEvent];
    }
    if (topic === ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed) {
      if (log.topics.length !== 4) throw new Error('Invalid crate claim event');
      const wallet = decodeReturn(['address'], log.topics[2])[0] as string;
      const receiptId = String(decodeReturn(['uint256'], log.topics[3])[0]);
      const [receiptIds] = decodeReturn(['uint256[]'], log.data);
      return [{ name: 'CrateReceiptClaimed', claimId: log.topics[1].toLowerCase(), wallet, receiptId,
        receiptIds: (receiptIds as bigint[]).map(String), log } satisfies EthereumDecodedEvent];
    }
    return [];
  });
}
