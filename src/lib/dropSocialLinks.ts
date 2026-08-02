import { isDropFamily, type DropFamily } from '../config/deployment';

export type DropXProfile = {
  handle: string;
  href: string;
};

type DropXProfileConfig = DropXProfile & {
  dropFamily: DropFamily;
};

const DROP_X_PROFILES: readonly DropXProfileConfig[] = [
  {
    handle: '@supermetalx',
    href: 'https://x.com/supermetalx/status/2004991803301548393',
    dropFamily: 'little_swag_boxes',
  },
  {
    handle: '@supermetalx',
    href: 'https://x.com/supermetalx/status/2046959410287669381',
    dropFamily: 'little_swag_hoodies',
  },
  {
    handle: '@bis__cut',
    href: 'https://x.com/bis__cut/status/2065174935983595934',
    dropFamily: 'card_nft_2',
  },
  {
    handle: '@bis__cut',
    href: 'https://x.com/bis__cut/status/2039338450969641143',
    dropFamily: 'poncho_drifella',
  },
  {
    handle: '@bis__cut',
    href: 'https://x.com/bis__cut/status/2080020123058876494',
    dropFamily: 'drifella_shirt',
  },
  {
    handle: '@bis__cut',
    href: 'https://x.com/bis__cut/status/2082471519683326394',
    dropFamily: 'card_nft_binder',
  },
  {
    handle: '@gucci4mycat',
    href: 'https://x.com/gucci4mycat',
    dropFamily: 'clear_cards',
  },
];

export function resolveDropXProfile(dropId?: string): DropXProfile | null {
  const profile = DROP_X_PROFILES.find(({ dropFamily }) => isDropFamily(dropId, dropFamily));
  return profile ? { handle: profile.handle, href: profile.href } : null;
}
