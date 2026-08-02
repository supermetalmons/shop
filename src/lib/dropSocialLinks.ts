import { isDropFamily, type DropFamily } from '../config/deployment';

export type DropXProfile = {
  handle: string;
  href: string;
};

type DropXProfileGroup = DropXProfile & {
  dropFamilies: readonly DropFamily[];
};

const DROP_X_PROFILE_GROUPS: readonly DropXProfileGroup[] = [
  {
    handle: '@supermetalx',
    href: 'https://x.com/supermetalx',
    dropFamilies: ['little_swag_boxes', 'little_swag_hoodies'],
  },
  {
    handle: '@bis__cut',
    href: 'https://x.com/bis__cut',
    dropFamilies: ['card_nft_2', 'poncho_drifella', 'drifella_shirt', 'card_nft_binder'],
  },
  {
    handle: '@gucci4mycat',
    href: 'https://x.com/gucci4mycat',
    dropFamilies: ['clear_cards'],
  },
];

export function resolveDropXProfile(dropId?: string): DropXProfile | null {
  const group = DROP_X_PROFILE_GROUPS.find(({ dropFamilies }) =>
    dropFamilies.some((dropFamily) => isDropFamily(dropId, dropFamily)),
  );
  return group ? { handle: group.handle, href: group.href } : null;
}
