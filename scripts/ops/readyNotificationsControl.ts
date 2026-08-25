import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
  type FirestoreRestDocument,
} from '../shared/firebaseCliFirestoreRest.ts';
import {
  importRemoteReadyNotificationsControl,
  readRemoteReadyNotificationsControl,
  setRemoteReadyNotificationsPaused,
  validateReadyNotificationCursorPath,
  type ReadyNotificationsControl,
} from '../shared/opsD1Maintenance.ts';

export type ReadyNotificationsControlArgs = {
  command: 'status' | 'pause' | 'resume' | 'import-firestore';
  write: boolean;
};

export type LegacyReadyNotificationsControl = {
  paused: boolean;
  cursorPath: string | null;
};

export type ReadyNotificationsControlDependencies = {
  importControl: (
    cursorPath: string | null,
    nowMs: number,
  ) => ReadyNotificationsControl;
  nowMs: () => number;
  readControl: () => ReadyNotificationsControl;
  readLegacyControl: () => Promise<LegacyReadyNotificationsControl>;
  setPaused: (
    paused: boolean,
    expectedRevision: number,
    nowMs: number,
  ) => ReadyNotificationsControl;
};

const projectId = 'mons-shop';
const legacyControlPath = 'workerControls/readyNotifications';

function usage(): string {
  return [
    'Inspect or change the ready-notification control in mons-shop-ops D1.',
    '',
    'Usage:',
    '  npm run ready-notifications-control -- status',
    '  npm run ready-notifications-control -- pause --write',
    '  npm run ready-notifications-control -- resume --write',
    '  npm run ready-notifications-control -- import-firestore --write',
    '',
    'Mutating commands require --write. The one-time import requires the legacy Firestore control to be paused.',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseReadyNotificationsControlArgs(
  argv: string[],
): ReadyNotificationsControlArgs {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const [command, ...options] = argv;
  if (
    command !== 'status' &&
    command !== 'pause' &&
    command !== 'resume' &&
    command !== 'import-firestore'
  ) {
    return fail(`Expected status, pause, resume, or import-firestore.\n\n${usage()}`);
  }
  if (options.some((option) => option !== '--write')) {
    return fail(`Unknown option.\n\n${usage()}`);
  }
  const writeCount = options.filter((option) => option === '--write').length;
  if (writeCount > 1) {
    return fail('--write may only be provided once.');
  }
  if (command === 'status' && writeCount !== 0) {
    return fail('status is read-only and does not accept --write.');
  }
  if (command !== 'status' && writeCount !== 1) {
    return fail(`${command} requires --write.`);
  }
  return { command, write: writeCount === 1 };
}

export function parseLegacyReadyNotificationsControl(
  document: FirestoreRestDocument | undefined,
): LegacyReadyNotificationsControl {
  if (!document || document.path !== legacyControlPath) {
    return fail('Legacy Firestore ready-notification control is missing.');
  }
  if (typeof document.data.paused !== 'boolean') {
    return fail('Legacy Firestore ready-notification paused state is invalid.');
  }
  const rawCursor = document.data.cursorPath;
  const cursorPath = rawCursor === undefined
    ? null
    : validateReadyNotificationCursorPath(rawCursor);
  return { paused: document.data.paused, cursorPath };
}

export async function readLegacyReadyNotificationsControl(): Promise<LegacyReadyNotificationsControl> {
  const client = createFirebaseCliFirestoreRestClient({ projectId });
  const raw = await client.request({
    url: client.documentUrl(legacyControlPath),
    allow404: true,
  });
  const document = raw ? decodeFirestoreRestDocument(raw) : undefined;
  return parseLegacyReadyNotificationsControl(document);
}

function defaultDependencies(): ReadyNotificationsControlDependencies {
  return {
    importControl: importRemoteReadyNotificationsControl,
    nowMs: Date.now,
    readControl: readRemoteReadyNotificationsControl,
    readLegacyControl: readLegacyReadyNotificationsControl,
    setPaused: setRemoteReadyNotificationsPaused,
  };
}

export function formatReadyNotificationsControl(
  control: ReadyNotificationsControl,
): string {
  return [
    `Ready notifications are ${control.paused ? 'paused' : 'active'}.`,
    `Cursor: ${control.cursorPath || 'none'}.`,
    `Revision: ${control.revision}.`,
    `Updated at: ${new Date(control.updatedAtMs).toISOString()}.`,
  ].join(' ');
}

export async function runReadyNotificationsControl(
  args: ReadyNotificationsControlArgs,
  dependencies = defaultDependencies(),
): Promise<ReadyNotificationsControl> {
  if (args.command === 'status') {
    return dependencies.readControl();
  }
  if (!args.write) {
    return fail(`${args.command} requires --write.`);
  }
  const nowMs = dependencies.nowMs();
  if (args.command === 'pause' || args.command === 'resume') {
    const current = dependencies.readControl();
    return dependencies.setPaused(
      args.command === 'pause',
      current.revision,
      nowMs,
    );
  }
  const legacy = await dependencies.readLegacyControl();
  if (!legacy.paused) {
    return fail('Legacy Firestore ready-notification control must be paused before import.');
  }
  return dependencies.importControl(legacy.cursorPath, nowMs);
}

async function main(): Promise<void> {
  const args = parseReadyNotificationsControlArgs(process.argv.slice(2));
  const control = await runReadyNotificationsControl(args);
  console.log(formatReadyNotificationsControl(control));
}

function isDirectRun(): boolean {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
