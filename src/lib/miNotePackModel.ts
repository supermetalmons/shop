import * as THREE from 'three';
import { createMiNotePackSeal, type MiNoteStickerTextureSize } from './miNotePackSeal';
import type { MiNotePackStar } from './miNotePackStars';
import type { MiNoteStickerEffectSettings } from './miNoteStickerEffects';

export const MI_NOTE_CARD_WIDTH = 1.1525;
export const MI_NOTE_CARD_HEIGHT = 1.6135;
export const MI_NOTE_LEAF_WIDTH = 1.29;

const HEIGHT = 1.82;
const THICKNESS = 0.0018;
const POCKET_HEIGHT = 0.56;
export const MI_NOTE_POCKET_TOP = -HEIGHT / 2 + POCKET_HEIGHT;
const POCKET_TOP = MI_NOTE_POCKET_TOP;
const SPINE = 0.0158;
const HINGE_OFFSET = SPINE / 2;
const SPINE_SEGMENTS = 8;
const POCKET_BASE = 0.0069;
const POCKET_BOW = 0.0038;
const LINER_Z = THICKNESS / 2;
const OPEN_LEAF_ANGLE = THREE.MathUtils.degToRad(2.5);

export function sampleMiNoteFolderPose(value: number) {
  const phase = THREE.MathUtils.clamp(value, 0, 2);
  const spread = 1 - Math.abs(phase - 1);
  const openAngle = OPEN_LEAF_ANGLE * spread;
  const frontAngle = Math.PI * (1 - Math.min(phase, 1)) + openAngle;
  const backAngle = Math.PI * Math.max(phase - 1, 0) + openAngle;
  return {
    phase,
    frontAngle,
    backAngle,
    leftPosition: new THREE.Vector3(-HINGE_OFFSET * Math.sin(frontAngle), 0, HINGE_OFFSET * (1 - Math.cos(frontAngle))),
    rightPosition: new THREE.Vector3(HINGE_OFFSET * Math.sin(backAngle), 0, HINGE_OFFSET * (1 - Math.cos(backAngle))),
    bookX: MI_NOTE_LEAF_WIDTH / 4 * (Math.cos(frontAngle) - Math.cos(backAngle)),
    spread,
    spineAngle: frontAngle + backAngle,
  };
}

function ease(value: number) {
  return value * value * (3 - 2 * value);
}

function createCanvas(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The paper texture canvas could not be created.');
  return { canvas, context };
}

function createPaperTextures() {
  const fiberCanvas = createCanvas(128);
  const { canvas, context } = createCanvas(256);
  const pixels = fiberCanvas.context.createImageData(128, 128);
  let seed = 931;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 118 + (seed >>> 27);
    pixels.data.set([value, value, value, 255], i);
  }
  fiberCanvas.context.putImageData(pixels, 0, 0);
  const fiber = new THREE.CanvasTexture(fiberCanvas.canvas);
  fiber.wrapS = fiber.wrapT = THREE.RepeatWrapping;
  fiber.repeat.set(5, 7);

  const grainPixels = context.createImageData(256, 256);
  let grainSeed = 1847;
  const random = () => {
    grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
    return grainSeed / 4294967296;
  };
  const mottling = Array.from({ length: 32 * 32 }, random);
  const sample = (x: number, y: number) => mottling[(y % 32) * 32 + (x % 32)];
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      const gx = x / 8;
      const gy = y / 8;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const u = ease(gx - ix);
      const v = ease(gy - iy);
      const cloud = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(sample(ix, iy), sample(ix + 1, iy), u),
        THREE.MathUtils.lerp(sample(ix, iy + 1), sample(ix + 1, iy + 1), u),
        v,
      );
      const value = Math.round(239 + (random() - 0.5) * 18 + (cloud - 0.5) * 12);
      grainPixels.data.set([value, value, value, 255], (y * 256 + x) * 4);
    }
  }
  context.putImageData(grainPixels, 0, 0);
  context.lineWidth = 0.55;
  for (let i = 0; i < 1600; i += 1) {
    const x = random() * 256;
    const y = random() * 256;
    const angle = random() * Math.PI * 2;
    const length = 0.7 + random() * 2.4;
    context.strokeStyle = random() > 0.5 ? 'rgba(255,255,255,.18)' : 'rgba(125,125,125,.10)';
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    context.stroke();
  }
  const grain = new THREE.CanvasTexture(canvas);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(2, 3);
  grain.anisotropy = 8;
  return { fiber, grain };
}

function faceGeometry(shape: THREE.Shape) {
  const geometry = new THREE.ShapeGeometry(shape, 12);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    uv.setXY(i, position.getX(i) / MI_NOTE_LEAF_WIDTH + 0.5, position.getY(i) / HEIGHT + 0.5);
  }
  return geometry;
}

function sheetOutline(side: number) {
  const shape = new THREE.Shape();
  const radius = 0.016;
  const outer = side * MI_NOTE_LEAF_WIDTH / 2;
  const hinge = -outer;
  shape.moveTo(hinge, -HEIGHT / 2);
  shape.lineTo(outer - side * radius, -HEIGHT / 2);
  shape.quadraticCurveTo(outer, -HEIGHT / 2, outer, -HEIGHT / 2 + radius);
  shape.lineTo(outer, HEIGHT / 2 - radius);
  shape.quadraticCurveTo(outer, HEIGHT / 2, outer - side * radius, HEIGHT / 2);
  shape.lineTo(hinge, HEIGHT / 2);
  shape.closePath();
  return shape;
}

function innerSheetShapes() {
  const edge = MI_NOTE_LEAF_WIDTH - 0.052;
  const bottom = -HEIGHT / 2;
  const top = HEIGHT / 2;
  const radius = 0.016;
  const tabY = POCKET_TOP + 0.012;
  const tabHalfHeight = 0.0083;
  const tabReach = 0.024;
  const liner = new THREE.Shape();
  liner.moveTo(0, bottom);
  liner.lineTo(edge, bottom);
  liner.lineTo(edge, tabY - tabHalfHeight);
  liner.bezierCurveTo(edge + tabReach, tabY - tabHalfHeight, edge + tabReach, tabY + tabHalfHeight, edge, tabY + tabHalfHeight);
  liner.lineTo(edge, top);
  liner.lineTo(0, top);
  liner.closePath();
  const border = new THREE.Shape();
  border.moveTo(edge, bottom);
  border.lineTo(MI_NOTE_LEAF_WIDTH - radius, bottom);
  border.quadraticCurveTo(MI_NOTE_LEAF_WIDTH, bottom, MI_NOTE_LEAF_WIDTH, bottom + radius);
  border.lineTo(MI_NOTE_LEAF_WIDTH, top - radius);
  border.quadraticCurveTo(MI_NOTE_LEAF_WIDTH, top, MI_NOTE_LEAF_WIDTH - radius, top);
  border.lineTo(edge, top);
  border.lineTo(edge, tabY + tabHalfHeight);
  border.bezierCurveTo(edge + tabReach, tabY + tabHalfHeight, edge + tabReach, tabY - tabHalfHeight, edge, tabY - tabHalfHeight);
  border.closePath();
  return { liner, border };
}

function pocketInsideEdge(value: number) {
  const bottom = -HEIGHT / 2;
  const roundHeight = 0.045;
  const inset = 0.095;
  if (value < 0.8) return new THREE.Vector2(inset * value / 0.8, bottom + (POCKET_HEIGHT - roundHeight) * value / 0.8);
  const progress = (value - 0.8) / 0.2;
  const control = inset + roundHeight * inset / (POCKET_HEIGHT - roundHeight);
  return new THREE.Vector2(
    (1 - progress) ** 2 * inset + 2 * (1 - progress) * progress * control + progress * progress * 0.15,
    POCKET_TOP - roundHeight * (1 - progress) ** 2,
  );
}

function pocketDepth(x: number, y: number, bow: number) {
  return POCKET_BASE + bow * Math.sin(Math.PI * THREE.MathUtils.clamp(x / MI_NOTE_LEAF_WIDTH + 0.5, 0, 1))
    * THREE.MathUtils.clamp((y + HEIGHT / 2) / POCKET_HEIGHT, 0, 1);
}

export function createMiNotePackModel({ color, star, foldPosition, rotationOffsetDegrees, verticalPosition, sizeScale, effectSettings, stickerTextureSize, onInvalidate }: {
  color: string;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  verticalPosition?: number;
  sizeScale?: number;
  effectSettings?: MiNoteStickerEffectSettings;
  stickerTextureSize?: MiNoteStickerTextureSize;
  onInvalidate?: () => void;
}) {
  const { fiber, grain } = createPaperTextures();
  const stock = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(255 / 239),
    map: grain,
    roughness: 0.97,
    bumpMap: grain,
    bumpScale: 0.00055,
  });
  const paper = new THREE.MeshStandardMaterial({ color: 0xf1eedf, roughness: 1, bumpMap: fiber, bumpScale: 0.00045 });
  paper.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <bumpmap_pars_fragment>', THREE.ShaderChunk.bumpmap_pars_fragment
        .replace('vec2 dHdxy_fwd()', 'vec2 dHdxy_fwd(out float paperFiber)')
        .replace('float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;', `
          paperFiber = texture2D( bumpMap, vBumpMapUv ).x;
          float Hll = bumpScale * paperFiber;
        `))
      .replace('#include <normal_fragment_maps>', `
        float paperFiber;
        vec2 paperGradient = dHdxy_fwd(paperFiber);
        normal = perturbNormalArb(-vViewPosition, normal, paperGradient, faceDirection);
        diffuseColor.rgb *= 1.0 + (paperFiber * 255.0 - 133.5) * (0.04 / 31.0);
      `);
  };
  paper.customProgramCacheKey = () => 'mi-note-paper-v2';
  const cutEdge = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xf1eedf), 0.35), roughness: 1 });
  const foldedStock = stock.clone();
  foldedStock.side = THREE.DoubleSide;
  const geometries = new Set<THREE.BufferGeometry>();
  const own = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.add(geometry);
    return geometry;
  };
  const group = new THREE.Group();
  const flipRoot = new THREE.Group();
  const book = new THREE.Group();
  const left = new THREE.Group();
  const right = new THREE.Group();
  group.rotation.set(0.055, -0.12, -0.016);
  group.add(flipRoot);
  flipRoot.add(book);
  book.add(left, right);
  const pockets: THREE.PlaneGeometry[] = [];

  const sheet = (leaf: THREE.Group, side: number) => {
    const center = side * MI_NOTE_LEAF_WIDTH / 2;
    const coreGeometry = own(new THREE.ExtrudeGeometry(sheetOutline(side), { depth: THICKNESS, bevelEnabled: false, curveSegments: 12 }));
    coreGeometry.translate(0, 0, -THICKNESS / 2);
    const perimeter = coreGeometry.groups.find((entry) => entry.materialIndex === 1);
    if (perimeter) coreGeometry.setDrawRange(perimeter.start, perimeter.count);
    const core = new THREE.Mesh(coreGeometry, cutEdge);
    core.position.x = center;
    leaf.add(core);
    const outer = new THREE.Mesh(own(faceGeometry(sheetOutline(-side))), stock);
    outer.position.set(center, 0, -THICKNESS / 2);
    outer.rotation.y = Math.PI;
    leaf.add(outer);
    const inside = innerSheetShapes();
    const liner = new THREE.Mesh(own(faceGeometry(inside.liner)), paper);
    liner.position.z = LINER_Z;
    liner.scale.x = side;
    leaf.add(liner);
    const flap = new THREE.Mesh(own(faceGeometry(inside.border)), stock);
    flap.position.z = LINER_Z;
    flap.scale.x = side;
    leaf.add(flap);

    const pocketGeometry = own(new THREE.PlaneGeometry(MI_NOTE_LEAF_WIDTH, POCKET_HEIGHT, 28, 30));
    const position = pocketGeometry.attributes.position;
    const uv = pocketGeometry.attributes.uv;
    for (let i = 0; i < position.count; i += 1) {
      const edge = pocketInsideEdge(uv.getY(i));
      const u = side > 0 ? uv.getX(i) : 1 - uv.getX(i);
      const x = side * THREE.MathUtils.lerp(edge.x, MI_NOTE_LEAF_WIDTH, u) - center;
      position.setXYZ(i, x, edge.y + HEIGHT / 2 - POCKET_HEIGHT / 2, pocketDepth(x, edge.y, POCKET_BOW));
    }
    pocketGeometry.computeVertexNormals();
    const pocket = new THREE.Mesh(pocketGeometry, foldedStock);
    pocket.position.set(center, -HEIGHT / 2 + POCKET_HEIGHT / 2, 0);
    leaf.add(pocket);
    pockets.push(pocketGeometry);
    const bottom = new THREE.Mesh(own(new THREE.BoxGeometry(MI_NOTE_LEAF_WIDTH, 0.003, 0.004)), stock);
    bottom.position.set(center, -HEIGHT / 2 + 0.0015, 0.0038);
    leaf.add(bottom);
    const seam = new THREE.Mesh(own(new THREE.BoxGeometry(0.004, POCKET_HEIGHT, 0.004)), stock);
    seam.position.set(side * (MI_NOTE_LEAF_WIDTH - 0.005), -HEIGHT / 2 + POCKET_HEIGHT / 2, 0.0038);
    leaf.add(seam);
    leaf.traverse((object) => { object.userData.leaf = side < 0 ? 0 : 2; });
  };
  sheet(left, -1);
  sheet(right, 1);

  const spineGeometry = own(new THREE.PlaneGeometry(1, HEIGHT, SPINE_SEGMENTS, 1));
  const spinePositions = spineGeometry.attributes.position;
  const spine = new THREE.Mesh(spineGeometry, foldedStock);
  spine.frustumCulled = false;
  book.add(spine);
  const centerSeam = new THREE.Mesh(own(new THREE.PlaneGeometry(0.0015, HEIGHT)), paper);
  centerSeam.position.z = LINER_Z + 0.0001;
  book.add(centerSeam);
  const releaseResources = () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of [stock, foldedStock, paper, cutEdge]) material.dispose();
    fiber.dispose();
    grain.dispose();
  };
  let seal: ReturnType<typeof createMiNotePackSeal>;
  try {
    seal = createMiNotePackSeal({ parent: right, width: MI_NOTE_LEAF_WIDTH, height: HEIGHT, spine: SPINE, thickness: THICKNESS, star, foldPosition, rotationOffsetDegrees, verticalPosition, sizeScale, effectSettings, stickerTextureSize, onInvalidate });
    right.traverse((object) => { object.userData.leaf = 2; });
  } catch (error) {
    releaseResources();
    throw error;
  }
  let lastPhase = -1;
  let disposed = false;
  let currentColor = color;

  const setFolderPhase = (value: number) => {
    const phase = THREE.MathUtils.clamp(value, 0, 2);
    if (disposed || phase === lastPhase) return;
    lastPhase = phase;
    const pose = sampleMiNoteFolderPose(phase);
    left.rotation.y = pose.frontAngle;
    left.position.copy(pose.leftPosition);
    right.rotation.y = -pose.backAngle;
    right.position.copy(pose.rightPosition);
    book.position.x = pose.bookX;
    const angle = pose.spineAngle;
    spine.visible = angle > 0.001;
    centerSeam.visible = angle < 0.04;
    const pinchOffset = 0.0014 * (Math.sin(pose.backAngle / 2) ** 2 - Math.sin(pose.frontAngle / 2) ** 2);
    for (let i = 0; i < spinePositions.count; i += 1) {
      const t = (i % (SPINE_SEGMENTS + 1)) / SPINE_SEGMENTS;
      spinePositions.setXYZ(
        i,
        THREE.MathUtils.lerp(pose.leftPosition.x, pose.rightPosition.x, t) + pinchOffset * Math.sin(Math.PI * t),
        i <= SPINE_SEGMENTS ? HEIGHT / 2 : -HEIGHT / 2,
        THREE.MathUtils.lerp(pose.leftPosition.z, pose.rightPosition.z, t),
      );
    }
    spinePositions.needsUpdate = true;
    spineGeometry.computeVertexNormals();
    const bow = 0.0003 + (POCKET_BOW - 0.0003) * pose.spread;
    for (const geometry of pockets) {
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) {
        position.setZ(i, pocketDepth(position.getX(i), position.getY(i) - HEIGHT / 2 + POCKET_HEIGHT / 2, bow));
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
    }
  };
  setFolderPhase(0);

  return {
    group,
    flipRoot,
    left,
    right,
    ready: seal.ready,
    setColor(value: string) {
      if (disposed || value === currentColor) return;
      currentColor = value;
      stock.color.set(value).multiplyScalar(255 / 239);
      foldedStock.color.copy(stock.color);
      cutEdge.color.set(value).lerp(paper.color, 0.35);
      onInvalidate?.();
    },
    setFolderPhase,
    getSealFocus: (target: THREE.Vector3) => seal.getFocus(target),
    setSealFoldPosition: (value: number) => seal.setFoldPosition(value),
    setSealRotationOffsetDegrees: (value: number) => seal.setRotationOffsetDegrees(value),
    setSealVerticalPosition: (value: number) => seal.setVerticalPosition(value),
    setSealSizeScale: (value: number) => seal.setSizeScale(value),
    setSealEffectSettings: (value: MiNoteStickerEffectSettings) => seal.setEffectSettings(value),
    startSealPeel: () => seal.start(),
    updateSeal: (elapsedSeconds: number, reducedMotion: boolean, motion = 0) => seal.update(elapsedSeconds, reducedMotion, motion),
    dispose() {
      if (disposed) return;
      disposed = true;
      seal.dispose();
      releaseResources();
      group.removeFromParent();
    },
  };
}
