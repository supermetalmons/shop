import { navigate } from '../navigation';
import { mintPanelPreviewImage, resolveDropContent } from '../lib/dropContent';
import { dropPath, listUpcomingDropRoutes, resolveUpcomingRouteDrop } from '../lib/dropConfig';

const lsbImage = mintPanelPreviewImage('little_swag_boxes');
const ponchoImage = mintPanelPreviewImage('poncho_drifella');
const upcomingDropItems = listUpcomingDropRoutes().map((route) => {
  const liveDrop = resolveUpcomingRouteDrop(route);
  const previewDropId = liveDrop?.dropId || route.previewDropId;
  const dropContent = previewDropId ? resolveDropContent(previewDropId) : undefined;
  return {
    key: `upcoming:${route.path}`,
    image: dropContent?.box.previewImageUrl || route.previewImageUrl,
    alt: route.label,
    label: route.label,
    path: route.path,
  };
});

type DropPanelItem = {
  key: string;
  image?: string;
  alt: string;
  label: string;
  path: string;
  previewScale?: number;
};

function DropPanelCard({ item }: { item: DropPanelItem }) {
  return (
    <div className="drops-panel__drop">
      <div className="drops-panel__image-wrap">
        {item.image ? (
          <img
            className="drops-panel__image"
            src={item.image}
            alt={item.alt}
            style={item.previewScale ? { transform: `scale(${item.previewScale})` } : undefined}
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

export function DropsPanel() {
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
      previewScale: 0.92,
    },
    ...upcomingDropItems,
  ];

  return (
    <section className="drops-panel">
      <div className="drops-panel__grid">
        {items.map((item) => (
          <DropPanelCard
            key={item.key}
            item={item}
          />
        ))}
      </div>
    </section>
  );
}
