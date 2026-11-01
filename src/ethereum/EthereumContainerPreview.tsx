import type { EthereumContainerKind } from '../../shared/ethereum/protocol';
import type { PrimaryMediaControls } from '../components/MediaWithFallback';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';

type EthereumContainerPreviewProps = Pick<PrimaryMediaControls, 'hidden' | 'onReady' | 'onError'> & {
  kind: EthereumContainerKind;
  className?: string;
};

export function EthereumContainerPreview({ kind, className, hidden, onReady, onError }: EthereumContainerPreviewProps) {
  const media = ETHEREUM_CONTAINER_MEDIA[kind];
  return <img
    className={className}
    src={media.src}
    width={media.width}
    height={media.height}
    alt={`111K ${kind}`}
    hidden={hidden}
    draggable={false}
    onDragStart={event => event.preventDefault()}
    ref={image => { if (image?.complete && image.naturalWidth > 0) onReady(); }}
    onLoad={onReady}
    onError={onError}
  />;
}
