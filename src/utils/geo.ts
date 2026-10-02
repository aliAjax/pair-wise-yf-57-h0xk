/**
 * 地理与时间工具：haversine 距离、ISO 时间解析、格式化。
 */

/** 两点间球面距离（米）。 */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 解析时间字符串为毫秒；兼容 ISO 与 'YYYY-MM-DD HH:mm'。 */
export function parseMs(s: string): number {
  if (!s) return NaN;
  const t = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(t).getTime();
}

/** 格式化为 HH:mm。 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化时间范围 HH:mm – HH:mm。 */
export function fmtRange(start: string, end: string): string {
  return `${fmtTime(start)} – ${fmtTime(end)}`;
}
