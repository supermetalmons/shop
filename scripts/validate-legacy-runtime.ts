import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const excluded = new Set([
  'scripts/validate-browser-bundle.ts',
  'scripts/validate-legacy-runtime.ts',
  'scripts/ops/commerceIdentityManifest.ts',
  'scripts/shared/commerceIdentityCanonicalization.ts',
]);

const activePrefixes = [
  'cloud/workers/api/src/',
  'cloud/workers/frontend/',
  'scripts/',
  'shared/',
  'src/',
];

const activeFiles = new Set([
  'package.json',
  'wrangler.jsonc',
  'cloud/workers/api/wrangler.jsonc',
  'cloud/workers/api/worker-configuration.d.ts',
  'cloud/workers/frontend/worker-configuration.d.ts',
]);

const forbidden = [
  { label: 'legacy provider identifier', pattern: /\b(?:firebase|firestore)[A-Za-z0-9_:-]*/i },
  { label: 'legacy provider endpoint', pattern: /(?:firestore|identitytoolkit|securetoken)\.googleapis\.com/i },
  { label: 'legacy hosting domain', pattern: /[a-z0-9-]+\.(?:firebaseapp\.com|web\.app)/i },
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isActive(path: string): boolean {
  if (excluded.has(path) || path.endsWith('.md')) return false;
  if (activeFiles.has(path)) return true;
  if (!activePrefixes.some((prefix) => path.startsWith(prefix))) return false;
  return !path.includes('/test/') && !path.includes('/runtime-test/') && !path.includes('/migrations/');
}

const violations = trackedFiles().filter(isActive).flatMap((path) => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return forbidden.filter(({ pattern }) => pattern.test(text)).map(({ label }) => ({ label, path }));
});

if (violations.length) {
  violations.forEach(({ label, path }) => console.error(`[legacy-runtime] Found ${label} in ${path}`));
  process.exitCode = 1;
} else {
  console.log('[legacy-runtime] Active runtime and tooling contain no retired-provider integration.');
}
