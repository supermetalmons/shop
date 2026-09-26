import { useEffect, useRef } from 'react';
import type { PreorderOrder } from '../../shared/preorders.ts';
import type { createPreorderApi } from '../lib/preorderApi';
import { listPreorderRecoveries, subscribePreorderRecoveries, upsertPreorderRecovery } from '../lib/preorderRecovery';
import { runPreorderStatus } from '../lib/preorderStatusQueue';

export type PreorderCheckoutApi = Omit<ReturnType<typeof createPreorderApi>, 'recoveries'> & Partial<Pick<ReturnType<typeof createPreorderApi>, 'recoveries'>>;

export function usePreorderReconciliation(options: {
  buyer: string | undefined;
  signedIn: boolean;
  preorderId: string;
  enabled: boolean;
  api: PreorderCheckoutApi;
  onTerminal: (order: PreorderOrder) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const { buyer, signedIn, preorderId, enabled, api } = options;
    if (!buyer || !signedIn || !enabled) return;
    let stopped = false;
    let discovering = false;
    let discovered = false;
    let discoveryAt = 0;
    let discoveryFailures = 0;
    const pending = new Set<string>();
    const nextAt = new Map<string, number>();
    const failures = new Map<string, number>();
    const current = () => !stopped && latest.current.buyer === buyer && latest.current.signedIn && latest.current.preorderId === preorderId;
    const discover = async () => {
      if (!api.recoveries || discovering || discovered || Date.now() < discoveryAt) return;
      discovering = true;
      let cursor: string | undefined;
      const seen = new Set<string>();
      try {
        do {
          const page = await runPreorderStatus(async () => {
            if (!current()) throw new Error('Recovery scope changed');
            return api.recoveries!(preorderId, cursor);
          }, 'background');
          if (!current()) return;
          if (page.recoveries.some(order => order.buyer !== buyer || order.preorderId !== preorderId)) throw new Error('Recovery wallet does not match');
          for (const order of page.recoveries) {
            await upsertPreorderRecovery(order);
            if (!current()) return;
          }
          const next = page.nextRecoveryCursor;
          if (next && seen.has(next)) throw new Error('Recovery pagination did not advance');
          if (next) seen.add(next);
          cursor = next ?? undefined;
        } while (cursor && current());
        discovered = true;
      } catch {
        discoveryAt = Date.now() + Math.min(15_000, 3_000 * 2 ** discoveryFailures++);
      } finally { discovering = false; }
    };
    const check = async (order: PreorderOrder) => {
      const id = order.orderId;
      pending.add(id);
      nextAt.set(id, Date.now() + 3_000);
      try {
        const result = await runPreorderStatus(async () => {
          if (!current()) throw new Error('Recovery scope changed');
          return api.status(preorderId, id);
        }, 'background');
        if (!current()) return;
        let next = result.order;
        if (!next || next.orderId !== id || next.buyer !== buyer || next.preorderId !== preorderId) throw new Error('Recovery order does not match');
        if (next.confirmedSlot == null) {
          if (!['succeeded', 'failed', 'expired'].includes(next.status)) throw new Error('Recovery confirmation is unavailable');
          next = { ...next, confirmedSlot: order.confirmedSlot };
        }
        await upsertPreorderRecovery(next);
        if (!current()) return;
        failures.delete(id);
        if (next.status !== 'submitted') latest.current.onTerminal(next);
      } catch {
        const count = (failures.get(id) ?? 0) + 1;
        failures.set(id, count);
        nextAt.set(id, Date.now() + Math.min(15_000, 3_000 * 2 ** (count - 1)));
      } finally { pending.delete(id); }
    };
    const tick = () => {
      if (!current() || document.visibilityState === 'hidden') return;
      void discover();
      const records = listPreorderRecoveries(buyer).filter(record => record.order.preorderId === preorderId && record.order.status === 'submitted')
        .sort((left, right) => (nextAt.get(left.order.orderId) ?? 0) - (nextAt.get(right.order.orderId) ?? 0));
      for (const { order } of records) {
        if (pending.size >= 2) break;
        if (!pending.has(order.orderId) && Date.now() >= (nextAt.get(order.orderId) ?? 0)) void check(order);
      }
    };
    tick();
    const focused = () => {
      if (!discovering) { discovered = false; discoveryAt = 0; }
      tick();
    };
    const unsubscribe = subscribePreorderRecoveries(tick);
    const interval = setInterval(tick, 1_000);
    window.addEventListener('focus', focused);
    document.addEventListener('visibilitychange', focused);
    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('focus', focused);
      document.removeEventListener('visibilitychange', focused);
    };
  }, [options.api, options.buyer, options.enabled, options.preorderId, options.signedIn]);
}
