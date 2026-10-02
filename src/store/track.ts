export type SyncState = 'local' | 'queued' | 'synced' | 'conflict' | 'failed';

export interface TrackPoint {
  id: string;
  latitude: number;
  longitude: number;
  at: number;
  source: 'gps' | 'manual';
  durationMinutes?: number;
}

export interface RouteSegment {
  id: string;
  startAt: number;
  endAt: number;
  representativePointId: string | null;
  representativeLatitude: number;
  representativeLongitude: number;
  pointIds: string[];
  kind: 'stay' | 'route';
  version: number;
  sync: SyncState;
}

export const TRACK_CAPACITY = 10;
export const PRUNE_BATCH_SIZE = Math.max(1, Math.ceil(TRACK_CAPACITY / 4));
export const SEGMENT_GAP_MINUTES = 10;
export const ROUTE_MAX_DISTANCE_METERS = 300;
export const STAY_RADIUS_METERS = 25;
export const NORMAL_SAMPLE_INTERVAL_MINUTES = 1;
export const LOW_BATTERY_THRESHOLD = 20;
export const LOW_BATTERY_SAMPLE_INTERVAL_MINUTES = 5;
export const OBSERVATION_TIME_TOLERANCE_MS = 90_000;

const SEGMENT_GAP_MS = SEGMENT_GAP_MINUTES * 60_000;
const STAY_MERGE_GAP_MS = 2 * 60_000;

export function distanceMeters(aLatitude: number, aLongitude: number, bLatitude: number, bLongitude: number) {
  const radius = 6371000;
  const toRadians = (value: number) => value * Math.PI / 180;
  const deltaLatitude = toRadians(bLatitude - aLatitude);
  const deltaLongitude = toRadians(bLongitude - aLongitude);
  const latitudeAngle = Math.sin(deltaLatitude / 2) ** 2;
  const longitudeAngle = Math.cos(toRadians(aLatitude)) * Math.cos(toRadians(bLatitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(latitudeAngle + longitudeAngle));
}

export function samplingIntervalMinutes(battery: number) {
  return battery <= LOW_BATTERY_THRESHOLD ? LOW_BATTERY_SAMPLE_INTERVAL_MINUTES : NORMAL_SAMPLE_INTERVAL_MINUTES;
}

export function canSampleAt(at: number, battery: number, lastSampleAt: number | null) {
  if (!lastSampleAt) return true;
  return at - lastSampleAt >= samplingIntervalMinutes(battery) * 60_000;
}

export function findStaySegment(segments: RouteSegment[], latitude: number, longitude: number, at: number) {
  return segments.find((segment) => (
    at >= segment.startAt - STAY_MERGE_GAP_MS &&
    at <= segment.endAt + STAY_MERGE_GAP_MS &&
    distanceMeters(latitude, longitude, segment.representativeLatitude, segment.representativeLongitude) <= STAY_RADIUS_METERS
  ));
}

export function segmentAt(segments: RouteSegment[], at: number) {
  return segments.find((segment) => at >= segment.startAt - OBSERVATION_TIME_TOLERANCE_MS && at <= segment.endAt + OBSERVATION_TIME_TOLERANCE_MS) ?? null;
}

interface PointGroup {
  points: TrackPoint[];
  kind: 'stay' | 'route';
}

function groupPoints(points: TrackPoint[]): PointGroup[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const groups: PointGroup[] = [];

  for (const point of sorted) {
    const lastGroup = groups[groups.length - 1];
    const previous = lastGroup?.points[lastGroup.points.length - 1];

    if (!lastGroup || !previous ||
      point.at - previous.at > SEGMENT_GAP_MS ||
      distanceMeters(point.latitude, point.longitude, previous.latitude, previous.longitude) > ROUTE_MAX_DISTANCE_METERS) {
      groups.push({ points: [point], kind: 'stay' });
      continue;
    }

    lastGroup.points.push(point);
    const first = lastGroup.points[0];
    if (lastGroup.kind === 'stay' && distanceMeters(point.latitude, point.longitude, first.latitude, first.longitude) > STAY_RADIUS_METERS) {
      lastGroup.kind = 'route';
    }
  }

  return groups;
}

function signature(segment: Pick<RouteSegment, 'startAt' | 'endAt' | 'kind' | 'representativeLatitude' | 'representativeLongitude'>) {
  return [
    segment.startAt,
    segment.endAt,
    segment.kind,
    segment.representativeLatitude.toFixed(6),
    segment.representativeLongitude.toFixed(6)
  ].join('|');
}

export interface RebuildResult {
  segments: RouteSegment[];
  changedSegmentIds: string[];
}

export function rebuildSegments(points: TrackPoint[], existing: RouteSegment[], createId: () => string): RebuildResult {
  const groups = groupPoints(points);
  const result: RouteSegment[] = [];
  const changedSegmentIds: string[] = [];
  const usedExisting = new Set<string>();

  for (const group of groups) {
    const startPoint = group.points[0];
    const endPoint = group.points[group.points.length - 1];
    let match: RouteSegment | undefined = existing
      .filter((segment) => !usedExisting.has(segment.id) && segment.pointIds.some((id) => group.points.some((point) => point.id === id)))
      .map((segment) => ({ segment, overlap: segment.pointIds.filter((id) => group.points.some((point) => point.id === id)).length }))
      .sort((a, b) => b.overlap - a.overlap || a.segment.startAt - b.segment.startAt)[0]?.segment;

    if (!match) {
      match = existing.find((segment) => {
        if (usedExisting.has(segment.id) || segment.pointIds.length > 0) return false;
        const nearTime = startPoint.at >= segment.startAt - STAY_MERGE_GAP_MS && startPoint.at <= segment.endAt + STAY_MERGE_GAP_MS;
        const nearPlace = distanceMeters(startPoint.latitude, startPoint.longitude, segment.representativeLatitude, segment.representativeLongitude) <= ROUTE_MAX_DISTANCE_METERS;
        return nearTime && nearPlace;
      });
    }

    if (match) {
      usedExisting.add(match.id);
      const representativeStillExists = match.representativePointId && group.points.some((point) => point.id === match.representativePointId);
      const representative = representativeStillExists || match.startAt === startPoint.at
        ? {
            id: representativeStillExists ? match.representativePointId : null,
            latitude: match.representativeLatitude,
            longitude: match.representativeLongitude
          }
        : { id: startPoint.id, latitude: startPoint.latitude, longitude: startPoint.longitude };

      const next: RouteSegment = {
        ...match,
        startAt: Math.min(match.startAt, startPoint.at),
        endAt: Math.max(match.endAt, endPoint.at),
        representativePointId: representative.id,
        representativeLatitude: representative.latitude,
        representativeLongitude: representative.longitude,
        pointIds: group.points.map((point) => point.id),
        kind: group.kind
      };
      const changed = signature(match) !== signature(next);
      if (changed) {
        next.version += 1;
        next.sync = 'queued';
        changedSegmentIds.push(next.id);
      }
      result.push(next);
    } else {
      result.push({
        id: createId(),
        startAt: startPoint.at,
        endAt: endPoint.at,
        representativePointId: startPoint.id,
        representativeLatitude: startPoint.latitude,
        representativeLongitude: startPoint.longitude,
        pointIds: group.points.map((point) => point.id),
        kind: group.kind,
        version: 1,
        sync: 'queued'
      });
    }
  }

  for (const segment of existing) {
    if (!usedExisting.has(segment.id)) result.push(segment);
  }

  return {
    segments: result.sort((a, b) => a.startAt - b.startAt),
    changedSegmentIds
  };
}

export function pointDwellMinutes(point: TrackPoint, segment: RouteSegment, pointsById: Map<string, TrackPoint>) {
  if (typeof point.durationMinutes === 'number') return point.durationMinutes;
  const segmentPoints = segment.pointIds.map((id) => pointsById.get(id)).filter((item): item is TrackPoint => Boolean(item)).sort((a, b) => a.at - b.at);
  if (segment.kind === 'stay') return Math.max(0, (segment.endAt - segment.startAt) / 60000);
  const index = segmentPoints.findIndex((item) => item.id === point.id);
  const previous = segmentPoints[index - 1];
  const next = segmentPoints[index + 1];
  if (previous && next) return (next.at - previous.at) / 120000;
  if (next) return (next.at - point.at) / 60000;
  if (previous) return (point.at - previous.at) / 60000;
  return 0;
}

export interface PruneResult {
  points: TrackPoint[];
  segments: RouteSegment[];
  removedCount: number;
}

export function pruneShortestDwellPoints(points: TrackPoint[], segments: RouteSegment[]): PruneResult {
  if (points.length < TRACK_CAPACITY) return { points, segments, removedCount: 0 };

  const pointsById = new Map(points.map((point) => [point.id, point]));
  const selected = points
    .map((point) => {
      const segment = segments.find((item) => item.pointIds.includes(point.id));
      return { point, dwell: segment ? pointDwellMinutes(point, segment, pointsById) : 0 };
    })
    .sort((a, b) => a.dwell - b.dwell || a.point.at - b.point.at)
    .slice(0, PRUNE_BATCH_SIZE)
    .map((item) => item.point.id);
  const removed = new Set(selected);

  return {
    points: points.filter((point) => !removed.has(point.id)),
    segments: segments.map((segment) => ({
      ...segment,
      pointIds: segment.pointIds.filter((id) => !removed.has(id)),
      representativePointId: segment.representativePointId && removed.has(segment.representativePointId) ? null : segment.representativePointId
    })),
    removedCount: selected.length
  };
}

export function assignPendingObservations<T extends { id: string; at: number; segmentId: string | null }>(observations: T[], segments: RouteSegment[]) {
  return observations.map((observation) => observation.segmentId ? observation : {
    ...observation,
    segmentId: segmentAt(segments, observation.at)?.id ?? null
  });
}

export function formatDateTime(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
