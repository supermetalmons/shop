import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readRemoteReadyNotificationsControl,
  setRemoteReadyNotificationsPaused,
  type ReadyNotificationsControl,
} from '../shared/opsD1Maintenance.ts';

export type ReadyNotificationsControlArgs = {
  command: 'status' | 'pause' | 'resume';
  write: boolean;
};

export type ReadyNotificationsControlDependencies = {
  nowMs: () => number;
  readControl: () => ReadyNotificationsControl;
  setPaused: (
    paused: boolean,
    expectedRevision: number,
    nowMs: number,
  ) => ReadyNotificationsControl;
};

function usage(): string {
  return [
    'Inspect or change the ready-notification control in mons-shop-ops D1.',
    '',
    'Usage:',
    '  npm run ready-notifications-control -- status',
    '  npm run ready-notifications-control -- pause --write',
    '  npm run ready-notifications-control -- resume --write',
    '',
    'Mutating commands require --write.',
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
    command !== 'resume'
  ) {
    return fail(`Expected status, pause, or resume.\n\n${usage()}`);
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

function defaultDependencies(): ReadyNotificationsControlDependencies {
  return {
    nowMs: Date.now,
    readControl: readRemoteReadyNotificationsControl,
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
  const current = dependencies.readControl();
  return dependencies.setPaused(
    args.command === 'pause',
    current.revision,
    nowMs,
  );
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
