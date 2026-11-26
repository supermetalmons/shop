import { TAROT_API_PATHS } from '../../../../shared/ethereum/tarot.js';
import { handleTarotRequest } from './tarot.js';
import { trackProviderFetch } from './providerMetrics.js';
import { exactRoute, type ExactWorkerRoute } from './workerRoutes/support.js';

export const tarotRoutes: readonly ExactWorkerRoute[] = Object.values(TAROT_API_PATHS).map(path => exactRoute(path, {
  commerceMutation: path === TAROT_API_PATHS.prepare || path === TAROT_API_PATHS.claim, cors: 'ethereum', profileOriginGate: true,
  staff: 'skip', unexpectedError: 'profile',
}, async context => ({ response: await handleTarotRequest(context.request, context.env, path, {
  fetch: trackProviderFetch(context.dependencies.providerFetch, context.metrics),
}) })));
