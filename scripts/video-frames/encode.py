import json
import math
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

from media import MAX_MOVIE_BYTES
from verify import movie_tick


def screen_filters(index, corners):
    xs, ys = zip(*corners)
    left = max(0, math.floor(min(xs)) - 2)
    top = max(0, math.floor(min(ys)) - 2)
    width = min(1440, math.ceil(max(xs)) + 2) - left
    height = min(1440, math.ceil(max(ys)) + 2) - top
    # FFmpeg uses TL, TR, BL, BR, while the projected corners wind clockwise.
    warp = ":".join(
        f"x{i}={x-left:.6f}:y{i}={y-top:.6f}"
        for i, (x, y) in enumerate(corners[j] for j in (0, 1, 3, 2))
    )
    return [
        f"[source{index}]scale={width}:{height}:flags=lanczos+accurate_rnd:"
        f"in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,format=yuv444p,"
        f"perspective={warp}:sense=destination:interpolation=cubic[screen{index}]",
        f"[{index+2}:v]format=gray,crop={width}:{height}:{left}:{top}[mask{index}]",
        f"[screen{index}][mask{index}]alphamerge[layer{index}]",
        f"[plate{index}][layer{index}]overlay=x={left}:y={top}:eval=init:"
        f"shortest=1:format=yuv444:alpha=straight[plate{index+1}]",
    ]


def encode(source, studio, output, *, fps, transfer, duration, audio, source_filter):
    screens = json.loads((studio / "screens.json").read_text())
    audio_base = Fraction(audio["time_base"]) if audio else Fraction(1)
    timescale = math.lcm(fps.numerator, audio_base.denominator)
    if timescale >= 2**31:
        raise ValueError("Video and audio clocks exceed the MP4 movie timescale limit")
    audio_options = ["-c:a", "copy"]
    available = MAX_MOVIE_BYTES
    if audio:
        probe = subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=size,pts,duration",
            "-of", "json", source,
        ])
        packets = json.loads(probe)["packets"]
        if not packets:
            raise ValueError(f"{source}: audio stream has no packets")
        available -= sum(int(packet["size"]) for packet in packets)
        end = (int(audio["start_pts"]) + int(audio["duration_ts"])) * audio_base
        last = packets[-1]
        packet_end = (int(last["pts"]) + int(last["duration"])) * audio_base
        if abs(packet_end - end) > movie_tick(source) + Fraction(1, timescale):
            audio_options += ["-bsf:a", f"setts=duration='if(eq(NEXT_PTS,NOPTS),max(0,round({end}/TB)-PTS),DURATION)'"]
    if available <= 0:
        raise ValueError(f"{source}: copied audio alone exhausts the 15 MB output limit")
    # Leave room for muxing and the encoder's initial VBV buffer.
    video_bytes = min(9_800_000, available * .98)
    maxrate = max(1000, int(video_bytes * 8 / (duration + 1)))
    inputs = ["-i", source, "-framerate", str(fps), "-i", studio / "plate.png"]
    plate = "[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv444p"
    if transfer == "bt709":
        plate += ",colorspace=iall=bt709:itrc=srgb:all=bt709:irange=tv:range=tv"
    filters = [
        plate + ",loop=loop=-1:size=1:start=0[plate0]",
    ]
    labels = "".join(f"[source{i}]" for i in range(len(screens)))
    fit = source_filter + "," if source_filter else ""
    filters.append(f"[0:v]{fit}split={len(screens)}{labels}")
    for index, corners in enumerate(screens):
        inputs.extend(["-i", studio / f"mask-{index}.png"])
        filters.extend(screen_filters(index, corners))
    filters.append(
        f"[plate{len(screens)}]format=yuv420p,setsar=1,"
        f"setparams=range=limited:colorspace=bt709:color_primaries=bt709:color_trc={transfer}[out]"
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as stage:
        rendered = Path(stage) / "encoded.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-filter_complex_threads", "4",
            *inputs, "-filter_complex", ";".join(filters), "-map", "[out]", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-threads", "6",
            "-maxrate", str(maxrate), "-bufsize", str(maxrate), "-fps_mode", "passthrough",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", transfer,
            "-color_range", "tv", *audio_options, "-write_tmcd", "0", "-movflags", "+faststart",
            "-movie_timescale", str(timescale), rendered,
        ], check=True)
        if rendered.stat().st_size > MAX_MOVIE_BYTES:
            raise ValueError(f"{output.name} exceeds 15 MB")
        rendered.replace(output)
