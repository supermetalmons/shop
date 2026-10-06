import * as THREE from 'three';
import type { MiNotePackStar } from './miNotePackStars';
import { MI_NOTE_STAR_VERTICAL_DEFAULT, normalizeMiNoteStarFoldPosition, normalizeMiNoteStarRotationOffset, normalizeMiNoteStarSizeScale, normalizeMiNoteStarVerticalPosition } from './miNoteStarFolds';
import { createMiNoteStickerFinish, MI_NOTE_STICKER_EDGE_DISTANCE, MI_NOTE_STICKER_OUTLINE_SUPPORT } from './miNoteStickerFinish';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, normalizeMiNoteStickerEffectSettings, type MiNoteStickerEffectSettings } from './miNoteStickerEffects';

export type MiNoteStickerTextureSize = 512 | 1024 | 2048;

const STICKER_WIDTH = 0.56;
const SURFACE_CLEARANCE = 0.0015;
const PROFILE_SEGMENTS = [56, 64, 40];
const WIDTH_SEGMENTS = PROFILE_SEGMENTS.reduce((total, count) => total + count, 0);
const HEIGHT_SEGMENTS = 48;
const PEEL_DURATION = 1.2;
const ARTWORK_TIMEOUT_MS = 30_000;

function sealPoint(distance: number, angle: number, radius: number, curvature: number) {
  if (distance <= 0) return { x: distance, z: 0 };
  const theta = Math.min(distance / radius, angle);
  const tail = Math.max(0, distance - radius * angle);
  const tipLength = Math.max(0, tail - 0.012);
  const straight = Math.min(tail, 0.012);
  let tipX = tipLength * Math.cos(angle);
  let tipZ = tipLength * Math.sin(angle);
  if (Math.abs(curvature) > 0.00001) {
    tipX = (Math.sin(angle + curvature * tipLength) - Math.sin(angle)) / curvature;
    tipZ = (Math.cos(angle) - Math.cos(angle + curvature * tipLength)) / curvature;
  }
  return {
    x: radius * Math.sin(theta) + straight * Math.cos(angle) + tipX,
    z: radius * (1 - Math.cos(theta)) + straight * Math.sin(angle) + tipZ,
  };
}

export function createMiNotePackSeal({
  parent,
  width,
  height,
  spine,
  thickness,
  star,
  foldPosition,
  rotationOffsetDegrees,
  verticalPosition = MI_NOTE_STAR_VERTICAL_DEFAULT,
  sizeScale = star.sizeScale,
  effectSettings = DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  stickerTextureSize = 512,
  onInvalidate,
}: {
  parent: THREE.Group;
  width: number;
  height: number;
  spine: number;
  thickness: number;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  verticalPosition?: number;
  sizeScale?: number;
  effectSettings?: MiNoteStickerEffectSettings;
  stickerTextureSize?: MiNoteStickerTextureSize;
  onInvalidate?: () => void;
}) {
  if (![512, 1024, 2048].includes(stickerTextureSize)) throw new RangeError('Sticker texture size must be 512, 1024, or 2048.');
  const resolutionScale = stickerTextureSize / 512;
  const artworkPadding = 32 * resolutionScale;
  const edgeDistanceRange = MI_NOTE_STICKER_EDGE_DISTANCE * resolutionScale;
  const outlineAntialias = 0.75 * resolutionScale;
  const stickerCoverageFragment = `
    vec4 stickerFinish = texture2D(stickerFinishMap, vMapUv);
    float stickerDistance = (stickerFinish.b * 2.0 - 1.0) * ${edgeDistanceRange.toFixed(1)};
    float stickerAntialias = max(${outlineAntialias.toFixed(2)}, .75 * fwidth(stickerDistance));
    float stickerBacking = 1.0 - smoothstep(stickerEdgeBounds.y - stickerAntialias,
      stickerEdgeBounds.y + stickerAntialias, -stickerDistance);
    float stickerCoverage = stickerFinish.a + (1.0 - stickerFinish.a) * stickerBacking;
    float stickerFoil = (stickerCoverage - stickerFinish.a) / max(stickerCoverage, .0001);
    diffuseColor.a = opacity * stickerCoverage;
  `;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = stickerTextureSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The star sticker canvas could not be created.');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const finishPixels = new Uint8Array(stickerTextureSize * stickerTextureSize * 4);
  const finishMap = new THREE.DataTexture(finishPixels, stickerTextureSize, stickerTextureSize);
  finishMap.flipY = true;
  finishMap.minFilter = THREE.LinearFilter;
  finishMap.magFilter = THREE.LinearFilter;
  let currentEffectSettings = normalizeMiNoteStickerEffectSettings(effectSettings);
  const effectUniforms = {
    stickerEdgeShape: { value: new THREE.Vector4() },
    stickerEdgeColor: { value: new THREE.Vector4() },
    stickerEdgeBounds: { value: new THREE.Vector2() },
  };
  const updateEffectUniforms = () => {
    const effect = currentEffectSettings;
    effectUniforms.stickerEdgeShape.value.set(effect.width * stickerTextureSize, effect.softness, effect.strength, effect.scale);
    effectUniforms.stickerEdgeColor.value.set(effect.hue, effect.variation, effect.motion, effect.shine);
    const bandWidth = effect.width * stickerTextureSize;
    effectUniforms.stickerEdgeBounds.value.set(
      bandWidth * (1 - effect.outerness),
      bandWidth * effect.outerness,
    );
  };
  updateEffectUniforms();
  const material = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.28,
    metalness: 0.2,
    clearcoat: 0.25,
    clearcoatRoughness: 0.24,
    bumpMap: finishMap,
    bumpScale: 0.0012,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
    alphaToCoverage: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.stickerFinishMap = { value: finishMap };
    Object.assign(shader.uniforms, effectUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform sampler2D stickerFinishMap;
        uniform vec4 stickerEdgeShape;
        uniform vec4 stickerEdgeColor;
        uniform vec2 stickerEdgeBounds;
      `)
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        ${stickerCoverageFragment}
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        float inkLuminance = dot(diffuseColor.rgb, vec3(.2126, .7152, .0722));
        if (gl_FrontFacing) {
          vec3 ink = diffuseColor.rgb;
          float inkChroma = max(max(ink.r, ink.g), ink.b) - min(min(ink.r, ink.g), ink.b);
          float gradeStrength = (1.0 - stickerFoil) * smoothstep(.025, .12, inkChroma);
          vec3 vividInk = (mix(vec3(inkLuminance), ink, 1.28) - .18) * 1.06 + .18;
          float yellowInk = smoothstep(.05, .25, min(ink.r, ink.g) - ink.b)
            * smoothstep(.4, .85, ink.r / max(ink.g, .001));
          vividInk *= mix(vec3(1.0), vec3(1.12, .98, .9), yellowInk);
          diffuseColor.rgb = mix(ink, clamp(vividInk, 0.0, 1.0), gradeStrength);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.4, .43, .47), stickerFoil);
        } else {
          diffuseColor.rgb = vec3(.57, .53, .43);
        }
      `)
      .replace('#include <alphatest_fragment>', `
        if (diffuseColor.a <= 0.0) discard;
      `)
      .replace('#include <metalnessmap_fragment>', `
        #include <metalnessmap_fragment>
        if (gl_FrontFacing) {
          metalnessFactor = mix(.2, .22, stickerFoil);
          roughnessFactor = mix(.28, .24, stickerFoil);
        } else {
          metalnessFactor = 0.0;
          roughnessFactor = .94;
        }
      `)
      .replace('#include <normal_fragment_maps>', `
        if (gl_FrontFacing) {
          #include <normal_fragment_maps>
        }
      `)
      .replace('#include <clearcoat_normal_fragment_maps>', `
        #include <clearcoat_normal_fragment_maps>
        clearcoatNormal = normal;
      `)
      .replace('#include <lights_physical_fragment>', `
        #include <lights_physical_fragment>
        if (!gl_FrontFacing) material.clearcoat = 0.0;
      `)
      .replace('#include <opaque_fragment>', `
        if (gl_FrontFacing) {
          float viewAngle = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          float filmPhase = dot(vMapUv, vec2(.8, .65)) + viewAngle * 2.4;
          vec3 rainbow = .5 + .5 * cos(6.28318 * (vec3(0.0, .333, .667) + filmPhase));
          float inkResponse = mix(.2, 1.0, smoothstep(.025, .5, inkLuminance));
          float filmStrength = mix(.38, .58, stickerFoil) * inkResponse;
          vec3 reflectedFilm = outgoingLight * .3 + rainbow * .95 + vec3(.06);
          outgoingLight = mix(outgoingLight, reflectedFilm, filmStrength);
          if (stickerEdgeShape.z > 0.0) {
            float edgeBlend = max(${outlineAntialias.toFixed(2)}, stickerEdgeShape.x * stickerEdgeShape.y * .5);
            float edgeMask = 1.0 - smoothstep(stickerEdgeBounds.x - edgeBlend,
              stickerEdgeBounds.x, stickerDistance);
            vec2 foilUv = (vMapUv - .5) * stickerEdgeShape.w;
            float angleShift = (viewAngle * 2.4 + dot(normal.xy, vec2(.18, -.12))) * stickerEdgeColor.z;
            float ripple = sin(dot(foilUv, vec2(18.0, 11.0)) + angleShift * .6)
              * sin(dot(foilUv, vec2(-9.0, 17.0)) - angleShift * .4);
            float flow = sin(dot(foilUv, vec2(6.0, -8.0)) + ripple * .7);
            float edgePhase = dot(foilUv, vec2(.8, .65)) + angleShift + stickerEdgeColor.x;
            edgePhase += (ripple * .28 + flow * .18) * stickerEdgeColor.y;
            vec3 edgeRainbow = .5 + .5 * cos(6.28318 * (vec3(0.0, .333, .667) + edgePhase));
            vec3 edgeFilm = outgoingLight * .2 + edgeRainbow + vec3(.035);
            if (stickerEdgeColor.w > 0.0) {
              float sheen = pow(.5 + .5 * cos(6.28318 * (dot(foilUv, vec2(.45, -.6))
                + angleShift * .7 + flow * stickerEdgeColor.y * .08)), 6.0);
              edgeFilm += vec3(.65, .78, .9) * sheen * stickerEdgeColor.w;
            }
            outgoingLight = mix(outgoingLight, edgeFilm, edgeMask * stickerEdgeShape.z);
          }
        }
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => `mi-note-holographic-star-seal-v11-${stickerTextureSize}`;
  const geometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
  (geometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geometry.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geometry.attributes.uv as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  let pixels: Uint8ClampedArray | undefined;
  mesh.raycast = (raycaster, intersections) => {
    if (!pixels) return;
    const hits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, hits);
    for (const hit of hits) {
      if (!hit.uv) continue;
      const x = THREE.MathUtils.clamp(Math.floor(hit.uv.x * stickerTextureSize), 0, stickerTextureSize - 1);
      const y = THREE.MathUtils.clamp(Math.floor((1 - hit.uv.y) * stickerTextureSize), 0, stickerTextureSize - 1);
      const offset = (y * stickerTextureSize + x) * 4;
      const artworkAlpha = finishPixels[offset + 3] / 255;
      const distance = (finishPixels[offset + 2] / 255 * 2 - 1) * edgeDistanceRange;
      const radius = effectUniforms.stickerEdgeBounds.value.y;
      const backingAlpha = 1 - THREE.MathUtils.smoothstep(-distance, radius - outlineAntialias, radius + outlineAntialias);
      if (artworkAlpha + (1 - artworkAlpha) * backingAlpha >= material.alphaTest) intersections.push(hit);
    }
  };
  let currentVerticalPosition = normalizeMiNoteStarVerticalPosition(verticalPosition);
  const pivot = new THREE.Group();
  pivot.position.set(width, (0.5 - currentVerticalPosition) * height, spine / 2);
  pivot.add(mesh);
  parent.add(pivot);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map,
    color: 0x000000,
    vertexColors: true,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  shadowMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.stickerFinishMap = { value: finishMap };
    shader.uniforms.stickerEdgeBounds = effectUniforms.stickerEdgeBounds;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform sampler2D stickerFinishMap;
        uniform vec2 stickerEdgeBounds;
      `)
      .replace('#include <map_fragment>', stickerCoverageFragment);
  };
  shadowMaterial.customProgramCacheKey = () => `mi-note-star-seal-shadow-v5-${stickerTextureSize}`;
  const shadows = [-1, 1].map((side) => {
    const shadowGeometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
    shadowGeometry.setAttribute('uv', geometry.attributes.uv);
    shadowGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 4), 4).setUsage(THREE.DynamicDrawUsage));
    (shadowGeometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.frustumCulled = false;
    shadow.raycast = () => undefined;
    pivot.add(shadow);
    return { geometry: shadowGeometry, side };
  });

  let disposed = false;
  let started = false;
  let finished = false;
  let lastProgress = -1;
  let lastFlutter = 0;
  let lastTwist = 0;
  let currentFoldPosition = normalizeMiNoteStarFoldPosition(foldPosition);
  let currentRotationOffsetDegrees = normalizeMiNoteStarRotationOffset(rotationOffsetDegrees);
  let currentSizeScale = normalizeMiNoteStarSizeScale(sizeScale);
  const pose = (progress: number, flutter = 0, twist = 0) => {
    if (progress === lastProgress && flutter === lastFlutter && twist === lastTwist) return;
    lastProgress = progress;
    lastFlutter = flutter;
    lastTwist = twist;
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    const stickerWidth = STICKER_WIDTH * currentSizeScale;
    const eased = progress ** 3 * (10 - 15 * progress + 6 * progress * progress);
    const angle = THREE.MathUtils.degToRad(5 - currentRotationOffsetDegrees);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const back = -thickness / 2 - SURFACE_CLEARANCE;
    const closedRadius = (spine + thickness + 2 * SURFACE_CLEARANCE) / 2;
    const wrapLength = Math.PI * closedRadius;
    const backTangent = currentFoldPosition + wrapLength / (2 * stickerWidth);
    const bendAngle = THREE.MathUtils.lerp(Math.PI, 0.85, eased) + flutter;
    const peeledArcLength = Math.max(wrapLength, Math.min(0.25, backTangent * stickerWidth * 0.66));
    const arcLength = THREE.MathUtils.lerp(wrapLength, peeledArcLength, eased);
    const curl = THREE.MathUtils.clamp((eased - 0.65) / 0.35, 0, 1);
    const curvature = -24 * curl * curl * (3 - 2 * curl);
    const distances = [arcLength, 0];
    const uniformRows = HEIGHT_SEGMENTS - 2 * distances.length;
    const rows = Array.from({ length: uniformRows + 1 }, (_, row) => 1 - row / uniformRows);
    for (const distance of distances) {
      for (const u of [0, 1]) {
        rows.push(Math.abs(sin) < 1e-8 ? 0 : THREE.MathUtils.clamp(
          0.5 + (distance - (backTangent - 0.5) * stickerWidth + (u - 0.5) * stickerWidth * cos) / (stickerWidth * sin),
          0,
          1,
        ));
      }
    }
    rows.sort((a, b) => b - a);
    for (let row = 0; row <= HEIGHT_SEGMENTS; row += 1) {
      const v = rows[row];
      const y = (v - 0.5) * stickerWidth;
      const boundaries = [0, ...distances.map((distance) => THREE.MathUtils.clamp(
        0.5 + ((backTangent - 0.5) * stickerWidth - distance + y * sin) / (stickerWidth * cos),
        0,
        1,
      )), 1];
      const rowAngle = bendAngle + twist * y / stickerWidth;
      const radius = arcLength / rowAngle;
      let column = 0;
      for (let section = 0; section < PROFILE_SEGMENTS.length; section += 1) {
        const segments = PROFILE_SEGMENTS[section];
        for (let step = section === 0 ? 0 : 1; step <= segments; step += 1) {
          const u = THREE.MathUtils.lerp(boundaries[section], boundaries[section + 1], step / segments);
          const x = (u - 0.5) * stickerWidth;
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;
          const distance = (backTangent - 0.5) * stickerWidth - rotatedX;
          const point = sealPoint(distance, rowAngle, radius, curvature + flutter * 8);
          const index = row * (WIDTH_SEGMENTS + 1) + column;
          position.setXYZ(index, point.x, rotatedY, back + point.z - spine / 2);
          uv.setXY(index, u, v);
          for (const shadow of shadows) {
            const surface = shadow.side < 0 ? -thickness / 2 : spine + thickness / 2;
            const lift = shadow.side * (back + point.z - surface);
            const opacity = lift > 0 ? Math.exp(-lift * 65) : 0;
            shadow.geometry.attributes.position.setXYZ(index,
              Math.min(0, point.x + Math.max(0, lift) * 0.4),
              rotatedY - Math.max(0, lift) * 0.6,
              surface + shadow.side * 0.0001 - spine / 2,
            );
            shadow.geometry.attributes.color.setXYZW(index, 1, 1, 1, opacity);
          }
          column += 1;
        }
      }
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    for (const shadow of shadows) {
      shadow.geometry.attributes.position.needsUpdate = true;
      shadow.geometry.attributes.color.needsUpdate = true;
    }
  };
  pose(0);

  const artwork = new Image();
  let cancelReady: (() => void) | undefined;
  let loadTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearLoadTimeout = () => {
    if (loadTimeout === undefined) return;
    clearTimeout(loadTimeout);
    loadTimeout = undefined;
  };
  const ready = new Promise<void>((resolve, reject) => {
    cancelReady = () => reject(new DOMException('Star sticker loading was cancelled.', 'AbortError'));
    artwork.onload = () => {
      clearLoadTimeout();
      if (disposed) return;
      try {
        const scale = (stickerTextureSize - 2 * artworkPadding) / Math.max(artwork.naturalWidth, artwork.naturalHeight);
        const artworkWidth = artwork.naturalWidth * scale;
        const artworkHeight = artwork.naturalHeight * scale;
        context.imageSmoothingQuality = 'high';
        context.drawImage(artwork, (stickerTextureSize - artworkWidth) / 2, (stickerTextureSize - artworkHeight) / 2, artworkWidth, artworkHeight);
        const artworkPixels = context.getImageData(0, 0, stickerTextureSize, stickerTextureSize);
        const finished = createMiNoteStickerFinish(artworkPixels.data, stickerTextureSize, stickerTextureSize, MI_NOTE_STICKER_OUTLINE_SUPPORT * resolutionScale, resolutionScale);
        artworkPixels.data.set(finished.pixels);
        context.putImageData(artworkPixels, 0, 0);
        pixels = artworkPixels.data;
        finishPixels.set(finished.finish);
        finishMap.needsUpdate = true;
        map.needsUpdate = true;
        cancelReady = undefined;
        resolve();
        onInvalidate?.();
      } catch (error) {
        cancelReady = undefined;
        reject(error);
      }
    };
    artwork.onerror = () => {
      clearLoadTimeout();
      cancelReady = undefined;
      reject(new Error('The star sticker could not be loaded.'));
    };
    loadTimeout = setTimeout(() => {
      loadTimeout = undefined;
      artwork.onload = null;
      artwork.onerror = null;
      artwork.removeAttribute('src');
      cancelReady = undefined;
      reject(new Error('The star sticker took too long to load.'));
    }, ARTWORK_TIMEOUT_MS);
    artwork.src = star.src;
  });

  return {
    ready,
    getFocus(target: THREE.Vector3) {
      return mesh.localToWorld(target.copy(geometry.boundingSphere!.center));
    },
    setEffectSettings(value: MiNoteStickerEffectSettings) {
      if (disposed || value === currentEffectSettings) return;
      const next = normalizeMiNoteStickerEffectSettings(value);
      if (Object.entries(next).every(([key, setting]) => currentEffectSettings[key as keyof MiNoteStickerEffectSettings] === setting)) return;
      currentEffectSettings = next;
      updateEffectUniforms();
      onInvalidate?.();
    },
    setFoldPosition(value: number) {
      const next = normalizeMiNoteStarFoldPosition(value);
      if (disposed || next === currentFoldPosition) return;
      currentFoldPosition = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress, lastFlutter, lastTwist);
      onInvalidate?.();
    },
    setRotationOffsetDegrees(value: number) {
      const next = normalizeMiNoteStarRotationOffset(value);
      if (disposed || next === currentRotationOffsetDegrees) return;
      currentRotationOffsetDegrees = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress, lastFlutter, lastTwist);
      onInvalidate?.();
    },
    setVerticalPosition(value: number) {
      const next = normalizeMiNoteStarVerticalPosition(value);
      if (disposed || next === currentVerticalPosition) return;
      currentVerticalPosition = next;
      pivot.position.y = (0.5 - next) * height;
      onInvalidate?.();
    },
    setSizeScale(value: number) {
      const next = normalizeMiNoteStarSizeScale(value);
      if (disposed || next === currentSizeScale) return;
      currentSizeScale = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress, lastFlutter, lastTwist);
      onInvalidate?.();
    },
    start() {
      if (started || disposed) return;
      started = true;
      onInvalidate?.();
    },
    update(elapsedSeconds: number, reducedMotion: boolean, motion = 0) {
      if (disposed) return true;
      if (!started) return false;
      const elapsed = Math.max(0, elapsedSeconds);
      finished ||= reducedMotion || elapsed >= PEEL_DURATION;
      const progress = finished ? 1 : Math.min(1, elapsed / PEEL_DURATION);
      const release = THREE.MathUtils.smoothstep(progress, 0.65, 1);
      const flutter = reducedMotion ? 0 : release * (
        Math.sin(elapsed * 4.2) * 0.11 + Math.sin(elapsed * 7.1 + 0.8) * 0.035
        + THREE.MathUtils.clamp(motion, -1, 1) * 0.24
      );
      const twist = reducedMotion ? 0 : release * Math.sin(elapsed * 5.3 + 1.2) * 0.12;
      pose(progress, flutter, twist);
      return finished;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      artwork.onload = null;
      artwork.onerror = null;
      artwork.removeAttribute('src');
      clearLoadTimeout();
      cancelReady?.();
      cancelReady = undefined;
      pixels = undefined;
      pivot.removeFromParent();
      geometry.dispose();
      shadows.forEach((shadow) => shadow.geometry.dispose());
      shadowMaterial.dispose();
      material.dispose();
      map.dispose();
      finishMap.dispose();
    },
  };
}
