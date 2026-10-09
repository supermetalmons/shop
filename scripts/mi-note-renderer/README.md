# Mi Note native Safari renderer

This toolkit captures the complete collection, IDs 1–1430, as transparent
2000 × 2800 PNGs. It uses native Safari viewport compositor screenshots,
paired white/black mattes, and integer tile reconstruction. The final PNGs
retain the screenshot ICC profile. The gallery, thumbnails, and contact sheets
use sRGB; the adjacent ZIP contains the finished collection.

The preset comes from the successful Safari 27.0.1
`22625.1.29.11.28` calibration. It is tied to a 1280 × 1000 browser window,
a 1024 × 686 CSS viewport at DPR 2.5, and 2560 × 1716 screenshot tiles.
Two vertical tiles use pixel origins −64 and 1156 with a 488 CSS-pixel bottom
scroll. Capture geometry is checked before reconstruction. A different browser,
display scale, toolbar configuration, or screenshot profile can fail these checks;
changing numeric constants alone is not a new calibration.
On a 2× Retina display, Safari page zoom at 125% normally produces DPR 2.5;
the exact viewport and DPR checks remain authoritative. The capture URL uses
`localhost`, matching the original calibration host, because another hostname
can have a different saved Safari site zoom preference.

## Setup

Use macOS with native `/usr/bin/safaridriver --mcp`, Node.js 22.15 or newer,
the npm version pinned in the root `package.json`, and Python 3.11 or newer.
Node 22.23.1 and Python 3.12.14 are the tested runtimes. Install the root JavaScript dependencies
and create a Python environment inside the ignored cache directory:

```bash
npm ci
python3 -m venv .cache/mi-note-renderer-venv
.cache/mi-note-renderer-venv/bin/python -m pip install -r scripts/mi-note-renderer/requirements.txt
export MI_NOTE_RENDER_PYTHON="$PWD/.cache/mi-note-renderer-venv/bin/python"
```

The CLI checks Python before starting work and requires exactly Pillow 12.3.0
and NumPy 2.3.5. It records Node, Python, Pillow, NumPy, and Vite versions in the
run configuration. Keep the same dependencies when resuming.

In Safari 27, open **Develop → Developer Settings…** and record the current
value of **Allow remote automation and external agents**. Enable it manually
if required; Safari may request Touch ID. Restore its previous value manually
after the run. The toolkit does not toggle Safari permissions, run
`safaridriver --enable`, or change global browser preferences.

Allow substantial free disk space for the PNGs, raw capture evidence, and ZIP.
The run checks a 10 GiB free-space reserve, which is a minimum safety margin,
not an estimate of the complete collection size. Keep the calibrated display
and browser geometry stable during capture.

## Full collection workflow

Run from the repository root. A new run requires empty or nonexistent output
and cache directories and no preexisting adjacent ZIP:

```bash
npm run render:mi-note-cards -- \
  --output renderer-samples/mi-note-native \
  --cache .cache/mi-note-native-run
```

This verifies all 4,290 CDN assets, starts an owned Vite server bound to
`127.0.0.1:5174` with a strict port, captures the full collection, and publishes
only after capture completes. Safari opens `http://localhost:5174`. A port conflict is an error; choose an unused
port with `--vite-port`. Safari is accessed directly through its native stdio
MCP driver. No external HTTP automation bridge is needed.

If `--cache` is omitted, it defaults to
`.cache/mi-note-renderer/<hash-of-absolute-output-path>`. `--python` overrides
`MI_NOTE_RENDER_PYTHON`, which otherwise falls back to `python3`.
Within the repository, both generated directories must be below `.cache/` or
`renderer-samples/`. Explicit directories outside the repository are supported.
Source directories, overlapping output/cache paths, and paths that contain the
repository are rejected, including aliases through symbolic links.
Capture and publication hold an exclusive cache lock; a lock left by a dead
process is recovered automatically when resuming.

For a startup rehearsal, stop after the calibrated startup checks:

```bash
npm run render:mi-note-cards -- \
  --output renderer-samples/mi-note-native \
  --cache .cache/mi-note-native-run \
  --stop-after-startup
```

Continue using the same paths:

```bash
npm run render:mi-note-cards -- \
  --output renderer-samples/mi-note-native \
  --cache .cache/mi-note-native-run \
  --resume
```

`--stop-after N` stops when the total completed-card count reaches N, including
cards already completed before a resume. Planned stops leave a resumable run and
skip publication while the collection is incomplete. At 1,430 completed cards,
the run continues through final validation and publication. The command always targets
the entire fixed collection; there is no arbitrary card-ID or alternate-preset
mode. Interrupting capture requests a graceful stop, allowing active work to
settle before the checkpoint and cleanup are finalized.

Resume requires the matching `run-config.json` and `checkpoint.json` in the
selected cache. The output/cache bindings, source hashes, runtime, CDN asset
fingerprint, capture profile, and completed artifacts are checked. Invalid
completed artifacts are quarantined for recapture. Drift in the recorded inputs
requires a new output/cache pair. A failure before the first run configuration
and checkpoint exist cannot be resumed; keep its diagnostics and start with
fresh directories after correcting the cause.

The capture owns its Safari tabs, native driver process, sleep-prevention
process, and Vite server. Cleanup closes resources created by this run. It does
not quit the user's Safari application or restore permissions on their behalf.

## Publish an already captured run

Publishing revalidates the existing collection and creates the gallery, contact
sheets, manifests, validation report, and adjacent ZIP:

```bash
npm run render:mi-note-cards -- \
  --output renderer-samples/mi-note-native \
  --cache .cache/mi-note-native-run \
  --publish-only
```

This path does not start Safari, Vite, or CDN preflight. It requires the same
bound output/cache paths and a complete valid capture. Publication operates on
local files and can run without Safari. Keep historical finished collections
and their original caches intact; a new capture is a separate output/cache pair.

## Image and recovery constraints

The fixed pose is centered, has no rotation or shadow, and uses opacity 0.99.
Final output uses geometry-driven integer crops and hard tile stitching. It
does not resize, shift pixels, blend seams, adjust contrast, or convert the final
PNG's color profile. Rounded corners come from the renderer's original geometry;
alpha is recovered from the white/black mattes and checked by recomposition.
The original native ICC bytes are preserved in full-resolution PNGs.

Startup, periodic, and final repeat controls detect unstable capture. Pair
readiness retries allow transient paints to settle; recovery must still satisfy
the same geometry, profile, repeatability, and per-card QA gates. A failed gate
is evidence to investigate, not a reason to loosen tolerances or silently change
the calibration. Raw evidence and checkpoints stay in the ignored cache.

The fixed document height is 2936 physical pixels. Its extra bottom padding
makes the bottom scroll integer-aligned, leaving a 64-pixel top gutter and a
72-pixel bottom gutter. Stitching uses a 64-pixel edge guard and a hard seam at
row 1404. The seam band must have mean channel error at most 0.01, maximum error
at most 6, 99.9th-percentile error at most 1, and zero alpha difference. Matte
recomposition tolerance is 2 channel levels; the interior must be opaque and
the four corners transparent.

Capture uses one Safari producer, at most two finalization workers, and at most
four uncommitted cards. A matte pair gets at most five paint-readiness attempts;
a card or control gets at most three whole captures before stopping. The 20
control IDs are captured at startup and repeated at completion. Card 460 is
repeated immediately and every 100 completed cards; resume repeats every
available control before continuing. Source assets are checked again before
the completed run is published.

Run the offline toolkit tests without starting Safari or capturing cards:

```bash
npm run test:mi-note-renderer
```

Use `npm run render:mi-note-cards -- --help` for the complete CLI flag list.
