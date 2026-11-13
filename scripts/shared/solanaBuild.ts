import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';

type BuildCommand = (command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}) => void | Promise<void>;

type BuildOptions = {
  onchainDirectory: string;
  buildFeature?: string;
  freshIdentity?: { programId: string; cluster: 'devnet' | 'mainnet-beta' | 'testnet' };
  env?: NodeJS.ProcessEnv;
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function prepareFreshIdentity(directory: string, identity: NonNullable<BuildOptions['freshIdentity']>): void {
  const programId = new PublicKey(identity.programId).toBase58();
  const sourcePath = path.join(directory, 'programs/box_minter/src/lib.rs');
  const source = readFileSync(sourcePath, 'utf8');
  const declarations = [...source.matchAll(/(?:#\[cfg\(([\s\S]*?)\)\]\s*)?declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/g)];
  const defaults = declarations.filter((match) => {
    if (!match[1]) return true;
    const conditions = match[1].replace(/not\s*\(\s*feature\s*=\s*"[^"]+"\s*\)/g, '').replace(/[\s,()]/g, '');
    return conditions === 'all' || conditions === '';
  });
  if (defaults.length !== 1) throw new Error('Fresh Solana build requires exactly one default program declaration.');
  const declaration = defaults[0];
  const updated = declaration[0].replace(`declare_id!("${declaration[2]}")`, `declare_id!("${programId}")`);
  writeFileSync(sourcePath, source.slice(0, declaration.index) + updated + source.slice(declaration.index + declaration[0].length));

  const anchorPath = path.join(directory, 'Anchor.toml');
  const anchor = readFileSync(anchorPath, 'utf8');
  const sectionName = identity.cluster === 'mainnet-beta' ? 'mainnet' : identity.cluster;
  const section = new RegExp(`(\\[programs\\.${sectionName}\\]\\s*\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = anchor.match(section);
  const program = /box_minter\s*=\s*"[1-9A-HJ-NP-Za-km-z]{32,44}"/;
  if (!match || !program.test(match[2])) throw new Error(`Missing box_minter in [programs.${sectionName}] for the isolated build.`);
  writeFileSync(anchorPath, anchor.replace(section, () => `${match[1]}${match[2].replace(program, `box_minter = "${programId}"`)}`));
}

export function createSolanaBuildWorkspace(options: BuildOptions) {
  if (options.freshIdentity && options.buildFeature) throw new Error('Choose a fresh identity or an existing program build feature.');
  if (options.buildFeature && !/^[a-z0-9-]+$/.test(options.buildFeature)) throw new Error('Invalid Solana program build feature.');
  const directory = mkdtempSync(path.join(tmpdir(), 'mons-solana-build-'));
  const sources: string[] = [];
  let cleaned = false;
  let buildStarted = false;
  const cleanup = () => {
    if (cleaned) return;
    rmSync(directory, { recursive: true, force: true });
    cleaned = true;
  };
  const copy = (relative: string) => {
    const source = path.join(options.onchainDirectory, relative);
    const target = path.join(directory, relative);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source).sort()) {
        if (entry === 'target' || entry === '.git') continue;
        copy(path.join(relative, entry));
      }
    } else if (stat.isFile()) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      sources.push(relative);
    } else throw new Error(`Solana build source must be a regular file or directory: ${relative}`);
  };
  let sourceHashes: Map<string, string>;
  try {
    for (const source of ['Anchor.toml', 'Cargo.toml', 'Cargo.lock', 'programs']) copy(source);
    if (options.freshIdentity) prepareFreshIdentity(directory, options.freshIdentity);
    sourceHashes = new Map(sources.map(name => [name, digest(readFileSync(path.join(directory, name)))]));
  } catch (error) {
    cleanup();
    throw error;
  }
  const verifySources = () => {
    if (cleaned) throw new Error('Solana build workspace has already been cleaned up.');
    for (const [name, hash] of sourceHashes) {
      if (digest(readFileSync(path.join(directory, name))) !== hash) throw new Error(`Solana build input changed: ${name}`);
    }
  };
  const env = { ...process.env, ...options.env, NO_DNA: '1', CARGO_TARGET_DIR: path.join(directory, 'target') };
  const command = async (run: BuildCommand, executable: string, args: string[], label: string, extraEnv: NodeJS.ProcessEnv = {}) => {
    verifySources();
    await run(executable, args, { cwd: directory, env: { ...env, ...extraEnv }, label });
    verifySources();
  };
  const buildFeature = options.buildFeature ? [options.buildFeature] : [];
  return {
    directory,
    env,
    cleanup,
    testHost: (run: BuildCommand) => command(run, 'cargo', ['test', '--lib', '--locked'], 'Locked Solana host tests'),
    build: async (run: BuildCommand, { test = true }: { test?: boolean } = {}) => {
      if (buildStarted) throw new Error('Solana build workspace can only produce one frozen artifact.');
      buildStarted = true;
      await command(run, 'anchor', ['build', '--no-idl', '--arch', 'sbf', '--', '--features',
        ['no-idl', 'no-log-ix-name', ...buildFeature].join(','), '--', '--locked'], 'Build locked Solana SBF program');
      const built = path.join(directory, 'target/deploy/box_minter.so');
      if (!lstatSync(built).isFile()) throw new Error('Solana build did not produce a regular program binary.');
      if (!readFileSync(built).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        throw new Error('Solana build did not produce an ELF program binary.');
      }
      const artifactDirectory = path.join(directory, 'verified');
      mkdirSync(artifactDirectory);
      const artifactPath = path.join(artifactDirectory, 'box_minter.so');
      copyFileSync(built, artifactPath, constants.COPYFILE_EXCL);
      chmodSync(artifactPath, 0o400);
      const bytes = readFileSync(artifactPath);
      const sha256 = digest(bytes);
      const verify = () => {
        if (cleaned) throw new Error('Solana build workspace has already been cleaned up.');
        const stat = lstatSync(artifactPath);
        if (!stat.isFile() || (stat.mode & 0o222) !== 0 || stat.size !== bytes.length || digest(readFileSync(artifactPath)) !== sha256) {
          throw new Error('Frozen Solana program binary changed after the build.');
        }
      };
      if (test) {
        await command(run, 'cargo', ['test', '--locked', '--features', ['sbf-tests', ...buildFeature].join(','),
          '--test', 'split_payments_sbf'], 'Solana exact-ELF integration tests', { BOX_MINTER_SBF_PATH: artifactPath });
      }
      verify();
      return { path: artifactPath, bytes: bytes.length, sha256, verify };
    },
  };
}
