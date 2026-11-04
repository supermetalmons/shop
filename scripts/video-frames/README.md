# Reproducing the bamboo video frames

Rebuild all three variants from the repository root.

```sh
npm run render:video-frames
```

The command renders headlessly and writes 12 MP4s and a midpoint comparison sheet
to `output/video-frames/`. Each MP4 is 1440 × 1440 at 24 fps on white, with the
full landscape picture and original AAC audio.

| Comparison order | Folder | Camera | Frame |
| --- | --- | --- | --- |
| 1 | `01-front` | Straight on | Standard honey bamboo bezel |
| 2 | `03-wide-border` | 15° left, 8° above | Wider bezel in the same outer frame |
| 3 | `04-bamboo-block` | 18° left, 9° above | Thicker square-edged block with an even bezel on all sides |

`studio.py` builds the geometry, bamboo grain, lights, camera and shadow from
scratch. `encode.py` holds the screen projection and H.264 settings.
`render.py` pins the four source files by SHA-256 and fetches clips 1–4 from
`https://wip.lil.org/111k/videos/{id}.mp4` using curl. For offline rendering,
place matching copies named `1.mp4` through `4.mp4` in `.cache/video-frames/sources/`.
`verify.py` checks square pixels, every frame timestamp, audio, format and file
sizes. It compares each source midpoint with the picture at the reviewed screen
position for that variant before publication.

The reference setup used Blender 4.5.3 LTS (build `67807e1800cc`, Cycles
Metal on Apple M1 Max), Python 3.9.6, FFmpeg and ffprobe 8.1.2 with libx264
r3222, and rsvg-convert 2.62.3 on macOS 27.2. Set `BLENDER_BIN` if Blender
is outside its default macOS app path and not on PATH.

A clean replay on that host passed validation for all 12 clips. MP4 bytes
varied across renders. Every decoded frame measured at least 49.7 dB PSNR
against its reviewed export.
