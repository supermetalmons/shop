import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ToolEnv = Record<string, string | undefined>;

export type CommandOptions = {
  cwd?: string;
  env?: ToolEnv;
  stdin?: string;
  sensitiveRpcUrl?: string;
  cancellation?: CommandCancellationController;
  allowAfterCancellation?: boolean;
};

export type UpgradeSignal = 'SIGINT' | 'SIGTERM';

export class CommandCancelledError extends Error {
  readonly signal: UpgradeSignal;
  readonly exitCode: number;

  constructor(signal: UpgradeSignal, message = `Upgrade interrupted by ${signal}`) {
    super(message);
    this.name = 'CommandCancelledError';
    this.signal = signal;
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

export class CommandCancellationController {
  private requestedSignal?: UpgradeSignal;
  private activeChild?: ChildProcess;
  private activeAllowsRecovery = false;
  private killTimer?: NodeJS.Timeout;

  get signal(): UpgradeSignal | undefined {
    return this.requestedSignal;
  }

  get hasActiveChild(): boolean {
    return Boolean(this.activeChild);
  }

  request(signal: UpgradeSignal): void {
    const repeated = Boolean(this.requestedSignal);
    if (!this.requestedSignal) this.requestedSignal = signal;
    if (!this.activeChild) return;
    if (repeated) {
      this.signalChild(this.activeChild, 'SIGKILL');
      return;
    }
    if (this.activeAllowsRecovery) return;
    this.terminateActiveChild(signal);
  }

  throwIfCancelled(allowAfterCancellation = false): void {
    if (this.requestedSignal && !allowAfterCancellation) {
      throw new CommandCancelledError(this.requestedSignal);
    }
  }

  attach(child: ChildProcess, allowAfterCancellation = false): void {
    this.activeChild = child;
    this.activeAllowsRecovery = allowAfterCancellation;
    if (this.requestedSignal && !allowAfterCancellation) {
      this.terminateActiveChild(this.requestedSignal);
    }
  }

  detach(child: ChildProcess): void {
    if (this.activeChild !== child) return;
    this.activeChild = undefined;
    this.activeAllowsRecovery = false;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    try {
      child.kill(signal);
    } catch {}
  }

  private terminateActiveChild(signal: UpgradeSignal): void {
    const child = this.activeChild;
    if (!child) return;
    this.signalChild(child, signal);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.activeChild === child) this.signalChild(child, 'SIGKILL');
    }, 5_000);
    this.killTimer.unref();
  }
}

export function shouldDeferUpgradeSignalExit(args: {
  childActive: boolean;
  deployVerificationPending: boolean;
  promptPending: boolean;
  repeatedSignal: boolean;
}): boolean {
  if (args.childActive) return true;
  if (args.repeatedSignal) return false;
  return args.deployVerificationPending || args.promptPending;
}

export function validateRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid --rpc-url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid --rpc-url protocol; expected http or https');
  }
  if (parsed.hash) {
    throw new Error('Invalid --rpc-url; fragments are not allowed');
  }
  return parsed.toString();
}

export function redactRpcUrl(value: string): string {
  void value;
  return '<custom-rpc-url-redacted>';
}

export function redactRpcDetailsInText(value: string, rpcUrl: string): string {
  let redacted = value.split(rpcUrl).join(redactRpcUrl(rpcUrl));
  try {
    const parsed = new URL(rpcUrl);
    const broadParts = [
      parsed.href,
      parsed.origin,
      parsed.host,
      parsed.hostname,
      parsed.search,
    ];
    const secretParts = [
      parsed.username,
      parsed.password,
      parsed.pathname === '/' ? '' : parsed.pathname,
      ...parsed.searchParams.values(),
    ];
    const sensitive = new Set<string>();
    const shortSensitive = new Set<string>();
    const addVariants = (part: string, allowShort: boolean) => {
      if (!part) return;
      sensitive.add(part);
      if (allowShort) shortSensitive.add(part);
      try {
        const decoded = decodeURIComponent(part);
        sensitive.add(decoded);
        if (allowShort) shortSensitive.add(decoded);
      } catch {}
    };
    for (const part of broadParts) addVariants(part, false);
    for (const part of secretParts) addVariants(part, true);
    for (const part of [...sensitive]
      .filter(
        (candidate) =>
          candidate.length >= 3 || shortSensitive.has(candidate),
      )
      .sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(part).join('<redacted>');
    }
  } catch {}
  return redacted;
}

export function buildProgramShowArgs(args: {
  programId: string;
  solanaConfigPath: string;
}): string[] {
  return [
    'program',
    'show',
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    '-',
    '--output',
    'json',
    '--commitment',
    'finalized',
  ];
}

export function buildProgramDumpArgs(args: {
  programId: string;
  dumpPath: string;
  solanaConfigPath: string;
}): string[] {
  return [
    'program',
    'dump',
    args.programId,
    args.dumpPath,
    '--config',
    args.solanaConfigPath,
    '--commitment',
    'finalized',
  ];
}

export function buildProgramDeployArgs(args: {
  programBinaryPath: string;
  programId: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
  useRpc?: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
}): string[] {
  const deployArgs = [
    'program',
    'deploy',
    args.programBinaryPath,
    '--program-id',
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--upgrade-authority',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
    '--no-auto-extend',
  ];
  if (args.useRpc) deployArgs.push('--use-rpc');
  if (args.computeUnitPrice) {
    deployArgs.push('--with-compute-unit-price', args.computeUnitPrice);
  }
  if (args.maxSignAttempts) {
    deployArgs.push('--max-sign-attempts', args.maxSignAttempts);
  }
  return deployArgs;
}

export function buildProgramWriteBufferArgs(args: {
  programBinaryPath: string;
  bufferSignerPath: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
  useRpc?: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
}): string[] {
  const writeArgs = [
    'program',
    'write-buffer',
    args.programBinaryPath,
    '--buffer',
    args.bufferSignerPath,
    '--buffer-authority',
    args.authorityKeypairPath,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
  ];
  if (args.useRpc) writeArgs.push('--use-rpc');
  if (args.computeUnitPrice) {
    writeArgs.push('--with-compute-unit-price', args.computeUnitPrice);
  }
  if (args.maxSignAttempts) {
    writeArgs.push('--max-sign-attempts', args.maxSignAttempts);
  }
  return writeArgs;
}

export function buildProgramUpgradeArgs(args: {
  bufferPubkey: string;
  programId: string;
  solanaConfigPath: string;
  authorityKeypairPath: string;
}): string[] {
  return [
    'program',
    'upgrade',
    args.bufferPubkey,
    args.programId,
    '--config',
    args.solanaConfigPath,
    '--keypair',
    args.authorityKeypairPath,
    '--upgrade-authority',
    args.authorityKeypairPath,
    '--commitment',
    'finalized',
  ];
}

function commandEnv(env: ToolEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NO_DNA: '1', ...env };
}

function displayedCommand(cmd: string, args: string[]): string {
  const displayed = [...args];
  const urlIndex = displayed.indexOf('--url');
  if (urlIndex >= 0 && displayed[urlIndex + 1]) {
    displayed[urlIndex + 1] = redactRpcUrl(displayed[urlIndex + 1]);
  }
  return `${cmd} ${displayed.join(' ')}`;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

async function executeCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions,
  captureOutput: boolean,
): Promise<CommandResult> {
  const urlIndex = args.indexOf('--url');
  const rpcUrl =
    opts.sensitiveRpcUrl || (urlIndex >= 0 ? args[urlIndex + 1] : undefined);
  const shouldBuffer = captureOutput || Boolean(rpcUrl);
  opts.cancellation?.throwIfCancelled(opts.allowAfterCancellation);
  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    env: commandEnv(opts.env),
    detached: process.platform !== 'win32',
    stdio: [
      opts.stdin === undefined
        ? captureOutput
          ? 'ignore'
          : 'inherit'
        : 'pipe',
      shouldBuffer ? 'pipe' : 'inherit',
      shouldBuffer ? 'pipe' : 'inherit',
    ],
  };
  const child = spawn(cmd, args, spawnOptions);
  opts.cancellation?.attach(child, opts.allowAfterCancellation);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout.push(Buffer.from(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.push(Buffer.from(chunk));
  });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  let spawnError: Error | undefined;
  const result = await new Promise<CommandResult>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      });
    });
  }).finally(() => {
    opts.cancellation?.detach(child);
  });
  if (!captureOutput && shouldBuffer) {
    const safeStdout = rpcUrl
      ? redactRpcDetailsInText(result.stdout, rpcUrl)
      : result.stdout;
    const safeStderr = rpcUrl
      ? redactRpcDetailsInText(result.stderr, rpcUrl)
      : result.stderr;
    if (safeStdout) process.stdout.write(safeStdout);
    if (safeStderr) process.stderr.write(safeStderr);
  }
  if (opts.cancellation?.signal && !opts.allowAfterCancellation) {
    throw new CommandCancelledError(opts.cancellation.signal);
  }
  if (spawnError) {
    throw new Error(
      `Command failed to start: ${displayedCommand(cmd, args)}\n${spawnError.message}`,
    );
  }
  if (result.code !== 0) {
    const safeStderr = rpcUrl
      ? redactRpcDetailsInText(result.stderr.trim(), rpcUrl)
      : result.stderr.trim();
    throw new Error(
      `Command failed: ${displayedCommand(cmd, args)}` +
        `${result.signal ? ` (signal ${result.signal})` : ''}` +
        `${safeStderr ? `\n${safeStderr}` : ''}`,
    );
  }
  return result;
}

export async function runUpgradeCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions = {},
): Promise<void> {
  await executeCommand(cmd, args, opts, false);
}

export async function runCapture(
  cmd: string,
  args: string[],
  opts: CommandOptions = {},
): Promise<string> {
  return (await executeCommand(cmd, args, opts, true)).stdout;
}
