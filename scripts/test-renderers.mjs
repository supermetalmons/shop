import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runValidationCommand } from './check-all.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const suites = {
  portable: [
    'scripts/painting-canvas/render.test.mjs',
    'scripts/egg-render/publish.test.mjs',
    'scripts/egg-render/sources.test.mjs',
    'scripts/painting-canvas/path-safety.test.py',
    'scripts/painting-canvas/lifecycle.test.py',
    'scripts/video-frames/acrylic/test_finalists.py',
    'scripts/video-frames/acrylic/test_frameless.py',
    'scripts/video-frames/acrylic/test_source_lookup.py',
    'scripts/video-frames/acrylic/test_worker.py',
    'scripts/video-frames/knives/test_sources.py',
  ],
  native: [
    'scripts/video-frames/test_media.py',
    'scripts/video-frames/acrylic/test_composite.py',
    'scripts/video-frames/knives/test_renderer.py',
    'scripts/painting-canvas/normalization.test.swift',
    'scripts/egg-render/batch.test.py',
  ],
};

function checkSuiteCoverage(root) {
  const registered = new Set(Object.values(suites).flat());
  const discovered = new Set();
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (/\.test\.(mjs|py|swift)$|^test_.*\.py$/.test(entry.name)) discovered.add(path);
    }
  };
  for (const directory of ['scripts/painting-canvas', 'scripts/egg-render', 'scripts/video-frames']) visit(directory);
  const missing = [...registered].filter(path => !discovered.has(path));
  const unregistered = [...discovered].filter(path => !registered.has(path));
  if (missing.length || unregistered.length) {
    throw new Error(`Renderer suite coverage differs: missing [${missing.join(', ')}]; unregistered [${unregistered.join(', ')}]. Assign every suite to a validation tier.`);
  }
}

export async function runRendererChecks(tier = 'portable', {
  root = projectRoot, run = runValidationCommand, env = process.env, platform = process.platform,
} = {}) {
  if (tier !== 'portable' && tier !== 'native') throw new Error('Renderer tier must be portable or native.');
  checkSuiteCoverage(root);
  if (tier === 'native' && platform !== 'darwin') {
    throw new Error('Native renderer checks require macOS with Swift/Metal, Blender, FFmpeg and the pinned Mi Note runtime. Use test:renderers for portable checks.');
  }
  const python = env.PYTHON || 'python3';
  const blender = env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/Blender';
  const options = label => ({ cwd: root, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, label });
  if (tier === 'native') {
    for (const [command, args] of [[python, ['--version']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']],
      ['swift', ['--version']], [blender, ['--version']]]) {
      await run(command, args, options(`Required native renderer tool: ${command}`));
    }
  }
  const nodeTests = suites[tier].filter(path => path.endsWith('.mjs'));
  if (nodeTests.length) await run(process.execPath, ['--test', ...nodeTests], options('Renderer CLI and publication tests'));
  for (const path of suites[tier].filter(path => !path.endsWith('.mjs'))) {
    if (path.endsWith('.swift')) await run('swift', [path], options('Canvas image normalization'));
    else if (path === 'scripts/egg-render/batch.test.py') {
      await run(blender, ['-b', '--quiet', '--factory-startup', '--python-exit-code', '1', '--python', path], options('Headless egg batch and cancellation tests'));
    } else await run(python, ['-B', 'scripts/shared/runPythonTests.py', path], options(`Renderer tests: ${path}`));
  }
  if (tier === 'native') {
    await run(npm, ['run', 'render:video-frames', '--', '--verify'], options('Approved acrylic preset verification'));
    const output = mkdtempSync(join(tmpdir(), 'mons-canvas-verification-'));
    try {
      await run(npm, ['run', 'render:canvases', '--', '--verify', '--output', output], options('Approved A Light canvas reproduction'));
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
    await run(npm, ['run', 'test:mi-note-videos'], options('Pinned native Mi Note renderer tests'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/test-renderers.mjs [portable|native]');
    await runRendererChecks(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
