import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentMatches, nativeEnvironment, runtimePaths, verifyPinnedNode } from './native-runtime.mjs';
import { defaultOutputDirectory } from './native-output.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const help = `Mi Note native video renderer

  run --ids 17|1-46|1,4-6 [--output /absolute/video-directory] [--retain-all] [--background]
  resume --ids SAME_SELECTION [--output /absolute/video-directory] [--retain-all] [--background]
  doctor [--background]
  help

Uses the preserved native app and runtime, Display P3, 2160 pixels, 276 frames,
60 fps, and breathing-swing. Doctor verifies the runtime without rendering.
Use --background to capture offscreen without activating the application.
Videos default to ~/Movies/Mi Note Native Renders; new cards join the same directory.
Run state stays in Application Support. Successful runs discard intermediate images by default.
Resume requires the same run identity.
`;

export function parseArguments(argv, maximum = 1430) {
  if (!argv.length || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) return { command: 'help' };
  const [command, ...args] = argv;
  if (!['run', 'resume', 'doctor'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options = command === 'doctor' ? { command, background: false }
    : { command, resume: command === 'resume', output: defaultOutputDirectory(), 'retain-all': false, background: false };
  const allowed = command === 'doctor' ? ['--background'] : ['--ids', '--output', '--retain-all', '--background'];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--retain-all' || flag === '--background') { options[flag.slice(2)] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (command === 'doctor') return options;
  if (!options.ids) throw new Error('--ids is required.');
  if (!isAbsolute(options.output)) throw new Error('--output must be an absolute directory.');
  options.output = resolve(options.output);
  options.cardIds = options.ids.split(',').flatMap(part => {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error('Expected comma-separated card IDs or inclusive ranges.');
    const [start, end = start] = part.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > maximum || end < start) throw new Error(`Card IDs must be between 1 and ${maximum}.`);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
  if (new Set(options.cardIds).size !== options.cardIds.length) throw new Error('Duplicate card ID.');
  return options;
}

export async function execute(command, args, env) {
  const child = spawn(command, args, { stdio: 'inherit', env, detached: true });
  const forward = signal => { if (!child.killed) child.kill(signal); };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143))); });
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === 'help') { process.stdout.write(help); return 0; }
  const paths = runtimePaths();
  verifyPinnedNode(paths);
  const env = nativeEnvironment(paths);
  if (realpathSync(process.execPath) !== realpathSync(paths.node) || !environmentMatches(process.env, env)) return execute(paths.node, [fileURLToPath(import.meta.url), ...argv], env);
  if (options.command === 'doctor') {
    const [{ assertNativeHost, renderingSourceHashes }, { verifyNativeEnvironment }] = await Promise.all([import('./native-config.mjs'), import('./native-runtime.mjs')]);
    const model = assertNativeHost();
    const environment = verifyNativeEnvironment(paths);
    const sourceHashes = renderingSourceHashes();
    process.stdout.write(JSON.stringify({ passed: true, model, presentation: options.background ? 'offscreen' : 'foreground', ...environment, sourceHashes }, null, 2) + '\n');
    return 0;
  }
  return execute(paths.node, [join(directory, 'native-render.mjs'), ...argv], env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
