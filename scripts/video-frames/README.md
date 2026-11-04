# Reproducing the bamboo video frames

Render clips 10, 11, and 12 with both bamboo frames from the repository root.

```sh
npm run render:video-frames
```

Use the animated collection for clips 3, 27, and 102.

```sh
npm run render:video-frames -- --collection animated
```

Each run writes six 1440 × 1440 MP4s on white and a midpoint comparison sheet.
The original 16:9 clips retain their 24 fps timing and AAC audio in
`output/video-frames/`. The 932 × 1006 animated clips retain all 360 frames
at 60 fps and have no audio track. Their outputs go in `output/video-frames/animated/`.

| Comparison order | Folder | Camera | Frame |
| --- | --- | --- | --- |
| 1 | `01-wide-border` | 15° left, 8° above | Wide bamboo border |
| 2 | `02-front` | Straight on | Standard honey bamboo bezel |

`studio.py` sizes the screen opening and bamboo enclosure for each display
aspect ratio. Both presets keep their camera angles, depth, material and lights.
`encode.py` projects the complete source picture into the opening. For sRGB
animations it converts the bamboo plate from its approved BT.709 appearance
to sRGB before compositing. Both comparison sheets use sRGB.
`render.py` pins the source files by SHA-256 and fetches them from
`https://wip.lil.org/111k/{collection}/{id}.mp4` using curl. For offline rendering,
place matching copies named `{id}.mp4` in `.cache/video-frames/sources/` for
the videos collection or `.cache/video-frames/animated/sources/` for animated.
Before Blender starts, the renderer checks that both presets have reviewed
screen corners for every input aspect ratio. `verify.py` checks square pixels,
every frame timestamp, audio, format and file sizes. It compares each source
midpoint with the picture at the reviewed screen position before publication.

The reference setup used Blender 4.5.3 LTS (build `67807e1800cc`, Cycles
Metal on Apple M1 Max), Python 3.9.6, FFmpeg and ffprobe 8.1.2 with libx264
r3222, and rsvg-convert 2.62.3 on macOS 27.2. Set `BLENDER_BIN` if Blender
is outside its default macOS app path and not on PATH.

MP4 bytes can vary slightly between renders on the reference hardware.
