import '../styles/mi-note-closing-particles.css';

let clearActiveParticles: (() => void) | undefined;

export function playMiNoteClosingParticles(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  clearActiveParticles?.();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) return;

  const layer = document.createElement('div');
  layer.className = 'mi-note-closing-particles';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const count = Math.min(40, Math.max(12, Math.round(window.innerWidth * window.innerHeight / 36000)));

  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement('span');
    particle.className = `mi-note-closing-particles__light${index % 8 === 0 ? ' mi-note-closing-particles__light--star' : ''}`;
    particle.style.left = `${(index + Math.random()) / count * 100}%`;
    particle.style.top = `${Math.random() * 96 - 4}%`;
    particle.style.setProperty('--size', `${1.1 + Math.random() ** 1.6 * 3}px`);
    particle.style.setProperty('--fall', `${24 + Math.random() * 32}px`);
    particle.style.setProperty('--drift', `${Math.random() * 12 - 6}px`);
    particle.style.setProperty('--trail', `${10 + Math.random() * 14}px`);
    particle.style.setProperty('--alpha', `${0.3 + Math.random() * 0.25}`);
    particle.style.animationDuration = `${600 + Math.random() * 180}ms`;
    particle.style.animationDelay = `${Math.random() * 60}ms`;
    layer.append(particle);
  }

  const clear = () => {
    window.clearTimeout(timeout);
    reducedMotion.removeEventListener('change', clear);
    window.removeEventListener('pagehide', clear);
    layer.remove();
    if (clearActiveParticles === clear) clearActiveParticles = undefined;
  };
  const timeout = window.setTimeout(clear, 900);
  clearActiveParticles = clear;
  reducedMotion.addEventListener('change', clear);
  window.addEventListener('pagehide', clear, { once: true });
  document.body.append(layer);
}
