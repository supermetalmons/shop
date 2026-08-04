import { spawn, spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

export async function startSolanaSignerPipe(pipePath: string, secretKey: Uint8Array) {
  const mkfifo = spawnSync('mkfifo', ['-m', '600', pipePath], { encoding: 'utf8' });
  if (mkfifo.status !== 0) {
    throw new Error(`Failed to create private signer pipe: ${mkfifo.stderr.trim()}`);
  }
  chmodSync(pipePath, 0o600);
  const serverSource = [
    "const fs = require('node:fs');",
    'const pipePath = process.argv[1];',
    "let key = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { key += chunk; });",
    "process.stdin.on('end', () => {",
    '  const serve = () => {',
    '    const stream = fs.createWriteStream(pipePath);',
    "    stream.on('open', () => stream.end(key));",
    "    stream.on('close', () => setTimeout(serve, 50));",
    "    stream.on('error', (error) => { if (error.code !== 'ENOENT') process.exit(2); });",
    '  };',
    '  serve();',
    '});',
  ].join('');
  const server = spawn(process.execPath, ['-e', serverSource, pipePath], {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  let signerJson = `${JSON.stringify(Array.from(secretKey))}\n`;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.stdin.once('error', reject);
      server.stdin.end(signerJson, resolve);
    });
  } catch (error) {
    server.kill('SIGTERM');
    throw error;
  } finally {
    signerJson = '';
  }
  return server;
}
