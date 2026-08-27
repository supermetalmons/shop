import { existsSync, readFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Provide at least one API bundle path.');

const forbidden = [
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'Stripe secret key', pattern: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { label: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
] as const;

const violations = paths.flatMap((path) => {
  if (!existsSync(path)) throw new Error(`API bundle is missing: ${path}`);
  const content = readFileSync(path, 'utf8');
  return forbidden
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => ({ label, path }));
});

if (violations.length) {
  violations.forEach(({ label, path }) => console.error(`[api-bundle] Found ${label} in ${path}`));
  process.exitCode = 1;
} else {
  console.log('[api-bundle] No embedded credentials found.');
}
