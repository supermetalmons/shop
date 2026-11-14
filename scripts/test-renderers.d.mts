import type { ValidationCommand } from './check-all.mjs';

export function runRendererChecks(tier?: string, options?: {
  root?: string;
  run?: ValidationCommand;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<void>;
