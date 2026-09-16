export type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type EthereumProviderListener = (...args: unknown[]) => void;

export type EIP1193Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: EthereumProviderListener) => unknown;
  removeListener?: (event: string, listener: EthereumProviderListener) => unknown;
};

export type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
};

type Discovery = {
  wallets: Map<string, EIP6963ProviderDetail>;
  listeners: Set<(wallets: EIP6963ProviderDetail[]) => void>;
  lastAnnouncementAt: number;
  scan: Promise<EIP6963ProviderDetail[]> | null;
};

const discoveries = new WeakMap<Window, Discovery>();

function readAnnouncedWallet(event: Event): EIP6963ProviderDetail | null {
  const detail = (event as CustomEvent<unknown>).detail as Partial<EIP6963ProviderDetail> | undefined;
  if (!detail || typeof detail !== 'object' || typeof detail.provider?.request !== 'function') return null;
  const info = detail.info;
  if (!info || typeof info !== 'object' || typeof info.uuid !== 'string' || !info.uuid) return null;
  const rdns = typeof info.rdns === 'string' ? info.rdns : '';
  const name = typeof info.name === 'string' && info.name ? info.name : rdns;
  if (!name) return null;
  return {
    info: { uuid: info.uuid, name, rdns, icon: typeof info.icon === 'string' ? info.icon : '' },
    provider: detail.provider,
  };
}

function getDiscovery(): Discovery | null {
  if (typeof window === 'undefined') return null;
  let discovery = discoveries.get(window);
  if (!discovery) {
    discovery = { wallets: new Map(), listeners: new Set(), lastAnnouncementAt: 0, scan: null };
    discoveries.set(window, discovery);
    const current = discovery;
    window.addEventListener('eip6963:announceProvider', (event) => {
      const wallet = readAnnouncedWallet(event);
      if (!wallet || current.wallets.has(wallet.info.uuid)) return;
      current.wallets.set(wallet.info.uuid, wallet);
      current.lastAnnouncementAt = Date.now();
      for (const listener of current.listeners) listener([...current.wallets.values()]);
    });
  }
  return discovery;
}

export function primeInjectedEthereumProviderDiscovery(): void {
  if (getDiscovery()) window.dispatchEvent(new window.Event('eip6963:requestProvider'));
}

export function subscribeInjectedEthereumProviders(listener: (wallets: EIP6963ProviderDetail[]) => void): () => void {
  const discovery = getDiscovery();
  discovery?.listeners.add(listener);
  return () => { discovery?.listeners.delete(listener); };
}

export function getLegacyInjectedProvider(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;
  const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  return provider && typeof provider.request === 'function' ? provider : null;
}

export async function listInjectedEthereumProviders(): Promise<EIP6963ProviderDetail[]> {
  const discovery = getDiscovery();
  if (!discovery) return [];
  if (!discovery.scan) {
    discovery.scan = (async () => {
      const startedAt = Date.now();
      const maxWait = getLegacyInjectedProvider() ? 100 : 300;
      primeInjectedEthereumProviderDiscovery();
      do {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
        if (discovery.wallets.size > 0 && Date.now() - Math.max(startedAt, discovery.lastAnnouncementAt) >= 60) break;
      } while (Date.now() - startedAt < maxWait);
      return [...discovery.wallets.values()];
    })().finally(() => { discovery.scan = null; });
  }
  return discovery.scan;
}

export function getInjectedWalletIconSrc(icon: string): string | null {
  return icon.startsWith('data:image/') ? icon : null;
}
