#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/convert-alpha-video.sh [options] source.mov

Options:
  --out-dir DIR        Output directory. Defaults to ./output next to source.
  --basename NAME      Output basename. Defaults to source filename without extension.
  --poster-time TIME   Poster timestamp passed to ffmpeg -ss. Defaults to 0.
  --webm-crf VALUE     VP9 CRF for WebM alpha output. Defaults to 34.
  --mov-scale WxH      Scale Safari MOV output before avconvert. Defaults to source.
  --webp-quality N     cwebp quality for poster. Defaults to 85.
  -h, --help           Show this help.

Outputs:
  NAME.webm
  NAME.mov
  NAME-poster.webp
USAGE
}

fail() {
  printf 'convert-alpha-video: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

out_dir=''
out_basename=''
poster_time='0'
webm_crf='34'
mov_scale='source'
webp_quality='85'
sources=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 ]] || fail '--out-dir requires a value'
      out_dir="$2"
      shift 2
      ;;
    --basename)
      [[ $# -ge 2 ]] || fail '--basename requires a value'
      out_basename="$2"
      shift 2
      ;;
    --poster-time)
      [[ $# -ge 2 ]] || fail '--poster-time requires a value'
      poster_time="$2"
      shift 2
      ;;
    --webm-crf)
      [[ $# -ge 2 ]] || fail '--webm-crf requires a value'
      webm_crf="$2"
      shift 2
      ;;
    --mov-scale)
      [[ $# -ge 2 ]] || fail '--mov-scale requires a value'
      mov_scale="$2"
      shift 2
      ;;
    --webp-quality)
      [[ $# -ge 2 ]] || fail '--webp-quality requires a value'
      webp_quality="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      sources+=("$@")
      break
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      sources+=("$1")
      shift
      ;;
  esac
done

[[ ${#sources[@]} -eq 1 ]] || fail 'expected exactly one source .mov file'

need_command ffmpeg
need_command avconvert
need_command cwebp

source_file="${sources[0]}"
[[ -f "$source_file" ]] || fail "source file does not exist: $source_file"

source_dir="$(cd "$(dirname "$source_file")" && pwd)"
source_name="$(basename "$source_file")"
source_path="$source_dir/$source_name"
source_stem="${source_name%.*}"

if [[ -z "$out_dir" ]]; then
  out_dir="$source_dir/output"
fi
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

if [[ -z "$out_basename" ]]; then
  out_basename="$source_stem"
fi

[[ "$webm_crf" =~ ^[0-9]+$ ]] || fail "--webm-crf must be an integer: $webm_crf"
[[ "$webp_quality" =~ ^[0-9]+$ ]] || fail "--webp-quality must be an integer: $webp_quality"

if [[ "$mov_scale" =~ ^([0-9]+)x([0-9]+)$ ]]; then
  mov_filter="scale=${BASH_REMATCH[1]}:${BASH_REMATCH[2]}:flags=lanczos,format=yuva444p10le"
elif [[ "$mov_scale" == 'source' || "$mov_scale" == 'original' ]]; then
  mov_filter='format=yuva444p10le'
else
  fail "--mov-scale must be WxH, source, or original: $mov_scale"
fi

webm_out="$out_dir/$out_basename.webm"
mov_out="$out_dir/$out_basename.mov"
poster_out="$out_dir/$out_basename-poster.webp"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

printf 'Writing %s\n' "$webm_out"
ffmpeg -hide_banner -y -i "$source_path" \
  -an \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -b:v 0 \
  -crf "$webm_crf" \
  -deadline good \
  -cpu-used 2 \
  -row-mt 1 \
  -auto-alt-ref 0 \
  -colorspace bt709 \
  -color_primaries bt709 \
  -color_trc bt709 \
  "$webm_out"

printf 'Preparing ProRes alpha intermediate for %s\n' "$mov_out"
ffmpeg -hide_banner -y -i "$source_path" \
  -vf "$mov_filter" \
  -c:v prores_ks \
  -profile:v 4 \
  -pix_fmt yuva444p10le \
  -an \
  -colorspace bt709 \
  -color_primaries bt709 \
  -color_trc bt709 \
  -color_range pc \
  "$tmpdir/original.mov"

printf 'Writing %s\n' "$mov_out"
avconvert \
  -s "$tmpdir/original.mov" \
  -o "$mov_out" \
  -p PresetHEVCHighestQualityWithAlpha \
  --replace \
  --progress

printf 'Writing %s\n' "$poster_out"
ffmpeg -hide_banner -y -ss "$poster_time" -i "$source_path" \
  -frames:v 1 \
  -vf format=rgba \
  -update 1 \
  "$tmpdir/poster.png"
cwebp -quiet -q "$webp_quality" -alpha_q 100 "$tmpdir/poster.png" -o "$poster_out"

ls -lh "$webm_out" "$mov_out" "$poster_out"
