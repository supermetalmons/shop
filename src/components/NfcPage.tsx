import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { TarotRequest } from '../../shared/ethereum/tarot';
import type { NfcLink } from '../ethereum/tarotLink';
import type { EthereumWallet } from '../ethereum/useEthereum111k';
import { useTarotClaim } from '../ethereum/useTarotClaim';
import { EthereumWalletPicker } from '../ethereum/EthereumWalletPicker';
import { NfcClaimPage } from './NfcClaimPage';

type Props = {
  link: NfcLink; wallet: EthereumWallet; header?: ReactNode; suspended?: boolean;
  onModalOpenChange?: (open: boolean) => void;
};

function TarotCard({ tokenId, large = false }: { tokenId: number; large?: boolean }) {
  return <img className={large ? 'nfc-tarot-card nfc-tarot-card--large' : 'nfc-tarot-card'}
    src={`https://wip.lil.org/tarot/bases/${tokenId}.webp`} alt="Mutating Card" width={881} height={1400}
    style={{ aspectRatio: '881 / 1400' }} decoding="async" draggable={false} referrerPolicy="no-referrer" />;
}

function TarotClaimPage({ request, wallet, header, suspended = false, onModalOpenChange }: Omit<Props, 'link'> & { request: TarotRequest }) {
  const model = useTarotClaim(request, wallet, suspended);
  const { visible: walletModalVisible } = useWalletModal();
  const initialScrollPending = useRef(true);
  const pickerOpen = wallet.status === 'choosing' && !model.status?.claimed;
  useLayoutEffect(() => { onModalOpenChange?.(pickerOpen && !suspended); }, [pickerOpen, suspended, onModalOpenChange]);
  useLayoutEffect(() => () => { onModalOpenChange?.(false); }, [onModalOpenChange]);
  useEffect(() => {
    if (walletModalVisible || pickerOpen || !initialScrollPending.current) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0 });
      initialScrollPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [walletModalVisible, pickerOpen]);

  if (model.status?.claimed) return <>
    {header}
    <main className="nfc-claim-page nfc-claim-page--claimed" aria-label="Tarot card">
      <TarotCard tokenId={request.tokenId} large />
    </main>
  </>;
  if (!model.status) return <>
    {header}
    <main className="nfc-claim-page" aria-label="NFC claim" aria-busy={model.loading}>
      {model.error ? <p className="nfc-claim-error" role="alert">{model.error}</p> : null}
    </main>
  </>;

  return <>
    {header}
    <main className="nfc-claim-page" aria-label="NFC claim">
      <h1 className="nfc-claim-page__title">You got 2 NFTs:</h1>
      <ul className="nfc-claim-nfts" aria-label="Your NFTs" role="list">
        <li className="nfc-claim-nft">
          <TarotCard tokenId={request.tokenId} />
          <div className="nfc-claim-nft__copy"><h2>Mutating Card</h2><p>Evolve it and get it physically delivered when you’re ready.</p></div>
        </li>
        <li className="nfc-claim-nft">
          <img className="nfc-claim-nft__image--certificate" src={`https://wip.lil.org/tarot/receipts/${request.tokenId}.webp`}
            alt="NFC Card Receipt" width={1400} height={1400} style={{ aspectRatio: '1 / 1' }}
            decoding="async" draggable={false} referrerPolicy="no-referrer" />
          <div className="nfc-claim-nft__copy"><h2>NFC Card Receipt</h2><p>Proves the authenticity of the physical card you just scanned.</p></div>
        </li>
      </ul>
      <button type="button" className="nfc-claim-button" onClick={model.claim}
        disabled={model.pending || model.loading || model.coolingDown || suspended || walletModalVisible || !model.status.config.enabled}>
        {model.submitted ? 'Claiming…' : model.connecting ? 'Connecting…' : model.pending ? 'Confirm in wallet…' : 'Claim'}
      </button>
      {model.error ? <p className="nfc-claim-error" role="alert">{model.error}</p> : null}
    </main>
    <EthereumWalletPicker wallet={wallet} suspended={suspended} onClose={model.connecting ? model.cancel : wallet.cancel} />
  </>;
}

export function NfcPage({ link, ...props }: Props) {
  if (link.kind === 'placeholder') return <>{props.header}<NfcClaimPage /></>;
  if (link.kind === 'invalid') return <>{props.header}<main className="nfc-claim-page" aria-label="NFC claim">
    <p className="nfc-claim-error" role="alert">This Tarot claim link is invalid.</p>
  </main></>;
  return <TarotClaimPage key={link.key} {...props} request={link.request} />;
}
