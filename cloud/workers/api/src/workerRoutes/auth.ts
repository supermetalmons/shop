import { STAFF_AUTH_PATHS, handleStaffAuthRequest, type StaffAuthPath } from '../staffWalletAuth.js';
import { ANONYMOUS_AUTH_PATHS, handleAnonymousAuthRequest } from '../anonymousAuth.js';
import { handleMiNoteAuthRequest, MI_NOTE_AUTH_PATHS } from '../miNoteAuth.js';
import {
  type WorkerRouteContext,
  type WorkerRouteResult,
  type ExactWorkerRoute,
  profilePolicy,
  exactRoute,
} from './support.js';

async function dispatchAnonymousAuth(
  context: WorkerRouteContext,
  path: string,
): Promise<WorkerRouteResult> {
  return { response: await handleAnonymousAuthRequest(context.request, context.env, path) };
}

async function dispatchStaffAuth(
  context: WorkerRouteContext,
  path: StaffAuthPath,
): Promise<WorkerRouteResult> {
  return { response: await handleStaffAuthRequest(context.request, context.env, path) };
}

export const authRoutes: readonly ExactWorkerRoute[] = [
  ...MI_NOTE_AUTH_PATHS.map((path) => exactRoute(path, Object.freeze({
    commerceMutation: false, cors: 'mi-note', profileOriginGate: true,
    staff: 'skip', unexpectedError: 'profile',
  }), async (context) => ({ response: await handleMiNoteAuthRequest(context.request, context.env, path) }))),
  ...Array.from(ANONYMOUS_AUTH_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ profileOriginGate: false }),
    (context) => dispatchAnonymousAuth(context, path),
  )),
  ...Array.from(STAFF_AUTH_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ cors: 'staff-auth', profileOriginGate: false, staff: 'skip' }),
    (context) => dispatchStaffAuth(context, path as StaffAuthPath),
  )),
];
