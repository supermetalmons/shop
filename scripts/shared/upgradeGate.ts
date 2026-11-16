import { assertProgramSnapshotUnchanged, type StableProgramSnapshot } from './upgradeProgramSnapshot.ts';
import { assertLineageFingerprintUnchanged, type SharedProgramConfigAudit, type SharedProgramConfigAuditResult } from './upgradeConfigAudit.ts';
import { CommandCancelledError, type CommandCancellationController } from './upgradeCommandRunner.ts';

export type UpgradeGateState = {
  program: StableProgramSnapshot;
  configs: ReadonlyArray<SharedProgramConfigAudit>;
  minContextSlot: number;
};

export async function captureCoherentUpgradeGateState(args: {
  stage: string;
  minContextSlot: number;
  captureProgram: (stage: string) => Promise<StableProgramSnapshot>;
  inspectConfigs: (minContextSlot: number) => Promise<SharedProgramConfigAuditResult>;
}): Promise<UpgradeGateState> {
  const beforeAuditProgram = await args.captureProgram(
    `${args.stage} before config audit`,
  );
  const firstAudit = await args.inspectConfigs(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: args.minContextSlot,
      lastDeploySlot: beforeAuditProgram.show.lastDeploySlot,
    }),
  );
  const afterAuditProgram = await args.captureProgram(
    `${args.stage} after config audit`,
  );
  assertProgramSnapshotUnchanged(
    beforeAuditProgram,
    afterAuditProgram,
    `during ${args.stage}`,
  );
  const finalAudit = await args.inspectConfigs(
    postUpgradeConfigMinContextSlot({
      previousAuditSlot: firstAudit.slot,
      lastDeploySlot: afterAuditProgram.show.lastDeploySlot,
    }),
  );
  assertLineageFingerprintUnchanged(
    firstAudit.configs,
    finalAudit.configs,
    `during ${args.stage}`,
  );
  const finalProgram = await args.captureProgram(
    `${args.stage} after final config audit`,
  );
  assertProgramSnapshotUnchanged(
    afterAuditProgram,
    finalProgram,
    `during final ${args.stage} config audit`,
  );
  return {
    program: finalProgram,
    configs: finalAudit.configs,
    minContextSlot: finalAudit.slot,
  };
}

export function postUpgradeConfigMinContextSlot(args: {
  previousAuditSlot: number;
  lastDeploySlot: number;
}): number {
  if (
    !Number.isSafeInteger(args.previousAuditSlot) ||
    args.previousAuditSlot < 0 ||
    !Number.isSafeInteger(args.lastDeploySlot) ||
    args.lastDeploySlot < 0
  ) {
    throw new Error('Invalid post-upgrade context slot');
  }
  return Math.max(args.previousAuditSlot, args.lastDeploySlot);
}

export function assertUpgradeGateUnchanged(
  before: UpgradeGateState,
  after: UpgradeGateState,
  stage: string,
): void {
  assertProgramSnapshotUnchanged(before.program, after.program, stage);
  assertLineageFingerprintUnchanged(before.configs, after.configs, stage);
}

export function runAfterUnchangedUpgradeGate<Result>(args: {
  before: UpgradeGateState;
  after: UpgradeGateState;
  stage: string;
  action: () => Result;
}): Result {
  assertUpgradeGateUnchanged(args.before, args.after, args.stage);
  return args.action();
}

export async function runDeployAttemptWithVerification<Result>(args: {
  deploy: () => Promise<void>;
  verify: () => Promise<Result>;
  onWarning?: (message: string) => void;
  cancellation?: CommandCancellationController;
}): Promise<Result> {
  let deployError: unknown;
  try {
    await args.deploy();
  } catch (error) {
    deployError = error;
  }

  let verified: Result | undefined;
  let verificationError: unknown;
  try {
    verified = await args.verify();
  } catch (error) {
    verificationError = error;
  }

  if (verificationError) {
    const error = new Error(
      `PROGRAM UPGRADE OUTCOME IS AMBIGUOUS; do not retry blindly.\n` +
        `Deploy command: ${deployError ? errorMessage(deployError) : 'reported success'}\n` +
        `Finalized verification: ${errorMessage(verificationError)}`,
    ) as Error & { exitCode?: number };
    const cancellationSignal =
      deployError instanceof CommandCancelledError
        ? deployError.signal
        : args.cancellation?.signal;
    if (cancellationSignal) {
      error.exitCode = cancellationSignal === 'SIGINT' ? 130 : 143;
    }
    throw error;
  }
  if (deployError instanceof CommandCancelledError) {
    throw new CommandCancelledError(
      deployError.signal,
      `${deployError.message}; finalized verification confirms the upgrade landed`,
    );
  }
  if (deployError) {
    const message =
      `Deploy command reported an error, but finalized state verifies the exact upgrade: ` +
      errorMessage(deployError);
    if (args.onWarning) args.onWarning(message);
    else console.warn(message);
  }
  return verified as Result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
