import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = new URL('../', import.meta.url);
const artifact = JSON.parse(await readFile(new URL('out/NFT111K.sol/NFT111K.json', project), 'utf8'));
const target = new URL('../../shared/ethereum/abi.generated.ts', project);
const source = `export const nft111KAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8').catch(() => '');
  if (existing !== source) throw new Error(`Generated ABI is stale: ${fileURLToPath(target)}`);
} else {
  await writeFile(target, source);
}
