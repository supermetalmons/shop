import { navigate } from '../navigation';
import { resolveDropContent } from '../lib/dropContent';

const lsbContent = resolveDropContent('little_swag_boxes');
const lsbBase = lsbContent.box.previewImageUrl?.replace(/\/[^/]+$/, '');
const lsbImage = lsbBase ? `${lsbBase}/default.webp` : undefined;
const ponchoImage = resolveDropContent('poncho_drifella_devnet').box.previewImageUrl;

export function DropsPanel() {
  return (
    <section className="card drops-panel">
      <div className="drops-panel__grid">
        <div className="drops-panel__drop">
          <div className="drops-panel__image-wrap">
            {lsbImage ? (
              <img className="drops-panel__image" src={lsbImage} alt="Little Swag Boxes" />
            ) : (
              <div className="drops-panel__image drops-panel__image--placeholder" />
            )}
          </div>
          <div className="drops-panel__cta">
            <button
              type="button"
              className="drops-panel__link"
              onClick={() => navigate('/little_swag_boxes')}
            >
              <span className="drops-panel__link-text">Little Swag Boxes</span>
            </button>
          </div>
        </div>
        <div className="drops-panel__drop">
          <div className="drops-panel__image-wrap">
            {ponchoImage ? (
              <img className="drops-panel__image" src={ponchoImage} alt="Poncho Drifella" />
            ) : (
              <div className="drops-panel__image drops-panel__image--placeholder" />
            )}
          </div>
          <div className="drops-panel__cta">
            <button
              type="button"
              className="drops-panel__link"
              onClick={() => navigate('/notify-me')}
            >
              <span className="drops-panel__link-text">Poncho Drifella</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
