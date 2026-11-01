import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseFreeMintConfigJson, freeMintOwnerCalls } from './free-mint-config.mjs';

const [command, ...args] = process.argv.slice(2);
if (!['check', 'calldata'].includes(command) ||
  command === 'check' && args.length > 1 || command === 'calldata' && (args.length < 1 || args.length > 2)) {
  throw new Error('Usage: node scripts/free-mints.mjs check [config-path] | calldata <collection-address> [config-path]');
}
const path = command === 'check' ? args[0] : args[1];
const configuration = parseFreeMintConfigJson(await readFile(path ? resolve(path) : new URL('../config/free-mints.json', import.meta.url), 'utf8'));
const result = command === 'check' ? configuration : freeMintOwnerCalls({ groups: configuration.groups }, args[0]);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
