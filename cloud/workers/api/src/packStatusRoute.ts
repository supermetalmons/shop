import { shopDropById } from '../../../../shared/shopDomain.js';
import { isPackStatusSupportedDropId } from '../../../../shared/packStatus.js';
import {
  D1_PACK_STATUS_CACHE_TTL_SECONDS,
  packStatusCacheRequest,
  parseD1PackStatusCache,
  readD1PackStatus,
  readPackStatusMetadata,
} from './d1PackStatus.js';
import {
  registerDeferredWork,
  type DeferredWork,
} from './deferredWork.js';
import { publicJsonResponse, type WorkerDependencies } from './publicRouteSupport.js';

export function packStatusDropIdFromPathname(pathname: string): string | null | undefined {
  if (pathname !== '/pack-status' && !pathname.startsWith('/pack-status/')) return undefined;
  const match = pathname.match(/^\/pack-status\/([^/]+)$/);
  const dropId = match?.[1] || '';
  const drop = shopDropById(dropId);
  return isPackStatusSupportedDropId(dropId) && drop?.solanaCluster === 'mainnet-beta' ? dropId : null;
}

export async function handlePackStatus(
  dropId: string,
  env: Pick<Env, 'DATA_DB'>,
  dependencies: Pick<WorkerDependencies, 'cache' | 'log'>,
  defer: DeferredWork,
): Promise<{ response: Response; cacheStatus?: string }> {
  let cacheWrite: Promise<void> | undefined;
  let result: { response: Response; cacheStatus?: string };
  try {
    if (typeof env.DATA_DB?.prepare !== 'function') throw new Error('pack_status_data_db_not_configured');
    const metadata = await readPackStatusMetadata(env.DATA_DB);
    const cacheRequest = packStatusCacheRequest(metadata.cacheGeneration, dropId);
    let cached: Response | undefined;
    try {
      cached = await dependencies.cache?.match(cacheRequest);
    } catch (error) {
      dependencies.log({
        event: 'pack_status_d1_cache_read_failed',
        dropId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
      });
    }
    if (cached) {
      try {
        const packStatus = parseD1PackStatusCache(await cached.json(), dropId);
        if (packStatus) {
          return {
            response: publicJsonResponse({ ok: true, packStatus }, 200),
            cacheStatus: 'D1-HIT',
          };
        }
      } catch {}
      dependencies.log({ event: 'pack_status_d1_cache_invalid', dropId });
    }
    const packStatus = await readD1PackStatus(env.DATA_DB, dropId);
    if (!packStatus) throw new Error('pack_status_d1_row_missing');
    if (dependencies.cache) {
      const cacheResponse = Response.json(packStatus, {
        headers: { 'Cache-Control': `max-age=${D1_PACK_STATUS_CACHE_TTL_SECONDS}` },
      });
      cacheWrite = dependencies.cache.put(cacheRequest, cacheResponse).catch((error) => {
        dependencies.log({
          event: 'pack_status_d1_cache_write_failed',
          dropId,
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
        });
      });
    }
    result = {
      response: publicJsonResponse({ ok: true, packStatus }, 200),
      cacheStatus: 'D1-MISS',
    };
  } catch (error) {
    dependencies.log({
      event: 'pack_status_d1_unavailable',
      dropId,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
    return {
      response: publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502),
    };
  }
  if (cacheWrite) registerDeferredWork(defer, cacheWrite);
  return result;
}
