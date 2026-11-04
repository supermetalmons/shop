import json
import struct
import subprocess
from fractions import Fraction

from media import MAX_MOVIE_BYTES

BT709_TO_SRGB = "colorspace=iall=bt709:all=bt709:trc=srgb:irange=tv:range=tv"

FFMPEG = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror"]


def streams(path, *, media_only=False):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", path],
        check=True, capture_output=True,
    )
    tracks = json.loads(result.stdout)["streams"]
    if media_only:
        tracks = [track for track in tracks if track["codec_type"] in ("audio", "video")]
    if sorted(track["codec_type"] for track in tracks) not in (["video"], ["audio", "video"]):
        raise ValueError(f"{path}: expected one video stream and at most one audio stream")
    return {track["codec_type"]: track for track in tracks}


def mp4_boxes(movie, end):
    while movie.tell() + 8 <= end:
        offset = movie.tell()
        size, kind = struct.unpack(">I4s", movie.read(8))
        header = 8
        if size == 1:
            extended = movie.read(8)
            if len(extended) != 8:
                return
            size, = struct.unpack(">Q", extended)
            header = 16
        if size == 0:
            size = end - offset
        if size < header or offset + size > end:
            return
        yield kind, offset + size
        movie.seek(offset + size)


def fast_start(path):
    with path.open("rb") as movie:
        for kind, _ in mp4_boxes(movie, path.stat().st_size):
            if kind in (b"moov", b"mdat"):
                return kind == b"moov"
    return False


def movie_tick(path):
    with path.open("rb") as movie:
        for kind, end in mp4_boxes(movie, path.stat().st_size):
            if kind == b"moov":
                for child, limit in mp4_boxes(movie, end):
                    if child == b"mvhd":
                        header = movie.read(min(24, limit - movie.tell()))
                        offset = 20 if header and header[0] == 1 else 12
                        if len(header) >= offset + 4:
                            scale, = struct.unpack_from(">I", header, offset)
                            if scale:
                                return Fraction(1, scale)
    return Fraction(0)


def audio_packets(path, time_base):
    packets = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "packet=pts,duration:packet_side_data=skip_samples,discard_padding", "-of", "json", path,
    ]))["packets"]
    return [(int(packet["pts"]) * time_base, int(packet["duration"]) * time_base,
             [(side.get("skip_samples", 0), side.get("discard_padding", 0))
              for side in packet.get("side_data_list", [])
              if side.get("skip_samples", 0) or side.get("discard_padding", 0)]) for packet in packets]


def check_audio_timing(source, output, original, encoded):
    old_base, new_base = Fraction(original["time_base"]), Fraction(encoded["time_base"])
    if int(original["start_pts"]) * old_base != int(encoded["start_pts"]) * new_base:
        raise ValueError(f"{output}: audio start differs from source")
    if audio_packets(source, old_base) != audio_packets(output, new_base):
        raise ValueError(f"{output}: audio packet timeline differs from source")
    old_duration = int(original["duration_ts"]) * old_base
    new_duration = int(encoded["duration_ts"]) * new_base
    # MP4 edit duration labels are rounded to their movie clocks, independently of the copied samples.
    if abs(old_duration - new_duration) > movie_tick(source) + movie_tick(output):
        raise ValueError(f"{output}: audio edit duration differs from source")


def audio_hash(path):
    result = subprocess.run(
        [*FFMPEG, "-i", path, "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", "-"],
        check=True, stdout=subprocess.PIPE,
    )
    return result.stdout


def midpoint_filter(frame_count, transfer):
    select = f"select=eq(n\\,{frame_count // 2})"
    if transfer == "bt709":
        return select + "," + BT709_TO_SRGB
    return select


def check_movie(path, frame_count, fps, transfer, source_audio, source_hash, samples, *, source):
    size = path.stat().st_size
    if size > MAX_MOVIE_BYTES or not fast_start(path):
        raise ValueError(f"{path}: exceeds 15 MB or lacks MP4 fast-start layout")
    tracks = streams(path)
    video = tracks["video"]
    expected = {
        "codec_name": "h264", "width": 1440, "height": 1440, "pix_fmt": "yuv420p",
        "color_space": "bt709", "color_transfer": transfer, "color_primaries": "bt709",
        "sample_aspect_ratio": "1:1", "start_pts": 0, "nb_frames": str(frame_count),
    }
    for key, value in expected.items():
        if video.get(key) != value:
            raise ValueError(f"{path}: {key} is {video.get(key)!r}, expected {value!r}")
    duration = Fraction(video["time_base"]) * int(video["duration_ts"])
    if duration != Fraction(frame_count, fps) or Fraction(video["avg_frame_rate"]) != fps:
        raise ValueError(f"{path}: incorrect video timing")
    if ("audio" in tracks) != (source_audio is not None):
        raise ValueError(f"{path}: audio stream presence differs from source")
    audio_output = []
    if source_audio is not None:
        for key in ("codec_name", "sample_rate", "channels"):
            if tracks["audio"].get(key) != source_audio.get(key):
                raise ValueError(f"{path}: audio {key} differs from source")
        check_audio_timing(source, path, source_audio, tracks["audio"])
        audio_output = ["-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", samples / "audio.sha256"]
    result = subprocess.run([
        *FFMPEG, "-i", path, "-stats_enc_pre", "pipe:1", "-stats_enc_pre_fmt", "{ptsi} {tbi}",
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-",
        *audio_output,
        "-map", "0:v:0", "-vf", midpoint_filter(frame_count, transfer) + ",scale=424:424:flags=lanczos+accurate_rnd+full_chroma_int",
        "-fps_mode", "passthrough", "-threads:v", "1", "-update", "1", samples / "midpoint.png",
    ], check=True, stdout=subprocess.PIPE, text=True)
    timestamps = result.stdout.splitlines()
    if len(timestamps) != frame_count:
        raise ValueError(f"{path}: decoded {len(timestamps)}, expected {frame_count} frames")
    for index, line in enumerate(timestamps):
        pts, base = line.split()
        time_base = Fraction(base)
        if time_base <= 0 or int(pts) * time_base != Fraction(index, fps):
            raise ValueError(f"{path}: frame {index} has incorrect presentation timestamp {pts} × {base}")
    if source_hash is not None and (samples / "audio.sha256").read_bytes() != source_hash:
        raise ValueError(f"{path}: decoded audio differs from source")
    print(f"{path.parent.name}/{path.name}    {frame_count} frames    {size / 1_000_000:.3f} MB", flush=True)
    return size


def thumbnail(path, picture_filter):
    pixels = subprocess.check_output([
        *FFMPEG, "-i", path, "-vf", f"{picture_filter},scale=32:18:flags=area:in_color_matrix=bt709",
        "-frames:v", "1", "-an", "-pix_fmt", "rgb24", "-threads:v", "1", "-f", "rawvideo", "-",
    ])
    if len(pixels) != 32 * 18 * 3:
        raise ValueError(f"{path}: missing midpoint image")
    return pixels
