import type { KnipConfig } from 'knip';
import { readdirSync } from 'node:fs';

const newDropEntries = readdirSync(new URL('./scripts/newDrops/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.startsWith('.'))
  .map((entry) => `scripts/newDrops/${entry.name}`);

const config = {
  compilers: {
    json: () => 'export default null;',
  },
  ignoreIssues: {
    'src/lib/miNotePackRenderSetup.ts': ['exports', 'types'],
  },
  workspaces: {
    '.': {
      entry: [
        'src/renderer/main.tsx!',
        'src/static-render/clearCards.tsx!',
        'scripts/mi-note-renderer/harness.tsx',
        'scripts/mi-note-renderer/tests/*.test.mjs',
        'src/lib/miNotePackRenderSetup.ts!',
        'cloud/workers/api/src/index.ts!',
        'cloud/workers/api/test/*.test.ts',
        'cloud/workers/api/runtime-test/*.test.ts',
        'cloud/workers/frontend/test/*.test.ts',
        ...newDropEntries,
        'scripts/newPreorderCollections/*.ts',
        'tests/api/*.test.ts',
        'tests/*.test.ts',
      ],
      project: [
        'src/**/*.{ts,tsx}!',
        'cloud/workers/api/src/**/*.ts!',
        'cloud/workers/frontend/src/**/*.ts!',
        'shared/**/*.ts!',
        'shared/**/*.json!',
        'cloud/workers/api/test/**/*.ts',
        'cloud/workers/api/runtime-test/**/*.ts',
        'cloud/workers/frontend/test/**/*.ts',
        'scripts/**/*.{ts,mjs}',
        'scripts/mi-note-renderer/*.tsx',
        'tests/**/*.ts',
      ],
      ignoreDependencies: ['buffer', 'cloudflare'],
      ignoreBinaries: ['anchor', 'mkfifo', 'solana'],
      ignoreExportsUsedInFile: { type: true },
    },
  },
} satisfies KnipConfig;

export default config;
