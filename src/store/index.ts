import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import {
  OBSERVATION_TIME_TOLERANCE_MS,
  LOW_BATTERY_SAMPLE_INTERVAL_MINUTES,
  LOW_BATTERY_THRESHOLD,
  NORMAL_SAMPLE_INTERVAL_MINUTES,
  assignPendingObservations,
  canSampleAt,
  findStaySegment,
  pruneShortestDwellPoints,
  rebuildSegments,
  segmentAt,
  TRACK_CAPACITY,
  type SyncState
} from './track';

export type { SyncState, TrackPoint, RouteSegment } from './track';
export {
  LOW_BATTERY_THRESHOLD,
  NORMAL_SAMPLE_INTERVAL_MINUTES,
  LOW_BATTERY_SAMPLE_INTERVAL_MINUTES,
  OBSERVATION_TIME_TOLERANCE_MS,
  TRACK_CAPACITY,
  canSampleAt,
  distanceMeters,
  formatDateTime,
  formatTime,
  samplingIntervalMinutes,
  segmentAt
} from './track';

export interface PatrolObservation {
  id: string;
  at: number;
  note: string;
  risk: 'low' | 'medium' | 'high';
  sync: SyncState;
  reviewed: boolean;
  segmentId: string | null;
}
export interface Sample { id: string; code: string; species: string; count: number; status: 'draft' | 'submitted' | 'verified'; }

interface PatrolState {
  observations: PatrolObservation[];
  points: import('./track').TrackPoint[];
  segments: import('./track').RouteSegment[];
  samples: Sample[];
  conflict: string | null;
  battery: number;
  lastSampleAt: number | null;
  syncNotice: string | null;
  prunedCount: number;
  storageVersion: 2;
}

const createId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const seedTime = (hours: number, minutes = 0) => new Date(2026, 8, 29, hours, minutes).getTime();
const stayStart = seedTime(9, 15);

const seed: PatrolState = {
  observations: [
    {
      id: 'o1',
      at: seedTime(7, 20),
      note: '东坡发现新鲜足迹，沿溪谷方向移动',
      risk: 'medium',
      sync: 'synced',
      reviewed: false,
      segmentId: 'seg-east-ridge'
    },
    {
      id: 'o2',
      at: seedTime(8, 5),
      note: '红外相机外壳松动，已拍照待补报',
      risk: 'high',
      sync: 'queued',
      reviewed: false,
      segmentId: 'seg-camera'
    },
    {
      id: 'o3',
      at: seedTime(8, 40),
      note: '样线南段观察缺少对应轨迹点，等待补轨迹',
      risk: 'low',
      sync: 'failed',
      reviewed: true,
      segmentId: null
    },
    {
      id: 'o4',
      at: stayStart,
      note: '溪边同一处停留，发现两处觅食痕迹',
      risk: 'medium',
      sync: 'queued',
      reviewed: false,
      segmentId: 'seg-stream-stay'
    }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: seedTime(7, 20), source: 'gps' },
    { id: 'p1b', latitude: 30.5825, longitude: 103.2179, at: seedTime(7, 25), source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: seedTime(8, 5), source: 'gps' },
    { id: 'p2b', latitude: 30.5859, longitude: 103.2215, at: seedTime(8, 9), source: 'gps' },
    { id: 'p4', latitude: 30.5902, longitude: 103.2261, at: stayStart, source: 'gps' },
    { id: 'p5', latitude: 30.59021, longitude: 103.22609, at: seedTime(9, 18), source: 'gps' }
  ],
  segments: [
    {
      id: 'seg-east-ridge',
      startAt: seedTime(7, 20),
      endAt: seedTime(7, 25),
      representativePointId: 'p1',
      representativeLatitude: 30.5821,
      representativeLongitude: 103.2174,
      pointIds: ['p1', 'p1b'],
      kind: 'route',
      version: 1,
      sync: 'synced'
    },
    {
      id: 'seg-camera',
      startAt: seedTime(8, 5),
      endAt: seedTime(8, 9),
      representativePointId: 'p2',
      representativeLatitude: 30.5856,
      representativeLongitude: 103.2211,
      pointIds: ['p2', 'p2b'],
      kind: 'route',
      version: 1,
      sync: 'queued'
    },
    {
      id: 'seg-stream-stay',
      startAt: stayStart,
      endAt: seedTime(9, 18),
      representativePointId: 'p4',
      representativeLatitude: 30.5902,
      representativeLongitude: 103.2261,
      pointIds: ['p4', 'p5'],
      kind: 'stay',
      version: 1,
      sync: 'queued'
    }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
  conflict: null,
  battery: 82,
  lastSampleAt: seedTime(9, 18),
  syncNotice: null,
  prunedCount: 0,
  storageVersion: 2
};

function readState(): PatrolState {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state-v2');
    if (!saved) return seed;
    const parsed = JSON.parse(saved) as PatrolState;
    return parsed.storageVersion === 2 && Array.isArray(parsed.segments) ? parsed : seed;
  } catch {
    return seed;
  }
}

function invalidateChangedObservations(state: PatrolState, changedSegmentIds: string[]) {
  if (!changedSegmentIds.length) return;
  const changed = new Set(changedSegmentIds);
  state.observations = state.observations.map((observation) => (
    observation.segmentId && changed.has(observation.segmentId)
      ? { ...observation, segmentId: null, sync: 'queued' }
      : observation
  ));
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: PatrolObservation['risk']; at?: number }>) => {
      const at = action.payload.at ?? Date.now();
      const segment = segmentAt(state.segments, at);
      state.observations.unshift({
        id: createId('o'),
        at,
        note: action.payload.note,
        risk: action.payload.risk,
        sync: segment ? 'queued' : 'failed',
        reviewed: false,
        segmentId: segment?.id ?? null
      });
      state.syncNotice = segment ? null : `观察时间两侧 ${OBSERVATION_TIME_TOLERANCE_MS / 1000} 秒内没有路段，已列入待归位。`;
    },
    recordTrackPoint: (state, action: PayloadAction<{ latitude: number; longitude: number; at?: number; source?: 'gps' | 'manual' }>) => {
      const at = action.payload.at ?? Date.now();
      const source = action.payload.source ?? 'gps';
      if (!canSampleAt(at, state.battery, state.lastSampleAt)) {
        const lowBattery = state.battery <= LOW_BATTERY_THRESHOLD;
        const intervalMinutes = lowBattery ? LOW_BATTERY_SAMPLE_INTERVAL_MINUTES : NORMAL_SAMPLE_INTERVAL_MINUTES;
        const waited = state.lastSampleAt ? at - state.lastSampleAt : 0;
        const remaining = intervalMinutes * 60_000 - waited;
        state.syncNotice = `采样间隔保护中：${lowBattery ? '低电量' : '常规'}模式请等待 ${Math.ceil(remaining / 1000)} 秒；观察可先保存，补轨迹后再归位。`;
        return;
      }
      const stay = findStaySegment(state.segments, action.payload.latitude, action.payload.longitude, at);

      if (stay) {
        if (at > stay.endAt) {
          const before = { ...stay };
          stay.endAt = at;
          stay.sync = 'queued';
          if (before.endAt !== at) {
            stay.version += 1;
            invalidateChangedObservations(state, [stay.id]);
          }
        }
        state.lastSampleAt = at;
        state.syncNotice = '同一处停留已合并，仅保留该路段的一个代表点。';
        return;
      }

      const point = { id: createId('p'), latitude: action.payload.latitude, longitude: action.payload.longitude, at, source };
      state.points.push(point);
      const rebuilt = rebuildSegments(state.points, state.segments, () => createId('seg'));
      state.segments = rebuilt.segments;
      invalidateChangedObservations(state, rebuilt.changedSegmentIds);

      const pruned = pruneShortestDwellPoints(state.points, state.segments);
      state.points = pruned.points;
      state.segments = pruned.segments;
      state.prunedCount += pruned.removedCount;
      state.lastSampleAt = at;
      state.syncNotice = pruned.removedCount
        ? `轨迹点达到 ${TRACK_CAPACITY} 个上限，已分批清理停留最短的 ${pruned.removedCount} 个原始点；观察归属路段仍保留。`
        : rebuilt.changedSegmentIds.length
          ? '路段已调整，原挂接观察已退回待归位。'
          : null;
    },
    reassignPending: (state) => {
      const beforeUnassigned = state.observations.filter((item) => !item.segmentId).length;
      state.observations = assignPendingObservations(state.observations, state.segments);
      const afterUnassigned = state.observations.filter((item) => !item.segmentId).length;
      state.syncNotice = beforeUnassigned === afterUnassigned
        ? afterUnassigned ? '仍有观察找不到时间匹配的路段，请先补轨迹。' : '没有待归位观察。'
        : `已归位 ${beforeUnassigned - afterUnassigned} 条观察。`;
    },
    syncQueue: (state) => {
      state.observations = assignPendingObservations(state.observations, state.segments);
      let synced = 0;
      state.observations = state.observations.map((item) => {
        if (item.sync === 'synced') return item;
        if (item.segmentId) {
          synced += 1;
          return { ...item, sync: 'synced' as const };
        }
        return { ...item, sync: 'failed' as const };
      });
      state.segments = state.segments.map((segment) => segment.sync === 'queued' ? { ...segment, sync: 'synced' as const } : segment);
      const unassigned = state.observations.filter((item) => !item.segmentId).length;
      state.syncNotice = unassigned
        ? `本次同步保留已归位路段和 ${synced} 条观察；${unassigned} 条待归位观察未提交，重试时只补这些。`
        : '全部观察和路段已同步，已归位数据未重复重建。';
    },
    retryPendingSync: (state) => {
      state.observations = assignPendingObservations(state.observations, state.segments);
      let synced = 0;
      state.observations = state.observations.map((item) => {
        if (item.sync !== 'failed' || !item.segmentId) return item;
        synced += 1;
        return { ...item, sync: 'synced' as const };
      });
      const unassigned = state.observations.filter((item) => !item.segmentId).length;
      state.syncNotice = synced
        ? `重试只补传新归位的 ${synced} 条观察；原有路段和观察保留。`
        : unassigned ? '仍没有可匹配的路段，未重复提交已同步数据。' : '没有需要重试的待归位观察。';
    },
    setBattery: (state, action: PayloadAction<number>) => {
      state.battery = Math.max(0, Math.min(100, Math.round(action.payload)));
    },
    clearNotice: (state) => {
      state.syncNotice = null;
    },
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => item.sync === 'conflict' ? { ...item, sync: 'synced' } : item);
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: createId('s'), ...action.payload, status: 'draft' });
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) })
});
export const { useConnectionQuery } = patrolApi;
export const {
  addObservation,
  addSample,
  clearNotice,
  recordTrackPoint,
  reassignPending,
  resolveConflict,
  retryPendingSync,
  reviewObservation,
  setBattery,
  syncQueue,
  verifySample
} = slice.actions;
export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});
if (typeof window !== 'undefined') {
  store.subscribe(() => Taro.setStorageSync('yf57-patrol-state-v2', JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
export const selectCanSampleNow = (state: RootState, at = Date.now()) => canSampleAt(
  at,
  state.patrol.battery,
  state.patrol.lastSampleAt
);
