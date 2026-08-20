import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationsDeployTestHooks } from '../../../../scripts/deploy-cloudflare-notifications.ts';

const CURRENT = '394a3980-dba4-40ba-b179-ea56feacbc52';
const CANDIDATE = '494a3980-dba4-40ba-b179-ea56feacbc52';

test('notification release manifest tracks exact production and rollback versions', () => {
  const manifest = notificationsDeployTestHooks.readNotificationReleaseManifest();
  assert.equal(notificationsDeployTestHooks.isNotificationReleaseManifest(manifest), true);
  assert.match(manifest.currentProductionVersionId, /^[0-9a-f-]{36}$/);
  assert.match(manifest.approvedRollbackVersionId, /^[0-9a-f-]{36}$/);
  assert.equal(notificationsDeployTestHooks.isNotificationReleaseManifest({ ...manifest, extra: true }), false);
  assert.equal(notificationsDeployTestHooks.isNotificationReleaseManifest({ ...manifest, currentProductionVersionId: 'latest' }), false);
});

test('notification upload metadata accepts only the exact Worker and version', () => {
  assert.equal(notificationsDeployTestHooks.parseNotificationUploadMetadata(JSON.stringify({
    type: 'version-upload',
    worker_name: 'mons-shop-notifications',
    version_id: CANDIDATE,
  })), CANDIDATE);
  assert.throws(
    () => notificationsDeployTestHooks.parseNotificationUploadMetadata(JSON.stringify({
      type: 'version-upload',
      worker_name: 'another-worker',
      version_id: CANDIDATE,
    })),
    /exact notification Worker version/,
  );
});

test('notification smoke parsing binds a sent log to the exact queued job', () => {
  const smokeOutput = `Queued Resend notification test email.\nJob ID: ${CANDIDATE}\n`;
  assert.equal(notificationsDeployTestHooks.notificationSmokeJobId(smokeOutput), CANDIDATE);
  assert.equal(notificationsDeployTestHooks.notificationSmokeLogSucceeded(
    JSON.stringify({ event: 'notification_email_sent', jobId: CANDIDATE }, null, 2),
    CANDIDATE,
  ), true);
  assert.equal(notificationsDeployTestHooks.notificationSmokeLogSucceeded(
    JSON.stringify({ event: 'notification_email_sent', jobId: CURRENT }),
    CANDIDATE,
  ), false);
  assert.equal(notificationsDeployTestHooks.notificationSmokeLogSucceeded([
    JSON.stringify({ event: 'notification_email_retry', jobId: CANDIDATE }),
    JSON.stringify({ event: 'notification_email_sent', jobId: CURRENT }),
  ].join('\n'), CANDIDATE), false);
});

test('notification deployment command uses the guarded release helper', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['deploy:notifications'], 'node --import tsx scripts/deploy-cloudflare-notifications.ts');
});
