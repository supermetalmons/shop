import type { EthereumMintKind } from '../../shared/ethereum/protocol';
import type { PrimaryMediaControls } from '../components/MediaWithFallback';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';

type EthereumContainerPreviewProps = Pick<PrimaryMediaControls, 'hidden' | 'onReady' | 'onError'> & {
  kind: EthereumMintKind;
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
