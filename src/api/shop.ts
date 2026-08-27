import type { PackStatusBreakdown, PackStatusDisplayLabels } from '../types';
import {
  FRONTEND_DROPS,
  normalizeDropId,
  type FrontendDeploymentConfig,
} from '../config/deployment';
import { dropAssetLabel } from '../lib/dropLabels';
import { fetchPackStatus } from '../lib/shopApi';
import {
  isPackStatusSupportedDropId,
  normalizePackStatusAmount,
} from '../../shared/packStatus.ts';

export type ShopApiClientDependencies = {
  fetchPackStatus: typeof fetchPackStatus;
};

export function createShopApiClient(
  dependencies: ShopApiClientDependencies = { fetchPackStatus },
) {
  function packStatusFrontendDropForDropId(dropId: string): FrontendDeploymentConfig | null {
    const normalizedDropId = normalizeDropId(dropId);
    const drop = FRONTEND_DROPS[normalizedDropId];
    if (
      !isPackStatusSupportedDropId(normalizedDropId) ||
      !drop ||
      drop.solanaCluster !== 'mainnet-beta' ||
      normalizePackStatusAmount(drop.itemsPerBox) <= 0
    ) {
      return null;
    }
    return drop;
  }

  function packStatusDisplayLabelsForDropId(dropId: string | undefined): PackStatusDisplayLabels | null {
    if (!dropId) return null;
    const normalizedDropId = normalizeDropId(dropId);
    const drop = FRONTEND_DROPS[normalizedDropId];
    if (!drop || !packStatusFrontendDropForDropId(normalizedDropId)) return null;
    return {
      itemColumnLabel: dropAssetLabel(drop, 'figure', 2, { capitalize: true }),
      ariaLabel: `${dropAssetLabel(drop, 'figure', 1, { capitalize: true })} status`,
    };
  }

  function supportsFrontendPackStatus(dropId: string | undefined): boolean {
    return Boolean(dropId && packStatusFrontendDropForDropId(dropId));
  }

  async function getDropPackStatus(dropId: string): Promise<PackStatusBreakdown | null> {
    const normalizedDropId = normalizeDropId(dropId);
    if (!normalizedDropId) throw new Error('dropId is required');
    return dependencies.fetchPackStatus(normalizedDropId);
  }

  return {
    getDropPackStatus,
    packStatusDisplayLabelsForDropId,
    supportsFrontendPackStatus,
  };
}

const shopApiClient = createShopApiClient();

export const {
  getDropPackStatus,
  packStatusDisplayLabelsForDropId,
  supportsFrontendPackStatus,
} = shopApiClient;
