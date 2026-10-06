import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createMiNotePackSeal } from '../src/lib/miNotePackSeal.ts';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, type MiNoteStickerEffectSettings } from '../src/lib/miNoteStickerEffects.ts';

function setupArtwork(
  t: TestContext,
  pixels = new Uint8ClampedArray(512 * 512 * 4).fill(255),
  onWrite: (pixels: Uint8ClampedArray) => void = () => undefined,
  onDraw: (rect: number[]) => void = () => undefined,
) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const requests: string[] = [];
  const context = {
    drawImage(_image: unknown, x: number, y: number, width: number, height: number) { onDraw([x, y, width, height]); },
    getImageData: () => ({ data: pixels }),
    putImageData(image: { data: Uint8ClampedArray }) { onWrite(image.data); },
    imageSmoothingQuality: 'low',
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      naturalWidth = 2048;
      naturalHeight = 2048;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        requests.push(value);
        queueMicrotask(() => this.onload?.());
      }
      removeAttribute() {}
    },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
  return requests;
}

async function createSeal(
  t: TestContext,
  foldPosition: number,
  rotationOffsetDegrees = 0,
  thickness = 0.0018,
  layout: Partial<Pick<Parameters<typeof createMiNotePackSeal>[0], 'star' | 'verticalPosition' | 'sizeScale' | 'stickerTextureSize' | 'onInvalidate'>> = {},
) {
  const parent = new THREE.Group();
  const seal = createMiNotePackSeal({
    parent,
    width: 1.29,
    height: 1.82,
    spine: 0.0158,
    thickness,
    star: { id: 'test', name: 'Test star', src: '/star.png', foldPosition, rotationOffsetDegrees, sizeScale: 1 },
    foldPosition,
    rotationOffsetDegrees,
    verticalPosition: 0.5,
    sizeScale: 1,
    ...layout,
  });
  t.after(() => seal.dispose());
  await seal.ready;
  const pivot = parent.children[0];
  const mesh = pivot.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  assert.ok(mesh instanceof THREE.Mesh);
  return { seal, parent, pivot, mesh };
}

test('sticker quality scales texture support and float shader constants without changing physical geometry', async (t) => {
  const cacheKeys = new Set<string>();
  const shadowCacheKeys = new Set<string>();
  let baselinePositions: ArrayLike<number> | undefined;
  for (const size of [512, 1024, 2048] as const) {
    await t.test(`${size}px`, async (t) => {
      const source = new Uint8ClampedArray(size * size * 4).fill(255);
      let artworkRect: number[] | undefined;
      setupArtwork(t, source, undefined, rect => { artworkRect = rect; });
      const { mesh } = await createSeal(t, 0.573, 0, 0.0018, { stickerTextureSize: size === 512 ? undefined : size });
      const material = mesh.material;
      const artworkCanvas = material.map!.image as HTMLCanvasElement;
      const finishMap = material.bumpMap as THREE.DataTexture;
      const scale = size / 512;
      assert.deepEqual(artworkRect, [32 * scale, 32 * scale, 448 * scale, 448 * scale]);
      assert.equal(artworkCanvas.width, size);
      assert.equal(artworkCanvas.height, size);
      assert.equal(finishMap.image.width, size);
      assert.equal(finishMap.image.height, size);
      if (!baselinePositions) baselinePositions = mesh.geometry.attributes.position.array.slice();
      else assert.deepEqual(mesh.geometry.attributes.position.array, baselinePositions);
      const shader = {
        ...THREE.ShaderLib.physical,
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
      } as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      const shadowMaterial = (mesh.parent!.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>).material;
      const shadowShader = {
        ...THREE.ShaderLib.basic,
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
      } as THREE.WebGLProgramParametersWithUniforms;
      shadowMaterial.onBeforeCompile(shadowShader, {} as THREE.WebGLRenderer);
      for (const fragment of [shader.fragmentShader, shadowShader.fragmentShader]) {
        const distance = fragment.match(/float stickerDistance = .* \* (\d+\.\d+);/);
        const antialias = fragment.match(/float stickerAntialias = max\((\d+\.\d+),/);
        assert.ok(distance, 'distance range must be a GLSL float');
        assert.ok(antialias, 'antialias threshold must be a GLSL float');
        assert.equal(Number(distance[1]) / size, 48 / 512);
        assert.equal(Number(antialias[1]) / size, 0.75 / 512);
      }
      const edgeBlend = shader.fragmentShader.match(/float edgeBlend = max\((\d+\.\d+),/);
      assert.ok(edgeBlend, 'edge blend threshold must be a GLSL float');
      assert.equal(Number(edgeBlend[1]) / size, 0.75 / 512);
      const settings = DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS;
      assert.equal(shader.uniforms.stickerEdgeShape.value.x / size, settings.width);
      assert.equal(shader.uniforms.stickerEdgeBounds.value.y / size, settings.width * settings.outerness);
      cacheKeys.add(material.customProgramCacheKey());
      shadowCacheKeys.add(shadowMaterial.customProgramCacheKey());
    });
  }
  assert.equal(cacheKeys.size, 3);
  assert.equal(shadowCacheKeys.size, 3);
});

function frontMaterialArea(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const indices = geometry.index!;
  let area = 0;
  for (let index = 0; index < indices.count; index += 3) {
    const a = indices.getX(index);
    const b = indices.getX(index + 1);
    const c = indices.getX(index + 2);
    if (positions.getZ(a) <= 0 || positions.getZ(b) <= 0 || positions.getZ(c) <= 0) continue;
    area += Math.abs(
      (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
      - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a)),
    ) / 2;
  }
  return area;
}

function assertBoundsMatchVertices(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const actualBox = new THREE.Box3().setFromBufferAttribute(positions);
  assert.ok(geometry.boundingBox?.equals(actualBox));
  const sphere = geometry.boundingSphere;
  assert.ok(sphere);
  const point = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    point.fromBufferAttribute(positions, index);
    assert.ok(sphere.center.distanceTo(point) <= sphere.radius + 1e-7);
  }
}

function assertAdhesiveRemainsAttached(
  mesh: THREE.Mesh<THREE.PlaneGeometry>,
  pivot: THREE.Object3D,
  foldPosition: number,
  rotationOffsetDegrees: number,
  sizeScale = 1,
) {
  const width = 0.56 * sizeScale;
  const thickness = 0.0018;
  const spine = 0.0158;
  const clearance = 0.0015;
  const radius = (spine + thickness + 2 * clearance) / 2;
  const angle = (5 - rotationOffsetDegrees) * Math.PI / 180;
  const position = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  let attachedVertices = 0;
  for (let index = 0; index < position.count; index += 1) {
    const x = (uv.getX(index) - 0.5) * width;
    const y = (uv.getY(index) - 0.5) * width;
    const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
    const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
    const distance = (foldPosition - 0.5) * width + Math.PI * radius / 2 - rotatedX;
    if (distance > -1e-6) continue;
    assert.ok(Math.abs(position.getX(index) - distance) < 1e-7);
    assert.ok(Math.abs(position.getY(index) - rotatedY) < 1e-7);
    assert.ok(Math.abs(position.getZ(index) + pivot.position.z + thickness / 2 + clearance) < 1e-7);
    attachedVertices += 1;
  }
  assert.ok(attachedVertices > 0);
}

test('omitted layout uses the raised pack position and each star preset size', async (t) => {
  setupArtwork(t);
  for (const star of MI_NOTE_PACK_STARS) {
    const preset = await createSeal(t, star.foldPosition, star.rotationOffsetDegrees, 0.0018, {
      star, verticalPosition: undefined, sizeScale: undefined,
    });
    const explicit = await createSeal(t, star.foldPosition, star.rotationOffsetDegrees, 0.0018, {
      star, verticalPosition: 0.485, sizeScale: star.sizeScale,
    });
    assert.ok(Math.abs(preset.pivot.position.y - 0.015 * 1.82) < 1e-10);
    assert.deepEqual(preset.mesh.geometry.attributes.position.array, explicit.mesh.geometry.attributes.position.array);
    assertBoundsMatchVertices(preset.mesh.geometry);
  }
});

test('fold adjustment updates a stationary seal and hit bounds without replacing or reloading assets', async (t) => {
  const requests = setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  const geometry = mesh.geometry;
  const material = mesh.material;
  const texture = material.map;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const originalPositions = Array.from(positions.array);
  const originalUv = Array.from(uv.array);
  const originalFront = frontMaterialArea(geometry);
  const originalBounds = new THREE.Box3().setFromObject(mesh);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setFoldPosition(0.7);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.equal(geometry.attributes.uv, uv);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(uv.array), originalUv);
  assert.ok(frontMaterialArea(geometry) > originalFront);
  assert.ok(!new THREE.Box3().setFromObject(mesh).equals(originalBounds));
  assert.ok(!geometry.boundingSphere!.equals(originalSphere));
  assertBoundsMatchVertices(geometry);
  assert.deepEqual(requests, ['/star.png']);

  const version = (positions as THREE.BufferAttribute).version;
  seal.setFoldPosition(0.7);
  assert.equal((positions as THREE.BufferAttribute).version, version);
});

test('peeling, flutter, and live tuning reuse the existing sticker resources without texture uploads', async (t) => {
  let artworkWrites = 0;
  const requests = setupArtwork(t, undefined, () => { artworkWrites += 1; });
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.573);
  const children = [...pivot.children];
  assert.equal(children.length, 3);
  const meshes = children.map((child) => {
    assert.ok(child instanceof THREE.Mesh);
    return child as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial>;
  });
  const materials = meshes.map((child) => child.material);
  const geometries = meshes.map((child) => child.geometry);
  const map = mesh.material.map;
  const finishMap = mesh.material.bumpMap;
  assert.ok(map instanceof THREE.CanvasTexture);
  assert.ok(finishMap instanceof THREE.DataTexture);
  assert.equal(new Set(materials).size, 2);
  assert.equal(new Set(geometries).size, 3);
  for (const shadow of meshes.slice(1)) {
    assert.ok(shadow.material instanceof THREE.MeshBasicMaterial);
    assert.equal(shadow.material.map, map);
  }
  const mapVersion = map.version;
  const finishVersion = finishMap.version;
  const positions = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const positionVersion = positions.version;

  seal.start();
  for (const [index, elapsed] of [0.1, 0.7, 1.2, 3.6, 8].entries()) {
    seal.update(elapsed, false, index % 2 === 0 ? 1 : -1);
    seal.setFoldPosition(0.4 + index * 0.1);
    seal.setRotationOffsetDegrees(-8 + index * 4);
    seal.setVerticalPosition(0.3 + index * 0.1);
    seal.setSizeScale(0.6 + index * 0.2);
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0], pivot);
    assert.equal(pivot.children.length, children.length);
    meshes.forEach((child, meshIndex) => {
      assert.equal(pivot.children[meshIndex], child);
      assert.equal(child.geometry, geometries[meshIndex]);
      assert.equal(child.material, materials[meshIndex]);
      assert.equal(child.material.map, map);
    });
    assert.equal(mesh.material.bumpMap, finishMap);
    assert.equal(map.version, mapVersion);
    assert.equal(finishMap.version, finishVersion);
  }
  assert.ok(positions.version > positionVersion);
  assert.equal(artworkWrites, 1);
  assert.deepEqual(requests, ['/star.png']);
});

test('vertical positioning moves sticker, shadows, focus, and picking together without changing geometry', async (t) => {
  setupArtwork(t);
  let invalidations = 0;
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.573, 0, 0.0018, {
    onInvalidate: () => { invalidations += 1; },
  });
  const meshes = pivot.children as THREE.Mesh<THREE.PlaneGeometry>[];
  const versions = meshes.map(child => (child.geometry.attributes.position as THREE.BufferAttribute).version);
  const originalFocus = seal.getFocus(new THREE.Vector3());
  const ray = new THREE.Raycaster(new THREE.Vector3(1.2, 0, 1), new THREE.Vector3(0, 0, -1));
  parent.updateMatrixWorld(true);
  const originalHits = ray.intersectObject(mesh);
  assert.ok(originalHits.length > 0);
  const before = invalidations;

  seal.setVerticalPosition(0.2);
  parent.updateMatrixWorld(true);

  const offset = 0.3 * 1.82;
  assert.equal(pivot.position.y, offset);
  assert.equal(invalidations, before + 1);
  const movedFocus = seal.getFocus(new THREE.Vector3());
  assert.ok(movedFocus.distanceTo(originalFocus.clone().add(new THREE.Vector3(0, offset, 0))) < 1e-10);
  assert.equal(ray.intersectObject(mesh).length, 0);
  ray.ray.origin.y += offset;
  const movedHits = ray.intersectObject(mesh);
  assert.ok(movedHits.length > 0);
  assert.ok(movedHits[0].point.distanceTo(originalHits[0].point.clone().add(new THREE.Vector3(0, offset, 0))) < 1e-7);
  meshes.forEach((child, index) => {
    assert.equal(child.parent, pivot);
    assert.equal((child.geometry.attributes.position as THREE.BufferAttribute).version, versions[index]);
  });
  seal.setVerticalPosition(0.2001);
  assert.equal(invalidations, before + 1);
  seal.dispose();
  seal.setVerticalPosition(0.7);
  assert.equal(pivot.position.y, offset);
  assert.equal(invalidations, before + 1);
});

test('size tuning changes sticker dimensions while preserving the fixed pack wrap and current peel pose', async (t) => {
  setupArtwork(t);
  let invalidations = 0;
  const adjusted = await createSeal(t, 0.573, -15, 0.0018, {
    onInvalidate: () => { invalidations += 1; },
  });
  const baselineSize = adjusted.mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
  for (const sizeScale of [0.5, 1.25, 1.5]) {
    const before = invalidations;
    adjusted.seal.setSizeScale(sizeScale);
    const size = adjusted.mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.y - baselineSize.y * sizeScale) < 1e-7);
    assert.ok(Math.abs(size.z - baselineSize.z) < 1e-7);
    assert.ok(adjusted.pivot.scale.equals(new THREE.Vector3(1, 1, 1)));
    assertAdhesiveRemainsAttached(adjusted.mesh, adjusted.pivot, 0.573, -15, sizeScale);
    assertBoundsMatchVertices(adjusted.mesh.geometry);
    assert.equal(invalidations, before + 1);
    const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
    adjusted.seal.setSizeScale(sizeScale + 0.001);
    assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
    assert.equal(invalidations, before + 1);
  }

  adjusted.seal.start();
  for (const [elapsed, sizeScale] of [[1.1, 0.65], [3.6, 1.35]]) {
    adjusted.seal.update(elapsed, false, 0.8);
    adjusted.seal.setSizeScale(sizeScale);
    const reference = await createSeal(t, 0.573, -15, 0.0018, { verticalPosition: 0.3, sizeScale });
    reference.seal.start();
    reference.seal.update(elapsed, false, 0.8);
    assert.equal(reference.pivot.position.y, 0.2 * 1.82);
    assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);
    assertAdhesiveRemainsAttached(adjusted.mesh, adjusted.pivot, 0.573, -15, sizeScale);
    assertBoundsMatchVertices(adjusted.mesh.geometry);
  }
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  const before = invalidations;
  adjusted.seal.dispose();
  adjusted.seal.setSizeScale(1);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
  assert.equal(invalidations, before);
});

test('effect tuning updates existing uniforms without recompiling or replacing sticker resources', async (t) => {
  let artworkWrites = 0;
  let invalidations = 0;
  const requests = setupArtwork(t, undefined, () => { artworkWrites += 1; });
  const parent = new THREE.Group();
  const initial: MiNoteStickerEffectSettings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS };
  const seal = createMiNotePackSeal({
    parent,
    width: 1.29,
    height: 1.82,
    spine: 0.0158,
    thickness: 0.0018,
    star: { id: 'test', name: 'Test star', src: '/star.png', foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
    foldPosition: 0.573,
    rotationOffsetDegrees: 0,
    effectSettings: initial,
    onInvalidate: () => { invalidations += 1; },
  });
  t.after(() => seal.dispose());
  await seal.ready;
  const mesh = parent.children[0].children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  const geometry = mesh.geometry;
  const material = mesh.material;
  const map = material.map!;
  const finishMap = material.bumpMap!;
  const materialVersion = material.version;
  const mapVersion = map.version;
  const finishVersion = finishMap.version;
  const shader = {
    ...THREE.ShaderLib.physical,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  const shadowMeshes = mesh.parent!.children.slice(1) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  const shadowMaterial = shadowMeshes[0].material;
  assert.ok(shadowMaterial instanceof THREE.MeshBasicMaterial);
  assert.ok(shadowMeshes.every(shadow => shadow.material === shadowMaterial));
  const shadowMaterialVersion = shadowMaterial.version;
  const shadowShader = {
    ...THREE.ShaderLib.basic,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
  } as THREE.WebGLProgramParametersWithUniforms;
  shadowMaterial.onBeforeCompile(shadowShader, {} as THREE.WebGLRenderer);
  const shape = shader.uniforms.stickerEdgeShape;
  const color = shader.uniforms.stickerEdgeColor;
  const bounds = shader.uniforms.stickerEdgeBounds;
  const shapeValue = shape.value;
  const colorValue = color.value;
  const boundsValue = bounds.value;
  assert.ok(shapeValue instanceof THREE.Vector4);
  assert.ok(colorValue instanceof THREE.Vector4);
  assert.ok(boundsValue instanceof THREE.Vector2);
  const assertEffect = (settings: MiNoteStickerEffectSettings) => {
    assert.equal(shader.uniforms.stickerEdgeShape, shape);
    assert.equal(shader.uniforms.stickerEdgeColor, color);
    assert.equal(shader.uniforms.stickerEdgeBounds, bounds);
    assert.equal(shape.value, shapeValue);
    assert.equal(color.value, colorValue);
    assert.equal(bounds.value, boundsValue);
    assert.deepEqual(shapeValue.toArray(), [settings.width * 512, settings.softness, settings.strength, settings.scale]);
    assert.deepEqual(colorValue.toArray(), [settings.hue, settings.variation, settings.motion, settings.shine]);
    assert.deepEqual(boundsValue.toArray(), [
      settings.width * 512 * (1 - settings.outerness),
      settings.width * 512 * settings.outerness,
    ]);
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(material.map, map);
    assert.equal(material.bumpMap, finishMap);
    assert.equal(shader.uniforms.stickerFinishMap.value, finishMap);
    assert.equal(shadowShader.uniforms.stickerFinishMap.value, finishMap);
    assert.equal(shadowShader.uniforms.stickerEdgeBounds, bounds);
    assert.equal(shadowMaterial.version, shadowMaterialVersion);
    assert.equal(material.version, materialVersion);
    assert.equal(map.version, mapVersion);
    assert.equal(finishMap.version, finishVersion);
  };
  const tune = (settings: MiNoteStickerEffectSettings) => {
    const versions = ['position', 'normal', 'uv'].map(name => (geometry.attributes[name] as THREE.BufferAttribute).version);
    const before = invalidations;
    seal.setEffectSettings(settings);
    assert.equal(invalidations, before + 1);
    assertEffect(settings);
    assert.deepEqual(['position', 'normal', 'uv'].map(name => (geometry.attributes[name] as THREE.BufferAttribute).version), versions);
    seal.setEffectSettings(settings);
    seal.setEffectSettings({ ...settings });
    assert.equal(invalidations, before + 1);
  };
  assertEffect(initial);
  const readyInvalidations = invalidations;
  seal.setEffectSettings({ ...initial });
  assert.equal(invalidations, readyInvalidations);
  const prism: MiNoteStickerEffectSettings = {
    mode: 'prism', width: 0.045, outerness: 0.9, softness: 0.6, strength: 0.8, scale: 2.4,
    hue: 0.35, variation: 0.55, motion: 1.5, shine: 0.7,
  };
  tune(prism);
  tune({ ...prism, width: 0.025, outerness: 0.4, hue: 0.8 });
  tune({ ...prism, outerness: 0 });
  seal.start();
  assert.equal(seal.update(1.2, false), true);
  tune({ ...prism, softness: 0.9, scale: 0.8, motion: 0.5 });
  tune({ ...prism, strength: 0.4, variation: 0.1, shine: 0 });
  tune(initial);
  seal.dispose();
  const disposedInvalidations = invalidations;
  seal.setEffectSettings(prism);
  assert.equal(invalidations, disposedInvalidations);
  assertEffect(initial);
  assert.equal(artworkWrites, 1);
  assert.deepEqual(requests, ['/star.png']);
});

test('fold endpoints maintain valid geometry and moving right increases the front portion', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.1);
  let previousFront = frontMaterialArea(mesh.geometry);
  for (const value of [0.3, 0.573, 0.7, 0.9]) {
    seal.setFoldPosition(value);
    const nextFront = frontMaterialArea(mesh.geometry);
    assert.ok(nextFront > previousFront);
    previousFront = nextFront;
    for (const attribute of [mesh.geometry.attributes.position, mesh.geometry.attributes.normal]) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
    assertBoundsMatchVertices(mesh.geometry);
  }
});

test('rotation updates a stationary seal in place and returning to zero preserves its fold', async (t) => {
  const requests = setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  seal.setFoldPosition(0.7);
  const geometry = mesh.geometry;
  const material = mesh.material;
  const texture = material.map;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const originalPositions = Array.from(positions.array);
  const originalNormals = Array.from(normals.array);
  const originalUv = Array.from(uv.array);
  const originalBounds = new THREE.Box3().setFromObject(mesh);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setRotationOffsetDegrees(7.5);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.equal(geometry.attributes.uv, uv);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(uv.array), originalUv);
  assert.ok(!new THREE.Box3().setFromObject(mesh).equals(originalBounds));
  assert.ok(!geometry.boundingSphere!.equals(originalSphere));
  assertBoundsMatchVertices(geometry);
  const clockwisePositions = Array.from(positions.array);

  const version = (positions as THREE.BufferAttribute).version;
  seal.setRotationOffsetDegrees(7.5);
  assert.equal((positions as THREE.BufferAttribute).version, version);

  seal.setRotationOffsetDegrees(-7.5);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(positions.array), clockwisePositions);
  assertBoundsMatchVertices(geometry);

  seal.setRotationOffsetDegrees(0);
  assert.deepEqual(Array.from(positions.array), originalPositions);
  assert.deepEqual(Array.from(normals.array), originalNormals);
  assert.deepEqual(Array.from(uv.array), originalUv);
  assertBoundsMatchVertices(geometry);
  assert.deepEqual(requests, ['/star.png']);
});

test('rotation endpoints keep finite geometry and positive offsets rotate artwork clockwise', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.573);
  for (const foldPosition of [0.1, 0.573, 0.9]) {
    seal.setFoldPosition(foldPosition);
    for (const rotationOffsetDegrees of [-15, 0, 15]) {
      seal.setRotationOffsetDegrees(rotationOffsetDegrees);
      const geometry = mesh.geometry;
      for (const attribute of [geometry.attributes.position, geometry.attributes.normal]) {
        assert.ok(Array.from(attribute.array).every(Number.isFinite));
      }
      const angle = (5 - rotationOffsetDegrees) * Math.PI / 180;
      const uv = geometry.attributes.uv;
      const x = (uv.getX(0) - 0.5) * 0.56;
      const y = (uv.getY(0) - 0.5) * 0.56;
      assert.ok(Math.abs(geometry.attributes.position.getY(0) - (x * Math.sin(angle) + y * Math.cos(angle))) < 1e-7);
      assertBoundsMatchVertices(geometry);
    }
  }
});

test('sealed sticker follows both cover surfaces and the pack edge without penetrating the pack', async (t) => {
  setupArtwork(t);
  const width = 1.29;
  const spine = 0.0158;
  const clearance = 0.0015;
  const tolerance = 1e-7;
  for (const thickness of [0.0018, 0.0036]) {
    const { seal, pivot, mesh } = await createSeal(t, 0.573, 0, thickness);
    const backCover = -thickness / 2;
    const frontCover = spine + thickness / 2;
    const radius = (spine + thickness + 2 * clearance) / 2;
    const centerZ = spine / 2;
    for (const foldPosition of [0.1, 0.573, 0.9]) {
      seal.setFoldPosition(foldPosition);
      for (const rotation of [-15, 0, 5, 15]) {
        seal.setRotationOffsetDegrees(rotation);
        const geometry = mesh.geometry;
        const positions = geometry.attributes.position;
        const uv = geometry.attributes.uv;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let maxX = -Infinity;
        let sideVertices = 0;
        for (let index = 0; index < positions.count; index += 1) {
          const x = positions.getX(index) + pivot.position.x;
          const z = positions.getZ(index) + pivot.position.z;
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
          maxX = Math.max(maxX, x);
          assert.ok(x <= width + radius + tolerance);
          assert.ok(z >= backCover - clearance - tolerance);
          assert.ok(z <= frontCover + clearance + tolerance);
          assert.ok(uv.getX(index) >= 0 && uv.getX(index) <= 1);
          assert.ok(uv.getY(index) >= 0 && uv.getY(index) <= 1);
          if (z > backCover + tolerance && z < frontCover - tolerance) {
            assert.ok(x > width);
            assert.ok(Math.abs((x - width) ** 2 + (z - centerZ) ** 2 - radius ** 2) < tolerance);
            sideVertices += 1;
          }
        }
        assert.ok(sideVertices > 0);
        assert.ok(Math.abs(minZ - backCover + clearance) < tolerance);
        assert.ok(Math.abs(maxZ - frontCover - clearance) < tolerance);
        assert.ok(Math.abs(maxX - width - radius) < radius * 0.001);
        const indices = geometry.index!;
        for (let index = 0; index < indices.count; index += 3) {
          const vertices = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
          const beyondEdge = vertices.every((vertex) => positions.getX(vertex) + pivot.position.x >= width - tolerance);
          const behindCover = vertices.every((vertex) => positions.getZ(vertex) + pivot.position.z <= backCover + tolerance);
          const aboveCover = vertices.every((vertex) => positions.getZ(vertex) + pivot.position.z >= frontCover - tolerance);
          assert.ok(beyondEdge || behindCover || aboveCover, `Triangle ${index / 3} crosses the pack at fold ${foldPosition}, rotation ${rotation}`);
        }
        assertBoundsMatchVertices(geometry);
      }
    }
  }
});

test('peeling starts continuously and keeps valid geometry through the completed peel', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.573, -15);
  const geometry = mesh.geometry;
  const originalPositions = Array.from(geometry.attributes.position.array);
  seal.start();
  seal.update(0.001, false);
  for (let index = 0; index < originalPositions.length; index += 1) {
    assert.ok(Math.abs(geometry.attributes.position.array[index] - originalPositions[index]) < 1e-6);
  }
  for (const elapsed of [0.12, 0.35, 0.619, 0.62, 0.9, 1.149]) {
    assert.equal(seal.update(elapsed, false), false);
    for (const attribute of [geometry.attributes.position, geometry.attributes.normal, geometry.attributes.uv]) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
    assertBoundsMatchVertices(geometry);
  }
});

test('peeling starts from the tuned rotation and live rotation retains the current peel pose', async (t) => {
  setupArtwork(t);
  const adjusted = await createSeal(t, 0.7);
  const reference = await createSeal(t, 0.7, 12.3);
  adjusted.seal.setRotationOffsetDegrees(12.3);
  const sealedPositions = Array.from(adjusted.mesh.geometry.attributes.position.array);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);
  adjusted.seal.start();
  reference.seal.start();

  assert.equal(adjusted.seal.update(0, false), false);
  assert.deepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  adjusted.seal.update(0.35, false);
  reference.seal.update(0.35, false);
  assert.notDeepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);

  const nextReference = await createSeal(t, 0.7, -8.2);
  nextReference.seal.start();
  nextReference.seal.update(0.35, false);
  adjusted.seal.setRotationOffsetDegrees(-8.2);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, nextReference.mesh.geometry.attributes.position.array);
  assertBoundsMatchVertices(adjusted.mesh.geometry);
  adjusted.seal.dispose();
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  adjusted.seal.setRotationOffsetDegrees(0);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
});

test('peeling starts at the tuned shape and retains the selected fold throughout animation', async (t) => {
  setupArtwork(t);
  const adjusted = await createSeal(t, 0.3);
  const reference = await createSeal(t, 0.7);
  adjusted.seal.setFoldPosition(0.7);
  const sealedPositions = Array.from(adjusted.mesh.geometry.attributes.position.array);
  adjusted.seal.start();
  reference.seal.start();

  assert.equal(adjusted.seal.update(0, false), false);
  assert.deepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  adjusted.seal.update(0.35, false);
  reference.seal.update(0.35, false);
  assert.notDeepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);
  assertBoundsMatchVertices(adjusted.mesh.geometry);

  const nextReference = await createSeal(t, 0.6);
  nextReference.seal.start();
  nextReference.seal.update(0.35, false);
  adjusted.seal.setFoldPosition(0.6);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, nextReference.mesh.geometry.attributes.position.array);
  assert.equal(adjusted.seal.update(1.2, false), true);
  assert.equal(adjusted.pivot.visible, true);
  adjusted.seal.dispose();
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  adjusted.seal.setFoldPosition(0.5);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
});

test('peeled sticker stays attached and visible while its free section keeps fluttering', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.556, 7.7);
  const pivotPosition = pivot.position.clone();
  const pivotQuaternion = pivot.quaternion.clone();
  seal.start();
  for (const elapsed of [0, 0.3, 0.9, 1.2, 8, 64, 300]) {
    assert.equal(seal.update(elapsed, false), elapsed >= 1.2);
    assert.equal(pivot.parent, parent);
    assert.equal(pivot.visible, true);
    assert.equal(mesh.visible, true);
    assert.ok(pivot.position.equals(pivotPosition));
    assert.ok(pivot.quaternion.equals(pivotQuaternion));
    assertAdhesiveRemainsAttached(mesh, pivot, 0.556, 7.7);
    assertBoundsMatchVertices(mesh.geometry);
  }
  const firstFlutter = Array.from(mesh.geometry.attributes.position.array);
  assert.equal(seal.update(300.2, false), true);
  assert.notDeepEqual(Array.from(mesh.geometry.attributes.position.array), firstFlutter);
  assertAdhesiveRemainsAttached(mesh, pivot, 0.556, 7.7);
});

test('attached sticker follows parent translation and rotation after peeling', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.532, 9.3);
  parent.position.set(0.4, -0.2, 0.7);
  parent.rotation.set(0.2, -0.7, 0.1);
  const localPosition = pivot.position.clone();
  const localQuaternion = pivot.quaternion.clone();
  seal.start();
  seal.update(1.2, false);
  parent.position.set(-1, 0.8, 0.2);
  parent.rotation.set(-0.3, 1.8, 0.4);
  seal.update(15, false);
  parent.updateWorldMatrix(true, true);

  assert.equal(pivot.parent, parent);
  assert.ok(pivot.position.equals(localPosition));
  assert.ok(pivot.quaternion.equals(localQuaternion));
  const expectedPosition = parent.localToWorld(localPosition.clone());
  assert.ok(pivot.getWorldPosition(new THREE.Vector3()).distanceTo(expectedPosition) < 1e-10);
  assert.ok(pivot.getWorldQuaternion(new THREE.Quaternion()).angleTo(parent.quaternion.clone().multiply(localQuaternion)) < 1e-7);
  assertAdhesiveRemainsAttached(mesh, pivot, 0.532, 9.3);
});

test('the reusable focus target follows the deformed seal through world transforms and peeling', async (t) => {
  setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  const ancestor = new THREE.Group();
  ancestor.position.set(-0.4, 0.6, 0.9);
  ancestor.rotation.set(0.2, -0.5, 0.3);
  ancestor.add(parent);
  const target = new THREE.Vector3();
  const expected = new THREE.Vector3();
  seal.start();
  for (const [index, elapsed] of [0, 0.35, 1.2, 2.4].entries()) {
    seal.setFoldPosition(0.4 + index * 0.1);
    seal.setRotationOffsetDegrees(-9 + index * 6);
    seal.update(elapsed, false, 0.7);
    parent.position.set(index * 0.2, -index * 0.1, index * 0.3);
    parent.rotation.set(index * 0.1, index * 0.4, -index * 0.15);
    const positions = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const version = positions.version;
    const localCenter = mesh.geometry.boundingSphere!.center.clone();
    assert.equal(seal.getFocus(target), target);
    mesh.updateWorldMatrix(true, false);
    new THREE.Box3().setFromBufferAttribute(positions).getCenter(expected).applyMatrix4(mesh.matrixWorld);
    assert.ok(target.distanceTo(expected) < 1e-10);
    assert.ok(mesh.geometry.boundingSphere!.center.equals(localCenter));
    assert.equal(positions.version, version);
  }
});

test('reduced motion leaves the peeled sticker attached without ongoing flutter', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.49, 3.2);
  seal.start();
  assert.equal(seal.update(0, true), true);
  const settledPositions = Array.from(mesh.geometry.attributes.position.array);
  for (const elapsed of [1.2, 8, 300]) {
    assert.equal(seal.update(elapsed, true, 1), true);
    assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), settledPositions);
    assert.equal(pivot.parent, parent);
    assert.equal(pivot.visible, true);
    assertAdhesiveRemainsAttached(mesh, pivot, 0.49, 3.2);
  }
  assertBoundsMatchVertices(mesh.geometry);
});

test('pack motion changes the free flap while the adhesive section remains fixed', async (t) => {
  setupArtwork(t);
  const resting = await createSeal(t, 0.487, 2.4);
  const moving = await createSeal(t, 0.487, 2.4);
  resting.seal.start();
  moving.seal.start();
  resting.seal.update(1.2, false);
  moving.seal.update(1.2, false);
  resting.seal.update(2, false, 0);
  moving.seal.update(2, false, 1);
  assert.notDeepEqual(moving.mesh.geometry.attributes.position.array, resting.mesh.geometry.attributes.position.array);
  assertAdhesiveRemainsAttached(resting.mesh, resting.pivot, 0.487, 2.4);
  assertAdhesiveRemainsAttached(moving.mesh, moving.pivot, 0.487, 2.4);
  assertBoundsMatchVertices(moving.mesh.geometry);
});

test('peeled sticker picking respects original alpha away from the outline and preserves transparent areas', async (t) => {
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  const alphaBands = [0, 101, 102, 255];
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) pixels[(y * 512 + x) * 4 + 3] = alphaBands[Math.floor(y / 128)];
  }
  setupArtwork(t, pixels);
  const { seal, parent, mesh } = await createSeal(t, 0.532, 9.3);
  seal.start();
  seal.update(2, true);
  parent.updateMatrixWorld(true);
  const indices = mesh.geometry.index!;
  const position = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  for (const [band, alpha] of alphaBands.entries()) {
    const triangle = new THREE.Triangle();
    let selected = false;
    for (let index = 0; index < indices.count; index += 3) {
      const vertices = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
      const u = vertices.reduce((sum, vertex) => sum + uv.getX(vertex), 0) / 3;
      const v = vertices.reduce((sum, vertex) => sum + uv.getY(vertex), 0) / 3;
      if (u < 0.08 || u > 0.12 || Math.abs(v - (1 - (band + 0.5) / 4)) > 0.02) continue;
      [triangle.a, triangle.b, triangle.c].forEach((point, corner) => point.fromBufferAttribute(position, vertices[corner]).applyMatrix4(mesh.matrixWorld));
      if (triangle.getArea() > 1e-8) { selected = true; break; }
    }
    assert.ok(selected);
    const point = triangle.getMidpoint(new THREE.Vector3());
    const normal = triangle.getNormal(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(point.clone().addScaledVector(normal, 0.01), normal.clone().negate(), 0, 0.04);
    const rawHits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, rawHits);
    assert.ok(rawHits.length > 0);
    assert.equal(Math.floor((1 - rawHits[0].uv!.y) * 4), band);

    const backing = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    backing.position.copy(point).addScaledVector(normal, -0.01);
    backing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    backing.updateMatrixWorld(true);
    const opaque = alpha >= 102;
    assert.equal(raycaster.intersectObject(parent, true).length > 0, opaque);
    assert.equal(raycaster.intersectObjects([backing, parent], true)[0]?.object, opaque ? mesh : backing);
    backing.geometry.dispose();
    backing.material.dispose();
  }
});

test('outward tuning grows and trims picking before and after peeling without uploading resources', async (t) => {
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 220; y < 290; y += 1) {
    for (let x = 330; x < 390; x += 1) pixels.set([250, 70, 25, 255], (y * 512 + x) * 4);
  }
  let renderedPixels: Uint8ClampedArray | undefined;
  let artworkWrites = 0;
  const requests = setupArtwork(t, pixels, (image) => { renderedPixels = image; artworkWrites += 1; });
  const { seal, parent, mesh } = await createSeal(t, 0.532, 9.3);
  assert.ok(renderedPixels);
  assert.deepEqual(Array.from(renderedPixels.slice((255 * 512 + 350) * 4, (255 * 512 + 350) * 4 + 4)), [250, 70, 25, 255]);
  assert.equal(renderedPixels[(255 * 512 + 300) * 4 + 3], 255);
  assert.equal(renderedPixels[(255 * 512 + 299) * 4 + 3], 0);
  for (let coordinate = 0; coordinate < 512; coordinate += 1) {
    for (const [x, y] of [[coordinate, 0], [coordinate, 511], [0, coordinate], [511, coordinate]]) {
      assert.equal(renderedPixels[(y * 512 + x) * 4 + 3], 0);
    }
  }
  const geometry = mesh.geometry;
  const material = mesh.material;
  const map = material.map!;
  const finishMap = material.bumpMap!;
  const mapVersion = map.version;
  const finishVersion = finishMap.version;
  const materialVersion = material.version;
  const artworkCanvas = map.image as HTMLCanvasElement;
  assert.equal(artworkCanvas.width, 512);
  assert.equal(artworkCanvas.height, 512);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const indices = geometry.index!;
  const assertPicked = (x: number, opaque: boolean) => {
    const target = new THREE.Vector3(x / 512, 1 - 255.5 / 512, 0);
    const triangle = new THREE.Triangle();
    const barycentric = new THREE.Vector3();
    let found = false;
    for (let index = 0; index < indices.count; index += 3) {
      const vertices = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
      [triangle.a, triangle.b, triangle.c].forEach((point, corner) => point.set(uv.getX(vertices[corner]), uv.getY(vertices[corner]), 0));
      if (!triangle.getBarycoord(target, barycentric) || Math.min(barycentric.x, barycentric.y, barycentric.z) < 0) continue;
      [triangle.a, triangle.b, triangle.c].forEach((point, corner) => point.fromBufferAttribute(position, vertices[corner]).applyMatrix4(mesh.matrixWorld));
      const point = triangle.a.clone().multiplyScalar(barycentric.x).addScaledVector(triangle.b, barycentric.y).addScaledVector(triangle.c, barycentric.z);
      const normal = triangle.getNormal(new THREE.Vector3());
      const raycaster = new THREE.Raycaster(point.clone().addScaledVector(normal, 0.01), normal.clone().negate(), 0, 0.04);
      const backing = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      backing.position.copy(point).addScaledVector(normal, -0.01);
      backing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      backing.updateMatrixWorld(true);
      assert.equal(raycaster.intersectObjects([backing, parent], true)[0]?.object, opaque ? mesh : backing, `Picking at artwork x=${x}`);
      backing.geometry.dispose();
      backing.material.dispose();
      found = true;
      break;
    }
    assert.ok(found);
  };
  const base = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.055, outerness: 1 };
  const scenarios: { settings: MiNoteStickerEffectSettings; hits: boolean[] }[] = [
    { settings: { ...base, width: 0.01 }, hits: [true, false, false, false] },
    { settings: { ...base, width: 0.04, outerness: 0.9 }, hits: [true, true, true, false] },
    { settings: { ...base, width: 0.02, outerness: 0.9 }, hits: [true, true, false, false] },
    { settings: base, hits: [true, true, true, true] },
    { settings: { ...base, outerness: 0 }, hits: [false, false, false, false] },
    { settings: { ...base, width: 0.04, outerness: 0.1 }, hits: [false, false, false, false] },
    { settings: { ...base, strength: 0 }, hits: [true, true, true, true] },
    { settings: { ...base, width: 0.01 }, hits: [true, false, false, false] },
  ];
  for (const peeled of [false, true]) {
    if (peeled) {
      seal.start();
      assert.equal(seal.update(2, true), true);
    }
    parent.updateMatrixWorld(true);
    for (const { settings, hits } of scenarios) {
      seal.setEffectSettings(settings);
      assertPicked(350.5, true);
      assertPicked(330.5, true);
      assertPicked(329.5, settings.outerness > 0);
      [325.5, 324.5, 315.5, 302.5].forEach((x, index) => assertPicked(x, hits[index]));
      assertPicked(300.5, false);
      assertPicked(480.5, false);
      assert.equal(mesh.geometry, geometry);
      assert.equal(mesh.material, material);
      assert.equal(material.map, map);
      assert.equal(material.bumpMap, finishMap);
      assert.equal(map.version, mapVersion);
      assert.equal(finishMap.version, finishVersion);
      assert.equal(material.version, materialVersion);
    }
  }
  assert.equal(artworkWrites, 1);
  assert.deepEqual(requests, ['/star.png']);
  assert.ok(finishMap instanceof THREE.DataTexture);
  let finishDisposals = 0;
  finishMap.addEventListener('dispose', () => { finishDisposals += 1; });
  seal.dispose();
  seal.dispose();
  assert.equal(finishDisposals, 1);
  assert.equal(parent.children.length, 0);
});
