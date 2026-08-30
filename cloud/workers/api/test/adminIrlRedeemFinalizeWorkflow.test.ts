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
    assert.equal(captured.warn.length, 1);
    assert.equal(JSON.stringify(captured).includes(rawMessage), false);
    const errors = logEntries(captured.error);
    assert.ok(errors.some((entry) => entry.step === stage.name && entry.outcome === 'terminal_failure'));
    assert.ok(errors.some((entry) => entry.step === 'workflow' && entry.outcome === 'failed'));
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
    assert.deepEqual(
      step.boundaryErrors,
      Array.from({ length: 5 }, () => ({
        name: 'AdminIrlRedeemFinalizeWorkflowRetry',
        message: 'admin-irl-redeem-finalize-retry:unavailable',
      })),
    );
    assert.equal(JSON.stringify(output).includes(rawMessage), false);
    assert.equal(JSON.stringify(captured).includes(rawMessage), false);
    assert.equal(captured.warn.length, 6);
    assert.ok(logEntries(captured.error).some((entry) =>
      entry.step === 'workflow' && entry.outcome === 'failed' && entry.cleanupExhausted === false));
  });
}

test('Admin IRL Workflow sanitizes unknown retry exhaustion after an Error boundary clone', async () => {
  const step = new FakeWorkflowStep();
  const rawMessage = 'raw RPC response with secrets';
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
  assert.equal(errors.filter((entry) => entry.outcome === 'cleanup_failure').length, 4);
  assert.ok(errors.some((entry) =>
    entry.step === 'workflow' && entry.outcome === 'failed' && entry.cleanupExhausted === true));
});
