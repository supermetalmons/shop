import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRemoteOpsD1Integrity } from '../shared/opsD1Maintenance.ts';

export function formatOpsD1Report(): string {
  const {
    authProviderRetirement,
    anonymousAuthSessionCount,
    profileAddressCount,
    profileCount,
    readyNotifications,
    revealSubmissionCount,
    revealSubmissionStorage,
    walletSessionCount,
  } = readRemoteOpsD1Integrity();
  const cursor = readyNotifications.cursorPath || 'none';
  return `Ops D1 is healthy: anonymous auth ${anonymousAuthSessionCount} sessions, legacy provider retired at ${new Date(authProviderRetirement.legacyProviderDisabledAtMs).toISOString()}, revision ${authProviderRetirement.revision}; ready notifications ${readyNotifications.paused ? 'paused' : 'active'}, cursor ${cursor}, revision ${readyNotifications.revision}; reveal submissions ${revealSubmissionCount}, ${revealSubmissionStorage.paused ? 'paused' : 'active'}, revision ${revealSubmissionStorage.revision}; profiles ${profileCount}, addresses ${profileAddressCount}; wallet sessions ${walletSessionCount}.`;
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
