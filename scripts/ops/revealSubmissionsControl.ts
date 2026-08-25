import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  queryRemoteOpsD1,
  type OpsD1Row,
} from '../shared/opsD1Maintenance.ts';

export type RevealSubmissionsControlArgs = {
  command: 'status' | 'pause' | 'resume';
  write: boolean;
};

export type RevealSubmissionsControl = {
  paused: boolean;
  source: 'd1';
  revision: number;
  updatedAtMs: number;
  cutoverAtMs: number;
};

export type RevealSubmissionsControlDependencies = {
  nowMs: () => number;
  readControl: () => RevealSubmissionsControl;
  readSubmissionCount: () => number;
  setPaused: (
    paused: boolean,
    expectedRevision: number,
    nowMs: number,
  ) => RevealSubmissionsControl;
};

function usage(): string {
  return [
    'Inspect or pause reveal submissions in mons-shop-ops D1.',
    '',
    'Usage:',
    '  npm run reveal-submissions-control -- status',
    '  npm run reveal-submissions-control -- pause --write',
    '  npm run reveal-submissions-control -- resume --write',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    return fail(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

export function parseRevealSubmissionsControlArgs(
  argv: string[],
): RevealSubmissionsControlArgs {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const [command, ...options] = argv;
  if (command !== 'status' && command !== 'pause' && command !== 'resume') {
    return fail(`Expected status, pause, or resume.\n\n${usage()}`);
  }
  if (options.some((option) => option !== '--write')) {
    return fail(`Unknown option.\n\n${usage()}`);
  }
  const writeCount = options.filter((option) => option === '--write').length;
  if (writeCount > 1) return fail('--write may only be provided once.');
  if (command === 'status' && writeCount !== 0) {
    return fail('status is read-only and does not accept --write.');
  }
  if (command !== 'status' && writeCount !== 1) {
    return fail(`${command} requires --write.`);
  }
  return { command, write: writeCount === 1 };
}

export function parseRevealSubmissionsControl(
  row: OpsD1Row,
): RevealSubmissionsControl {
  if (
    row.singleton !== 1 ||
    (row.paused !== 0 && row.paused !== 1) ||
    row.storage_source !== 'd1'
  ) return fail('Reveal-submission storage control is invalid.');
  return {
    paused: row.paused === 1,
    source: 'd1',
    revision: safeInteger(row.revision, 'Reveal-submission storage revision', 1),
    updatedAtMs: safeInteger(row.updated_at_ms, 'Reveal-submission storage update timestamp'),
    cutoverAtMs: safeInteger(row.cutover_at_ms, 'Reveal-submission cutover timestamp'),
  };
}

const controlSelect = `SELECT
  singleton,
  paused,
  storage_source,
  revision,
  updated_at_ms,
  cutover_at_ms
FROM reveal_submission_storage_control
WHERE singleton = 1`;

export function readRemoteRevealSubmissionsControl(): RevealSubmissionsControl {
  const rows = queryRemoteOpsD1(controlSelect);
  if (rows.length !== 1) return fail('Reveal-submission storage control is missing.');
  return parseRevealSubmissionsControl(rows[0]);
}

export function readRemoteRevealSubmissionCount(): number {
  const rows = queryRemoteOpsD1(
    'SELECT COUNT(*) AS reveal_submission_count FROM reveal_submissions',
  );
  if (rows.length !== 1) return fail('Reveal-submission count is invalid.');
  return safeInteger(rows[0].reveal_submission_count, 'Reveal-submission count');
}

function returningControl(): string {
  return 'RETURNING singleton, paused, storage_source, revision, updated_at_ms, cutover_at_ms';
}

export function setRemoteRevealSubmissionsPaused(
  paused: boolean,
  expectedRevision: number,
  nowMs: number,
): RevealSubmissionsControl {
  const rows = queryRemoteOpsD1(`UPDATE reveal_submission_storage_control
    SET
      paused = ${paused ? 1 : 0},
      revision = revision + 1,
      updated_at_ms = MAX(updated_at_ms, ${safeInteger(nowMs, 'Mutation timestamp')})
    WHERE
      singleton = 1 AND
      storage_source = 'd1' AND
      revision = ${safeInteger(expectedRevision, 'Expected revision', 1)}
    ${returningControl()}`);
  if (rows.length !== 1) {
    return fail('Reveal-submission storage control changed concurrently.');
  }
  return parseRevealSubmissionsControl(rows[0]);
}

function defaultDependencies(): RevealSubmissionsControlDependencies {
  return {
    nowMs: Date.now,
    readControl: readRemoteRevealSubmissionsControl,
    readSubmissionCount: readRemoteRevealSubmissionCount,
    setPaused: setRemoteRevealSubmissionsPaused,
  };
}

export async function runRevealSubmissionsControl(
  args: RevealSubmissionsControlArgs,
  dependencies = defaultDependencies(),
): Promise<{ control: RevealSubmissionsControl; submissionCount: number }> {
  const control = dependencies.readControl();
  if (args.command === 'status') {
    return { control, submissionCount: dependencies.readSubmissionCount() };
  }
  if (!args.write) return fail(`${args.command} requires --write.`);
  const updated = dependencies.setPaused(
    args.command === 'pause',
    control.revision,
    dependencies.nowMs(),
  );
  return { control: updated, submissionCount: dependencies.readSubmissionCount() };
}

export function formatRevealSubmissionsControl(result: {
  control: RevealSubmissionsControl;
  submissionCount: number;
}): string {
  return [
    `Reveal submissions are ${result.control.paused ? 'paused' : 'active'}.`,
    `Source: ${result.control.source}.`,
    `Rows: ${result.submissionCount}.`,
    `Revision: ${result.control.revision}.`,
    `Updated at: ${new Date(result.control.updatedAtMs).toISOString()}.`,
    `Cutover at: ${new Date(result.control.cutoverAtMs).toISOString()}.`,
  ].join(' ');
}

async function main(): Promise<void> {
  const args = parseRevealSubmissionsControlArgs(process.argv.slice(2));
  console.log(formatRevealSubmissionsControl(await runRevealSubmissionsControl(args)));
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
