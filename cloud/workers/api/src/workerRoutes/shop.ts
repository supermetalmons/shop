import { handleRpcMethodNotAllowed, handleRpcPost } from '../rpcProxy.js';
import { handleNotificationEnqueue, NOTIFICATION_ENQUEUE_PATH } from '../notificationEnqueue.js';
import { handlePublicMethodNotAllowed, publicJsonResponse } from '../publicRouteSupport.js';
import { handleNotificationSubscription } from '../notificationSubscription.js';
import { handlePackStatus, packStatusDropIdFromPathname } from '../packStatusRoute.js';
import { handlePost } from '../shopInventory.js';
import { MI_NOTE_CARDS_API_PATH } from '../../../../../shared/miNoteCards.js';
import { handleMiNoteCards } from '../miNoteCards.js';
import {
  type WorkerRouteContext,
  type WorkerRouteResult,
  type MatchedWorkerRoute,
  type ExactWorkerRoute,
  INTERNAL_POLICY,
  exactRoute,
} from './support.js';

async function dispatchHealth(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: context.request.method === 'GET'
      ? publicJsonResponse({ ok: true }, 200)
      : publicJsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET' }),
  };
}

async function dispatchNotificationEnqueue(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: await handleNotificationEnqueue(
      context.request,
      context.env,
      { log: context.dependencies.log },
    ),
  };
}

async function dispatchRpc(
  context: WorkerRouteContext,
  cluster: 'mainnet-beta' | 'devnet',
): Promise<WorkerRouteResult> {
  if (context.request.method !== 'POST') {
    return { response: handleRpcMethodNotAllowed(context.request) };
  }
  const result = await handleRpcPost(
    context.request,
    context.env,
    cluster,
    context.dependencies,
    context.metrics,
  );
  return {
    response: result.response,
    logFields: result.rpcMethod ? { rpcMethod: result.rpcMethod } : undefined,
  };
}

async function dispatchNotificationSubscription(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: context.request.method === 'POST'
      ? await handleNotificationSubscription(
          context.request,
          context.env,
          context.dependencies,
          context.metrics,
        )
      : handlePublicMethodNotAllowed(context.request),
  };
}

async function dispatchShopPost(
  context: WorkerRouteContext,
  path: '/inventory' | '/pending-open-boxes',
): Promise<WorkerRouteResult> {
  if (context.request.method !== 'POST') {
    return { response: handlePublicMethodNotAllowed(context.request) };
  }
  const result = await handlePost(
    context.request,
    context.env,
    path,
    context.dependencies,
    context.metrics,
  );
  return {
    response: result.response,
    logFields: {
      includeDevnet: result.includeDevnet,
    },
  };
}

async function dispatchMiNoteCards(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  if (context.request.method !== 'GET') {
    return { response: handlePublicMethodNotAllowed(context.request, 'GET, OPTIONS') };
  }
  const result = await handleMiNoteCards(
    context.request,
    context.env,
    context.dependencies,
    context.metrics,
    context.defer,
  );
  return {
    response: result.response,
    logFields: result.cacheStatus ? { providerCacheStatus: result.cacheStatus } : {},
  };
}

export function packStatusRoute(pathname: string): MatchedWorkerRoute | undefined {
  const dropId = packStatusDropIdFromPathname(pathname);
  if (dropId === undefined) return undefined;
  return Object.freeze({
    commerceMutation: false,
    cors: 'pack-status',
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'public',
    logRoute: '/pack-status/:dropId',
    packStatusDropId: dropId,
    baseLogFields: () => dropId ? { dropId } : {},
    async dispatch(context) {
      if (dropId === null) {
        return { response: publicJsonResponse({ ok: false, error: 'invalid-request' }, 400) };
      }
      if (context.request.method !== 'GET') {
        return {
          response: publicJsonResponse(
            { ok: false, error: 'method-not-allowed' },
            405,
            { Allow: 'GET, OPTIONS' },
          ),
        };
      }
      const result = await handlePackStatus(
        dropId,
        context.env,
        context.dependencies,
        context.defer,
      );
      return {
        response: result.response,
        logFields: {
          ...(result.cacheStatus ? { providerCacheStatus: result.cacheStatus } : {}),
        },
      };
    },
  });
}

export const shopRoutes: readonly ExactWorkerRoute[] = [
  exactRoute('/health', INTERNAL_POLICY, dispatchHealth),
  exactRoute(
    MI_NOTE_CARDS_API_PATH,
    Object.freeze({
      commerceMutation: false,
      cors: 'mi-note',
      profileOriginGate: true,
      staff: 'optional',
      unexpectedError: 'profile',
    }),
    dispatchMiNoteCards,
  ),
  exactRoute(NOTIFICATION_ENQUEUE_PATH, INTERNAL_POLICY, dispatchNotificationEnqueue),
  exactRoute(
    '/inventory',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    (context) => dispatchShopPost(context, '/inventory'),
    '/inventory',
    (metrics) => ({
      expectedAssetIds: metrics.expectedAssetIds,
      expectedAssetRecoveryFailures: metrics.expectedAssetRecoveryFailures,
      expectedAssetResolved: metrics.expectedAssetResolved,
    }),
  ),
  exactRoute(
    '/pending-open-boxes',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    (context) => dispatchShopPost(context, '/pending-open-boxes'),
  ),
  exactRoute(
    '/notifications/subscribe',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    dispatchNotificationSubscription,
  ),
  exactRoute(
    '/rpc/mainnet-beta',
    Object.freeze({
      commerceMutation: false,
      cors: 'rpc',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'rpc',
    }),
    (context) => dispatchRpc(context, 'mainnet-beta'),
  ),
  exactRoute(
    '/rpc/devnet',
    Object.freeze({
      commerceMutation: false,
      cors: 'rpc',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'rpc',
    }),
    (context) => dispatchRpc(context, 'devnet'),
  ),
];
