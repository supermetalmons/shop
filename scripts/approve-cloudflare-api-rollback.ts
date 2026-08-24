import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approveCurrentApiRollback,
  cloudflareVersionIdPattern,
} from './finalize-cloudflare-release.js';

type CliOptions = {
  confirm: true;
  versionId: string;
};

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = 'cloud/release-manifest.json';

function usage(): string {
  return [
    'Approve the exact current production API and frontend pair as the recovery baseline.',
    '',
    'Usage:',
    '  npm run release:approve-api-rollback -- --version-id <uuid> --confirm',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseApproveApiRollbackArgs(argv: string[]): CliOptions {
  let confirm = false;
  let versionId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--confirm') {
      if (confirm) fail('--confirm may only be provided once.');
      confirm = true;
      continue;
    }
    if (option !== '--version-id') fail(`Unknown argument: ${option}\n\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('Missing value for --version-id.');
    if (versionId) fail('--version-id may only be provided once.');
    versionId = value;
    index += 1;
  }
  if (!versionId || !cloudflareVersionIdPattern.test(versionId)) {
    fail('--version-id must be an exact UUID.');
  }
  if (!confirm) fail('Refusing to approve an API rollback target without --confirm.');
  return { confirm: true, versionId: versionId.toLowerCase() };
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return String(result.stdout || '').trimEnd();
}

function manifestOnlyWorktreeEntries(): string[] {
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const entries = status ? status.split('\n') : [];
  if (entries.some((entry) => entry.slice(3) !== manifestPath)) {
    fail('Refusing to commit rollback approval while unrelated worktree changes exist.');
  }
  return entries;
}

function commitApprovedRollback(versionId: string): void {
  const entries = manifestOnlyWorktreeEntries();
  if (!entries.length) {
    console.log(`[release] API ${versionId} is already the clean approved rollback target.`);
    return;
  }
  const result = spawnSync('git', [
    'commit',
    '--only',
    '-m',
    `approve API rollback ${versionId}`,
    '--',
    manifestPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('Failed to commit the approved API rollback manifest.');
}

function main(): void {
  if (process.argv.slice(2).some((value) => value === '-h' || value === '--help')) {
    console.log(usage());
    return;
  }
  const options = parseApproveApiRollbackArgs(process.argv.slice(2));
  manifestOnlyWorktreeEntries();
  const manifest = approveCurrentApiRollback(options.versionId);
  commitApprovedRollback(options.versionId);
  console.log(`[release] Approved recovery API ${manifest.approvedRollback.apiVersionId}.`);
  console.log(`[release] Approved recovery frontend ${manifest.approvedRollback.frontendVersionId}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\n[release] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
