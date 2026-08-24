import type { PackStatusEvent } from '../../../../shared/packStatus.js';
import {
  applyD1PackStatusEvent,
  type PackStatusD1Database,
} from './d1PackStatus.js';

type ProjectionLog = (entry: Record<string, unknown>) => void;

function logProjectionFailure(args: {
  error: unknown;
  event: PackStatusEvent;
  log?: ProjectionLog;
}): void {
  args.log?.({
    event: 'pack_status_projection_write_failed',
    store: 'd1',
    dropId: args.event.dropId,
    eventType: args.event.type,
    eventKey: args.event.eventKey,
    error: args.error instanceof Error
      ? { name: args.error.name, message: args.error.message }
      : { name: 'UnknownError' },
  });
}

export async function applyPackStatusProjection(args: {
  dataDb?: PackStatusD1Database;
  event: PackStatusEvent;
  log?: ProjectionLog;
}): Promise<void> {
  if (typeof args.dataDb?.prepare !== 'function') {
    const error = new Error('pack_status_data_db_not_configured');
    logProjectionFailure({ error, event: args.event, log: args.log });
    throw error;
  }
  try {
    await applyD1PackStatusEvent(args.dataDb, args.event);
  } catch (error) {
    logProjectionFailure({ error, event: args.event, log: args.log });
    throw new Error('pack_status_d1_write_failed', { cause: error });
  }
}
