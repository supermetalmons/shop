import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createServer, normalizePath, resolveConfig } from 'vite';
import { normalizeMonsApiOrigin } from '../src/lib/monsApiOrigin.ts';
import { createViteConfig, rewriteDependencyPublicRpcFallbacks } from '../vite.config.ts';

test('private operator files are denied alongside Vite default sensitive files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mons-vite-private-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const config = createViteConfig('test', root);
  const defaults = await resolveConfig({ configFile: false, envDir: false, logLevel: 'silent' }, 'serve', 'test');
  for (const pattern of defaults.server.fs.deny) assert.ok(config.server?.fs?.deny?.includes(pattern));
  assert.ok(config.server?.fs?.deny?.includes('**/.operations/**'));
  const privateContent = 'synthetic-private-operator-data';
  const privateFiles = ['.operations/private/nfc.csv', '.env', '.env.local', 'private.pem', '.npmrc', '.yarnrc.yml', '.git/config'];
  for (const name of privateFiles) {
    const filename = join(root, name);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, privateContent);
  }
  await writeFile(join(root, 'ordinary.txt'), 'ordinary public file');
  server = await createServer({
    ...config, root, publicDir: false, configFile: false, envDir: false,
    cacheDir: join(root, 'vite-cache'), logLevel: 'silent', appType: 'custom',
    server: { ...config.server, host: '127.0.0.1', port: 0, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal(await (await fetch(`${origin}/ordinary.txt`)).text(), 'ordinary public file');
  for (const name of privateFiles) {
    for (const pathname of [`/${name}`, `/@fs/${normalizePath(join(root, name))}`]) {
      for (const query of ['', '?raw']) {
        const response = await fetch(origin + pathname + query);
        assert.equal(response.status, 403, pathname + query);
        assert.ok(!(await response.text()).includes(privateContent));
      }
    }
  }
});

test('the NFC document head saves the scan and scrubs its URL before the app loads', async t => {
  const server = await createServer({
    ...createViteConfig('test'), configFile: false, cacheDir: '.cache/vite-tests', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  });
  t.after(() => server.close());
  const template = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const html = await server.transformIndexHtml('/nfc', template);
  const code = '00000000-0000-4000-8000-000000000001';
  const { window } = new JSDOM(html.split('</head>')[0], {
    url: `https://shop.example/nfc?code=${code}&tokenId=10&testnet=true#card`, runScripts: 'dangerously',
  });
  t.after(() => window.close());
  assert.equal(window.location.href, 'https://shop.example/nfc?tokenId=10&testnet=true#card');
  assert.equal(window.localStorage.getItem('mons.shop.tarot.claim:sepolia:10'), code);
});

test('dependency RPC fallbacks use the same configured mons API origin', () => {
  const apiOrigin = normalizeMonsApiOrigin('https://candidate-api.example/');
  assert.equal(normalizeMonsApiOrigin(undefined), 'https://api.mons.shop');
  const source = [
    'https://api.mainnet-beta.solana.com/',
    'http://api.mainnet-beta.solana.com',
    'https://api.devnet.solana.com/',
    'http://api.devnet.solana.com',
  ].join(' ');
  const transformed = rewriteDependencyPublicRpcFallbacks(source, '/repo/node_modules/solana/index.js', apiOrigin);

  assert.equal(
    transformed,
    [
      'https://candidate-api.example/rpc/mainnet-beta',
      'https://candidate-api.example/rpc/mainnet-beta',
      'https://candidate-api.example/rpc/devnet',
      'https://candidate-api.example/rpc/devnet',
    ].join(' '),
  );
});

test('dependency RPC fallback rewriting never invents an unsupported testnet route', () => {
  const source = 'https://api.testnet.solana.com http://api.testnet.solana.com/';
  assert.equal(
    rewriteDependencyPublicRpcFallbacks(source, '/repo/node_modules/solana/index.js', normalizeMonsApiOrigin(undefined)),
    undefined,
  );
});

test('dependency RPC fallback rewriting does not touch application source', () => {
  const source = 'https://api.mainnet-beta.solana.com/';
  assert.equal(rewriteDependencyPublicRpcFallbacks(source, '/repo/src/app.ts', normalizeMonsApiOrigin(undefined)), undefined);
});
