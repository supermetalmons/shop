import { useCallback } from 'react';
import { Modal } from './Modal';
import { NotifyForm } from './NotifyForm';

interface NotifySubscriptionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubscribed: (announcement: string) => void;
  suspended?: boolean;
}

export function NotifySubscription({
  open,
  onOpenChange,
  onSubscribed,
  suspended = false,
}: NotifySubscriptionProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleSuccess = useCallback(() => {
    close();
    onSubscribed('You’re on the list.');
  }, [close, onSubscribed]);

  return (
    <Modal
      open={open}
      title="Notify me"
      onClose={close}
      className="compact-modal notify-modal"
      overlayClassName="notify-modal-overlay"
      blurBackground
      showCloseButton={false}
      suspended={suspended}
    >
      <NotifyForm onSuccess={handleSuccess} onCancel={close} />
    </Modal>
  );
}
