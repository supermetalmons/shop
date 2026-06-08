export function prepareMutedAutoplayVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.defaultMuted = true;
  video.muted = true;
  video.volume = 0;
}

export function playMutedAutoplayVideo(video: HTMLVideoElement) {
  prepareMutedAutoplayVideo(video);
  if (!video.paused && !video.ended) return;
  void video.play().catch(() => undefined);
}
