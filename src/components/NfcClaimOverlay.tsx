import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { navigate } from '../navigation';
import { Modal } from './Modal';

const NFT_PREVIEWS = [
  {
    title: 'Gen 0 Card Certificate',
    description: 'Proves the authenticity of your physical card.',
    src: 'https://wip.lil.org/zero10_certificate.webp',
    width: 1254,
    height: 1254,
  },
  {
    title: 'Gen 1 Card',
    description: 'Evolve it and get it physically delivered.',
    src: 'https://wip.lil.org/zero10_card.webp',
    width: 836,
    height: 1280,
  },
];

export function NfcClaimOverlay() {
  const { publicKey } = useWallet();
  const { visible, setVisible } = useWalletModal();
  const [ready, setReady] = useState(!visible);
  const defaultRecipient = publicKey?.toBase58() || '';
  const recipientTouchedRef = useRef(false);
  const [recipient, setRecipient] = useState('');

  useLayoutEffect(() => {
    if (visible) setVisible(false);
    else setReady(true);
  }, [setVisible, visible]);

  useEffect(() => {
    if (recipientTouchedRef.current || !defaultRecipient) return;
    setRecipient((current) => current || defaultRecipient);
  }, [defaultRecipient]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    window.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer');
  };

  return (
    <Modal
      open={ready}
      title="You got 2 NFTs"
      ariaLabel="NFC claim"
      onClose={() => navigate('/', { replace: true })}
      className="nfc-claim-modal"
      overlayClassName="nfc-claim-overlay"
      showCloseButton={false}
      blurBackground
      suspended={visible}
      focusTarget="scope"
    >
      <ul className="nfc-claim-nfts" aria-label="Your NFTs" role="list">
        {NFT_PREVIEWS.map((nft) => (
          <li className="nfc-claim-nft" key={nft.title}>
            <img
              src={nft.src}
              alt={nft.title}
              width={nft.width}
              height={nft.height}
              style={{ aspectRatio: `${nft.width} / ${nft.height}` }}
              decoding="async"
              draggable={false}
            />
            <div className="nfc-claim-nft__copy">
              <h2>{nft.title}</h2>
              <p>{nft.description}</p>
            </div>
          </li>
        ))}
      </ul>
      <form className="modal-form nfc-claim-form" onSubmit={submit} noValidate>
        <input
          value={recipient}
          onChange={(event) => {
            recipientTouchedRef.current = true;
            setRecipient(event.target.value);
          }}
          placeholder="Solana address"
          aria-label="Solana address"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button type="submit">Claim</button>
      </form>
    </Modal>
  );
}
