import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameWorker } from '../frame-worker.mjs';

function fixture(context, source, options = {}) {
  const activeChildren = new Set();
  const worker = new FrameWorker(process.execPath, ['--input-type=module', '-e', source], {
    activeChildren, timeoutMilliseconds: 5000, stopMilliseconds: 50, ...options,
  });
  context.after(() => worker.close());
  return { worker, activeChildren };
}

const readLines = "import { createInterface } from 'node:readline'; const input = createInterface({ input: process.stdin });";

test('one tracked process handles requests serially and closes without leaving a child', async context => {
  const { worker, activeChildren } = fixture(context, `${readLines}
    let busy = false; let sequence = 0;
    input.on('line', line => {
      if (busy) throw new Error('Concurrent request received');
      busy = true;
      const request = JSON.parse(line);
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: request.id, result: { sequence: ++sequence, args: request.args, pid: process.pid } }) + '\\n');
        busy = false;
      }, 10);
    });`);
  assert.equal(activeChildren.size, 1);
  const results = await Promise.all([1, 2, 3].map(value => worker.request('fixture', { value })));
  assert.deepEqual(results.map(result => result.sequence), [1, 2, 3]);
  assert.deepEqual(results.map(result => result.args), [{ value: 1 }, { value: 2 }, { value: 3 }]);
  assert.equal(new Set(results.map(result => result.pid)).size, 1);
  await worker.close();
  assert.equal(activeChildren.size, 0);
  assert.throws(() => process.kill(results[0].pid, 0), { code: 'ESRCH' });
  await assert.rejects(worker.request('fixture', {}), /closed/);
});

test('an operation error keeps the worker available for the next request', async context => {
  const { worker } = fixture(context, `${readLines}
    input.on('line', line => {
      const { id, operation } = JSON.parse(line);
      const response = operation === 'bad' ? { id, error: { type: 'ValueError', message: 'Tile overlap/seam QA failed' } } : { id, result: 42 };
      process.stdout.write(JSON.stringify(response) + '\\n');
    });`);
  await assert.rejects(worker.request('bad', {}), /failed \(1\): Tile overlap\/seam QA failed/);
  assert.equal(await worker.request('good', {}), 42);
});

test('malformed, mismatched, duplicate and oversized output terminate the worker', async context => {
  for (const response of ["'not JSON\\n'", "JSON.stringify({id:999,result:{}})+'\\n'",
    "JSON.stringify({id:1,result:{},error:{message:'both'}})+'\\n'",
    "JSON.stringify({id:1,error:{message:42}})+'\\n'", "'x'.repeat(4*1024*1024+1)",
    "JSON.stringify({id:1,result:{}})+'\\n'+JSON.stringify({id:1,result:{}})+'\\n'"]) {
    const { worker, activeChildren } = fixture(context, `${readLines}
      input.on('line', () => process.stdout.write(${response}));`);
    const results = await Promise.allSettled([worker.request('first', {}), worker.request('second', {})]);
    assert.equal(results[1].status, 'rejected');
    assert.match(results[1].reason.message, /Invalid frame worker response|response is too large/);
    await worker.close();
    assert.equal(activeChildren.size, 0);
  }
});

test('a dead child or closed stdout rejects active and queued requests promptly', async context => {
  for (const action of ["process.stderr.write('fixture failure'); process.exit(23)",
    "process.stdout.end(); setInterval(() => {}, 1000)"]) {
    const { worker, activeChildren } = fixture(context, `${readLines} input.on('line', () => { ${action}; });`);
    const results = await Promise.allSettled([worker.request('first', {}), worker.request('second', {})]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.match(results[0].reason.message, /worker exited|worker output ended/);
    await worker.close();
    assert.equal(activeChildren.size, 0);
  }
});

test('a hung request is timed out and escalates when SIGTERM is ignored', async context => {
  const { worker, activeChildren } = fixture(context, `${readLines}
    process.on('SIGTERM', () => {});
    input.on('line', line => {
      const { id, operation } = JSON.parse(line);
      if (operation === 'ready') process.stdout.write(JSON.stringify({ id, result: true })+'\\n');
    });
    setInterval(() => {}, 1000);`);
  await worker.request('ready', {});
  worker.timeoutMilliseconds = 30;
  await assert.rejects(worker.request('hang', {}), /timed out/);
  await worker.close();
  assert.equal(worker.child.signalCode, 'SIGKILL');
  assert.equal(activeChildren.size, 0);
});

test('a crashed worker retains ownership until its resistant descendant is stopped', async context => {
  for (const handler of ['() => {}', '() => setTimeout(() => process.exit(0), 1000)']) {
    const descendantSource = `process.on('SIGTERM', ${handler}); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const { worker, activeChildren } = fixture(context, `${readLines}
      import { spawn } from 'node:child_process';
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      const ready = new Promise(resolve => descendant.stdout.once('data', () => { descendant.stdout.destroy(); resolve(); }));
      input.on('line', async line => {
        await ready;
        const { id, operation } = JSON.parse(line);
        if (operation === 'ready') process.stdout.write(JSON.stringify({ id, result: descendant.pid })+'\\n');
        else process.exit(23);
      });`, { stopMilliseconds: 200 });
    context.after(() => worker.signal('SIGKILL'));
    const descendant = await worker.request('ready', {});
    const directClosed = new Promise(resolve => worker.child.once('close', resolve));
    await assert.rejects(worker.request('crash', {}), /worker exited|worker output ended/);
    await directClosed;
    assert.equal(activeChildren.size, 1);
    assert.doesNotThrow(() => process.kill(descendant, 0));
    await worker.close();
    assert.equal(activeChildren.size, 0);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(-worker.child.pid, 0), { code: 'ESRCH' });
  }
});

test('closing during work cancels both pending and queued requests', async context => {
  const { worker, activeChildren } = fixture(context, `${readLines} input.on('line', () => {});`);
  const requests = Promise.allSettled([worker.request('first', {}), worker.request('second', {})]);
  await worker.close();
  const results = await requests;
  assert.ok(results.every(result => result.status === 'rejected' && /closed/.test(result.reason.message)));
  assert.equal(activeChildren.size, 0);
});

test('external process-group cancellation and spawn failures reject requests and clean tracking', async context => {
  const { worker, activeChildren } = fixture(context, `${readLines} input.on('line', () => {});`);
  const pending = assert.rejects(worker.request('hang', {}), /worker exited|worker output ended|EPIPE/);
  process.kill(-worker.child.pid, 'SIGTERM');
  await pending;
  await worker.close();
  assert.equal(activeChildren.size, 0);
  const missing = new FrameWorker('/missing/mi-note-frame-worker-python', [], { activeChildren });
  await assert.rejects(missing.request('inspect', {}), /ENOENT/);
  await missing.close();
  assert.equal(activeChildren.size, 0);
});
