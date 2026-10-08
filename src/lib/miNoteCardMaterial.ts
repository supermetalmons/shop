import * as THREE from 'three';
import { DRIF_EFFECT_KEYS, DRIF_GRAIN_URL, type DrifCardConfig } from '../drifCards.ts';

type TextureLoader = (source: string) => Promise<THREE.Texture>;
type TextureEntry = { ready: Promise<THREE.Texture>; references: number };
const textureCaches = new WeakMap<TextureLoader, Map<string, TextureEntry>>();
const loadTexture: TextureLoader = (source) => new THREE.TextureLoader().loadAsync(source);

function loadTextureWithTimeout(source: string, loader: TextureLoader): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      settled = true;
      reject(new Error(`Timed out loading card texture: ${source}`));
    }, 30_000);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(`Unable to load card texture: ${source}`));
    };
    try {
      void loader(source).then((texture) => {
        if (settled) {
          texture.dispose();
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(texture);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function acquireTexture(source: string, loader: TextureLoader) {
  let cache = textureCaches.get(loader);
  if (!cache) {
    cache = new Map();
    textureCaches.set(loader, cache);
  }
  let entry = cache.get(source);
  if (!entry) {
    entry = {
      references: 0,
      ready: loadTextureWithTimeout(source, loader).then((texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 4;
        if (source === DRIF_GRAIN_URL) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        return texture;
      }),
    };
    cache.set(source, entry);
  }
  entry.references += 1;
  const current = entry;
  let released = false;
  return {
    ready: current.ready,
    release() {
      if (released) return;
      released = true;
      current.references -= 1;
      if (current.references > 0) return;
      if (cache.get(source) === current) cache.delete(source);
      void current.ready.then((texture) => texture.dispose(), () => undefined);
    },
  };
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uFront;
uniform sampler2D uFoil;
uniform sampler2D uMask;
uniform sampler2D uGrain;
uniform vec2 uPointer;
uniform vec2 uBackground;
uniform vec2 uCardSize;
uniform float uPointerFromCenter;
uniform int uEffect;
varying vec2 vUv;

const float FOIL_HIGHLIGHTS = 0.7;
const float GLARE_OPACITY = 0.5;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float linearStep(float a, float b, float t) { return clamp((t - a) / (b - a), 0.0, 1.0); }
vec3 screenBlend(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
vec3 overlayBlend(vec3 a, vec3 b) {
  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(vec3(0.5), a));
}
vec3 hardLightBlend(vec3 a, vec3 b) { return overlayBlend(b, a); }
vec3 softLightBlend(vec3 a, vec3 b) {
  vec3 low = 2.0 * a * b + a * a * (1.0 - 2.0 * b);
  vec3 high = sqrt(max(a, 0.0)) * (2.0 * b - 1.0) + 2.0 * a * (1.0 - b);
  return mix(low, high, step(vec3(0.5), b));
}
vec3 dodgeBlend(vec3 a, vec3 b) { return clamp(a / max(1.0 - b, 0.025), 0.0, 1.0); }
float cssLum(vec3 c) { return dot(c, vec3(0.30, 0.59, 0.11)); }
vec3 hueBlend(vec3 base, vec3 source) {
  float saturation = max(max(base.r, base.g), base.b) - min(min(base.r, base.g), base.b);
  float low = min(min(source.r, source.g), source.b);
  float delta = max(max(source.r, source.g), source.b) - low;
  vec3 color = (source - low) * saturation / max(delta, 0.0001);
  color += cssLum(base) - cssLum(color);
  float lightness = cssLum(color);
  float minimum = min(min(color.r, color.g), color.b);
  float maximum = max(max(color.r, color.g), color.b);
  if (minimum < 0.0) color = lightness + (color - lightness) * lightness / max(lightness - minimum, 0.0001);
  if (maximum > 1.0) color = lightness + (color - lightness) * (1.0 - lightness) / max(maximum - lightness, 0.0001);
  return color;
}
vec3 filterColor(vec3 color, float brightness, float contrast, float saturation) {
  color = (color * brightness - 0.5) * contrast + 0.5;
  return clamp(mix(vec3(lum(color)), color, saturation), 0.0, 1.0);
}
vec2 backgroundUV(vec2 uv, vec2 scale, vec2 position) {
  return (uv - (1.0 - scale) * position) / scale;
}
float gradientPercent(vec2 uv, vec2 scale, vec2 position, vec2 axis) {
  vec2 size = uCardSize * scale;
  vec2 pixel = (uv - (1.0 - scale) * position) * uCardSize;
  float lineLength = dot(abs(axis), size);
  return dot(pixel - size * 0.5, axis) / lineLength + 0.5;
}
float radialProgress(vec2 uv, vec2 pointer, vec2 size) {
  vec2 farthest = max(pointer, 1.0 - pointer) * size;
  return length((uv - pointer) * size) / max(length(farthest), 0.001);
}
vec4 radialStops(float d, vec4 a, vec4 b, vec4 c, vec3 stops) {
  return mix(mix(a, b, linearStep(stops.x, stops.y, d)), c, linearStep(stops.y, stops.z, d));
}
vec4 premultipliedMix(vec4 a, vec4 b, float t) {
  float alpha = mix(a.a, b.a, t);
  return vec4(mix(a.rgb * a.a, b.rgb * b.a, t) / max(alpha, 0.0001), alpha);
}
vec3 sunColor(float phase) {
  float segment = fract(phase) * 6.0;
  vec3 a = vec3(1.0, 0.48, 0.46);
  vec3 b = vec3(1.0, 0.92, 0.38);
  vec3 c = vec3(0.63, 1.0, 0.38);
  vec3 d = vec3(0.52, 1.0, 0.97);
  vec3 e = vec3(0.48, 0.58, 1.0);
  vec3 f = vec3(0.82, 0.46, 1.0);
  if (segment < 1.0) return mix(a, b, segment);
  if (segment < 2.0) return mix(b, c, segment - 1.0);
  if (segment < 3.0) return mix(c, d, segment - 2.0);
  if (segment < 4.0) return mix(d, e, segment - 3.0);
  if (segment < 5.0) return mix(e, f, segment - 4.0);
  return mix(f, a, segment - 5.0);
}
vec3 diagonalColor(float percent) {
  float phase = mod(percent, 0.12);
  vec3 dark = vec3(0.055, 0.082, 0.18);
  vec3 muted = vec3(0.56, 0.64, 0.64);
  vec3 cyan = vec3(0.55, 0.78, 0.80);
  vec3 color = dark;
  if (phase < 0.038) color = mix(dark, muted, phase / 0.038);
  else if (phase < 0.045) color = mix(muted, cyan, (phase - 0.038) / 0.007);
  else if (phase < 0.052) color = mix(cyan, muted, (phase - 0.045) / 0.007);
  else if (phase < 0.10) color = mix(muted, dark, (phase - 0.052) / 0.048);
  return mix(color, vec3(0.294375, 0.3552167, 0.4078333), smoothstep(0.004, 0.06, fwidth(percent)));
}
vec3 diagonal(vec2 uv, bool after, bool trainer) {
  float x = uBackground.x + (trainer ? uBackground.y * 0.2 : 0.0);
  vec2 position = vec2(x, uBackground.y) * (after ? -1.0 : 1.0);
  float percent = gradientPercent(uv, vec2(after ? 1.95 : 3.0, 1.0), position, vec2(0.7313537, 0.6819984));
  return diagonalColor(percent);
}
vec3 foilLayer(vec2 uv, vec3 textureColor, bool after, bool trainer, vec3 rib) {
  vec2 radialUV = trainer ? backgroundUV(uv, vec2(2.0, 1.0), uBackground) : uv;
  vec2 radialSize = uCardSize * (trainer ? vec2(2.0, 1.0) : vec2(1.0));
  float d = radialProgress(radialUV, uPointer, radialSize);
  float alpha = mix(mix(0.10, 0.15, linearStep(0.12, 0.20, d)), 0.25, linearStep(0.20, 1.20, d));
  if (trainer && after) rib = mix(rib, max(rib, vec3(0.82)), smoothstep(0.42, 0.72, lum(rib)) * 0.35);
  vec3 color = mix(rib, hardLightBlend(vec3(0.0), rib), alpha);
  float percent = gradientPercent(uv, vec2(2.0, after ? 4.0 : 7.0), vec2(0.0, uBackground.y), vec2(0.0, -1.0));
  float phase = (percent - 0.05) / 0.30 + (trainer && after ? 5.0 / 6.0 : 0.0);
  vec3 sun = mix(sunColor(phase), vec3(0.7417, 0.7400, 0.6983), smoothstep(0.08, 1.0, fwidth(phase)));
  color = hueBlend(color, sun);
  return trainer ? softLightBlend(color, textureColor) : screenBlend(color, textureColor);
}
vec3 lighting(vec3 base, float d) {
  vec4 glare;
  if (d <= 0.24) glare = premultipliedMix(vec4(1.0, 1.0, 1.0, 0.66), vec4(1.0, 1.0, 1.0, 0.34), linearStep(0.08, 0.24, d));
  else if (d <= 0.58) glare = premultipliedMix(vec4(1.0, 1.0, 1.0, 0.34), vec4(1.0, 1.0, 1.0, 0.04), linearStep(0.24, 0.58, d));
  else glare = premultipliedMix(vec4(1.0, 1.0, 1.0, 0.04), vec4(0.0, 0.0, 0.0, 0.16), linearStep(0.58, 1.0, d));
  return mix(base, overlayBlend(base, glare.rgb * 0.98), clamp(0.56 * glare.a * GLARE_OPACITY, 0.0, 1.0));
}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 front = texture2D(uFront, vUv);
  vec3 base = front.rgb;
  float d = radialProgress(uv, uPointer, uCardSize);
  if (uEffect == 2) {
    gl_FragColor = vec4(lighting(base, d), front.a);
    return;
  }
  float mask = texture2D(uMask, vUv).a;
  bool trainer = uEffect == 1;
  vec3 mainRib = diagonal(uv, false, trainer);
  vec3 afterRib = diagonal(uv, true, trainer);
  vec3 surface;
  if (trainer) surface = texture2D(uFoil, vUv).rgb;
  else {
    vec2 grainUV = backgroundUV(uv, vec2(500.0 / uCardSize.x, 1.0), vec2(0.5));
    surface = texture2D(uGrain, vec2(grainUV.x, 1.0 - grainUV.y)).rgb;
  }
  vec3 shine = foilLayer(uv, surface, false, trainer, mainRib);
  vec3 shineAfter = foilLayer(uv, surface, true, trainer, afterRib);
  if (trainer) {
    shine = filterColor(shine, uPointerFromCenter * 0.05 + 0.80, 1.75, 1.20);
    float beforeAlpha = 1.0 - linearStep(0.0, 0.80, d);
    shine = mix(shine, screenBlend(shine, vec3(beforeAlpha)), beforeAlpha * 0.50);
    shineAfter = filterColor(shineAfter, uPointerFromCenter * 0.40 + 0.85, 2.0, 0.50);
    shine = mix(shine, shine + shineAfter - 2.0 * shine * shineAfter, 0.99);
    float hotspot = mask * smoothstep(0.52, 0.82, lum(shine));
    float ribHotspot = mask * smoothstep(0.48, 0.70, max(lum(afterRib), lum(mainRib) * 0.70));
    base = mix(base, dodgeBlend(base, clamp(shine * FOIL_HIGHLIGHTS, 0.0, 1.0)), mask);
    base = mix(base, vec3(1.0), clamp(0.08 * hotspot * beforeAlpha * FOIL_HIGHLIGHTS, 0.0, 1.0));
    float glareD = radialProgress(backgroundUV(uv, vec2(1.7), vec2(0.5)), uPointer, uCardSize * 1.7);
    vec3 glare = radialStops(glareD, vec4(vec3(0.75), 1.0), vec4(0.3325, 0.3558333, 0.3675, 1.0), vec4(0.14, 0.06, 0.1133333, 1.0), vec3(0.05, 0.60, 1.50)).rgb;
    glare = filterColor(glare, 1.50, 1.40, 1.0);
    base = mix(base, base * glare, clamp(0.75 * (1.0 - 0.25 * hotspot - 0.45 * ribHotspot) * GLARE_OPACITY, 0.0, 1.0));
    base = mix(base, screenBlend(base, vec3(1.0, 0.96, 0.82)), clamp(0.16 * ribHotspot * FOIL_HIGHLIGHTS, 0.0, 1.0));
  } else {
    shine = filterColor(shine, 0.80, 2.95, 0.65);
    base = mix(base, dodgeBlend(base, clamp(shine * FOIL_HIGHLIGHTS, 0.0, 1.0)), mask);
    shineAfter = filterColor(shineAfter, 1.0, 2.5, 1.75);
    base = mix(base, softLightBlend(base, shineAfter), mask);
    vec4 glare = radialStops(d, vec4(1.0), vec4(vec3(0.54), 0.33), vec4(vec3(0.20), 0.90), vec3(0.0, 0.45, 1.30));
    glare.rgb = filterColor(glare.rgb, 0.90, 1.75, 1.0);
    base = mix(base, hardLightBlend(base, glare.rgb), clamp(0.50 * glare.a * GLARE_OPACITY, 0.0, 1.0));
  }
  gl_FragColor = vec4(clamp(base, 0.0, 1.0), front.a);
}
`;

export function createMiNoteCardMaterial(
  card: DrifCardConfig,
  options: { loadTexture?: TextureLoader } = {},
) {
  const placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  placeholder.needsUpdate = true;
  const uniforms = {
    uFront: { value: placeholder as THREE.Texture },
    uFoil: { value: placeholder as THREE.Texture },
    uMask: { value: placeholder as THREE.Texture },
    uGrain: { value: placeholder as THREE.Texture },
    uPointer: { value: new THREE.Vector2(0.5, 0.5) },
    uBackground: { value: new THREE.Vector2(0.5, 0.5) },
    uCardSize: { value: new THREE.Vector2(300, 420) },
    uPointerFromCenter: { value: 0 },
    uEffect: { value: 0 },
  };
  // CSS and the reference Metal shader blend encoded RGB, so these colors bypass Three's linear conversion.
  const material = new THREE.ShaderMaterial({
    name: 'Mi Note card effects',
    uniforms,
    vertexShader,
    fragmentShader,
    toneMapped: false,
  });
  const loader = options.loadTexture ?? loadTexture;
  const leases = new Map<string, ReturnType<typeof acquireTexture>>();
  let disposed = false;
  let effectVersion = 0;
  const localCamera = new THREE.Vector3();
  const inverseWorld = new THREE.Matrix4();
  async function ensureTexture(uniform: { value: THREE.Texture }, source: string | undefined) {
    if (!source) throw new Error('Missing required card texture');
    let lease = leases.get(source);
    if (!lease) {
      lease = acquireTexture(source, loader);
      leases.set(source, lease);
    }
    try {
      const texture = await lease.ready;
      if (!disposed) uniform.value = texture;
    } catch (error) {
      if (leases.get(source) === lease) leases.delete(source);
      lease.release();
      throw error;
    }
  }
  async function setEffect(effect: DrifCardConfig['effect']): Promise<void> {
    if (disposed) return;
    const version = ++effectVersion;
    const value = effect.effectKey === DRIF_EFFECT_KEYS.miNoteCardsDefault ? 0
      : effect.effectKey === DRIF_EFFECT_KEYS.lightingOnly ? 2
      : effect.effectKey === DRIF_EFFECT_KEYS.trainerFullArt ? 1 : 0;
    const pending = [ensureTexture(uniforms.uFront, card.imageSrc)];
    if (value !== 2) {
      pending.push(ensureTexture(uniforms.uMask, card.textureSrc));
      pending.push(value === 1 ? ensureTexture(uniforms.uFoil, card.foilSrc) : ensureTexture(uniforms.uGrain, DRIF_GRAIN_URL));
    }
    await Promise.all(pending);
    if (disposed || version !== effectVersion) return;
    const image = uniforms.uFront.value.image as { width?: number; height?: number } | undefined;
    if (image?.width && image.height) uniforms.uCardSize.value.set(300, 300 * image.height / image.width);
    uniforms.uEffect.value = value;
  }
  return {
    material,
    setEffect,
    update(mesh: THREE.Object3D, camera: THREE.Camera) {
      if (disposed) return;
      mesh.updateWorldMatrix(true, false);
      camera.updateWorldMatrix(true, false);
      inverseWorld.copy(mesh.matrixWorld).invert();
      localCamera.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverseWorld);
      const z = Math.max(Math.abs(localCamera.z), 0.0001);
      const x = THREE.MathUtils.clamp(0.5 + Math.atan2(localCamera.x, z) * 2.0, 0, 1);
      const y = THREE.MathUtils.clamp(0.5 - Math.atan2(localCamera.y, z) * 1.15, 0, 1);
      uniforms.uPointer.value.set(x, y);
      uniforms.uBackground.value.set(0.37 + x * 0.26, 0.33 + y * 0.34);
      uniforms.uPointerFromCenter.value = Math.min(Math.hypot(x - 0.5, y - 0.5) * 2, 1);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      leases.forEach((lease) => lease.release());
      placeholder.dispose();
      material.dispose();
    },
  };
}
