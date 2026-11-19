import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export const REVEAL_JSON_HTTP_METADATA = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } as const;

export function putRevealMetadataConditionally(bucket: Pick<R2Bucket, 'put'>, key: string, metadataJson: string, metadataRevision: number,
  identity: { deploymentId: string; tokenId: string }, previous: Pick<R2Object, 'etag' | 'customMetadata'> | null): Promise<R2Object | null> {
  return bucket.put(key, metadataJson, {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: REVEAL_JSON_HTTP_METADATA,
    customMetadata: { ...previous?.customMetadata, revealDeployment: identity.deploymentId, revealToken: identity.tokenId,
      revealMetadataRevision: String(metadataRevision),
      ...(previous?.customMetadata?.sha256 === undefined ? {} : { sha256: bytesToHex(sha256(metadataJson)) }) },
  });
}
