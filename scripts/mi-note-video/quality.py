import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import math
from pathlib import Path
import statistics

import numpy as np
from PIL import Image


FRAME_COUNT = 276
METRIC_LONG_EDGE = 1080
COLOR_LONG_EDGE = 128
TEMPORAL_RADIUS = 5
DETAIL_DEVIATIONS = {
    'gradientEnergy': .10,
    'fineDetailEnergy': .15,
    'fineToGradientRatio': .10,
}
COLOR_MAE_FLOOR = 2.0
COLOR_LOCAL_RATIO = 3.5
ROBUST_DEVIATIONS = 6.0


def scaled_size(size, longest):
    scale = min(1, longest / max(size))
    return tuple(max(1, round(value * scale)) for value in size)


def frame_metrics(image, bounds):
    card = image.crop(bounds)
    reduced = card.resize(scaled_size(card.size, METRIC_LONG_EDGE), Image.Resampling.LANCZOS)
    luminance = np.asarray(reduced.convert('L'), dtype=np.float32)
    center = luminance[1:-1, 1:-1]
    dx = (luminance[1:-1, 2:] - luminance[1:-1, :-2]) / 2
    dy = (luminance[2:, 1:-1] - luminance[:-2, 1:-1]) / 2
    laplacian = 4 * center - luminance[:-2, 1:-1] - luminance[2:, 1:-1] - luminance[1:-1, :-2] - luminance[1:-1, 2:]
    gradient = float(np.mean(dx * dx + dy * dy))
    fine = float(np.mean(laplacian * laplacian))
    row = {
        'gradientEnergy': gradient,
        'fineDetailEnergy': fine,
        'fineToGradientRatio': fine / max(gradient, 1e-6),
    }
    color = np.asarray(card.resize(scaled_size(card.size, COLOR_LONG_EDGE), Image.Resampling.BOX), dtype=np.float32)
    return row, color


def temporal_issues(rows):
    count = len(rows)
    issues = []
    for index, row in enumerate(rows):
        adjacent = [rows[(index + offset) % count]['previousRGBMAE']
                    for offset in range(-TEMPORAL_RADIUS, TEMPORAL_RADIUS + 1) if offset]
        median = statistics.median(adjacent)
        if row['previousRGBMAE'] > COLOR_MAE_FLOOR and row['previousRGBMAE'] > COLOR_LOCAL_RATIO * max(median, .001):
            issues.append({
                'frame': index, 'type': 'color-continuity',
                'mae': row['previousRGBMAE'], 'localMedian': median,
            })
    for key, deviation in DETAIL_DEVIATIONS.items():
        values = [math.log(max(row[key], 1e-6)) for row in rows]
        changes = [value - values[(index - 1) % count] for index, value in enumerate(values)]
        for index, change in enumerate(changes):
            if min(rows[index]['gradientEnergy'], rows[(index - 1) % count]['gradientEnergy']) < .1:
                continue
            adjacent = [changes[(index + offset) % count]
                        for offset in range(-TEMPORAL_RADIUS, TEMPORAL_RADIUS + 1) if offset]
            trend = statistics.median(adjacent)
            scatter = 1.4826 * statistics.median(abs(value - trend) for value in adjacent)
            limit = max(math.log1p(deviation), ROBUST_DEVIATIONS * scatter)
            residual = abs(change - trend)
            rows[index].setdefault('detailTrendResiduals', {})[key] = residual
            if residual > limit:
                issues.append({
                    'frame': index, 'type': 'detail-continuity', 'metric': key,
                    'previousRatio': math.exp(change), 'localTrendRatio': math.exp(trend),
                    'logResidual': residual, 'logLimit': limit,
                })
    return issues


class SequenceQuality:
    def __init__(self, before, card_bounds, card_id, native_size, before_sha256=None):
        if isinstance(native_size, bool) or not isinstance(native_size, int) or native_size < 8:
            raise ValueError('Native size must be an integer of at least 8 pixels')
        if len(card_bounds) != 4 or any(isinstance(value, bool) or not isinstance(value, int) for value in card_bounds):
            raise ValueError('Card bounds must contain four integers')
        left, top, right, bottom = card_bounds
        if not (0 <= left < right <= native_size and 0 <= top < bottom <= native_size) or min(right - left, bottom - top) < 8:
            raise ValueError('Invalid card motion bounds')
        self.before, self.bounds, self.card_id, self.native_size = Path(before), card_bounds, card_id, native_size
        content = self.before.read_bytes()
        if before_sha256 is not None and hashlib.sha256(content).hexdigest() != before_sha256:
            raise ValueError('Native cycle-start proof checksum changed')
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            if image.size != (native_size, native_size) or image.mode != 'RGB':
                raise ValueError(f'Expected a {native_size}-pixel RGB native cycle-start proof')
            self.baseline = np.asarray(image).copy()
            self.profile = image.info.get('icc_profile')
        if not self.profile:
            raise ValueError('Native cycle-start proof has no ICC profile')
        self.boxes = [(0, 0, native_size, top), (0, bottom, native_size, native_size),
                      (0, top, left, bottom), (right, top, native_size, bottom)]
        self.exterior = [self.baseline[y0:y1, x0:x1] for x0, y0, x1, y1 in self.boxes]
        self.rows = []
        self.previous = self.first_color = None

    def measure(self, image, frame, sha256):
        if image.size != (self.native_size, self.native_size) or image.mode != 'RGB' or image.info.get('icc_profile') != self.profile:
            raise ValueError(f'Frame {frame} geometry, mode, or ICC mismatch')
        pixels = np.asarray(image)
        static_equal = all(np.array_equal(pixels[b:d, a:c], reference)
                           for (a, b, c, d), reference in zip(self.boxes, self.exterior))
        first_equal = frame != 0 or np.array_equal(pixels, self.baseline)
        metrics, color = frame_metrics(image, self.bounds)
        return {'frame': frame, 'sha256': sha256, 'staticExteriorExact': static_equal,
                'firstRestExact': first_equal, **metrics}, color

    def add(self, row, color):
        if row['frame'] != len(self.rows) or len(self.rows) >= FRAME_COUNT:
            raise ValueError('Native quality frame order or count changed')
        if self.previous is None:
            self.first_color = color
        else:
            row['previousRGBMAE'] = float(np.abs(color - self.previous).mean())
        self.previous = color
        self.rows.append(row)

    def finish(self, after, output, after_sha256=None):
        if len(self.rows) != FRAME_COUNT:
            raise ValueError(f'Expected exactly {FRAME_COUNT} native quality frames')
        after, output = Path(after), Path(output)
        self.rows[0]['previousRGBMAE'] = float(np.abs(self.first_color - self.previous).mean())
        content = after.read_bytes()
        if after_sha256 is not None and hashlib.sha256(content).hexdigest() != after_sha256:
            raise ValueError('Native cycle-end proof checksum changed')
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            repeat_exact = image.size == (self.native_size, self.native_size) and image.mode == 'RGB' \
                and image.info.get('icc_profile') == self.profile and np.array_equal(np.asarray(image), self.baseline)
        issues = [] if repeat_exact else [{'type': 'rest-repeat'}]
        for row in self.rows:
            if not row['staticExteriorExact'] or not row['firstRestExact']:
                issues.append({'frame': row['frame'], 'type': 'static-or-rest-pixels'})
        issues.extend(temporal_issues(self.rows))
        report = {
            'passed': not issues, 'cardId': self.card_id, 'frameCount': len(self.rows), 'frames': self.rows,
            'nativeSize': self.native_size, 'nativeIccSha256': hashlib.sha256(self.profile).hexdigest(),
            'staticBounds': self.bounds, 'before': str(self.before.resolve()), 'after': str(after.resolve()),
            'restRepeatExact': repeat_exact, 'controlPose': 'cycle-start',
            'detailCheckAvailable': all(row['gradientEnergy'] >= .1 for row in self.rows),
            'issues': issues, 'maximumAdjacentRGBMAE': max(row['previousRGBMAE'] for row in self.rows),
            'detailMethod': 'Integrated gradient, Laplacian, and their ratio over the complete bounded moving card; cyclic local log-change trends',
            'thresholds': {
                'colorMae': COLOR_MAE_FLOOR, 'localColorRatio': COLOR_LOCAL_RATIO,
                'detailRelativeChangeFloors': DETAIL_DEVIATIONS, 'localRadiusFrames': TEMPORAL_RADIUS,
                'robustStandardDeviations': ROBUST_DEVIATIONS, 'metricMaximumLongEdge': METRIC_LONG_EDGE,
                'colorMaximumLongEdge': COLOR_LONG_EDGE,
                'rationale': '10–15% single-transition floors allow perspective resampling and subpixel edge motion; six local robust deviations adapt to normal foil and rasterization variation.',
            },
            'limitations': [
                'Temporal checks identify abrupt changes, not uniform or slowly developing blur across the entire sequence.',
                'Aggregate detail checks may miss small localized defects; per-frame geometry is validated separately by the capture runner.',
            ],
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        pending = output.with_name(f'.{output.name}.pending')
        pending.write_text(json.dumps(report, indent=2) + '\n')
        pending.replace(output)
        return report


def audit_sequence(frames, before, after, output, card_bounds, card_id, native_size):
    quality = SequenceQuality(before, card_bounds, card_id, native_size)
    names = [f'{frame:04d}.png' for frame in range(FRAME_COUNT)]
    if sorted(path.name for path in frames.glob('*.png')) != names:
        raise ValueError(f'Expected exactly {FRAME_COUNT} numbered native PNGs')

    def load(frame):
        content = (frames / names[frame]).read_bytes()
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            return quality.measure(image, frame, hashlib.sha256(content).hexdigest())

    with ThreadPoolExecutor(max_workers=4) as pool:
        for row, color in pool.map(load, range(FRAME_COUNT)):
            quality.add(row, color)
    return quality.finish(after, output)


def main():
    parser = argparse.ArgumentParser(description='Audit native tilted Mi Note frames before encoding')
    parser.add_argument('--frames', type=Path, required=True)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--card-id', type=int, required=True)
    parser.add_argument('--card-bounds', type=json.loads, required=True)
    parser.add_argument('--native-size', type=int, required=True)
    args = parser.parse_args()
    if args.card_id < 1:
        parser.error('Invalid card ID')
    report = audit_sequence(args.frames, args.before, args.after, args.output, args.card_bounds, args.card_id, args.native_size)
    print(json.dumps({
        'passed': report['passed'], 'cardId': args.card_id, 'frames': report['frameCount'],
        'issues': report['issues'], 'report': str(args.output.resolve()),
    }))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
