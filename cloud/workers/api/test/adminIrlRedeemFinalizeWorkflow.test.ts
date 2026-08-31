import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminIrlRedeemFinalizeError } from '../src/adminIrlRedeemFinalize.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';

const workflowModule = await loadCloudflareWorkersModule(() =>
  import('../src/adminIrlRedeemFinalizeWorkflow.ts'));

const OPERATION_ID = `airf-v1-${'a'.repeat(64)}`;
const PAYLOAD = { version: 1 as const, dropId: 'card_nft_2', requestId: 'AbCdEfGhIjKlMnOpQrSt' };
const REFERENCE = {
  kind: 'admin-irl-redeem-finalize-v1' as const,
  dropId: PAYLOAD.dropId,
  requestId: PAYLOAD.requestId,
};

class FakeWorkflowStep {
  readonly calls: Array<{ name: string; config: Record<string, unknown> }> = [];
  readonly attempts: Array<{ name: string; attempt: number }> = [];
  readonly boundaryErrors: Array<{ name: string; message: string }> = [];

  async do(
    name: string,
    config: Record<string, unknown>,
    callback: (context: { attempt: number }) => Promise<unknown>,
  ): Promise<unknown> {
    this.calls.push({ name, config });
    const retries = config.retries;
    const limit = retries && typeof retries === 'object' &&
      Number.isSafeInteger((retries as { limit?: unknown }).limit)
      ? Number((retries as { limit: number }).limit)
      : 0;
    let boundaryError: Error | undefined;
    for (let attempt = 1; attempt <= limit + 1; attempt += 1) {
      this.attempts.push({ name, attempt });
      try {
        return await callback({ attempt });
      } catch (error) {
        const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {};
        boundaryError = new Error(typeof value.message === 'string' ? value.message : 'Workflow step failed.');
        boundaryError.name = typeof value.name === 'string' ? value.name : 'Error';
        this.boundaryErrors.push({ name: boundaryError.name, message: boundaryError.message });
      }
    }
    throw boundaryError || new Error('Workflow step failed.');
  }
}

class ExternallyRejectingWorkflowStep extends FakeWorkflowStep {
  constructor(private readonly failures: ReadonlyMap<string, string>) {
    super();
  }

  override async do(
    name: string,
    config: Record<string, unknown>,
    callback: (context: { attempt: number }) => Promise<unknown>,
  ): Promise<unknown> {
    const failure = this.failures.get(name);
    if (failure) {
      this.calls.push({ name, config });
      throw new Error(failure);
    }
    return super.do(name, config, callback);
  }
}

type CapturedConsole = Readonly<{
  log: unknown[][];
  warn: unknown[][];
  error: unknown[][];
}>;

async function captureConsole<T>(action: () => Promise<T>): Promise<Readonly<{
  result: T;
  captured: CapturedConsole;
}>> {
  const captured: {
    log: unknown[][];
    warn: unknown[][];
    error: unknown[][];
  } = { log: [], warn: [], error: [] };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values: unknown[]) => { captured.log.push(values); };
  console.warn = (...values: unknown[]) => { captured.warn.push(values); };
  console.error = (...values: unknown[]) => { captured.error.push(values); };
  try {
    return { result: await action(), captured };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

async function withThrowingConsole<T>(action: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const unavailable = () => { throw new Error('Console unavailable.'); };
  console.log = unavailable;
  console.warn = unavailable;
  console.error = unavailable;
  try {
    return await action();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function logEntries(values: unknown[][]): Array<Record<string, unknown>> {
  return values.map(([value]) => {
    assert.equal(typeof value, 'string');
    const parsed = JSON.parse(value as string) as unknown;
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    return parsed as Record<string, unknown>;
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    cleanup: async () => ({ cleared: true }),
    resumeAndReconcile: async () => ({ status: 'ready' as const }),
    validate: async () => ({ status: 'ready' as const }),
    prepareDraft: async () => ({ status: 'drafted' as const }),
    publish: async () => REFERENCE,
    ...overrides,
  };
}

function event() {
  return {
    instanceId: OPERATION_ID,
    payload: PAYLOAD,
    timestamp: new Date(),
    workflowName: 'mons-shop-admin-irl-redeem-finalize-v1',
  };
}

test('Admin IRL Workflow runs exactly four fixed business steps and emits only a safe reference', async () => {
  const step = new FakeWorkflowStep();
  const { result: output, captured } = await captureConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      step as never,
      dependencies(),
    ));

  assert.deepEqual(output, { version: 1, ok: true, result: REFERENCE });
  assert.deepEqual(step.calls.map((call) => call.name), [
    'resume exact lease and reconcile WAL',
    'validate configuration and transfer',
    'prepare immutable publication draft',
    'publish durable completion',
  ]);
  assert.equal(step.calls[2].config.sensitive, 'output');
  assert.equal(step.calls[2].config.timeout, 25 * 60 * 1000);
  assert.equal(JSON.stringify(output).includes('claimCode'), false);
  assert.equal(captured.warn.length, 0);
  assert.equal(captured.error.length, 0);
  assert.equal(logEntries(captured.log).some((entry) => entry.step === 'workflow'), false);
});

test('Admin IRL Workflow logging failures do not change success or cleanup outcomes', async () => {
  const successStep = new FakeWorkflowStep();
  let publishCalls = 0;
  const success = await withThrowingConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      successStep as never,
      dependencies({
        publish: async () => {
          publishCalls += 1;
          return REFERENCE;
        },
      }),
    ));
  assert.deepEqual(success, { version: 1, ok: true, result: REFERENCE });
  assert.equal(publishCalls, 1);

  const failureStep = new FakeWorkflowStep();
  let cleanupCalls = 0;
  const failure = await withThrowingConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      failureStep as never,
      dependencies({
        validate: async () => {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Transfer mismatch.');
        },
        cleanup: async () => {
          cleanupCalls += 1;
          return { cleared: true };
        },
      }),
    ));
  assert.deepEqual(failure, {
    version: 1,
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'Admin IRL redeem finalization requirements are not satisfied.',
      retryable: false,
    },
  });
  assert.equal(cleanupCalls, 1);
});

const BUSINESS_STAGES = [
  { dependency: 'resumeAndReconcile', name: 'resume exact lease and reconcile WAL' },
  { dependency: 'validate', name: 'validate configuration and transfer' },
  { dependency: 'prepareDraft', name: 'prepare immutable publication draft' },
  { dependency: 'publish', name: 'publish durable completion' },
] as const;

for (const [index, stage] of BUSINESS_STAGES.entries()) {
  test(`Admin IRL Workflow cleans up terminal ${stage.dependency} failures`, async () => {
    const step = new FakeWorkflowStep();
    let cleanupError: unknown;
    const rawMessage = `raw ${stage.dependency} terminal response with secrets`;
    const { result: output, captured } = await captureConsole(() =>
      workflowModule.runAdminIrlRedeemFinalizeWorkflow(
        {} as Env,
        event(),
        step as never,
        dependencies({
          [stage.dependency]: async () => {
            throw new AdminIrlRedeemFinalizeError('failed-precondition', rawMessage);
          },
          cleanup: async (args: { error: unknown }) => {
            cleanupError = args.error;
            return { cleared: true };
          },
        }),
      ));

    assert.deepEqual(output, {
      version: 1,
      ok: false,
      error: {
        code: 'failed-precondition',
        message: 'Admin IRL redeem finalization requirements are not satisfied.',
        retryable: false,
      },
    });
    assert.deepEqual(cleanupError, output.error);
    assert.deepEqual(step.calls.map((call) => call.name), [
      ...BUSINESS_STAGES.slice(0, index + 1).map((entry) => entry.name),
      'persist terminal failure',
    ]);
    assert.equal(captured.warn.length, 0);
    assert.equal(JSON.stringify(captured).includes(rawMessage), false);
    const errors = logEntries(captured.error);
    assert.ok(errors.some((entry) => entry.step === stage.name && entry.outcome === 'terminal_failure'));
    assert.equal(errors.some((entry) => entry.step === 'workflow'), false);
    const terminalFailures = errors.filter((entry) => entry.step === 'persist terminal failure');
    assert.equal(terminalFailures.length, 1);
    assert.equal(terminalFailures[0].outcome, 'terminal_failure');
    assert.equal(terminalFailures[0].errorCode, 'failed-precondition');
    assert.equal(terminalFailures[0].cleanupOutcome, 'cleared');
  });

  test(`Admin IRL Workflow exhausts and boundary-clones retryable ${stage.dependency} failures`, async () => {
    const step = new FakeWorkflowStep();
    let dependencyCalls = 0;
    let cleanupError: unknown;
    const rawMessage = `raw ${stage.dependency} provider response with secrets`;
    const { result: output, captured } = await captureConsole(() =>
      workflowModule.runAdminIrlRedeemFinalizeWorkflow(
        {} as Env,
        event(),
        step as never,
        dependencies({
          [stage.dependency]: async () => {
            dependencyCalls += 1;
            throw new AdminIrlRedeemFinalizeError('unavailable', rawMessage);
          },
          cleanup: async (args: { error: unknown }) => {
            cleanupError = args.error;
            return { cleared: true };
          },
        }),
      ));

    assert.deepEqual(output, {
      version: 1,
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Admin IRL redeem finalization is temporarily unavailable.',
        retryable: true,
      },
    });
    assert.deepEqual(cleanupError, output.error);
    assert.equal(dependencyCalls, 5);
    assert.equal(step.attempts.filter((attempt) => attempt.name === stage.name).length, 5);
    assert.deepEqual(step.boundaryErrors, Array.from({ length: 5 }, () => ({
      name: 'AdminIrlRedeemFinalizeWorkflowRetry',
      message: 'admin-irl-redeem-finalize-retry:unavailable',
    })));
    assert.equal(JSON.stringify(output).includes(rawMessage), false);
    assert.equal(JSON.stringify(captured).includes(rawMessage), false);
    assert.equal(captured.warn.length, 5);
    const errors = logEntries(captured.error);
    assert.equal(errors.some((entry) => entry.step === 'workflow'), false);
    assert.deepEqual(errors.map((entry) => ({
      step: entry.step,
      outcome: entry.outcome,
      errorCode: entry.errorCode,
      cleanupOutcome: entry.cleanupOutcome,
    })), [{
      step: 'persist terminal failure',
      outcome: 'terminal_failure',
      errorCode: 'unavailable',
      cleanupOutcome: 'cleared',
    }]);
  });
}

test('Admin IRL Workflow does not treat a dependency error as an engine abort', async () => {
  const step = new FakeWorkflowStep();
  const rawMessage = 'Aborting engine: User called pause';
  const { result: output, captured } = await captureConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      step as never,
      dependencies({
        resumeAndReconcile: async () => {
          throw new Error(rawMessage);
        },
      }),
    ));

  assert.deepEqual(output, {
    version: 1,
    ok: false,
    error: {
      code: 'internal',
      message: 'Admin IRL redeem finalization failed unexpectedly.',
      retryable: true,
    },
  });
  assert.equal(JSON.stringify(output).includes(rawMessage), false);
  assert.equal(JSON.stringify(captured).includes(rawMessage), false);
  assert.equal(step.attempts.filter((attempt) => attempt.name === BUSINESS_STAGES[0].name).length, 5);
});

test('Admin IRL Workflow propagates engine aborts through business, cleanup, and reporting paths', async () => {
  const abortMessage = 'Aborting engine: User called delete';
  const abortsWithMessage = (action: () => Promise<unknown>) => assert.rejects(
    action,
    (error: unknown) => error instanceof Error && error.message === abortMessage,
  );

  await abortsWithMessage(() => workflowModule.runAdminIrlRedeemFinalizeWorkflow(
    {} as Env,
    event(),
    new ExternallyRejectingWorkflowStep(new Map([
      ['resume exact lease and reconcile WAL', abortMessage],
    ])) as never,
    dependencies(),
  ));
  await abortsWithMessage(() => workflowModule.runAdminIrlRedeemFinalizeWorkflow(
    {} as Env,
    event(),
    new ExternallyRejectingWorkflowStep(new Map([
      ['persist terminal failure', abortMessage],
    ])) as never,
    dependencies({
      validate: async () => { throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Transfer mismatch.'); },
    }),
  ));
  await abortsWithMessage(() => workflowModule.runAdminIrlRedeemFinalizeWorkflow(
    {} as Env,
    event(),
    new ExternallyRejectingWorkflowStep(new Map([
      ['persist terminal failure', 'Workflow step failed outside its callback.'],
      ['report cleanup exhaustion', abortMessage],
    ])) as never,
    dependencies({
      validate: async () => { throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Transfer mismatch.'); },
    }),
  ));
});

test('Admin IRL Workflow reports terminal cleanup exhaustion at error severity', async () => {
  const step = new FakeWorkflowStep();
  let cleanupCalls = 0;
  const rawMessage = 'raw cleanup response with secrets';
  const { result: output, captured } = await captureConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      step as never,
      dependencies({
        validate: async () => {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Transfer mismatch.');
        },
        cleanup: async () => {
          cleanupCalls += 1;
          throw new Error(rawMessage);
        },
      }),
    ));

  assert.deepEqual(output, {
    version: 1,
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Admin IRL redeem finalization is temporarily unavailable.',
      retryable: true,
    },
  });
  assert.equal(cleanupCalls, 4);
  assert.equal(step.attempts.filter((attempt) => attempt.name === 'persist terminal failure').length, 4);
  assert.deepEqual(step.boundaryErrors, Array.from({ length: 4 }, () => ({
    name: 'AdminIrlRedeemFinalizeWorkflowRetry',
    message: 'admin-irl-redeem-finalize-retry:internal',
  })));
  assert.equal(JSON.stringify(captured).includes(rawMessage), false);
  const errors = logEntries(captured.error);
  const cleanupFailures = errors.filter((entry) => entry.outcome === 'cleanup_failure');
  assert.equal(cleanupFailures.length, 4);
  assert.ok(cleanupFailures.every((entry) => Object.hasOwn(entry, 'retryExhausted') === false));
  assert.equal(errors.filter((entry) =>
    entry.outcome === 'cleanup_exhausted' && entry.retryExhausted === true).length, 1);
  assert.equal(errors.some((entry) => entry.step === 'workflow'), false);
});

test('Admin IRL Workflow marks cleanup exhaustion when the step fails outside its callback', async () => {
  const step = new ExternallyRejectingWorkflowStep(new Map([
    ['persist terminal failure', 'Workflow step failed outside its callback.'],
  ]));
  let cleanupCalls = 0;
  const { result: output, captured } = await captureConsole(() =>
    workflowModule.runAdminIrlRedeemFinalizeWorkflow(
      {} as Env,
      event(),
      step as never,
      dependencies({
        validate: async () => {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Transfer mismatch.');
        },
        cleanup: async () => {
          cleanupCalls += 1;
          return { cleared: true };
        },
      }),
    ));

  assert.deepEqual(output, {
    version: 1,
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Admin IRL redeem finalization is temporarily unavailable.',
      retryable: true,
    },
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(step.attempts.some((attempt) => attempt.name === 'persist terminal failure'), false);
  const terminalMarkers = logEntries(captured.error).filter((entry) =>
    entry.step === 'persist terminal failure' && entry.retryExhausted === true);
  assert.deepEqual(terminalMarkers.map((entry) => ({
    outcome: entry.outcome,
    errorCode: entry.errorCode,
  })), [{
    outcome: 'cleanup_exhausted',
    errorCode: 'unavailable',
  }]);
});
