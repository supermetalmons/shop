import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publishStudy } from './publish.mjs';
import { prepareEggSources } from './sources.mjs';
import sampleHashes from './samples.json' with { type: 'json' };

const scripts = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(scripts, '../..');
const sourceDir = join(root, '.cache/egg-render/sources/cdn-lil-111k');

async function main() {
  const { values } = parseArgs({ options: {
    ids: { type: 'string', default: Object.keys(sampleHashes).join(',') },
    output: { type: 'string', default: join(root, 'output/eggs') },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: npm run render:eggs -- [--ids 1,29,127,277,466] [--output output/eggs]\n'
      + 'Render four finishes per egg and a labeled comparison sheet. Matching output files are replaced.');
    return;
  }

  const ids = values.ids.split(',').map(value => {
    const id = value.trim();
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error(`Invalid egg ID: ${value}`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate egg IDs.');
  const samples = ids.map(id => ({
    id, path: join(sourceDir, `${id}.webp`), source_url: `https://cdn.lil.org/nft/111k/eggs/${id}.webp`,
  }));
  await prepareEggSources(samples, sampleHashes);

  const output = resolve(values.output);
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, '.egg-study-'));
  const cancelFile = join(staging, 'cancel');
  const controller = new AbortController();
  let child;

  function cancel(signal) {
    if (controller.signal.aborted) return;
    const error = new Error(`Egg render cancelled (${signal}).`);
    error.exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort(error);
    try {
      writeFileSync(cancelFile, signal);
    } catch {
      child?.kill('SIGTERM');
      return;
    }
    child?.kill(signal);
  }

  async function run(command, args) {
    controller.signal.throwIfAborted();
    child = spawn(command, args, { stdio: 'inherit' });
    const [code, signal] = await once(child, 'close');
    child = undefined;
    controller.signal.throwIfAborted();
    if (code !== 0) throw new Error(`${command} exited with ${signal ?? code}`);
  }

  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const blender = process.env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/Blender';
    await run(blender, ['-b', '--quiet', '--factory-startup', '--python-exit-code', '1', '--python',
      join(scripts, 'render.py'), '--', sourceDir, staging, ...ids, '--cancel-file', cancelFile]);
    await run('swift', [join(scripts, 'comparison.swift'), staging, sourceDir, ...ids]);

    const count = await publishStudy(staging, output, ids, controller.signal);
    console.log(`Saved ${count} images and comparison.png in ${output}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
});
