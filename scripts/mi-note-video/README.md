# Native Mi Note videos

This renderer uses a dedicated AppKit/WKWebView application and the validated
native capture and processing recipe. Run it on
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

The current verified application supports foreground and offscreen capture:

```text
.cache/native-webview-background/MiNoteCapture.app/Contents/MacOS/MiNoteCapture
```

Its executable SHA-256 is
`e270a1def8c960e482401b12926dbbd1a857a2c559623cfeb5196468e8973b62`.
The source capture profile SHA-256 is
`0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0`.
The controller checks the verified application, runtime, and profile before a
render. A graphical macOS session and Screen Recording permission for the
capture application are required.

No command installs dependencies or rebuilds the application.
The build script defaults to this application directory.
A newly compiled binary is not automatically accepted by the
controller's executable and source hash checks.

## Commands

From the repository root:

```sh
npm run render:mi-note-videos -- help
npm run render:mi-note-videos -- doctor
```

`doctor` checks the preserved prerequisites without capturing a frame. The
launcher selects the pinned Node executable before loading the renderer.

Render one card into the shared video directory:

```sh
npm run render:mi-note-videos -- run --ids 49 --background
```

The default destination is `~/Movies/Mi Note Native Renders`. Completed videos
are named `1.mp4`, `2.mp4`, and so on, directly in that directory. New renders
join the same directory, and existing videos are never overwritten. Use
`--output /absolute/video-directory` only to choose another shared destination.
Run state and verification receipts stay under
`~/Library/Application Support/Mons Mi Note Render/native-runs`, keyed by the
output directory and exact ordered selection.
The initial manifest and run directory become available together, so an
interrupted first write does not block a new attempt.

`--background` captures entirely outside the display area without activating
the app or focusing its window.

This still uses a real offscreen window and requires the logged-in graphical
session and a display. It does not minimize or hide the WebView: the window
remains ordered in, and reports itself visible to WebKit so animation frames
continue. ScreenCaptureKit captures only that window. Each capture verifies that
the app is inactive, the window is not key or main, and its frame intersects no
display. The original dimensions, color handling, and quality checks apply.
One initial capture warms the offscreen surface before the two independent
starting captures; both starting captures and both ending controls must still
match exactly.
Use the same `--background` selection when resuming. `doctor --background`
verifies prerequisites without opening a window.

Select IDs explicitly with a comma-separated list or inclusive range, for
example `--ids 1,4-6` or `--ids 1-46`. There is no implicit collection render.
Other cards can already exist in the output directory. Commands stay attached
to the invoking terminal.

Resume an interrupted run with the same selection and directory:

```sh
npm run render:mi-note-videos -- resume --ids 49 --background
```

Resume requires matching source, application, runtime, selection, presentation,
recipe, and completed-video hashes. A verified publication receipt is saved
before a video becomes visible in the output directory, allowing resume to
recover publication interrupted before the completion record was saved.
Cross-volume copy temporaries are recorded before copying and removed on resume.
An unfinished card attempt is preserved before that
card is captured again. The video directory is never used for temporary frames.
Use `--retain-all` consistently on both commands when all native and prepared
frames are needed for a replay benchmark.

## Capture and evidence

A persistent ScreenCaptureKit stream captures the entire owned window without
scrolling or resizing. It requests Display P3 and preserves the ICC profile
attached to each captured pixel buffer. An incrementing pixel marker in the
discarded gutter verifies that the compositor has produced the requested frame.
Every capture checks dimensions, content scale, the full content rectangle, and
opaque alpha before removing alpha without changing RGB values.
If the compositor stalls, the stream requests a repaint of the same serial in
the discarded gutter every two seconds, for up to 30 seconds. It still requires
the exact requested marker before accepting a frame and records these refreshes
in the capture receipt.

The complete geometry scan warms every pose in the motion cycle. Two independent
starting captures must match exactly. After the sequence, two consecutive rest
captures must match that starting reference; up to eight attempts allow WebKit's
raster refinement to settle. Preparation and encoding stay in frame order while
two isolated workers perform the preserved image operations.

Each run writes `native-run.json` in its private state directory. Per-card
receipts retain geometry, source frame identities, quality reports, and the
full-decode certificate. After successful publication and receipt persistence,
default runs remove native/prepared PNGs, control images, and decoded YUV
samples. `--retain-all` keeps those intermediates privately. Failed attempts
retain their evidence for diagnosis. Generated videos and evidence belong
outside version control.

## Storage and checks

Application Support needs only `host/runtime` and `native-runs`. Keep the
complete pinned runtime intact. Native run receipts support verification and
resume; temporary images are removed after successful publication. Finished
videos stay together in `~/Movies/Mi Note Native Renders`.

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
