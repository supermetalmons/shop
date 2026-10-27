import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type MetadataCommand = 'generate' | 'validate' | 'upload' | 'verify' | 'restore';
type MetadataNetwork = 'sepolia' | 'mainnet';

export type MetadataCliOptions = {
  command: MetadataCommand;
  directory: string;
  networks: MetadataNetwork[];
  concurrency: number;
  tokenIds?: string[];
  snapshotDirectory?: string;
  priorCacheRoot?: string;
};

const usage = `Usage: npm run ethereum:metadata -- <command> [options]

Commands: generate, validate, upload, verify, restore

  --directory PATH           Generated collection directory (default: .cache/111k-metadata/current)
  --network NETWORK          Required for upload, verify and restore: sepolia, mainnet or all
  --concurrency NUMBER       Concurrent remote requests (default: 32, maximum: 256)
  --token-ids IDS             Comma-separated token IDs for a sample upload or verification
  --snapshot-directory PATH  Upload rollback snapshot directory
  --prior-cache-root PATH    Previous canonical dataset or legacy root with network directories
  --help                     Show this help

For restore, --directory names the rollback snapshot directory.
`;

export function parseMetadataCliArgs(args: string[]): MetadataCliOptions | null {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: 'string', default: '.cache/111k-metadata/current' },
      network: { type: 'string' },
      concurrency: { type: 'string' },
      'token-ids': { type: 'string' },
      'snapshot-directory': { type: 'string' },
      'prior-cache-root': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  const command = positionals[0] as MetadataCommand;
  if (positionals.length !== 1 || !['generate', 'validate', 'upload', 'verify', 'restore'].includes(command)) {
    throw new Error(usage);
  }
  if (!values.directory.trim()) throw new Error('--directory cannot be empty');
  const remote = ['upload', 'verify', 'restore'].includes(command);
  if (remote && !['sepolia', 'mainnet', 'all'].includes(values.network ?? '')) {
    throw new Error('--network must explicitly select sepolia, mainnet or all');
  }
  if (!remote && values.network !== undefined) throw new Error('generate and validate use one network-independent collection; omit --network');
  if (!remote && values.concurrency !== undefined) throw new Error('--concurrency applies only to remote commands');
  const concurrency = Number(values.concurrency ?? '32');
  if (!/^[1-9]\d*$/.test(values.concurrency ?? '32') || !Number.isSafeInteger(concurrency) || concurrency > 256) {
    throw new Error('--concurrency must be an integer between 1 and 256');
  }
  if (values['token-ids'] !== undefined && !['upload', 'verify'].includes(command)) {
    throw new Error('--token-ids applies only to upload and verify');
  }
  const tokenIds = values['token-ids']?.split(',');
  if (tokenIds && (tokenIds.some(id => !/^[1-9]\d*$/.test(id)) || new Set(tokenIds).size !== tokenIds.length)) {
    throw new Error('--token-ids requires unique comma-separated decimal token IDs');
  }
  if ((values['snapshot-directory'] !== undefined || values['prior-cache-root'] !== undefined) && command !== 'upload') {
    throw new Error('--snapshot-directory and --prior-cache-root apply only to upload');
  }
  for (const option of ['snapshot-directory', 'prior-cache-root'] as const) {
    if (values[option] !== undefined && !values[option]!.trim()) throw new Error(`--${option} cannot be empty`);
  }
  return {
    command,
    directory: resolve(values.directory),
    networks: !remote ? [] : values.network === 'all' ? ['sepolia', 'mainnet'] : [values.network as MetadataNetwork],
    concurrency,
    ...(tokenIds ? { tokenIds } : {}),
    ...(values['snapshot-directory'] ? { snapshotDirectory: resolve(values['snapshot-directory']) } : {}),
    ...(values['prior-cache-root'] ? { priorCacheRoot: resolve(values['prior-cache-root']) } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseMetadataCliArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(usage);
    return;
  }
  const { command, directory } = options;
  if (command === 'generate' || command === 'validate') {
    const progress = (count: number) => process.stderr.write(`${command}: ${count}/344948\n`);
    const report = command === 'generate'
      ? await (await import('./generate.ts')).generateMetadata(directory, { progress })
      : await (await import('./validate.ts')).validateMetadata(directory, { progress });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const { uploadMetadata, verifyMetadata, restoreMetadata } = await import('./remote.ts');
  for (const network of options.networks) {
    const common = {
      concurrency: options.concurrency,
      progress: (counts: object) => process.stderr.write(`${command} ${network}: ${JSON.stringify(counts)}\n`),
    };
    const report = command === 'upload'
      ? await uploadMetadata(directory, network, { ...common, tokenIds: options.tokenIds,
        snapshotDirectory: options.snapshotDirectory, priorCacheRoot: options.priorCacheRoot })
      : command === 'verify' ? await verifyMetadata(directory, network, { ...common, tokenIds: options.tokenIds })
        : await restoreMetadata(directory, network, common);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    process.stderr.write(status ? `Metadata operation failed: remote HTTP ${status}\n`
      : `Metadata operation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
