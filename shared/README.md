# Shared domain core

This directory is the canonical home for code and data used by the frontend,
Cloudflare Worker, and repository tools.

## Boundary rules

- Keep modules runtime-neutral: no retired-provider SDKs, Node-only, DOM, React, Solana SDK,
  secret, or environment-variable dependencies.
- Put pure calculations, serialized API contracts, codecs, normalization,
  deployment data, and shared presentation data here.
- Import individual modules directly. Do not add a barrel that could pull
  server-only dependencies into the browser bundle.
- Convert runtime-specific values at the edge. For example, shared codecs
  return bytes; frontend and server adapters may convert those bytes to
  `PublicKey` or `Buffer`.
- Model intentionally different policies with options or edge adapters instead
  of forking the shared implementation.

The directory lives at the repository root so every consumer imports the same
canonical implementation directly.
