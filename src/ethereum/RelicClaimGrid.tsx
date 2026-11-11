import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ETHEREUM_MAX_RELICS, type EthereumMetadata } from '../../shared/ethereum/protocol';
import { MediaWithFallback } from '../components/MediaWithFallback';
import { relicDisplayMedia } from './relicMedia';

type RelicClaimGridProps = {
  metadata?: readonly EthereumMetadata[];
  claimedMask: number;
  selectedId: number | null;
  disabled: boolean;
  attentionToken?: number;
  onAttentionEnd?: (token: number) => void;
  onSelect: (id: number | null) => void;
};

function layout(width: number, height: number, gap: number) {
  let best = { size: 1, columns: 6, gap };
  for (let columns = 1; columns <= ETHEREUM_MAX_RELICS; columns++) {
    const rows = Math.ceil(ETHEREUM_MAX_RELICS / columns);
    const size = Math.floor(Math.min((width - (columns - 1) * gap) / columns, (height - (rows - 1) * gap) / rows));
    if (size > best.size || size === best.size && rows < Math.ceil(ETHEREUM_MAX_RELICS / best.columns)) {
      best = { size, columns, gap };
    }
  }
  return best;
}

export function RelicClaimGrid({ metadata, claimedMask, selectedId, disabled, attentionToken = 0, onAttentionEnd, onSelect }: RelicClaimGridProps) {
  const preview = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ size: 44, columns: 6, gap: 4 });
  useLayoutEffect(() => {
    const element = preview.current;
    if (!element) return;
    const update = () => {
      const style = window.getComputedStyle(element);
      const padding = (value: string) => Number.parseFloat(value) || 0;
      const width = element.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight);
      const height = element.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom);
      if (width <= 0 || height <= 0) return;
      const gap = window.innerWidth <= 860 ? 12 : 24;
      const preferred = layout(width, height, gap);
      const next = preferred.size >= 44 ? preferred : layout(width, height, gap / 3);
      setGeometry(previous => previous.size === next.size && previous.columns === next.columns && previous.gap === next.gap ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  return <div ref={preview} className="mint-panel__preview ethereum111k__relic-preview">
    <div className="ethereum111k__relic-grid" role="radiogroup" aria-label="Choose a relic"
      style={{ '--relic-size': `${geometry.size}px`, '--relic-columns': geometry.columns, '--relic-gap': `${geometry.gap}px` } as CSSProperties}>
      {Array.from({ length: ETHEREUM_MAX_RELICS }, (_, index) => {
        const id = index + 1;
        const claimed = (claimedMask & (1 << index)) !== 0;
        const image = metadata?.[index]?.image;
        const media = relicDisplayMedia(image);
        const source = media?.src ?? image;
        return <label key={id} className="ethereum111k__relic" data-claimed={claimed} data-disabled={disabled || claimed}>
          <input type="radio" name="ethereum-relic" value={id} checked={selectedId === id}
            disabled={disabled || claimed} aria-label={`Relic #${id}${claimed ? ', claimed' : ''}`}
            onClick={() => { if (selectedId === id) onSelect(null); }}
            onChange={() => onSelect(id)} />
          <span className="ethereum111k__relic-image">
            {attentionToken > 0 && selectedId === null && !disabled && !claimed && <span key={attentionToken}
              className="ethereum111k__relic-attention" aria-hidden="true" onAnimationEnd={() => onAttentionEnd?.(attentionToken)} />}
            <MediaWithFallback imageSources={source ? [source] : []} showPlaceholderWhileLoading
              imageProps={{ alt: '', width: media?.width, height: media?.height, draggable: false, loading: 'eager', decoding: 'async', onDragStart: event => event.preventDefault() }}
              renderPlaceholder={hidden => <span hidden={hidden} className="ethereum111k__relic-placeholder" aria-hidden="true" />} />
          </span>
        </label>;
      })}
    </div>
    <span className="ethereum111k__relic-feedback" role="status" aria-atomic="true">
      {attentionToken > 0 && selectedId === null && !disabled ? 'Choose an available relic.' : ''}
    </span>
  </div>;
}
