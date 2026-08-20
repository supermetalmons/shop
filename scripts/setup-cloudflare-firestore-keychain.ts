import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  deleteCloudflareFirestoreKeychainCredential,
  firestoreReaderServiceAccountEmail,
  firestoreWriterServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
  writeCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.ts';

const projectId = 'mons-shop';
const expectedRoles = new Map([
  [firestoreReaderServiceAccountEmail, 'roles/datastore.viewer'],
  [firestoreWriterServiceAccountEmail, 'roles/datastore.user'],
]);

type Credential = {
  client_email: string;
  private_key: string;
  private_key_id: string;
  project_id: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function runGcloud(args: string[]): string {
  try {
    return execFileSync('gcloud', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fail('Google Cloud credential setup failed. Reauthenticate gcloud and retry.');
  }
}

function parseCredential(value: string, expectedEmail: string): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return fail(`Stored credential is invalid for ${expectedEmail}.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`Stored credential is invalid for ${expectedEmail}.`);
  }
  const record = parsed as Record<string, unknown>;
  const credential: Credential = {
    client_email: typeof record.client_email === 'string' ? record.client_email : '',
    private_key: typeof record.private_key === 'string' ? record.private_key : '',
    private_key_id: typeof record.private_key_id === 'string' ? record.private_key_id : '',
    project_id: typeof record.project_id === 'string' ? record.project_id : '',
  };
  if (
    credential.project_id !== projectId ||
    credential.client_email !== expectedEmail ||
    !/^[0-9a-f]{40}$/i.test(credential.private_key_id) ||
    !credential.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !credential.private_key.trimEnd().endsWith('-----END PRIVATE KEY-----')
  ) {
    return fail(`Stored credential is invalid for ${expectedEmail}.`);
  }
  return credential;
}

function compactCredential(value: string, expectedEmail: string): { credential: Credential; json: string } {
  const credential = parseCredential(value, expectedEmail);
  return { credential, json: JSON.stringify(JSON.parse(value)) };
}

function serviceAccountKeyIds(email: string): Set<string> {
  const output = runGcloud([
    'iam', 'service-accounts', 'keys', 'list',
    '--iam-account', email,
    '--project', projectId,
    '--managed-by', 'user',
    '--format', 'value(name)',
  ]);
  return new Set(output.split(/\r?\n/).filter(Boolean).map((name) => basename(name)));
}

function assertProjectAccess(): void {
  if (runGcloud(['projects', 'describe', projectId, '--format', 'value(projectId)']) !== projectId) {
    fail(`The active gcloud account cannot access ${projectId}.`);
  }
  const policy = JSON.parse(runGcloud(['projects', 'get-iam-policy', projectId, '--format', 'json'])) as {
    bindings?: Array<{ members?: string[]; role?: string }>;
  };
  for (const [email, role] of expectedRoles) {
    const described = runGcloud([
      'iam', 'service-accounts', 'describe', email,
      '--project', projectId,
      '--format', 'value(email)',
    ]);
    if (described !== email) fail(`Missing service account ${email}.`);
    const member = `serviceAccount:${email}`;
    if (!policy.bindings?.some((binding) => binding.role === role && binding.members?.includes(member))) {
      fail(`${email} is missing ${role}.`);
    }
  }
}

function readValidKeychainCredential(email: string): { credential: Credential; json: string } | null {
  try {
    const stored = compactCredential(readCloudflareFirestoreKeychainCredential(email), email);
    return serviceAccountKeyIds(email).has(stored.credential.private_key_id) ? stored : null;
  } catch {
    return null;
  }
}

function createCredential(email: string, directory: string): { credential: Credential; json: string } {
  const path = join(directory, email.startsWith('mons-shop-cloudflare-reader@') ? 'reader.json' : 'writer.json');
  runGcloud([
    'iam', 'service-accounts', 'keys', 'create', path,
    '--iam-account', email,
    '--project', projectId,
    '--key-file-type', 'json',
  ]);
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o077) !== 0) fail(`Credential permissions are unsafe for ${email}.`);
  const created = compactCredential(readFileSync(path, 'utf8'), email);
  if (!serviceAccountKeyIds(email).has(created.credential.private_key_id)) {
    fail(`Created key was not visible for ${email}.`);
  }
  return created;
}

function deleteIamKey(email: string, keyId: string): void {
  runGcloud([
    'iam', 'service-accounts', 'keys', 'delete', keyId,
    '--iam-account', email,
    '--project', projectId,
    '--quiet',
  ]);
}

function removeTemporaryDirectory(directory: string): void {
  const resolved = resolve(directory);
  const temporaryRoot = resolve(tmpdir());
  if (dirname(resolved) !== temporaryRoot || !basename(resolved).startsWith('mons-shop-firestore-keychain-')) {
    fail('Refusing to remove an unexpected temporary credential directory.');
  }
  rmSync(resolved, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') fail('Keychain setup requires macOS.');
  assertProjectAccess();
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-firestore-keychain-'));
  chmodSync(directory, 0o700);
  const created: Array<{ email: string; keyId: string }> = [];
  const updatedKeychainAccounts: string[] = [];
  try {
    for (const email of [firestoreReaderServiceAccountEmail, firestoreWriterServiceAccountEmail]) {
      const existing = readValidKeychainCredential(email);
      if (existing) continue;
      if (serviceAccountKeyIds(email).size >= 9) fail(`${email} has no safe key-creation capacity.`);
      const generated = createCredential(email, directory);
      created.push({ email, keyId: generated.credential.private_key_id });
      writeCloudflareFirestoreKeychainCredential(email, generated.json);
      updatedKeychainAccounts.push(email);
      const verified = readValidKeychainCredential(email);
      if (!verified || verified.credential.private_key_id !== generated.credential.private_key_id) {
        fail(`Keychain verification failed for ${email}.`);
      }
    }
    console.log('[keychain] Cloudflare Firestore reader and writer credentials are ready.');
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const email of updatedKeychainAccounts.reverse()) {
      try {
        deleteCloudflareFirestoreKeychainCredential(email);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const entry of created.reverse()) {
      try {
        deleteIamKey(entry.email, entry.keyId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Credential setup and rollback both failed.');
    throw error;
  } finally {
    removeTemporaryDirectory(directory);
  }
}

main().catch((error) => {
  console.error(`[keychain] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
