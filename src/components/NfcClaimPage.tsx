import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

const NFT_PREVIEWS = [
  {
    title: 'Gen 0 Card Certificate',
    description: 'Proves the authenticity of your physical card.',
    src: 'https://wip.lil.org/zero10_certificate_2.webp',
    width: 1254,
    height: 1254,
  },
  {
    title: 'Gen 1 Card',
    description: 'Evolve it and get it physically delivered.',
    src: 'https://wip.lil.org/zero10_card.webp',
    imageClassName: 'nfc-claim-nft__image--card',
    width: 836,
    height: 1280,
  },
];

export function NfcClaimPage() {
  const { publicKey } = useWallet();
  const { visible: walletModalVisible } = useWalletModal();
  const defaultRecipient = publicKey?.toBase58() || '';
  const recipientTouchedRef = useRef(false);
  const initialScrollPendingRef = useRef(true);
  const [recipient, setRecipient] = useState('');

  useEffect(() => {
    if (walletModalVisible || !initialScrollPendingRef.current) return;
    const frameId = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0 });
      initialScrollPendingRef.current = false;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [walletModalVisible]);

  useEffect(() => {
    if (recipientTouchedRef.current || !defaultRecipient) return;
    setRecipient((current) => current || defaultRecipient);
  }, [defaultRecipient]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    window.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="nfc-claim-page" aria-label="NFC claim">
      <h1 className="nfc-claim-page__title">You got 2 NFTs</h1>
      <ul className="nfc-claim-nfts" aria-label="Your NFTs" role="list">
        {NFT_PREVIEWS.map((nft) => (
          <li className="nfc-claim-nft" key={nft.title}>
            <img
              className={nft.imageClassName}
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
      <form className="nfc-claim-form" onSubmit={submit} noValidate>
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
    </main>
  );
}
