import * as THREE from 'three';

const CAPACITY = 32;
const BURST_SIZE = 8;
const COLORS = [0xffe4ad, 0xf4f0ff, 0xcde4ff].map(color => new THREE.Color(color));

export function createMiNoteTapSparkles() {
  const particles = Array.from({ length: CAPACITY }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    age: 0,
    lifetime: 0,
    size: 0,
    rotation: 0,
    star: false,
    color: COLORS[0],
  }));
  let count = 0;
  const positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const shapes = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', positions);
  geometry.setAttribute('sparkleColor', colors);
  geometry.setAttribute('sparkleShape', shapes);
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    vertexShader: `
      uniform float pixelRatio;
      attribute vec4 sparkleColor;
      attribute vec3 sparkleShape;
      varying vec4 vColor;
      varying vec2 vShape;
      void main() {
        vColor = sparkleColor;
        vShape = sparkleShape.yz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = sparkleShape.x * pixelRatio;
      }
    `,
    fragmentShader: `
      varying vec4 vColor;
      varying vec2 vShape;
      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float c = cos(vShape.x);
        float s = sin(vShape.x);
        point = mat2(c, -s, s, c) * point;
        vec2 curve = abs(point);
        float distanceToEdge = mix(length(point), curve.x + curve.y + 3.0 * curve.x * curve.y, vShape.y);
        float coverage = 1.0 - smoothstep(0.65, 1.0, distanceToEdge);
        gl_FragColor = vec4(vColor.rgb, vColor.a * coverage);
        #include <colorspace_fragment>
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'mi-note-tap-sparkles';
  points.frustumCulled = false;
  points.renderOrder = 10;
  points.visible = false;

  function clear() {
    count = 0;
    points.visible = false;
    geometry.setDrawRange(0, 0);
  }

  return {
    points,
    burst(origin: THREE.Vector3, worldPerPixel: number) {
      const amount = Math.min(BURST_SIZE, CAPACITY - count);
      const offset = Math.random() * Math.PI * 2;
      for (let index = 0; index < amount; index += 1) {
        const particle = particles[count++];
        const angle = offset + index / BURST_SIZE * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
        const speed = (55 + Math.random() * 40) * worldPerPixel;
        particle.position.copy(origin);
        particle.position.x += Math.cos(angle) * 3 * worldPerPixel;
        particle.position.y += Math.sin(angle) * 3 * worldPerPixel;
        particle.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed + 12 * worldPerPixel, 0);
        particle.age = 0;
        particle.lifetime = 0.42 + Math.random() * 0.24;
        particle.star = index % 3 === 0;
        particle.size = particle.star ? 11 + Math.random() * 4 : 2.5 + Math.random() * 1.5;
        particle.rotation = Math.random() * Math.PI;
        particle.color = COLORS[index % COLORS.length];
      }
    },
    update(dt: number, pixelRatio: number) {
      if (count === 0) return false;
      material.uniforms.pixelRatio.value = pixelRatio;
      const drag = Math.exp(-2.5 * dt);
      for (let index = 0; index < count;) {
        const particle = particles[index];
        particle.age += dt;
        if (particle.age >= particle.lifetime) {
          particles[index] = particles[--count];
          particles[count] = particle;
          continue;
        }
        particle.position.addScaledVector(particle.velocity, dt);
        particle.velocity.multiplyScalar(drag);
        const remaining = 1 - particle.age / particle.lifetime;
        const alpha = Math.min(1, particle.age / 0.035) * remaining * remaining * 0.85;
        positions.setXYZ(index, particle.position.x, particle.position.y, particle.position.z);
        colors.setXYZW(index, particle.color.r, particle.color.g, particle.color.b, alpha);
        shapes.setXYZ(index, particle.size * (0.75 + remaining * 0.25), particle.rotation + particle.age * 0.5, Number(particle.star));
        index += 1;
      }
      positions.needsUpdate = colors.needsUpdate = shapes.needsUpdate = true;
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      return points.visible;
    },
    clear,
    dispose() {
      clear();
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
