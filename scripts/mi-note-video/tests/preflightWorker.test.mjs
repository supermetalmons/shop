import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { FrameWorker } from '../frame-worker.mjs';

const source = readFileSync(new URL('../preflight.mjs', import.meta.url), 'utf8');
const helperStart = source.indexOf('const imageHelper = ');
const helperEnd = source.indexOf('const assertSources = ', helperStart);
const lifecycleStart = source.indexOf('const interrupt = signal => ');
assert.ok(helperStart >= 0 && helperEnd > helperStart && lifecycleStart > helperEnd);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fixture(main, { safariError, serverError } = {}) {
  const workers = [];
  const activeChildren = new Set();
  const events = new Map();
  const cleanup = [];
  class Worker extends FrameWorker {
    constructor(command, args) {
      assert.equal(command, 'fixture-python');
      assert.deepEqual(args, ['-u', '/fixture/scripts/mi-note-video/frame_worker.py']);
      super(process.execPath, ['--input-type=module', '-e', `
        import { createInterface } from 'node:readline';
        const input = createInterface({ input: process.stdin });
        input.on('line', line => {
          const { id, operation, args } = JSON.parse(line);
          if (operation === 'hang') return;
          process.stdout.write(JSON.stringify({ id, result: { operation, args, pid: process.pid } }) + '\\n');
        });
      `], { activeChildren, stopMilliseconds: 50 });
      workers.push(this);
    }

    async close() {
      cleanup.push('worker');
      await super.close();
    }
  }
  const report = {};
  const localProcess = { once: (signal, handler) => events.set(signal, handler) };
  const bindings = {
    FrameWorker: Worker, options: { python: 'fixture-python' }, root: '/fixture', join, report, events,
    runDirectory: '/fixture/run', existsSync: () => false, save: () => assert.fail('Unexpected report write'),
    process: localProcess, console: { error: () => {} }, ownedProcess: undefined,
    processList: () => assert.fail('No Safari process should be inspected'),
    safari: { close: async () => { cleanup.push('safari'); if (safariError) throw safariError; } },
    server: { close: async () => { cleanup.push('server'); if (serverError) throw serverError; } },
    main,
  };
  const execute = AsyncFunction(...Object.keys(bindings), `
    let frameWorker, interrupted;
    ${source.slice(helperStart, helperEnd)}
    const perform = main;
    main = () => perform({ imageHelper, compare, events });
    ${source.slice(lifecycleStart)}
  `);
  return { execute: () => execute(...Object.values(bindings)), workers, activeChildren, events, cleanup, report, localProcess };
}

test('preflight reuses one lazy worker and awaits its comparison result', async () => {
  const unused = fixture(async () => {});
  await unused.execute();
  assert.equal(unused.workers.length, 0);
  const results = [];
  const used = fixture(async ({ imageHelper, compare }) => {
    results.push(await imageHelper('inspect', { input: '/first.png' }));
    results.push(await imageHelper('prepare', { input: '/first.png', output: '/prepared.png', space: 'p3', size: 1980 }));
    results.push(await compare('/first.png', '/second.png'));
    results.push(await imageHelper('black-exterior', { input: '/first.png', bounds: [1, 2, 3, 4], size: 2970 }));
  });
  await used.execute();
  assert.equal(used.workers.length, 1);
  assert.equal(new Set(results.map(result => result.pid)).size, 1);
  assert.deepEqual(results.map(result => result.operation), ['inspect', 'prepare', 'compare', 'black-exterior']);
  assert.deepEqual(results[2].args, { first: '/first.png', second: '/second.png' });
  assert.deepEqual(used.cleanup, ['safari', 'server', 'worker']);
  assert.equal(used.activeChildren.size, 0);
});

test('preflight signals reject awaited image work and stop the worker process', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const run = fixture(async ({ imageHelper, events }) => {
      await imageHelper('inspect', { input: '/first.png' });
      setImmediate(() => events.get(signal)(signal));
      await imageHelper('hang', {});
      assert.fail('Interrupted work must not continue');
    });
    await run.execute();
    assert.equal(run.report.status, 'failed');
    assert.match(run.report.error, new RegExp(`Interrupted by ${signal}`));
    assert.equal(run.localProcess.exitCode, 1);
    assert.equal(run.activeChildren.size, 0);
    assert.throws(() => process.kill(run.workers[0].child.pid, 0), { code: 'ESRCH' });
  }
});

test('an interruption before image work prevents a worker from being created', async () => {
  const run = fixture(async ({ imageHelper, events }) => {
    events.get('SIGTERM')('SIGTERM');
    await imageHelper('inspect', { input: '/first.png' });
  });
  await run.execute();
  assert.equal(run.workers.length, 0);
  assert.match(run.report.error, /Interrupted by SIGTERM/);
});

test('worker cleanup completes even if Safari or server cleanup fails', async () => {
  for (const options of [{ safariError: new Error('Safari close failed') }, { serverError: new Error('Server close failed') }]) {
    const run = fixture(async ({ imageHelper }) => { await imageHelper('inspect', { input: '/first.png' }); }, options);
    await assert.rejects(run.execute(), /close failed/);
    assert.deepEqual(run.cleanup, ['safari', 'server', 'worker']);
    assert.equal(run.activeChildren.size, 0);
    assert.throws(() => process.kill(run.workers[0].child.pid, 0), { code: 'ESRCH' });
  }
});
