import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseAnonymousAuthControl,
  queryRemoteOpsD1,
  type AnonymousAuthControl,
} from '../shared/opsD1Maintenance.ts';
import { readOwnershipAudit, type OwnershipAudit } from './migrateFirebaseWalletOwnership.ts';

type Command = 'status' | 'disable-firebase';

export type AnonymousAuthControlArgs = {
  command: Command;
  write: boolean;
};

type Dependencies = {
  read: () => AnonymousAuthControl;
  disable: () => AnonymousAuthControl;
  audit: () => Promise<OwnershipAudit>;
};

export function parseAnonymousAuthControlArgs(argv: string[]): AnonymousAuthControlArgs {
  const command = argv.find((value): value is Command => value === 'status' || value === 'disable-firebase');
  if (!command || argv.some((value) => !['status', 'disable-firebase', '--write'].includes(value))) {
    throw new Error('Usage: npm run anonymous-auth-control -- <status|disable-firebase> [--write]');
  }
  const write = argv.includes('--write');
  if (command === 'status' && write) throw new Error('The status command does not accept --write.');
  if (command === 'disable-firebase' && !write) {
    throw new Error('Disabling Firebase authentication requires --write.');
  }
  return { command, write };
}

function readControl(): AnonymousAuthControl {
  const rows = queryRemoteOpsD1(`SELECT
    singleton,
    firebase_fallback_enabled,
    revision,
    created_at_ms,
    updated_at_ms,
    firebase_disabled_at_ms
    FROM anonymous_auth_control
    WHERE singleton = 1`);
  if (rows.length !== 1) throw new Error('Anonymous-auth control is missing.');
  return parseAnonymousAuthControl(rows[0]);
}

function disableFirebase(): AnonymousAuthControl {
  const rows = queryRemoteOpsD1(`UPDATE anonymous_auth_control
    SET
      firebase_fallback_enabled = 0,
      revision = revision + 1,
      updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      firebase_disabled_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    WHERE singleton = 1 AND firebase_fallback_enabled = 1
    RETURNING
      singleton,
      firebase_fallback_enabled,
      revision,
      created_at_ms,
      updated_at_ms,
      firebase_disabled_at_ms`);
  if (rows.length === 1) return parseAnonymousAuthControl(rows[0]);
  return readControl();
}

function format(control: AnonymousAuthControl): string {
  const disabledAt = control.firebaseDisabledAtMs === null
    ? 'not disabled'
    : new Date(control.firebaseDisabledAtMs).toISOString();
  return `Firebase fallback ${control.firebaseFallbackEnabled ? 'enabled' : 'disabled'}; revision ${control.revision}; ${disabledAt}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function auditDisabledState(
  control: AnonymousAuthControl,
  audit: Dependencies['audit'],
): Promise<string> {
  let result: OwnershipAudit;
  try {
    result = await audit();
  } catch (error) {
    throw new Error(`Firebase fallback is disabled, but the ownership audit failed: ${errorMessage(error)}. Run npm run migrate:firebase-wallet-ownership -- status.`, { cause: error });
  }
  if (result.mappedUpdates) {
    throw new Error(`Firebase fallback is disabled, but ${result.mappedUpdates} mapped delivery orders need migration. Run npm run migrate:firebase-wallet-ownership -- apply --write.`);
  }
  return `${format(control)} Post-disable ownership audit clean.`;
}

export async function runAnonymousAuthControl(
  args: AnonymousAuthControlArgs,
  dependencies: Dependencies = {
    read: readControl,
    disable: disableFirebase,
    audit: readOwnershipAudit,
  },
): Promise<string> {
  if (args.command === 'status') return format(dependencies.read());
  const current = dependencies.read();
  if (!current.firebaseFallbackEnabled) return auditDisabledState(current, dependencies.audit);
  const before = await dependencies.audit();
  if (before.mappedUpdates) {
    throw new Error(`Firebase fallback cannot be disabled while ${before.mappedUpdates} mapped delivery orders still need migration.`);
  }
  let control: AnonymousAuthControl;
  try {
    control = dependencies.disable();
  } catch (error) {
    throw new Error(`Firebase disable outcome is unknown: ${errorMessage(error)}. Run npm run anonymous-auth-control -- status before retrying.`, { cause: error });
  }
  if (args.command === 'disable-firebase' && control.firebaseFallbackEnabled) {
    throw new Error('Firebase fallback was not disabled.');
  }
  return auditDisabledState(control, dependencies.audit);
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  runAnonymousAuthControl(parseAnonymousAuthControlArgs(process.argv.slice(2)))
    .then((report) => console.log(report))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
