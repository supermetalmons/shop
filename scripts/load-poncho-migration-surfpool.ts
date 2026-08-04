import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';

const PROGRAM_ID = 'C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A';
const ADMIN = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const surfpoolRpc = process.env.SURFPOOL_RPC_URL || 'http://127.0.0.1:8899';
const elfPath = process.env.PONCHO_PROGRAM_ELF || 'onchain/target/deploy/box_minter.so';
let rpcId = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(surfpoolRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: unknown };
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result as T;
}

const program = await rpc<any>('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
if (!program.value?.executable) throw new Error('Surfpool could not clone the program account');
const programData = Buffer.from(program.value.data[0], 'base64');
const programDataAddress = new PublicKey(programData.subarray(4, 36)).toBase58();
await rpc('getAccountInfo', [programDataAddress, { encoding: 'base64' }]);
const elf = await readFile(elfPath);
await rpc('surfnet_writeProgram', [PROGRAM_ID, elf.toString('hex'), 0, ADMIN]);
await rpc('surfnet_setAccount', [PROGRAM_ID, {
  lamports: program.value.lamports,
  data: programData.toString('hex'),
  owner: program.value.owner,
  executable: true,
}]);
const installed = await rpc<any>('getAccountInfo', [programDataAddress, { encoding: 'base64' }]);
const installedData = Buffer.from(installed.value.data[0], 'base64');
if (!installedData.subarray(45).equals(elf)) throw new Error('Surfpool ELF verification failed');
process.stdout.write(`${JSON.stringify({
  surfpoolRpc,
  programId: PROGRAM_ID,
  programDataAddress,
  elfPath,
  elfBytes: elf.length,
  elfSha256: createHash('sha256').update(elf).digest('hex'),
}, null, 2)}\n`);
