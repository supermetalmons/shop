import { spawnSync } from 'node:child_process';

const PROJECT_ID = 'mons-shop';
const DATABASE_ID = '(default)';
const SAFETY_CAP = 1000;
const BATCH_SIZE = 100;
const DOCUMENT_NAME_PATTERN = /^projects\/mons-shop\/databases\/\(default\)\/documents\/profiles\/[1-9A-HJ-NP-Za-km-z]{32,44}\/shipments\/[0-9a-f]{64}$/;

type Options = {
  projectId: string;
  execute: boolean;
  confirmProject?: string;
  expectedCount?: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { projectId: '', execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--execute') {
      options.execute = true;
      continue;
    }
    if (arg === '--project' || arg === '--confirm-project' || arg === '--expected-count') {
      if (!value || value.startsWith('--')) fail(`Missing value for ${arg}`);
      index += 1;
      if (arg === '--project') options.projectId = value;
      if (arg === '--confirm-project') options.confirmProject = value;
      if (arg === '--expected-count') {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 0 || count > SAFETY_CAP) fail('Invalid --expected-count');
        options.expectedCount = count;
      }
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (options.projectId !== PROJECT_ID) fail(`--project must be ${PROJECT_ID}`);
  if (process.env.FIRESTORE_EMULATOR_HOST) fail('Refusing to run while FIRESTORE_EMULATOR_HOST is set');
  if (options.execute && (
    options.confirmProject !== PROJECT_ID || options.expectedCount === undefined
  )) fail(`Execution requires --confirm-project ${PROJECT_ID} and --expected-count`);
  return options;
}

function accessToken(): string {
  const result = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || !result.stdout.trim()) fail('Unable to obtain a gcloud access token');
  return result.stdout.trim();
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`Firestore returned malformed JSON with status ${response.status}`);
  }
}

async function listProjectionDocuments(token: string): Promise<string[]> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents:runQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          select: { fields: [{ fieldPath: '__name__' }] },
          from: [{ collectionId: 'shipments', allDescendants: true }],
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          limit: SAFETY_CAP + 1,
        },
      }),
    },
  );
  const payload = await responseJson(response);
  if (!response.ok || !Array.isArray(payload)) fail(`Firestore query failed with status ${response.status}`);
  const names = payload.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const document = (entry as { document?: unknown }).document;
    if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
    const name = (document as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
  if (names.length > SAFETY_CAP) fail(`Projection count exceeded safety cap ${SAFETY_CAP}`);
  const unexpected = names.find((name) => !DOCUMENT_NAME_PATTERN.test(name));
  if (unexpected) fail(`Unexpected shipment path: ${unexpected}`);
  return names;
}

async function deleteBatch(token: string, names: string[]): Promise<void> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents:batchWrite`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: names.map((name) => ({ delete: name })) }),
    },
  );
  const payload = await responseJson(response);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(`Firestore batch delete failed with status ${response.status}`);
  }
  const statuses = (payload as { status?: unknown }).status;
  if (Array.isArray(statuses) && statuses.some((status) =>
    status && typeof status === 'object' && !Array.isArray(status) && Number((status as { code?: unknown }).code || 0) !== 0)) {
    fail('Firestore reported a partial batch delete failure');
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const token = accessToken();
  const names = await listProjectionDocuments(token);
  console.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', projectId: PROJECT_ID, documents: names.length }));
  if (!options.execute) {
    console.log(`No writes performed. Execute with --execute --confirm-project ${PROJECT_ID} --expected-count ${names.length}.`);
    return;
  }
  if (names.length !== options.expectedCount) fail(`Expected ${options.expectedCount} documents but found ${names.length}`);
  for (let index = 0; index < names.length; index += BATCH_SIZE) {
    await deleteBatch(token, names.slice(index, index + BATCH_SIZE));
  }
  const remaining = await listProjectionDocuments(token);
  if (remaining.length) fail(`Projection purge left ${remaining.length} documents`);
  console.log(JSON.stringify({ deleted: names.length, remaining: 0 }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
