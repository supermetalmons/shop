import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { createShopConnection } from '../../lib/shopRpc';

type BalanceConnection = Pick<Connection, 'rpcEndpoint' | 'getAccountInfo'>;
type BalanceRuntime = {
  createConnection: () => BalanceConnection;
};

const DEFAULT_RUNTIME: BalanceRuntime = {
  createConnection: () => createShopConnection('mainnet-beta'),
};

export function useMainnetSolBalance(
  address: string | undefined,
  open: boolean,
  runtime: BalanceRuntime = DEFAULT_RUNTIME,
) {
  const connection = useMemo(() => runtime.createConnection(), [runtime]);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const queryKey = useMemo(() => ['headerSolBalance', connection.rpcEndpoint, address] as const, [address, connection.rpcEndpoint]);

  useEffect(() => {
    const updateVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  const enabled = Boolean(address && open && visible);
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      if (!address) throw new Error('Wallet address is unavailable');
      const account = await connection.getAccountInfo(new PublicKey(address), {
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
      });
      signal.throwIfAborted();
      return account?.lamports ?? 0;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  return {
    lamports: address ? query.data : undefined,
    loading: enabled && query.isPending,
    error: Boolean(address && query.isError),
    retry: () => {
      if (enabled) void query.refetch({ cancelRefetch: false });
    },
  };
}
