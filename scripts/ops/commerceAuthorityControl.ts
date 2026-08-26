import { pathToFileURL } from 'node:url';
import {
  queryRemoteCommerceD1,
  safeInteger,
} from '../shared/commerceD1Maintenance.ts';

type Command = 'status' | 'paused' | 'd1';

type Args = {
  command: Command;
  expectedRevision?: number;
  write: boolean;
};

function fail(message: string): never {
  throw new Error(message);
}

export function parseCommerceAuthorityControlArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'status' && command !== 'paused' && command !== 'd1') {
    fail('Usage: npm run commerce-authority-control -- <status|paused|d1> [--expected-revision <n>] [--write]');
  }
  let expectedRevision: number | undefined;
  let write = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--expected-revision') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) fail('Expected revision must be a positive integer.');
      expectedRevision = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (command === 'status' && (write || expectedRevision !== undefined)) fail('Status does not accept mutation options.');
  if (command !== 'status' && (!write || expectedRevision === undefined)) {
    fail(`${command} requires --write and --expected-revision.`);
  }
  return { command, expectedRevision, write };
}

const statusSql = `SELECT
  authority_state,
  revision,
  documents_revision,
  paused_at_ms,
  cutover_at_ms,
  import_manifest_sha256,
  updated_at_ms
FROM commerce_authority_control
WHERE singleton = 1`;

export function buildCommerceAuthorityMutationSql(
  command: Exclude<Command, 'status'>,
  expectedRevision: number,
  nowMs: number,
): string {
  if (command === 'paused') {
    return `UPDATE commerce_authority_control
      SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = ${nowMs}, updated_at_ms = ${nowMs}
      WHERE singleton = 1 AND authority_state = 'd1' AND revision = ${expectedRevision}
      RETURNING *`;
  }
  return `UPDATE commerce_authority_control
    SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, cutover_at_ms = COALESCE(cutover_at_ms, ${nowMs}), updated_at_ms = ${nowMs}
    WHERE singleton = 1 AND authority_state = 'paused' AND revision = ${expectedRevision}
      AND import_manifest_sha256 IS NOT NULL
    RETURNING *`;
}

export function runCommerceAuthorityControl(args: Args, nowMs = Date.now()): Record<string, unknown> {
  if (args.command === 'status') {
    const rows = queryRemoteCommerceD1(statusSql);
    if (rows.length !== 1) fail('Commerce authority control is missing or duplicated.');
    return rows[0];
  }
  const revision = safeInteger(args.expectedRevision, 'Expected revision');
  const rows = queryRemoteCommerceD1(buildCommerceAuthorityMutationSql(args.command, revision, nowMs));
  if (rows.length !== 1) fail('Commerce authority transition was rejected or changed concurrently.');
  return rows[0];
}

async function main(): Promise<void> {
  console.log(JSON.stringify(runCommerceAuthorityControl(parseCommerceAuthorityControlArgs(process.argv.slice(2))), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
