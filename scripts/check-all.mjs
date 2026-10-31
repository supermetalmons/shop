import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { withValidationWorkspace } from './shared/validationWorkspace.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function runValidationCommand(command, args, options) {
  console.log(`\n${options.label}`);
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit' });
  if (result.error) throw new Error(`${options.label}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${options.label} failed (${result.signal ?? `exit ${result.status}`}).`);
}

export async function runEthereumChecks(root = projectRoot, run = runValidationCommand) {
  await withValidationWorkspace(root, 'ethereum', async directory => {
    const cwd = join(directory, 'onchain/ethereum');
    await run(npm, ['run', 'check'], { cwd, label: 'Solidity, gas snapshots, fixtures, ABI and contract tooling' });
    const fixture = 'onchain/ethereum/fixtures/eip712.json';
    if (!isDeepStrictEqual(JSON.parse(readFileSync(join(root, fixture), 'utf8')),
      JSON.parse(readFileSync(join(directory, fixture), 'utf8')))) {
      throw new Error('Generated Ethereum authorization fixtures differ from the source fixture. Regenerate them intentionally.');
    }
  });
}

export async function runSbfChecks(root = projectRoot, run = runValidationCommand) {
  await withValidationWorkspace(root, 'sbf', async directory => {
    const cwd = join(directory, 'onchain');
    const env = { ...process.env, NO_DNA: '1', CARGO_TARGET_DIR: join(cwd, 'target') };
    await run('anchor', ['build', '--no-idl', '--arch', 'sbf', '--', '--features',
      'no-idl,no-log-ix-name,mainnet-program-id', '--', '--locked'], { cwd, env, label: 'Build locked Solana SBF program' });
    await run('cargo', ['test', '--locked', '--features', 'sbf-tests,mainnet-program-id', '--test', 'split_payments_sbf'],
      { cwd, env: { ...env, BOX_MINTER_SBF_PATH: join(cwd, 'target/deploy/box_minter.so') }, label: 'Solana SBF integration tests' });
  });
}

export async function runAllChecks(root = projectRoot, run = runValidationCommand) {
  await run(npm, ['run', 'check'], { cwd: root, label: 'Routine repository checks' });
  await runEthereumChecks(root, run);
  const ethereumTests = readdirSync(join(root, 'tests/ethereum')).filter(name => name.endsWith('.test.ts')).sort();
  if (!ethereumTests.length) throw new Error('No nested Ethereum integration tests were found.');
  await run(process.execPath, ['--import', 'tsx', '--test', ...ethereumTests.map(name => `tests/ethereum/${name}`)],
    { cwd: root, label: 'Ethereum integration tests' });
  await withValidationWorkspace(root, 'ethereum', directory => run(npm, ['run', 'test:invariants:extended'],
    { cwd: join(directory, 'onchain/ethereum'), label: 'Extended Ethereum invariant campaign' }));
  await run(npm, ['run', 'test:ethereum:e2e'], { cwd: root, label: 'Local Ethereum lifecycle and reveal E2E' });
  await runSbfChecks(root, run);
  await run(npm, ['run', 'test:mi-note-videos'], { cwd: root, label: 'Pinned native renderer tests' });
}

export async function runEthereumForkChecks(root = projectRoot, run = runValidationCommand, rpcUrl = process.env.ETHEREUM_RPC_URL) {
  if (!rpcUrl?.trim()) throw new Error('ETHEREUM_RPC_URL is required for the optional Seaport fork tests.');
  await withValidationWorkspace(root, 'ethereum', directory => run('forge', ['test', '--offline',
    '--match-contract', '^NFT111KSeaportForkTest$', '--fork-url', rpcUrl, '--gas-snapshot-emit=false'],
  { cwd: join(directory, 'onchain/ethereum'), label: 'Optional Seaport public-RPC fork tests' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? 'all';
    if (process.argv.length > 3 || !['all', 'ethereum', 'sbf', 'fork'].includes(mode)) {
      throw new Error('Usage: node scripts/check-all.mjs [all|ethereum|sbf|fork]');
    }
    if (mode === 'ethereum') await runEthereumChecks();
    else if (mode === 'sbf') await runSbfChecks();
    else if (mode === 'fork') await runEthereumForkChecks();
    else await runAllChecks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
