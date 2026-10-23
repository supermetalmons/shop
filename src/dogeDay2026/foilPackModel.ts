import * as THREE from 'three';

const WIDTH = 2.45;
const HEIGHT = 3.75;
const HALF_WIDTH = WIDTH / 2;
const HALF_HEIGHT = HEIGHT / 2;
const SEAL_Y = 1.61;
const SEAL_COLUMNS = 80;
const BODY_COLUMNS = 48;
const BODY_ROWS = 24;

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
  const shoulder = ease((HALF_WIDTH - Math.abs(x)) / 0.045);
  const cavity = shoulder * ease((y + 1.74) / 0.16) * ease((1.67 - y) / 0.18) * 0.13;
  return Math.max(cavity, 0.018 + puff * 0.175 + body * (folds + edgeWrinkles) + crimp);
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

function createFoilGeometry(face: 'front' | 'rear' | 'seal') {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const strip = face === 'seal';
  const rows = strip ? 2 : BODY_ROWS;
  const columnsAt = (row: number) => strip && row > 0 ? SEAL_COLUMNS : BODY_COLUMNS;
  const addVertex = (x: number, y: number, z: number, front: boolean) => {
    positions.push(x, y, z);
    uvs.push((front ? x / WIDTH + 0.5 : 1.5 - x / WIDTH) * 0.5, y / HEIGHT + 0.5);
  };
  const sample = (column: number, row: number) => {
    const columns = columnsAt(row);
    const x = (column / columns - 0.5) * WIDTH;
    const v = strip && row === 1 ? 0.25 : row / rows;
    const y = strip
      ? THREE.MathUtils.lerp(sealEdge(x), HALF_HEIGHT - (column % 2) * 0.012, v)
      : THREE.MathUtils.lerp(-HALF_HEIGHT + (column % 2) * 0.012, sealEdge(x), v);
    const z = strip
      ? THREE.MathUtils.lerp(foilDepth(x, sealEdge(x)), 0.022 + (column % 2) * 0.016, Math.min(1, v * 4))
        + Math.sin(v * Math.PI) * 0.006
      : foilDepth(x, y);
    return { x, y, z };
  };
  const addFace = (front: boolean) => {
    const rowStarts: number[] = [];
    for (let row = 0; row <= rows; row += 1) {
      rowStarts.push(positions.length / 3);
      for (let column = 0; column <= columnsAt(row); column += 1) {
        const { x, y, z } = sample(column, row);
        addVertex(x, y, front ? z : -z, front);
      }
    }
    const triangle = (a: number, b: number, c: number) => {
      if (front) indices.push(a, b, c);
      else indices.push(a, c, b);
    };
    for (let row = 0; row < rows; row += 1) {
      const lowerColumns = columnsAt(row);
      const upperColumns = columnsAt(row + 1);
      let lower = 0;
      let upper = 0;
      while (lower < lowerColumns || upper < upperColumns) {
        const a = rowStarts[row] + lower;
        const b = rowStarts[row + 1] + upper;
        if (upper === upperColumns || lower < lowerColumns && (lower + 1) * upperColumns <= (upper + 1) * lowerColumns) {
          triangle(a, a + 1, b);
          lower += 1;
        } else {
          triangle(a, b + 1, b);
          upper += 1;
        }
      }
    }
  };
  if (face !== 'rear') addFace(true);
  if (face !== 'front') addFace(false);
  const addRim = (horizontal: boolean, edge: number, reverse: boolean) => {
    const count = horizontal ? columnsAt(edge) : rows;
    const offset = positions.length / 3;
    for (let i = 0; i <= count; i += 1) {
      const row = horizontal ? edge : i;
      const column = horizontal ? i : edge === 0 ? 0 : columnsAt(row);
      const { x, y, z } = sample(column, row);
      addVertex(x, y, face === 'rear' ? 0 : z, face !== 'rear');
      addVertex(x, y, face === 'front' ? 0 : -z, face !== 'rear');
    }
    for (let i = 0; i < count; i += 1) {
      const a = offset + i * 2;
      if (reverse) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  addRim(true, 0, false);
  if (strip) addRim(true, rows, true);
  addRim(false, 0, true);
  addRim(false, BODY_COLUMNS, false);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.boundingBox!.expandByVector(new THREE.Vector3(4, 2, 0.6));
  geometry.computeBoundingSphere();
  geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere!);
  return geometry;
}

const vertexShader = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vPosition;
void main() {
  vUv = uv;
  vPosition = position;
  vNormal = normalize(normalMatrix * normal);
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const fragmentShader = `
uniform sampler2D uPrint;
uniform float uHit;
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
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createDogeFoilPackModel(cardCount: 1 | 2 | 3 = 1) {
  const group = new THREE.Group();
  group.name = 'doge-day-2026-foil-pack';
  const rig = new THREE.Group();
  const sleeve = new THREE.Group();
  group.add(rig);
  rig.add(sleeve);
  const print = createPrintTexture(cardCount);
  const uniforms = { uPrint: { value: print }, uHit: { value: 0 } };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide });
  const front = new THREE.Mesh(createFoilGeometry('front'), material);
  const rear = new THREE.Mesh(createFoilGeometry('rear'), material);
  const seal = new THREE.Mesh(createFoilGeometry('seal'), material);
  front.name = 'foil-front';
  rear.name = 'foil-rear';
  seal.name = 'foil-top-seal';
  const parts = [front, rear, seal].map(mesh => ({
    mesh,
    base: new Float32Array(mesh.geometry.attributes.position.array),
  }));
  parts.forEach(({ mesh }) => { mesh.frustumCulled = false; });
  sleeve.add(front, rear);
  rig.add(seal);
  let disposed = false;
  let exitDistance = 7.25;
  let discardStart = 0;
  let distanceStart = 0;
  let previousDiscard = 0;
  let currentDistance = 0;
  let previousHit = NaN;
  let previousX = NaN;
  let previousY = NaN;
  let previousVariant = NaN;
  let previousTear = NaN;

  return {
    group,
    setExitDistance(distance: number) {
      if (disposed || !Number.isFinite(distance)) return;
      const nextDistance = Math.max(7.25, distance);
      if (nextDistance === exitDistance) return;
      exitDistance = nextDistance;
      if (previousDiscard > 0) {
        discardStart = previousDiscard;
        distanceStart = currentDistance;
      }
    },
    update({ hit, hitX, hitY, variant, tear, discard }: DogeFoilPackPose, preserveResizeMotion = true) {
      if (disposed) return;
      const pulse = THREE.MathUtils.clamp(hit, 0, 1);
      const ripping = THREE.MathUtils.clamp(tear, 0, 1);
      const falling = THREE.MathUtils.clamp(discard, 0, 1);
      const kind = ((Math.floor(variant) % 3) + 3) % 3;
      const direction = hitX < 0 ? -1 : 1;
      uniforms.uHit.value = pulse;
      rig.visible = falling < 1;
      rig.position.set(
        pulse * direction * (kind === 2 ? 0.075 : 0.025),
        pulse * (kind === 0 ? -0.055 : 0.045),
        -pulse * (kind === 0 ? 0.14 : 0.075),
      );
      rig.rotation.set(
        pulse * (kind === 0 ? -0.12 : hitY * 0.07),
        pulse * direction * (kind === 2 ? 0.15 : kind === 1 ? -0.11 : 0.065),
        pulse * direction * (kind === 2 ? 0.085 : 0.035),
      );
      rig.scale.set(1 - pulse * (kind === 1 ? 0.075 : 0.025), 1 - pulse * (kind === 0 ? 0.055 : 0.025), 1 + pulse * (kind === 1 ? 0.1 : 0));
      if (!preserveResizeMotion || falling < previousDiscard || falling === 0) {
        discardStart = 0;
        distanceStart = 0;
      }
      const remaining = discardStart < 1 ? (falling - discardStart) / (1 - discardStart) : 0;
      const distance = THREE.MathUtils.lerp(distanceStart, Math.max(exitDistance, distanceStart), remaining);
      previousDiscard = falling;
      currentDistance = distance;
      const cleared = ease((distance - 3.2) / 1.3);
      sleeve.position.y = -distance;
      sleeve.rotation.z = -cleared * Math.PI * 8 / 180;
      sleeve.scale.setScalar(1 - cleared * 0.1);
      seal.position.set(distance, distance, 0);
      if (pulse === previousHit && hitX === previousX && hitY === previousY
        && variant === previousVariant && ripping === previousTear) return;
      previousHit = pulse;
      previousX = hitX;
      previousY = hitY;
      previousVariant = variant;
      previousTear = ripping;
      const pointX = THREE.MathUtils.clamp(hitX, -1, 1) * HALF_WIDTH;
      const pointY = THREE.MathUtils.clamp(hitY, -1, 1) * HALF_HEIGHT;
      const mouth = ease((ripping - 0.15) / 0.65);
      for (const { mesh, base } of parts) {
        const attribute = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const positions = attribute.array;
        for (let offset = 0; offset < base.length; offset += 3) {
          const x = base[offset];
          const y = base[offset + 1];
          const z = base[offset + 2];
          let px = x;
          let py = y;
          let pz = z;
          if (mesh === seal) {
            const release = ease((ripping - (0.5 - x / WIDTH) * 0.28) / 0.72);
            px += release * (0.35 + ripping * 2.8);
            py += release * (0.24 + ripping * 1.35);
            pz += release * 0.22;
          } else {
            const lip = mouth * ease((y - 1.13) / 0.48);
            const shoulder = ease((HALF_WIDTH - Math.abs(x)) / 0.045);
            pz += Math.sign(z) * lip * shoulder * 0.16;
          }
          if (pulse > 0) {
            const dx = (x - pointX) * 1.4;
            const dy = y - pointY;
            pz -= pulse * Math.exp(-(dx * dx + dy * dy) * 2.2) * (0.16 + 0.035 * Math.sin(variant * 2));
            pz += pulse * Math.sin(y * 5 + variant) * Math.sin(x * 3) * 0.035;
          }
          positions[offset] = px;
          positions[offset + 1] = py;
          positions[offset + 2] = pz;
        }
        attribute.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { mesh } of parts) mesh.geometry.dispose();
      material.dispose();
      print.dispose();
      group.clear();
    },
  };
}
