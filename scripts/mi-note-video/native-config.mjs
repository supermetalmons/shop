import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export const engineDirectory = dirname(fileURLToPath(import.meta.url));
export const sourceRoot = resolve(engineDirectory, '../..');
export const contract = JSON.parse(readFileSync(join(engineDirectory, 'contract.json'), 'utf8'));
export const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export const nativeSourceFiles = Object.freeze([
  'cli.mjs', 'native-runtime.mjs', 'native-config.mjs', 'native-render.mjs', 'native-processing.mjs',
  'frame-worker.mjs', 'native_processing_worker.py', 'processing_worker.py', 'frame_worker.py',
  'frames.py', 'quality.py', 'video_validation.py', 'native-webview.swift', 'build-native-webview.sh',
  'harness.tsx', 'index.html', 'capture.css', 'captureGeometry.ts', 'motion.ts', 'preset.json',
  'contract.json', 'package.json', 'package-lock.json', 'requirements.txt',
]);

export function catalogCount() {
  const source = readFileSync(join(sourceRoot, 'src/lib/miNoteCards.ts'), 'utf8');
  const count = Number(source.match(/\bMI_NOTE_CARD_COUNT\s*=\s*(\d+)\s*;/)?.[1]);
  requireValue(Number.isSafeInteger(count) && count > 0, 'The pinned source catalog count is unavailable.');
  return count;
}

export function assertNativeHost(system = {}) {
  requireValue((system.platform ?? process.platform) === 'darwin', 'Native rendering requires macOS.');
  const model = system.model ?? execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim();
  requireValue(typeof model === 'string' && model.trim().length > 0, 'Native rendering could not identify the Mac hardware.');
  requireValue(!model.trim().startsWith('VirtualMac'), 'Native rendering requires physical Mac hardware.');
  return model.trim();
}

export function renderingSourceHashes(root = sourceRoot, entries = nativeSourceFiles) {
  root = resolve(root);
  const files = new Set();
  const queue = entries.map(name => join(root, 'scripts/mi-note-video', name));
  while (queue.length) {
    const path = resolve(queue.pop());
    const name = relative(root, path);
    requireValue(name && !isAbsolute(name) && !name.split(/[\\/]/).includes('..'), `Rendering dependency escapes source root: ${path}`);
    if (files.has(path)) continue;
    requireValue(existsSync(path) && lstatSync(path).isFile() && realpathSync(path) === path, `Missing regular rendering dependency: ${name}`);
    files.add(path);
    if (!['.mjs', '.ts', '.tsx', '.js'].includes(extname(path))) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]);
      const found = [base, ...['.ts', '.tsx', '.mjs', '.js', '.json', '.css'].map(suffix => base + suffix)].find(existsSync);
      requireValue(found, `Missing local rendering dependency: ${match[1]}`);
      queue.push(found);
    }
  }
  return Object.fromEntries([...files].map(path => [relative(root, path), hashFile(path)]).sort(([a], [b]) => a.localeCompare(b)));
}

export function assertSourceHashes(hashes, root = sourceRoot) {
  const current = renderingSourceHashes(root);
  requireValue(JSON.stringify(current) === JSON.stringify(hashes), 'Rendering source inventory or content changed.');
}

export function assertResumeIdentity(manifest, identity) {
  requireValue(manifest?.version === 2, 'Native resume requires a version 2 run; preserved version 1 review evidence remains unchanged.');
  for (const [key, value] of Object.entries(identity)) {
    requireValue(JSON.stringify(manifest[key]) === JSON.stringify(value), `Native resume ${key} differs.`);
  }
  requireValue(manifest.cards && typeof manifest.cards === 'object' && !Array.isArray(manifest.cards), 'Native resume card records are missing.');
  requireValue(Number.isSafeInteger(manifest.pid) && manifest.pid > 0, 'Native resume process identity is invalid.');
}

export function verifyCompletedCard(output, card, summary) {
  const evidenceDirectory = join(output, 'evidence', String(card));
  const videoPath = join(output, `${card}.mp4`);
  requireValue(summary?.status === 'complete' && summary.id === card && summary.evidenceDirectory === evidenceDirectory
    && summary.frameCount === 276 && summary.qualityPassed === true && summary.fullyDecoded === true
    && summary.video?.path === videoPath && /^[a-f0-9]{64}$/.test(summary.video.sha256), `Completed native card ${card} has an invalid summary binding.`);
  const detailPath = join(evidenceDirectory, 'card.json');
  for (const path of [detailPath, videoPath]) requireValue(existsSync(path) && lstatSync(path).isFile() && realpathSync(path) === path, `Completed native card ${card} is missing its canonical regular output.`);
  const detail = JSON.parse(readFileSync(detailPath, 'utf8'));
  requireValue(detail.id === card && detail.status === 'complete' && detail.evidenceDirectory === evidenceDirectory
    && detail.video?.path === videoPath && detail.video.sha256 === summary.video.sha256
    && Array.isArray(detail.frames) && detail.frames.length === 276
    && detail.frames.every((frame, index) => frame.frame === index && frame.pose?.cardId === card && frame.pose.frame === index)
    && detail.result?.qualityReport?.passed === true && detail.result?.video?.fullyDecoded === true,
  `Completed native card ${card} has an invalid detail binding.`);
  requireValue(hashFile(videoPath) === summary.video.sha256, `Completed native card ${card} video checksum differs.`);
  return detail;
}

export function viteOptions(port) {
  return { root: sourceRoot, configFile: false, envDir: false, envPrefix: [], plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] } };
}
