import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../drif.css';
import type { DrifCardConfig } from '../drifCards';

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

type DrifEffectCardProps = {
  card: DrifCardConfig;
  ariaLabel: string;
  imageAlt?: string;
  onClick?: () => void;
  interactive?: boolean;
  disableGlow?: boolean;
  preserveTransformOnCardChange?: boolean;
  preloadCards?: readonly DrifCardConfig[];
};

function round(value: number, precision = 3) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function adjust(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
  return round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
}

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

function toCssVars(glare: SpringVec3, rotate: SpringVec2, background: SpringVec2): React.CSSProperties {
  const pointerFromCenter = clamp(Math.sqrt((glare.y - 50) ** 2 + (glare.x - 50) ** 2) / 50, 0, 1);
  return {
    ['--pointer-x' as never]: `${glare.x}%`,
    ['--pointer-y' as never]: `${glare.y}%`,
    ['--pointer-from-center' as never]: String(pointerFromCenter),
    ['--pointer-from-top' as never]: String(glare.y / 100),
    ['--pointer-from-left' as never]: String(glare.x / 100),
    ['--card-opacity' as never]: String(Math.min(glare.o, 0.99)),
    ['--rotate-x' as never]: `${rotate.x}deg`,
    ['--rotate-y' as never]: `${rotate.y}deg`,
    ['--rotate-delta' as never]: '0deg',
    ['--background-x' as never]: `${background.x}%`,
    ['--background-y' as never]: `${background.y}%`,
    ['--card-scale' as never]: '1',
    ['--translate-x' as never]: '0px',
    ['--translate-y' as never]: '0px',
  };
}

export default function DrifEffectCard({
  card,
  ariaLabel,
  imageAlt = '',
  onClick,
  interactive = true,
  disableGlow = false,
  preserveTransformOnCardChange = false,
  preloadCards,
}: DrifEffectCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const springTickLastTimeRef = useRef(0);
  const springUpdateRafRef = useRef<number | null>(null);
  const firstImageLoadedRef = useRef(false);
  const pendingSpringUpdateRef = useRef<{
    background: SpringVec2;
    rotate: SpringVec2;
    glare: SpringVec3;
  } | null>(null);
  const interactTimerRef = useRef<number | null>(null);
  const interactingRef = useRef(false);
  const visibleRef = useRef(typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  const springsRef = useRef({
    rotate: createSpring<SpringVec2>({ x: 0, y: 0 }, { stiffness: 0.066, damping: 0.25 }),
    glare: createSpring<SpringVec3>({ x: 50, y: 50, o: 0 }, { stiffness: 0.066, damping: 0.25 }),
    background: createSpring<SpringVec2>({ x: 50, y: 50 }, { stiffness: 0.066, damping: 0.25 }),
  });
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(false);

  const staticCardStyle = useMemo<React.CSSProperties>(() => {
    const randomSeed = {
      x: Math.random(),
      y: Math.random(),
    };
    const bgPosition1 = {
      x: Math.floor(randomSeed.x * 734),
      y: Math.floor(randomSeed.y * 1280),
    };
    const bgPosition2 = {
      x: Math.floor(Math.random() * 734),
      y: Math.floor(Math.random() * 1280),
    };

    return {
      ['--seedx' as never]: String(randomSeed.x),
      ['--seedy' as never]: String(randomSeed.y),
      ['--cosmosbg' as never]: `${bgPosition1.x}px ${bgPosition1.y}px`,
      ['--birthdaybg' as never]: `${bgPosition2.x}px ${bgPosition2.y}px`,
    };
  }, []);

  const cardStyle = useMemo<React.CSSProperties>(
    () => ({
      ...staticCardStyle,
      ['--mask' as never]: `url(${card.textureSrc})`,
      ['--foil' as never]: `url(${card.foilSrc})`,
    }),
    [card.foilSrc, card.textureSrc, staticCardStyle],
  );

  const applyStylesFromSprings = useCallback(() => {
    const cardElement = cardRef.current;
    if (!cardElement) return;

    const springs = springsRef.current;
    const vars = toCssVars(
      springs.glare.current as SpringVec3,
      springs.rotate.current as SpringVec2,
      springs.background.current as SpringVec2,
    );
    Object.entries(vars).forEach(([key, value]) => {
      cardElement.style.setProperty(key, String(value));
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

      if (!settled || interactingRef.current) {
        animationFrameRef.current = requestAnimationFrame(tickSprings);
        if (settled && interactingRef.current) {
          const el = cardRef.current;
          if (el) {
            const gl = springs.glare.current as SpringVec3;
            const bg = springs.background.current as SpringVec2;
            const nudge = Math.sin(now * 0.002) * 0.01;
            el.style.setProperty('--pointer-x', `${gl.x + nudge}%`);
            el.style.setProperty('--background-x', `${bg.x + nudge}%`);
          }
        }
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

  const setPointerFromPercent = useCallback(
    (percentX: number, percentY: number) => {
      const percent = {
        x: clamp(round(percentX)),
        y: clamp(round(percentY)),
      };
      const center = {
        x: percent.x - 50,
        y: percent.y - 50,
      };

      clearInteractTimer();
      interactingRef.current = true;
      setInteracting(true);

      pendingSpringUpdateRef.current = {
        background: {
          x: adjust(percent.x, 0, 100, 37, 63),
          y: adjust(percent.y, 0, 100, 33, 67),
        },
        rotate: {
          x: round(-(center.x / 3.5)),
          y: round(center.y / 2),
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

  const interact = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!visibleRef.current) {
        interactingRef.current = false;
        setInteracting(false);
        return;
      }

      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      const absolute = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      setPointerFromPercent((100 / rect.width) * absolute.x, (100 / rect.height) * absolute.y);
    },
    [setPointerFromPercent],
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
      interactingRef.current = false;
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

  const onImageLoad = useCallback(() => {
    if (preserveTransformOnCardChange) {
      if (firstImageLoadedRef.current) return;
      firstImageLoadedRef.current = true;
    }
    setLoading(false);
  }, [preserveTransformOnCardChange]);

  useEffect(() => {
    if (!preloadCards?.length || typeof window === 'undefined') return undefined;

    const preloadImages = preloadCards.flatMap(({ imageSrc, foilSrc, textureSrc }) => [imageSrc, foilSrc, textureSrc]).map((src) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
      return image;
    });

    return () => {
      preloadImages.forEach((image) => {
        image.src = '';
      });
    };
  }, [preloadCards]);

  useEffect(() => {
    if (preserveTransformOnCardChange) return;
    setLoading(true);
    interactingRef.current = false;
    setInteracting(false);
    reset();
  }, [card.imageSrc, preserveTransformOnCardChange, reset]);

  useEffect(() => {
    applyStylesFromSprings();
  }, [applyStylesFromSprings]);

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

  const glowType = card.glowType ?? card.effect.typeClass;
  const cardClassName = [
    'drif-effect-card',
    glowType,
    'interactive',
    'masked',
    disableGlow ? 'no-glow' : 'glowing',
    interacting ? 'interacting' : '',
    loading ? 'loading' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      data-id={card.effect.id}
      data-display-id={card.effect.id}
      data-number={card.effect.number}
      data-set={card.effect.setId}
      data-source={card.effect.source}
      data-subtypes={card.effect.subtypes}
      data-supertype={card.effect.supertype}
      data-rarity={card.effect.rarity}
      data-trainer-gallery={String(card.effect.trainerGallery)}
      data-effect={card.effect.effectKey}
      style={cardStyle}
    >
      <div className="drif-effect-card__translater">
        <button
          className="drif-effect-card__rotator"
          onPointerEnter={interactive ? interact : undefined}
          onPointerMove={interactive ? interact : undefined}
          onPointerLeave={interactive ? () => interactEnd() : undefined}
          onPointerCancel={interactive ? () => interactEnd() : undefined}
          onBlur={interactive ? () => interactEnd(0) : undefined}
          onClick={interactive ? onClick : undefined}
          aria-label={ariaLabel}
          tabIndex={interactive ? 0 : -1}
          disabled={!interactive}
        >
          <div className="drif-effect-card__back" aria-hidden="true" />
          <div className="drif-effect-card__front">
            <img src={card.imageSrc} alt={imageAlt} onLoad={onImageLoad} loading="lazy" width="1000" height="1400" draggable={false} />
            <div className="drif-effect-card__shine" />
            <div className="drif-effect-card__glitter" />
            <div className="drif-effect-card__glare" />
            <div className="drif-effect-card__glare2" />
          </div>
        </button>
      </div>
    </div>
  );
}
