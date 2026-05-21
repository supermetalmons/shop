import { navigate } from '../navigation';
import { mintPanelPreviewImage, resolveDropContent } from '../lib/dropContent';
import { dropPath, listUpcomingDropRoutes, resolveUpcomingRouteDrop } from '../lib/dropConfig';

const lsbImage = mintPanelPreviewImage('little_swag_boxes');
const ponchoImage = mintPanelPreviewImage('poncho_drifella');
const upcomingDropItems = listUpcomingDropRoutes().map((route) => {
  const liveDrop = resolveUpcomingRouteDrop(route);
  const previewDropId = liveDrop?.dropId || route.previewDropId;
  return {
    key: `upcoming:${route.path}`,
    image: previewDropId ? resolveDropContent(previewDropId).box.previewImageUrl : undefined,
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

function DropPanelCard({ item, isOrphan }: { item: DropPanelItem; isOrphan?: boolean }) {
  return (
    <div className={`drops-panel__drop${isOrphan ? ' drops-panel__drop--orphan' : ''}`}>
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

  const gridClassName = `drops-panel__grid${items.length > 1 ? ' drops-panel__grid--compact' : ''}`;

  return (
    <section className="drops-panel">
      <div className={gridClassName}>
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
