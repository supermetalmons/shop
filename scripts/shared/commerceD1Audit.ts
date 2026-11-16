import { sqlString, type CommerceAuthorityQuery, type CommerceD1Row } from './commerceD1Maintenance.ts';
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

type AuditOptions = {
  table: string;
  keys: string[];
  columns?: string;
  alias?: string;
  joins?: string;
  where?: string;
  rowKeys?: string[];
  pageSize?: number;
};

function createAuditScan(options: AuditOptions) {
  const { table, keys, alias = table, columns = `${alias}.*`, joins = '', where,
    rowKeys = keys, pageSize = 100 } = options;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || rowKeys.length !== keys.length) {
    throw new Error('Invalid Commerce D1 audit scan options.');
  }
  const byteColumns = (prefix = '') => keys.map((key, index) =>
    `hex(CAST(${prefix}${key} AS BLOB)) AS __audit_key_bytes_${index}`).join(', ');
  const invalid = (): never => { throw new Error(`Commerce D1 audit page is invalid for ${table}.`); };
  const readRows = (rows: CommerceD1Row[], limit: number): CommerceD1Row[] => {
    if (!Array.isArray(rows) || rows.length > limit || rows.some((row) =>
      !row || typeof row !== 'object' || Array.isArray(row))) invalid();
    return rows;
  };
  const cursor = (row: CommerceD1Row): Cursor => keys.map((_, index) => {
    const value = row[rowKeys[index]];
    if ((typeof value !== 'string' || !value) &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) invalid();
    if (typeof value === 'string' &&
      row[`__audit_key_bytes_${index}`] !== Buffer.from(value, 'utf8').toString('hex').toUpperCase()) invalid();
    return value as string | number;
  });
  const upperSql = `SELECT ${keys.map((key, index) => `${alias}.${key}${rowKeys[index] === key ? '' : ` AS ${rowKeys[index]}`}`).join(', ')}, ${byteColumns(`${alias}.`)} FROM ${table} AS ${alias}
    ${where ? `WHERE ${where}` : ''}
    ORDER BY ${keys.map((key) => `${alias}.${key} DESC`).join(', ')} LIMIT 1`;
  let upper: Cursor | undefined;
  const literal = (values: Cursor) => `(${values.map((value) =>
    typeof value === 'number' ? String(value) : sqlString(value)).join(', ')})`;
  const keySql = `(${keys.map((key) => `${alias}.${key}`).join(', ')})`;
  let after: Cursor | undefined;
  let done = false;
  return {
    upperSql,
    start(rows: CommerceD1Row[]) {
      const upperRows = readRows(rows, 1);
      if (upperRows.length === 0) done = true;
      else upper = cursor(upperRows[0]);
    },
    get done() { return done; },
    pageSql() {
      if (!upper) return invalid();
      return `SELECT ${columns}, ${byteColumns(`${alias}.`)}
      FROM ${table} AS ${alias} ${joins}
      WHERE ${where ? `(${where}) AND ` : ''}${after ? `${keySql} > ${literal(after)} AND ` : ''}${keySql} <= ${literal(upper)}
      ORDER BY ${keys.map((key) => `${alias}.${key}`).join(', ')} LIMIT ${pageSize}`;
    },
    *page(input: CommerceD1Row[]): Generator<CommerceD1Row> {
      if (!upper) return invalid();
      const rows = readRows(input, pageSize);
      for (const row of rows) {
        const next = cursor(row);
        if ((after && compareCursor(next, after) <= 0) || compareCursor(next, upper) > 0) invalid();
        after = next;
        keys.forEach((_, index) => { delete row[`__audit_key_bytes_${index}`]; });
        yield row;
      }
      done = rows.length < pageSize || Boolean(after && compareCursor(after, upper) === 0);
    },
  };
}

export function* commerceD1AuditRows(query: Query, options: AuditOptions): Generator<CommerceD1Row> {
  const scan = createAuditScan(options);
  scan.start(query(scan.upperSql));
  while (!scan.done) yield* scan.page(query(scan.pageSql()));
}

export async function* commerceD1AuditRowsAsync(query: CommerceAuthorityQuery, options: AuditOptions): AsyncGenerator<CommerceD1Row> {
  const scan = createAuditScan(options);
  scan.start(await query(scan.upperSql));
  while (!scan.done) {
    yield* scan.page(await query(scan.pageSql()));
  }
}
