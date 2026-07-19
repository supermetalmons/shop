import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
} from '../scripts/shared/firebaseCliFirestoreRest.ts';

type ClientOptions = Parameters<
  typeof createFirebaseCliFirestoreRestClient
>[0];
type FirebaseCliFetch = NonNullable<ClientOptions['fetchImpl']>;
type FirebaseCliSpawnSync = NonNullable<ClientOptions['spawnSyncImpl']>;

function firebaseLoginResult(
  refreshToken = 'refresh-token',
  scope = 'scope-a scope-b',
): ReturnType<FirebaseCliSpawnSync> {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: [
        {
          tokens: {
            refresh_token: refreshToken,
            scope,
          },
        },
      ],
    }),
    stderr: '',
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

test('Firestore REST decoder supports the complete value union used by admin tools', () => {
  const document = decodeFirestoreRestDocument({
    name: 'projects/mons-shop/databases/(default)/documents/claimCodes/123',
    fields: {
      nil: { nullValue: null },
      enabled: { booleanValue: false },
      count: { integerValue: '42' },
      ratio: { doubleValue: 1.5 },
      createdAt: { timestampValue: '2026-07-19T10:11:12Z' },
      label: { stringValue: 'hello' },
      bytes: { bytesValue: 'AQID' },
      reference: {
        referenceValue:
          'projects/mons-shop/databases/(default)/documents/drops/demo',
      },
      point: {
        geoPointValue: {
          latitude: 41.0082,
          longitude: 28.9784,
        },
      },
      values: {
        arrayValue: {
          values: [{ stringValue: 'one' }, { integerValue: '2' }],
        },
      },
      nested: {
        mapValue: {
          fields: {
            value: { doubleValue: 3.25 },
          },
        },
      },
    },
  });

  assert.deepEqual(document, {
    path: 'claimCodes/123',
    id: '123',
    data: {
      nil: null,
      enabled: false,
      count: 42,
      ratio: 1.5,
      createdAt: '2026-07-19T10:11:12Z',
      label: 'hello',
      bytes: 'AQID',
      reference:
        'projects/mons-shop/databases/(default)/documents/drops/demo',
      point: {
        latitude: 41.0082,
        longitude: 28.9784,
      },
      values: ['one', 2],
      nested: { value: 3.25 },
    },
  });
  assert.equal(decodeFirestoreRestDocument({ name: 'missing-prefix' }), undefined);
});

test('Firebase CLI Firestore client is lazy, encodes raw path segments once, and caches its token', async () => {
  let spawnCalls = 0;
  const firestoreRequests: Array<{
    url: string;
    init: RequestInit | undefined;
  }> = [];
  let oauthRequests = 0;

  const spawnSyncImpl: FirebaseCliSpawnSync = (
    command,
    args,
    options,
  ) => {
    spawnCalls += 1;
    assert.equal(command, 'firebase');
    assert.deepEqual(args, ['login:list', '--json']);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.env.FIREBASE_CLI_DISABLE_UPDATE_CHECK, '1');
    return firebaseLoginResult();
  };
  const fetchImpl: FirebaseCliFetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://www.googleapis.com/oauth2/v3/token') {
      oauthRequests += 1;
      assert.equal(init?.method, 'POST');
      const body = init?.body as URLSearchParams;
      assert.equal(body.get('refresh_token'), 'refresh-token');
      assert.equal(body.get('scope'), 'scope-a scope-b');
      return jsonResponse({ access_token: 'access-token' });
    }
    firestoreRequests.push({ url, init });
    return jsonResponse({ request: firestoreRequests.length });
  };

  const client = createFirebaseCliFirestoreRestClient({
    projectId: 'mons-shop',
    fetchImpl,
    spawnSyncImpl,
  });

  assert.equal(spawnCalls, 0);
  assert.equal(oauthRequests, 0);
  assert.equal(
    client.documentUrl('/claimCodes/a b%/').toString(),
    'https://firestore.googleapis.com/v1/projects/mons-shop/databases/(default)/documents/claimCodes/a%20b%25',
  );
  assert.equal(
    client.documentsUrl(':runQuery').toString(),
    'https://firestore.googleapis.com/v1/projects/mons-shop/databases/(default)/documents:runQuery',
  );

  await client.request({ url: client.documentUrl('claimCodes/one') });
  await client.request({ url: client.documentUrl('claimCodes/two') });

  assert.equal(spawnCalls, 1);
  assert.equal(oauthRequests, 1);
  assert.equal(firestoreRequests.length, 2);
  for (const request of firestoreRequests) {
    assert.equal(request.init?.method, 'GET');
    assert.deepEqual(request.init?.headers, {
      Authorization: 'Bearer access-token',
    });
  }
});

test('Firebase CLI token cache resets after refresh failure', async () => {
  let spawnCalls = 0;
  let oauthAttempts = 0;
  let firestoreRequests = 0;

  const client = createFirebaseCliFirestoreRestClient({
    projectId: 'mons-shop',
    spawnSyncImpl: () => {
      spawnCalls += 1;
      return firebaseLoginResult(`refresh-${spawnCalls}`, '');
    },
    fetchImpl: async (input) => {
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/token') {
        oauthAttempts += 1;
        return oauthAttempts === 1
          ? jsonResponse(
              { error: 'invalid_grant', error_description: 'expired token' },
              { status: 400 },
            )
          : jsonResponse({ access_token: 'recovered-token' });
      }
      firestoreRequests += 1;
      return jsonResponse({ ok: true });
    },
  });

  await assert.rejects(
    client.request({ url: client.documentUrl('claimCodes/one') }),
    /expired token/,
  );
  assert.deepEqual(
    await client.request({ url: client.documentUrl('claimCodes/one') }),
    { ok: true },
  );
  assert.equal(spawnCalls, 2);
  assert.equal(oauthAttempts, 2);
  assert.equal(firestoreRequests, 1);
});

test('Firebase CLI token cache resets after a malformed OAuth response', async () => {
  let spawnCalls = 0;
  let oauthAttempts = 0;
  let firestoreRequests = 0;

  const client = createFirebaseCliFirestoreRestClient({
    projectId: 'mons-shop',
    spawnSyncImpl: () => {
      spawnCalls += 1;
      return firebaseLoginResult(`refresh-${spawnCalls}`, '');
    },
    fetchImpl: async (input) => {
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/token') {
        oauthAttempts += 1;
        return oauthAttempts === 1
          ? new Response('{not-json', { status: 200 })
          : jsonResponse({ access_token: 'recovered-token' });
      }
      firestoreRequests += 1;
      return jsonResponse({ ok: true });
    },
  });

  await assert.rejects(
    client.request({ url: client.documentUrl('claimCodes/one') }),
    /OAuth token refresh returned malformed JSON/,
  );
  assert.deepEqual(
    await client.request({ url: client.documentUrl('claimCodes/one') }),
    { ok: true },
  );
  assert.equal(spawnCalls, 2);
  assert.equal(oauthAttempts, 2);
  assert.equal(firestoreRequests, 1);
});

test('Firestore REST requests support JSON POST, empty DELETE, and allowed 404 responses', async () => {
  const firestoreRequests: Array<{
    url: string;
    init: RequestInit | undefined;
  }> = [];
  const client = createFirebaseCliFirestoreRestClient({
    projectId: 'mons-shop',
    spawnSyncImpl: () => firebaseLoginResult(),
    fetchImpl: async (input, init) => {
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/token') {
        return jsonResponse({ access_token: 'access-token' });
      }
      firestoreRequests.push({ url: String(input), init });
      if (String(input).endsWith('/missing')) {
        return jsonResponse(
          { error: { status: 'NOT_FOUND', message: 'missing' } },
          { status: 404 },
        );
      }
      if (String(input).endsWith('/plain-text-missing')) {
        return new Response('not found', {
          status: 404,
          statusText: 'Not Found',
        });
      }
      if (String(input).endsWith('/malformed-success')) {
        return new Response('{not-json', { status: 200 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse([{ document: { name: 'example' } }]);
    },
  });

  const queryResult = await client.request({
    url: client.documentsUrl(':runQuery'),
    body: { structuredQuery: { from: [] } },
  });
  assert.deepEqual(queryResult, [{ document: { name: 'example' } }]);
  assert.deepEqual(
    JSON.parse(String(firestoreRequests[0].init?.body)),
    { structuredQuery: { from: [] } },
  );
  assert.deepEqual(firestoreRequests[0].init?.headers, {
    Authorization: 'Bearer access-token',
    'Content-Type': 'application/json',
  });

  assert.deepEqual(
    await client.request({
      url: client.documentUrl('claimCodes/one'),
      method: 'DELETE',
    }),
    {},
  );
  assert.equal(
    await client.request({
      url: client.documentUrl('claimCodes/missing'),
      allow404: true,
    }),
    undefined,
  );
  assert.equal(
    await client.request({
      url: client.documentUrl('claimCodes/plain-text-missing'),
      allow404: true,
    }),
    undefined,
  );
  await assert.rejects(
    client.request({
      url: client.documentUrl('claimCodes/plain-text-missing'),
    }),
    /Firestore REST request returned malformed JSON/,
  );
  await assert.rejects(
    client.request({
      url: client.documentUrl('claimCodes/malformed-success'),
    }),
    /Firestore REST request returned malformed JSON/,
  );
});
