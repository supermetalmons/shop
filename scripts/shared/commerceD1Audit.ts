import { sqlString, type CommerceD1Row } from './commerceD1Maintenance.ts';
import type { D1MaintenanceQueryBatch } from './d1MaintenanceRunner.ts';

type Query = (sql: string) => CommerceD1Row[];
type Cursor = Array<string | number>;

export function sequentialD1QueryBatch(query: Query): D1MaintenanceQueryBatch {
  return (queries) => Object.fromEntries(Object.entries<string>(queries)
    .map(([key, sql]) => [key, query(sql)])) as ReturnType<D1MaintenanceQueryBatch>;
}

function compareCursor(left: Cursor, right: Cursor): number {
  for (let index = 0; index < left.length; index += 1) {
    if (typeof left[index] !== typeof right[index]) throw new Error('Commerce D1 audit cursor type changed.');
    const compared = typeof left[index] === 'number'
      ? Number(left[index]) - Number(right[index])
      : Buffer.compare(Buffer.from(String(left[index])), Buffer.from(String(right[index])));
    if (compared !== 0) return compared;
  }
  return 0;
}

export function* commerceD1AuditRows(query: Query, options: {
  table: string;
  keys: string[];
  columns?: string;
  alias?: string;
  joins?: string;
}): Generator<CommerceD1Row> {
  const { table, keys, alias = table, columns = `${alias}.*`, joins = '' } = options;
  const byteColumns = (prefix = '') => keys.map((key, index) =>
    `hex(CAST(${prefix}${key} AS BLOB)) AS __audit_key_bytes_${index}`).join(', ');
  const invalid = (): never => { throw new Error(`Commerce D1 audit page is invalid for ${table}.`); };
  const readRows = (sql: string, limit: number): CommerceD1Row[] => {
    const rows = query(sql);
    if (!Array.isArray(rows) || rows.length > limit || rows.some((row) =>
      !row || typeof row !== 'object' || Array.isArray(row))) invalid();
    return rows;
  };
  const cursor = (row: CommerceD1Row): Cursor => keys.map((key, index) => {
    const value = row[key];
    if ((typeof value !== 'string' || !value) &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) invalid();
    if (typeof value === 'string' &&
      row[`__audit_key_bytes_${index}`] !== Buffer.from(value, 'utf8').toString('hex').toUpperCase()) invalid();
    return value as string | number;
  });
  const upperRows = readRows(`SELECT ${keys.join(', ')}, ${byteColumns()} FROM ${table}
    ORDER BY ${keys.map((key) => `${key} DESC`).join(', ')} LIMIT 1`, 1);
  if (upperRows.length === 0) return;
  const upper = cursor(upperRows[0]);
  const literal = (values: Cursor) => `(${values.map((value) =>
    typeof value === 'number' ? String(value) : sqlString(value)).join(', ')})`;
  const keySql = `(${keys.map((key) => `${alias}.${key}`).join(', ')})`;
  let after: Cursor | undefined;
  for (;;) {
    const rows = readRows(`SELECT ${columns}, ${byteColumns(`${alias}.`)}
      FROM ${table} AS ${alias} ${joins}
      WHERE ${after ? `${keySql} > ${literal(after)} AND ` : ''}${keySql} <= ${literal(upper)}
      ORDER BY ${keys.map((key) => `${alias}.${key}`).join(', ')} LIMIT 100`, 100);
    for (const row of rows) {
      const next = cursor(row);
      if ((after && compareCursor(next, after) <= 0) || compareCursor(next, upper) > 0) invalid();
      after = next;
      keys.forEach((_, index) => { delete row[`__audit_key_bytes_${index}`]; });
      yield row;
    }
    if (rows.length < 100 || (after && compareCursor(after, upper) === 0)) return;
  }
}
