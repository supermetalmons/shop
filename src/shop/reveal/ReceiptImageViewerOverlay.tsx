import { FaBoxOpen } from 'react-icons/fa6';
import { MediaWithFallback } from '../../components/MediaWithFallback';
import { MediaViewerOverlay } from './MediaViewerOverlay';
import { ReceiptImageViewerOverlayProps, ReceiptViewerImageShellStyle } from './types';

export function ReceiptImageViewerOverlay({
  dropId,
  overlayStyle,
  active,
  closing,
  suspended = false,
  images,
  imageSrc,
  alt,
  viewerSize = 'receipt',
  explorerHref,
  onDismiss,
  transfer,
  adminIrlRedeem,
  onTransitionEnd,
}: ReceiptImageViewerOverlayProps) {
  const interactionSuspended = closing || suspended;
  const receiptImages = images?.length ? images : [{ key: 'receipt-image', name: alt, image: imageSrc }];
  const multiReceiptClass = receiptImages.length > 1 ? ' receipt-viewer-overlay__image-shell--multi' : '';
  const imageShellStyle: ReceiptViewerImageShellStyle | undefined =
    receiptImages.length > 1
      ? { '--receipt-viewer-count': String(receiptImages.length) }
      : undefined;
  return (
    <MediaViewerOverlay name={alt} resetKey={imageSrc} active={active} closing={closing} suspended={suspended}
      className={`receipt-viewer-overlay receipt-viewer-overlay--${viewerSize}`} style={overlayStyle}
      onDismiss={onDismiss} onTransitionEnd={onTransitionEnd}
      controls={explorerHref || transfer || adminIrlRedeem ? (
        <div
          className="receipt-viewer-overlay__controls"
          data-viewer-dismiss-ignore
          inert={interactionSuspended || undefined}
          onClick={(evt) => evt.stopPropagation()}
        >
          {adminIrlRedeem ? (
            <div className="receipt-viewer-overlay__admin-irl">
              <button
                type="button"
                className="ghost receipt-viewer-overlay__admin-irl-button"
                disabled={interactionSuspended || adminIrlRedeem.loading}
                aria-busy={adminIrlRedeem.loading}
                onClick={(evt) => {
                  evt.stopPropagation();
                  if (interactionSuspended) return;
                  adminIrlRedeem.onClick();
                }}
              >
                <FaBoxOpen aria-hidden="true" focusable="false" size={16} />
                <span>{adminIrlRedeem.loading ? 'Redeeming…' : 'Admin IRL Redeem'}</span>
              </button>
            </div>
          ) : null}
          {explorerHref || transfer ? (
            <div className="receipt-viewer-overlay__actions">
              {explorerHref ? (
                <a
                  className="receipt-viewer-overlay__action receipt-viewer-overlay__explorer-link"
                  href={explorerHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on explorer
                </a>
              ) : null}
              {transfer ? (
                <button
                  type="button"
                  className="receipt-viewer-overlay__action receipt-viewer-overlay__transfer-button"
                  disabled={interactionSuspended || transfer.disabled}
                  aria-disabled={interactionSuspended || transfer.disabled || transfer.unavailable || undefined}
                  aria-busy={transfer.busy || undefined}
                  onClick={(evt) => {
                    evt.stopPropagation();
                    if (interactionSuspended || transfer.disabled) return;
                    transfer.onClick(evt.currentTarget);
                  }}
                >
                  {transfer.label || 'Transfer'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    >
        <div className={`receipt-viewer-overlay__image-shell${multiReceiptClass}`} style={imageShellStyle}>
          {receiptImages.map((receiptImage, index) => (
            <div className="receipt-viewer-overlay__image-frame" key={`${receiptImage.key}:${index}`}>
              <MediaWithFallback
                dropId={dropId}
                imageSources={receiptImage.image ? [receiptImage.image] : []}
                imageProps={{
                  alt: receiptImage.name || alt,
                  className: 'receipt-viewer-overlay__image',
                  draggable: false,
                }}
                renderPlaceholder={(hidden) => (
                  <div className="receipt-viewer-overlay__image receipt-viewer-overlay__image--placeholder" hidden={hidden} aria-hidden="true" />
                )}
              />
            </div>
          ))}
        </div>
    </MediaViewerOverlay>
  );
}
