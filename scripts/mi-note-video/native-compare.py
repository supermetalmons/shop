import argparse
import hashlib
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

import frames


CONTROL_FRAMES = [0, 69, 138, 207, 275]
NATIVE_SIZE = 3240
DELIVERY_SIZE = 2160
INTERIOR = (640, 480, 1520, 1680)
P3 = frames.PROFILE_PATHS['p3'].read_bytes()
LAB_TRANSFORM = ImageCms.buildTransformFromOpenProfiles(
    ImageCms.ImageCmsProfile(io.BytesIO(P3)), ImageCms.createProfile('LAB'),
    'RGB', 'LAB', renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def image_identity(path):
    path = Path(path).resolve(strict=True)
    before = digest(path)
    with Image.open(path) as image:
        image.load()
        if image.size != (NATIVE_SIZE, NATIVE_SIZE):
            raise ValueError(f'{path}: expected {NATIVE_SIZE}x{NATIVE_SIZE} native pixels, got {image.size}')
        if image.mode not in ('RGB', 'RGBA'):
            raise ValueError(f'{path}: expected RGB or RGBA, got {image.mode}')
        if image.mode == 'RGBA' and image.getchannel('A').getextrema() != (255, 255):
            raise ValueError(f'{path}: native frame is not opaque')
        embedded_profile = image.info.get('icc_profile')
        declared_srgb = 'srgb' in image.info
        if not embedded_profile and not declared_srgb:
            raise ValueError(f'{path}: embedded source ICC or explicit PNG sRGB declaration is required')
        profile = embedded_profile or frames.PROFILE_PATHS['srgb'].read_bytes()
        result = {'path': str(path), 'sha256': before, 'bytes': path.stat().st_size,
                  'width': image.width, 'height': image.height, 'mode': image.mode,
                  'icc': frames.profile_metadata(profile),
                  'embeddedIcc': frames.profile_metadata(embedded_profile),
                  'pngSrgbIntent': image.info.get('srgb'),
                  'inputSpace': 'srgb' if not embedded_profile else None,
                  'rgbSha256': hashlib.sha256(image.convert('RGB').tobytes()).hexdigest()}
    if digest(path) != before:
        raise ValueError(f'{path}: input changed during inspection')
    return result


def difference_metrics(reference, candidate):
    delta = candidate.astype(np.float32) - reference.astype(np.float32)
    absolute = np.abs(delta)
    mse = float(np.mean(delta * delta, dtype=np.float64))
    pixel_error = absolute.max(axis=-1)
    return {
        'meanAbsoluteChannelError255': float(absolute.mean(dtype=np.float64)),
        'rootMeanSquaredChannelError255': math.sqrt(mse),
        'peakSignalToNoiseRatioDb': 10 * math.log10(255 ** 2 / mse) if mse else None,
        'maxAbsoluteChannelError255': float(absolute.max()),
        'absoluteChannelErrorPercentiles': dict(zip(
            ('p50', 'p95', 'p99', 'p99_9'), np.percentile(absolute, [50, 95, 99, 99.9]).tolist())),
        'meanSignedRGB255': delta.mean(axis=(0, 1), dtype=np.float64).tolist(),
        'changedPixelFraction': float(np.mean(pixel_error != 0)),
        'pixelFractionOverChannelError': {str(value): float(np.mean(pixel_error > value))
                                         for value in (1, 2, 5, 10)},
    }


def detail_metrics(pixels):
    luminance = pixels.astype(np.float32) @ np.array([.2126, .7152, .0722], dtype=np.float32)
    center = luminance[1:-1, 1:-1]
    dx = (luminance[1:-1, 2:] - luminance[1:-1, :-2]) / 2
    dy = (luminance[2:, 1:-1] - luminance[:-2, 1:-1]) / 2
    laplacian = 4 * center - luminance[:-2, 1:-1] - luminance[2:, 1:-1] - luminance[1:-1, :-2] - luminance[1:-1, 2:]
    gradient = float(np.mean(dx * dx + dy * dy, dtype=np.float64))
    fine = float(np.mean(laplacian * laplacian, dtype=np.float64))
    return {'gradientEnergy': gradient, 'fineDetailEnergy': fine,
            'fineToGradientRatio': fine / gradient if gradient else None}


def quantized_lab(image):
    lab = ImageCms.applyTransform(image, LAB_TRANSFORM)
    value = np.stack([np.asarray(channel, dtype=np.float32) for channel in lab.split()], axis=-1)
    value[:, :, 0] *= 100 / 255
    value[:, :, 1:] -= 128
    return value


def perceptual_metrics(reference, candidate):
    delta = quantized_lab(candidate) - quantized_lab(reference)
    de = np.sqrt(np.sum(delta * delta, axis=-1))
    return {'method': 'CIE76 from LittleCMS relative-colorimetric ICC to 8-bit Lab D50',
            'limitation': 'Lab is quantized to 8 bits; this is descriptive evidence, not a perceptual acceptance gate.',
            'meanDeltaE76': float(de.mean(dtype=np.float64)), 'maxDeltaE76': float(de.max()),
            'deltaE76Percentiles': dict(zip(('p50', 'p95', 'p99'), np.percentile(de, [50, 95, 99]).tolist()))}


def paired_metrics(reference, candidate):
    if reference.size != candidate.size or reference.mode != 'RGB' or candidate.mode != 'RGB':
        raise ValueError('Comparison requires equal-size RGB images')
    if reference.info.get('icc_profile') != P3 or candidate.info.get('icc_profile') != P3:
        raise ValueError('Comparison requires the exact standard Display P3 ICC on both images')
    a, b = np.asarray(reference), np.asarray(candidate)
    x0, y0, x1, y1 = INTERIOR
    interior_a, interior_b = reference.crop(INTERIOR), candidate.crop(INTERIOR)
    detail_a = detail_metrics(a[y0:y1, x0:x1])
    detail_b = detail_metrics(b[y0:y1, x0:x1])
    low_a = interior_a.resize((94, 128), Image.Resampling.BOX)
    low_b = interior_b.resize((94, 128), Image.Resampling.BOX)
    return {
        'pixelExact': bool(np.array_equal(a, b)), 'iccExact': True,
        'wholeImage': difference_metrics(a, b),
        'cardInteriorBounds': list(INTERIOR),
        'cardInterior': difference_metrics(np.asarray(interior_a), np.asarray(interior_b)),
        'cardInteriorPerceptual': perceptual_metrics(interior_a, interior_b),
        'lowFrequencyColor': {'method': 'Identical fixed interior BOX-reduced to 94x128 Display P3 RGB',
                              **difference_metrics(np.asarray(low_a), np.asarray(low_b)),
                              **perceptual_metrics(low_a, low_b)},
        'detail': {'reference': detail_a, 'candidate': detail_b,
                   'candidateToReference': {key: detail_b[key] / value if value and detail_b[key] is not None else None
                                            for key, value in detail_a.items()}},
        'nonBlackBounds': {'reference': reference.getbbox(), 'candidate': candidate.getbbox()},
        'blackBorder': {'referenceMaxChannel': border_max(a), 'candidateMaxChannel': border_max(b)},
    }


def border_max(pixels):
    width = 32
    return max(int(part.max()) for part in (pixels[:width], pixels[-width:], pixels[:, :width], pixels[:, -width:]))


def save_visuals(reference, candidate, output, frame):
    output.mkdir(parents=True, exist_ok=True)
    stem = f'{frame:04d}'
    pairs = Image.new('RGB', (reference.width * 2, reference.height))
    pairs.paste(reference, (0, 0))
    pairs.paste(candidate, (reference.width, 0))
    side_path = output / f'{stem}-reference-left-candidate-right.png'
    frames.save_png(pairs, side_path, P3)
    a, b = reference.crop(INTERIOR), candidate.crop(INTERIOR)
    pair_crop = Image.new('RGB', (a.width * 2, a.height))
    pair_crop.paste(a, (0, 0))
    pair_crop.paste(b, (a.width, 0))
    crop_path = output / f'{stem}-interior-reference-left-candidate-right.png'
    frames.save_png(pair_crop, crop_path, P3)
    delta = np.abs(np.asarray(a).astype(np.int16) - np.asarray(b).astype(np.int16))
    difference = Image.fromarray(np.minimum(delta * 8, 255).astype(np.uint8))
    diff_path = output / f'{stem}-interior-absolute-difference-x8.png'
    frames.save_png(difference, diff_path, P3)
    return {'sideBySide': str(side_path), 'interiorSideBySide': str(crop_path),
            'interiorAbsoluteDifference8x': str(diff_path),
            'differenceVisualization': 'Absolute encoded RGB differences multiplied by 8 and clipped; not actual scene color.'}


def compare_directories(reference, candidate, output, selected_frames=CONTROL_FRAMES):
    reference, candidate, output = (Path(value).resolve() for value in (reference, candidate, output))
    if output.exists():
        raise ValueError('Output directory already exists: ' + str(output))
    if selected_frames != sorted(set(selected_frames)) or not selected_frames or any(
            type(value) is not int or not 0 <= value < frames.FRAME_COUNT for value in selected_frames):
        raise ValueError('Frames must be unique increasing integers from 0 through 275')
    sources = [(frame, image_identity(reference / f'{frame:04d}.png'),
                image_identity(candidate / f'{frame:04d}.png')) for frame in selected_frames]
    output.mkdir(parents=True)
    for name in ('reference-prepared', 'candidate-prepared'):
        (output / name).mkdir()
    results = []
    for frame, first, second in sources:
        reports = []
        paths = []
        for role, source in (('reference', first), ('candidate', second)):
            path = output / f'{role}-prepared' / f'{frame:04d}.png'
            reports.append(frames.prepare_frame(source['path'], path, 'p3', size=DELIVERY_SIZE,
                                                input_space=source['inputSpace']))
            paths.append(path)
        with Image.open(paths[0]) as a, Image.open(paths[1]) as b:
            a.load()
            b.load()
            metrics = paired_metrics(a, b)
            visuals = save_visuals(a, b, output / 'visuals', frame)
        results.append({'frame': frame, 'reference': first, 'candidate': second,
                        'nativeRgbExact': first['rgbSha256'] == second['rgbSha256'],
                        'nativeIccExact': bool(first['embeddedIcc'] and first['embeddedIcc'] == second['embeddedIcc']),
                        'preparation': dict(zip(('reference', 'candidate'), reports)),
                        'metrics': metrics, 'visuals': visuals})
        print(json.dumps({'frame': frame, 'pixelExact': metrics['pixelExact'],
                          'interiorMAE': metrics['cardInterior']['meanAbsoluteChannelError255'],
                          'lowFrequencyColorMAE': metrics['lowFrequencyColor']['meanAbsoluteChannelError255']}), flush=True)
    for _, first, second in sources:
        for source in (first, second):
            if digest(source['path']) != source['sha256']:
                raise ValueError('Source changed during comparison: ' + source['path'])
    report = {
        'version': 1, 'kind': 'mi-note-native-capture-comparison',
        'referenceDirectory': str(reference), 'candidateDirectory': str(candidate),
        'scope': 'Corresponding frame indices; no registration, alignment, denoising, or color correction.',
        'interpretation': 'Metrics describe differences and do not by themselves establish equal capture quality. Review color, fine detail, geometry, effects, and temporal behavior. Fresh compositor captures may have raster variation.',
        'preparationContract': {'nativeSize': NATIVE_SIZE, 'deliverySize': DELIVERY_SIZE,
                                'targetIcc': frames.profile_metadata(P3),
                                'conversion': 'Existing frames.prepare_frame: LittleCMS relative colorimetric from each embedded source ICC or explicit PNG sRGB declaration, then one Lanczos reduction.'},
        'sourceInputsUnchanged': True, 'frames': results,
        'allPreparedPixelsExact': all(row['metrics']['pixelExact'] for row in results),
        'allPreparedIccExact': all(row['metrics']['iccExact'] for row in results),
        'maximumInteriorMAE': max(row['metrics']['cardInterior']['meanAbsoluteChannelError255'] for row in results),
        'maximumLowFrequencyColorMAE': max(row['metrics']['lowFrequencyColor']['meanAbsoluteChannelError255'] for row in results),
    }
    with (output / 'comparison.json').open('x') as destination:
        json.dump(report, destination, indent=2, allow_nan=False)
        destination.write('\n')
    return report


def main():
    parser = argparse.ArgumentParser(description='Compare native 3240px Mi Note captures using the established Display P3 preparation path.')
    parser.add_argument('--reference', required=True, type=Path, help='Reference native PNG directory, named 0000.png through 0275.png')
    parser.add_argument('--candidate', required=True, type=Path, help='Native app PNG directory with corresponding frame names and embedded ICC or explicit PNG sRGB declaration')
    parser.add_argument('--output', required=True, type=Path, help='New comparison directory; existing directories are refused')
    parser.add_argument('--frames', default=','.join(map(str, CONTROL_FRAMES)), help='Increasing comma-separated frame indices')
    args = parser.parse_args()
    compare_directories(args.reference, args.candidate, args.output, [int(value) for value in args.frames.split(',')])


if __name__ == '__main__':
    main()
