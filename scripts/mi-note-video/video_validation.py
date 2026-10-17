import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
from fractions import Fraction
import zlib


SOURCE = 'scripts/mi-note-video/video_validation.py'
CONTRACT_PATH = Path(__file__).with_name('contract.json')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def regular(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and path.is_file(), 'Expected a regular validation file: ' + str(path))
    return path


def executables():
    import sys
    paths = {'python': sys.executable}
    for name in ('ffmpeg', 'ffprobe'):
        paths[name] = os.environ.get('MI_NOTE_' + name.upper()) or shutil.which(name)
        require(paths[name], name + ' is required for video validation')
    return paths


def validator_identity(paths):
    versions = {'python': platform.python_version()}
    for name in ('ffmpeg', 'ffprobe'):
        result = subprocess.run([paths[name], '-version'], check=True, capture_output=True, text=True)
        versions[name] = result.stdout.splitlines()[0].split()[2]
    return {'source': SOURCE, 'sha256': digest(Path(__file__).resolve()), 'contractSha256': digest(CONTRACT_PATH),
            'executableSha256': {name: digest(path) for name, path in paths.items()}, 'versions': versions}


def validate_stream(stream, size, space, frame_count, fps):
    expected = {'codec_type': 'video', 'codec_name': 'hevc' if space == 'p3' else 'h264',
                'width': size, 'height': size, 'pix_fmt': 'yuv420p10le' if space == 'p3' else 'yuv420p',
                'color_range': 'tv', 'color_space': 'bt709', 'color_transfer': 'iec61966-2-1',
                'color_primaries': 'smpte432' if space == 'p3' else 'bt709'}
    if space == 'p3':
        expected.update({'profile': 'Main 10', 'codec_tag_string': 'hvc1'})
    for key, value in expected.items():
        require(stream.get(key) == value, 'Video stream mismatch: ' + key)
    require(Fraction(stream['avg_frame_rate']) == fps, 'Video frame rate changed')
    require(int(stream['nb_frames']) == frame_count, 'Video declared frame count changed')
    require(abs(float(stream['duration']) - frame_count / fps) <= .001, 'Video duration changed')


def decoded_records(path, frame_count, fps, frame_bytes):
    rows, time_base = [], None
    for line in regular(path).read_text().splitlines():
        if line.startswith('#tb 0: '):
            time_base = Fraction(line.removeprefix('#tb 0: '))
        elif line and not line.startswith('#'):
            fields = [part.strip() for part in line.split(',')]
            require(len(fields) >= 6 and re.fullmatch(r'0x[0-9a-fA-F]{8}', fields[5]), 'Invalid decoded frame evidence')
            stream, dts, pts, duration, size = map(int, fields[:5])
            require(stream == 0 and size == frame_bytes and duration > 0 and dts == pts, 'Decoded frame properties changed')
            rows.append({'pts': pts, 'crc': int(fields[5], 16)})
    require(time_base is not None and len(rows) == frame_count, 'Decoded frame count changed')
    require(all(row['pts'] * time_base == Fraction(index, fps) for index, row in enumerate(rows)), 'Decoded frame order or timing changed')
    return rows


def describe(path):
    path = regular(path)
    return {'path': str(path), 'sha256': digest(path), 'bytes': path.stat().st_size}


def strict_decode(video_path, directory, size, space='p3', frame_count=276, fps=60, sample_frames=None):
    video_path = regular(Path(video_path).resolve())
    directory = Path(directory).resolve()
    require(not directory.exists(), 'Validation output already exists: ' + str(directory))
    sample_frames = [0, 69, 138, 207, 275] if sample_frames is None else list(sample_frames)
    require(sample_frames == sorted(set(sample_frames)) and all(type(frame) is int and 0 <= frame < frame_count for frame in sample_frames), 'Invalid decoded sample frames')
    paths = executables()
    identity = validator_identity(paths)
    video_hash, video_bytes = digest(video_path), video_path.stat().st_size
    probe = subprocess.run([paths['ffprobe'], '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(video_path)],
                           check=True, capture_output=True, text=True, timeout=300)
    streams = json.loads(probe.stdout).get('streams', [])
    require(len(streams) == 1, 'Expected exactly one video stream')
    stream = streams[0]
    validate_stream(stream, size, space, frame_count, fps)
    directory.mkdir(parents=True)
    count_path, raw_path = directory / 'decoded.framecrc', directory / 'samples.raw'
    pixel_format = 'yuv420p10le' if space == 'p3' else 'yuv420p'
    frame_bytes = size * size * 3 if space == 'p3' else size * size * 3 // 2
    command = [paths['ffmpeg'], '-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-n', '-i', str(video_path)]
    if sample_frames:
        selection = '+'.join(f'eq(n\\,{frame})' for frame in sample_frames)
        command.extend(['-filter_complex', f'[0:v:0]split=2[all][samples];[samples]select={selection}[selected]', '-map', '[all]'])
    else:
        command.extend(['-map', '0:v:0'])
    command.extend(['-an', '-c:v', 'rawvideo', '-pix_fmt', pixel_format, '-fps_mode', 'passthrough',
                    '-enc_time_base', f'1:{fps}', '-f', 'framecrc', str(count_path)])
    if sample_frames:
        command.extend(['-map', '[selected]', '-an', '-c:v', 'rawvideo', '-pix_fmt', pixel_format,
                        '-fps_mode', 'passthrough', '-f', 'rawvideo', str(raw_path)])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=300)
    rows = decoded_records(count_path, frame_count, fps, frame_bytes)
    samples = []
    if sample_frames:
        require(raw_path.stat().st_size == len(sample_frames) * frame_bytes, 'Decoded sample byte count changed')
        with raw_path.open('rb') as source:
            for frame in sample_frames:
                data = source.read(frame_bytes)
                require(zlib.adler32(data, 0) == rows[frame]['crc'], 'Decoded sample differs from counted frame')
                path = directory / f'{frame:04d}.yuv'
                with path.open('xb') as output:
                    output.write(data)
                samples.append({'frame': frame, **describe(path), 'pixelFormat': pixel_format, 'width': size, 'height': size})
        raw_path.unlink()
    require(digest(video_path) == video_hash and video_path.stat().st_size == video_bytes, 'Video changed during validation')
    stream['nb_read_frames'] = str(len(rows))
    certificate = {'version': 1, 'kind': 'mi-note-video-decode', 'videoSha256': video_hash, 'videoBytes': video_bytes,
                   'fullyDecoded': True, 'decodedFrames': len(rows), 'stream': stream, 'validator': identity,
                   'countEvidence': describe(count_path), 'samples': samples}
    for file in [count_path, *(Path(sample['path']) for sample in samples)]:
        with file.open('rb') as source:
            os.fsync(source.fileno())
    path = directory / 'certificate.json'
    with path.open('x') as output:
        json.dump(certificate, output, indent=2, allow_nan=False)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return certificate, {'path': str(path), 'sha256': digest(path)}


def verify_certificate(job, video, path, source_root, verify_samples=True, executable_paths=None):
    path = regular(path)
    descriptor = video.get('decodeCertificate', {})
    require(descriptor.get('path') == str(path) and descriptor.get('sha256') == digest(path), 'Decode certificate checksum changed')
    certificate = json.loads(path.read_text())
    require(certificate.get('version') == 1 and certificate.get('kind') == 'mi-note-video-decode'
            and certificate.get('fullyDecoded') is True, 'Invalid decode certificate')
    require(certificate.get('videoSha256') == video['sha256'] and certificate.get('videoBytes') == video['bytes'], 'Decode certificate belongs to another video')
    root = Path(source_root).resolve()
    contract_path = root / 'scripts/mi-note-video/contract.json'
    contract = json.loads(regular(contract_path).read_text())
    recipe = contract['video']
    size = contract['profiles'][job['profile']]['deliverySize']
    validator = certificate['validator']
    require(validator.get('source') == SOURCE and validator.get('sha256') == digest(regular(root / SOURCE)), 'Decode validator source changed')
    require(validator.get('contractSha256') == digest(contract_path) == job['contractSha256'], 'Decode contract changed')
    for name in ('python', 'ffmpeg', 'ffprobe'):
        expected_hash = job['runtime']['executableSha256'][name]
        require(validator.get('executableSha256', {}).get(name) == expected_hash, 'Decode runtime executable changed: ' + name)
        require(validator.get('versions', {}).get(name) == job['runtime']['versions'][name], 'Decode runtime version changed: ' + name)
        if executable_paths is not None:
            require(name in executable_paths and digest(executable_paths[name]) == expected_hash, 'Current decode executable changed: ' + name)
    validate_stream(certificate['stream'], size, recipe['space'], recipe['frames'], recipe['frameRate'])
    require(certificate['stream'] == video['stream'] and certificate.get('decodedFrames') == recipe['frames']
            and certificate['stream'].get('nb_read_frames') == str(recipe['frames']), 'Decode certificate stream differs from video')
    evidence = certificate['countEvidence']
    count_path = regular(evidence['path'])
    require(count_path.parent == path.parent and count_path.name == 'decoded.framecrc'
            and count_path.stat().st_size == evidence['bytes'] and digest(count_path) == evidence['sha256'], 'Decoded count evidence changed')
    rows = decoded_records(count_path, recipe['frames'], recipe['frameRate'], size * size * 3)
    samples = certificate['samples']
    require([item['frame'] for item in samples] == contract['capture']['controlFrames'], 'Decoded sample selection changed')
    for sample in samples:
        require(sample.get('pixelFormat') == recipe['pixelFormat'] and sample.get('width') == size and sample.get('height') == size
                and sample.get('bytes') == size * size * 3, 'Decoded sample format changed')
        sample_path = Path(sample['path'])
        require(sample_path.parent == path.parent and sample_path.name == f"{sample['frame']:04d}.yuv", 'Decoded sample location changed')
        if verify_samples:
            data = regular(sample_path).read_bytes()
            require(len(data) == sample['bytes'] and hashlib.sha256(data).hexdigest() == sample['sha256']
                    and zlib.adler32(data, 0) == rows[sample['frame']]['crc'], 'Decoded sample checksum changed')
    return {'fullyDecoded': True, 'stream': certificate['stream'], 'certificateSha256': descriptor['sha256'],
            'decodedFrames': len(rows), 'validator': validator}
