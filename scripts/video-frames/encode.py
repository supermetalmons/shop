import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path


BT709_TO_SRGB = "colorspace=iall=bt709:all=bt709:trc=srgb:irange=tv:range=tv"


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


def encode(source, studio, output):
    screens = json.loads((studio / "screens.json").read_text())
    probe = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,avg_frame_rate,duration,bit_rate,color_transfer", "-of", "json", source,
    ])
    streams = json.loads(probe)["streams"]
    video = next(stream for stream in streams if stream["codec_type"] == "video")
    audio = next((stream for stream in streams if stream["codec_type"] == "audio"), None)
    fps = video["avg_frame_rate"]
    transfer = "iec61966-2-1" if video.get("color_transfer") == "iec61966-2-1" else "bt709"
    duration = float(video["duration"])
    # Reserve space for muxing, audio, and the encoder's initial VBV buffer.
    audio_bits = float(audio["duration"]) * int(audio["bit_rate"]) if audio else 0
    maxrate = int((9_800_000 * 8 - audio_bits) / (duration + 1))
    inputs = ["-i", source, "-framerate", fps, "-i", studio / "plate.png"]
    plate = "[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv444p"
    if transfer == "iec61966-2-1":
        # The approved plate values were mastered as BT.709.
        plate += "," + BT709_TO_SRGB
    filters = [
        plate + ",loop=loop=-1:size=1:start=0[plate0]",
    ]
    labels = "".join(f"[source{i}]" for i in range(len(screens)))
    filters.append(f"[0:v]split={len(screens)}{labels}")
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
            "-color_range", "tv", "-c:a", "copy", "-movflags", "+faststart", rendered,
        ], check=True)
        if rendered.stat().st_size > 15_000_000:
            raise ValueError(f"{output.name} exceeds 15 MB")
        rendered.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("studio", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    encode(args.source, args.studio, args.output)
