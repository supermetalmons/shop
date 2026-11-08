import { encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

function address(value, collection) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value) ||
    value.toLowerCase() === collection?.toLowerCase()) throw new Error('Invalid public relic wallet address.');
  return value.toLowerCase();
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 18) throw new Error('Public relic limits must be integers from 0 to 18.');
  return value;
}

export function parsePublicRelicConfig(value, collection, chainId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['chainId', 'sale', 'groups'].includes(key)) ||
    !Object.hasOwn(value, 'sale') && !Object.hasOwn(value, 'groups')) throw new Error('Invalid public relic configuration.');
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0 || chainId !== value.chainId) {
    throw new Error('Public relic configuration requires its explicit matching chain ID.');
  }
  const result = { chainId: value.chainId };
  if (Object.hasOwn(value, 'sale')) {
    const sale = value.sale;
    if (!sale || typeof sale !== 'object' || Array.isArray(sale) ||
      Object.keys(sale).sort().join(',') !== 'active,limit,priceWei' || typeof sale.active !== 'boolean' ||
      typeof sale.priceWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(sale.priceWei) ||
      BigInt(sale.priceWei) >= (1n << 256n)) throw new Error('Invalid public relic sale configuration.');
    result.sale = { limit: limit(sale.limit), priceWei: sale.priceWei, active: sale.active };
  }
  if (Object.hasOwn(value, 'groups')) {
    if (!Array.isArray(value.groups)) throw new Error('Invalid public relic allowance groups.');
    const names = new Set();
    const wallets = new Set();
    result.groups = value.groups.map(group => {
      if (!group || typeof group !== 'object' || Array.isArray(group) ||
        Object.keys(group).sort().join(',') !== 'limit,name,wallets' || typeof group.name !== 'string' ||
        !group.name.length || names.has(group.name) || !Array.isArray(group.wallets) || group.wallets.length > 32) {
        throw new Error('Public relic allowance groups need unique names and at most 32 wallets.');
      }
      names.add(group.name);
      return { name: group.name, limit: limit(group.limit), wallets: group.wallets.map(wallet => {
        const normalized = address(wallet, collection);
        if (wallets.has(normalized)) throw new Error('Public relic wallets must be distinct across all groups.');
        wallets.add(normalized);
        return normalized;
      }) };
    });
  }
  return result;
}

export function parsePublicRelicConfigJson(json, collection, chainId) {
  const value = JSON.parse(json);
  for (const match of json.matchAll(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (match[1] !== undefined && !/^(?:0|[1-9]\d*)$/.test(match[1])) {
      throw new Error('Public relic limits and chain IDs must use nonnegative decimal integer JSON literals.');
    }
  }
  return parsePublicRelicConfig(value, collection, chainId);
}

export function publicRelicOwnerCalls(value, collection, chainId) {
  const to = address(collection);
  const config = parsePublicRelicConfig(value, to, chainId);
  const call = (name, signature, types, args) => ({ name, chainId: config.chainId, to, value: '0',
    data: `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}${bytesToHex(encode(types, args))}` });
  const calls = [];
  if (config.sale) calls.push(call('sale', 'setPublicRelicSale(uint256,uint256,bool)', ['uint256', 'uint256', 'bool'],
    [config.sale.limit, config.sale.priceWei, config.sale.active]));
  for (const group of config.groups ?? []) if (group.wallets.length) {
    calls.push(call(group.name, 'setPublicRelicFreeMintAllowances(address[],uint16)', ['address[]', 'uint16'],
      [group.wallets, group.limit]));
  }
  return calls;
}
