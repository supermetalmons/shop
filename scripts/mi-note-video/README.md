# Resumable Mi Note videos on host or VM

This tool captures native Safari pixels on the host Mac or inside an owned,
headless macOS VM. New jobs share one immutable catalog, source snapshot, and
completed-card ledger across both backends. Each backend retains its own runtime,
display calibration, and partial frames. One renderer runs at a time.

The approved full-catalog recipe is `upright-2160` with `breathing-swing` for all
1,430 cards. The VM remains the default backend; host rendering is an explicit
choice for periods when the host display is available.

## Approved rendering settings

| Profile | Native scene | Native captures per frame | Output |
| --- | --- | --- | --- |
| `sideways-1980` | 2970 × 2970 | One sideways viewport, restored upright by an integer transpose | 1980 × 1980 |
| `upright-2160` | 3240 × 3240 | Two upright vertical tiles with checked overlaps | 2160 × 2160 |

Both profiles use black without shadows, Display P3 SDR, HEVC Main 10 `hvc1`,
CRF 16, medium preset, 60 fps, and 276 frames over 4.6 seconds. Native pixels
receive one Lanczos reduction after relative-colorimetric ICC conversion.
The original 2000 × 2800 PNG fronts, processed masks, grain, foil opacity,
framing, and motion equations are preserved.

Choose `original` (Original full circle), `vertical-swing`, or `breathing-swing`.
The defaults are `sideways-1980` and `breathing-swing`.

The upright profile preserves the earlier two-capture technique, with the
selected black background and no shadow. It captures 3240 pixels independently;
it never enlarges the 1980 output. The renderer calculates tile positions from
the actual viewport and refuses a profile if its required tile count or guards
cannot be satisfied.

## Setup and prerequisites

The controller requires an Apple silicon Mac, Xcode Command Line Tools with
Swift 6, Python 3.9 or newer, the repository's Node dependencies, and
FFmpeg/FFprobe for collection. Native processing and image audits use the pinned
runtime of the selected backend.

The VM must already contain macOS with an unlocked automatic-login GUI account,
Remote Login, and Safari's remote automation permission. This tool adopts a
configured VM; it does not install macOS or create accounts. The preserved
rendering VM is already configured.

Host rendering requires an unlocked graphical session and enough display space
for the selected native viewport. It opens and activates its own Safari automation
window, keeps the host display awake, and validates viewport size, ICC, tile
overlap, and capture permissions during native preflight. Leave that window and
display available while rendering. Setup does not change global Safari settings
or enable permissions on the user's behalf.

Private state defaults to
`~/Library/Application Support/Mons Mi Note Render`. It stores the VM, private
access files, isolated host runtime, frozen source releases, outputs, logs, and
job controls outside the worktree. Put `--state /absolute/private/directory`
before the subcommand to use another state directory. Nothing in private state
is committed.

When the VM is already adopted:

```sh
npm run render:mi-note-videos -- status --backend vm
npm run render:mi-note-videos -- setup --backend vm
npm run render:mi-note-videos -- doctor --backend vm
npm run render:mi-note-videos -- prepare --backend vm
```

To prepare host rendering:

```sh
npm run render:mi-note-videos -- setup --backend host
npm run render:mi-note-videos -- doctor --backend host
npm run render:mi-note-videos -- prepare --backend host
npm run render:mi-note-videos -- status --backend host
```

`setup --backend host` provisions a private runtime using verified copies of the
configured VM's pinned Node/Python installation and the matching locally installed
FFmpeg/FFprobe with their non-system libraries. It may start the configured VM
for this initial copy. It performs no global install or upgrade, and subsequent
host renders use the private copy. Repeating setup verifies and reuses it.

`doctor` checks the selected runtime, account, and graphical session; the VM
variant also boots and verifies the owned VM. `prepare` freezes the current
source and installs renderer dependencies from its lockfile. Resume stages the
job's existing frozen source on the chosen backend instead of taking a new
snapshot. Setup, doctor, and prepare do not render videos.

To adopt another configured VM, supply its actual paths and existing pinned
SSH identity:

```sh
npm run render:mi-note-videos -- adopt \
  --vm /absolute/path/render.vbvm \
  --guest-user render \
  --password-file /absolute/private/guest-password \
  --known-hosts /absolute/private/known-hosts \
  --host-key-alias render-vm \
  --guest-root /Volumes/RenderData/MiNoteRender \
  --node /usr/local/bin/node \
  --python /Volumes/RenderData/runtime/python/bin/python3 \
  --ffmpeg /opt/homebrew/bin/ffmpeg \
  --ffprobe /opt/homebrew/bin/ffprobe \
  --move
```

Use `--move` only for an idle VM you intend this renderer to own. It moves the
whole bundle into private state while preserving its disks, machine identity,
and network identity. Without it, the VM stays at its supplied location.
Credentials are copied into a private directory with owner-only permissions;
the original files remain untouched. Passwords are never command-line values.
SSH ignores host configuration, agents, Keychain, forwarding, and unpinned keys.

The adopted VM uses four CPUs, 8 GiB memory, and a fixed 4480 × 2520 virtual
display at 218 pixels per inch. The launcher is built and ad-hoc signed from
the included Swift source and virtualization entitlement. Guest UID and home
directory are discovered rather than assumed.

Both backends require Node 24.22.0, Python 3.12.14, NumPy 2.3.5, Pillow 12.3.0,
LittleCMS 2.19, FFmpeg/FFprobe 8.1.2, and Safari 27.0.1
`22625.1.29.11.28`. Adoption verifies the guest's installed runtimes. Renderer JavaScript
dependencies have their own exact versions and lockfile. Preparation does not
copy the host's `node_modules` or environment files.

## Start a catalog job

Run from the repository root. Each job needs a unique lowercase name and an
explicit ID selection:

```sh
npm run render:mi-note-videos -- run --job selected-breathing --ids 312,904,1375

npm run render:mi-note-videos -- run --job selected-upright \
  --ids 312,904,1375 --profile upright-2160 --motion vertical-swing
```

These commands create version 2 catalog jobs. `--all` records the complete catalog
in the immutable job; rendering always requires `--ids` or `--all`. The existing
full-circle recipe remains available:

```sh
npm run render:mi-note-videos -- run --job full-original \
  --all --profile sideways-1980 --motion original
```

Start the approved full catalog with compact retention and background supervision:

```sh
npm run render:mi-note-videos -- run \
  --job mi-note-all-upright-2160-breathing --all \
  --backend vm --profile upright-2160 --motion breathing-swing \
  --retention receipt --background
```

The full catalog renders its own complete set; it does not import the comparison
renders for cards 166 and 1284. Those comparison outputs remain preserved.

`run` defaults to `--backend vm`, `--retention full`, and foreground supervision.
The profile and motion defaults remain `sideways-1980` and `breathing-swing`, so
specify `--profile upright-2160` for this approved recipe. Profile, motion,
selection, and retention are fixed when the job is created. Backend can change
on resume. Rendering source remains pinned unless an explicit, verified source
upgrade is recorded at an untouched card boundary.

To apply updated host job-control code to an existing stopped catalog, run
`resume JOB --refresh-controller --background` from the updated checkout. This
freezes a separate controller release and refreshes `control.command`. It keeps
the original native rendering source, recipe, completed outputs, and partial
frames unchanged, and rejects a changed rendering contract.

For a controlled performance upgrade, first run the updated controller against
the original rendering source and request a stop after the current card:

```sh
npm run render:mi-note-videos -- interrupt JOB --after-card
npm run render:mi-note-videos -- resume JOB --refresh-controller --background
```

The controller must be stopped before `--refresh-controller`; interrupt an older
running controller and wait for it to stop first. Its partial capture remains
available for the resumed execution. The boundary request can be saved while
the controller is stopped. It survives failures and is consumed only after the
already started cards have been verified and durably published, before another
execution is created. When saved before an idle resume, it finishes one card.
An already updated running controller also accepts `interrupt JOB
--after-card` without interrupting its current capture.

After the boundary stop and a complete equivalence comparison, run:

```sh
npm run render:mi-note-videos -- upgrade-source JOB \
  --from-id FIRST_UNPUBLISHED_CARD --evidence /absolute/path/equivalence.json
npm run render:mi-note-videos -- resume JOB --background
```

`upgrade-source` freezes the current checkout and requires the exact candidate
source ID tested by the evidence. The report uses version 1 and kind
`mi-note-performance-equivalence`, status `passed`, `baselineSourceId`,
`candidateSourceId`, `contractSha256`, the catalog's `profile` and `motion`, a
selected `cardId`, and `frames: 276`. It must contain true `nativePixelsExact`,
`preparedPixelsExact`, `iccExact`, and `videoBytesExact` flags, matching
`baselineVideoSha256` and `candidateVideoSha256`, and `nativeFrameHashes` plus
`preparedFrameHashes` arrays. Both arrays must cover frames 0 through 275 in
order, with matching SHA-256 values in each entry's `baseline` and `candidate`
fields.

The upgrade rejects changed artwork, CSS, motion, harness, presets, contract,
dependencies, or other rendering inputs outside the explicit performance and
controller file list. It also rejects any existing execution at or after the
boundary; finish and publish those original checkpoints first. The immutable
logical job and completed executions, receipts, and releases remain unchanged.
`job-meta.json` records each source boundary and a retained, hashed equivalence
report. Verification and collection continue using each card's original source.

Sources containing the version 1 `pipeline.json` capability use at most two
unfinished host cards. One card owns the Safari capture lease while the previous
card finishes processing and publication. The lease is released only after all
276 native checkpoints and exact final controls are saved, every owned Safari
process has exited, and a durable capture-completion record has been verified.
An execution ownership record remains until the host acknowledgment and cleanup
finish. The encoder has its own shared lock, so only one encoder runs at a time.
The VM and older frozen sources retain serial execution.

Within a card, warmups, controls, and frame zero remain sequential. Later frames
can capture their native viewport tiles while the preceding frame is stitched
and checked. At most two frames are unfinished, and checkpoints are committed in
order only after every existing pixel and ICC check passes. Recovery waits for
both operations before restarting the owned capture session. Preflight reuses
one Python worker for its unchanged image operations and checks.

Upright captures batch frame selection and scrolling into one browser action,
preserving both paint waits and the intermediate and final snapshot checks.
Preflight overlaps its fixed warmup and sample sequences with image processing,
with at most two unfinished captures. Adaptive calibration remains sequential,
and each sequence drains before the next phase or approval.

Streaming color preparation transforms the nonblack image bounds and reconstructs the
remaining canvas with the same ICC transform's black value before the unchanged
full-canvas Lanczos resize. Exterior checks still decode each saved PNG and
verify its geometry, ICC, and reference checksum. Steady output frames can use
their nonzero pixel bounds to prove an exactly black exterior. Warmups, controls,
and frame zero retain the original comparison and reference-cache initialization.
Preflight and standalone preparation retain the original full-canvas ICC path.
Other exterior-check cases retain the full comparison.

`active-executions.json` identifies both pipeline executions for interruption and
resume, including after a supervisor crash. The controller publishes cards in
catalog order and starts no new cards after a boundary-stop request. Immediate
interruption preserves every unfinished card. A fresh pipeline execution reuses
its independent audit's verified decode certificate instead of repeating the
complete post-render resume audit; actual recovery keeps the resume checks.

`--background` on `run` or `resume` starts an owned launchd supervisor with
keep-awake and persistent logs. It continues after the terminal or chat closes.
It does not automatically restart after failure, interruption, logout, or restart,
and does not install a login-starting service. Resume it explicitly.

VM samples suggested roughly 16 days for the complete catalog, before pauses.
That is a sample-based estimate, not a runtime guarantee; host speed must be
measured on its own completed renders.

## Interrupt, resume, and switch backends

```sh
npm run render:mi-note-videos -- status selected-breathing
npm run render:mi-note-videos -- interrupt selected-breathing
npm run render:mi-note-videos -- resume selected-breathing
```

Resume verifies the completed videos and their retained records before skipping
them, then continues the first unfinished card. Without `--backend`, it selects
the last saved backend. `status JOB` reports that saved backend; use `status
--backend host|vm` without a job to inspect a backend's availability.

To switch the full catalog to the host, request interruption and inspect status:

```sh
npm run render:mi-note-videos -- interrupt mi-note-all-upright-2160-breathing
npm run render:mi-note-videos -- status mi-note-all-upright-2160-breathing
```

Wait until status is `interrupted` and the prior renderer has stopped, then run:

```sh
npm run render:mi-note-videos -- resume mi-note-all-upright-2160-breathing \
  --backend host --background
```

Use the same interruption sequence before switching back with `--backend vm`.
The coordinator rejects a backend switch while the prior renderer is still active.
Ctrl-C in foreground supervision also requests graceful interruption. Wait for
interruption before shutting down the owned VM:

```sh
npm run render:mi-note-videos -- vm-stop
```

To express an inclusive starting ID:

```sh
npm run render:mi-note-videos -- resume mi-note-all-upright-2160-breathing \
  --backend host --from-id 400 --background
```

This is valid only after every selected ID below 400 is verified. It never skips
an earlier gap. ID 400 itself is skipped if already verified. For a selected-card
job, the ID must belong to its pinned selection. Ordinary resume needs no ID.

Each backend has separate partial checkpoints for each card. Returning to the
same backend reuses validated frames only when its runtime and paths still match.
Every capture session performs six warmup captures and fresh controls that must
match saved pixels and ICC exactly. Switching backends never combines frames: it
uses that backend's existing validated checkpoint, or starts the card afresh with
new calibration. The other backend's partial capture remains until the card is
complete; its superseded working files can be cleaned when that backend is next
used. VM resume automatically boots the VM when necessary.

If the supervising command ends unexpectedly, the guest preserves partial work
or waits for collection. Resume the same job. Initial dispatch, stale ownership,
incomplete files, and interrupted transfers have explicit recovery paths.

## Outputs, controls, and retention

New videos appear at
`~/Library/Application Support/Mons Mi Note Render/outputs/<job>/<id>.mp4`, or the
explicit `run --output` directory. Collection does not re-encode videos. The
shared catalog manifest lives beside the videos. Execution metadata, evidence,
receipts, and logs live under `jobs/<job>/executions/<backend>/<id>` in private
state; shared frozen source lives under `releases/<sourceId>`.

Each job also has a stable `jobs/<job>/control.command` that uses its frozen
source and works independently of the worktree:

```sh
"$HOME/Library/Application Support/Mons Mi Note Render/jobs/mi-note-all-upright-2160-breathing/control.command" status
"$HOME/Library/Application Support/Mons Mi Note Render/jobs/mi-note-all-upright-2160-breathing/control.command" interrupt
"$HOME/Library/Application Support/Mons Mi Note Render/jobs/mi-note-all-upright-2160-breathing/control.command" resume --backend host --from-id 400
```

The control script's `resume` action always uses background supervision. The
job's `host.log` records supervisor activity. `status` reports the output and
control paths, current backend/card, collected count, and supervisor state.

Manual collection remains available:

```sh
npm run render:mi-note-videos -- collect selected-breathing
```

Collection checks hashes, stream settings, complete decoding, source identity,
and the independent native-pixel/fidelity audit before acknowledging a card.
Matching files are verified; conflicting files are preserved and reported.
Collection FFmpeg paths can be selected with `MI_NOTE_FFMPEG` and
`MI_NOTE_FFPROBE`; native rendering uses the selected backend's pinned runtime.

`--retention full` is the default. It retains five native control frames, source
viewport captures, start/end controls, geometry, quality reports, source hashes,
and transfer records. The upright profile retains both source tiles per control.

`--retention receipt` retains each MP4, the original evidence inventory, the
audit report, a hashed receipt, and the shared frozen source release. The receipt
binds the card, recipe, video, source, and originating execution/runtime to its
passed audits. Full native evidence is verified first; the receipt and publication
manifest are persisted before acknowledgment. Cleanup begins only after matching
completion confirms that acknowledgment, and a recoverable cleanup transaction
removes completed native evidence. Failed or unacknowledged cards keep full
checkpoints. Resume verifies the retained video, receipt, inventory, audit, and
source records; missing or corrupted records stop the job. Completed native
pixels cannot be independently re-audited after compaction without rerendering.

Receipt retention projects to approximately 12 GiB for the completed catalog,
plus runtimes and temporary working space. Before starting a native card, the
controller uses macOS available capacity for important usage, including reclaimable
space, with a 5 GiB reserve plus 12 GiB working headroom. It falls back to immediate
free space if that capacity query is unavailable;
the existing 12 GiB guest capacity check also applies to VM rendering. Collection
keeps the host reserve and pauses safely when space is insufficient. Free space
and resume the job manually.

Keep outputs, job records, receipts or full evidence, and frozen source releases
while expecting a job to resume. Preserve the chosen backend's configuration and
runtime as well. Jobs become complete only when their full pinned selection is
verified.

## Existing VM jobs

Existing version 1 jobs retain their identities, full evidence, and original
output locations, including `renderer-samples/mi-note-video/<job>/<id>.mp4` and
earlier explicit output paths. Their original controls still work:

```sh
npm run render:mi-note-videos -- status existing-vm-job
npm run render:mi-note-videos -- interrupt existing-vm-job
npm run render:mi-note-videos -- resume existing-vm-job
npm run render:mi-note-videos -- collect existing-vm-job
```

Version 1 resume remains VM-only and does not accept `--backend host`,
`--background`, or `--from-id`. Create a new catalog job to use these features;
comparison renders and legacy records are not migrated or replaced.

## Validation

Run offline backend, orchestration, motion, geometry, and recovery tests:

```sh
npm run test:mi-note-videos
```

To additionally run pixel-processing tests with a local Python containing the
pinned requirements:

```sh
npm run test:mi-note-videos -- --python /absolute/path/to/python3
```

The bounded native validation command runs all six profile/motion combinations,
captures representative poses, encodes five-frame probes, restarts the VM, and
requires fresh exact controls. It never renders a full-length video or starts
a collection, and stops the VM afterward:

```sh
python3 scripts/mi-note-video/validate.py
```

Its report is saved in private state under `validation/`. A failed check retains
its evidence and logs. Production rendering still runs its own preflight for
each card; a successful smoke test does not bypass those checks.
