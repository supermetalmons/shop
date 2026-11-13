import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { createSolanaBuildWorkspace } from '../scripts/shared/solanaBuild.ts';

const MAINNET = '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU';
const DEFAULT = 'Hr39xMTdeQFPkLb9D6yYxxzTTkfW6QgVyyUETT7jyfZw';
const FRESH = PublicKey.default.toBase58();
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'solana-build-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name: string, content: string | Uint8Array) => {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write('Cargo.lock', 'version = 3\n');
  write('Cargo.toml', '[workspace]\nmembers=["programs/box_minter"]\n');
  write('Anchor.toml', `[programs.devnet]\nbox_minter = "${DEFAULT}"\n\n[programs.mainnet]\nbox_minter = "${MAINNET}"\n`);
  write('programs/box_minter/Cargo.toml', '[package]\nname="box_minter"\n');
  write('programs/box_minter/src/lib.rs', `#[cfg(feature = "mainnet-program-id")]\ndeclare_id!("${MAINNET}");\n` +
    `#[cfg(all(\n not(feature = "mainnet-program-id")\n))]\ndeclare_id!("${DEFAULT}");\n`);
  write('target/deploy/box_minter.so', 'stale ELF');
  write('programs/box_minter/target/stale', 'stale nested target');
  return { directory, write };
}

function writeElf(directory: string, bytes = ELF) {
  mkdirSync(path.join(directory, 'target/deploy'), { recursive: true });
  writeFileSync(path.join(directory, 'target/deploy/box_minter.so'), bytes);
}

test('fresh identity preparation changes only the selected default in an isolated source snapshot', t => {
  const source = fixture(t);
  const original = readFileSync(path.join(source.directory, 'programs/box_minter/src/lib.rs'), 'utf8');
  const anchor = readFileSync(path.join(source.directory, 'Anchor.toml'), 'utf8');
  const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory, freshIdentity: { programId: FRESH, cluster: 'mainnet-beta' } });
  try {
    assert.notEqual(workspace.directory, source.directory);
    assert.equal(readFileSync(path.join(workspace.directory, 'programs/box_minter/src/lib.rs'), 'utf8'), original.replace(DEFAULT, FRESH));
    assert.equal(readFileSync(path.join(workspace.directory, 'Anchor.toml'), 'utf8'), anchor.replace(MAINNET, FRESH));
    assert.equal(readFileSync(path.join(source.directory, 'programs/box_minter/src/lib.rs'), 'utf8'), original);
    assert.equal(readFileSync(path.join(source.directory, 'Anchor.toml'), 'utf8'), anchor);
    assert.equal(existsSync(path.join(workspace.directory, 'target')), false);
    assert.equal(existsSync(path.join(workspace.directory, 'programs/box_minter/target')), false);
  } finally { workspace.cleanup(); }
  assert.equal(existsSync(workspace.directory), false);
  workspace.cleanup();
});

test('locked builds test and return the identical frozen ELF with the requested feature', async t => {
  const source = fixture(t);
  const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory, buildFeature: 'mainnet-program-id',
    env: { CARGO_TARGET_DIR: '/must-not-use', NO_DNA: '0' } });
  let testedPath = '';
  const commands: string[] = [];
  const run: Parameters<typeof workspace.build>[0] = async (command, args, options) => {
    commands.push(`${command} ${args.join(' ')}`);
    assert.equal(options.cwd, workspace.directory);
    assert.equal(options.env.CARGO_TARGET_DIR, path.join(workspace.directory, 'target'));
    assert.equal(options.env.NO_DNA, '1');
    assert.ok(args.includes('--locked'));
    if (command === 'anchor') {
      assert.ok(args.includes('no-idl,no-log-ix-name,mainnet-program-id'));
      writeElf(options.cwd);
    } else if (args.includes('split_payments_sbf')) {
      assert.ok(args.includes('sbf-tests,mainnet-program-id'));
      testedPath = options.env.BOX_MINTER_SBF_PATH!;
      assert.deepEqual(readFileSync(testedPath), ELF);
      assert.equal(statSync(testedPath).mode & 0o777, 0o400);
      writeElf(options.cwd, Buffer.concat([ELF, Buffer.from('later build output')]));
    }
  };
  try {
    await workspace.testHost(run);
    const artifact = await workspace.build(run);
    assert.equal(commands.length, 3);
    assert.equal(artifact.path, testedPath);
    assert.equal(artifact.bytes, ELF.length);
    assert.equal(artifact.sha256, createHash('sha256').update(ELF).digest('hex'));
    artifact.verify();
    assert.equal(readFileSync(path.join(source.directory, 'Cargo.lock'), 'utf8'), 'version = 3\n');
    assert.equal(readFileSync(path.join(source.directory, 'target/deploy/box_minter.so'), 'utf8'), 'stale ELF');
    await assert.rejects(workspace.build(run), /only produce one/);
  } finally { workspace.cleanup(); }
  assert.equal(existsSync(testedPath), false);
});

test('builds reject a changed pinned lockfile and never reach exact-ELF tests', async t => {
  const source = fixture(t);
  const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory });
  let commands = 0;
  try {
    await assert.rejects(workspace.build(async (_command, _args, options) => {
      commands += 1;
      writeFileSync(path.join(options.cwd, 'Cargo.lock'), 'regenerated lockfile');
      writeElf(options.cwd);
    }), /build input changed: Cargo.lock/);
    assert.equal(commands, 1);
    assert.equal(readFileSync(path.join(source.directory, 'Cargo.lock'), 'utf8'), 'version = 3\n');
  } finally { workspace.cleanup(); }
  assert.equal(existsSync(workspace.directory), false);
});

test('exact-ELF tampering and invalid build outputs fail before an artifact is returned', async t => {
  for (const invalidOutput of [true, false]) {
    const source = fixture(t);
    const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory });
    try {
      await assert.rejects(workspace.build(async (command, _args, options) => {
        if (command === 'anchor') writeElf(options.cwd, invalidOutput ? Buffer.from('not ELF') : ELF);
        else {
          const target = options.env.BOX_MINTER_SBF_PATH!;
          chmodSync(target, 0o600);
          writeFileSync(target, Buffer.concat([ELF, Buffer.from('tampered')]));
        }
      }), invalidOutput ? /did not produce an ELF/ : /binary changed/);
    } finally { workspace.cleanup(); }
    assert.equal(existsSync(workspace.directory), false);
  }
});

test('cancelled build commands can clean up without changing checkout sources or stale artifacts', async t => {
  const source = fixture(t);
  const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory });
  const cancelled = new Error('cancelled');
  try {
    await assert.rejects(workspace.build(async (_command, _args, options) => {
      writeElf(options.cwd);
      throw cancelled;
    }), error => error === cancelled);
  } finally { workspace.cleanup(); }
  assert.equal(existsSync(workspace.directory), false);
  assert.equal(readFileSync(path.join(source.directory, 'target/deploy/box_minter.so'), 'utf8'), 'stale ELF');
});

test('missing lockfile, symlink inputs and ambiguous fresh declarations fail before command execution', t => {
  const source = fixture(t);
  rmSync(path.join(source.directory, 'Cargo.lock'));
  assert.throws(() => createSolanaBuildWorkspace({ onchainDirectory: source.directory }), /Cargo.lock/);
  source.write('Cargo.lock', 'version = 3\n');
  symlinkSync(path.join(source.directory, 'Cargo.lock'), path.join(source.directory, 'programs/link'));
  assert.throws(() => createSolanaBuildWorkspace({ onchainDirectory: source.directory }), /regular file or directory/);
  rmSync(path.join(source.directory, 'programs/link'));
  source.write('programs/box_minter/src/lib.rs', `declare_id!("${DEFAULT}");\ndeclare_id!("${MAINNET}");`);
  assert.throws(() => createSolanaBuildWorkspace({ onchainDirectory: source.directory,
    freshIdentity: { programId: FRESH, cluster: 'devnet' } }), /exactly one default/);
});

test('explicit skipped integration tests still freeze and verify the ELF', async t => {
  const source = fixture(t);
  const workspace = createSolanaBuildWorkspace({ onchainDirectory: source.directory });
  let commands = 0;
  try {
    const artifact = await workspace.build(async (command, _args, options) => {
      commands += 1;
      assert.equal(command, 'anchor');
      writeElf(options.cwd);
    }, { test: false });
    assert.equal(commands, 1);
    artifact.verify();
    chmodSync(artifact.path, 0o600);
    assert.throws(() => artifact.verify(), /binary changed/);
  } finally { workspace.cleanup(); }
});
