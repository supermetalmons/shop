import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertJobRuntime } from '../guest-runner.mjs';
import { runtimeVersions } from '../native-config.mjs';

test('guest runtime checks use configured media binaries despite competing PATH entries', context => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mi-note-runtime-'));
  const previous = { PATH: process.env.PATH, MI_NOTE_FFMPEG: process.env.MI_NOTE_FFMPEG, MI_NOTE_FFPROBE: process.env.MI_NOTE_FFPROBE };
  const exec = childProcess.execFileSync;
  const read = fs.readFileSync;
  const python = join(root, 'python');
  fs.writeFileSync(python, 'fixture python');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const configured = join(root, `${name}-pinned`);
    fs.writeFileSync(configured, `#!/bin/sh\nprintf '${name} version 8.1.2 configured\\n'\n`, { mode: 0o700 });
    fs.writeFileSync(join(root, name), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    process.env[`MI_NOTE_${name.toUpperCase()}`] = configured;
  }
  process.env.PATH = root;
  const commands = context.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === python) return JSON.stringify({ python: '3.12.14', pillow: '12.3.0', numpy: '2.3.5', littlecms: '2.19' });
    if (command === '/usr/bin/safaridriver') return 'fixture Safari';
    if (command === '/usr/bin/sw_vers') return 'fixture macOS';
    return exec(command, args, options);
  });
  const files = context.mock.method(fs, 'readFileSync', (path, ...args) => String(path).startsWith('/System/Library/ColorSync/Profiles/')
    ? Buffer.from('fixture ICC') : read(path, ...args));
  syncBuiltinESMExports();
  try {
    const versions = runtimeVersions(python);
    assert.equal(versions.ffmpeg, 'ffmpeg version 8.1.2 configured');
    assert.equal(versions.ffprobe, 'ffprobe version 8.1.2 configured');
    assert.throws(() => assertJobRuntime({ python, runtime: {} }), /Incomplete pinned runtime identity/);
  } finally {
    commands.mock.restore();
    files.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
