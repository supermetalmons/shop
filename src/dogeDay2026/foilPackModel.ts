import * as THREE from 'three';

const WIDTH = 2.45;
const HEIGHT = 3.75;
const HALF_WIDTH = WIDTH / 2;
const HALF_HEIGHT = HEIGHT / 2;
const SEAL_Y = 1.61;
const BODY_COLUMNS = 24;
const BODY_ROWS = 32;

export type DogeFoilPackPose = {
  hit: number;
  hitX: number;
  hitY: number;
  variant: number;
  tear: number;
  discard: number;
};

function ease(value: number) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function tearEdge(y: number) {
  return Math.sin(y * 19.3) * 0.027 + Math.sin(y * 43.7) * 0.016;
}

function sealEdge(x: number) {
  return SEAL_Y + Math.sin(x * 34.1) * 0.017 + Math.sin(x * 71.7) * 0.008;
}

function foilDepth(x: number, y: number) {
  const across = Math.max(0, 1 - (x / HALF_WIDTH) ** 2);
  const body = ease((y + 1.66) / 0.3) * ease((1.66 - y) / 0.32);
  const puff = Math.pow(across, 0.45) * body;
  const folds = Math.sin(x * 21 + y * 5) * Math.sin(y * 11 - x * 3) * 0.006
    + Math.sin(x * 37 - y * 12) * 0.0025;
  const edgeWrinkles = (1 - ease(across / 0.7)) * Math.sin(y * 27 + x * 4) * 0.016;
  const crimp = (1 - body) * (0.008 + 0.009 * Math.cos((x + HALF_WIDTH) * Math.PI * 48 / WIDTH));
  return 0.018 + puff * 0.175 + body * (folds + edgeWrinkles) + crimp;
}

function createPrintTexture(cardCount: 1 | 2 | 3) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create the foil pack print.');
  const ink = '#19242a';
  context.fillStyle = ink;
  context.strokeStyle = ink;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '600 18px Helvetica, Arial, sans-serif';
  context.fillText('LITTLE SWAG WORLD', 256, 146);
  context.font = '900 115px Helvetica, Arial, sans-serif';
  context.fillText('DOGE', 256, 272);
  context.fillText('DAY', 256, 382);
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(94, 460);
  context.lineTo(418, 460);
  context.stroke();
  context.save();
  context.translate(256, 614);
  context.lineWidth = 5;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(-91, -7);
  context.lineTo(-86, -97);
  context.lineTo(-39, -61);
  context.quadraticCurveTo(0, -77, 39, -61);
  context.lineTo(86, -97);
  context.lineTo(91, -7);
  context.quadraticCurveTo(114, 24, 80, 65);
  context.quadraticCurveTo(44, 105, 0, 106);
  context.quadraticCurveTo(-44, 105, -80, 65);
  context.quadraticCurveTo(-114, 24, -91, -7);
  context.stroke();
  context.beginPath();
  context.moveTo(-66, -58);
  context.lineTo(-66, -24);
  context.lineTo(-47, -42);
  context.moveTo(66, -58);
  context.lineTo(66, -24);
  context.lineTo(47, -42);
  context.moveTo(-53, 0);
  context.quadraticCurveTo(-35, -10, -20, 1);
  context.moveTo(53, 0);
  context.quadraticCurveTo(35, -10, 20, 1);
  context.moveTo(-29, 53);
  context.quadraticCurveTo(-13, 65, 0, 49);
  context.quadraticCurveTo(13, 65, 29, 53);
  context.moveTo(0, 40);
  context.lineTo(0, 49);
  context.stroke();
  context.beginPath();
  context.ellipse(-35, 7, 5, 8, 0.15, 0, Math.PI * 2);
  context.ellipse(35, 7, 5, 8, -0.15, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.moveTo(-15, 31);
  context.quadraticCurveTo(0, 24, 15, 31);
  context.quadraticCurveTo(0, 51, -15, 31);
  context.fill();
  context.restore();
  context.font = '900 78px Helvetica, Arial, sans-serif';
  context.fillText('2026', 256, 816);
  context.font = '600 17px Helvetica, Arial, sans-serif';
  context.fillText(`${cardCount} CARD PACK`, 256, 882);
  context.lineWidth = 2;
  context.strokeRect(574, 144, 388, 734);
  context.font = '900 55px Helvetica, Arial, sans-serif';
  context.fillText('DOGE DAY', 768, 240);
  context.font = '600 22px Helvetica, Arial, sans-serif';
  context.fillText('2026 EDITION', 768, 301);
  context.font = '500 18px Helvetica, Arial, sans-serif';
  context.fillText('A SMALL PACK.', 768, 450);
  context.fillText('A VERY GOOD DAY.', 768, 480);
  context.font = '600 15px Helvetica, Arial, sans-serif';
  context.fillText('LITTLE SWAG WORLD', 768, 822);
  for (let i = 0; i < 54; i += 1) {
    const width = i % 7 === 0 ? 4 : i % 3 === 0 ? 2 : 1;
    context.fillRect(658 + i * 4.1, 692, width, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createFoilGeometry(side: number, strip: boolean) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const panels: number[] = [];
  const indices: number[] = [];
  const columns = strip ? 80 : BODY_COLUMNS;
  const rows = strip ? 4 : BODY_ROWS;

  const addVertex = (x: number, y: number, z: number, front: boolean) => {
    positions.push(x, y, z);
    uvs.push((front ? (x / WIDTH + 0.5) : (0.5 - x / WIDTH) + 1) * 0.5, y / HEIGHT + 0.5);
    panels.push(strip ? 0 : side);
  };
  const sample = (column: number, row: number) => {
    const u = column / columns;
    const v = row / rows;
    if (strip) {
      const x = (u - 0.5) * WIDTH;
      const lower = sealEdge(x);
      const serration = (column % 2) * 0.012;
      const y = THREE.MathUtils.lerp(lower, HALF_HEIGHT - serration, v);
      const z = 0.022 + (column % 2) * 0.016 + Math.sin(v * Math.PI) * 0.006;
      return { x, y, z };
    }
    const yBase = THREE.MathUtils.lerp(-HALF_HEIGHT, SEAL_Y, v);
    const middle = tearEdge(yBase);
    const x = side < 0 ? THREE.MathUtils.lerp(-HALF_WIDTH, middle, u) : THREE.MathUtils.lerp(middle, HALF_WIDTH, u);
    const y = yBase + (sealEdge(x) - SEAL_Y) * v ** 16 + (row === 0 ? (column % 2) * 0.012 : 0);
    return { x, y, z: foilDepth(x, y) };
  };

  for (let face = 0; face < 2; face += 1) {
    const offset = positions.length / 3;
    const front = face === 0;
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const { x, y, z } = sample(column, row);
        addVertex(x, y, front ? z : -z, front);
      }
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = offset + row * (columns + 1) + column;
        const b = a + columns + 1;
        if (front) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  const addRim = (horizontal: boolean, edge: number, reverse: boolean) => {
    const count = horizontal ? columns : rows;
    const offset = positions.length / 3;
    for (let i = 0; i <= count; i += 1) {
      const { x, y, z } = sample(horizontal ? i : edge, horizontal ? edge : i);
      addVertex(x, y, z, true);
      addVertex(x, y, -z, true);
    }
    for (let i = 0; i < count; i += 1) {
      const a = offset + i * 2;
      if (reverse) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  addRim(true, 0, false);
  addRim(true, rows, true);
  if (strip || side < 0) addRim(false, 0, true);
  if (strip || side > 0) addRim(false, columns, false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aPanel', new THREE.Float32BufferAttribute(panels, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const vertexShader = `
uniform float uHit;
uniform vec2 uHitPoint;
uniform float uVariant;
uniform float uTear;
attribute float aPanel;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vPosition;
void main() {
  vUv = uv;
  vec3 p = position;
  vec2 delta = p.xy - uHitPoint;
  float dent = exp(-dot(delta * vec2(1.4, 1.0), delta * vec2(1.4, 1.0)) * 2.2);
  p.z -= uHit * dent * (0.16 + 0.035 * sin(uVariant * 2.0));
  p.z += uHit * sin(p.y * 5.0 + uVariant) * sin(p.x * 3.0) * 0.035;
  float wave = smoothstep(1.10 - uTear * 1.9, 1.34 - uTear * 1.9, position.y / 3.75 + 0.5);
  float peel = wave * smoothstep(0.10, 0.95, uTear) * abs(aPanel);
  p.x += aPanel * peel * 0.24;
  p.z += peel * 0.12 * (1.0 - abs(position.x) / 1.225);
  p.y -= peel * 0.12;
  vPosition = p;
  vNormal = normalize(normalMatrix * normal);
  vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
  vViewPosition = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const fragmentShader = `
uniform sampler2D uPrint;
uniform float uHit;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vPosition;
void main() {
  vec3 faceNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  vec3 smoothNormal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 normal = normalize(mix(smoothNormal, faceNormal, 0.08));
  normal.xy += vec2(sin(vPosition.y * 180.0), cos(vPosition.x * 210.0)) * 0.003;
  normal = normalize(normal);
  vec3 eye = normalize(-vViewPosition);
  vec3 reflection = reflect(-eye, normal);
  float key = smoothstep(0.66, 0.98, dot(reflection, normalize(vec3(-0.65, 0.45, 1.0))));
  float rim = smoothstep(0.81, 0.99, dot(reflection, normalize(vec3(0.85, 0.1, 0.7))));
  float ribbon = 1.0 - smoothstep(0.03, 0.16, abs(reflection.x + reflection.y * 0.24 + 0.25));
  float dark = 1.0 - smoothstep(0.06, 0.28, abs(reflection.x - reflection.y * 0.32 - 0.38));
  float fresnel = pow(1.0 - abs(dot(normal, eye)), 3.0);
  vec3 silver = vec3(0.43, 0.47, 0.51) + key * vec3(0.49, 0.48, 0.45) + rim * 0.64 + ribbon * 0.22;
  silver *= 1.0 - dark * 0.63;
  silver += fresnel * 0.28 + uHit * key * 0.035;
  vec4 printColor = texture2D(uPrint, vUv);
  float printed = printColor.a * (gl_FrontFacing ? 1.0 : 0.0);
  vec3 ink = printColor.rgb * (0.65 + key * 0.35) + (rim * 0.12 + key * 0.035);
  vec3 color = mix(silver, ink, printed);
  gl_FragColor = vec4(color, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createDogeFoilPackModel(cardCount: 1 | 2 | 3 = 1) {
  const group = new THREE.Group();
  group.name = 'doge-day-2026-foil-pack';
  const rig = new THREE.Group();
  group.add(rig);
  const print = createPrintTexture(cardCount);
  const uniforms = {
    uPrint: { value: print },
    uHit: { value: 0 },
    uHitPoint: { value: new THREE.Vector2() },
    uVariant: { value: 0 },
    uTear: { value: 0 },
    uOpacity: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide, transparent: true, forceSinglePass: true });
  const left = new THREE.Mesh(createFoilGeometry(-1, false), material);
  const right = new THREE.Mesh(createFoilGeometry(1, false), material);
  const seal = new THREE.Mesh(createFoilGeometry(0, true), material);
  left.name = 'foil-left';
  right.name = 'foil-right';
  seal.name = 'foil-top-seal';
  left.frustumCulled = right.frustumCulled = seal.frustumCulled = false;
  rig.add(left, right, seal);
  let disposed = false;

  return {
    group,
    update({ hit, hitX, hitY, variant, tear, discard }: DogeFoilPackPose) {
      if (disposed) return;
      const pulse = THREE.MathUtils.clamp(hit, 0, 1);
      const ripping = THREE.MathUtils.clamp(tear, 0, 1);
      const falling = THREE.MathUtils.clamp(discard, 0, 1);
      const opening = ease((ripping - 0.3) / 0.7);
      const unseal = ease(ripping / 0.42);
      const kind = ((Math.floor(variant) % 3) + 3) % 3;
      const direction = hitX < 0 ? -1 : 1;
      uniforms.uHit.value = pulse;
      uniforms.uHitPoint.value.set(THREE.MathUtils.clamp(hitX, -1, 1) * HALF_WIDTH, THREE.MathUtils.clamp(hitY, -1, 1) * HALF_HEIGHT);
      uniforms.uVariant.value = variant;
      uniforms.uTear.value = ripping;
      uniforms.uOpacity.value = 1 - falling;
      rig.visible = falling < 1;
      rig.position.set(
        pulse * direction * (kind === 2 ? 0.075 : 0.025),
        pulse * (kind === 0 ? -0.055 : 0.045),
        -pulse * (kind === 0 ? 0.14 : 0.075),
      );
      rig.rotation.set(
        pulse * (kind === 0 ? -0.12 : hitY * 0.07),
        pulse * direction * (kind === 2 ? 0.15 : kind === 1 ? -0.11 : 0.065),
        pulse * direction * (kind === 2 ? 0.085 : 0.035) - falling * Math.PI * 8 / 180,
      );
      rig.scale.set(1 - pulse * (kind === 1 ? 0.075 : 0.025), 1 - pulse * (kind === 0 ? 0.055 : 0.025), 1 + pulse * (kind === 1 ? 0.1 : 0));
      rig.scale.multiplyScalar(1 - falling * 0.1);
      left.position.set(-opening * 0.1, -opening * 0.06, -opening * 0.03);
      right.position.set(opening * 0.1, -opening * 0.06, -opening * 0.03);
      left.rotation.set(opening * 0.04, -opening * 0.18, opening * 0.035);
      right.rotation.set(-opening * 0.04, opening * 0.18, -opening * 0.035);
      seal.position.set(unseal * 0.16, unseal * 0.16 - opening * 0.2, unseal * 0.1);
      seal.rotation.set(unseal * 0.34, -unseal * 0.16, -unseal * 0.12);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      left.geometry.dispose();
      right.geometry.dispose();
      seal.geometry.dispose();
      material.dispose();
      print.dispose();
      group.clear();
    },
  };
}
