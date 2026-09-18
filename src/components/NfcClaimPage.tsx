import { useEffect, useRef } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { NfcMutatingCard } from './NfcMutatingCard';

const NFT_PREVIEWS = [
  {
    title: 'Mutating Card',
    description: "Evolve it and get it physically delivered when you're ready.",
    animated: true,
    width: 805,
    height: 1280,
  },
  {
    title: 'NFC Card Receipt',
    description: 'Proves the authenticity of the physical card you just scanned.',
    src: 'https://wip.lil.org/zero10_certificate_2.webp',
    imageClassName: 'nfc-claim-nft__image--certificate',
    width: 1254,
    height: 1254,
  },
];

export function NfcClaimPage() {
  const { visible: walletModalVisible } = useWalletModal();
  const initialScrollPendingRef = useRef(true);

  useEffect(() => {
    if (walletModalVisible || !initialScrollPendingRef.current) return;
    const frameId = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0 });
      initialScrollPendingRef.current = false;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [walletModalVisible]);

  const openPlaceholderVideo = () => {
    window.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="nfc-claim-page" aria-label="NFC claim">
      <h1 className="nfc-claim-page__title">You got 2 NFTs:</h1>
      <ul className="nfc-claim-nfts" aria-label="Your NFTs" role="list">
        {NFT_PREVIEWS.map((nft) => (
          <li className="nfc-claim-nft" key={nft.title}>
            {nft.animated ? (
              <NfcMutatingCard alt={nft.title} width={nft.width} height={nft.height} />
            ) : (
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
            )}
            <div className="nfc-claim-nft__copy">
              <h2>{nft.title}</h2>
              <p>{nft.description}</p>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="nfc-claim-button" onClick={openPlaceholderVideo}>Claim</button>
    </main>
  );
}
