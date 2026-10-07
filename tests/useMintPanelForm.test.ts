import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import type { MintPanelFormOptions } from '../src/shop/purchase/useMintPanelForm.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useMintPanelForm } = await import('../src/shop/purchase/useMintPanelForm.ts');

afterEach(cleanup);
after(() => dom.window.close());

function options(overrides: Partial<MintPanelFormOptions> = {}): MintPanelFormOptions {
  return {
    stats: { minted: 0, total: 15, remaining: 15, maxPerTx: 5 },
    onMint: () => undefined,
    busy: false,
    priceSol: 1,
    discountPriceSol: 0.5,
    maxSupply: 15,
    maxPerTx: 5,
    stripePaymentVisible: true,
    stripePaymentUnitAmountCents: 1000,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const mode of ['regular', 'discount', 'stripe'] as const) {
  test(`${mode} submissions block same-turn duplicates and the other payment method, then allow retry`, async () => {
    const first = deferred();
    const calls: string[] = [];
    const errors: string[] = [];
    const submit = (action: string) => {
      calls.push(action);
      return calls.length === 1 ? first.promise : undefined;
    };
    const { result } = renderHook(() => useMintPanelForm(options({
      onMint: () => submit('regular'),
      discountAvailable: mode === 'discount',
      onDiscountMint: () => submit('discount'),
      onStripePaymentClick: () => submit('stripe'),
      onError: (message) => errors.push(message),
    })), { reactStrictMode: true });
    const invoke = () => mode === 'stripe' ? result.current.handleStripePaymentClick() : result.current.handleMint();
    let completion!: Promise<void>;
    act(() => {
      completion = invoke();
      void invoke();
      void (mode === 'stripe' ? result.current.handleMint() : result.current.handleStripePaymentClick());
    });
    assert.deepEqual(calls, [mode]);
    await act(async () => {
      first.reject(new Error('Request failed'));
      await completion;
    });
    assert.deepEqual(errors, ['Request failed']);
    assert.equal(result.current.controlsBusy, false);
    await act(async () => { await invoke(); });
    assert.deepEqual(calls, [mode, mode]);
  });

  test(`${mode} synchronous failures retain fallback text and release the guard`, async () => {
    const errors: string[] = [];
    let attempts = 0;
    const submit = () => {
      attempts += 1;
      if (attempts === 1) throw { reason: 'Unavailable' };
    };
    const { result } = renderHook(() => useMintPanelForm(options({
      onMint: submit,
      discountAvailable: mode === 'discount',
      onDiscountMint: submit,
      onStripePaymentClick: submit,
      onError: (message) => errors.push(message),
    })));
    const invoke = () => mode === 'stripe' ? result.current.handleStripePaymentClick() : result.current.handleMint();
    await act(async () => { await invoke(); });
    assert.deepEqual(errors, [mode === 'stripe' ? 'Failed to start Stripe payment' : 'Failed to mint']);
    assert.equal(result.current.controlsBusy, false);
    await act(async () => { await invoke(); });
    assert.equal(attempts, 2);
  });

  test(`${mode} failures after unmount do not report errors`, async () => {
    const request = deferred();
    const errors: string[] = [];
    const { result, unmount } = renderHook(() => useMintPanelForm(options({
      onMint: () => request.promise,
      discountAvailable: mode === 'discount',
      onDiscountMint: () => request.promise,
      onStripePaymentClick: () => request.promise,
      onError: (message) => errors.push(message),
    })));
    let completion!: Promise<void>;
    act(() => {
      completion = mode === 'stripe' ? result.current.handleStripePaymentClick() : result.current.handleMint();
    });
    unmount();
    await act(async () => {
      request.reject(new Error('Late failure'));
      await completion;
    });
    assert.deepEqual(errors, []);
  });
}

test('external busy states guard both handlers even when invoked directly', async () => {
  const onSubmit = () => assert.fail('Busy forms must not submit');
  const base = options({ onMint: onSubmit, onDiscountMint: onSubmit, onStripePaymentClick: onSubmit });
  const { result, rerender } = renderHook(useMintPanelForm, { initialProps: { ...base, busy: true } });
  for (const external of [
    { busy: true },
    { discountAvailable: true, discountBusy: true },
    { stripePaymentBusy: true },
  ]) {
    rerender({ ...base, ...external });
    await act(async () => {
      await result.current.handleMint();
      await result.current.handleStripePaymentClick();
    });
  }
});
