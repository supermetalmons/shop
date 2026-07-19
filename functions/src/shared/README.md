# Shared domain core

This directory is the canonical home for code and data used by both the
frontend and Cloud Functions.

## Boundary rules

- Keep modules runtime-neutral: no Firebase, Node-only, DOM, React, Solana SDK,
  secret, or environment-variable dependencies.
- Put pure calculations, serialized API contracts, codecs, normalization,
  deployment data, and shared presentation data here.
- Import individual modules directly. Do not add a barrel that could pull
  server-only dependencies into the browser bundle.
- Keep legacy frontend or Functions modules as thin compatibility facades when
  existing imports are part of the project surface.
- Convert runtime-specific values at the edge. For example, shared codecs
  return bytes; frontend and server adapters may convert those bytes to
  `PublicKey` or `Buffer`.
- Model intentionally different policies with options or edge adapters instead
  of forking the shared implementation.

The directory lives under `functions/src` so the Firebase Functions compiler
and deployment package include it naturally. The root TypeScript and Vite
builds also compile the same source files directly.
