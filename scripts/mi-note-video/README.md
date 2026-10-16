# Mi Note videos in a standalone macOS VM

This tool captures native Safari pixels inside an owned, headless macOS VM.
The host's Safari is never used. It supports the complete Mi Note catalog,
selected card IDs, interruption, restart, verified host collection, and bounded
guest storage.

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

## Host and guest setup

The host requires an Apple silicon Mac, Xcode Command Line Tools with Swift 6,
Python 3.9 or newer, the repository's Node dependencies, and FFmpeg/FFprobe.
The controller uses Python's standard library. Native processing and the
independent image audit run with the pinned Python installation in the guest.

The VM must already contain macOS with an unlocked automatic-login GUI account,
Remote Login, and Safari's remote automation permission. This tool adopts a
configured VM; it does not install macOS or create accounts. The preserved
rendering VM is already configured.

Private state defaults to the current user's
`~/Library/Application Support/Mons Mi Note Render`. It contains the VM,
private access files, launcher binary, prepared source snapshots, job records,
and retained evidence. `--state /absolute/private/directory` selects another
state directory. Nothing in this directory is committed.

When the VM is already adopted:

```sh
npm run render:mi-note-videos -- status
npm run render:mi-note-videos -- doctor
npm run render:mi-note-videos -- prepare
```

`doctor` boots the owned VM and checks its identity, GUI session, and runtimes.
`prepare` stages a complete hashed source snapshot and installs the isolated
renderer dependencies from its lockfile. Neither command captures a video.

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

The proven runtime is Node 24.22.0, Python 3.12.14, NumPy 2.3.5, Pillow 12.3.0,
LittleCMS 2.19, FFmpeg/FFprobe 8.1.2, and Safari 27.0.1
`22625.1.29.11.28`. Adoption verifies the guest's installed runtimes; no Codex
runtime installation or other repository is required. Renderer JavaScript
dependencies have their own exact versions and lockfile. Preparation does not
copy the host's `node_modules` or environment files.

## Start and resume a job

Run from the repository root. Each job needs a unique lowercase name and an
explicit ID selection:

```sh
npm run render:mi-note-videos -- run --job selected-breathing --ids 312,904,1375

npm run render:mi-note-videos -- run --job selected-upright \
  --ids 312,904,1375 --profile upright-2160 --motion vertical-swing
```

For a future full collection, `--all` records the current complete catalog in
the immutable job. It is never selected implicitly:

```sh
npm run render:mi-note-videos -- run --job full-original \
  --all --profile sideways-1980 --motion original
```

The command supervises collection while the guest renders one card at a time.
Keep the host awake. Each job pins its source snapshot, catalog, motion, profile,
runtime, references, native ICC, and capture geometry. Changing these requires
a new job, not a changed resume command.

```sh
npm run render:mi-note-videos -- status selected-breathing
npm run render:mi-note-videos -- interrupt selected-breathing
npm run render:mi-note-videos -- resume selected-breathing
```

Ctrl-C also requests a graceful interruption. Wait for `interrupted` status
before shutting down the VM:

```sh
npm run render:mi-note-videos -- vm-stop
```

Resume automatically boots the VM if needed. It verifies already-published host
artifacts before skipping completed cards, and checks partial native frames
before continuing. Every capture session performs six actual warmup captures;
fresh starting controls must match the original pixels and ICC exactly.
Advancing DOM poses alone is insufficient to restore Safari's compositing state.

If the supervising command ends unexpectedly, the guest preserves partial work
or waits for collection. Resume the same job. Initial dispatch, stale ownership,
incomplete files, and interrupted transfers have explicit recovery paths.

## Outputs and retained evidence

Videos appear under `renderer-samples/mi-note-video/<job>/<id>.mp4`, or the
explicit `run --output` directory. Collection does not re-encode them.

```sh
npm run render:mi-note-videos -- collect selected-breathing
```

Collection checks hashes, stream settings, complete decoding, source identity,
and the independent native-pixel/fidelity audit. Existing matching files are
verified; conflicting files are preserved and reported. Publication and
acknowledgment are atomic. Host FFmpeg paths can be selected with
`MI_NOTE_FFMPEG` and `MI_NOTE_FFPROBE`.

After each card is verified, the host acknowledges its exact video and evidence
identity. Only then may the guest discard that card's working files and proceed.
The host retains five native control frames, their source viewport captures,
start/end controls, geometry, quality reports, source hashes, and transfer
receipts. The upright profile retains both source tiles for each control.
Evidence lives in private state under `jobs/<job>/evidence`; small completion
records remain in the guest. A new resume attempt requires fresh host verification
before those records authorize skipping cards.

Do not remove a job's host outputs or evidence while expecting it to resume.
The VM, private configuration, guest runtimes, and prepared source release must
also remain available. The guest pauses rather than accumulating an entire
collection when the host cannot collect.

## Validation

Run offline orchestration, motion, geometry, and recovery tests:

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
