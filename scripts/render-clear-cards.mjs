import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const defaults = {
  from: 1,
  longestEdge: 1400,
  mode: 'light',
  open: true,
  receiverPort: 5175,
  supersample: 4,
  timeoutMinutes: 60,
  to: 192,
  vitePort: 5174,
};

function usage() {
  return `Usage: npm run render:clear-cards -- [options]

Options:
  --mode light|dark       Composite target (default: light)
  --output <directory>    Output directory (default: renders-<mode>-<N>x)
  --supersample <N>       Source resolution multiplier (default: 4)
  --longest-edge <px>     Final longest edge (default: 1400)
  --from <card>           First card id (default: 1)
  --to <card>             Last card id (default: 192)
  --vite-port <port>      Static renderer port (default: 5174)
  --receiver-port <port>  PNG receiver port (default: 5175)
  --timeout <minutes>     Batch timeout (default: 60)
  --no-open               Print the URL without opening a browser
  --help                  Show this help`;
}

function integerOption(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseOptions(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--no-open') {
      options.open = false;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === '--mode') options.mode = value;
    else if (argument === '--output') options.output = value;
    else if (argument === '--supersample') options.supersample = integerOption(argument, value);
    else if (argument === '--longest-edge') options.longestEdge = integerOption(argument, value);
    else if (argument === '--from') options.from = integerOption(argument, value);
    else if (argument === '--to') options.to = integerOption(argument, value);
    else if (argument === '--vite-port') options.vitePort = integerOption(argument, value);
    else if (argument === '--receiver-port') options.receiverPort = integerOption(argument, value);
    else if (argument === '--timeout') options.timeoutMinutes = integerOption(argument, value);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.mode !== 'light' && options.mode !== 'dark') {
    throw new Error('--mode must be light or dark.');
  }
  if (options.from > options.to || options.to > 192) {
    throw new Error('Card range must satisfy 1 <= from <= to <= 192.');
  }
  options.output ??= `renders-${options.mode}-${options.supersample}x`;
  return options;
}

function runMagick(magick, inputPath, outputPath, width, height, mode) {
  const arguments_ = [
    inputPath,
    '-alpha', 'on',
    '-channel', 'RGB',
    '-fx', 'u*u.a',
    '+channel',
    '-filter', 'Box',
    '-resize', `${width}x${height}!`,
    '-channel', 'RGB',
    '-fx', 'u.a>0.0039215686?u/u.a:0',
    '+channel',
  ];
  if (mode === 'dark') {
    arguments_.push(
      '-channel', 'A',
      '-fx', 'max(u.a,0.75*pow(max(u.r,max(u.g,u.b)),6)*min(1,u.a/0.3))',
      '+channel',
    );
  }
  arguments_.push(outputPath);
  const result = spawnSync(magick, arguments_, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ImageMagick failed.');
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const arguments_ = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, arguments_, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitForUrl(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Vite did not become ready at ${url}.`);
}

function readRequest(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = process.cwd();
  const outputDirectory = resolve(root, options.output);
  if (existsSync(outputDirectory)) throw new Error(`Output already exists: ${outputDirectory}`);
  mkdirSync(outputDirectory);
  const workDirectory = mkdtempSync(join(tmpdir(), 'mons-clear-card-render-'));
  const magick = process.env.CLEAR_CARD_MAGICK_BIN ?? 'magick';
  const magickCheck = spawnSync(magick, ['-version'], { encoding: 'utf8' });
  if (magickCheck.status !== 0) throw new Error('ImageMagick is required and was not found.');

  const expectedCount = options.to - options.from + 1;
  const completed = new Set();
  let finishBatch;
  let failBatch;
  const batch = new Promise((resolveBatch, rejectBatch) => {
    finishBatch = resolveBatch;
    failBatch = rejectBatch;
  });
  const receiver = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Output-Height, X-Output-Width');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url, `http://127.0.0.1:${options.receiverPort}`);
    try {
      if (request.method === 'POST' && url.pathname === '/error') {
        throw new Error((await readRequest(request)).toString('utf8') || 'Renderer page failed.');
      }
      if (request.method === 'POST' && url.pathname === '/complete') {
        if (completed.size !== expectedCount) {
          throw new Error(`Renderer completed with ${completed.size} of ${expectedCount} cards.`);
        }
        response.writeHead(200).end('ok');
        finishBatch();
        return;
      }
      const filename = basename(url.searchParams.get('filename') ?? '');
      const cardId = Number(filename.replace(/\.png$/, ''));
      const width = integerOption('X-Output-Width', request.headers['x-output-width']);
      const height = integerOption('X-Output-Height', request.headers['x-output-height']);
      if (
        request.method !== 'POST' ||
        url.pathname !== '/upload' ||
        !/^\d+\.png$/.test(filename) ||
        cardId < options.from ||
        cardId > options.to ||
        Math.max(width, height) !== options.longestEdge
      ) {
        response.writeHead(400).end();
        return;
      }
      const workPath = join(workDirectory, filename);
      writeFileSync(workPath, await readRequest(request));
      runMagick(magick, workPath, join(outputDirectory, filename), width, height, options.mode);
      completed.add(cardId);
      response.writeHead(200).end('ok');
      console.log(`[${completed.size}/${expectedCount}] ${filename}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      response.writeHead(500).end(error.message);
      failBatch(error);
    }
  });

  const viteEntry = resolve(root, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteEntry)) throw new Error('Vite is not installed. Run npm install first.');
  const vite = spawn(
    process.execPath,
    [viteEntry, '--host', '127.0.0.1', '--port', String(options.vitePort)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let viteError = '';
  vite.stderr.on('data', (chunk) => {
    viteError += chunk.toString();
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      receiver.once('error', rejectListen);
      receiver.listen(options.receiverPort, '127.0.0.1', resolveListen);
    });
    const pageUrl = `http://127.0.0.1:${options.vitePort}/clear-card-renderer.html`;
    await waitForUrl(pageUrl);
    const query = new URLSearchParams({
      from: String(options.from),
      mode: options.mode,
      receiver: `http://127.0.0.1:${options.receiverPort}`,
      source: String(options.longestEdge * options.supersample),
      target: String(options.longestEdge),
      to: String(options.to),
    });
    const rendererUrl = `${pageUrl}?${query}`;
    console.log(`Renderer: ${rendererUrl}`);
    console.log(`Output: ${outputDirectory}`);
    if (options.open) openBrowser(rendererUrl);
    let timeoutId;
    const timeout = new Promise((_, rejectTimeout) => {
      timeoutId = setTimeout(
        () => rejectTimeout(new Error(`Render timed out after ${options.timeoutMinutes} minutes.`)),
        options.timeoutMinutes * 60_000,
      );
    });
    try {
      await Promise.race([batch, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
    console.log(`Rendered ${completed.size} cards to ${outputDirectory}`);
  } finally {
    vite.kill('SIGTERM');
    await new Promise((resolveClose) => receiver.close(resolveClose));
    rmSync(workDirectory, { force: true, recursive: true });
    if (vite.exitCode && viteError) console.error(viteError.trim());
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
