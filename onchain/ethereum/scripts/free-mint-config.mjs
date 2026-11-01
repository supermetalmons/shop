import { encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const MAX_FREE_MINT_WALLETS = 32;
const limits = { crates: 5555, warehouses: 505, relics: 18 };
const fields = ['crates', 'name', 'relics', 'wallets', 'warehouses'];

function requireAddress(value, collectionAddress) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value) ||
    value.toLowerCase() === collectionAddress?.toLowerCase()) throw new Error('Invalid free mint wallet address.');
  return value.toLowerCase();
}

export function parseFreeMintConfig(value, collectionAddress, chainId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.groups) ||
    Object.keys(value).some(key => key !== 'groups' && key !== 'chainId')) throw new Error('Invalid free mint configuration.');
  const restricted = Object.hasOwn(value, 'chainId');
  if (restricted && (value.chainId !== 11155111 || chainId !== value.chainId)) {
    throw new Error('The Sepolia free mint configuration requires explicit chain ID 11155111.');
  }
  const names = new Set();
  const wallets = new Set();
  const allocations = [];
  const groups = value.groups.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group) ||
      Object.keys(group).sort().join(',') !== fields.join(',') ||
      typeof group.name !== 'string' || group.name.length === 0 || names.has(group.name) ||
      !Array.isArray(group.wallets)) throw new Error('Invalid free mint group.');
    names.add(group.name);
    for (const [kind, maximum] of Object.entries(limits)) {
      if (!Number.isInteger(group[kind]) || group[kind] < 0 || group[kind] > maximum) {
        throw new Error(`Invalid free mint ${kind} limit.`);
      }
    }
    const addresses = group.wallets.map(wallet => {
      const address = requireAddress(wallet, collectionAddress);
      if (wallets.has(address)) throw new Error('Free mint wallets must be distinct across all groups.');
      wallets.add(address);
      if (wallets.size > MAX_FREE_MINT_WALLETS) throw new Error('Free mint configuration supports at most 32 wallets.');
      allocations.push({ wallet: address, crateLimit: group.crates, warehouseLimit: group.warehouses, relicLimit: group.relics });
      return address;
    });
    return { name: group.name, crates: group.crates, warehouses: group.warehouses, relics: group.relics, wallets: addresses };
  });
  return { ...(restricted ? { chainId: value.chainId } : {}), groups, allocations };
}

export function parseFreeMintConfigJson(json, collectionAddress, chainId) {
  const value = JSON.parse(json);
  for (const match of json.matchAll(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (match[1] !== undefined && !/^(?:0|[1-9]\d*)$/.test(match[1])) {
      throw new Error('Free mint limits must use nonnegative decimal integer JSON literals.');
    }
  }
  return parseFreeMintConfig(value, collectionAddress, chainId);
}

export function freeMintOwnerCalls(value, collectionAddress, chainId) {
  const to = requireAddress(collectionAddress);
  const { groups, chainId: restrictedChainId } = parseFreeMintConfig(value, to, chainId);
  const selector = bytesToHex(keccak_256(utf8ToBytes('setFreeMintAllowances(address[],uint16,uint16,uint16)'))).slice(0, 8);
  return groups.filter(group => group.wallets.length > 0).map(group => ({
    group: group.name,
    ...(restrictedChainId === undefined ? {} : { chainId: restrictedChainId }),
    to,
    data: `0x${selector}${bytesToHex(encode(['address[]', 'uint16', 'uint16', 'uint16'],
      [group.wallets, group.crates, group.warehouses, group.relics]))}`,
    value: '0',
  }));
}
