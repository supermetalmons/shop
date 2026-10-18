import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseArguments } from '../cli.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('public CLI requires explicit IDs and output with no backend or quality overrides', () => {
  assert.deepEqual(parseArguments([]), { command: 'help' });
  assert.deepEqual(parseArguments(['doctor']), { command: 'doctor' });
  for (const args of [['run'], ['run', '--ids', '17'], ['run', '--output', '/tmp/render'], ['doctor', '--ids', '17']]) assert.throws(() => parseArguments(args));
  for (const flag of ['--backend', '--method', '--probe', '--python', '--app', '--expected-icc', '--port', '--resume']) {
    assert.throws(() => parseArguments(['run', '--ids', '17', '--output', '/tmp/render', flag, 'anything']), /Unknown option/);
  }
  assert.throws(() => parseArguments(['setup']), /Unknown command/);
  assert.throws(() => parseArguments(['run', '--ids', '17', '--output', 'relative']), /absolute/);
});

test('run and resume keep an ordered, explicit, duplicate-free card selection', () => {
  const run = parseArguments(['run', '--ids', '1,4-6,1430', '--output', '/tmp/render', '--retain-all']);
  assert.deepEqual(run.cardIds, [1, 4, 5, 6, 1430]);
  assert.equal(run.resume, false);
  assert.equal(run['retain-all'], true);
  assert.equal(parseArguments(['resume', '--ids', '17', '--output', '/tmp/render']).resume, true);
  for (const ids of ['0', '1431', '3-1', '1-3,2', '17,17', '1,', '1e2', '9007199254740999']) assert.throws(() => parseArguments(['run', '--ids', ids, '--output', '/tmp/render']));
  assert.throws(() => parseArguments(['run', '--ids', '17', '--ids', '18', '--output', '/tmp/render']), /Duplicate option/);
});

test('help and invalid commands do not create an output directory', context => {
  const root = mkdtempSync(join(tmpdir(), 'mi-note-cli-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'not-created');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /doctor/);
  const rejected = spawnSync(process.execPath, [cli, 'run', '--output', output], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--ids and --output are required/);
  assert.equal(existsSync(output), false);
});

test('legacy resume rejection preserves the existing manifest bytes', context => {
  const root = mkdtempSync(join(tmpdir(), 'mi-note-legacy-resume-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'native-run.json'), content = '{"version":1,"status":"complete"}\n';
  writeFileSync(path, content);
  const result = spawnSync(process.execPath, [cli, 'resume', '--ids', '17', '--output', root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version 2/);
  assert.equal(readFileSync(path, 'utf8'), content);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} reaches the child once and allows cleanup before the launcher exits`, { timeout: 10_000 }, async context => {
    const childSource = `
      let interrupted = false;
      const stop = () => { interrupted = true; process.stdout.write('SIGNAL\\n'); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.stdin.on('data', () => {
        if (!interrupted) process.exit(2);
        process.stdout.write('CLEANUP_DONE\\n');
        process.exit(0);
      });
      process.stdout.write('READY:' + process.pid + '\\n');
    `;
    const wrapperSource = `
      import { execute } from ${JSON.stringify(pathToFileURL(cli).href)};
      process.exitCode = await execute(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}], process.env);
    `;
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = createInterface({ input: wrapper.stdout });
    const lines = reader[Symbol.asyncIterator]();
    let childPid, stderr = '';
    wrapper.stderr.setEncoding('utf8');
    wrapper.stderr.on('data', value => { stderr += value; });
    const exited = new Promise((resolve, reject) => {
      wrapper.once('error', reject);
      wrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    context.after(() => {
      for (const pid of [wrapper.pid, childPid]) {
        if (!pid) continue;
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      reader.close();
      wrapper.stdin.destroy();
      wrapper.stdout.destroy();
      wrapper.stderr.destroy();
    });
    const nextLine = () => Promise.race([
      lines.next().then(({ value, done }) => {
        assert.equal(done, false, `Launcher output ended before cleanup: ${stderr}`);
        return value;
      }),
      exited.then(result => { throw new Error(`Launcher exited before cleanup: ${JSON.stringify(result)} ${stderr}`); }),
    ]);
    const ready = await nextLine();
    assert.match(ready, /^READY:\d+$/);
    childPid = Number(ready.slice('READY:'.length));
    const interrupt = () => signal === 'SIGINT' ? process.kill(-wrapper.pid, signal) : wrapper.kill(signal);
    interrupt();
    assert.equal(await nextLine(), 'SIGNAL');
    interrupt();
    wrapper.stdin.end('finish\n');
    assert.equal(await nextLine(), 'CLEANUP_DONE');
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  });
}
