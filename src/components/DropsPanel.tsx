import { isDropFamily } from '../config/deployment';
import { navigate } from '../navigation';
import { resolveDropContent } from '../lib/dropContent';
import { dropPath, listFrontendDrops } from '../lib/dropConfig';

const lsbContent = resolveDropContent('little_swag_boxes');
const lsbBase = lsbContent.box.previewImageUrl?.replace(/\/[^/]+$/, '');
const lsbImage = lsbBase ? `${lsbBase}/default.webp` : undefined;
const ponchoImage = resolveDropContent('poncho_drifella').box.previewImageUrl;
const hoodieDrops = listFrontendDrops().filter((drop) => isDropFamily(drop, 'lsw_cobalt_figure_hoodie'));
const hoodieDrop = hoodieDrops.find((drop) => drop.solanaCluster === 'mainnet-beta') ?? hoodieDrops[0];
const hoodieImage = hoodieDrop ? resolveDropContent(hoodieDrop.dropId).box.previewImageUrl : undefined;

type DropsPanelProps = {
  showHoodieOnMain?: boolean;
};

type DropPanelItem = {
  key: string;
  image?: string;
  alt: string;
  label: string;
  path: string;
};

function DropPanelCard({ item, isOrphan }: { item: DropPanelItem; isOrphan?: boolean }) {
  return (
    <div className={`drops-panel__drop${isOrphan ? ' drops-panel__drop--orphan' : ''}`}>
      <div className="drops-panel__image-wrap">
        {item.image ? (
          <img
            className="drops-panel__image"
            src={item.image}
            alt={item.alt}
            draggable={false}
            onDragStart={(evt) => evt.preventDefault()}
          />
        ) : (
          <div className="drops-panel__image drops-panel__image--placeholder" />
        )}
      </div>
      <div className="drops-panel__cta">
        <button
          type="button"
          className="drops-panel__link"
          onClick={() => navigate(item.path)}
        >
          <span className="drops-panel__link-text">{item.label}</span>
        </button>
      </div>
    </div>
  );
}

export function DropsPanel({ showHoodieOnMain = false }: DropsPanelProps) {
  const items: DropPanelItem[] = [
    {
      key: 'little_swag_boxes',
      image: lsbImage,
      alt: 'Little Swag Boxes',
      label: 'Little Swag Boxes',
      path: dropPath('little_swag_boxes'),
    },
    {
      key: 'poncho_drifella',
      image: ponchoImage,
      alt: 'Poncho Drifella',
      label: 'Poncho Drifella',
      path: dropPath('poncho_drifella'),
    },
  ];
  if (showHoodieOnMain && hoodieDrop) {
    items.push({
      key: hoodieDrop.dropId,
      image: hoodieImage,
      alt: 'lsw cobalt figure hoodie 26',
      label: 'lsw cobalt figure hoodie 26',
      path: dropPath(hoodieDrop.dropId),
    });
  }

  return (
    <section className="card drops-panel">
      <div className="drops-panel__grid">
        {items.map((item, index) => (
          <DropPanelCard
            key={item.key}
            item={item}
            isOrphan={items.length > 1 && items.length % 2 === 1 && index === items.length - 1}
          />
        ))}
      </div>
    </section>
  );
}
