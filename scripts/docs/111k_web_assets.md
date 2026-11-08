# 111K Web Assets

The `image` URL in revealed 111K NFT metadata identifies the artwork's original
image and lets an application construct its published web images, alternate
views and playable media. All artwork assets below use the base URL
`https://cdn.lil.org/nft/111k/`.

## Derive paths from metadata

Read the family directory and numeric filename stem from `metadata.image`.
For `https://cdn.lil.org/nft/111k/paintings/1.png`, the family is `paintings` and
the asset ID is `1`. Keep that ID unchanged when constructing companion URLs.
It is local to the family and independent of the NFT token ID, metadata
filename and `name` field. IDs are positive decimal integers without leading
zeroes.

Use the original image path as the starting point. Videos use a `.webp` image;
the other four families use `.png`. The family directory determines which
companions are available.

## Published assets

Paths in this table are relative to the base URL. Paths in the last column are
relative to the corresponding family directory.

| Family | Standard metadata image | Standard image variants | Other published companions |
| --- | --- | --- | --- |
| Eggs | `eggs/{id}.png` | None | `{id}.webp` |
| Paintings | `paintings/{id}.png` | All four | `alt/{id}.webp` |
| 3D | `3d/{id}.png` | All four | `{id}.glb` |
| Animated | `animated/{id}.png` | All four | `{id}.mp4`, `mid/{id}.mp4` |
| Videos | `videos/{id}.webp` | All four | `{id}.mp4` |

For paintings, 3D, animated works and videos, insert the following directories
between the family and filename, and use the `.webp` extension:

| Variant | Path relative to the base URL | Maximum width |
| --- | --- | ---: |
| Mid | `{family}/mid/{id}.webp` | 1320px |
| Thumbnail | `{family}/thumbs/{id}.webp` | 420px |
| Small thumbnail | `{family}/thumbs/260/{id}.webp` | 260px |
| Smallest thumbnail | `{family}/thumbs/140/{id}.webp` | 140px |

These sizes are width caps. Images preserve aspect ratio and never upscale;
heights vary, and a source narrower than the cap keeps its original dimensions.
For example, painting 1 has a 1320 × 1425 mid image and a 420 × 453 thumbnail.
3D previews preserve transparency. Video WebPs are static first-frame posters;
the root WebP retains the original displayed dimensions.

Eggs have a root WebP companion at `eggs/{id}.webp`, with the same 1024 × 1024
dimensions as the PNG. They have no published `mid`, `thumbs` or `alt` paths.

Only paintings have `alt/{id}.webp` images. These alternative views have their
own dimensions and may contain transparency. Read their intrinsic dimensions
when displaying them; the original image's aspect ratio need not match.

Animated works have both `mid/{id}.webp` and `mid/{id}.mp4`: the former is a
static preview and the latter is a supplied video. The mid video may have the
same dimensions as the original MP4; it has no fixed resolution cap. Videos
have only the root MP4, and 3D works have the root GLB model. Use
`metadata.animation_url` as the authoritative playable media URL when supplied.

For unrevealed artwork, receipts, crates, warehouses, relics and other image
paths outside the table, retain the supplied `metadata.image`. Their URLs do
not use these companion rules.

Fresh publications use `crate.webp` (1448 × 1086, 4:3) and `warehouse.webp`
(1536 × 1024, 3:2) at the same CDN root. Unrevealed artwork and all receipt
kinds use `placeholder.png` (932 × 1006, 466:503). Their metadata includes
the corresponding `aspectRatio`; display these images without stretching.

## URL examples

Each example uses asset ID 1 within its own family.

### Paintings

```text
original: https://cdn.lil.org/nft/111k/paintings/1.png
mid: https://cdn.lil.org/nft/111k/paintings/mid/1.webp
420px: https://cdn.lil.org/nft/111k/paintings/thumbs/1.webp
260px: https://cdn.lil.org/nft/111k/paintings/thumbs/260/1.webp
140px: https://cdn.lil.org/nft/111k/paintings/thumbs/140/1.webp
alt: https://cdn.lil.org/nft/111k/paintings/alt/1.webp
```

### Eggs

```text
original: https://cdn.lil.org/nft/111k/eggs/1.png
webp: https://cdn.lil.org/nft/111k/eggs/1.webp
```

### Videos

```text
original: https://cdn.lil.org/nft/111k/videos/1.webp
mid: https://cdn.lil.org/nft/111k/videos/mid/1.webp
420px: https://cdn.lil.org/nft/111k/videos/thumbs/1.webp
260px: https://cdn.lil.org/nft/111k/videos/thumbs/260/1.webp
140px: https://cdn.lil.org/nft/111k/videos/thumbs/140/1.webp
video: https://cdn.lil.org/nft/111k/videos/1.mp4
```

### Animated works

```text
original: https://cdn.lil.org/nft/111k/animated/1.png
mid: https://cdn.lil.org/nft/111k/animated/mid/1.webp
420px: https://cdn.lil.org/nft/111k/animated/thumbs/1.webp
260px: https://cdn.lil.org/nft/111k/animated/thumbs/260/1.webp
140px: https://cdn.lil.org/nft/111k/animated/thumbs/140/1.webp
video: https://cdn.lil.org/nft/111k/animated/1.mp4
mid video: https://cdn.lil.org/nft/111k/animated/mid/1.mp4
```

### 3D works

```text
original: https://cdn.lil.org/nft/111k/3d/1.png
mid: https://cdn.lil.org/nft/111k/3d/mid/1.webp
420px: https://cdn.lil.org/nft/111k/3d/thumbs/1.webp
260px: https://cdn.lil.org/nft/111k/3d/thumbs/260/1.webp
140px: https://cdn.lil.org/nft/111k/3d/thumbs/140/1.webp
model: https://cdn.lil.org/nft/111k/3d/1.glb
```

## JavaScript helper

Pass the original `metadata.image` string to this function. It accepts the
exact canonical image paths in the table and returns only the applicable URL
fields. Other inputs return just `original`, unchanged. It constructs URLs
without network requests or checking whether an asset ID exists.

```js
function derive111kAssets(image) {
  const assets = { original: image };
  if (typeof image !== 'string') return assets;

  const base = 'https://cdn.lil.org/nft/111k/';
  if (!image.startsWith(base)) return assets;

  const path = image.slice(base.length);
  const match = /^(eggs|paintings|3d|animated|videos)\/([1-9][0-9]*)\.(png|webp)$/.exec(path);
  if (!match || match[0] !== path) return assets;

  const [, family, id, extension] = match;
  if (extension !== (family === 'videos' ? 'webp' : 'png')) return assets;

  const root = `${base}${family}/`;
  if (family === 'eggs') {
    assets.webp = `${root}${id}.webp`;
    return assets;
  }

  assets.mid = `${root}mid/${id}.webp`;
  assets.thumbnails = {
    420: `${root}thumbs/${id}.webp`,
    260: `${root}thumbs/260/${id}.webp`,
    140: `${root}thumbs/140/${id}.webp`,
  };

  if (family === 'paintings') assets.alt = `${root}alt/${id}.webp`;
  if (family === '3d') assets.model = `${root}${id}.glb`;
  if (family === 'videos' || family === 'animated') {
    assets.video = `${root}${id}.mp4`;
  }
  if (family === 'animated') assets.midVideo = `${root}mid/${id}.mp4`;

  return assets;
}
```

Select the 260px variant when available, falling back to the egg WebP or the
original image:

```js
const assets = derive111kAssets(metadata.image);
const preview = assets.thumbnails?.[260] ?? assets.webp ?? assets.original;
```
