import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OverlayRect } from '../../shop/reveal/types';
import type { CratePreviewAssets } from '../crate/crateAssets';
import { createCrateSprites } from './crateSprites';
import type { WarehouseCrateImage } from './warehouseAssets';
import { createWarehouseModel, WAREHOUSE_BOUNDS, WAREHOUSE_CAMERA, WAREHOUSE_IMAGE_ASPECT } from './warehouseModel';
import { clamp, createWarehouseCrateLayout, sampleWarehouseCrate, smooth, warehouseFracture, warehouseRenderDensity,
  WAREHOUSE_CRATE_COUNT, WAREHOUSE_CRITICAL_CONTACT_MS, WAREHOUSE_HIT_CONTACT_MS, WAREHOUSE_HIT_DURATION_MS,
  WAREHOUSE_OPEN_DURATION_MS, WAREHOUSE_REDUCED_DURATION_MS, type WarehouseCratePose } from './warehouseMotion';

export type WarehouseHit = { id: number; x: number; y: number };
export type WarehouseSceneProps = {
  assets: CratePreviewAssets | null;
  crateImage: WarehouseCrateImage | null;
  hits: readonly WarehouseHit[];
  opening: boolean;
  active: boolean;
  closing?: boolean;
  suspended: boolean;
  reducedMotion: boolean;
  viewport: OverlayRect;
  containerRect: OverlayRect;
  onReady: () => void;
  onAssetsReady: () => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  onFrame: () => void;
  onImpact: (critical: boolean) => void;
  inspectionTime?: number;
};

function createScene(host: HTMLDivElement, props: () => WarehouseSceneProps) {
  const scene = new THREE.Scene();
  const modelRequest = new AbortController();
  const camera = new THREE.PerspectiveCamera(WAREHOUSE_CAMERA.fov, WAREHOUSE_IMAGE_ASPECT, 0.1, 180);
  const referencePosition = new THREE.Vector3(...WAREHOUSE_CAMERA.position);
  const referenceTarget = new THREE.Vector3(...WAREHOUSE_CAMERA.target);
  const referenceDirection = referencePosition.clone().sub(referenceTarget).normalize();
  const referenceDistance = referencePosition.distanceTo(referenceTarget);
  const pileDirection = referenceDirection.clone().setY(0.43).normalize();
  const finalFacing = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pileDirection, new THREE.Vector3(), camera.up));
  const finalTarget = new THREE.Vector3();
  const cameraTarget = new THREE.Vector3();
  const cameraDirection = new THREE.Vector3();
  const pileBounds = new THREE.Box3();
  const tempBounds = new THREE.Box3();
  const object = new THREE.Object3D();
  const billboardUp = new THREE.Vector3();
  const billboardFoot = new THREE.Vector3();
  const planeBounds = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0));
  const point = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  scene.add(new THREE.HemisphereLight(0xe7f7ff, 0x655a48, 2.5));
  const light = new THREE.DirectionalLight(0xf6faff, 2.3);
  light.position.set(-6, 12, 16);
  scene.add(light);

  const iceGeometry = new THREE.IcosahedronGeometry(1, 0);
  const iceMaterial = new THREE.MeshPhongMaterial({ color: 0xa9e4ff, specular: 0xe4fbff, shininess: 80,
    emissive: 0x174b6d, emissiveIntensity: 0.35, flatShading: true });
  const meteor = new THREE.Mesh(iceGeometry, iceMaterial);
  meteor.name = 'warehouse-ice-meteor';
  meteor.visible = false;
  scene.add(meteor);
  const shardGeometry = new THREE.TetrahedronGeometry(0.12);
  const shardMaterial = new THREE.MeshLambertMaterial({ color: 0xc6eeff, emissive: 0x102332, flatShading: true });
  const shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, 64);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false;
  shards.visible = false;
  scene.add(shards);
  const particles = Array.from({ length: 64 }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), born: -Infinity, spin: 0 }));
  const meteorStart = new THREE.Vector3();
  const meteorTarget = new THREE.Vector3();
  const shadowGeometry = new THREE.CircleGeometry(1, 20);
  const shadowPixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4;
    shadowPixels.fill(255, offset, offset + 3);
    shadowPixels[offset + 3] = Math.round((1 - smooth(Math.hypot((x - 15.5) / 15.5, (y - 15.5) / 15.5))) * 255);
  }
  const shadowTexture = new THREE.DataTexture(shadowPixels, 32, 32);
  shadowTexture.magFilter = shadowTexture.minFilter = THREE.LinearFilter;
  shadowTexture.needsUpdate = true;
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, color: 0x414950, transparent: true, opacity: 0.2, depthWrite: false });
  const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, WAREHOUSE_CRATE_COUNT);
  shadows.frustumCulled = false;
  shadows.visible = false;
  scene.add(shadows);

  let renderer: THREE.WebGLRenderer | undefined;
  let model: Awaited<ReturnType<typeof createWarehouseModel>> | undefined;
  let crates: ReturnType<typeof createCrateSprites> | undefined;
  let poses: WarehouseCratePose[] = [];
  let imageSource: WarehouseCrateImage | null = null;
  let disposed = false;
  let failed = false;
  let shaderFailed = false;
  let frame = 0;
  let time = 0;
  let previousTime = 0;
  let wasRenderable = false;
  let ready = false;
  let assetsReady = false;
  let complete = false;
  let openingReduced: boolean | null = null;
  let warmStep = 0;
  let textures: THREE.Texture[] = [];
  let warmTarget: THREE.WebGLRenderTarget | null = null;
  let normalHits = 0;
  let hitStarted: number | null = null;
  let openingStarted: number | null = null;
  let contacted = false;
  let criticalContacted = false;
  let lastHitCount = 0;
  let particleCursor = 0;
  let recoilAt = -Infinity;
  let recoilStrength = 0;
  let width = 0;
  let height = 0;
  let finalDistance = referenceDistance;

  const canRender = () => !disposed && !failed && props().active && !props().suspended && !document.hidden;
  function invalidate() {
    if (canRender() && !frame) frame = requestAnimationFrame(render);
  }
  function clearCrates() {
    crates?.root.removeFromParent();
    crates?.dispose();
    crates = undefined;
    assetsReady = false;
    poses = [];
    textures = [];
    warmStep = 0;
    warmTarget?.dispose();
    warmTarget = null;
    shadows.visible = false;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    modelRequest.abort();
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener('visibilitychange', visibilityChange);
    renderer?.domElement.removeEventListener('webglcontextlost', contextLost);
    clearCrates();
    model?.dispose();
    iceGeometry.dispose();
    iceMaterial.dispose();
    shardGeometry.dispose();
    shardMaterial.dispose();
    shards.dispose();
    shadowGeometry.dispose();
    shadowTexture.dispose();
    shadowMaterial.dispose();
    shadows.dispose();
    renderer?.dispose();
    if (renderer && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
    renderer?.domElement.remove();
  }
  function fail(error: unknown) {
    if (failed || disposed) return;
    failed = true;
    dispose();
    props().onError(error instanceof Error ? error : new Error('The 3D display was interrupted.'));
  }
  function contextLost(event: Event) { event.preventDefault(); fail(new Error('The 3D display was interrupted.')); }
  function checkRenderer() {
    if (shaderFailed || renderer?.getContext().isContextLost()) throw new Error('Unable to prepare the warehouse display.');
  }
  function visibilityChange() {
    const renderable = canRender();
    if (!renderable || !wasRenderable) previousTime = 0;
    wasRenderable = renderable;
    if (!renderable) { cancelAnimationFrame(frame); frame = 0; }
    else invalidate();
  }
  function fitPile() {
    if (!crates || !poses.length || !width || !height) return;
    pileBounds.makeEmpty();
    poses.forEach((pose, index) => {
      sampleWarehouseCrate(pose, index, WAREHOUSE_OPEN_DURATION_MS, true, object);
      faceCrate(finalFacing);
      pileBounds.union(tempBounds.copy(planeBounds).applyMatrix4(object.matrix));
    });
    pileBounds.getCenter(finalTarget);
    const radius = pileBounds.getSize(point).length() / 2;
    const rect = props().containerRect;
    const vertical = Math.tan(THREE.MathUtils.degToRad(WAREHOUSE_CAMERA.fov) / 2) * height / rect.height;
    const horizontal = vertical * width / height;
    finalDistance = Math.max(referenceDistance, radius / (Math.min(vertical * 0.72, horizontal * 0.84)));
  }
  function faceCrate(facing: THREE.Quaternion) {
    if (!crates || !imageSource) return;
    const scale = object.scale.x;
    billboardUp.set(0, 1, 0).applyQuaternion(facing);
    const height = (crates.bounds.max.y - crates.bounds.min.y) * scale / Math.max(0.5, billboardUp.y);
    billboardFoot.copy(object.position);
    billboardFoot.y += crates.bounds.min.y * scale;
    object.position.copy(billboardFoot).addScaledVector(billboardUp, height / 2);
    object.quaternion.copy(facing);
    object.scale.set(height * imageSource.width / imageSource.height, height, 1);
    object.updateMatrix();
  }
  function cameraPose(progress: number) {
    const { viewport, containerRect: rect } = props();
    cameraTarget.lerpVectors(referenceTarget, finalTarget, progress);
    cameraDirection.lerpVectors(referenceDirection, pileDirection, progress).normalize();
    camera.position.copy(cameraTarget).addScaledVector(cameraDirection, THREE.MathUtils.lerp(referenceDistance, finalDistance, progress));
    camera.lookAt(cameraTarget);
    camera.setViewOffset(rect.width, rect.height, viewport.left - rect.left, viewport.top - rect.top, viewport.width, viewport.height);
    camera.updateMatrixWorld(true);
  }
  function resize() {
    if (!renderer || disposed) return;
    const viewport = props().viewport;
    if (!viewport.width || !viewport.height || !props().containerRect.width || !props().containerRect.height) return;
    if (width !== viewport.width || height !== viewport.height) {
      width = viewport.width;
      height = viewport.height;
      renderer.setPixelRatio(warehouseRenderDensity(width, height, window.devicePixelRatio));
      renderer.setSize(width, height, false);
    }
    fitPile();
  }
  function syncAssets() {
    if (props().assets && props().assets!.items.length !== WAREHOUSE_CRATE_COUNT) {
      fail(new Error('Unable to arrange the warehouse results.'));
      return;
    }
    if (props().crateImage === imageSource) return;
    clearCrates();
    imageSource = props().crateImage;
    if (!imageSource) return;
    try {
      const value = createCrateSprites(WAREHOUSE_CRATE_COUNT, imageSource);
      crates = value;
      scene.add(value.root);
      poses = createWarehouseCrateLayout(value.bounds, WAREHOUSE_CRATE_COUNT);
      poses.forEach((pose, index) => { sampleWarehouseCrate(pose, index, 0, false, object); value.setMatrixAt(index, object.matrix); });
      value.root.visible = false;
      value.commit();
      const unique = new Set<THREE.Texture>();
      value.root.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          const texture = (material as THREE.MeshBasicMaterial).map;
          if (texture) unique.add(texture);
        }
      });
      textures = [...unique];
      fitPile();
      invalidate();
    } catch (error) { fail(error); }
  }
  function warmAssets() {
    if (!renderer || !model || !crates || assetsReady) return false;
    if (warmStep < textures.length) { renderer.initTexture(textures[warmStep++]); return true; }
    if (warmStep === textures.length) {
      renderer.compile(scene, camera);
      checkRenderer();
      warmStep++;
      return true;
    }
    warmTarget ??= new THREE.WebGLRenderTarget(8, 8, { depthBuffer: true });
    renderer.setRenderTarget(warmTarget);
    const cratesVisible = crates.root.visible;
    const shardsVisible = shards.visible;
    const shadowsVisible = shadows.visible;
    crates.root.visible = true;
    shards.visible = shadows.visible = true;
    model.root.visible = false;
    meteor.visible = true;
    meteor.position.copy(cameraTarget);
    try {
      renderer.render(scene, camera);
      checkRenderer();
    } finally {
      if (!disposed) renderer.setRenderTarget(null);
      model.root.visible = true;
      crates.root.visible = cratesVisible;
      shards.visible = shardsVisible;
      shadows.visible = shadowsVisible;
      meteor.visible = false;
    }
    warmTarget.dispose();
    warmTarget = null;
    assetsReady = true;
    host.dataset.assetsReady = 'true';
    props().onAssetsReady();
    return false;
  }
  function aim(hit: WarehouseHit | undefined, critical: boolean) {
    model!.setFracture(0);
    model!.setRecoil(0, 0, 0);
    cameraPose(0);
    const { viewport, containerRect: rect } = props();
    const x = rect.left + ((hit?.x ?? 0) + 1) * rect.width / 2;
    const y = rect.top + ((hit?.y ?? 0) + 1) * rect.height / 2;
    pointer.set((x - viewport.left) / viewport.width * 2 - 1, 1 - (y - viewport.top) / viewport.height * 2);
    raycaster.setFromCamera(pointer, camera);
    model!.root.updateMatrixWorld(true);
    const intersection = raycaster.intersectObjects(model!.hitMeshes, false)[0];
    if (intersection) meteorTarget.copy(intersection.point);
    else meteorTarget.set(0, 0.4, WAREHOUSE_BOUNDS.depth / 2);
    meteorStart.copy(meteorTarget).addScaledVector(referenceDirection, critical ? 11 : 8);
    meteorStart.y += critical ? 7 : 4;
    meteorStart.x -= critical ? 3 : 2;
  }
  function burst(critical: boolean, at: number, reduced: boolean) {
    recoilAt = at;
    recoilStrength = critical ? 1 : 0.55;
    if (reduced) return;
    const count = critical ? 64 : 28;
    for (let index = 0; index < count; index++) {
      const particle = particles[particleCursor++ % particles.length];
      const angle = index * 2.39996;
      const strength = 1.8 + index % 7 * 0.4;
      particle.position.copy(meteorTarget);
      particle.velocity.set(Math.cos(angle) * strength, 1.5 + index % 5 * 0.7, Math.sin(angle) * strength + 1.8);
      particle.born = at;
      particle.spin = angle;
    }
  }
  function animateMeteor(elapsed: number, critical: boolean, reduced: boolean) {
    const contact = critical ? WAREHOUSE_CRITICAL_CONTACT_MS : WAREHOUSE_HIT_CONTACT_MS;
    meteor.visible = elapsed > 0 && elapsed < contact && !reduced;
    if (!meteor.visible) return;
    const p = clamp(elapsed / contact);
    meteor.position.lerpVectors(meteorStart, meteorTarget, p * p);
    meteor.rotation.set(elapsed * 0.003, elapsed * 0.004, elapsed * 0.002);
    meteor.scale.setScalar((critical ? 1.55 : 0.9) * (0.75 + p * 0.25));
  }
  function updateShards(now: number, reduced: boolean) {
    let visible = false;
    particles.forEach((particle, index) => {
      const age = (now - particle.born) / 1000;
      const live = age >= 0 && age < 0.85 && !reduced;
      object.scale.setScalar(live ? (1 - age / 0.85) * (0.7 + index % 4 * 0.28) : 0);
      if (live) {
        visible = true;
        object.position.copy(particle.position).addScaledVector(particle.velocity, age);
        object.position.y -= age * age * 6;
        object.rotation.set(particle.spin + age * 3, age * 4, particle.spin);
      }
      object.updateMatrix();
      shards.setMatrixAt(index, object.matrix);
    });
    shards.instanceMatrix.needsUpdate = true;
    shards.visible = visible;
    return visible;
  }
  function updateCrates(elapsed: number, reduced: boolean) {
    if (!crates) return;
    const opacity = reduced ? smooth(elapsed / WAREHOUSE_REDUCED_DURATION_MS) : 1;
    crates.setOpacity(opacity);
    poses.forEach((pose, index) => {
      sampleWarehouseCrate(pose, index, elapsed, reduced, object);
      const y = object.position.y;
      const scale = object.scale.x;
      faceCrate(camera.quaternion);
      crates!.setMatrixAt(index, object.matrix);
      object.position.copy(billboardFoot);
      object.position.y = -WAREHOUSE_BOUNDS.height / 2 + 0.025;
      object.rotation.set(-Math.PI / 2, 0, 0);
      const distance = Math.max(0, y - pose.target.y);
      object.scale.set(scale * 1.9 / (1 + distance * 0.2), scale * 1.2 / (1 + distance * 0.2), 1);
      object.updateMatrix();
      shadows.setMatrixAt(index, object.matrix);
    });
    crates.commit();
    crates.root.visible = reduced ? opacity > 0.001 : elapsed >= WAREHOUSE_CRITICAL_CONTACT_MS;
    shadows.instanceMatrix.needsUpdate = true;
    shadows.visible = elapsed > 800 || reduced;
    shadowMaterial.opacity = opacity * 0.2;
  }
  function resetHits() {
    normalHits = 0;
    hitStarted = null;
    openingStarted = null;
    openingReduced = null;
    contacted = false;
    criticalContacted = false;
    complete = false;
    recoilAt = -Infinity;
    meteor.visible = false;
    particles.forEach(particle => { particle.born = -Infinity; });
    model?.setDamage(0);
    model?.setFracture(0);
    model?.setOpacity(1);
  }
  function render(now: number) {
    frame = 0;
    if (!canRender() || !renderer || !model || !width || !height) { previousTime = 0; return; }
    time += previousTime ? Math.max(0, now - previousTime) : 0;
    previousTime = now;
    try {
      const inspecting = props().inspectionTime !== undefined;
      cameraPose(0);
      const warming = warmAssets();
      if (disposed) return;
      let moving = false;
      meteor.visible = false;
      if (!inspecting && openingStarted === null && normalHits < Math.min(2, props().hits.length)) {
        if (hitStarted === null) { hitStarted = time; contacted = false; aim(props().hits[normalHits], false); }
        const elapsed = time - hitStarted;
        if (!contacted) animateMeteor(elapsed, false, props().reducedMotion);
        if (!contacted && elapsed >= (props().reducedMotion ? 0 : WAREHOUSE_HIT_CONTACT_MS)) {
          contacted = true;
          model.setDamage(normalHits + 1, meteorTarget);
          burst(false, time, props().reducedMotion);
          props().onImpact(false);
          if (disposed) return;
        }
        if (elapsed >= (props().reducedMotion ? 100 : WAREHOUSE_HIT_DURATION_MS)) { normalHits++; hitStarted = null; }
        moving = true;
      }
      if (!inspecting && props().opening && props().assets && assetsReady && normalHits >= 2 && hitStarted === null && openingStarted === null) {
        openingStarted = time;
        openingReduced = props().reducedMotion;
        aim(props().hits[2], true);
      }
      let elapsed = inspecting ? Math.max(0, props().inspectionTime!) : openingStarted === null ? -1 : time - openingStarted;
      if (!inspecting && !complete && openingStarted !== null && props().reducedMotion) openingReduced = true;
      const reduced = inspecting ? props().reducedMotion : openingReduced ?? props().reducedMotion;
      const duration = reduced ? WAREHOUSE_REDUCED_DURATION_MS : WAREHOUSE_OPEN_DURATION_MS;
      if (complete && !inspecting) elapsed = duration;
      if (elapsed >= 0 && props().assets && assetsReady) {
        if (inspecting) {
          model.setDamage(0);
          const damageCount = Math.min(2, props().hits.length);
          for (let index = 0; index < damageCount; index++) {
            aim(props().hits[index], false);
            model.setDamage(index + 1, meteorTarget);
          }
          aim(props().hits[2], true);
          particles.forEach(particle => { particle.born = -Infinity; });
          particleCursor = 0;
          recoilAt = -Infinity;
          if (elapsed >= (reduced ? 0 : WAREHOUSE_CRITICAL_CONTACT_MS)) {
            model.setDamage(damageCount + 1, meteorTarget);
            burst(true, WAREHOUSE_CRITICAL_CONTACT_MS, reduced);
          }
        }
        animateMeteor(elapsed, true, reduced);
        if (!criticalContacted && elapsed >= (reduced ? 0 : WAREHOUSE_CRITICAL_CONTACT_MS) && !inspecting) {
          criticalContacted = true;
          model.setDamage(3, meteorTarget);
          burst(true, time, reduced);
          props().onImpact(true);
          if (disposed) return;
        }
        if (reduced) {
          model.setFracture(0);
          model.setOpacity(1 - smooth(elapsed / duration));
        } else {
          model.setOpacity(1);
          model.setFracture(warehouseFracture(elapsed));
        }
        cameraPose(reduced ? 1 : smooth((elapsed - 450) / 1750));
        updateCrates(elapsed, reduced);
        moving = moving || elapsed < duration && !inspecting;
      } else {
        model.setFracture(0);
        model.setOpacity(1);
        if (crates) updateCrates(0, false);
      }
      const recoilAge = ((inspecting ? elapsed : time) - recoilAt) / 1000;
      const recoil = !reduced && recoilAge >= 0 && recoilAge < 0.55
        ? Math.sin(recoilAge * 35) * Math.exp(-recoilAge * 8) * recoilStrength : 0;
      model.setRecoil(props().hits[inspecting ? 2 : Math.min(normalHits, 2)]?.x ?? 0, 0, recoil);
      const particlesMoving = updateShards(inspecting ? elapsed : time, reduced);
      renderer.render(scene, camera);
      checkRenderer();
      if (!ready) { ready = true; host.dataset.warehouseReady = 'true'; props().onReady(); }
      if (disposed) return;
      props().onFrame();
      if (disposed) return;
      if (!complete && !inspecting && elapsed >= duration && assetsReady) {
        complete = true;
        host.dataset.complete = 'true';
        props().onComplete();
      }
      if (disposed) return;
      const animating = warming || moving || !inspecting && (particlesMoving || Math.abs(recoil) > 0.001);
      host.dataset.drawCalls = String(renderer.info.render.calls);
      host.dataset.triangles = String(renderer.info.render.triangles);
      host.dataset.textures = String(renderer.info.memory.textures);
      host.dataset.animating = String(animating);
      host.dataset.phase = complete ? 'complete' : elapsed >= 0 ? 'opening' : props().hits.length >= 3 ? 'charged' : 'sealed';
      if (animating) invalidate();
      else previousTime = 0;
    } catch (error) { fail(error); }
  }
  function sync() {
    if (disposed) return;
    if (!props().hits.length && lastHitCount) resetHits();
    lastHitCount = props().hits.length;
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
    resize();
    void createWarehouseModel({ signal: modelRequest.signal }).then(value => {
      if (disposed) { value.dispose(); return; }
      model = value;
      scene.add(value.root);
      sync();
    }).catch(fail);
  } catch (error) { queueMicrotask(() => fail(error)); }
  return { sync, dispose };
}

export default function WarehouseScene(props: WarehouseSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const controller = useRef<ReturnType<typeof createScene> | null>(null);
  current.current = props;
  useLayoutEffect(() => {
    if (!host.current) return;
    controller.current = createScene(host.current, () => current.current);
    return () => { controller.current?.dispose(); controller.current = null; };
  }, []);
  useLayoutEffect(() => { controller.current?.sync(); });
  return <div ref={host} className="crate-reveal__scene warehouse-reveal__scene" aria-hidden="true"
    style={{ position: 'fixed', left: props.viewport.left, top: props.viewport.top, width: props.viewport.width,
      height: props.viewport.height, pointerEvents: 'none', visibility: (props.active || props.closing) && !props.suspended ? 'visible' : 'hidden' }} />;
}
