import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseTwinMetadataRequest, type TwinMetadataMaintenanceRequest, type TwinMetadataMaintenanceResult } from '../../shared/ethereum/twinMetadataMaintenance.ts';
import { privateHatchPath } from '../ethereum-metadata/privateHatchPath.ts';
import { withEthereumRevealMaintenance } from '../shared/ethereumRevealMaintenance.ts';

type Send = (request: TwinMetadataMaintenanceRequest) => Promise<TwinMetadataMaintenanceResult>;

export async function runTwinMetadata(command: 'inspect' | 'apply' | 'verify', manifest: unknown, send: Send) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid private twin manifest.');
  const prepared = parseTwinMetadataRequest({ ...manifest, action: 'prepare' });
  const { rows, ...identity } = prepared;
  const total = rows!.length;
  const good = rows!.filter(row => row.role === 'good twin').length;
  async function call(request: TwinMetadataMaintenanceRequest) {
    const r = await send(request);
    if (r.operationId !== identity.operationId || r.cohortSha256 !== identity.cohortSha256 ||
      !Number.isSafeInteger(r.registryRevision) || r.registryRevision < identity.expectedRevision || !Number.isSafeInteger(r.catalogRevision) ||
      r.phase === 'unstarted' && r.registryRevision !== identity.expectedRevision ||
      !['unstarted','prepared','publishing','complete'].includes(r.phase)) throw new Error('Unexpected twin operation identity or state.');
    if (r.phase !== 'unstarted' && (r.total !== total || r.good !== good || r.groups !== good || r.evil !== total - good ||
      !Number.isSafeInteger(r.published) || r.published < 0 || r.published > total ||
      (r.phase === 'complete') !== (r.published === total))) throw new Error('Twin publication counts did not reconcile.');
    return r;
  }
  if (command === 'inspect') return call({ ...identity, action: 'inspect' });
  if (command === 'apply') {
    let state = await call({ ...identity, action: 'inspect' });
    if (state.phase === 'unstarted') state = await call(prepared);
    while (state.phase !== 'complete') {
      const previous = state.published;
      state = await call({ ...identity, action: 'advance' });
      if (state.published <= previous) throw new Error('Twin publication did not advance; inspect and resume the same manifest.');
    }
    return state;
  }
  let offset = 0;
  while (true) {
    const state = await call({ ...identity, action: 'verify', after: offset });
    if (state.phase !== 'complete' || !Number.isSafeInteger(state.checked) || state.checked < 1 ||
      offset + state.checked > total || (state.next === null ? offset + state.checked !== total : state.next !== offset + state.checked)) {
      throw new Error('Incomplete twin verification page.');
    }
    offset += state.checked;
    if (state.next === null) return { ...state, checked: offset };
  }
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { manifest: { type: 'string' }, write: { type: 'boolean' } } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['inspect','apply','verify'].includes(command) || !values.manifest ||
    Boolean(values.write) !== (command === 'apply')) throw new Error('Usage: ethereum:twin-metadata <inspect|apply|verify> --manifest PRIVATE_JSON [--write for apply]');
  const manifest: unknown = JSON.parse(await readFile(privateHatchPath(values.manifest), 'utf8'));
  return withEthereumRevealMaintenance(transport => {
    if (!transport.twinMetadata) throw new Error('Private twin metadata service is unavailable.');
    return runTwinMetadata(command as 'inspect' | 'apply' | 'verify', manifest, request => transport.twinMetadata!(request));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
