export function fmtTime(ts?: string): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('ko-KR', { hour12: false });
}

export function ageFrom(ts?: string): string {
  if (!ts) return '-';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '-';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
