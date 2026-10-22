import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createD1MaintenanceRunner } from '../scripts/shared/d1MaintenanceRunner.ts';

function envelope(results: Record<string, unknown>[][]): string {
  return JSON.stringify(results.map((rows) => ({ success: true, results: rows })));
}

const databases = [
  { name: 'data', label: 'D1', maxBuffer: 32 * 1024 * 1024 },
  { name: 'ops', label: 'Ops D1', maxBuffer: 32 * 1024 * 1024 },
  { name: 'commerce', label: 'Commerce D1', maxBuffer: 64 * 1024 * 1024 },
] as const;

for (const database of databases) {
  test(`${database.label} preserves Wrangler invocation and process options`, () => {
    let calls = 0;
    const sql = "SELECT 'literal; value' AS value";
    const runner = createD1MaintenanceRunner(database.name, (file, args, options) => {
      calls += 1;
      assert.equal(file, resolve('node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'));
      assert.deepEqual(args, [
        'd1', 'execute', `mons-shop-${database.name}`, '--remote', '--command', sql,
        '--config', 'cloud/workers/api/wrangler.jsonc',
        '--env-file', 'cloud/workers/api/release.env', '--json',
      ]);
      assert.deepEqual(options, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: process.env,
        maxBuffer: database.maxBuffer,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10 * 60_000,
      });
      return `\n${envelope([[{ value: 'literal; value' }]])}\n`;
    });
    assert.deepEqual(runner.query(sql), [{ value: 'literal; value' }]);
    assert.equal(calls, 1);
  });

  test(`${database.label} preserves malformed output errors`, () => {
    const commerce = database.name === 'commerce';
    const cases = [
      ['{', 'returned invalid JSON.'],
      ['{}', `returned an invalid ${commerce ? 'result' : 'query'} envelope.`],
      ['[]', `returned an invalid ${commerce ? 'result' : 'query'} envelope.`],
      ['[null]', `returned an invalid ${commerce ? '' : 'query '}result.`],
      ['[[]]', `returned an invalid ${commerce ? '' : 'query '}result.`],
      ['[{"success":false,"results":[]}]', 'query failed.'],
      ['[{"success":true,"results":{}}]', 'query failed.'],
    ];
    for (const [output, message] of cases) {
      const runner = createD1MaintenanceRunner(database.name, () => output);
      assert.throws(() => runner.query('SELECT 1'), { message: `${database.label} ${message}` });
    }
    const multiple = createD1MaintenanceRunner(database.name, () => envelope([[], []]));
    assert.throws(() => multiple.query('SELECT 1; SELECT 2'), {
      message: `Expected exactly one ${database.label} statement result.`,
    });
  });

  test(`${database.label} preserves command failure output and fallback`, () => {
    const detailed = createD1MaintenanceRunner(database.name, () => {
      throw { stdout: '\u001b[31mfirst detail\u001b[0m\n', stderr: '\nsecond detail\n' };
    });
    assert.throws(() => detailed.query('SELECT 1'), { message: 'first detail\nsecond detail' });
    const fallback = createD1MaintenanceRunner(database.name, () => { throw new Error('spawn failed'); });
    assert.throws(() => fallback.query('SELECT 1'), { message: `Wrangler ${database.label} command failed.` });
  });

  test(`${database.label} preserves JSON preamble handling`, () => {
    const runner = createD1MaintenanceRunner(database.name, () => `Wrangler output\n${envelope([[]])}`);
    if (database.name === 'commerce') assert.deepEqual(runner.query('SELECT 1'), []);
    else assert.throws(() => runner.query('SELECT 1'), { message: `${database.label} returned invalid JSON.` });
  });
}

test('named query batches use one command and preserve empty result positions', () => {
  let calls = 0;
  const runner = createD1MaintenanceRunner('ops', (_file, args) => {
    calls += 1;
    assert.equal(args[args.indexOf('--command') + 1], 'SELECT 1 AS value;\nSELECT 2 WHERE 0;\nSELECT 3 AS value');
    assert.equal(args.includes('--file'), false);
    return envelope([[{ value: 1 }], [], [{ value: 3 }]]);
  });
  assert.deepEqual(runner.queryBatch({ first: 'SELECT 1 AS value;', empty: 'SELECT 2 WHERE 0', last: 'SELECT 3 AS value' }), {
    first: [{ value: 1 }], empty: [], last: [{ value: 3 }],
  });
  assert.equal(calls, 1);
});

test('named query batches reject missing, extra, or failed statement results', () => {
  for (const count of [1, 3]) {
    const runner = createD1MaintenanceRunner('data', () => envelope(Array.from({ length: count }, () => [])));
    assert.throws(() => runner.queryBatch({ first: 'SELECT 1', second: 'SELECT 2' }), {
      message: 'Expected exactly 2 D1 statement results.',
    });
  }
  const failed = createD1MaintenanceRunner('data', () => JSON.stringify([
    { success: true, results: [] }, { success: false, results: [] },
  ]));
  assert.throws(() => failed.queryBatch({ first: 'SELECT 1', second: 'SELECT 2' }), { message: 'D1 query failed.' });
});

test('empty query batches fail before running Wrangler', () => {
  const runner = createD1MaintenanceRunner('ops', () => assert.fail('must not execute'));
  const cases: Array<Record<string, string>> = [{}, { blank: ' ' }];
  for (const queries of cases) {
    assert.throws(() => runner.queryBatch(queries), {
      message: 'Ops D1 query batch must contain non-empty statements.',
    });
  }
});

test('Commerce named batches preserve empty positions and reject malformed statement envelopes', () => {
  const queries = { first: 'SELECT 1', empty: 'SELECT 2 WHERE 0', last: 'SELECT 3' };
  const valid = createD1MaintenanceRunner('commerce', () => envelope([[{ value: 1 }], [], [{ value: 3 }]]));
  assert.deepEqual(valid.queryBatch(queries), { first: [{ value: 1 }], empty: [], last: [{ value: 3 }] });
  for (const output of [
    envelope([[], []]), envelope([[], [], [], []]),
    JSON.stringify([{ success: true, results: [] }, { success: false, results: [] }, { success: true, results: [] }]),
    JSON.stringify([{ success: true, results: [] }, { success: true, results: null }, { success: true, results: [] }]),
  ]) {
    const runner = createD1MaintenanceRunner('commerce', () => output);
    assert.throws(() => runner.queryBatch(queries), /(?:Expected exactly 3 Commerce D1 statement results|Commerce D1 query failed)/);
  }
});

test('Commerce file execution preserves file mode and import summary results', () => {
  const summary = [{ 'Total queries executed': 2, 'Rows read': 0, 'Rows written': 2 }];
  const runner = createD1MaintenanceRunner('commerce', (_file, args) => {
    assert.equal(args[args.indexOf('--file') + 1], '/tmp/maintenance.sql');
    assert.equal(args.includes('--command'), false);
    return envelope([summary]);
  });
  assert.deepEqual(runner.executeFile('/tmp/maintenance.sql'), [summary]);
});

test('raw command execution preserves multi-statement writes verbatim', () => {
  const sql = 'UPDATE pack_status SET unsealed_online = 1;\nUPDATE pack_status_metadata SET cache_generation = 2;';
  const runner = createD1MaintenanceRunner('data', (_file, args) => {
    assert.equal(args[args.indexOf('--command') + 1], sql);
    return envelope([[], []]);
  });
  assert.deepEqual(runner.executeCommand(sql), [[], []]);
});

test('large named batches retain one Wrangler command and result mapping without SQL in process arguments', () => {
  const sql = `SELECT '${'界'.repeat(12000)}' AS value`;
  let calls = 0;
  const runner = createD1MaintenanceRunner('commerce', (file, args, options) => {
    calls++;
    assert.equal(file, process.execPath);
    assert.deepEqual(args.slice(0, 4), ['--no-warnings', '--require', resolve('scripts/shared/d1CommandInput.cjs'),
      createRequire(import.meta.url).resolve('wrangler')]);
    assert.equal(args[args.indexOf('--command') + 1], 'MONS_D1_SQL_STDIN');
    assert.equal(args.includes('--file'), false);
    assert.ok(!args.some(value => value.includes('界')));
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(options.input, `${sql};\nSELECT 2 WHERE 0`);
    return envelope([[{ value: 1 }], []]);
  });
  assert.deepEqual(runner.queryBatch({ large: sql, empty: 'SELECT 2 WHERE 0' }), { large: [{ value: 1 }], empty: [] });
  assert.equal(calls, 1);
});

test('large SQL reaches the CLI unchanged through stdin beyond operating-system argument limits', t => {
  const directory = mkdtempSync(join(tmpdir(), 'd1-command-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, 'cli.cjs');
  writeFileSync(cli, `const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
assert.equal(require.main, module);
const sql = process.argv[process.argv.indexOf('--command') + 1];
process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(sql), hash: createHash('sha256').update(sql).digest('hex') }));`);
  const input = `SELECT '${'界\n\"; literal'.repeat(100000)}'`;
  const preload = resolve('scripts/shared/d1CommandInput.cjs');
  const result = JSON.parse(execFileSync(process.execPath, ['--require', preload, cli, '--command', 'MONS_D1_SQL_STDIN'], {
    encoding: 'utf8', input, maxBuffer: 1024 * 1024,
  }));
  assert.deepEqual(result, { bytes: Buffer.byteLength(input), hash: createHash('sha256').update(input).digest('hex') });
  assert.throws(() => execFileSync(process.execPath, ['--require', preload, cli, '--command', 'wrong-input'], {
    encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'],
  }), /Invalid D1 command input/);
});
