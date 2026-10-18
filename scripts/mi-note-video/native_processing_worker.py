from collections import deque
from concurrent.futures import ProcessPoolExecutor
import hashlib
import io
import json
import multiprocessing
from pathlib import Path
import signal
import sys

from PIL import Image

import frames
import quality
from processing_worker import ProcessingSession, checksum
from video_validation import regular


_preparation_context = None


def initialize_preparation(configuration):
    global _preparation_context
    sequence = quality.SequenceQuality(regular(configuration['before']), configuration['bounds'],
                                       configuration['cardId'], configuration['nativeSize'],
                                       checksum(configuration['beforeSha256']))
    sequence.baseline.flags.writeable = False
    _preparation_context = (sequence, Path(configuration['preparedDirectory']),
                            configuration['space'], configuration['size'])


def prepare_frame(args):
    sequence, directory, space, size = _preparation_context
    source = regular(args['input'])
    content = source.read_bytes()
    source_hash = hashlib.sha256(content).hexdigest()
    if source_hash != checksum(args['sha256']):
        raise ValueError('Native processing frame checksum changed')
    destination = directory / source.name
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        row, color = sequence.measure(image, args['frame'], source_hash)
        if not row['staticExteriorExact'] or not row['firstRestExact']:
            raise ValueError('Native processing frame static or rest pixels changed')
        preparation = frames.prepare_loaded_frame(image, source, destination, space, size=size, black_padding=True)
    return row, color, preparation, source_hash


class NativeProcessingSession(ProcessingSession):
    def __init__(self, args):
        self.pool = None
        self.pending = deque()
        self.submitted = 0
        self.workers = frames.integer(args.get('workers', 2), 'preparation worker count', 1)
        self.capacity = frames.integer(args.get('capacity', self.workers + 1), 'preparation capacity', 1)
        if self.workers > 3 or not self.workers <= self.capacity <= 4:
            raise ValueError('Native preparation requires one to three workers and capacity between workers and four')
        super().__init__(args)
        try:
            self.pool = ProcessPoolExecutor(max_workers=self.workers, mp_context=multiprocessing.get_context('spawn'),
                                            initializer=initialize_preparation, initargs=(args,))
        except BaseException:
            self.close()
            raise

    def commit(self):
        frame, source, source_hash, future = self.pending.popleft()
        row, color, preparation, measured_hash = future.result()
        if frame != len(self.preparations) or row['frame'] != frame or measured_hash != source_hash:
            raise ValueError('Parallel native preparation identity or order changed')
        destination = self.prepared / source.name
        if preparation['path'] != str(destination) or preparation['input'] != str(source):
            raise ValueError('Parallel native preparation location changed')
        prepared = destination.read_bytes()
        self.encoder.write(frame, prepared)
        self.quality.add(row, color)
        self.preparations.append(preparation)
        return {'frame': frame, 'sourceSha256': source_hash, 'preparedSha256': hashlib.sha256(prepared).hexdigest(),
                'preparation': preparation, 'qualityRow': row}

    def frame(self, args):
        if self.finished or self.failed or self.quality_result is not None:
            raise ValueError('Processing session is closed')
        frame = args['frame']
        if type(frame) is not int or frame != self.submitted or frame >= frames.FRAME_COUNT:
            raise ValueError('Native processing frame order or count changed')
        source = regular(args['input'])
        if source.name != f'{frame:04d}.png' or (self.source is not None and source.parent != self.source):
            raise ValueError('Native processing frame location changed')
        source_hash = checksum(args['sha256'])
        completed = []
        while self.pending and self.pending[0][3].done():
            completed.append(self.commit())
        if len(self.pending) >= self.capacity:
            completed.append(self.commit())
        future = self.pool.submit(prepare_frame, {'frame': frame, 'input': str(source), 'sha256': source_hash})
        self.pending.append((frame, source, source_hash, future))
        self.source = source.parent
        self.submitted += 1
        return {'acceptedFrame': frame, 'acceptedSha256': source_hash, 'completed': completed}

    def validate_quality(self, args):
        if self.submitted != frames.FRAME_COUNT:
            raise ValueError(f'Expected exactly {frames.FRAME_COUNT} submitted native frames')
        completed = []
        while self.pending:
            completed.append(self.commit())
        self.pool.shutdown(wait=True)
        self.pool = None
        return {**super().validate_quality(args), 'completed': completed}

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=True, cancel_futures=True)
            self.pool = None
        super().close()


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
                    session = NativeProcessingSession(args)
                    result = {'ready': True, 'cardId': session.card_id, 'workers': session.workers, 'capacity': session.capacity}
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
