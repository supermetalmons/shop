# Legacy authentication provider retirement — historical record

The repository recorded the retired Google Cloud project's deletion request on
August 26, 2026, without a database archive. Its recorded recovery deadline was
September 25, 2026. These are historical records, not a fresh query of the provider.
The complete pre-cleanup documentation remains in commit
`abb1e8b84fadae8d59af363e6b4a8117343f2dba`.

The permanent retirement marker remains in Ops D1. Current identity, profiles,
commerce, addresses, and wallet sessions use Cloudflare D1. Runtime requests reject
old provider ID tokens without external certificate lookup; the application no
longer manages or deploys the retired project.

See [authentication and access](../../scripts/docs/app_auth.md) for current behavior.
