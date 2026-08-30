import type { KnipConfig } from 'knip';

const config = {
  compilers: {
    json: () => 'export default null;',
  },
  workspaces: {
    '.': {
      entry: [
        'src/renderer/main.tsx!',
        'src/static-render/clearCards.tsx!',
        'cloud/workers/api/src/index.ts!',
        'cloud/workers/api/test/*.test.ts',
        'cloud/workers/api/runtime-test/*.test.ts',
        'cloud/workers/frontend/test/*.test.ts',
        'scripts/*.{ts,mjs}',
        'scripts/newDrops/*.ts',
        'scripts/ops/*.ts',
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
        'tests/**/*.ts',
      ],
      ignoreDependencies: ['buffer', 'cloudflare'],
      ignoreBinaries: ['anchor', 'mkfifo', 'solana'],
      ignoreExportsUsedInFile: { type: true },
    },
  },
} satisfies KnipConfig;

export default config;
