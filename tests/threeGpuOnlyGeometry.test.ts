import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { releaseClearCardModelLoadResources } from '../src/lib/clearCardModelLoadResources.ts';
import { releaseObjectGeometryCpuBuffersAfterUpload } from '../src/lib/threeGpuOnlyGeometry.ts';

function createTriangleGeometry() {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(
    [-1, -1, 0, 1, -1, 0, -1, 1, 0],
    3,
  );
  const index = new THREE.Uint16BufferAttribute([0, 1, 2], 1);
  geometry.setAttribute('position', position);
  geometry.setIndex(index);
  return { geometry, position, index };
}

test('aborted model loads dispose immediately and again after settling', () => {
  const calls: string[] = [];
  const load = {
    loadingManager: {
      abort: () => {
        calls.push('abort');
      },
    } as unknown as THREE.LoadingManager,
    dracoLoader: {
      setWorkerLimit: (limit: number) => {
        calls.push(`limit:${limit}`);
      },
      dispose: () => {
        calls.push('dispose');
      },
    } as unknown as import('three/examples/jsm/loaders/DRACOLoader.js').DRACOLoader,
    abortRequested: false,
  };

  releaseClearCardModelLoadResources(load, true);
  assert.deepEqual(calls, ['abort', 'limit:0', 'dispose']);
  assert.equal(load.loadingManager, null);
  assert.ok(load.dracoLoader);

  releaseClearCardModelLoadResources(load);
  assert.deepEqual(calls, ['abort', 'limit:0', 'dispose', 'limit:0', 'dispose']);
  assert.equal(load.dracoLoader, null);
  releaseClearCardModelLoadResources(load);
  assert.deepEqual(calls, ['abort', 'limit:0', 'dispose', 'limit:0', 'dispose']);
});

test('aborted Draco loads block workers that resume after decoder initialization', async () => {
  let resolveDecoder: (() => void) | undefined;
  let workerStarts = 0;
  const decoderReady = new Promise<void>((resolve) => {
    resolveDecoder = resolve;
  });
  const dracoLoader = new DRACOLoader();
  const internals = dracoLoader as DRACOLoader & {
    _initDecoder: () => Promise<void>;
    _getWorker: (taskId: number, taskCost: number) => Promise<unknown>;
    workerPool: unknown[];
  };
  internals._initDecoder = () => decoderReady;
  const load = {
    loadingManager: null,
    dracoLoader,
    abortRequested: false,
  };
  const runtime = globalThis as typeof globalThis & { Worker?: typeof Worker };
  const previousWorker = runtime.Worker;
  runtime.Worker = class {
    postMessage() {}
    terminate() {}
    constructor() {
      workerStarts += 1;
    }
  } as unknown as typeof Worker;

  try {
    const workerPending = internals._getWorker(1, 1);
    releaseClearCardModelLoadResources(load, true);
    resolveDecoder?.();
    await assert.rejects(workerPending);

    assert.equal(workerStarts, 0);
    assert.equal(internals.workerPool.length, 0);
    releaseClearCardModelLoadResources(load);
    assert.equal(load.dracoLoader, null);
  } finally {
    if (previousWorker) runtime.Worker = previousWorker;
    else delete runtime.Worker;
  }
});

test('aborted Draco loads reject tasks acquired before callback registration', async () => {
  const dracoLoader = new DRACOLoader();
  const internals = dracoLoader as DRACOLoader & {
    _initDecoder: () => Promise<void>;
    decodeGeometry: (
      buffer: ArrayBuffer,
      taskConfig: Record<string, unknown>,
    ) => Promise<THREE.BufferGeometry>;
  };
  internals._initDecoder = () => Promise.resolve();
  const load = {
    loadingManager: null,
    dracoLoader,
    abortRequested: false,
  };
  const runtime = globalThis as typeof globalThis & { Worker?: typeof Worker };
  const previousWorker = runtime.Worker;
  runtime.Worker = class {
    postMessage() {}
    terminate() {}
  } as unknown as typeof Worker;

  try {
    const decodePending = internals.decodeGeometry(new ArrayBuffer(16), {});
    queueMicrotask(() => releaseClearCardModelLoadResources(load, true));

    await assert.rejects(
      decodePending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    releaseClearCardModelLoadResources(load);
    assert.equal(load.dracoLoader, null);
  } finally {
    if (previousWorker) runtime.Worker = previousWorker;
    else delete runtime.Worker;
  }
});

test('aborted Draco loads reject active decode tasks before terminating workers', async () => {
  let resolveDecodePosted: (() => void) | undefined;
  let workerStarts = 0;
  let workerTerminations = 0;
  const decodePosted = new Promise<void>((resolve) => {
    resolveDecodePosted = resolve;
  });
  const dracoLoader = new DRACOLoader();
  const internals = dracoLoader as DRACOLoader & {
    _initDecoder: () => Promise<void>;
    decodeGeometry: (
      buffer: ArrayBuffer,
      taskConfig: Record<string, unknown>,
    ) => Promise<THREE.BufferGeometry>;
    workerPool: unknown[];
  };
  internals._initDecoder = () => Promise.resolve();
  const load = {
    loadingManager: null,
    dracoLoader,
    abortRequested: false,
  };
  const runtime = globalThis as typeof globalThis & { Worker?: typeof Worker };
  const previousWorker = runtime.Worker;
  runtime.Worker = class {
    postMessage(message: { type?: string }) {
      if (message.type === 'decode') resolveDecodePosted?.();
    }
    terminate() {
      workerTerminations += 1;
    }
    constructor() {
      workerStarts += 1;
    }
  } as unknown as typeof Worker;

  try {
    const decodePending = internals.decodeGeometry(new ArrayBuffer(16), {});
    await decodePosted;
    assert.equal(workerStarts, 1);
    assert.equal(internals.workerPool.length, 1);

    releaseClearCardModelLoadResources(load, true);

    await assert.rejects(
      decodePending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(workerTerminations, 1);
    assert.equal(internals.workerPool.length, 0);
    releaseClearCardModelLoadResources(load);
    assert.equal(load.dracoLoader, null);
  } finally {
    if (previousWorker) runtime.Worker = previousWorker;
    else delete runtime.Worker;
  }
});

test('a failing Draco task rejection does not block other tasks or disposal', () => {
  const calls: string[] = [];
  const reportedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => reportedErrors.push(args);
  const load = {
    loadingManager: null,
    dracoLoader: {
      workerPool: [
        {
          _callbacks: {
            first: {
              reject: () => {
                calls.push('reject:first');
                throw new Error('reject failed');
              },
            },
            second: {
              reject: (error: Error) => {
                calls.push(`reject:second:${error.name}`);
              },
            },
          },
        },
      ],
      setWorkerLimit: () => {
        calls.push('limit');
      },
      dispose: () => {
        calls.push('dispose');
      },
    } as unknown as import('three/examples/jsm/loaders/DRACOLoader.js').DRACOLoader,
    abortRequested: false,
  };

  try {
    releaseClearCardModelLoadResources(load, true);
    assert.deepEqual(calls, [
      'limit',
      'reject:first',
      'reject:second:AbortError',
      'dispose',
    ]);
    assert.equal(reportedErrors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test('failed decoder disposal remains available for a later cleanup attempt', () => {
  let disposeAttempts = 0;
  const reportedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => reportedErrors.push(args);
  const load = {
    loadingManager: null,
    dracoLoader: {
      dispose: () => {
        disposeAttempts += 1;
        if (disposeAttempts === 1) throw new Error('dispose failed');
      },
    } as unknown as import('three/examples/jsm/loaders/DRACOLoader.js').DRACOLoader,
    abortRequested: false,
  };

  try {
    releaseClearCardModelLoadResources(load);
    assert.ok(load.dracoLoader);
    assert.equal(reportedErrors.length, 1);
    releaseClearCardModelLoadResources(load);
    assert.equal(load.dracoLoader, null);
    assert.equal(disposeAttempts, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

test('failed request abort remains available for final cleanup', () => {
  let abortAttempts = 0;
  const reportedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => reportedErrors.push(args);
  const load = {
    loadingManager: {
      abort: () => {
        abortAttempts += 1;
        if (abortAttempts === 1) throw new Error('abort failed');
      },
    } as unknown as THREE.LoadingManager,
    dracoLoader: null,
    abortRequested: false,
  };

  try {
    releaseClearCardModelLoadResources(load, true);
    assert.ok(load.loadingManager);
    assert.equal(reportedErrors.length, 1);
    releaseClearCardModelLoadResources(load);
    assert.equal(load.loadingManager, null);
    assert.equal(abortAttempts, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

test('GPU-only geometry retains bounds and releases decoded arrays after upload', () => {
  const { geometry, position, index } = createTriangleGeometry();
  let previousUploadCalls = 0;
  position.onUpload(() => {
    previousUploadCalls += 1;
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

  const gpuOnlyGeometryApplied = releaseObjectGeometryCpuBuffersAfterUpload(root, {
    immutable: true,
  });

  assert.equal(gpuOnlyGeometryApplied, true);
  assert.deepEqual(geometry.boundingBox?.min.toArray(), [-1, -1, 0]);
  assert.deepEqual(geometry.boundingBox?.max.toArray(), [1, 1, 0]);
  assert.ok(geometry.boundingSphere);
  assert.ok(position.array);
  assert.ok(index.array);

  position.onUploadCallback();
  index.onUploadCallback();

  assert.equal(previousUploadCalls, 1);
  assert.equal((position as unknown as { array: ArrayBufferView | null }).array, null);
  assert.equal((index as unknown as { array: ArrayBufferView | null }).array, null);
});

test('GPU-only geometry requires explicit immutable ownership', () => {
  const { geometry, position, index } = createTriangleGeometry();
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

  assert.equal(releaseObjectGeometryCpuBuffersAfterUpload(root), false);
  position.onUploadCallback();
  index.onUploadCallback();

  assert.ok(position.array);
  assert.ok(index.array);
});

test('GPU-only geometry retains its CPU array when an earlier upload callback fails', () => {
  const { geometry, position } = createTriangleGeometry();
  position.onUpload(() => {
    throw new Error('upload callback failed');
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

  assert.equal(
    releaseObjectGeometryCpuBuffersAfterUpload(root, { immutable: true }),
    true,
  );
  assert.throws(() => position.onUploadCallback(), /upload callback failed/);
  assert.ok(position.array);
});

test('unsafe geometry retains every CPU array in the object root', async (t) => {
  const cases: Array<{
    name: string;
    createObject: (
      geometry: THREE.BufferGeometry,
      material: THREE.MeshBasicMaterial,
    ) => THREE.Object3D;
    prepare?: (geometry: THREE.BufferGeometry, position: THREE.BufferAttribute) => void;
  }> = [
    {
      name: 'skinned mesh',
      createObject: (geometry, material) => new THREE.SkinnedMesh(geometry, material),
    },
    {
      name: 'instanced mesh',
      createObject: (geometry, material) => new THREE.InstancedMesh(geometry, material, 1),
    },
    {
      name: 'batched mesh',
      createObject: (_geometry, material) => new THREE.BatchedMesh(1, 3, 3, material),
    },
    {
      name: 'instanced geometry',
      createObject: (geometry, material) => {
        const instancedGeometry = new THREE.InstancedBufferGeometry();
        instancedGeometry.copy(geometry);
        return new THREE.Mesh(instancedGeometry, material);
      },
    },
    {
      name: 'instanced attribute',
      createObject: (geometry, material) => new THREE.Mesh(geometry, material),
      prepare: (geometry) => {
        geometry.setAttribute(
          'offset',
          new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3),
        );
      },
    },
    {
      name: 'morph attributes',
      createObject: (geometry, material) => new THREE.Mesh(geometry, material),
      prepare: (geometry) => {
        geometry.morphAttributes.position = [
          new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1.5, 0], 3),
        ];
      },
    },
    {
      name: 'dynamic attributes',
      createObject: (geometry, material) => new THREE.Mesh(geometry, material),
      prepare: (_geometry, position) => {
        position.setUsage(THREE.DynamicDrawUsage);
      },
    },
    {
      name: 'wireframe material',
      createObject: (geometry) =>
        new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ wireframe: true })),
    },
    {
      name: 'unsupported line geometry',
      createObject: (geometry, material) => new THREE.Line(geometry, material),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const safe = createTriangleGeometry();
      const unsafe = createTriangleGeometry();
      testCase.prepare?.(unsafe.geometry, unsafe.position);
      const root = new THREE.Group();
      root.add(new THREE.Mesh(safe.geometry, new THREE.MeshBasicMaterial()));
      root.add(testCase.createObject(unsafe.geometry, new THREE.MeshBasicMaterial()));

      const gpuOnlyGeometryApplied = releaseObjectGeometryCpuBuffersAfterUpload(root, {
        immutable: true,
      });
      safe.position.onUploadCallback();
      safe.index.onUploadCallback();
      unsafe.position.onUploadCallback();
      unsafe.index.onUploadCallback();

      assert.equal(gpuOnlyGeometryApplied, false);
      assert.ok(safe.position.array);
      assert.ok(safe.index.array);
      assert.ok(unsafe.position.array);
      assert.ok(unsafe.index.array);
    });
  }
});
