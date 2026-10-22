import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkerVersionClient,
  WORKER_SIGNER_RUNTIME,
  type SourceRestoration,
  type WorkerSnapshot,
  type TemporaryWorkerVersion,
} from '../scripts/ops/worker-transaction/cloudflare.ts';

const SOURCE = '11111111-1111-1111-1111-111111111111';
const TEMP = '01234567-1234-1234-1234-123456789abc';
const RESTORED = 'fedcba98-1234-1234-1234-123456789abc';
const OPERATION = 'abcd1234-1234-1234-1234-123456789abc';
const DEPLOYMENT = '22222222-2222-2222-2222-222222222222';
const VERSION_PATH = '/workers/workers/test-worker/versions';
const target = { accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', workerName: 'test-worker' };
const snapshot: WorkerSnapshot = {
  deploymentId: DEPLOYMENT, versionId: SOURCE, latestVersionId: SOURCE, previewSuffix: 'test-worker.test-account.workers.dev', compatibilityDate: '2026-08-08',
  compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
  secretNames: ['COSIGNER_SECRET', 'HELIUS_API_KEY', 'OTHER_EXISTING_SECRET'],
};
const temporary: TemporaryWorkerVersion = {
  id: TEMP, url: 'https://01234567-test-worker.test-account.workers.dev', operationId: OPERATION,
};

function envelope(result: unknown, result_info?: unknown): Response {
  return Response.json({ success: true, result, ...(result_info ? { result_info } : {}) });
}

function deployed(versionId = SOURCE, id = DEPLOYMENT): Response {
  return envelope({ deployments: [{ id, versions: [{ version_id: versionId, percentage: 100 }] }] });
}

function temporaryResult() {
  return { id: TEMP, urls: [temporary.url], annotations: { 'workers/tag': `worker-tx-${OPERATION}` } };
}

function client(handler: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  return createWorkerVersionClient({ token: 'private-token', target, fetch: async (input, init) => handler(new URL(String(input)), init ?? {}) });
}

test('snapshots the active production version and exposes only secret binding names', async () => {
  const calls: string[] = [];
  const api = client((url, init) => {
    calls.push(url.pathname);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-token');
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE });
    assert.ok(url.pathname.endsWith(`${VERSION_PATH}/${SOURCE}`));
    return envelope({ id: SOURCE, urls: ['https://11111111-test-worker.test-account.workers.dev'], compatibility_date: '2026-08-08', compatibility_flags: snapshot.compatibilityFlags,
      bindings: [...snapshot.secretNames.map(name => ({ name, type: 'secret_text' })), { name: 'DATA_DB', type: 'd1', id: 'not-inherited' }] });
  });
  assert.deepEqual(await api.snapshot(), snapshot);
  assert.equal(calls.length, 5);
});

test('normalizes omitted compatibility flags while rejecting malformed supplied values', async () => {
  for (const flags of [undefined, [], null, 'nodejs_compat', {}, [false], ['nodejs_compat', 1]]) {
    const api = client((url, init) => {
      assert.equal(init.method, undefined);
      if (url.pathname.endsWith('/deployments')) return deployed();
      if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE });
      return envelope({ id: SOURCE, urls: [`https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}`],
        compatibility_date: snapshot.compatibilityDate,
        ...(flags === undefined ? {} : { compatibility_flags: flags }),
        bindings: snapshot.secretNames.map(name => ({ name, type: 'secret_text' })),
      });
    });
    if (flags === undefined || (Array.isArray(flags) && flags.length === 0)) {
      assert.deepEqual(await api.snapshot(), { ...snapshot, compatibilityFlags: [] });
    } else {
      await assert.rejects(api.snapshot(), /production version configuration is invalid/);
    }
  }
});

test('supports another Worker and signing binding without an RPC secret or trusted upload URL', async () => {
  const alternate = { accountId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', workerName: 'maintenance-worker' };
  const alternateSuffix = 'maintenance-worker.another-account.workers.dev';
  const api = createWorkerVersionClient({ token: 'private-token', target: alternate, signerBinding: 'MaintenanceKey', fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.ok(url.pathname.startsWith(`/client/v4/accounts/${alternate.accountId}/workers/`));
    assert.ok(url.pathname.includes(`/${alternate.workerName}/`));
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.bindings, [{ name: 'MaintenanceKey', type: 'inherit', version_id: SOURCE }]);
      return envelope({ ...temporaryResult(), urls: ['https://untrusted.example/sign'] });
    }
    return envelope({ id: SOURCE, urls: [`https://${SOURCE.slice(0, 8)}-${alternateSuffix}`],
      compatibility_date: snapshot.compatibilityDate, compatibility_flags: snapshot.compatibilityFlags,
      bindings: [{ name: 'MaintenanceKey', type: 'secret_text' }] });
  } });
  const source = await api.snapshot();
  assert.equal(source.previewSuffix, alternateSuffix);
  assert.deepEqual(source.secretNames, ['MaintenanceKey']);
  const result = await api.upload({ snapshot: source, bundle: 'export default {};', operationId: OPERATION, onUploadChange: () => {} });
  assert.equal(result.url, `https://${TEMP.slice(0, 8)}-${alternateSuffix}`);
});

test('rejects invalid targets, secret binding names and source Version URL origins', async () => {
  for (const invalidTarget of [
    { ...target, accountId: '../other-account' },
    { ...target, accountId: 'a'.repeat(31) },
    { ...target, workerName: 'worker/path' },
    { ...target, workerName: 'worker.example' },
    { ...target, workerName: '-worker' },
    { ...target, workerName: 'worker-' },
  ]) assert.throws(() => createWorkerVersionClient({ token: 'private-token', target: invalidTarget }), /target is invalid/);
  assert.throws(() => createWorkerVersionClient({ token: 'private-token', target, signerBinding: 'invalid binding' }), /binding name is invalid/);
  for (const url of [
    `http://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}`,
    `https://user@${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}`,
    `https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}:8443`,
    `https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}/path`,
    `https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}?query=1`,
    `https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}#fragment`,
    `https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}.example`,
    `https://${SOURCE.slice(0, 8)}-another-worker.test-account.workers.dev`,
    `https://${TEMP.slice(0, 8)}-${snapshot.previewSuffix}`,
  ]) {
    const api = client(requestUrl => requestUrl.pathname.endsWith('/deployments') ? deployed() : envelope({
      id: SOURCE, urls: [url], compatibility_date: snapshot.compatibilityDate, compatibility_flags: snapshot.compatibilityFlags,
      bindings: [{ name: 'COSIGNER_SECRET', type: 'secret_text' }],
    }));
    await assert.rejects(api.snapshot(), /valid Version URL/);
  }
});

test('rejects a mismatched snapshot suffix before any upload or inventory request', async () => {
  const api = client(() => assert.fail('Invalid snapshot must fail before a request.'));
  const invalid = { ...snapshot, previewSuffix: 'another-worker.test-account.workers.dev' };
  await assert.rejects(api.upload({ snapshot: invalid, bundle: 'export default {};', operationId: OPERATION,
    onUploadChange: () => assert.fail('Invalid snapshot must not set an upload marker.') }), /suffix is invalid/);
  await assert.rejects(api.findOperation({ operationId: OPERATION, snapshot: invalid }), /suffix is invalid/);
});

test('uploads a compatible signer independently of an older source runtime', async () => {
  const sourceSnapshot = { ...snapshot, compatibilityDate: '2025-01-01', compatibilityFlags: [] };
  const uploadChanges: boolean[] = [];
  const api = client((url, init) => {
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE });
    if (url.pathname.endsWith(`/${SOURCE}`)) return envelope({ id: SOURCE, main_module: 'index.js' });
    assert.deepEqual(uploadChanges, [true]);
    assert.ok(url.pathname.endsWith(VERSION_PATH));
    assert.equal(url.search, '?deploy=false');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.bindings, snapshot.secretNames.map(name => ({ name, type: 'inherit', version_id: SOURCE })));
    assert.equal(body.main_module, 'worker-transaction-signer.js');
    assert.equal(Buffer.from(body.modules[0].content_base64, 'base64').toString(), 'export default {};');
    assert.equal(body.modules[0].content_type, 'application/javascript+module');
    assert.equal(body.compatibility_date, WORKER_SIGNER_RUNTIME.compatibility_date);
    assert.deepEqual(body.compatibility_flags, WORKER_SIGNER_RUNTIME.compatibility_flags);
    assert.equal(body.annotations['workers/tag'], `worker-tx-${OPERATION}`);
    assert.equal(JSON.stringify(body).includes('private-token'), false);
    return envelope(temporaryResult());
  });
  assert.deepEqual(await api.upload({ snapshot: sourceSnapshot, bundle: 'export default {};', operationId: OPERATION,
    onUploadChange: started => uploadChanges.push(started) }), temporary);
  assert.equal(sourceSnapshot.compatibilityDate, '2025-01-01');
  assert.deepEqual(sourceSnapshot.compatibilityFlags, []);
});

test('refuses upload if production changes between snapshot and mutation', async () => {
  const api = client((_url, init) => {
    assert.notEqual(init.method, 'POST');
    return deployed(TEMP);
  });
  await assert.rejects(api.upload({ snapshot, bundle: 'export default {};', operationId: OPERATION,
    onUploadChange: () => assert.fail('Upload marker changed before preflight passed') }), /deployment changed/);
});

test('refuses a signer upload when another version was staged after the snapshot', async () => {
  const api = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    if (url.pathname.endsWith('/deployments')) return deployed();
    return envelope({ id: url.pathname.endsWith(`/${SOURCE}`) ? SOURCE : RESTORED });
  });
  await assert.rejects(api.upload({ snapshot, bundle: 'export default {};', operationId: OPERATION,
    onUploadChange: () => assert.fail('No upload may start after latest changes') }), /latest Worker version changed/);
});

function sourceMetadata(id = SOURCE, additions: Record<string, unknown> = {}) {
  return { id, main_module: 'index.js', urls: [`https://${id.slice(0, 8)}-${snapshot.previewSuffix}`],
    compatibility_date: snapshot.compatibilityDate, compatibility_flags: snapshot.compatibilityFlags,
    bindings: snapshot.secretNames.map(name => ({ name, type: 'secret_text' })), ...additions };
}

function guardedSources(active: Record<string, unknown>, latest: Record<string, unknown>) {
  let posts = 0;
  const api = client((url, init) => {
    if (init.method === 'POST') { posts++; assert.fail('Unsupported sources must never reach upload.'); }
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope(latest);
    assert.ok(url.pathname.endsWith(`/${SOURCE}`));
    return envelope(active);
  });
  const upload = () => api.upload({ snapshot: { ...snapshot, latestVersionId: String(latest.id) }, bundle: 'export default {};', operationId: OPERATION,
    onUploadChange: () => assert.fail('Unsupported sources must not set an upload marker.') });
  return { api, upload, posts: () => posts };
}

test('an earlier operation signer cannot become another operation active or latest source', async () => {
  for (const unsafe of [
    { annotations: { 'workers/tag': `worker-tx-${'99999999-1234-1234-1234-123456789abc'}` } },
    { main_module: 'worker-transaction-signer.js', annotations: { 'workers/tag': `worker-source-${OPERATION}` } },
  ]) {
    for (const placement of ['active', 'latest'] as const) {
      const f = guardedSources(sourceMetadata(SOURCE, placement === 'active' ? unsafe : {}),
        sourceMetadata(RESTORED, placement === 'latest' ? unsafe : {}));
      await assert.rejects(f.api.snapshot(), /temporary transaction signer cannot be used/);
      await assert.rejects(f.upload(), /temporary transaction signer cannot be used/);
      assert.equal(f.posts(), 0);
    }
  }
});

test('active and staged Durable Object lifecycle metadata blocks signing before upload', async () => {
  const unsupported: Record<string, unknown>[] = [
    { migrations: { old_tag: 'v1', new_tag: 'v2', deleted_classes: ['OldState'] } },
    { migrations: { old_tag: 'v1', new_tag: 'v2', renamed_classes: [{ from: 'OldState', to: 'NewState' }] } },
    { migrations: { new_sqlite_classes: ['NewState'] } },
    { migrations: null }, { migrations: [] }, { migrations: 'v2' },
    { migration_tag: 'v2' }, { migration_tag: null },
    { exports: { State: { type: 'durable-object', storage: 'sqlite' } } },
    { exports: { State: { type: 'durable_object', state: 'deleted' } } },
    { exports: { State: { type: 'worker', state: 'deleted' } } },
    { exports: { State: { type: 'worker', renamed_to: 'NewState' } } },
    { exports: { State: { type: 'workflow', state: 'expecting-transfer', transfer_from: 'other' } } },
    { exports: [] },
    { exports_reconciliation: { deleted: ['OldState'] } },
    { exports_reconciliation: { renamed: [{ from: 'OldState', to: 'NewState' }] } },
    { exports_reconciliation: { transferred: [{ class: 'State', to: 'other-worker' }] } },
    { exports_reconciliation: { transfer_pending: [{ class: 'State', from: 'other-worker' }] } },
    { exports_reconciliation: { deleted: null } }, { exports_reconciliation: { renamed: {} } },
    { exports_reconciliation: null },
    { bindings: [{ name: 'REMOTE_STATE', type: 'durable_object_namespace', script_name: 'other-worker' }] },
    { containers: [{ class_name: 'State' }] }, { containers: {} },
  ];
  for (const unsafe of unsupported) {
    for (const placement of ['active', 'latest'] as const) {
      const f = guardedSources(sourceMetadata(SOURCE, placement === 'active' ? unsafe : {}),
        sourceMetadata(RESTORED, placement === 'latest' ? unsafe : {}));
      await assert.rejects(f.api.snapshot(), /Durable Object lifecycle sources are unsupported/);
      await assert.rejects(f.upload(), /Durable Object lifecycle sources are unsupported/);
      assert.equal(f.posts(), 0);
    }
  }
});

test('ordinary Worker and Workflow exports with empty lifecycle metadata remain supported', async () => {
  const source = sourceMetadata(SOURCE, { migrations: {}, migration_tag: '', containers: [],
    exports: { default: { type: 'worker' }, Admin: { type: 'worker', state: 'created' }, Order: { type: 'workflow', state: 'created' } },
    exports_reconciliation: { created: ['Admin', 'Order'], deleted: [], renamed: [], transferred: [], transfer_pending: [] },
  });
  let posted = false;
  const api = client((url, init) => {
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (init.method === 'POST') { posted = true; return envelope(temporaryResult()); }
    return envelope(source);
  });
  assert.deepEqual(await api.snapshot(), snapshot);
  await api.upload({ snapshot, bundle: 'export default {};', operationId: OPERATION, onUploadChange: () => {} });
  assert.equal(posted, true);
});

test('restoration refuses poisoned or unsupported source configurations before cloning', async () => {
  for (const unsafe of [
    { main_module: 'worker-transaction-signer.js', annotations: { 'workers/tag': `worker-source-${OPERATION}` } },
    { annotations: { 'workers/tag': 'worker-tx-old-operation' } },
    { migrations: { deleted_classes: ['OldState'] } },
    { exports: { State: { type: 'durable-object', state: 'renamed', renamed_to: 'NewState' } } },
    { exports_reconciliation: { deleted: ['OldState'] } },
  ]) {
    const source = sourceMetadata(SOURCE, { modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], ...unsafe });
    const api = client((url, init) => {
      assert.notEqual(init.method, 'POST');
      if (url.pathname.endsWith('/latest')) return envelope(temporaryResult());
      return envelope(source);
    });
    await assert.rejects(api.restoreSourceLatest({ snapshot, operationId: OPERATION,
      onRestorationChange: () => assert.fail('Unsupported source must fail before a clone upload marker.') }),
    /temporary transaction signer cannot be used|Durable Object lifecycle sources are unsupported/);
  }
});

test('restored copies are checked for signer code and unsupported lifecycle metadata', async () => {
  for (const unsafe of [
    { main_module: 'worker-transaction-signer.js' },
    { migrations: { renamed_classes: [{ from: 'OldState', to: 'NewState' }] } },
  ]) {
    const source = sourceMetadata(SOURCE, { modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }] });
    const restored = { ...source, id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` }, ...unsafe };
    const api = client((url, init) => {
      assert.notEqual(init.method, 'POST');
      return envelope(url.pathname.endsWith(`/${SOURCE}`) ? source : restored);
    });
    await assert.rejects(api.restoreSourceLatest({ snapshot, operationId: OPERATION, restoration: { started: true, versionId: RESTORED } }),
      /temporary transaction signer cannot be used|Durable Object lifecycle sources are unsupported/);
  }
});

function uploadAttempt(kind: 'signer' | 'source', post: () => Response) {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  const clone = { ...source, id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` } };
  const changes: boolean[] = [];
  let restoration: SourceRestoration = { started: false };
  let started = false;
  let posts = 0;
  let failPreflight = false;
  const api = client((url, init) => {
    if (failPreflight && init.method !== 'POST') throw new Error('GET transport failed');
    if (url.pathname.endsWith('/deployments')) {
      return deployed();
    }
    if (url.pathname.endsWith('/latest')) return envelope(kind === 'signer' ? { id: SOURCE } : temporaryResult());
    if (url.pathname.endsWith(`/${SOURCE}`)) return envelope(source);
    if (url.pathname.endsWith(`/${RESTORED}`)) return envelope(clone);
    assert.equal(init.method, 'POST');
    assert.equal(started, true);
    posts++;
    return post();
  });
  const onUploadChange = (value: boolean) => { started = value; changes.push(value); };
  const run = () => kind === 'signer'
    ? api.upload({ snapshot, bundle: 'export default {};', operationId: OPERATION, onUploadChange })
    : api.restoreSourceLatest({ snapshot, operationId: OPERATION, restoration,
      onRestorationChange: state => { restoration = state; onUploadChange(state.started); } });
  return { run, changes, success: () => envelope(kind === 'signer' ? temporaryResult() : clone),
    state: () => ({ started, posts }), failPreflight: () => { failPreflight = true; } };
}

test('preflight GET failures leave signer and source upload markers unchanged without posting', async () => {
  for (const kind of ['signer', 'source'] as const) {
    const f = uploadAttempt(kind, () => assert.fail('POST after failed preflight'));
    f.failPreflight();
    await assert.rejects(f.run(), /version request failed/);
    assert.deepEqual(f.state(), { started: false, posts: 0 });
    assert.deepEqual(f.changes, []);
  }
});

test('definitive Cloudflare upload rejections clear their markers and permit corrected retries', async () => {
  for (const kind of ['signer', 'source'] as const) {
    for (const status of [403, 429]) {
      let reject = true;
      const f = uploadAttempt(kind, () => reject
        ? Response.json({ success: false, errors: [{ code: 10000, message: 'private-token must not appear' }] }, { status })
        : f.success());
      await assert.rejects(f.run(), error => error instanceof Error && error.message === `Cloudflare version request failed with HTTP ${status} (codes 10000).`);
      assert.deepEqual(f.state(), { started: false, posts: 1 });
      assert.deepEqual(f.changes, [true, false]);
      reject = false;
      await f.run();
      assert.deepEqual(f.state(), { started: true, posts: 2 });
    }
  }
});

test('uncertain upload responses retain pending markers, including malformed successful results', async () => {
  const responses = [
    () => { throw new Error('connection lost after acceptance'); },
    () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 }),
    () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 408 }),
    () => new Response('<html>denied</html>', { status: 403 }),
    () => Response.json({ error: 'denied' }, { status: 403 }),
    () => envelope({}),
  ];
  for (const kind of ['signer', 'source'] as const) {
    for (const response of responses) {
      const f = uploadAttempt(kind, response);
      await assert.rejects(f.run());
      assert.deepEqual(f.state(), { started: true, posts: 1 });
      assert.deepEqual(f.changes, [true]);
    }
  }
});

test('recovers a lost upload response using the exact operation tag', async () => {
  const api = client((url, init) => {
    assert.equal(init.method, undefined);
    assert.ok(url.pathname.endsWith(VERSION_PATH));
    assert.equal(url.searchParams.get('page'), '1');
    return envelope([temporaryResult(), { id: SOURCE, annotations: {} }], { page: 1, total_count: 2 });
  });
  assert.deepEqual(await api.findOperation({ operationId: OPERATION, snapshot }), [temporary]);
});

test('never deletes the production source or a currently deployed temporary version', async () => {
  let calls = 0;
  const api = client((_url, init) => {
    calls++;
    assert.notEqual(init.method, 'DELETE');
    return deployed(TEMP);
  });
  await assert.rejects(api.remove({ snapshot, version: { ...temporary, id: SOURCE } }), /production source/);
  assert.equal(calls, 0);
  await assert.rejects(api.remove({ snapshot, version: temporary }), /deployed Worker/);
  assert.equal(calls, 1);
});

test('deletes only the exact tagged temporary version and verifies disappearance without leaking credentials', async () => {
  let removed = false;
  const api = client((url, init) => {
    if (url.hostname.endsWith('.workers.dev')) {
      assert.equal(url.toString(), `${temporary.url}/sign`);
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE, annotations: {} });
    assert.ok(url.pathname.endsWith(`${VERSION_PATH}/${TEMP}`));
    if (init.method === 'DELETE') {
      removed = true;
      return envelope(null);
    }
    if (removed) return Response.json({ success: false, errors: [{ code: 10071 }] }, { status: 404 });
    return envelope(temporaryResult());
  });
  await api.remove({ snapshot, version: temporary });
  assert.deepEqual(await api.verifyRemoved({ snapshot, version: temporary }), { absent: true, previewStatus: 404, productionUnchanged: true });
});

test('cleanup rejects an untagged version and an endpoint that still executes', async () => {
  const untagged = client((url, init) => {
    assert.notEqual(init.method, 'DELETE');
    return url.pathname.endsWith('/deployments') ? deployed() : envelope({ ...temporaryResult(), annotations: {} });
  });
  await assert.rejects(untagged.remove({ snapshot, version: temporary }), /does not match/);
  const stillExecuting = client(url => url.hostname.endsWith('.workers.dev')
    ? new Response('Unauthorized', { status: 401 })
    : Response.json({ success: false }, { status: 404 }));
  await assert.rejects(stillExecuting.verifyRemoved({ snapshot, version: temporary }), /not yet confirmed/);
});

test('API failures never expose response messages or transport error credentials', async () => {
  const denied = client(() => Response.json({ success: false, errors: [{ code: 10000, message: 'private-token and other credentials' }] }, { status: 403 }));
  await assert.rejects(denied.snapshot(), error => error instanceof Error && error.message === 'Cloudflare version request failed with HTTP 403 (codes 10000).');
  const broken = client(() => { throw new Error('https://example.test/?api-key=private-token'); });
  await assert.rejects(broken.snapshot(), error => error instanceof Error && !error.message.includes('private-token') && !error.message.includes('https://'));
});

test('copies the exact production source and every resource binding before deleting a latest temporary version', async () => {
  const sourceSnapshot = { ...snapshot, compatibilityDate: '2025-01-01', compatibilityFlags: [] };
  const source = {
    id: SOURCE, main_module: 'index.js', compatibility_date: sourceSnapshot.compatibilityDate,
    compatibility_flags: sourceSnapshot.compatibilityFlags, placement: { mode: 'smart' }, usage_model: 'standard',
    modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: Buffer.from('original source').toString('base64') }],
    bindings: [{ name: 'DATA_DB', type: 'd1', id: 'existing-db' }, { name: 'COSIGNER_SECRET', type: 'secret_text' }, { name: 'FEATURE', type: 'plain_text', text: 'true' }],
    env: { DATA_DB: { type: 'd1', id: 'existing-db' }, COSIGNER_SECRET: { type: 'secret_text' }, FEATURE: { type: 'plain_text', text: 'true' } },
  };
  const events: string[] = [];
  const restorationChanges: SourceRestoration[] = [];
  const api = client((url, init) => {
    events.push(`${init.method ?? 'GET'} ${url.pathname.split('/').at(-1)}`);
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope(temporaryResult());
    if (url.pathname.endsWith(`/${SOURCE}`)) {
      assert.equal(url.searchParams.get('include'), 'modules');
      return envelope(source);
    }
    if (url.pathname.endsWith(`/${RESTORED}`)) return envelope({ ...source, id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` } });
    if (url.pathname.endsWith(VERSION_PATH)) {
      assert.deepEqual(restorationChanges, [{ started: true }]);
      assert.equal(url.searchParams.get('deploy'), 'false');
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.modules, source.modules);
      assert.equal(body.main_module, source.main_module);
      assert.equal(body.compatibility_date, source.compatibility_date);
      assert.deepEqual(body.compatibility_flags, source.compatibility_flags);
      assert.deepEqual(body.placement, source.placement);
      assert.deepEqual(body.bindings, [
        { name: 'COSIGNER_SECRET', type: 'inherit', version_id: SOURCE },
        { name: 'DATA_DB', type: 'inherit', version_id: SOURCE },
        { name: 'FEATURE', type: 'inherit', version_id: SOURCE },
      ]);
      assert.equal(body.annotations['workers/tag'], `worker-source-${OPERATION}`);
      return envelope({ id: RESTORED, annotations: body.annotations });
    }
    assert.ok(url.pathname.endsWith(`/${TEMP}`));
    return init.method === 'DELETE' ? envelope(null) : envelope(temporaryResult());
  });
  await api.remove({ snapshot: sourceSnapshot, version: temporary, onRestorationChange: state => restorationChanges.push(state) });
  assert.deepEqual(restorationChanges, [{ started: true }, { started: true, versionId: RESTORED }]);
  assert.ok(events.indexOf('POST versions') < events.indexOf(`DELETE ${TEMP}`));
  assert.ok(events.includes(`GET ${RESTORED}`));
});

test('preserves staged latest during cleanup after production rolls back while the signer remains latest', async () => {
  const stagedId = '33333333-3333-3333-3333-333333333333';
  const active = { id: SOURCE, urls: [`https://${SOURCE.slice(0, 8)}-${snapshot.previewSuffix}`],
    compatibility_date: snapshot.compatibilityDate, compatibility_flags: snapshot.compatibilityFlags,
    bindings: [{ name: 'COSIGNER_SECRET', type: 'secret_text' }] };
  const staged = { ...active, id: stagedId, main_module: 'index.js',
    modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: Buffer.from('staged code').toString('base64') }],
    bindings: [...active.bindings, { name: 'NEXT_SECRET', type: 'secret_text' }],
  };
  let latest: unknown = staged;
  let deleted = false;
  let cloned = false;
  let rolledBack = false;
  const api = client((url, init) => {
    if (url.hostname.endsWith('.workers.dev')) return new Response('Not found', { status: 404 });
    if (url.pathname.endsWith('/deployments')) {
      assert.equal(init.method, undefined);
      return rolledBack ? deployed('44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555') : deployed();
    }
    if (url.pathname.endsWith('/latest')) return envelope(latest);
    if (url.pathname.endsWith(`/${SOURCE}`)) return envelope(active);
    if (url.pathname.endsWith(`/${stagedId}`)) return envelope(staged);
    if (url.pathname.endsWith(`/${RESTORED}`)) return envelope(latest);
    if (url.pathname.endsWith(VERSION_PATH)) {
      assert.equal(init.method, 'POST');
      assert.equal(url.searchParams.get('deploy'), 'false');
      const body = JSON.parse(String(init.body));
      if (body.annotations['workers/tag'] === `worker-tx-${OPERATION}`) {
        assert.deepEqual(body.bindings, [{ name: 'COSIGNER_SECRET', type: 'inherit', version_id: SOURCE }]);
        latest = temporaryResult();
      } else {
        assert.deepEqual(body.modules, staged.modules);
        assert.deepEqual(body.bindings, staged.bindings.map(binding => ({ name: binding.name, type: 'inherit', version_id: stagedId })));
        cloned = true; latest = { ...staged, id: RESTORED, annotations: body.annotations };
      }
      return envelope(latest);
    }
    assert.ok(url.pathname.endsWith(`/${TEMP}`));
    if (init.method === 'DELETE') { deleted = true; return envelope(null); }
    return deleted ? Response.json({ success: false }, { status: 404 }) : envelope(temporaryResult());
  });
  const captured = await api.snapshot();
  assert.equal(captured.versionId, SOURCE); assert.equal(captured.latestVersionId, stagedId);
  const version = await api.upload({ snapshot: captured, bundle: 'export default {};', operationId: OPERATION, onUploadChange: () => {} });
  rolledBack = true;
  await api.remove({ snapshot: captured, version, onRestorationChange: () => {} });
  assert.equal(cloned, true); assert.equal(deleted, true);
  assert.deepEqual(await api.verifyRemoved({ snapshot: captured, version }), {
    absent: true, previewStatus: 404, productionUnchanged: false, restoredVersion: RESTORED,
  });
});

test('cleanup completes after an external deployment with optional annotations without copying old source', async () => {
  for (const [alreadyAbsent, latest] of [
    [false, { id: RESTORED, annotations: {} }],
    [true, { id: RESTORED, annotations: {} }],
    [false, { id: RESTORED }],
    [true, { id: RESTORED }],
  ] as const) {
    let absent = alreadyAbsent;
    let deletes = 0;
    const api = client((url, init) => {
      if (url.hostname.endsWith('.workers.dev')) return new Response('Not found', { status: 404 });
      assert.notEqual(init.method, 'POST');
      if (url.pathname.endsWith('/deployments')) return deployed(RESTORED, '44444444-4444-4444-4444-444444444444');
      if (url.pathname.endsWith('/latest')) return envelope(latest);
      assert.ok(url.pathname.endsWith(`/${TEMP}`));
      if (init.method === 'DELETE') { deletes++; absent = true; return envelope(null); }
      return absent ? Response.json({ success: false }, { status: 404 }) : envelope(temporaryResult());
    });
    await api.remove({ snapshot, version: temporary });
    assert.deepEqual(await api.verifyRemoved({ snapshot, version: temporary }), { absent: true, previewStatus: 404, productionUnchanged: false });
    assert.equal(deletes, alreadyAbsent ? 0 : 1);
  }
});

test('existing source clones can be verified after production changes without creating another clone', async () => {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  const clone = { ...source, id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` } };
  const api = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    if (url.pathname.endsWith('/deployments')) return deployed(RESTORED, '44444444-4444-4444-4444-444444444444');
    if (url.pathname.endsWith('/latest')) return envelope(temporaryResult());
    if (url.pathname.endsWith(`/${SOURCE}`)) return envelope(source);
    if (url.pathname.endsWith(`/${RESTORED}`)) return envelope(clone);
    return envelope([clone], { page: 1, total_count: 1 });
  });
  for (const restoration of [{ started: true }, { started: true, versionId: RESTORED }]) {
    assert.deepEqual(await api.restoreSourceLatest({ snapshot, operationId: OPERATION, restoration }), { id: RESTORED, sourceVersionId: SOURCE });
  }
});

test('does not replace a version staged during source-restoration reads', async () => {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  let latestReads = 0;
  const api = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    if (url.pathname.endsWith('/latest')) return envelope(++latestReads === 1 ? temporaryResult() : { id: RESTORED, annotations: {} });
    if (url.pathname.endsWith('/deployments')) return deployed();
    return envelope(source);
  });
  assert.equal(await api.restoreSourceLatest({ snapshot, operationId: OPERATION,
    onRestorationChange: () => assert.fail('A new clone must not start after latest advances') }), null);
});

test('restoration does not upload when latest is unrelated and verifies an existing cleanup clone after an uncertain upload', async () => {
  const unrelated = client((_url, init) => {
    assert.notEqual(init.method, 'POST');
    return envelope({ id: SOURCE, annotations: {} });
  });
  assert.equal(await unrelated.restoreSourceLatest({ snapshot, operationId: OPERATION }), null);
  const config = { main_module: 'index.js', compatibility_date: snapshot.compatibilityDate, compatibility_flags: snapshot.compatibilityFlags,
    modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  const recovering = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` } });
    return envelope({ ...config, id: url.pathname.endsWith(`/${SOURCE}`) ? SOURCE : RESTORED,
      annotations: { 'workers/tag': `worker-source-${OPERATION}` } });
  });
  assert.deepEqual(await recovering.restoreSourceLatest({ snapshot, operationId: OPERATION }), { id: RESTORED, sourceVersionId: SOURCE });
});

test('does not upload a source clone without a durable marker or when marker persistence fails', async () => {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  const api = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    if (url.pathname.endsWith('/latest')) return envelope(temporaryResult());
    if (url.pathname.endsWith('/deployments')) return deployed();
    return envelope(source);
  });
  await assert.rejects(api.restoreSourceLatest({ snapshot, operationId: OPERATION }), /durable upload marker/);
  await assert.rejects(api.restoreSourceLatest({ snapshot, operationId: OPERATION,
    onRestorationChange: () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
});

test('keeps a delayed accepted clone unresolved and recovers it after latest advances without another upload', async () => {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  const clone = { ...source, id: RESTORED, annotations: { 'workers/tag': `worker-source-${OPERATION}` } };
  let restoration: SourceRestoration | undefined;
  let cloneVisible = false;
  let uploads = 0;
  let latestReads = 0;
  const api = client((url, init) => {
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) {
      latestReads++;
      return envelope(uploads ? { id: '99999999-1234-1234-1234-123456789abc', annotations: {} } : temporaryResult());
    }
    if (url.pathname.endsWith(`/${SOURCE}`)) return envelope(source);
    if (url.pathname.endsWith(`/${RESTORED}`)) return envelope(clone);
    assert.ok(url.pathname.endsWith(VERSION_PATH));
    if (init.method === 'POST') {
      assert.deepEqual(restoration, { started: true });
      uploads++;
      throw new Error('server accepted create but response was lost');
    }
    return envelope(cloneVisible ? [clone] : [], { page: 1, total_count: cloneVisible ? 1 : 0 });
  });
  const restore = () => api.restoreSourceLatest({ snapshot, operationId: OPERATION, restoration,
    onRestorationChange: state => { restoration = state; } });
  await assert.rejects(restore(), /version request failed/);
  await assert.rejects(restore(), /upload is unresolved/);
  assert.equal(latestReads, 2);
  cloneVisible = true;
  assert.deepEqual(await restore(), { id: RESTORED, sourceVersionId: SOURCE });
  assert.deepEqual(restoration, { started: true, versionId: RESTORED });
  assert.deepEqual(await restore(), { id: RESTORED, sourceVersionId: SOURCE });
  assert.equal(uploads, 1);
  assert.equal(latestReads, 2);
});

test('rejects ambiguous source clones and reconciles pending restoration even after signer deletion', async () => {
  let matches: unknown[] = [];
  const api = client((url, init) => {
    assert.notEqual(init.method, 'POST');
    assert.notEqual(init.method, 'DELETE');
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith(`/${TEMP}`)) return Response.json({ success: false }, { status: 404 });
    assert.ok(url.pathname.endsWith(VERSION_PATH));
    return envelope(matches, { page: 1, total_count: matches.length });
  });
  const options = { snapshot, version: temporary, restoration: { started: true } };
  await assert.rejects(api.remove(options), /upload is unresolved/);
  matches = [RESTORED, '99999999-1234-1234-1234-123456789abc'].map(id => ({ id, annotations: { 'workers/tag': `worker-source-${OPERATION}` } }));
  await assert.rejects(api.remove(options), /Multiple source restoration versions/);
});

test('validates the exact source and operation tag for a recorded clone without consulting latest', async () => {
  const source = { id: SOURCE, main_module: 'index.js', modules: [{ name: 'index.js', content_type: 'application/javascript+module', content_base64: 'YQ==' }], bindings: [] };
  for (const clone of [
    { ...source, id: RESTORED, annotations: { 'workers/tag': 'unrelated' } },
    { ...source, id: RESTORED, main_module: 'changed.js', annotations: { 'workers/tag': `worker-source-${OPERATION}` } },
  ]) {
    const api = client((url, init) => {
      assert.notEqual(init.method, 'POST');
      assert.equal(url.pathname.endsWith('/latest'), false);
      if (url.pathname.endsWith('/deployments')) return deployed();
      return envelope(url.pathname.endsWith(`/${SOURCE}`) ? source : clone);
    });
    await assert.rejects(api.restoreSourceLatest({ snapshot, operationId: OPERATION,
      restoration: { started: true, versionId: RESTORED } }), /differ from the production source/);
  }
});

test('accepts the bounded Cloudflare 1101 HTML response only after API-confirmed deletion', async () => {
  const api = client(url => {
    if (url.hostname.endsWith('.workers.dev')) return new Response('<html><span class="cf-error-code">1101</span><h2>Worker threw exception</h2></html>', { status: 500, headers: { 'content-type': 'text/html' } });
    if (url.pathname.endsWith('/deployments')) return deployed();
    if (url.pathname.endsWith('/latest')) return envelope({ id: SOURCE, annotations: {} });
    return Response.json({ success: false, errors: [{ code: 10071 }] }, { status: 404 });
  });
  assert.deepEqual(await api.verifyRemoved({ snapshot, version: temporary }), { absent: true, previewStatus: 500, productionUnchanged: true });
});

test('does not treat arbitrary or oversized 500 preview responses as successful cleanup', async () => {
  const responses = [
    () => Response.json({ error: 'signing-preflight-failed' }, { status: 500 }),
    () => new Response('<html>Worker threw exception</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    () => new Response(`<span class="cf-error-code">1101</span>Worker threw exception${'x'.repeat(32_768)}`, { status: 500, headers: { 'content-type': 'text/html' } }),
  ];
  for (const response of responses) {
    const api = client(url => url.hostname.endsWith('.workers.dev') ? response() : Response.json({ success: false }, { status: 404 }));
    await assert.rejects(api.verifyRemoved({ snapshot, version: temporary }), /not yet confirmed|Could not verify/);
  }
});
