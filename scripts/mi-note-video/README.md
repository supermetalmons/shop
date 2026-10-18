# Native Mi Note videos

This renderer uses the dedicated AppKit/WKWebView application and the capture
and processing recipe preserved with the approved 46-video review. Run it on
the physical host Mac with the existing pinned runtime and application.

| Setting | Preserved value |
| --- | --- |
| Motion | `breathing-swing` |
| Scene | Upright, black background, no shadow |
| Window backing | 3304 × 3304 pixels at device scale 2 |
| Captured scene | 3240 × 3240 pixels, excluding the 32-pixel gutter |
| Delivered video | 2160 × 2160 pixels, one Lanczos reduction |
| Color | SDR Display P3, embedded source ICC verified |
| Encoding | HEVC Main 10 / `hvc1`, `yuv420p10le`, CRF 16, medium preset |
| Timing | 276 frames at 60 fps, 4.6 seconds |
| Preparation | Two workers, three-frame capacity, ordered encoding |

The native PNG capture and preparation path retains the established 8-bit RGB
behavior. Main 10 describes the delivery codec; it is not a claim of additional
source precision. The approved image operations, foil effects, color handling,
and encoder settings remain unchanged.

## Prerequisites

The preserved host runtime lives at:

```text
~/Library/Application Support/Mons Mi Note Render/host/runtime
```

It contains Node 24.22.0, Python 3.12.14, NumPy 2.3.5, Pillow 12.3.0,
LittleCMS 2.19, and FFmpeg/FFprobe 8.1.2. Keep the complete runtime, its shared
libraries, and `runtime.json`. JavaScript dependencies use this directory's
unchanged `package.json` and `package-lock.json`.

The approved application is:

```text
.cache/native-webview/MiNoteCapture.app/Contents/MacOS/MiNoteCapture
```

Its executable SHA-256 is
`7c24ee9d7d04b619424639f93a8ba5314dec7f8a80dc02ac5e55909c8049d529`.
The source capture profile SHA-256 is
`0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0`.
The controller checks the approved application, runtime, and profile before a
render. A graphical macOS session and Screen Recording permission for the
capture application are required.

No command installs dependencies, provisions a VM, or rebuilds the application.
The build script remains available for deliberate development work, but a newly
compiled binary is not automatically accepted as the approved application.

## Commands

From the repository root:

```sh
npm run render:mi-note-videos -- help
npm run render:mi-note-videos -- doctor
```

`doctor` checks the preserved prerequisites without capturing a frame. The
launcher selects the pinned Node executable before loading the renderer.

Render one card into a new directory:

```sh
npm run render:mi-note-videos -- run --ids 17 \
  --output "$HOME/Movies/Mi Note Native Card 17"
```

Select IDs explicitly with a comma-separated list or inclusive range, for
example `--ids 1,4-6` or `--ids 1-46`. There is no implicit collection render.
The output directory must be new or empty. Runs stay in the foreground.

Resume an interrupted run with the same selection and directory:

```sh
npm run render:mi-note-videos -- resume --ids 17 \
  --output "$HOME/Movies/Mi Note Native Card 17"
```

Resume requires matching source, application, runtime, selection, recipe, and
completed-video hashes. An unfinished card attempt is preserved before that
card is captured again. Use `--retain-all` consistently on both commands when
all native and prepared frames are needed for a replay benchmark.

## Capture and evidence

A persistent ScreenCaptureKit stream captures the entire owned window without
scrolling or resizing. It requests Display P3 and preserves the ICC profile
attached to each captured pixel buffer. An incrementing pixel marker in the
discarded gutter verifies that the compositor has produced the requested frame.
Every capture checks dimensions, content scale, the full content rectangle, and
opaque alpha before removing alpha without changing RGB values.

The complete geometry scan warms every pose in the motion cycle. Two independent
starting captures must match exactly. After the sequence, two consecutive rest
captures must match that starting reference; up to eight attempts allow WebKit's
raster refinement to settle. Preparation and encoding stay in frame order while
two isolated workers perform the preserved image operations.

Each run writes `native-run.json`. Per-card evidence includes geometry, source
frame identities, quality reports, full-decode certificates, and native/prepared
controls at frames 0, 69, 138, 207, and 275. `--retain-all` keeps the full sequence.
Generated videos and evidence belong outside version control.

## Preserved reference and regression checks

The approved review remains at:

```text
~/Movies/Mi Note Native Review 2026-10-18
```

Preserve that folder in full: its 46 videos, source snapshot, compiled
application, manifests, comparisons, and historical evidence. Its version-1
manifest is an immutable reference and is not resumed by the current controller.
New runs use their own output directories and version-2 manifests.

The cleanup regression uses the retained 276-frame native canary for processing
replay, followed by one fresh card-17 render. Compare prepared pixels, motion and
cycle controls, decode certificates, and the established color/detail metrics.
A fresh capture is checked against the reference; it is not assumed byte-equal
to a separate historical capture.

Run the retained JavaScript and Python suites with:

```sh
npm run test:mi-note-videos
```

The runner uses the preserved Node, Python, FFmpeg, and FFprobe executables by
default, checks the pinned Python/media versions, and runs every retained suite.
Missing prerequisites, failed tests, or skipped Python tests fail the command.
`PYTHON` does not silently select a reduced suite. For an explicit Python
executable with the same pinned package versions:

```sh
npm run test:mi-note-videos -- --python /absolute/path/to/python3.12
```

These tests cover image preparation, worker ordering and failure handling,
geometry, motion, color comparison, and video validation. They do not launch a
collection capture.
