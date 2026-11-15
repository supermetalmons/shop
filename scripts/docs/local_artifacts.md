# Local artifacts and private evidence

New private operation evidence belongs in `.operations/`, outside disposable
build caches. Initialize it with `npm run artifacts -- init`; the directory must
have mode `0700` and is ignored by Git. Keep signing keys in their existing
external keystores.

Worker transactions, preorder collection deployments, two-config deployments,
and Stripe chargeback checkpoints also select evidence locations per operation.
New journals use the corresponding directory under `.operations`; an existing
journal under `.cache` is resumed in place. Unrelated older operations do not
change the destination of new work. If the same operation exists in both roots,
the command stops and preserves both copies for reconciliation. Inspection does
not create directories. Stripe dry-run scans still save their separate progress
checkpoints when a page completes.

Worker target locks and preorder collection locks are acquired under both roots
so older commands cannot bypass an active operation. Worker cleanup discovery
checks both roots before admitting new work. These temporary locks do not move
or duplicate journal evidence.

New Sepolia release preparations default to
`.operations/111k-<deployment-id>-release/contract`. The containing release
directory can retain its publication and recovery evidence. Release runners also
accept explicit private directories. Release-location indexes use
`.operations/111k-release-locations` for new installations; an existing index in
`.cache/111k-release-locations` remains readable. Only one index directory may
exist. With all release operations stopped, the whole index directory can be
renamed into `.operations` without changing its records or the release paths.

Existing frozen release trees remain at their original locations. In particular,
`.cache/111k-mainnet-v1-release`, `.cache/111k-v17-release`, and their required
metadata publications contain retained evidence, not disposable cache data.
Signed journals, snapshots, frozen manifests, publication ownership, and original
revision bindings remain unchanged. Some journals bind absolute paths; moving
their files or rewriting those paths can break recovery. Resume each operation
against its recorded location. Superseded testnet releases are removed only by
the [scoped retirement procedure](111k_reveal_ops.md#superseded-testnet-retirement).

## Cache cleanup

`scripts/shared/localArtifacts.ts` is the reviewed local artifact manifest. It
lists the exact CDN source-cache directories, filename patterns, supported ID
bounds, and regeneration commands. Unknown files are retained. Release metadata,
transaction evidence, arbitrary `.cache` contents, local artwork inputs, render
outputs, and approved renderer presets are outside this cleanup.

Stop rendering jobs before cleaning their source caches. Inspect the plan first:

```sh
npm run clean:cache
npm run clean:cache -- --only video-sources,animation-sources
```

Remove the selected downloads with:

```sh
npm run clean:cache -- --only video-sources,animation-sources --write
```

Omitting `--only` selects all cache groups in the manifest. `--write` is required
to delete files. The command rechecks the file inventory and identities before
deletion, rejects symlinked roots, preserves symlinked contents, and removes only
the listed regular files. Empty cache directories are retained. The next render
downloads the selected sources again and applies its existing validation.

The old knife cache at `.cache/video-frames/knives/sources/<id>.glb` has different
provenance from `sources/cdn-lil-111k/<id>.glb` and is retained. Numeric filenames
outside the manifest's supported bounds are also retained; update the manifest
deliberately when the corresponding renderer gains support for more IDs.
