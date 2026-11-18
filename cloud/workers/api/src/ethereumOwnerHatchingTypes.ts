import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import type { RevealCanonicalMetadata, RevealOriginUnit } from './ethereumRevealCatalogTypes.js';

export type OwnerHatchingCanonical = RevealCanonicalMetadata;
export type OwnerHatchingAsset = {
  category: Exclude<EthereumArtworkCategory, 'egg'>;
  assetId: number;
  attributesJson?: string;
};
export type OwnerHatchingHooks = {
  canonical(tokenId: string): OwnerHatchingCanonical | null;
  build(tokenId: string, asset: OwnerHatchingAsset, original: OwnerHatchingCanonical): {
    artwork: EthereumRevealedArtwork; metadataJson: string;
  };
  reservedAttributes?(batchId: string, asset: RevealOriginUnit): string | undefined;
  takeOrdinary(): { origin: RevealOriginUnit; effective: OwnerHatchingAsset } | null;
  originForToken(tokenId: string): RevealOriginUnit;
  transitionSlot(origin: RevealOriginUnit, before: RevealOriginUnit, after: RevealOriginUnit): void;
  releaseReplacement(origin: RevealOriginUnit, freshEggId: number): void;
  freshEggAvailable(eggId: number): boolean;
  eligibleEgg(tokenId: string, eggId: number): boolean;
};
export type OwnerHatchingBatchInput = {
  batchId: string;
  sourceSha256: string;
  candidateTokenIds: string[];
  readyCount: number;
  grails: OwnerHatchingAsset[];
  freshEggIds: number[];
};
export type OwnerHatchingBatchStatus = {
  batchId: string; sourceSha256: string; phase: 'publishing' | 'complete'; prepared: true;
  readyCount: number; grailCount: number; freshEggCount: number; ready: number; hatched: number;
  published: number; pendingPublication: number; conflicts: number; pendingEnrichment: number; failedEnrichment: number;
};
export type OwnerHatchingResult =
  | { kind: 'hatched'; artwork: EthereumRevealedArtwork }
  | { kind: 'unavailable' | 'not-ready' };
export type OwnerHatchingEnrichmentError = 'invalid' | 'source-unavailable' | 'enrichment-failed';
export type OwnerHatchingEnrichment = {
  tokenId: string; category: OwnerHatchingAsset['category']; assetId: number; metadataRevision: number;
  baseJson: string; attempts: number; lastError: OwnerHatchingEnrichmentError | null;
};
export type OwnerHatchingEnrichmentSummary = {
  pending: number; failed: number; completed: number; errors: Partial<Record<OwnerHatchingEnrichmentError, number>>;
};

export type OwnerHatchingBatchRow = {
  batch_id: string; source_sha256: string; input_sha256: string; ready_count: number; grail_count: number;
  fresh_egg_count: number; created_at_ms: number;
};
export type OwnerHatchingTokenRow = {
  token_id: string; batch_id: string; egg_id: number; original_json: string;
  grail_category: OwnerHatchingAsset['category'] | null; grail_asset_id: number | null;
  status: 'ready' | 'hatched'; canonical_json: string; metadata_revision: number; hatched_at_ms: number | null;
};
export type OwnerHatchingPublicationRow = {
  token_id: string; metadata_revision: number; status: 'pending' | 'published' | 'conflict';
  attempts: number; next_check_ms: number; claim_id: string | null;
};

export const OWNER_HATCHING_ENRICHMENT_CLAIM_MS = 60_000;
