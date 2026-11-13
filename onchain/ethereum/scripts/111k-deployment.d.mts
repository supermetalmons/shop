export function run111kDeployment(argv: string[], overrides?: {
  rpc?: (method: string, params?: unknown[]) => Promise<unknown>;
  configuration?: Record<string, unknown>;
}): Promise<unknown>;
