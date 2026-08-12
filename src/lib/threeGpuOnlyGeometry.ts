import * as THREE from 'three';

type GpuBuffer = THREE.BufferAttribute | THREE.InterleavedBuffer;

function gpuBufferForAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): GpuBuffer {
  return attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data
    : attribute;
}

export function releaseObjectGeometryCpuBuffersAfterUpload(root: THREE.Object3D) {
  const buffers = new Set<GpuBuffer>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();

    const attributes = geometry.attributes as Record<
      string,
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    >;
    Object.values(attributes).forEach((attribute) => {
      buffers.add(gpuBufferForAttribute(attribute));
    });
    const morphAttributes = geometry.morphAttributes as Record<
      string,
      Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>
    >;
    Object.values(morphAttributes).forEach((attributes) => {
      attributes.forEach((attribute) => {
        buffers.add(gpuBufferForAttribute(attribute));
      });
    });
    if (geometry.index) buffers.add(geometry.index);
  });

  buffers.forEach((buffer) => {
    buffer.onUpload(() => {
      (buffer as unknown as { array: ArrayBufferView | null }).array = null;
    });
  });
}
