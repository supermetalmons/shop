import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { CaptureRun } from '../batch.mjs';
import { newCheckpoint, CONTROL_IDS, CARD_IDS, assetFingerprint, atomicJson } from '../run-state.mjs';

function runFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-note-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }));
  const output = path.join(directory, 'output'), cache = path.join(directory, 'cache');
  for (const folder of [output, cache, path.join(output, 'controls')]) fs.mkdirSync(folder, { recursive: true });
  const run = new CaptureRun({ output, cache, stopAfter: Infinity, stopAfterStartup: false, ...options });
  const preflight = { complete: true, summary: { assetsPassed: 4290 }, anomalies: [],
    cards: CARD_IDS.map(id => ({ id, assets: { front: { url: `https://example.test/${id}`, etag: 'stable', dimensions: [2000, 2800], totalBytes: 1 } } })) };
  run.config = { runFingerprint: 'run', sourceHashes: {}, assetFingerprint: assetFingerprint(preflight) };
  run.state = newCheckpoint('run');
  run.log = () => {};
  run.renderIds = async ids => {
    for (const id of ids) {
      if (run.state.completed[id]) continue;
      run.state.completed[id] = { id };
      run.state.commitOrder.push(id);
    }
  };
  run.control = async (id, label) => {
    if (run.state.controls.some(control => control.label === label)) return false;
    run.state.controls.push({ id, label, passed: true });
    return true;
  };
  run.python = async args => { atomicJson(args[args.indexOf('--output') + 1], preflight); };
  return run;
}

test('planned stop and resume retain the startup and periodic control schedule', async t => {
  const run = runFixture(t, { stopAfter: 4 });
  await run.renderCollection();
  assert.equal(run.count(), 4);
  assert.equal(run.state.status, 'stopped');
  assert.deepEqual(run.state.commitOrder, [460, 1, 166, 167]);
  assert.equal(run.state.startupControlsComplete, false);
  run.options.stopAfter = 105;
  await run.renderCollection();
  assert.equal(run.count(), 105);
  assert.equal(run.state.status, 'stopped');
  assert.equal(run.state.startupControlsComplete, true);
  assert.equal(run.state.lastControlCount, 100);
  const controls = run.state.controls;
  assert.equal(controls.filter(control => control.label.startsWith('resume-')).length, 4);
  assert.equal(controls.filter(control => control.label === 'startup-460').length, 1);
  assert.equal(controls.filter(control => control.label === 'after-0100').length, 1);
});

test('complete collection requires all periodic and final controls', async t => {
  const run = runFixture(t);
  await run.renderCollection();
  assert.equal(run.state.status, 'captured');
  assert.equal(run.count(), 1430);
  assert.equal(run.state.finalControlsComplete, true);
  assert.equal(run.state.controls.filter(control => control.label.startsWith('after-')).length, 14);
  assert.deepEqual(run.state.controls.filter(control => control.label.startsWith('end-')).map(control => control.id), CONTROL_IDS);
});

test('control drift quarantines only cards since the last passing boundary', async t => {
  const run = runFixture(t);
  await run.renderIds([1, 2, 3, 4]);
  run.state.lastControlCount = 2;
  run.state.finalControlsComplete = true;
  run.state.controls.push({ label: 'end-1', report: 'controls/end-1.json' });
  atomicJson(path.join(run.output, 'controls/end-1.json'), {});
  for (const id of [1, 2, 3, 4]) fs.writeFileSync(path.join(run.output, `${id}.png`), String(id));
  run.control = async () => { throw new Error('CONTROL_DRIFT: fixture'); };
  await assert.rejects(run.guardedControl(460, 'after-0100'), /CONTROL_DRIFT/);
  assert.deepEqual(run.state.commitOrder, [1, 2]);
  assert.equal(run.state.finalControlsComplete, false);
  assert.equal(fs.existsSync(path.join(run.output, '1.png')), true);
  assert.equal(fs.existsSync(path.join(run.output, '3.png')), false);
  assert.equal(run.state.controls.length, 0);
});

test('finalization keeps at most two Python workers active', async t => {
  const run = runFixture(t);
  let active = 0, maximum = 0;
  run.python = async args => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    const stage = args[args.indexOf('--stage') + 1];
    atomicJson(path.join(stage, 'result.json'), { qaPassed: true });
    active--;
    return { stdout: '', stderr: '' };
  };
  const jobs = [1, 2, 3, 4].map(id => run.makeJob(id));
  await Promise.all(jobs.map(job => run.finalize(job)));
  assert.equal(maximum, 2);
  assert.equal(run.activeWorkers, 0);
});
