import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export async function withValidationWorkspace(root, kind, action) {
  root = resolve(root);
  if (!['ethereum', 'sbf'].includes(kind)) throw new Error(`Unknown validation workspace: ${kind}`);
  const directory = mkdtempSync(join(tmpdir(), `mons-${kind}-validation-`));
  try {
    const scopes = kind === 'ethereum'
      ? ['package.json', 'onchain/ethereum', 'shared', 'src/ethereum/discounts']
      : ['onchain/Anchor.toml', 'onchain/Cargo.toml', 'onchain/Cargo.lock', 'onchain/programs'];
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes],
      { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of new Set(files)) {
      const source = join(root, name);
      if (!existsSync(source)) continue;
      if (!statSync(source).isFile()) throw new Error(`Validation source is not a file: ${name}`);
      const target = join(directory, name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    if (kind === 'ethereum') {
      for (const name of ['node_modules', 'onchain/ethereum/node_modules']) {
        const source = join(root, name);
        if (!existsSync(source) || !statSync(source).isDirectory()) {
          throw new Error(`Validation dependencies are missing: ${source}. Install the pinned dependencies first.`);
        }
        symlinkSync(source, join(directory, name), 'dir');
      }
      const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
      symlinkSync(gitDirectory, join(directory, '.git'), 'dir');
    }
    return await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
