const WEEK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function getBuildInfo(): string {
  const rawBuildDatetime = (import.meta.env?.VITE_BUILD_DATETIME || '').trim();
  if (!rawBuildDatetime) return 'local dev';

  const buildUnixSeconds = Number(rawBuildDatetime);
  if (!Number.isFinite(buildUnixSeconds) || buildUnixSeconds <= 0) return 'local dev';

  const date = new Date(buildUnixSeconds * 1000);
  const day = WEEK_DAYS[date.getDay()] || WEEK_DAYS[0];
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `build ${day} ${hours}:${minutes}`;
}
