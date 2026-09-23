import type { ReactNode } from 'react';
import type { FigureMediaConfig, FrontendDeploymentConfig } from '../config/deployment';
import { useFigureImage } from '../hooks/useFigureImage';
import { resolveDropContent } from '../lib/dropContent';
import type { FigureMetadataRecord } from '../lib/figureMetadata';
import { resolveFulfillmentFigurePreview, type FulfillmentFigureLabelOverrideArgs } from '../lib/fulfillmentLabels';

export function FulfillmentImage(props: {
  src?: string | null;
  alt: string;
  aspectRatio: number;
  onError?: () => void;
}) {
  return (
    <span className="fulfillment-image-frame" style={{ aspectRatio: props.aspectRatio }}>
      {props.src ? (
        <img
          src={props.src}
          alt={props.alt}
          loading="lazy"
          draggable={false}
          className="figure-image"
          onError={props.onError}
        />
      ) : (
        <span className="figure-image figure-image--placeholder" aria-hidden="true" />
      )}
    </span>
  );
}

function FigureTileImage(props: {
  dropId: string;
  figureId: number;
  alt: string;
  aspectRatio: number;
  primarySrc?: string;
  fallbackSrc?: string;
}) {
  const { activeSrc, handleError } = useFigureImage(props);

  return <FulfillmentImage src={activeSrc} alt={props.alt} aspectRatio={props.aspectRatio} onError={handleError} />;
}

export function FulfillmentFigureTiles(args: {
  drop?: FrontendDeploymentConfig | null;
  dropId: string;
  figureIds: number[];
  keyPrefix: string;
  figureNamePrefix?: string;
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  figureMediaBase?: string;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
  renderFooter?: (args: { figureId: number; index: number }) => ReactNode;
}) {
  const {
    dropId,
    figureIds,
    keyPrefix,
    drop,
    figureNamePrefix,
    previewMode,
    figureMedia,
    figureMediaBase,
    figureMetadataByKey,
    labelOverride,
    renderFooter,
  } = args;
  const aspectRatio = resolveDropContent(drop || dropId).figures.fulfillmentAspectRatio;
  return (
    <div className="figure-grid">
      {figureIds.map((figureId, index) => {
        const preview = resolveFulfillmentFigurePreview({
          dropId,
          drop: drop || { dropId, figureNamePrefix, figureMedia },
          figureId,
          index,
          previewMode,
          figureMediaBase,
          figureMetadataByKey,
          labelOverride,
        });
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            <FigureTileImage
              dropId={dropId}
              figureId={figureId}
              primarySrc={preview.primarySrc}
              fallbackSrc={preview.fallbackSrc}
              alt={preview.alt}
              aspectRatio={aspectRatio}
            />
            <span className="muted small">{preview.label}</span>
            {renderFooter?.({ figureId, index })}
          </div>
        );
      })}
    </div>
  );
}
