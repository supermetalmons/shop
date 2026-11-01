import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseFreeMintConfigJson, freeMintOwnerCalls } from './free-mint-config.mjs';

const [command, ...input] = process.argv.slice(2);
const args = [];
let chainId;
for (let index = 0; index < input.length; index++) {
  if (input[index] !== '--chain-id') { args.push(input[index]); continue; }
  if (chainId !== undefined || !/^[1-9][0-9]*$/.test(input[index + 1] ?? '')) throw new Error('Invalid --chain-id.');
  chainId = Number(input[++index]);
  if (!Number.isSafeInteger(chainId)) throw new Error('Invalid --chain-id.');
}
if (!['check', 'calldata'].includes(command) ||
  command === 'check' && args.length > 1 || command === 'calldata' && (args.length < 1 || args.length > 2)) {
  throw new Error('Usage: node scripts/free-mints.mjs check [config-path] [--chain-id ID] | calldata <collection-address> [config-path] [--chain-id ID]');
}
const path = command === 'check' ? args[0] : args[1];
const configuration = parseFreeMintConfigJson(await readFile(path ? resolve(path) : new URL('../config/free-mints.json', import.meta.url), 'utf8'), undefined, chainId);
const result = command === 'check' ? configuration : freeMintOwnerCalls({ groups: configuration.groups,
  ...(configuration.chainId === undefined ? {} : { chainId: configuration.chainId }) }, args[0], chainId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
