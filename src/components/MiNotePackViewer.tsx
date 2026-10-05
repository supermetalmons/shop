import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import {
  createMiNotePackModel,
  MI_NOTE_CARD_HEIGHT,
  MI_NOTE_CARD_WIDTH,
  MI_NOTE_LEAF_WIDTH,
} from '../lib/miNotePackModel';
import {
  MI_NOTE_PACK_DISCARD_DELAY_MS,
  MI_NOTE_PACK_DISCARD_DURATION_MS,
  type MiNoteRevealStage,
} from '../lib/miNoteCardReveal';

type MiNotePackViewerProps = {
  color: string;
  cardElements: readonly [HTMLDivElement, HTMLDivElement];
  stage: MiNoteRevealStage;
  onReadyChange: (ready: boolean) => void;
  onError: (error: Error) => void;
  onSealFinished: () => void;
  onOpened: () => void;
  onDiscarded: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
};

function cardApertureGeometry() {
  const width = MI_NOTE_CARD_WIDTH;
  const height = MI_NOTE_CARD_HEIGHT;
  const radius = width * 0.0455;
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return new THREE.ShapeGeometry(shape, 12);
}

export default function MiNotePackViewer(props: MiNotePackViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const invalidateRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frameId = 0;
    let failed = false;
    let width = 1;
    let height = 1;
    let cardWidth = 1;
    let stage: MiNoteRevealStage = 'sealed';
    let stageStarted = 0;
    let lastTime = 0;
    let stageCompleted = false;
    let openingProgress = 0;
    let openingVelocity = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (error) {
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to display the pack.'));
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'mi-note-wip__canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    const cssRenderer = new CSS3DRenderer();
    cssRenderer.domElement.className = 'mi-note-wip__css-scene';
    host.append(cssRenderer.domElement, renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 40);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb1b9ac, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    keyLight.position.set(-3, 5, 7);
    const fillLight = new THREE.DirectionalLight(0xe7f0ff, 0.8);
    fillLight.position.set(4, 0, 4);
    scene.add(keyLight, fillLight);
    let model: ReturnType<typeof createMiNotePackModel>;
    try {
      model = createMiNotePackModel({ color: props.color });
    } catch (error) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      cssRenderer.domElement.remove();
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to create the pack.'));
      return;
    }
    scene.add(model.group);
    const apertureGeometry = cardApertureGeometry();
    const apertureMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0,
      transparent: true,
      blending: THREE.NoBlending,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const cards = props.cardElements.map((element, index) => {
      const anchor = new THREE.Group();
      anchor.position.set((index === 0 ? -1 : 1) * MI_NOTE_LEAF_WIDTH / 2, -0.005, 0.0057);
      const cssObject = new CSS3DObject(element);
      const aperture = new THREE.Mesh(apertureGeometry, apertureMaterial);
      anchor.add(cssObject, aperture);
      (index === 0 ? model.left : model.right).add(anchor);
      return { anchor, cssObject, startPosition: new THREE.Vector3(), startQuaternion: new THREE.Quaternion() };
    });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finalQuaternion = new THREE.Quaternion();
    const targetPosition = new THREE.Vector3();
    const point = new THREE.Vector3();

    const invalidate = () => {
      if (!disposed && !failed && !frameId && !document.hidden) frameId = requestAnimationFrame(render);
    };
    invalidateRef.current = invalidate;

    const positionCamera = () => {
      const aspect = width / height;
      const closedHeight = Math.max(1.82 / 0.52, MI_NOTE_LEAF_WIDTH / (aspect * 0.68));
      const openHeight = Math.max(1.82 / 0.52, MI_NOTE_LEAF_WIDTH * 2 / (aspect * 0.86));
      const viewHeight = THREE.MathUtils.lerp(closedHeight, openHeight, openingProgress);
      camera.position.z = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(17)));
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    };

    const positionFinalCards = (progress: number) => {
      const pixelsToWorld = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(17)) / height;
      const gap = THREE.MathUtils.clamp(width * 0.028, 10, 26);
      const scale = cardWidth * pixelsToWorld / MI_NOTE_CARD_WIDTH;
      cards.forEach((card, index) => {
        targetPosition.set((index === 0 ? -1 : 1) * (cardWidth + gap) / 2 * pixelsToWorld, 0, 0);
        card.anchor.position.lerpVectors(card.startPosition, targetPosition, progress);
        card.anchor.quaternion.slerpQuaternions(card.startQuaternion, finalQuaternion, progress);
        card.anchor.scale.setScalar(THREE.MathUtils.lerp(1, scale, progress));
      });
    };

    const updatePackButton = () => {
      const button = currentProps.current.buttonRef.current;
      if (!button) return;
      const bounds = new THREE.Box3().setFromObject(model.left).expandByObject(model.right);
      let left = width;
      let top = height;
      let right = 0;
      let bottom = 0;
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            point.set(x, y, z).project(camera);
            const px = (point.x + 1) * width / 2;
            const py = (1 - point.y) * height / 2;
            left = Math.min(left, px);
            top = Math.min(top, py);
            right = Math.max(right, px);
            bottom = Math.max(bottom, py);
          }
        }
      }
      Object.assign(button.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    };

    function render(now: number) {
      frameId = 0;
      if (disposed || failed) return;
      const dt = Math.min((now - (lastTime || now)) / 1000, 0.05);
      lastTime = now;
      const nextStage = currentProps.current.stage;
      if (nextStage !== stage) {
        stage = nextStage;
        stageStarted = now;
        stageCompleted = false;
        if (stage === 'seal-falling') model.startSealFall();
        if (stage === 'pack-falling') {
          scene.updateMatrixWorld(true);
          cards.forEach((card) => {
            scene.attach(card.anchor);
            card.startPosition.copy(card.anchor.position);
            card.startQuaternion.copy(card.anchor.quaternion);
          });
        }
      }
      const elapsed = now - stageStarted;
      if (stage === 'seal-falling' && !stageCompleted && model.updateSeal(elapsed / 1000, reducedMotion.matches)) {
        stageCompleted = true;
        currentProps.current.onSealFinished();
      }
      if (stage === 'opening' && !stageCompleted) {
        const offset = openingProgress - 1;
        const impulse = openingVelocity + 13 * offset;
        const decay = Math.exp(-13 * dt);
        openingProgress = reducedMotion.matches ? 1 : 1 + (offset + impulse * dt) * decay;
        openingVelocity = reducedMotion.matches ? 0 : (openingVelocity - 13 * impulse * dt) * decay;
        if (Math.abs(openingProgress - 1) < 0.0001 && Math.abs(openingVelocity) < 0.0008) {
          openingProgress = 1;
          stageCompleted = true;
        }
        model.setOpenProgress(openingProgress);
        if (stageCompleted) currentProps.current.onOpened();
      }
      positionCamera();
      if (stage === 'pack-falling') {
        const delay = reducedMotion.matches ? 0 : MI_NOTE_PACK_DISCARD_DELAY_MS;
        const duration = reducedMotion.matches ? 1 : MI_NOTE_PACK_DISCARD_DURATION_MS;
        const progress = THREE.MathUtils.clamp((elapsed - delay) / duration, 0, 1);
        const settleProgress = reducedMotion.matches ? 1 : THREE.MathUtils.smoothstep(elapsed / (delay + duration), 0, 1);
        positionFinalCards(settleProgress);
        model.group.position.y = -progress * progress * camera.position.z;
        model.group.rotation.z = -0.016 + THREE.MathUtils.degToRad(8) * progress;
        model.group.scale.setScalar(1 - 0.1 * progress);
        renderer.domElement.style.opacity = String(1 - progress);
        if (progress === 1 && !stageCompleted) {
          stageCompleted = true;
          model.group.visible = false;
          currentProps.current.onDiscarded();
        }
      }
      if (stage === 'revealed') positionFinalCards(1);
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
      if (stage === 'sealed' || stage === 'unsealed') updatePackButton();
      if (!stageCompleted && ['seal-falling', 'opening', 'pack-falling'].includes(stage)) invalidate();
    }

    const resize = () => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      cardWidth = Math.min(width * 0.36, height * 0.7 / 1.4, 380);
      cards.forEach(({ cssObject }) => {
        cssObject.element.style.width = `${cardWidth}px`;
        cssObject.element.style.height = `${cardWidth * 1.4}px`;
        cssObject.scale.setScalar(MI_NOTE_CARD_WIDTH / cardWidth);
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      cssRenderer.setSize(width, height);
      invalidate();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      failed = true;
      currentProps.current.onReadyChange(false);
      currentProps.current.onError(new Error('The pack display was interrupted. Please retry.'));
    };
    const handleVisibility = () => {
      lastTime = 0;
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    document.addEventListener('visibilitychange', handleVisibility);
    reducedMotion.addEventListener('change', invalidate);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    currentProps.current.onReadyChange(false);
    resize();
    positionCamera();
    void model.ready.then(() => {
      if (disposed) return;
      renderer.compile(scene, camera);
      if (disposed || failed) return;
      currentProps.current.onReadyChange(true);
      invalidate();
    }).catch((error: unknown) => {
      if (disposed) return;
      failed = true;
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to load the pack.'));
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      invalidateRef.current = () => undefined;
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', invalidate);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      cards.forEach(({ anchor }) => anchor.removeFromParent());
      apertureGeometry.dispose();
      apertureMaterial.dispose();
      model.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      cssRenderer.domElement.remove();
    };
  }, [props.color, props.cardElements]);

  useEffect(() => invalidateRef.current(), [props.stage]);

  return <div ref={hostRef} className="mi-note-wip__renderer" />;
}
