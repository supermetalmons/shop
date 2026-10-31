import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runAllChecks, runEthereumChecks, runEthereumForkChecks, runSbfChecks, runValidationCommand } from '../scripts/check-all.mjs';
import { withValidationWorkspace } from '../scripts/shared/validationWorkspace.mjs';

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mons-validation-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, value: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), value);
  };
  write('.gitignore', 'node_modules/\n.cache/\n');
  write('package.json', '{"private":true}');
  write('onchain/Cargo.lock', 'pinned Rust dependencies');
  write('onchain/Cargo.toml', '[workspace]\n');
  write('onchain/Anchor.toml', '[programs.localnet]\n');
  write('onchain/programs/box_minter/src/lib.rs', 'original Rust source');
  write('onchain/ethereum/package.json', '{"private":true}');
  write('onchain/ethereum/fixtures/eip712.json', '{"version":1}');
  write('onchain/ethereum/src/NFT111K.sol', 'original Solidity source');
  write('shared/removed.ts', 'removed after staging');
  write('tests/ethereum/local.test.ts', 'nested test');
  write('tests/ethereumRoot.test.ts', 'root test');
  for (const name of ['node_modules', 'onchain/ethereum/node_modules']) mkdirSync(join(root, name), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  write('onchain/ethereum/src/NFT111K.sol', 'current unstaged Solidity source');
  write('shared/new.ts', 'current untracked source');
  rmSync(join(root, 'shared/removed.ts'));
  return { root, write };
}

test('validation copies current source and removes temporary changes after failure', async t => {
  const { root } = project(t);
  let workspace = '';
  await assert.rejects(withValidationWorkspace(root, 'ethereum', async directory => {
    workspace = directory;
    assert.equal(readFileSync(join(directory, 'onchain/ethereum/src/NFT111K.sol'), 'utf8'), 'current unstaged Solidity source');
    assert.equal(readFileSync(join(directory, 'shared/new.ts'), 'utf8'), 'current untracked source');
    assert.equal(existsSync(join(directory, 'shared/removed.ts')), false);
    writeFileSync(join(directory, 'onchain/ethereum/fixtures/eip712.json'), 'temporary generated fixture');
    throw new Error('test failure');
  }), /test failure/);
  assert.equal(existsSync(workspace), false);
  assert.equal(readFileSync(join(root, 'onchain/ethereum/fixtures/eip712.json'), 'utf8'), '{"version":1}');
});

test('Ethereum validation rejects changed generated fixtures without altering the source fixture', async t => {
  const { root } = project(t);
  let workspace = '';
  await assert.rejects(runEthereumChecks(root, (_command, _args, options) => {
    workspace = options.cwd;
    writeFileSync(join(options.cwd, 'fixtures/eip712.json'), '{"version":2}');
  }), /fixtures differ from the source fixture/);
  assert.equal(existsSync(workspace), false);
  assert.equal(readFileSync(join(root, 'onchain/ethereum/fixtures/eip712.json'), 'utf8'), '{"version":1}');
});

test('SBF build and test share an isolated artifact while preserving the source lockfile', async t => {
  const { root } = project(t);
  let workspace = '';
  await runSbfChecks(root, (command, args, options) => {
    assert.ok(args.includes('--locked'));
    assert.equal(options.env.CARGO_TARGET_DIR, join(options.cwd, 'target'));
    if (command === 'anchor') {
      workspace = options.cwd;
      assert.equal(options.env.NO_DNA, '1');
      assert.ok(args.includes('no-idl,no-log-ix-name,mainnet-program-id'));
      mkdirSync(join(workspace, 'target/deploy'), { recursive: true });
      writeFileSync(join(workspace, 'target/deploy/box_minter.so'), 'built artifact');
      writeFileSync(join(workspace, 'Cargo.lock'), 'temporary toolchain rewrite');
    } else {
      assert.equal(command, 'cargo');
      assert.equal(options.cwd, workspace);
      assert.ok(args.includes('sbf-tests,mainnet-program-id'));
      assert.equal(readFileSync(options.env.BOX_MINTER_SBF_PATH, 'utf8'), 'built artifact');
    }
  });
  assert.equal(existsSync(workspace), false);
  assert.equal(readFileSync(join(root, 'onchain/Cargo.lock'), 'utf8'), 'pinned Rust dependencies');
});

test('full validation includes extended and native suites without repeating root Ethereum tests or public forks', async t => {
  const { root } = project(t);
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  await runAllChecks(root, (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); });
  assert.deepEqual(calls.map(call => call.args[0] === 'run' ? call.args[1] : call.command === process.execPath
    ? call.args.filter(value => value.endsWith('.test.ts')) : call.command), [
    'check', 'check', ['tests/ethereum/local.test.ts'], 'test:invariants:extended', 'test:ethereum:e2e',
    'anchor', 'cargo', 'test:mi-note-videos',
  ]);
  assert.equal(calls[0].cwd, root);
  assert.notEqual(calls[1].cwd, join(root, 'onchain/ethereum'));
  assert.equal(calls.some(call => call.args.includes('--fork-url')), false);
});

test('full validation stops on a failed routine gate instead of skipping it', async t => {
  const { root } = project(t);
  let calls = 0;
  await assert.rejects(runAllChecks(root, () => {
    calls += 1;
    throw new Error('routine gate failed');
  }), /routine gate failed/);
  assert.equal(calls, 1);
});

test('missing dependencies, missing executables and unconfigured forks fail visibly', async t => {
  const { root } = project(t);
  rmSync(join(root, 'onchain/ethereum/node_modules'), { recursive: true });
  await assert.rejects(withValidationWorkspace(root, 'ethereum', () => assert.fail('must not run')), /dependencies are missing/);
  assert.throws(() => runValidationCommand(join(root, 'missing-tool'), [], { cwd: root, label: 'Required tool' }), /Required tool.*ENOENT/);
  await assert.rejects(runEthereumForkChecks(root, () => assert.fail('must not run'), ''), /ETHEREUM_RPC_URL is required/);
});
