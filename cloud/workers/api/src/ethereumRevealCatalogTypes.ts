import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import type { RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';

export type RevealOriginUnit = { category: EthereumArtworkCategory; assetId: number };
export type RevealArtworkReadOptions = { includeCollectionBlock?: boolean };
export type RevealEffectiveUnit = RevealOriginUnit & { assignmentRevision: number };
export type RevealPool = { category: EthereumArtworkCategory; total: number; seeded: number; available: number };
export type RevealCatalogMetadataStage = RevealOriginUnit & { attributesJson: string; sha256: string };
export type RevealCanonicalMetadata = {
  tokenId: string; category: EthereumArtworkCategory; assetId: number; assignmentRevision: number; metadataRevision: number;
  artwork: EthereumRevealedArtwork; metadataJson: string; targetSha256: string; expectedJsons: string[]; allowMissing: boolean; migration: boolean;
};
export type RevealCatalogUpdatePublication = RevealCanonicalMetadata & { eggId: number };
export type RevealCatalogUpdateStatus = {
  batchId: string; batchSha256: string; predecessor: RevealAssetCatalogDescriptor; target: RevealAssetCatalogDescriptor;
  sourceRevision: number; targetRevision: number; startedAtMs: number; activatedAtMs: number | null;
  phase: 'mapping' | 'staging' | 'ready' | 'active' | 'complete' | 'cancelled';
  total: number; mapped: number; metadataStaged: number; generationSeeded: number; frozen: number; published: number; retrying: number; conflicts: number;
  mode?: 'empty-rebuild'; categoryCounts?: Record<EthereumArtworkCategory, number>;
};
export type RevealCatalogOperation = {
  batch_id: string; batch_sha256: string; predecessor_json: string; target_json: string; target_manifest_json: string;
  source_revision: number; target_revision: number; mapping_count: number; mapping_sha256: string; phase: RevealCatalogUpdateStatus['phase'];
  started_at_ms: number; activated_at_ms: number | null; seeded: number; frozen_count: number; mode?: 'online' | 'empty-rebuild';
  batch_version: number; egg_cutoff: number | null;
};
export type RevealCatalogMappingRow = { batch_id: string; egg_id: number; category: EthereumArtworkCategory; asset_id: number;
  attributes_json: string | null; attributes_sha256: string | null; origin_category: EthereumArtworkCategory | null; origin_asset_id: number | null };
export type RevealCatalogAssignmentRow = { category: EthereumArtworkCategory; asset_id: number; token_id: string; crate_token_id: string;
  artwork_json: string; metadata_json: string; placeholder_json: string; frozen_at_ms: number; assignment_revision: number };
export type RevealCanonicalMappingRow = RevealCatalogMappingRow & { target_revision: number };
