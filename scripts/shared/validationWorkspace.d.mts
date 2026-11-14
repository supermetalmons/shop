export function withValidationWorkspace<T>(
  root: string,
  kind: string,
  action: (directory: string) => T | Promise<T>,
): Promise<T>;
