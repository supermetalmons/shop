import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishStudy } from './publish.mjs';

async function fixture(t) {
  const output = await fs.mkdtemp(join(tmpdir(), 'egg-publish-test-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const staging = await fs.mkdtemp(join(output, '.egg-study-'));
  await fs.mkdir(join(output, 'finish'));
  await fs.mkdir(join(staging, 'finish'));
  for (const name of ['finish/1.png', 'finish/2.png', 'comparison.png']) {
    await fs.writeFile(join(staging, name), 'new');
  }
  await fs.writeFile(join(output, 'finish/1.png'), 'old');
  await fs.writeFile(join(output, 'unrelated'), 'keep');
  return { staging, output };
}

test('publishes the requested study, preserving unrelated files', async t => {
  const { staging, output } = await fixture(t);
  assert.equal(await publishStudy(staging, output, ['1', '2']), 2);
  assert.equal(await fs.readFile(join(output, 'comparison.png'), 'utf8'), 'new');
  assert.equal(await fs.readFile(join(output, 'finish/1.png'), 'utf8'), 'new');
  assert.equal(await fs.readFile(join(output, 'unrelated'), 'utf8'), 'keep');
});

test('a conflicting comparison destination leaves all frames untouched', async t => {
  const { staging, output } = await fixture(t);
  await fs.mkdir(join(output, 'comparison.png'));
  await assert.rejects(publishStudy(staging, output, ['1', '2']), /regular destination/);
  assert.equal(await fs.readFile(join(output, 'finish/1.png'), 'utf8'), 'old');
  await assert.rejects(fs.stat(join(output, 'finish/2.png')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(output, '.egg-publish')), { code: 'ENOENT' });
});

test('rollback restores overwritten files and removes new files following a late rename failure', async t => {
  const { staging, output } = await fixture(t);
  const rename = fs.rename;
  const replacement = t.mock.method(fs, 'rename', async (source, target) => {
    if (source === join(staging, 'comparison.png')) await fs.unlink(source);
    return rename(source, target);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publishStudy(staging, output, ['1', '2']), { code: 'ENOENT' });
    assert.equal(await fs.readFile(join(output, 'finish/1.png'), 'utf8'), 'old');
    await assert.rejects(fs.stat(join(output, 'finish/2.png')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(join(output, '.egg-publish')), { code: 'ENOENT' });
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});
