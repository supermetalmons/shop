import { pathToFileURL } from 'node:url';
import { COMMERCE_D1_NOW_MS_SQL, queryRemoteCommerceD1, sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';
import { ethereum111kScope, readEthereum111kControl, type Ethereum111kScope } from '../shared/ethereum111kMaintenance.ts';
import { parseEthereum111kControl, type Ethereum111kControl } from '../../shared/ethereum/control.ts';

export type Ethereum111kControlArgs = { command: 'status' | 'pause' | 'resume'; write: boolean; expectedRevision?: number; scope?: Ethereum111kScope };

export function parseEthereum111kControlArgs(argv: string[]): Ethereum111kControlArgs {
  const command = argv[0];
  if (command !== 'status' && command !== 'pause' && command !== 'resume') throw new Error('Usage: ethereum111k-control -- <status|pause|resume> [--chain-id <n> --contract <address> --expected-revision <n>] [--write]');
  let write = false;
  let chainId: number | undefined;
  let contract: string | undefined;
  let expectedRevision: number | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--write') { write = true; continue; }
    const value = argv[++index];
    if (flag === '--chain-id') chainId = Number(value);
    else if (flag === '--contract') contract = value;
    else if (flag === '--expected-revision') expectedRevision = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (command === 'status') {
    if (seen.size) throw new Error('Status does not accept mutation options.');
    return { command, write };
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 1) throw new Error('Mutation planning requires --expected-revision.');
  return { command, write, expectedRevision, scope: ethereum111kScope(chainId, contract) };
}

export function buildEthereum111kControlMutation(args: Ethereum111kControlArgs, control: Ethereum111kControl): string {
  if (args.command === 'status' || !args.scope || args.expectedRevision !== control.revision || control.resetGuardId !== null) throw new Error('Ethereum 111k control changed or a reset is active.');
  const { chainId, contractAddress } = args.scope;
  const sameScope = control.chainId === chainId && control.contractAddress === contractAddress;
  if (args.command === 'pause' && control.chainId !== null && !sameScope) throw new Error('Pause must use the existing allowed scope.');
  if (args.command === 'resume' && (!control.paused || control.chainId === null)) throw new Error('Resume requires a paused, initialized scope.');
  const requireEmpty = args.command === 'resume' && !sameScope
    ? `AND NOT EXISTS (SELECT 1 FROM commerce_documents WHERE drop_id = '111k_devnet')
       AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ${control.chainId} AND contract_address = ${sqlString(control.contractAddress!)})
       AND NOT EXISTS (SELECT 1 FROM ethereum_crate_claims WHERE chain_id = ${control.chainId} AND contract_address = ${sqlString(control.contractAddress!)})
       AND NOT EXISTS (SELECT 1 FROM ethereum_reconciliation_cursor WHERE chain_id = ${control.chainId} AND contract_address = ${sqlString(control.contractAddress!)})` : '';
  return `UPDATE ethereum_111k_control SET paused = ${args.command === 'pause' ? 1 : 0}, revision = revision + 1,
    paused_at_ms = ${args.command === 'pause' ? COMMERCE_D1_NOW_MS_SQL : 'NULL'},
    chain_id = ${chainId}, contract_address = ${sqlString(contractAddress)}, updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
    WHERE singleton = 1 AND revision = ${args.expectedRevision} AND reset_guard_id IS NULL
      AND paused = ${control.paused ? 1 : 0}
      AND chain_id IS ${control.chainId ?? 'NULL'} AND contract_address IS ${control.contractAddress === null ? 'NULL' : sqlString(control.contractAddress)}
      ${requireEmpty} RETURNING *`;
}

export async function runEthereum111kControl(argv: string[], overrides: { query?: CommerceAuthorityQuery } = {}) {
  const args = parseEthereum111kControlArgs(argv);
  const query = overrides.query ?? queryRemoteCommerceD1;
  const control = await readEthereum111kControl(query);
  if (args.command === 'status') return { control };
  const sql = buildEthereum111kControlMutation(args, control);
  if (!args.write) return { dryRun: true, command: args.command, control, targetScope: args.scope, sql };
  try {
    const result = await query(sql);
    if (result.length !== 1) throw new Error('Ethereum 111k control transition rejected; stale revision or old-scope data remains.');
    return { dryRun: false, control: parseEthereum111kControl(result[0]) };
  } catch (error) {
    const observed = await readEthereum111kControl(query);
    if (observed.revision === args.expectedRevision! + 1 && observed.paused === (args.command === 'pause')
      && observed.chainId === args.scope!.chainId && observed.contractAddress === args.scope!.contractAddress
      && observed.resetGuardId === null) return { dryRun: false, reconciled: true, control: observed };
    throw new Error('Ethereum 111k control transition was not confirmed; inspect status before retrying.', { cause: error });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runEthereum111kControl(process.argv.slice(2)), null, 2));
}
