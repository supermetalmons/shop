import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { TarotRequest } from '../../shared/ethereum/tarot';
import type { NfcLink } from '../ethereum/tarotLink';
import type { EthereumWallet } from '../ethereum/useEthereum111k';
import { useTarotClaim } from '../ethereum/useTarotClaim';
import { EthereumWalletPicker } from '../ethereum/EthereumWalletPicker';
import { useTarotCardTransition } from '../hooks/useTarotCardTransition';
import { NfcClaimPage } from './NfcClaimPage';
import { NfcTarotCard } from './NfcTarotCard';

type Props = {
  link: NfcLink; wallet: EthereumWallet; header?: ReactNode; suspended?: boolean; headerWalletOpen?: boolean;
  onModalOpenChange?: (open: boolean) => void;
};

function TarotCardPage({ tokenId, header, model, suspended = false, pickerOpen = false, headerWalletOpen = false }: {
  tokenId: number; header?: ReactNode; model?: ReturnType<typeof useTarotClaim>; suspended?: boolean; pickerOpen?: boolean; headerWalletOpen?: boolean;
}) {
  const { visible: walletModalVisible } = useWalletModal();
  const eligible = Boolean(model?.status && !model.status.claimed && model.status.config.enabled);
  const { cardRef, receiptRef, receiptState, compact, transitioning, animateCard } =
    useTarotCardTransition(eligible, suspended || walletModalVisible || pickerOpen || headerWalletOpen);
  const initialScrollPending = useRef(true);
  useEffect(() => {
    if (walletModalVisible || pickerOpen || headerWalletOpen || !initialScrollPending.current) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0 });
      initialScrollPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [walletModalVisible, pickerOpen, headerWalletOpen]);

  return <>
    {header}
    <main className={`nfc-claim-page nfc-tarot-page${compact ? '' : ' nfc-claim-page--artwork'}${transitioning ? ' nfc-claim-page--entering' : ''}`}
      aria-label={compact ? 'NFC claim' : 'Tarot card'}>
      {compact && <h1 className="nfc-claim-page__title nfc-claim-reveal">You got 2 NFTs:</h1>}
      <ul className="nfc-claim-nfts" aria-label={compact ? 'Your NFTs' : undefined} role={compact ? 'list' : 'presentation'}>
        <li className="nfc-claim-nft" role={compact ? undefined : 'presentation'}>
          <NfcTarotCard tokenId={tokenId} heroRef={cardRef} animate={animateCard} />
          {compact && <div className="nfc-claim-nft__copy nfc-claim-reveal"><h2>Mutating Card</h2><p>Evolve it and get it physically delivered when you’re ready.</p></div>}
        </li>
        {eligible && <li className="nfc-claim-nft nfc-claim-reveal" hidden={!compact}>
          <img ref={receiptRef} className="nfc-claim-nft__image--certificate nfc-tarot-receipt"
            data-ready={receiptState === 'ready'} hidden={receiptState === 'failed'}
            src={`https://wip.lil.org/dmx/receipts/${tokenId}.webp`}
            alt="NFC Card Receipt" width={1400} height={1400} style={{ aspectRatio: '1 / 1' }}
            loading="eager" decoding="async" draggable={false} referrerPolicy="no-referrer" />
          {receiptState === 'failed' && <span className="nfc-claim-nft__image--certificate nfc-tarot-receipt__fallback">
            Receipt image unavailable
          </span>}
          <div className="nfc-claim-nft__copy"><h2>NFC Card Receipt</h2><p>Proves the authenticity of the physical card you just scanned.</p></div>
        </li>}
      </ul>
      {compact && model && <div className="nfc-tarot-page__action nfc-claim-reveal">
        <button type="button" className="nfc-claim-button" onClick={transitioning ? undefined : model.claim}
          inert={transitioning} disabled={model.pending || model.loading || model.coolingDown || suspended || walletModalVisible}>
          {model.submitted ? 'Claiming…' : model.connecting ? 'Connecting…' : model.pending ? 'Confirm in wallet…' : model.coolingDown ? 'Please wait…' : 'Claim'}
        </button>
      </div>}
    </main>
  </>;
}

function TarotClaimPage({ request, wallet, header, suspended = false, headerWalletOpen, onModalOpenChange }: Omit<Props, 'link'> & { request: TarotRequest }) {
  const model = useTarotClaim(request, wallet, suspended);
  const pickerOpen = wallet.status === 'choosing' && !model.status?.claimed;
  useLayoutEffect(() => { onModalOpenChange?.(pickerOpen && !suspended); }, [pickerOpen, suspended, onModalOpenChange]);
  useLayoutEffect(() => () => { onModalOpenChange?.(false); }, [onModalOpenChange]);

  return <>
    <TarotCardPage tokenId={request.tokenId} header={header} model={model} suspended={suspended} pickerOpen={pickerOpen} headerWalletOpen={headerWalletOpen} />
    <EthereumWalletPicker wallet={wallet} suspended={suspended} onClose={model.connecting ? model.cancel : wallet.cancel} />
  </>;
}

export function NfcPage({ link, ...props }: Props) {
  if (link.kind === 'placeholder') return <>{props.header}<NfcClaimPage /></>;
  if (link.kind === 'invalid') return <>{props.header}<main className="nfc-claim-page" aria-label="NFC claim">
    <p className="nfc-claim-error" role="alert">This Tarot claim link is invalid.</p>
  </main></>;
  if (link.kind === 'artwork') return <TarotCardPage key={link.key} tokenId={link.tokenId} header={props.header} suspended={props.suspended} headerWalletOpen={props.headerWalletOpen} />;
  return <TarotClaimPage key={link.key} {...props} request={link.request} />;
}
