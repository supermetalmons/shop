import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { stepMiNoteMotion } from '../../lib/miNoteCardTilt';
import type { OverlayRect } from '../../shop/reveal/types';
import { ethereumRevealTiles } from '../revealLayout';
import type { CratePreviewAssets } from './crateAssets';
import { crateOpeningDuration, sampleCrateOpening } from './crateFlow';
import { createCrateModel, CRATE_BOUNDS, CRATE_CAMERA } from './crateModel';

export type CrateSceneProps = {
  assets: CratePreviewAssets | null;
  hit: { id: number; x: number; y: number } | null;
  press?: { id: number; x: number; y: number } | null;
  opening: boolean;
  active: boolean;
  closing?: boolean;
  suspended: boolean;
  reducedMotion: boolean;
  viewport: OverlayRect;
  crateRect: OverlayRect;
  onReady: () => void;
  onAssetsReady: () => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  onFrame: () => void;
  inspectionTime?: number;
};

export function crateRenderDensity(width: number, height: number, deviceRatio: number) {
  return Math.min(Math.max(1, deviceRatio || 1), 2, Math.sqrt(3_000_000 / Math.max(1, width * height)));
}

function createScene(host: HTMLDivElement, props: () => CrateSceneProps) {
  const scene = new THREE.Scene();
  const modelRequest = new AbortController();
  const camera = new THREE.PerspectiveCamera(CRATE_CAMERA.fov, 1218 / 833, 0.01, 100);
  camera.position.fromArray(CRATE_CAMERA.position);
  camera.lookAt(...CRATE_CAMERA.target);
  camera.updateMatrixWorld();
  scene.add(new THREE.HemisphereLight(0xfff8eb, 0x5d4935, 2.4));
  const light = new THREE.DirectionalLight(0xfff3dd, 2);
  light.position.set(-4, 7, 5);
  scene.add(light);
  let renderer: THREE.WebGLRenderer | undefined;
  let model: Awaited<ReturnType<typeof createCrateModel>> | undefined;
  let disposed = false;
  let failed = false;
  let frame = 0;
  let time = 0;
  let previousTime = 0;
  let openingAt: number | null = null;
  let ready = false;
  let assets: CratePreviewAssets | null = null;
  let assetsReady = false;
  let complete = false;
  let processedHit = 0;
  let processedPress = 0;
  let shaderFailed = false;
  let warming = false;
  let warmIndex = 0;
  let warmTarget: THREE.WebGLRenderTarget | null = null;
  let generation = 0;
  let width = 0;
  let height = 0;
  const recoil = { value: 0, velocity: 0 };
  const direction = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const point = new THREE.Vector3();
  const screenPoint = new THREE.Vector3();
  const galleryNormal = new THREE.Vector3();
  const planeGeometry = new THREE.PlaneGeometry(1, 1);
  const cards: Array<{
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    texture: THREE.Texture;
    start: THREE.Vector3;
    rim: THREE.Vector3;
    exit: THREE.Vector3;
    target: THREE.Vector3;
    width: number;
    height: number;
    initialWidth: number;
    initialHeight: number;
  }> = [];
  const chipGeometry = new THREE.BoxGeometry(0.035, 0.012, 0.07);
  const chipMaterial = new THREE.MeshLambertMaterial({ color: 0xb78a54 });
  const chips = new THREE.InstancedMesh(chipGeometry, chipMaterial, 48);
  chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chips.frustumCulled = false;
  const chipPose = new THREE.Object3D();
  const particles = Array.from({ length: 48 }, () => ({
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, spin: 0,
  }));
  let chipCursor = 0;
  chips.visible = false;
  scene.add(chips);

  const canRender = () => !disposed && !failed && props().active && !props().suspended && !document.hidden;
  function invalidate() {
    if (canRender() && !frame) frame = requestAnimationFrame(render);
  }
  function clearCards() {
    warmTarget?.dispose();
    warmTarget = null;
    warmIndex = 0;
    for (const card of cards.splice(0)) {
      card.mesh.removeFromParent();
      card.mesh.material.dispose();
      card.texture.dispose();
    }
    assetsReady = false;
  }
  function cleanup() {
    if (disposed) return;
    disposed = true;
    modelRequest.abort();
    generation++;
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', visibilityChange);
    window.removeEventListener('resize', resize);
    renderer?.domElement.removeEventListener('webglcontextlost', contextLost);
    clearCards();
    model?.dispose();
    planeGeometry.dispose();
    chipGeometry.dispose();
    chipMaterial.dispose();
    chips.dispose();
    renderer?.dispose();
    if (renderer && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
    renderer?.domElement.remove();
  }
  function fail(error: unknown) {
    if (disposed || failed) return;
    failed = true;
    cleanup();
    props().onError(error instanceof Error ? error : new Error('The 3D display was interrupted.'));
  }
  function contextLost(event: Event) {
    event.preventDefault();
    fail(new Error('The 3D display was interrupted.'));
  }
  function visibilityChange() {
    previousTime = 0;
    if (!canRender()) { cancelAnimationFrame(frame); frame = 0; }
    else invalidate();
  }
  function worldAt(x: number, y: number, depth: number, result: THREE.Vector3) {
    const viewport = props().viewport;
    return result.set((x - viewport.left) / viewport.width * 2 - 1,
      1 - (y - viewport.top) / viewport.height * 2, depth).unproject(camera);
  }
  function layoutCards() {
    if (!assets || !cards.length) return;
    const tiles = ethereumRevealTiles(cards.length, props().viewport);
    camera.getWorldDirection(galleryNormal).negate();
    const distance = Math.abs(galleryNormal.x) * (CRATE_BOUNDS.width / 2 + 0.2)
      + Math.abs(galleryNormal.y) * (CRATE_BOUNDS.height / 2 + 0.2)
      + Math.abs(galleryNormal.z) * (CRATE_BOUNDS.depth / 2 + 0.2);
    const depth = point.copy(galleryNormal).multiplyScalar(distance).project(camera).z;
    const pixelScale = worldAt(1, 0, depth, point).distanceTo(worldAt(0, 0, depth, screenPoint));
    cards.forEach((card, index) => {
      const tile = tiles[index];
      const item = assets!.items[index];
      const aspect = item.width / item.height;
      const tileWidth = Math.min(tile.width, tile.height * aspect);
      card.width = tileWidth * pixelScale;
      card.height = tileWidth / aspect * pixelScale;
      const initialSize = Math.min(CRATE_BOUNDS.width, CRATE_BOUNDS.depth) * 0.26;
      card.initialWidth = Math.min(initialSize, initialSize * aspect);
      card.initialHeight = card.initialWidth / aspect;
      card.start.set(Math.sin(index * 2.4) * CRATE_BOUNDS.width * 0.06,
        -CRATE_BOUNDS.height * 0.12, Math.cos(index * 2.4) * CRATE_BOUNDS.depth * 0.08);
      card.rim.copy(card.start).setY(CRATE_BOUNDS.height / 2 + card.initialHeight * 0.65 + 0.12);
      card.exit.copy(card.rim).addScaledVector(galleryNormal, Math.max(0, distance - card.rim.dot(galleryNormal)));
      worldAt(tile.left + tile.width / 2, tile.top + tile.height / 2, depth, card.target);
      card.mesh.quaternion.copy(camera.quaternion);
    });
  }
  function resize() {
    if (disposed || !renderer) return;
    const { viewport, crateRect } = props();
    if (!viewport.width || !viewport.height || !crateRect.width || !crateRect.height) return;
    if (width !== viewport.width || height !== viewport.height) {
      width = viewport.width;
      height = viewport.height;
      renderer.setPixelRatio(crateRenderDensity(width, height, window.devicePixelRatio));
      renderer.setSize(width, height, false);
    }
    camera.setViewOffset(crateRect.width, crateRect.height,
      viewport.left - crateRect.left, viewport.top - crateRect.top, viewport.width, viewport.height);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    layoutCards();
    invalidate();
  }
  function applyHit() {
    const hit = props().hit;
    if (!model || !hit || hit.id === processedHit || openingAt !== null) return;
    processedHit = hit.id;
    const { viewport, crateRect } = props();
    const x = crateRect.left + (hit.x + 1) * crateRect.width / 2;
    const y = crateRect.top + (hit.y + 1) * crateRect.height / 2;
    pointer.set((x - viewport.left) / viewport.width * 2 - 1, 1 - (y - viewport.top) / viewport.height * 2);
    model.root.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    const intersection = raycaster.intersectObjects(model.hitMeshes, false)[0];
    point.copy(intersection?.point ?? model.root.position);
    model.setDamage(hit.id, model.root.worldToLocal(point.clone()));
    direction.set(hit.x || 0.2, hit.y || -0.15);
    recoil.value = Math.min(1.2, recoil.value + 0.75);
    recoil.velocity = 0;
    if (props().reducedMotion || !intersection) return;
    for (let index = 0; index < 7; index++) {
      const particle = particles[chipCursor++ % particles.length];
      const seed = hit.id * 2.39 + index * 7.13;
      particle.position.copy(intersection.point);
      particle.velocity.set(Math.sin(seed) * 1.5, 0.7 + Math.abs(Math.cos(seed)) * 1.5, Math.cos(seed * 1.7) * 1.5);
      particle.life = 0.55 + Math.abs(Math.sin(seed * 1.2)) * 0.3;
      particle.spin = seed;
    }
  }
  function updateParticles(dt: number) {
    let alive = false;
    particles.forEach((particle, index) => {
      particle.life = props().reducedMotion ? 0 : Math.max(0, particle.life - dt);
      if (particle.life > 0) {
        alive = true;
        particle.velocity.y -= dt * 5;
        particle.position.addScaledVector(particle.velocity, dt);
        chipPose.position.copy(particle.position);
        chipPose.rotation.set(time * 0.005 + particle.spin, particle.spin, time * 0.003);
        chipPose.scale.setScalar(Math.min(1, particle.life * 5));
      } else chipPose.scale.setScalar(0);
      chipPose.updateMatrix();
      chips.setMatrixAt(index, chipPose.matrix);
    });
    chips.instanceMatrix.needsUpdate = true;
    chips.visible = alive;
    return alive;
  }
  function syncAssets() {
    const next = props().assets;
    if (!model || !renderer || next === assets || warming || disposed) return;
    assets = next;
    generation++;
    clearCards();
    if (!next) return;
    for (const item of next.items) {
      const texture = new THREE.CanvasTexture(item.image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const mesh = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({
        map: texture, transparent: true, alphaTest: 0.025, toneMapped: false,
      }));
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      cards.push({ mesh, texture, start: new THREE.Vector3(), rim: new THREE.Vector3(), exit: new THREE.Vector3(), target: new THREE.Vector3(),
        width: 0, height: 0, initialWidth: 0, initialHeight: 0 });
    }
    layoutCards();
    invalidate();
  }
  function warmAssets() {
    if (!renderer || !model || !assets || assetsReady || warming || !canRender()) return;
    const token = generation;
    warming = true;
    warmTarget ??= new THREE.WebGLRenderTarget(4, 4);
    try {
      model.root.visible = false;
      chips.visible = false;
      renderer.setRenderTarget(warmTarget);
      const end = Math.min(cards.length, warmIndex + 2);
      for (; warmIndex < end; warmIndex++) {
        const card = cards[warmIndex];
        renderer.initTexture(card.texture);
        card.mesh.visible = true;
        card.mesh.position.copy(card.target);
        card.mesh.scale.set(card.width, card.height, 1);
        renderer.compile(scene, camera);
        renderer.render(scene, camera);
        card.mesh.visible = false;
        if (shaderFailed || renderer.getContext().isContextLost()) throw new Error('Unable to prepare the artwork display.');
      }
    } catch (error) { fail(error); }
    finally {
      if (!disposed) renderer.setRenderTarget(null);
      model.root.visible = true;
      warming = false;
    }
    if (disposed || token !== generation || assets !== props().assets) return;
    if (warmIndex !== cards.length) { invalidate(); return; }
    warmTarget?.dispose();
    warmTarget = null;
    assetsReady = true;
    host.dataset.assetsReady = 'true';
    props().onAssetsReady();
    invalidate();
  }
  function render(now: number) {
    frame = 0;
    if (!canRender() || !renderer || !model || !width || !height) { previousTime = 0; return; }
    const elapsedMs = previousTime ? Math.max(0, now - previousTime) : 0;
    const dt = Math.min(0.05, elapsedMs / 1000);
    previousTime = now;
    time += elapsedMs;
    try {
      const press = props().press;
      if (press && press.id !== processedPress && openingAt === null) {
        processedPress = press.id;
        direction.set(press.x || 0.2, press.y || -0.15);
        recoil.value = Math.min(1, recoil.value + 0.45);
        recoil.velocity = 0;
      }
      applyHit();
      warmAssets();
      if (disposed) return;
      if (props().opening && assetsReady && openingAt === null) openingAt = time;
      const moving = stepMiNoteMotion(recoil, 0, 19, dt, props().reducedMotion);
      model.setRecoil(direction.x, direction.y, recoil.value);
      const particleMotion = updateParticles(dt);
      const inspecting = props().inspectionTime !== undefined;
      const elapsed = inspecting ? props().inspectionTime! : openingAt === null ? -1 : time - openingAt;
      let openingMotion = false;
      if (elapsed >= 0 && assetsReady) {
        const pose = sampleCrateOpening(complete && !inspecting ? crateOpeningDuration(cards.length, props().reducedMotion) : elapsed,
          cards.length, props().reducedMotion);
        model.setOpening(pose.lid);
        model.setOpacity(pose.crateOpacity);
        cards.forEach((card, index) => {
          const progress = pose.items[index];
          card.mesh.visible = progress > 0;
          if (!card.mesh.visible) return;
          if (props().reducedMotion) {
            card.mesh.position.copy(card.target);
            card.mesh.scale.set(card.width, card.height, 1);
            card.mesh.material.opacity = progress;
          } else {
            const rise = Math.min(1, progress / 0.42);
            const outward = THREE.MathUtils.clamp((progress - 0.42) / 0.23, 0, 1);
            const spread = Math.max(0, (progress - 0.65) / 0.35);
            if (progress <= 0.42) card.mesh.position.lerpVectors(card.start, card.rim, rise);
            else if (!spread) card.mesh.position.lerpVectors(card.rim, card.exit, outward);
            else {
              card.mesh.position.lerpVectors(card.exit, card.target, spread);
              card.mesh.position.y += Math.sin(spread * Math.PI) * CRATE_BOUNDS.height * 0.12;
            }
            card.mesh.scale.set(THREE.MathUtils.lerp(card.initialWidth, card.width, spread),
              THREE.MathUtils.lerp(card.initialHeight, card.height, spread), 1);
            card.mesh.material.opacity = Math.min(1, progress * 12);
          }
        });
        openingMotion = !pose.complete && !inspecting;
        if (pose.complete && !complete && !inspecting) {
          complete = true;
          renderer.render(scene, camera);
          if (shaderFailed || renderer.getContext().isContextLost()) throw new Error('The artwork display was interrupted.');
          props().onComplete();
          if (disposed) return;
          host.dataset.complete = 'true';
        }
      }
      renderer.render(scene, camera);
      if (shaderFailed || renderer.getContext().isContextLost()) throw new Error('The 3D display was interrupted.');
      if (!ready) {
        ready = true;
        host.dataset.crateReady = 'true';
        props().onReady();
        if (disposed) return;
      }
      props().onFrame();
      if (disposed) return;
      host.dataset.drawCalls = String(renderer.info.render.calls);
      host.dataset.triangles = String(renderer.info.render.triangles);
      host.dataset.textures = String(renderer.info.memory.textures);
      host.dataset.animating = String(moving || particleMotion || openingMotion);
      if (moving || particleMotion || openingMotion) invalidate();
      else previousTime = 0;
    } catch (error) { fail(error); }
  }
  function sync() {
    if (disposed) return;
    resize();
    syncAssets();
    visibilityChange();
  }
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.debug.onShaderError = () => { shaderFailed = true; };
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    host.append(renderer.domElement);
    document.addEventListener('visibilitychange', visibilityChange);
    window.addEventListener('resize', resize);
    resize();
    void createCrateModel({ signal: modelRequest.signal }).then(value => {
      if (disposed) { value.dispose(); return; }
      model = value;
      scene.add(model.root);
      sync();
    }).catch(fail);
  } catch (error) { queueMicrotask(() => fail(error)); }
  return { sync, dispose: cleanup };
}

export default function CrateScene(props: CrateSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const controller = useRef<ReturnType<typeof createScene> | null>(null);
  current.current = props;
  useLayoutEffect(() => {
    if (!host.current) return;
    const scene = createScene(host.current, () => current.current);
    controller.current = scene;
    return () => { scene.dispose(); controller.current = null; };
  }, []);
  useLayoutEffect(() => { controller.current?.sync(); });
  return <div ref={host} className="crate-reveal__scene" aria-hidden="true" style={{ position: 'fixed',
    left: props.viewport.left, top: props.viewport.top, width: props.viewport.width, height: props.viewport.height,
    pointerEvents: 'none', visibility: (props.active || props.closing) && !props.suspended ? 'visible' : 'hidden' }} />;
}
