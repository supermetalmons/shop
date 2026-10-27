import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { generateMetadata } from './generate.ts';
import { validateMetadata } from './validate.ts';
import type { EthereumMetadataNetwork } from '../../shared/ethereum/placeholderMetadata.ts';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: 'string', default: '.cache/111k-metadata' },
      network: { type: 'string', default: 'all' },
      concurrency: { type: 'string', default: '16' },
      journal: { type: 'string' },
      'token-ids': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!['generate', 'validate', 'upload'].includes(command) || positionals.length !== 1 || !['all', 'sepolia', 'mainnet'].includes(values.network)) {
    throw new Error('Usage: cli.ts generate|validate|upload --directory PATH --network all|sepolia|mainnet [--concurrency 16] [--journal PATH] [--token-ids 1,1000001]');
  }
  if (command === 'upload' && values.network === 'all') throw new Error('Upload requires an explicit --network sepolia or --network mainnet');
  if (command !== 'upload' && (values.journal || values['token-ids'])) throw new Error('--journal and --token-ids apply only to upload');
  const networks: EthereumMetadataNetwork[] = values.network === 'all' ? ['sepolia', 'mainnet'] : [values.network as EthereumMetadataNetwork];
  for (const network of networks) {
    const directory = join(resolve(values.directory), network);
    const progress = (count: number) => process.stderr.write(`${command} ${network}: ${count}/344948\n`);
    if (command === 'generate') console.log(JSON.stringify(await generateMetadata(directory, network, progress)));
    else if (command === 'validate') console.log(JSON.stringify(await validateMetadata(directory, network, progress)));
    else {
      const { uploadMetadata, metadataUploadConcurrency } = await import('./upload.ts');
      const concurrency = metadataUploadConcurrency(Number(values.concurrency));
      const tokenIds = values['token-ids']?.split(',');
      if (tokenIds?.some(id => !/^[1-9]\d*$/.test(id))) throw new Error('--token-ids requires comma-separated decimal token IDs');
      console.log(JSON.stringify(await uploadMetadata(directory, network, {
        concurrency, journal: values.journal ? resolve(values.journal) : undefined, tokenIds,
        progress: counts => process.stderr.write(`upload ${network}: ${counts.uploaded} uploaded, ${counts.skipped} resumed, ${counts.total} total\n`),
      })));
    }
  }
}

main().catch(error => {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  process.stderr.write(status ? `Metadata operation failed: remote HTTP ${status}\n` : `Metadata operation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
