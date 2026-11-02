import { PRE111K_API_PATHS } from '../../../../shared/ethereum/pre111k.js';
import { handlePre111kRequest } from './pre111k.js';
import { trackProviderFetch } from './providerMetrics.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const pre111kRoutes: readonly ExactWorkerRoute[] = Object.values(PRE111K_API_PATHS).map(path => exactRoute(path, {
  commerceMutation: path === PRE111K_API_PATHS.prepare, cors: 'ethereum', profileOriginGate: true,
  staff: 'skip', unexpectedError: 'profile',
}, async context => ({ response: await handlePre111kRequest(context.request, context.env, path, {
  fetch: trackProviderFetch(context.dependencies.providerFetch, context.metrics),
}) })));
