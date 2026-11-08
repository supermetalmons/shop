import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePublicRelicConfigJson, publicRelicOwnerCalls } from './public-relic-config.mjs';

const [command, ...input] = process.argv.slice(2);
const args = [];
let chainId;
for (let index = 0; index < input.length; index++) {
  if (input[index] !== '--chain-id') { args.push(input[index]); continue; }
  if (chainId !== undefined || !/^[1-9][0-9]*$/.test(input[index + 1] ?? '')) throw new Error('Invalid --chain-id.');
  chainId = Number(input[++index]);
  if (!Number.isSafeInteger(chainId)) throw new Error('Invalid --chain-id.');
}
if (!['check', 'calldata'].includes(command) || chainId === undefined ||
  command === 'check' && args.length !== 1 || command === 'calldata' && args.length !== 2) {
  throw new Error('Usage: node scripts/public-relics.mjs check <config-path> --chain-id ID | calldata <collection-address> <config-path> --chain-id ID');
}
const configuration = parsePublicRelicConfigJson(await readFile(resolve(command === 'check' ? args[0] : args[1]), 'utf8'),
  command === 'calldata' ? args[0] : undefined, chainId);
const result = command === 'check' ? configuration : publicRelicOwnerCalls(configuration, args[0], chainId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
