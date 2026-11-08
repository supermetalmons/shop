# White acrylic frames for 111k

Soft Clear (`08-soft-clear`) and High Key (`15-high-key`) each use a single
clear acrylic body, a white bezel and four silver fasteners. Both face the
camera squarely on a shadowless white background. The 16:9 screen sits inside
a 1440 × 1440 H.264 MP4.

## Render

Run from the repository root with Python 3, FFmpeg with libx264, and ffprobe.
Fetching uncached 111k sources also requires curl.
Knife rendering also requires macOS, Swift and Metal. The encoder reads the
approved plates directly from the repository.

```sh
npm run render:video-frames -- --ids 1,12
npm run render:video-frames -- --collection animated --ids 21 --variant 08-soft-clear
npm run render:knives -- --ids 904 --variant 15-high-key
npm run render:video-frames -- --input /path/to/clip.mp4 --output /path/to/export
npm run render:knives -- --input /path/to/knife.glb --output /path/to/export
```

For standalone knife animations, use `npm run render:knives -- --frameless --ids 904,6`.
This approved frameless option renders at 3840 × 2160 with 4× MSAA, downsamples
to 1920 × 1080 with Lanczos, and encodes silent H.264 MP4s at CRF 12 using the
slow preset. It preserves the graphite background, lighting and five-second,
60 fps motion. Files are named `<id>.mp4` in `output/video-frames/knives/frameless/`
by default. See the [knife model guide](knives/README.md) for local inputs and samples.
Framed rendering remains the default.

Both presets render by default. `--background white` is accepted for existing
commands. Category-local 111k IDs download from `https://cdn.lil.org/nft/111k/`.
Videos use `videos/{id}.mp4` and animated works use `animated/{id}.mp4`.
The CDN catalog contains video IDs 1–58, animated IDs 1–421 and knife IDs 1–3000.
Their caches are `.cache/video-frames/sources/cdn-lil-111k/` and
`.cache/video-frames/animated/sources/cdn-lil-111k/`, respectively. The CDN
cache directories keep earlier WIP downloads from being reused.
The [animated source checksums](animated-source-sha256.json) pin the first 102 CDN
MP4 sources independently of testnet release artifacts. Pinned video and
animation sources were fully decoded before recording their checksums. Other
numbered sources are validated before entering the cache.
Local inputs require an explicit output directory. With no selection, videos
use IDs 10–12, animated items use 3, 27 and 102, and knives use 1–4.

## Approved assets

Both npm commands accept `--verify` to check the two saved setups against
their SHA-256 manifest. Verification works without cached sources or sample
movies.

```sh
npm run render:video-frames -- --verify
```

Each [preset directory](acrylic/presets/) contains the original sRGB plate,
antialiased opening mask, projected screen corners, physical frame bounds,
and editable Blender scene. The [checksum manifest](acrylic/presets/checksums.json)
identifies the approved copies. To rebuild a scene for inspection, run the
[Blender recipe](acrylic/studio.py) headlessly into a separate directory:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 \
  --python scripts/video-frames/acrylic/studio.py -- /tmp/111k-acrylic-inspect --variant 08-soft-clear --save-blend
```

## Samples and playback

Use `npm run render:video-frames -- --samples` to generate 18 MP4s on demand
in `output/video-frames/acrylic/finalists/`. Source numbers stay stable when
filtering by collection or preset. Each item produces a pair, such as
`01-soft-clear-white.mp4` and `01-high-key-white.mp4`.

| Sample numbers | Collection | 111k IDs in filename order |
| --- | --- | --- |
| 01–04 | Videos | 8, 12, 34, 19 |
| 05–09 | Knives | 904, 906, 909, 942, 986 |

The four video samples preserve the exact bytes of the earlier WIP IDs
1, 371, 2222 and 2963, mapped to their current CDN IDs by SHA-256. The earlier
1112 sample has no matching CDN source and is omitted. If the default finalists
folder contains the earlier 20-file set, select a fresh `--output` directory;
the sample numbering has changed and existing generated files are left intact.

The compositor centers the complete source image using neutral dark bars when
needed. It checks playback timestamps, source audio, color transfer, file size,
screen placement and the white surround before publishing a batch. Local
clips should have one constant-rate SDR BT.709 or sRGB video stream starting
at zero, and at most one MP4-compatible audio stream. Knife models use a native
1920 × 1080 intermediate with one scale for all 300 poses. See the
[knife model guide](knives/README.md) for GLB compatibility.
