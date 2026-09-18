import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { shouldAutoFocusFormControl } from '../lib/focusTrap';
import { navigate } from '../navigation';
import { Modal } from './Modal';

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
      title="NFC claim"
      onClose={() => navigate('/', { replace: true })}
      className="nfc-claim-modal"
      overlayClassName="nfc-claim-overlay"
      showCloseButton={false}
      blurBackground
      suspended={visible}
      focusTarget={shouldAutoFocusFormControl() ? 'first-control' : 'scope'}
    >
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
