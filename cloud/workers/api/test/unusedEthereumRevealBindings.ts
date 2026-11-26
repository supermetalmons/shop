export function unusedEthereumRevealBindings(): Pick<Env,
  'ETHEREUM_REVEAL' | 'ETHEREUM_REVEAL_VERIFIER' | 'ETHEREUM_REVEAL_PUBLISHER' | 'ETHEREUM_REVEAL_METADATA' | 'ETHEREUM_REVEAL_READ_RATE_LIMITER' | 'ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER' |
  'ETHEREUM_PROVIDER_BUDGET' | 'ETHEREUM_PUBLIC_READ_CACHE' | 'ETHEREUM_PUBLIC_READ_CACHE_ENABLED' | 'ETHEREUM_PROVIDER_CONTROL_ENABLED' | 'QUICKNODE_ETHEREUM_MAINNET_ENABLED' | 'QUICKNODE_ETHEREUM_MAINNET_RPC_URL' |
  'TAROT_CLAIM_RELAYER' | 'ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED' | 'ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED' |
  'ETHEREUM_TAROT_MAINNET_MAX_CLAIM_FEE_WEI' | 'ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI' |
  'ETHEREUM_TAROT_MAINNET_RELAYER_SECRET' | 'ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET'> {
  const unexpected = (): never => { throw new Error('Unexpected Ethereum reveal binding access in this test.'); };
  return {
    TAROT_CLAIM_RELAYER: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
    ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED: 'false',
    ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED: 'false',
    ETHEREUM_TAROT_MAINNET_MAX_CLAIM_FEE_WEI: '1500000000000000',
    ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI: '1500000000000000',
    ETHEREUM_TAROT_MAINNET_RELAYER_SECRET: '',
    ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET: '',
    ETHEREUM_PROVIDER_CONTROL_ENABLED: 'false',
    ETHEREUM_PUBLIC_READ_CACHE_ENABLED: 'false',
    QUICKNODE_ETHEREUM_MAINNET_ENABLED: 'false',
    QUICKNODE_ETHEREUM_MAINNET_RPC_URL: '',
    ETHEREUM_PROVIDER_BUDGET: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
    ETHEREUM_PUBLIC_READ_CACHE: { newUniqueId: unexpected, idFromName: unexpected, idFromString: unexpected,
      get: unexpected, getByName: unexpected, jurisdiction: unexpected },
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
