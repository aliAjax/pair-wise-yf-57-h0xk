/**
 * 巡护归并纯逻辑：不依赖 Taro / React，可在 Node 中直接测试。
 * - 轨迹点按时间与间距归成路段
 * - 同一处停留合并为一条代表点
 * - 观察按时间落进对应路段，没落进的列待归位
 * - 容量上限分批淘汰停留最短的点
 */
import { haversine, parseMs } from './geo';

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';

export interface TrackPoint {
  id: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  stay: boolean;
  stayMinutes: number;
  mergedCount: number;
}

export interface TrackSegment {
  id: string;
  name: string;
  pointIds: string[];
  startTime: string;
  endTime: string;
  synced: boolean;
}

export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: 'low' | 'medium' | 'high';
  sync: SyncState;
  reviewed: boolean;
  segmentId: string | null;
}

/* ---------- 归并常量 ---------- */
export const STAY_RADIUS_M = 30; // 同一处停留判定半径
export const STAY_MIN_MINUTES = 3; // 停留至少持续 3 分钟才合并为代表点
export const SEGMENT_TIME_GAP_MIN = 8; // 时间间隔超过 8 分钟断开为新路段
export const SEGMENT_DISTANCE_GAP_M = 300; // 间距超过 300 米断开为新路段
export const MAX_POINTS = 60; // 轨迹点容量上限
export const EVICT_TO = 48; // 容量触发后淘汰到的水位
export const BATTERY_LOW = 20; // 低电量警戒线
export const BATTERY_DRAIN = 2; // 每次定位耗电
export const SAVER_SKIP = 3; // 降频模式下每 3 次尝试只记录 1 次

export const SEED_DATE = '2026-09-29';

/** 兼容旧数据：HH:mm 补日期，'YYYY-MM-DD HH:mm' 转 ISO。 */
export function normalizeAt(s: string): string {
  if (!s) return new Date().toISOString();
  if (/^\d{2}:\d{2}$/.test(s)) return `${SEED_DATE}T${s}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.replace(' ', 'T');
  return s;
}

/**
 * 轨迹点归并为路段：
 * 1) 同一处停留（半径内、持续够久）合并为一条代表点；
 * 2) 相邻代表点时间或间距过大则断开为新路段。
 * 新路段与旧路段共享点 id 时继承 id 与 synced 状态，保证归属稳定。
 */
export function buildSegments(points: TrackPoint[], prevSegments: TrackSegment[]): TrackSegment[] {
  const sorted = [...points].sort((a, b) => parseMs(a.at) - parseMs(b.at));

  // 1. 停留合并
  const reps: TrackPoint[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let latSum = 0;
    let lonSum = 0;
    let count = 0;
    const runStart = sorted[i];
    while (j < sorted.length) {
      const p = sorted[j];
      const centroidLat = count === 0 ? p.latitude : latSum / count;
      const centroidLon = count === 0 ? p.longitude : lonSum / count;
      if (count > 0 && haversine(centroidLat, centroidLon, p.latitude, p.longitude) > STAY_RADIUS_M) break;
      latSum += p.latitude;
      lonSum += p.longitude;
      count += 1;
      j += 1;
    }
    const runEnd = sorted[j - 1];
    const durMin = (parseMs(runEnd.at) - parseMs(runStart.at)) / 60000;
    if (count >= 2 && durMin >= STAY_MIN_MINUTES) {
      reps.push({
        id: `stay-${runStart.id}`,
        latitude: latSum / count,
        longitude: lonSum / count,
        at: runStart.at,
        source: 'gps',
        stay: true,
        stayMinutes: Math.round(durMin),
        mergedCount: count
      });
    } else {
      for (let k = i; k < j; k++) reps.push(sorted[k]);
    }
    i = j;
  }

  // 2. 按时间 / 间距断开为路段
  const groups: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  for (let k = 0; k < reps.length; k++) {
    const p = reps[k];
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const timeGap = (parseMs(p.at) - parseMs(prev.at)) / 60000;
      const distGap = haversine(prev.latitude, prev.longitude, p.latitude, p.longitude);
      if (timeGap > SEGMENT_TIME_GAP_MIN || distGap > SEGMENT_DISTANCE_GAP_M) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(p);
  }
  if (cur.length) groups.push(cur);

  // 3. 继承旧路段 id 与 synced
  const usedPrev = new Set<string>();
  return groups.map((g, idx) => {
    const pointIds = g.map((p) => p.id);
    const startTime = g[0].at;
    const endTime = g[g.length - 1].at;
    let best: TrackSegment | null = null;
    let bestScore = 0;
    for (const ps of prevSegments) {
      if (usedPrev.has(ps.id)) continue;
      const shared = ps.pointIds.filter((id) => pointIds.includes(id)).length;
      if (shared > bestScore) {
        bestScore = shared;
        best = ps;
      }
    }
    if (best && bestScore > 0) {
      usedPrev.add(best.id);
      return { id: best.id, name: best.name, pointIds, startTime, endTime, synced: best.synced };
    }
    return { id: `seg-${Date.now()}-${idx}`, name: `路段 ${idx + 1}`, pointIds, startTime, endTime, synced: false };
  });
}

/**
 * 观察按时间落进对应路段：
 * - 已归属但仍落在路段范围内的保留；
 * - 已归属但范围不再覆盖（如路段被拆分）则改投当前覆盖的路段；
 * - 投不进任何路段的列待归位（segmentId = null）。
 */
export function assignObservationsInPlace(observations: PatrolObservation[], segments: TrackSegment[]) {
  for (const o of observations) {
    const oMs = parseMs(o.time);
    const cur = segments.find((s) => s.id === o.segmentId);
    if (cur && parseMs(cur.startTime) <= oMs && oMs <= parseMs(cur.endTime)) continue;
    const match = segments.find((s) => parseMs(s.startTime) <= oMs && oMs <= parseMs(s.endTime));
    o.segmentId = match ? match.id : null;
  }
}

/**
 * 容量淘汰：分批丢掉停留最短的停留点。
 * 受保护：若某停留点是某路段唯一一点且该路段挂着观察，则不丢，避免观察失去归属。
 */
export function evictPoints(points: TrackPoint[], segments: TrackSegment[], observations: PatrolObservation[]): TrackPoint[] {
  const segHasObs = (segId: string) => observations.some((o) => o.segmentId === segId);
  const arr = [...points];
  while (arr.length > EVICT_TO) {
    let candIdx = -1;
    let candMin = Infinity;
    for (let k = 0; k < arr.length; k++) {
      const p = arr[k];
      if (!p.stay) continue;
      if (p.stayMinutes < candMin) {
        const seg = segments.find((s) => s.pointIds.includes(p.id));
        if (seg && seg.pointIds.length === 1 && segHasObs(seg.id)) continue;
        candMin = p.stayMinutes;
        candIdx = k;
      }
    }
    if (candIdx === -1) break; // 没有可淘汰的停留点
    arr.splice(candIdx, 1);
  }
  return arr;
}
