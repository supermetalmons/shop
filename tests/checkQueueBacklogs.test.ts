import assert from 'node:assert/strict';
import test from 'node:test';
import { checkQueueBacklogs } from '../scripts/ops/checkQueueBacklogs.ts';

const names = [
  'mons-shop-notification-emails',
  'mons-shop-notification-emails-dlq',
  'mons-shop-reveal-reconciliation',
  'mons-shop-reveal-reconciliation-dlq',
  'mons-shop-stripe-fulfillment',
  'mons-shop-stripe-fulfillment-dlq',
];

function fetcher(backlogCount = 0): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/queues')) {
      return Response.json({
        success: true,
        result: names.map((queue_name, index) => ({ queue_name, queue_id: `queue-${index}` })),
      });
    }
    return Response.json({
      success: true,
      result: {
        backlog_count: backlogCount,
        backlog_bytes: backlogCount * 100,
        oldest_message_timestamp_ms: backlogCount ? 1 : 0,
      },
    });
  };
}

test('queue backlog check requires all active and dead-letter queues to be empty', async () => {
  const report = await checkQueueBacklogs('token', fetcher());
  assert.deepEqual(Object.keys(report), names);
  assert.ok(Object.values(report).every((entry) => entry.backlogCount === 0));
  await assert.rejects(checkQueueBacklogs('token', fetcher(1)), /backlog is not empty/);
});
