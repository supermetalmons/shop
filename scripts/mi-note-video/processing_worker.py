import hashlib
import io
import json
from pathlib import Path
import re
import signal
import sys

from PIL import Image

import frames
import quality
from video_validation import regular


def checksum(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        raise ValueError('Expected a SHA-256 checksum')
    return value


def new_path(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path or path.exists():
        raise ValueError('Expected a new absolute output: ' + str(path))
    return path


class ProcessingSession:
    def __init__(self, args):
        self.encoder = None
        self.finished = False
        self.failed = False
        self.quality_result = None
        self.preparations = []
        self.source = None
        self.card_id = frames.integer(args['cardId'], 'card ID', 1)
        self.native_size = frames.integer(args['nativeSize'], 'native size', 8)
        self.size = frames.integer(args['size'], 'delivery size', 2)
        self.space = args['space']
        if self.space != 'p3' or self.size > self.native_size:
            raise ValueError('Streaming preparation requires non-upscaled Display P3')
        self.prepared = new_path(args['preparedDirectory'])
        self.output = new_path(args['output'])
        self.certificate_directory = new_path(args['certificateDirectory'])
        self.quality = quality.SequenceQuality(regular(args['before']), args['bounds'], self.card_id,
                                              self.native_size, checksum(args['beforeSha256']))
        self.prepared.mkdir(parents=True)
        try:
            self.encoder = frames.PngSequenceEncoder(self.output, self.space, self.size)
        except BaseException:
            self.close()
            raise

    def frame(self, args):
        if self.finished or self.failed or self.quality_result is not None:
            raise ValueError('Processing session is closed')
        frame = args['frame']
        if type(frame) is not int or frame != len(self.preparations) or frame >= frames.FRAME_COUNT:
            raise ValueError('Native processing frame order or count changed')
        source = regular(args['input'])
        if source.name != f'{frame:04d}.png' or (self.source is not None and source.parent != self.source):
            raise ValueError('Native processing frame location changed')
        content = source.read_bytes()
        source_hash = hashlib.sha256(content).hexdigest()
        if source_hash != checksum(args['sha256']):
            raise ValueError('Native processing frame checksum changed')
        destination = self.prepared / source.name
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            row, color = self.quality.measure(image, frame, source_hash)
            if not row['staticExteriorExact'] or not row['firstRestExact']:
                raise ValueError('Native processing frame static or rest pixels changed')
            preparation = frames.prepare_loaded_frame(image, source, destination, self.space, size=self.size, black_padding=True)
        prepared = destination.read_bytes()
        self.encoder.write(frame, prepared)
        self.quality.add(row, color)
        self.preparations.append(preparation)
        self.source = source.parent
        return {'frame': frame, 'sourceSha256': source_hash, 'preparedSha256': hashlib.sha256(prepared).hexdigest(),
                'preparation': preparation, 'qualityRow': row}

    def validate_quality(self, args):
        if self.finished or self.failed or self.quality_result is not None:
            raise ValueError('Processing session is closed')
        if len(self.preparations) != frames.FRAME_COUNT:
            raise ValueError(f'Expected exactly {frames.FRAME_COUNT} processed frames')
        frames.frame_names(self.source)
        frames.frame_names(self.prepared)
        report_path = new_path(args['qualityOutput'])
        report = self.quality.finish(regular(args['after']), report_path, checksum(args['afterSha256']))
        if not report['passed']:
            raise ValueError('Native sequence quality audit failed: ' + json.dumps(report['issues']))
        first = self.preparations[0]
        preparation = {
            'input': str(self.source), 'output': str(self.prepared), 'space': self.space, 'frames': len(self.preparations),
            'width': first['width'], 'height': first['height'], 'mode': 'RGB', 'icc': first['icc'],
            'inputIcc': list({item['inputIcc']['sha256']: item['inputIcc'] for item in self.preparations}.values()),
            'inputProfileAssumed': any(item['inputProfileAssumed'] for item in self.preparations), 'crop': None,
            'capturedSize': first['capturedSize'], 'resample': first['resample'], 'conversion': first['conversion'],
        }
        self.quality_result = {'preparation': preparation, 'qualityReport': report}
        return self.quality_result

    def finish(self, args):
        if self.finished or self.failed:
            raise ValueError('Processing session is closed')
        if self.quality_result is None:
            self.validate_quality(args)
        elif args:
            raise ValueError('Finalization expects the validated quality checkpoint')
        video = self.encoder.finish(self.certificate_directory)
        self.finished = True
        self.close()
        return {**self.quality_result, 'video': video,
                'decodeCertificate': video['decodeCertificate']}

    def close(self):
        if self.encoder is not None:
            self.encoder.close()


def serve(source, destination):
    session = None
    limit = 4 * 1024 * 1024
    try:
        while line := source.readline(limit + 1):
            request_id = None
            try:
                if len(line) > limit or not line.endswith('\n'):
                    raise ValueError('Invalid processing request length or framing')
                request = json.loads(line)
                if not isinstance(request, dict) or type(request.get('id')) is not int or request['id'] < 1 \
                        or not isinstance(request.get('operation'), str) or not isinstance(request.get('args'), dict):
                    raise ValueError('Invalid processing request')
                request_id, operation, args = request['id'], request['operation'], request['args']
                if operation == 'init' and session is None:
                    session = ProcessingSession(args)
                    result = {'ready': True, 'cardId': session.card_id}
                elif operation == 'frame' and session is not None:
                    result = session.frame(args)
                elif operation == 'quality' and session is not None:
                    result = session.validate_quality(args)
                elif operation == 'finish' and session is not None:
                    result = session.finish(args)
                else:
                    raise ValueError('Unexpected processing operation: ' + operation)
                encoded = json.dumps({'id': request_id, 'result': result}, allow_nan=False)
            except Exception as error:
                if session is not None:
                    session.failed = True
                    session.close()
                destination.write(json.dumps({'id': request_id, 'error': {'type': type(error).__name__, 'message': str(error)}}) + '\n')
                destination.flush()
                return 1
            destination.write(encoded + '\n')
            destination.flush()
        return 0 if session is not None and session.finished else 1
    finally:
        if session is not None:
            session.close()


if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    sys.exit(serve(sys.stdin, sys.stdout))
