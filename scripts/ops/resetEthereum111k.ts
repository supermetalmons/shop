import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createD1MaintenanceRunner } from '../shared/d1MaintenanceRunner.ts';
import { type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { buildEthereum111kResetBatch, buildEthereum111kResetPlan, createEthereum111kMaintenanceRunner, ethereum111kResetOutcome, ethereum111kScope,
  ETHEREUM_111K_DATA_PREFLIGHT_SQL, ETHEREUM_111K_OPS_PREFLIGHT_SQL, readEthereum111kSnapshot,
  requireZeroEthereum111kHistory, type Ethereum111kQueryBatch, type Ethereum111kResetPlan, type Ethereum111kScope } from '../shared/ethereum111kMaintenance.ts';

export type ResetEthereum111kArgs = { write: boolean; expectedRevision: number; scope: Ethereum111kScope; resetId?: string; backupDirectory?: string };
type Dependencies = { queryBatch: Ethereum111kQueryBatch; queryData: CommerceAuthorityQuery; queryOps: CommerceAuthorityQuery;
  resetId: () => string; backup: (plan: Ethereum111kResetPlan, directory?: string) => string };

export function parseResetEthereum111kArgs(argv: string[]): ResetEthereum111kArgs {
  let write = false;
  let chainId: number | undefined;
  let contract: string | undefined;
  let expectedRevision: number | undefined;
  let resetId: string | undefined;
  let backupDirectory: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--write') { write = true; continue; }
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--chain-id') chainId = Number(value);
    else if (flag === '--old-contract') contract = value;
    else if (flag === '--expected-revision') expectedRevision = Number(value);
    else if (flag === '--reset-id') resetId = value;
    else if (flag === '--backup-directory') backupDirectory = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 1) throw new Error('Reset requires --expected-revision.');
  if (resetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resetId)) throw new Error('Invalid reset ID.');
  return { write, expectedRevision: expectedRevision!, scope: ethereum111kScope(chainId, contract), resetId, backupDirectory };
}

export function writeEthereum111kResetBackup(plan: Ethereum111kResetPlan, directory = join(homedir(), '.mons-shop-backups', 'ethereum111k')): string {
  if (!isAbsolute(directory)) throw new Error('Backup directory must be absolute and outside Git.');
  const repoRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const target = resolve(realpathSync(ancestor), relative(ancestor, resolve(directory)));
  const relativeToRepo = relative(repoRoot, target);
  if (relativeToRepo !== '..' && !relativeToRepo.startsWith(`..${sep}`) && !isAbsolute(relativeToRepo)) throw new Error('Backup must be outside the repository.');
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) throw new Error('Backup must be outside Git worktrees.');
    if (dirname(current) === current) break;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if ((statSync(target).mode & 0o077) !== 0) throw new Error('Backup directory must be private (mode 0700).');
  const path = join(target, `${plan.resetId}.json`);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  if (readFileSync(path, 'utf8') !== content || (statSync(path).mode & 0o077) !== 0) throw new Error('Private reset backup verification failed.');
  return path;
}

export async function runResetEthereum111k(argv: string[], overrides: Partial<Dependencies> = {}) {
  const args = parseResetEthereum111kArgs(argv);
  const deps: Dependencies = { queryBatch: createEthereum111kMaintenanceRunner().queryBatch, queryData: createD1MaintenanceRunner('data').query,
    queryOps: createD1MaintenanceRunner('ops').query, resetId: randomUUID, backup: writeEthereum111kResetBackup, ...overrides };
  const externalPreflight = async () => {
    const [data, ops] = await Promise.all([deps.queryData(ETHEREUM_111K_DATA_PREFLIGHT_SQL), deps.queryOps(ETHEREUM_111K_OPS_PREFLIGHT_SQL)]);
    requireZeroEthereum111kHistory(data, 'DATA pack-status history');
    requireZeroEthereum111kHistory(ops, 'OPS reveal submissions');
  };
  const snapshot = await readEthereum111kSnapshot(deps.queryBatch, args.scope);
  if (args.resetId && snapshot.control.lastResetId === args.resetId) {
    const completed = snapshot.control.resetGuardId === null && snapshot.control.paused
      && snapshot.control.revision === args.expectedRevision + 1 && snapshot.control.chainId === args.scope.chainId
      && snapshot.control.contractAddress === args.scope.contractAddress && Object.values(snapshot.counts).every(count => count === 0)
      && snapshot.quotes.length === 0 && snapshot.claims.length === 0 && snapshot.cursors.length === 0
      && snapshot.checkouts.length === 0 && snapshot.attempts.length === 0;
    if (!completed) throw new Error('Previous reset ID exists but its outcome cannot be confirmed.');
    return { dryRun: !args.write, completed: true, reconciled: true, resetId: args.resetId, control: snapshot.control };
  }
  await externalPreflight();
  const plan = buildEthereum111kResetPlan(snapshot, args.scope, args.expectedRevision, args.resetId ?? deps.resetId());
  const summary = { resetId: plan.resetId, scope: plan.scope, expectedRevision: plan.expectedRevision,
    counts: { ...snapshot.counts, quotes: snapshot.quotes.length, checkouts: snapshot.checkouts.length,
      attempts: snapshot.attempts.length, claims: snapshot.claims.length, cursors: snapshot.cursors.length } };
  if (!args.write) return { dryRun: true, ...summary, pausedForMs: snapshot.databaseNowMs - snapshot.control.pausedAtMs! };
  const batch = buildEthereum111kResetBatch(plan);
  const backupPath = deps.backup(plan, args.backupDirectory);
  await externalPreflight();
  let executionError: unknown;
  try { await deps.queryBatch(batch); } catch (error) { executionError = error; }
  let outcome: ReturnType<typeof ethereum111kResetOutcome>;
  try { outcome = ethereum111kResetOutcome(plan, await readEthereum111kSnapshot(deps.queryBatch, args.scope)); }
  catch (error) { throw new Error(`Reset ${plan.resetId} outcome is unknown. Inspect last_reset_id and scoped counts before retrying. Backup: ${backupPath}`, { cause: error }); }
  if (outcome === 'completed') return { dryRun: false, completed: true, reconciled: executionError !== undefined, ...summary, backupPath };
  throw new Error(`Reset ${plan.resetId} ${outcome === 'unchanged' ? 'was not applied; create a fresh dry-run plan before retrying' : 'outcome is unknown; inspect last_reset_id and scoped counts before retrying'}. Backup: ${backupPath}`, { cause: executionError });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runResetEthereum111k(process.argv.slice(2)), null, 2));
}
