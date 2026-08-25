import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRemoteOpsD1Integrity } from '../shared/opsD1Maintenance.ts';

export function formatOpsD1Report(): string {
  const {
    profileAddressCount,
    profileCount,
    profileStorageSource,
    readyNotifications,
    revealSubmissionCount,
    revealSubmissionStorage,
    walletSessionCount,
    walletSessionStorage,
  } = readRemoteOpsD1Integrity();
  const cursor = readyNotifications.cursorPath || 'none';
  return `Ops D1 is healthy: ready notifications ${readyNotifications.paused ? 'paused' : 'active'}, cursor ${cursor}, revision ${readyNotifications.revision}; reveal submissions ${revealSubmissionCount}, ${revealSubmissionStorage.paused ? 'paused' : 'active'}, source ${revealSubmissionStorage.source}, revision ${revealSubmissionStorage.revision}; profiles ${profileCount}, addresses ${profileAddressCount}, source ${profileStorageSource}; wallet sessions ${walletSessionCount}, source ${walletSessionStorage.source}, revision ${walletSessionStorage.revision}.`;
}

function isDirectRun(): boolean {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isDirectRun()) {
  try {
    console.log(formatOpsD1Report());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
