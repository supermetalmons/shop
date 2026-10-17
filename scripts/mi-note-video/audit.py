import argparse
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageCms, features

from video_validation import verify_certificate


CONTRACT = json.loads(Path(__file__).with_name('contract.json').read_text())
THRESHOLDS = {'wholeImageMAE': 3.0, 'cardInteriorMAE': 6.0, 'absoluteMeanSignedRGB': 1.5,
              'edgeEnergyRetention': .85, 'fineDetailEnergyRetention': .75, 'blackBorderMean': .5}
LUMA = np.array([.2126, .7152, .0722], dtype=np.float32)
SAMPLES = CONTRACT['capture']['controlFrames']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    path = Path(path)
    require(path.resolve() == path and path.is_file(), 'Expected a regular audit input: ' + str(path))
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def numeric(value):
    return float(re.match(r'^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?', str(value)).group())


def expected_motion(frame, motion):
    rounded = lambda value: float(Decimal.from_float(value).quantize(Decimal('.001'), rounding=ROUND_HALF_UP))
    phase = frame / CONTRACT['video']['frames']
    if motion != 'original':
        phase = ((phase % 1) + 1) % 1
    angle = phase * math.pi * 2
    if motion == 'original':
        x, y = math.cos(angle), math.sin(angle)
    elif motion == 'vertical-swing':
        x, y = .94 * math.sin(angle), .22 * math.cos(angle)
    elif motion == 'breathing-swing':
        radius, swing = .81 - .12 * math.cos(angle), angle + .18 * math.sin(angle)
        x, y = radius * math.sin(swing), radius * .65 * math.cos(swing)
    else:
        raise RuntimeError('Unsupported motion')
    px, py = rounded(50 + x * 22), rounded(50 + y * 16)
    return {'pointerX': px, 'pointerY': py, 'backgroundX': rounded(37 + 26 * px / 100), 'backgroundY': rounded(33 + 34 * py / 100),
            'pointerFromCenter': math.hypot(px - 50, py - 50) / 50, 'rotateX': rounded(-(px - 50) / 3.5),
            'rotateY': rounded((py - 50) / 2), 'opacity': .99, 'scale': 1, 'translateX': 0, 'translateY': 0}


def native_image(path, expected, icc, size):
    require(sha(path) == expected, 'Native PNG checksum changed')
    with Image.open(path) as source:
        source.load()
        require(source.mode == 'RGB' and source.size == (size, size), 'Native PNG geometry changed')
        profile = source.info.get('icc_profile')
        require(profile and hashlib.sha256(profile).hexdigest() == icc, 'Native ICC changed')
        return source.copy(), profile


def exterior_black(pixels, bounds):
    left, top, right, bottom = bounds
    require(all(np.all(region == 0) for region in [pixels[:top], pixels[bottom:], pixels[top:bottom, :left], pixels[top:bottom, right:]]), 'Native exterior is not exactly black')


def verify_geometry(job, card, manifest, approval, profile):
    preflight = read(approval['report'])
    require(preflight['status'] == 'passed', 'Preflight did not pass')
    geometry_path = preflight['cards'][0]['geometryPath']
    require(sha(geometry_path) == approval['evidenceHashes'][geometry_path], 'Preflight geometry changed')
    expected = read(geometry_path)
    require(len(expected) == CONTRACT['video']['frames'], 'Preflight geometry is incomplete')
    envelope = approval['motionEnvelope']['bounds']
    receipts = [read(path) for path in (Path(job['root']) / 'screenshot-transfers').glob('*.json')]
    minimum_inset, maximum_error = math.inf, 0
    for frame in range(CONTRACT['video']['frames']):
        record = manifest['nativeFrames'][f'{card}:{frame}']
        require(sha(record['stitchReport']) == record['stitchReportSha256'], 'Stitch report changed')
        stitched = read(record['stitchReport'])
        require(sha(record['tileMetadata']) == stitched['metadataSha256'], 'Tile metadata changed')
        metadata = read(record['tileMetadata'])
        require(stitched['passed'] and stitched['iccPreservedByteForByte'] and stitched['guardPixels'] == 32
                and stitched['width'] == stitched['height'] == profile['nativeSize'], 'Native stitch contract changed')
        require(metadata['profile'] == job['profile'] and metadata['id'] == card and metadata['frame'] == frame
                and metadata['captureRotationDegrees'] == profile['rotationDegrees'] and metadata['backgroundRgb'] == [0, 0, 0]
                and metadata['shadows'] is False and metadata['captureScale'] == profile['captureScale']
                and metadata['columns'] == 1 and metadata['rows'] == profile['tiles'] and len(metadata['tiles']) == profile['tiles'], 'Native capture profile changed')
        require(all(seam['passed'] and seam.get('delivery', {}).get('passed') for seam in stitched['seams']), 'Native or delivery seam failed')
        predicted = expected[frame]['snapshot']['unrotatedRotatorRect']
        for tile in metadata['tiles']:
            receipt_path = re.escape(str(Path(job['root']) / 'cards' / str(card) / 'capture/capture-attempts')) + rf"/{card}c-{frame}-{tile['row']}-{tile['col']}-{tile['captureAttempts']}-[a-f0-9-]{{36}}\.png"
            require(any(receipt.get('passed') is True and receipt.get('sourceSha256') == receipt.get('destinationSha256') == tile['sha256']
                        and re.fullmatch(receipt_path, receipt.get('destination', '')) for receipt in receipts), 'Accepted native viewport lacks a byte-identical transfer receipt')
            snapshot = tile['snapshot']
            require(snapshot['cardId'] == card and snapshot['frame'] == frame and snapshot['ready'] and snapshot['paintReady']
                    and snapshot['nativePixels'] and snapshot['dpr'] == 2 and snapshot['viewport']['visibility'] == 'visible'
                    and snapshot['background'] == '#000000' and snapshot['shadowEnabled'] is False and snapshot['effect']['shadow'] == 'none', 'Native snapshot identity changed')
            for key, target in expected_motion(frame, job['motion']).items():
                require(abs(numeric(snapshot['effect'][key]) - target) < 1e-9, f'Motion variable changed: {frame}:{key}')
            rect = snapshot['unrotatedRotatorRect']
            error = max(abs(rect[key] - predicted[key]) for key in ['x', 'y', 'width', 'height'])
            require(error <= .075, 'Captured pose differs from preflight')
            inset = min(rect['x'] - envelope[0], rect['y'] - envelope[1], envelope[2] - rect['x'] - rect['width'], envelope[3] - rect['y'] - rect['height'])
            require(inset >= -.075, 'Captured motion exceeds the original footprint')
            maximum_error, minimum_inset = max(maximum_error, error), min(minimum_inset, inset)
    return {'frames': CONTRACT['video']['frames'], 'maximumGeometryErrorNative': maximum_error, 'minimumEnvelopeInsetNative': minimum_inset}


def reconstruct(manifest, card, frame, profile, icc):
    record = manifest['nativeFrames'][f'{card}:{frame}']
    retained = next(item for item in manifest['compacted'][str(card)]['retained'] if item['frame'] == frame)
    image, profile_bytes = native_image(retained['path'], record['sha256'], icc, profile['nativeSize'])
    stitched, metadata = read(record['stitchReport']), read(record['tileMetadata'])
    sources = [retained['viewportSource']] if profile['tiles'] == 1 else retained['viewportSources']
    require(len(sources) == profile['tiles'], 'Retained original viewports are missing')
    by_path = {item['originalPath']: item for item in sources}
    result = np.zeros((profile['nativeSize'], profile['nativeSize'], 3), np.uint8)
    covered = np.zeros(result.shape[:2], bool)
    for part in stitched['partitions']:
        tile = next(item for item in metadata['tiles'] if item['row'] == part['row'] and item['col'] == part['col'])
        source = by_path[tile['path']]
        require(sha(source['path']) == source['sha256'] == tile['sha256'], 'Retained viewport checksum changed')
        with Image.open(source['path']) as viewport:
            viewport.load()
            require(viewport.size == (tile['viewportWidth'], tile['viewportHeight']) and viewport.info.get('icc_profile') == profile_bytes, 'Viewport size or byte-identical ICC changed')
            box = part['box']
            crop = [value - (tile['originX'] if index % 2 == 0 else tile['originY']) for index, value in enumerate(box)]
            require(crop[0] >= 32 and crop[1] >= 32 and crop[2] <= viewport.width - 32 and crop[3] <= viewport.height - 32, 'Source crop violates native guards')
            pixels = np.asarray(viewport.crop(crop).convert('RGBA'))
            require(np.all(pixels[:, :, 3] == 255), 'Native source crop is not opaque')
            rgb = pixels[:, :, :3]
        left, top, right, bottom = box
        require(not np.any(covered[top:bottom, left:right]), 'Native partitions overlap')
        result[top:bottom, left:right] = rgb
        covered[top:bottom, left:right] = True
        if profile['rotationDegrees'] == 90:
            padding = stitched['backgroundPadding']
            require(crop == padding['sourceCropBox'] and hashlib.sha256(rgb.tobytes()).hexdigest() == padding['sourceCropRgbSha256'], 'Native source crop bytes differ')
            require(padding['nativePixelsPreserved'] and padding['referenceIccMatches'] and padding['blackBordersExact']
                    and padding['capturedExteriorExactBlack'] and padding['losslessUnrotation']
                    and padding['inverseRotation']['losslessIntegerPermutation'] and padding['inverseRotation']['resampling'] is False, 'Sideways source provenance changed')
            require((top == 0 or np.all(rgb[:8] == 0)) and (bottom == profile['nativeSize'] or np.all(rgb[-8:] == 0)), 'Sideways padding joins are not black')
    if profile['rotationDegrees'] == 90:
        result = np.rot90(result, k=1)
        require(hashlib.sha256(result.tobytes()).hexdigest() == stitched['backgroundPadding']['inverseRotation']['restoredRgbSha256'], 'Restored native digest changed')
    else:
        require(np.all(covered), 'Upright native partitions leave a gap')
    require(np.array_equal(result, np.asarray(image)), 'Native frame differs from its original viewport pixels')
    return image, profile_bytes


def detail_metrics(luminance, mask):
    dx = (luminance[1:-1, 2:] - luminance[1:-1, :-2]) / 2
    dy = (luminance[2:, 1:-1] - luminance[:-2, 1:-1]) / 2
    lap = 4 * luminance[1:-1, 1:-1] - luminance[:-2, 1:-1] - luminance[2:, 1:-1] - luminance[1:-1, :-2] - luminance[1:-1, 2:]
    return float(np.mean((dx * dx + dy * dy)[mask])), float(np.mean((lap * lap)[mask]))


def fidelity(reference, decoded, decoded_luma):
    size = reference.shape[0]
    x0, y0, x1, y1 = [round(value * size / 1080) for value in (320, 240, 760, 840)]
    mask = np.zeros((size, size), bool)
    mask[y0:y1, x0:x1] = True
    region = (slice(y0, y1), slice(x0, x1))
    border = np.ones((size, size), bool)
    width = round(16 * size / 1080)
    border[width:-width, width:-width] = False
    delta = decoded - reference
    bias = delta[region].mean(axis=(0, 1))
    before, after = detail_metrics(reference @ LUMA, mask[1:-1, 1:-1]), detail_metrics(decoded_luma, mask[1:-1, 1:-1])
    edge, fine = [encoded / source if source > .1 else None for source, encoded in zip(before, after)]
    metrics = {'wholeImageMAE': float(np.abs(delta).mean()), 'cardInteriorMAE': float(np.abs(delta[region]).mean()),
               'cardInteriorMeanSignedRGB': bias.tolist(), 'edgeEnergyRetention': edge, 'fineDetailEnergyRetention': fine,
               'blackBorderMean': float(decoded[border].mean())}
    issues = []
    if metrics['wholeImageMAE'] > THRESHOLDS['wholeImageMAE'] or metrics['cardInteriorMAE'] > THRESHOLDS['cardInteriorMAE'] or np.max(np.abs(bias)) > THRESHOLDS['absoluteMeanSignedRGB']:
        issues.append('color-error')
    if any(metrics[key] is not None and metrics[key] < THRESHOLDS[key] for key in ['edgeEnergyRetention', 'fineDetailEnergyRetention']):
        issues.append('detail-loss')
    if metrics['blackBorderMean'] > THRESHOLDS['blackBorderMean']:
        issues.append('border-luminance')
    return metrics, issues


def audit(job, card):
    profile = CONTRACT['profiles'][job['profile']]
    unit = Path(job['root']) / 'cards' / str(card)
    manifest = read(unit / 'output/.render-manifest.json')
    require(manifest['status'] == 'complete' and manifest['profile'] == job['profile'] and manifest['motion'] == job['motion'] and manifest['ids'] == [card], 'Render is incomplete or belongs to another unit')
    approval = read(unit / 'preflight/approved.json')
    require(approval['status'] == 'passed' and sha(unit / 'preflight/approved.json') == manifest['preflight']['sha256'], 'Render preflight changed')
    video = manifest['videos'][0]
    require(len(manifest['videos']) == 1 and video['id'] == card and video['output'] == str(unit / 'output' / f'{card}.mp4') and sha(video['output']) == video['sha256'], 'Encoded video checksum changed')
    versions = {'python': platform.python_version(), 'pillow': Image.__version__, 'numpy': np.__version__, 'littlecms': features.version('littlecms2')}
    require(versions == manifest['versions']['python'], 'Audit and preparation runtimes differ')
    geometry = verify_geometry(job, card, manifest, approval, profile)
    quality_entry = manifest['qualityReports'][str(card)]
    require(sha(quality_entry['path']) == quality_entry['sha256'], 'Native sequence quality changed')
    quality = read(quality_entry['path'])
    require(quality['passed'] and quality['restRepeatExact'] and len(quality['frames']) == 276, 'Native sequence quality failed')
    require(all(row['frame'] == index and row['sha256'] == manifest['nativeFrames'][f'{card}:{index}']['sha256'] and row['staticExteriorExact'] and row['firstRestExact'] for index, row in enumerate(quality['frames'])), 'Native sequence quality does not cover every frame')
    proofs = manifest['nativeProofs'][str(card)]
    controls = [proofs['before'], proofs['initialCalibration']['independentRepeat'], *proofs['afterCalibrations'][-2:], proofs['after']]
    require(len(controls) == 5 and len({item['path'] for item in controls}) == 5 and proofs['initialCalibration']['afterFullOrbitWarmup'], 'Independent native controls are missing')
    baseline = None
    for control in controls:
        image, _ = native_image(control['path'], control['sha256'], quality['nativeIccSha256'], profile['nativeSize'])
        pixels = np.asarray(image)
        exterior_black(pixels, quality['staticBounds'])
        if baseline is None:
            baseline = pixels.copy()
        else:
            require(np.array_equal(pixels, baseline), 'Independent native controls differ')
    p3_bytes = Path('/System/Library/ColorSync/Profiles/Display P3.icc').read_bytes()
    preparation = [read(path) for path in (unit / 'capture/metadata').glob(f'{card}d-preparation-*.json')]
    preparation = [item for item in preparation if item['output'] == video['prepared']]
    require(len(preparation) == 1 and preparation[0]['icc']['sha256'] == hashlib.sha256(p3_bytes).hexdigest()
            and preparation[0]['resample']['filter'] == 'Lanczos' and preparation[0]['resample']['passes'] == 1
            and preparation[0]['resample']['afterIccConversion'] is True, 'Prepared P3 frame contract changed')
    certificate = video.get('decodeCertificate')
    if certificate:
        verify_certificate(job, video, certificate['path'], job['sourceRoot'])
        decoded = read(certificate['path'])
        raw = b''.join(Path(sample['path']).read_bytes() for sample in decoded['samples'])
    else:
        ffmpeg = os.environ.get('MI_NOTE_FFMPEG') or shutil.which('ffmpeg')
        require(ffmpeg, 'FFmpeg is required for independent fidelity auditing')
        selection = '+'.join(f'eq(n\\,{frame})' for frame in SAMPLES)
        raw = subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-i', video['output'], '-vf', f'select={selection}', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1'], check=True, capture_output=True, timeout=300).stdout
    size = profile['deliverySize']
    planes = np.frombuffer(raw, dtype='<u2')
    n, stride = size * size, size * size * 3 // 2
    require(len(planes) == len(SAMPLES) * stride, 'Decoded sample frame count changed')
    samples, issues = [], []
    for index, frame in enumerate(SAMPLES):
        native, icc = reconstruct(manifest, card, frame, profile, quality['nativeIccSha256'])
        exterior_black(np.asarray(native), quality['staticBounds'])
        if frame == 0:
            require(np.array_equal(np.asarray(native), baseline), 'Frame zero differs from the independent controls')
        converted = ImageCms.profileToProfile(native, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.ImageCmsProfile(io.BytesIO(p3_bytes)), outputMode='RGB', renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
        reference = np.asarray(converted.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
        values = planes[index * stride:(index + 1) * stride].astype(np.float32)
        y = (values[:n].reshape(size, size) - 64) / 876
        u = np.asarray(Image.fromarray((values[n:n + n // 4].reshape(size // 2, size // 2) - 512) / 896).resize((size, size), Image.Resampling.BILINEAR))
        v = np.asarray(Image.fromarray((values[n + n // 4:].reshape(size // 2, size // 2) - 512) / 896).resize((size, size), Image.Resampling.BILINEAR))
        red, blue = y + 1.5748 * v, y + 1.8556 * u
        green = (y - .2126 * red - .0722 * blue) / .7152
        decoded = np.clip(np.stack([red, green, blue], axis=2) * 255, 0, 255)
        metrics, failures = fidelity(reference, decoded, y * 255)
        samples.append({'frame': frame, **metrics})
        issues.extend({'frame': frame, 'type': issue} for issue in failures)
    return {'version': 1, 'jobId': job['jobId'], 'sourceId': job['sourceId'], 'cardId': card, 'profile': job['profile'], 'motion': job['motion'],
            'videoSha256': video['sha256'], 'auditSourceSha256': sha(Path(__file__).resolve()), 'thresholds': THRESHOLDS,
            'geometry': geometry, 'nativeFramesVerified': len(SAMPLES), 'sourceViewportsVerified': len(SAMPLES) * profile['tiles'],
            'independentControlsVerified': len(controls), 'iccByteExact': True, 'nativePixelsExact': True,
            'samples': samples, 'issues': issues, 'passed': not issues,
            **({'decodeCertificateSha256': certificate['sha256']} if certificate else {})}


def main():
    parser = argparse.ArgumentParser(description='Independently audit a completed native video unit before host collection.')
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--id', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    job = read(args.job)
    require(args.id in job['ids'], 'Card does not belong to this job')
    report = audit(job, args.id)
    with tempfile.NamedTemporaryFile(mode='w', prefix='.audit-', dir=args.output.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(report, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, args.output)
    print(json.dumps({'cardId': args.id, 'passed': report['passed'], 'issues': report['issues']}), flush=True)
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
