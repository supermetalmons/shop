import { registerHooks } from 'node:module';

export async function loadCloudflareWorkersModule<T>(load: () => Promise<T>): Promise<T> {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
        };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    return await load();
  } finally {
    hooks.deregister();
  }
}

export function loadApiWorkerIndex(): Promise<typeof import('../src/index.ts')> {
  return loadCloudflareWorkersModule(() => import('../src/index.ts'));
}
