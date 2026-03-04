import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './drif.css';
const HOLO_TEXTURE = '/drif/layers/7-holo-texture.webp';
const CARD_LAYERS = [
  '/drif/layers/1-bottom-layer.webp',
  '/drif/layers/2-under-holo.webp',
  '/drif/layers/3-dratini-sprites.webp',
  '/drif/layers/4-egg.webp',
  '/drif/layers/5-sparkle.webp',
  '/drif/layers/6-poncho-drif.webp',
];

function round(value: number, precision = 3) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function adjust(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
  return round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
}

type SpringVec2 = { x: number; y: number };
type SpringVec3 = { x: number; y: number; o: number };
type SpringValue = number | SpringVec2 | SpringVec3;

type SpringSetOptions = {
  hard?: boolean;
  soft?: boolean | number;
};

type TickContext = {
  inv_mass: number;
  opts: {
    stiffness: number;
    damping: number;
    precision: number;
  };
  settled: boolean;
  dt: number;
};

type SpringState<T extends SpringValue> = {
  current: T;
  target: T;
  last: T;
  stiffness: number;
  damping: number;
  precision: number;
  invMass: number;
  invMassRecoveryRate: number;
};

function cloneSpringValue<T extends SpringValue>(value: T): T {
  if (typeof value === 'number') return value;
  return { ...(value as Record<string, number>) } as T;
}

function tickSpring(ctx: TickContext, lastValue: SpringValue, currentValue: SpringValue, targetValue: SpringValue): SpringValue {
  if (typeof currentValue === 'number') {
    const delta = (targetValue as number) - currentValue;
    const velocity = (currentValue - (lastValue as number)) / (ctx.dt || 1 / 60);
    const spring = ctx.opts.stiffness * delta;
    const damper = ctx.opts.damping * velocity;
    const acceleration = (spring - damper) * ctx.inv_mass;
    const displacement = (velocity + acceleration) * ctx.dt;

    if (Math.abs(displacement) < ctx.opts.precision && Math.abs(delta) < ctx.opts.precision) {
      return targetValue;
    }
    ctx.settled = false;
    return currentValue + displacement;
  }

  if (typeof currentValue === 'object' && currentValue) {
    const nextValue: Record<string, number> = {};
    Object.keys(currentValue).forEach((key) => {
      nextValue[key] = tickSpring(
        ctx,
        (lastValue as Record<string, number>)[key],
        (currentValue as Record<string, number>)[key],
        (targetValue as Record<string, number>)[key],
      ) as number;
    });
    return nextValue as SpringValue;
  }

  throw new Error(`Cannot spring ${typeof currentValue} values`);
}

function createSpring<T extends SpringValue>(
  value: T,
  opts: {
    stiffness: number;
    damping: number;
    precision?: number;
  },
): SpringState<T> {
  return {
    current: cloneSpringValue(value),
    target: cloneSpringValue(value),
    last: cloneSpringValue(value),
    stiffness: opts.stiffness,
    damping: opts.damping,
    precision: opts.precision ?? 0.01,
    invMass: 1,
    invMassRecoveryRate: 0,
  };
}

function setSpringTarget<T extends SpringValue>(spring: SpringState<T>, newValue: T, opts: SpringSetOptions = {}) {
  spring.target = cloneSpringValue(newValue);

  if (opts.hard || (spring.stiffness >= 1 && spring.damping >= 1)) {
    spring.last = cloneSpringValue(newValue);
    spring.current = cloneSpringValue(newValue);
    return;
  }

  if (opts.soft) {
    const rate = opts.soft === true ? 0.5 : Number(opts.soft);
    spring.invMassRecoveryRate = 1 / (rate * 60);
    spring.invMass = 0;
  }
}

function stepSpring<T extends SpringValue>(spring: SpringState<T>, dt: number) {
  spring.invMass = Math.min(spring.invMass + spring.invMassRecoveryRate, 1);
  const ctx: TickContext = {
    inv_mass: spring.invMass,
    opts: {
      stiffness: spring.stiffness,
      damping: spring.damping,
      precision: spring.precision,
    },
    settled: true,
    dt,
  };

  const next = tickSpring(ctx, spring.last, spring.current, spring.target) as T;
  spring.last = cloneSpringValue(spring.current);
  spring.current = next;
  return ctx.settled;
}

function toCssVars(
  glare: SpringVec3,
  rotate: SpringVec2,
  background: SpringVec2,
): React.CSSProperties {
  const pointerFromCenter = clamp(Math.sqrt((glare.y - 50) ** 2 + (glare.x - 50) ** 2) / 50, 0, 1);
  return {
    ['--pointer-x' as never]: `${glare.x}%`,
    ['--pointer-y' as never]: `${glare.y}%`,
    ['--pointer-from-center' as never]: String(pointerFromCenter),
    ['--pointer-from-top' as never]: String(glare.y / 100),
    ['--pointer-from-left' as never]: String(glare.x / 100),
    ['--card-opacity' as never]: String(glare.o),
    ['--rotate-x' as never]: `${rotate.x}deg`,
    ['--rotate-y' as never]: `${rotate.y}deg`,
    ['--background-x' as never]: `${background.x}%`,
    ['--background-y' as never]: `${background.y}%`,
    ['--card-scale' as never]: '1',
    ['--translate-x' as never]: '0px',
    ['--translate-y' as never]: '0px',
  };
}

export default function DrifApp() {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const springTickLastTimeRef = useRef(0);
  const springUpdateRafRef = useRef<number | null>(null);
  const pendingSpringUpdateRef = useRef<{
    background: SpringVec2;
    rotate: SpringVec2;
    glare: SpringVec3;
  } | null>(null);
  const interactTimerRef = useRef<number | null>(null);
  const firstImageLoadedRef = useRef(false);
  const visibleRef = useRef(typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  const springsRef = useRef({
    rotate: createSpring<SpringVec2>({ x: 0, y: 0 }, { stiffness: 0.066, damping: 0.25 }),
    glare: createSpring<SpringVec3>({ x: 50, y: 50, o: 0 }, { stiffness: 0.066, damping: 0.25 }),
    background: createSpring<SpringVec2>({ x: 50, y: 50 }, { stiffness: 0.066, damping: 0.25 }),
  });
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(false);
  const [foilStyle, setFoilStyle] = useState<React.CSSProperties>({});

  const staticFrontStyle = useMemo<React.CSSProperties>(() => {
    const randomSeed = {
      x: Math.random(),
      y: Math.random(),
    };
    const cosmosPosition = {
      x: Math.floor(randomSeed.x * 734),
      y: Math.floor(randomSeed.y * 1280),
    };
    return {
      ['--seedx' as never]: String(randomSeed.x),
      ['--seedy' as never]: String(randomSeed.y),
      ['--cosmosbg' as never]: `${cosmosPosition.x}px ${cosmosPosition.y}px`,
    };
  }, []);
  const frontStyle = useMemo<React.CSSProperties>(() => {
    return { ...staticFrontStyle, ...foilStyle };
  }, [foilStyle, staticFrontStyle]);

  const applyStylesFromSprings = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;

    const springs = springsRef.current;
    const vars = toCssVars(
      springs.glare.current as SpringVec3,
      springs.rotate.current as SpringVec2,
      springs.background.current as SpringVec2,
    );
    Object.entries(vars).forEach(([key, value]) => {
      card.style.setProperty(key, String(value));
    });
  }, []);

  const clearInteractTimer = useCallback(() => {
    if (interactTimerRef.current === null) return;
    window.clearTimeout(interactTimerRef.current);
    interactTimerRef.current = null;
  }, []);

  const tickSprings = useCallback(
    (now: number) => {
      const elapsed = now - springTickLastTimeRef.current;
      springTickLastTimeRef.current = now;
      const dt = (elapsed * 60) / 1000;
      const springs = springsRef.current;

      let settled = true;
      settled = stepSpring(springs.rotate, dt) && settled;
      settled = stepSpring(springs.glare, dt) && settled;
      settled = stepSpring(springs.background, dt) && settled;

      applyStylesFromSprings();

      if (!settled) {
        animationFrameRef.current = requestAnimationFrame(tickSprings);
        return;
      }

      animationFrameRef.current = null;
    },
    [applyStylesFromSprings],
  );

  const ensureSpringLoop = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    springTickLastTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(tickSprings);
  }, [tickSprings]);

  const updateSprings = useCallback(
    (background: SpringVec2, rotate: SpringVec2, glare: SpringVec3) => {
      const springs = springsRef.current;
      springs.background.stiffness = 0.066;
      springs.background.damping = 0.25;
      springs.rotate.stiffness = 0.066;
      springs.rotate.damping = 0.25;
      springs.glare.stiffness = 0.066;
      springs.glare.damping = 0.25;

      setSpringTarget(springs.background, background);
      setSpringTarget(springs.rotate, rotate);
      setSpringTarget(springs.glare, glare);
      ensureSpringLoop();
    },
    [ensureSpringLoop],
  );

  const interact = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!visibleRef.current) {
        setInteracting(false);
        return;
      }

      clearInteractTimer();
      setInteracting(true);
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      const absolute = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const percent = {
        x: clamp(round((100 / rect.width) * absolute.x)),
        y: clamp(round((100 / rect.height) * absolute.y)),
      };
      const center = {
        x: percent.x - 50,
        y: percent.y - 50,
      };

      pendingSpringUpdateRef.current = {
        background: {
          x: adjust(percent.x, 0, 100, 37, 63),
          y: adjust(percent.y, 0, 100, 33, 67),
        },
        rotate: {
          x: round(-(center.x / 3.5)),
          y: round(center.y / 3.5),
        },
        glare: {
          x: round(percent.x),
          y: round(percent.y),
          o: 1,
        },
      };

      if (springUpdateRafRef.current === null) {
        springUpdateRafRef.current = requestAnimationFrame(() => {
          if (pendingSpringUpdateRef.current) {
            updateSprings(
              pendingSpringUpdateRef.current.background,
              pendingSpringUpdateRef.current.rotate,
              pendingSpringUpdateRef.current.glare,
            );
            pendingSpringUpdateRef.current = null;
          }
          springUpdateRafRef.current = null;
        });
      }
    },
    [clearInteractTimer, updateSprings],
  );

  const interactEnd = useCallback(
    (delay = 500) => {
      clearInteractTimer();
      if (springUpdateRafRef.current !== null) {
        cancelAnimationFrame(springUpdateRafRef.current);
        springUpdateRafRef.current = null;
      }
      pendingSpringUpdateRef.current = null;

      interactTimerRef.current = window.setTimeout(() => {
        const springs = springsRef.current;
        const snapStiff = 0.01;
        const snapDamp = 0.06;
        setInteracting(false);

        springs.rotate.stiffness = snapStiff;
        springs.rotate.damping = snapDamp;
        setSpringTarget(springs.rotate, { x: 0, y: 0 }, { soft: 1 });

        springs.glare.stiffness = snapStiff;
        springs.glare.damping = snapDamp;
        setSpringTarget(springs.glare, { x: 50, y: 50, o: 0 }, { soft: 1 });

        springs.background.stiffness = snapStiff;
        springs.background.damping = snapDamp;
        setSpringTarget(springs.background, { x: 50, y: 50 }, { soft: 1 });

        ensureSpringLoop();
        interactTimerRef.current = null;
      }, delay);
    },
    [clearInteractTimer, ensureSpringLoop],
  );

  const reset = useCallback(() => {
    interactEnd(0);
    const springs = springsRef.current;
    setSpringTarget(springs.rotate, { x: 0, y: 0 }, { hard: true });
    applyStylesFromSprings();
  }, [applyStylesFromSprings, interactEnd]);

  const imageLoader = useCallback(() => {
    if (firstImageLoadedRef.current) return;
    firstImageLoadedRef.current = true;
    setLoading(false);
    setFoilStyle({
      ['--mask' as never]: `url(${HOLO_TEXTURE})`,
      ['--foil' as never]: `url(${HOLO_TEXTURE})`,
    });
  }, []);

  useEffect(() => {
    applyStylesFromSprings();
  }, [applyStylesFromSprings]);

  useEffect(() => {
    const body = document.body;
    body.classList.add('drif-body');
    return () => {
      body.classList.remove('drif-body');
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      visibleRef.current = document.visibilityState === 'visible';
      reset();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [reset]);

  useEffect(() => {
    return () => {
      if (springUpdateRafRef.current !== null) {
        cancelAnimationFrame(springUpdateRafRef.current);
      }
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      clearInteractTimer();
    };
  }, [clearInteractTimer]);

  const signupRef = useRef<HTMLDivElement | null>(null);
  const [showForm, setShowForm] = useState(false);

  useLayoutEffect(() => {
    const container = signupRef.current;
    if (!container) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://eomail5.com/form/578237fe-8fb4-11f0-8bba-a35988c2be69.js';
    script.dataset.form = '578237fe-8fb4-11f0-8bba-a35988c2be69';
    container.appendChild(script);
    return () => {
      container.removeChild(script);
    };
  }, []);

  return (
    <div className="drif-page">
      <main className="drif-main">
        <div className="drif-card-showcase">
          <div
            ref={cardRef}
            className={`drif-card water interactive masked glowing${interacting ? ' interacting' : ''}${loading ? ' loading' : ''}`}
            data-number="001"
            data-set="custom"
            data-subtypes="v"
            data-supertype="pokémon"
            data-rarity="rare holo v"
            data-trainer-gallery="false"
          >
            <div className="drif-card__translater">
              <button
                className="drif-card__rotator"
                onPointerMove={interact}
                onPointerLeave={() => interactEnd()}
                onPointerCancel={() => interactEnd()}
                onBlur={() => interactEnd(0)}
                aria-label="Expand the Pokemon Card; Custom Card."
                tabIndex={0}
              >
                <div className="drif-card__back" aria-hidden="true" />
                <div className="drif-card__front" style={frontStyle}>
                  {CARD_LAYERS.map((layerSrc, index) => (
                    <img
                      key={layerSrc}
                      src={layerSrc}
                      alt={`Card layer ${index + 1}`}
                      onLoad={imageLoader}
                      loading="lazy"
                      width="1000"
                      height="1400"
                      draggable={false}
                    />
                  ))}
                  <div className="drif-card__shine" />
                  <div className="drif-card__glare" />
                </div>
              </button>
            </div>
          </div>
        </div>
      </main>
      <div className="drif-notify-area">
        {!showForm && (
          <button className="drif-notify-btn" onClick={() => setShowForm(true)}>
            notify me
          </button>
        )}
        <div id="signup" ref={signupRef} className={`drif-signup${showForm ? ' drif-signup--visible' : ''}`} />
      </div>
    </div>
  );
}
