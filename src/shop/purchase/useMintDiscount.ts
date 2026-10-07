import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Connection, PublicKey } from '@solana/web3.js';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { loadDiscountUsedCount, persistDiscountUsedCount } from '../persistedState';

type MintDiscountOptions = {
  routeDrop: FrontendDeploymentConfig | null;
  routeConnection: Connection | null;
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  walletBusy: boolean;
  mintedOut: boolean;
  activeDiscountAllowance: number;
  activeDiscountScope: string;
  activeDiscountVersion: string;
};

type MintDiscountRuntime = {
  isDiscountListed: typeof import('../../lib/discounts')['isDiscountListed'];
  fetchDiscountMintRecordUsedCount: typeof import('../../lib/boxMinter')['fetchDiscountMintRecordUsedCount'];
};

export function useMintDiscount({
  routeDrop, routeConnection, connectedWallet, publicKey, walletBusy, mintedOut,
  activeDiscountAllowance, activeDiscountScope, activeDiscountVersion,
}: MintDiscountOptions, { isDiscountListed, fetchDiscountMintRecordUsedCount }: MintDiscountRuntime) {
  const [discountEligible, setDiscountEligible] = useState(false);
  const [discountRemainingCount, setDiscountRemainingCount] = useState(0);
  const [discountChecking, setDiscountChecking] = useState(false);
  const context = useMemo(() => ({}), [
    routeDrop, routeConnection, connectedWallet, publicKey, mintedOut,
    activeDiscountAllowance, activeDiscountScope, activeDiscountVersion,
  ]);
  const contextGenerationRef = useRef(0);
  const activeContextRef = useRef<{ context: object; generation: number } | null>(null);
  const requestGenerationRef = useRef(0);
  const refreshEligibilityRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const activeContext = { context, generation: ++contextGenerationRef.current };
    activeContextRef.current = activeContext;
    return () => {
      if (activeContextRef.current === activeContext) activeContextRef.current = null;
      requestGenerationRef.current += 1;
    };
  }, [context]);

  useEffect(() => {
    const usedCount = loadDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet);
    setDiscountRemainingCount(Math.max(0, activeDiscountAllowance - usedCount));
    setDiscountEligible(false);
    setDiscountChecking(false);
  }, [activeDiscountAllowance, activeDiscountScope, activeDiscountVersion, connectedWallet]);

  useEffect(() => {
    const activeContext = activeContextRef.current;
    const check = () => {
      if (activeContextRef.current !== activeContext) return;
      const requestGeneration = ++requestGenerationRef.current;
      const isCurrent = () => activeContextRef.current === activeContext &&
        requestGenerationRef.current === requestGeneration;
      if (!routeDrop || routeDrop.salesMode === 'stripe_receipt_only' || !routeConnection || !connectedWallet || !publicKey || mintedOut) {
        setDiscountEligible(false);
        setDiscountRemainingCount(0);
        setDiscountChecking(false);
        return;
      }
      setDiscountChecking(true);
      void (async () => {
        const address = publicKey.toBase58();
        try {
          const listed = await isDiscountListed(routeDrop.dropId, address);
          if (!isCurrent()) return;
          if (!listed) {
            setDiscountEligible(false);
            setDiscountRemainingCount(0);
            persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, address, 0);
            return;
          }
          const usedCount = await fetchDiscountMintRecordUsedCount(routeConnection, publicKey, routeDrop);
          if (!isCurrent()) return;
          const remainingCount = Math.max(0, activeDiscountAllowance - usedCount);
          setDiscountRemainingCount(remainingCount);
          setDiscountEligible(remainingCount > 0);
          persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, address, usedCount);
        } catch (error) {
          if (!isCurrent()) return;
          console.warn('[mons] failed to check discount eligibility', error);
          setDiscountEligible(false);
          setDiscountRemainingCount(0);
        } finally {
          if (isCurrent()) setDiscountChecking(false);
        }
      })();
    };
    refreshEligibilityRef.current = check;
    check();
    return () => {
      if (refreshEligibilityRef.current === check) refreshEligibilityRef.current = null;
      requestGenerationRef.current += 1;
    };
  }, [
    context, routeDrop, routeConnection, connectedWallet, publicKey, mintedOut,
    activeDiscountAllowance, activeDiscountScope, activeDiscountVersion,
    isDiscountListed, fetchDiscountMintRecordUsedCount,
  ]);

  const captureDiscountUpdate = useCallback(() => {
    const activeContext = activeContextRef.current;
    const generation = activeContext?.generation;
    return (remainingCount: number, usedCount?: number) => {
      if (!activeContext || activeContext.context !== context || activeContextRef.current?.generation !== generation) {
        if (activeContextRef.current) refreshEligibilityRef.current?.();
        return;
      }
      requestGenerationRef.current += 1;
      setDiscountChecking(false);
      setDiscountRemainingCount(remainingCount);
      setDiscountEligible(remainingCount > 0);
      if (usedCount !== undefined && connectedWallet) {
        persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet, usedCount);
      }
    };
  }, [context, activeDiscountScope, activeDiscountVersion, connectedWallet]);

  const discountAvailable = Boolean(connectedWallet && publicKey) && !mintedOut && !walletBusy &&
    !discountChecking && discountEligible && discountRemainingCount > 0;

  return {
    discountEligible, discountRemainingCount, discountChecking, discountAvailable, captureDiscountUpdate,
  };
}
