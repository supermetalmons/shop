import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createD1MaintenanceRunner, loadD1Credentials } from '../shared/d1MaintenanceRunner.ts';
import { verifyTarotMedia } from './media.ts';
import { assertExistingTarotCredentialPin, assertTarotDeploymentActive, createTarotClaimLinks, loadTarotClaimLinks,
  privateDirectory, provisionTarotCredentials, readTarotCredentials, recordVerifiedTarotCredentials } from './claimLinks.ts';
import { rebindTarotCredentials } from './rebind.ts';
import { bindMainnetCredentials, createMainnetClaimLinks, loadMainnetBindingRelease, loadMainnetClaimLinks, mainnetBindingConfiguration,
  mainnetBindingRpc, mainnetCredentialFingerprint,
  stageMainnetCredentials, verifyMainnetCredentials } from './mainnetClaims.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runTarotOperations(argv: string[]) {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { directory: { type: 'string' }, contract: { type: 'string' }, 'deployment-block': { type: 'string' },
      'deployment-transaction': { type: 'string' }, 'source-directory': { type: 'string' }, 'source-pin': { type: 'string' },
      'deployment-directory': { type: 'string' } } });
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  const command = positionals[0];
  if (positionals.length !== 1 || new Set(options).size !== options.length ||
    !['verify-media', 'links', 'rebind', 'provision', 'verify-codes',
      'mainnet-links', 'mainnet-provision', 'mainnet-verify', 'mainnet-bind'].includes(command)) {
    throw new Error('Use verify-media|links|rebind|provision|verify-codes|mainnet-links|mainnet-provision|mainnet-verify|mainnet-bind [--directory PATH] [--contract ADDRESS for links or mainnet-bind] [--source-directory PATH --source-pin PATH --deployment-directory PATH for rebind] [--deployment-block BLOCK --deployment-transaction HASH --deployment-directory PATH for mainnet-bind].');
  }
  for (const option of ['source-directory', 'source-pin'] as const) {
    if (command === 'rebind' ? !values[option]?.trim() : values[option] !== undefined) {
      throw new Error('rebind requires --source-directory, --source-pin, and --deployment-directory; these options are only allowed for rebind.');
    }
  }
  if (command === 'rebind' && !values['deployment-directory']?.trim()) {
    throw new Error('rebind requires --source-directory, --source-pin, and --deployment-directory.');
  }
  if (!['rebind', 'mainnet-bind'].includes(command) && values['deployment-directory'] !== undefined) {
    throw new Error('--deployment-directory is only allowed for rebind or mainnet-bind.');
  }
  if (command !== 'links' && command !== 'mainnet-bind' && values.contract !== undefined) throw new Error('--contract is only allowed for links or mainnet-bind.');
  if (command !== 'mainnet-bind' && values['deployment-block'] !== undefined) throw new Error('--deployment-block is only allowed for mainnet-bind.');
  if (command !== 'mainnet-bind' && values['deployment-transaction'] !== undefined) throw new Error('--deployment-transaction is only allowed for mainnet-bind.');
  if (command === 'verify-media') {
    if (options.length) throw new Error('verify-media does not accept credential options.');
    return verifyTarotMedia();
  }
  if (command === 'rebind') {
    loadD1Credentials(root);
    return rebindTarotCredentials({ root, sourceDirectory: resolve(root, values['source-directory']!),
      sourcePin: resolve(root, values['source-pin']!), deploymentDirectory: resolve(root, values['deployment-directory']!),
      directory: resolve(root, values.directory || '.operations/dmx-sepolia-v3') }, createD1MaintenanceRunner('ops'));
  }
  if (command.startsWith('mainnet-')) {
    const binding = command === 'mainnet-bind'
      ? mainnetBindingConfiguration(values.contract, values['deployment-block'], values['deployment-transaction']) : null;
    if (binding && !values['deployment-directory']?.trim()) {
      throw new Error('Mainnet binding requires --deployment-directory for the approved frozen collection release.');
    }
    const deploymentDirectory = binding ? resolve(root, values['deployment-directory']!) : null;
    const rpc = binding ? mainnetBindingRpc() : null;
    if (!binding && values.contract !== undefined) throw new Error('Mainnet staging must not bind a contract.');
    const directory = resolve(root, values.directory || '.operations/dmx-mainnet-v1');
    privateDirectory(directory, root);
    const locks = [resolve(directory, 'claim-links.lock'),
      ...(deploymentDirectory ? [resolve(deploymentDirectory, 'operation.lock')] : [])].sort();
    const locked = async <T>(index: number, work: () => Promise<T>): Promise<T> => index === locks.length
      ? work() : withMetadataLock(locks[index], () => locked(index + 1, work));
    return locked(0, async () => {
      const release = deploymentDirectory ? await loadMainnetBindingRelease(deploymentDirectory) : null;
      const manifest = command === 'mainnet-links'
        ? createMainnetClaimLinks(directory, root) : loadMainnetClaimLinks(directory, root);
      const fingerprint = mainnetCredentialFingerprint(manifest);
      const files = { privateManifest: resolve(directory, 'claim-links.private.json'),
        csv: resolve(directory, 'claim-links.private.csv') };
      if (command === 'mainnet-links') return { operation: command, chainId: 1, batchId: manifest.batchId,
        credentialCount: manifest.links.length, credentialSetSha256: fingerprint,
        status: 'local', contractAddress: null, verified: false, ...files };
      loadD1Credentials(root);
      const database = createD1MaintenanceRunner('ops');
      const verified = binding && rpc && release ? await bindMainnetCredentials(manifest, database, binding, release, rpc)
        : command === 'mainnet-provision' ? stageMainnetCredentials(manifest, database) : verifyMainnetCredentials(manifest, database);
      if (mainnetCredentialFingerprint(loadMainnetClaimLinks(directory, root)) !== fingerprint) {
        throw new Error('Private mainnet files changed during provisioning.');
      }
      return { operation: command, ...verified, ...files };
    });
  }
  const directory = resolve(root, values.directory || '.operations/dmx-sepolia-v3');
  privateDirectory(directory, root);
  return withMetadataLock(resolve(directory, 'claim-links.lock'), async () => {
    const manifest = command === 'links' ? createTarotClaimLinks(directory, values.contract || '', root) : loadTarotClaimLinks(directory, root);
    if (command !== 'links') {
      assertExistingTarotCredentialPin(manifest, root);
      loadD1Credentials(root);
      const database = createD1MaintenanceRunner('ops');
      assertTarotDeploymentActive(manifest, database);
      const rows = command === 'provision' ? provisionTarotCredentials(manifest, database, root) : readTarotCredentials(manifest, database);
      if (JSON.stringify(loadTarotClaimLinks(directory, root)) !== JSON.stringify(manifest)) {
        throw new Error('Private Sepolia credentials changed during verification.');
      }
      assertTarotDeploymentActive(manifest, database);
      recordVerifiedTarotCredentials(manifest, rows, root);
    }
    return { operation: command, chainId: manifest.chainId, contractAddress: manifest.contractAddress,
      credentialCount: manifest.links.length, privateManifest: resolve(directory, 'claim-links.private.json'), verified: command !== 'links' };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runTarotOperations(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), () => {
    console.error('Tarot operation failed. Check configuration, deployment scope, and the private manifest; no secrets were printed.');
    process.exitCode = 1;
  });
}
