import { useCallback } from 'react';
import type { SubscribeToNotificationsRequest } from '../types';
import { Modal } from './Modal';
import { NotifyForm } from './NotifyForm';

interface NotifySubscriptionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubscribed: (announcement: string) => void;
  dropFamily?: SubscribeToNotificationsRequest['dropFamily'];
  suspended?: boolean;
}

export function NotifySubscription({
  open,
  onOpenChange,
  onSubscribed,
  dropFamily,
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
      <NotifyForm dropFamily={dropFamily} onSuccess={handleSuccess} onCancel={close} />
    </Modal>
  );
}
