import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeOperationsDirectory } from '../shared/localArtifacts.ts';

const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const privateRoot = join(repository, '.operations');

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export function privateHatchPath(input: string): string {
  const requested = resolve(input);
  const rejected = () => new Error('Hatch evidence must be inside the ignored .operations directory or a private directory outside Git. Copy the original bundle and journal there to resume.');
  let ancestor = requested;
  let stat = lstatSync(ancestor, { throwIfNoEntry: false });
  while (!stat) {
    ancestor = dirname(ancestor);
    stat = lstatSync(ancestor, { throwIfNoEntry: false });
  }
  if (stat.isSymbolicLink()) throw rejected();
  const existing = realpathSync(ancestor);
  const physical = resolve(existing, relative(ancestor, requested));
  const containing = stat.isDirectory() ? existing : dirname(existing);
  const local = inside(repository, requested) || inside(repository, physical);
  if (local && (!inside(privateRoot, requested) || requested === privateRoot || physical !== requested)) throw rejected();

  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = (args: string[]) => spawnSync('git', ['-C', containing, ...args], { encoding: 'utf8', env });
  const root = git(['rev-parse', '--show-toplevel']);
  if (root.status === 0) {
    if (!local || realpathSync(root.stdout.trim()) !== repository ||
      git(['check-ignore', '--quiet', '--', physical]).status !== 0) throw rejected();
    const tracked = git(['ls-files', '--', physical]);
    if (tracked.status !== 0 || tracked.stdout.length) throw rejected();
  } else if (root.status !== 128 || !root.stderr.includes('not a git repository')) {
    throw rejected();
  }
  if (local) {
    initializeOperationsDirectory(repository);
  } else {
    let parent = containing;
    while (parent !== dirname(parent) && (statSync(parent).mode & 0o077) !== 0) parent = dirname(parent);
    if ((statSync(parent).mode & 0o077) !== 0) throw rejected();
  }
  return requested;
}
