import type { PackStatusEvent } from '../../../../shared/packStatus.js';
import {
  applyD1PackStatusEvent,
  type PackStatusD1Database,
} from './d1PackStatus.js';

type ProjectionLog = (entry: Record<string, unknown>) => void;

export async function applyPackStatusDualWrite(args: {
  dataDb?: PackStatusD1Database;
  event: PackStatusEvent;
  firestore: () => Promise<void>;
  log?: ProjectionLog;
}): Promise<void> {
  const writes: Array<{ store: 'firestore' | 'd1'; promise: Promise<unknown> }> = [
    { store: 'firestore', promise: Promise.resolve().then(args.firestore) },
  ];
  if (args.dataDb) {
    writes.push({
      store: 'd1',
      promise: Promise.resolve().then(() => applyD1PackStatusEvent(args.dataDb!, args.event)),
    });
  }
  const results = await Promise.allSettled(writes.map((write) => write.promise));
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const store = writes[index].store;
    args.log?.({
      event: 'pack_status_projection_write_failed',
      store,
      dropId: args.event.dropId,
      eventType: args.event.type,
      eventKey: args.event.eventKey,
      error: result.reason instanceof Error
        ? { name: result.reason.name, message: result.reason.message }
        : { name: 'UnknownError' },
    });
    return [result.reason];
  });
  if (failures.length) throw new AggregateError(failures, 'Pack-status projection write failed');
}
