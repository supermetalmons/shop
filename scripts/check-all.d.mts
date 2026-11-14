export type ValidationCommandOptions = {
  cwd: string;
  label: string;
  env?: NodeJS.ProcessEnv;
};

export type ValidationCommand = (
  command: string,
  args: string[],
  options: ValidationCommandOptions,
) => void | Promise<void>;

export function runValidationCommand(command: string, args: string[], options: ValidationCommandOptions): void;
export function runEthereumChecks(root?: string, run?: ValidationCommand): Promise<void>;
export function runSbfChecks(root?: string, run?: ValidationCommand): Promise<void>;
export function runAllChecks(root?: string, run?: ValidationCommand): Promise<void>;
export function runEthereumForkChecks(root?: string, run?: ValidationCommand, rpcUrl?: string): Promise<void>;
