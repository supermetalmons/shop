export function unusedEthereumRevealBindings(): Pick<Env,
  'ETHEREUM_REVEAL' | 'ETHEREUM_REVEAL_VERIFIER' | 'ETHEREUM_REVEAL_PUBLISHER' | 'ETHEREUM_REVEAL_METADATA' | 'ETHEREUM_REVEAL_READ_RATE_LIMITER' | 'ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER'> {
  const unexpected = (): never => { throw new Error('Unexpected Ethereum reveal binding access in this test.'); };
  return {
    ETHEREUM_REVEAL: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
    ETHEREUM_REVEAL_VERIFIER: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
    ETHEREUM_REVEAL_PUBLISHER: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
    ETHEREUM_REVEAL_METADATA: { head: unexpected, get: unexpected, put: unexpected,
      createMultipartUpload: unexpected, resumeMultipartUpload: unexpected, delete: unexpected, list: unexpected },
    ETHEREUM_REVEAL_READ_RATE_LIMITER: { limit: unexpected },
    ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: { limit: unexpected },
  };
}
