import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<object>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    if (image && typeof image === 'object') images.add(image);
    texture.dispose();
  }
  for (const image of images) if ('close' in image && typeof image.close === 'function') image.close();
  for (const geometry of geometries) geometry.dispose();
  root.removeFromParent();
}

type EthereumModelViewerProps = { src: string; label: string; onReady: () => void; onError: () => void };

export default function EthereumModelViewer({ src, label, onReady, onError }: EthereumModelViewerProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    const manager = new THREE.LoadingManager();
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let environment: THREE.WebGLRenderTarget | undefined;
    let model: THREE.Object3D | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let ready = false;
    let shaderFailed = false;
    let frame = 0;
    let radius = 1;
    let fitDistance = 0;
    let width = 0;
    let height = 0;
    const offset = new THREE.Vector3();
    const orbit = new THREE.Spherical();

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      manager.abort();
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      controls?.removeEventListener('change', schedule);
      controls?.dispose();
      if (renderer) {
        renderer.domElement.removeEventListener('keydown', keydown);
        renderer.domElement.removeEventListener('pointerdown', focus);
        renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        renderer.domElement.remove();
      }
      if (model) disposeModel(model);
      environment?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
    const fail = () => {
      if (disposed) return;
      cleanup();
      callbacks.current.onError();
    };
    function render() {
      frame = 0;
      if (disposed || !renderer || !model || !width || !height) return;
      try {
        renderer.render(scene, camera);
        if (shaderFailed) { fail(); return; }
        if (!ready) {
          ready = true;
          renderer.domElement.tabIndex = 0;
          callbacks.current.onReady();
        }
      } catch { fail(); }
    }
    function schedule() {
      if (!disposed && model && !frame) frame = requestAnimationFrame(render);
    }
    function resize() {
      if (disposed || !renderer) return;
      width = host!.clientWidth;
      height = host!.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      if (model && controls) {
        const vertical = THREE.MathUtils.degToRad(camera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
        const nextDistance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
        if (fitDistance) camera.position.multiplyScalar(nextDistance / fitDistance);
        else camera.position.set(0, 0, nextDistance);
        fitDistance = nextDistance;
        controls.minDistance = radius * 1.05;
        controls.maxDistance = fitDistance * 5;
        camera.near = radius / 1000;
        camera.far = controls.maxDistance + radius * 4;
        controls.update();
      }
      camera.updateProjectionMatrix();
      schedule();
    }
    function keydown(event: KeyboardEvent) {
      if (!ready || !controls || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Home'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') camera.position.set(0, 0, fitDistance);
      else {
        orbit.setFromVector3(offset.copy(camera.position).sub(controls.target));
        const turn = Math.PI / 15;
        if (event.key === 'ArrowLeft') orbit.theta -= turn;
        if (event.key === 'ArrowRight') orbit.theta += turn;
        if (event.key === 'ArrowUp') orbit.phi -= turn;
        if (event.key === 'ArrowDown') orbit.phi += turn;
        if (event.key === '+' || event.key === '=') orbit.radius *= 0.9;
        if (event.key === '-' || event.key === '_') orbit.radius /= 0.9;
        orbit.radius = THREE.MathUtils.clamp(orbit.radius, controls.minDistance, controls.maxDistance);
        orbit.makeSafe();
        camera.position.copy(controls.target).add(offset.setFromSpherical(orbit));
      }
      controls.update();
      schedule();
    }
    function focus() { renderer?.domElement.focus({ preventScroll: true }); }
    function contextLost(event: Event) { event.preventDefault(); fail(); }

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.debug.onShaderError = () => { shaderFailed = true; };
      const canvas = renderer.domElement;
      canvas.tabIndex = -1;
      canvas.setAttribute('aria-label', `${label}. Drag to rotate, scroll or pinch to zoom. Arrow keys rotate, plus and minus zoom, Home resets the view.`);
      canvas.addEventListener('keydown', keydown);
      canvas.addEventListener('pointerdown', focus);
      canvas.addEventListener('webglcontextlost', contextLost);
      host.append(canvas);
      controls = new OrbitControls(camera, canvas);
      controls.enablePan = false;
      controls.enableDamping = false;
      controls.autoRotate = false;
      controls.addEventListener('change', schedule);
      const room = new RoomEnvironment();
      const generator = new THREE.PMREMGenerator(renderer);
      try { environment = generator.fromScene(room, 0.04); }
      finally { generator.dispose(); room.dispose(); }
      scene.environment = environment.texture;
      if (shaderFailed) throw new Error('Model environment rendering failed.');
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(resize);
        observer.observe(host);
      }
      window.addEventListener('resize', resize);
      resize();
      void Promise.resolve().then(async () => {
        if (disposed) return;
        const gltf = await new GLTFLoader(manager).loadAsync(src);
        if (disposed) { disposeModel(gltf.scene); return; }
        model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
        if (!Number.isFinite(radius) || radius <= 0) throw new Error('Model has no visible bounds.');
        model.position.sub(bounds.getCenter(new THREE.Vector3()));
        scene.add(model);
        resize();
      }).catch(fail);
    } catch { fail(); }
    return cleanup;
  }, [src, label]);

  return <span ref={hostRef} className="ethereum111k__model-canvas" />;
}
