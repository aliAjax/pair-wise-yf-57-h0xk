import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import {
  assignObservationsInPlace,
  BATTERY_DRAIN,
  BATTERY_LOW,
  buildSegments,
  evictPoints,
  normalizeAt,
  SAVER_SKIP,
  type PatrolObservation,
  type TrackPoint,
  type TrackSegment
} from '../utils/patrol-logic';
import { parseMs } from '../utils/geo';

export type { PatrolObservation, TrackPoint, TrackSegment, SyncState } from '../utils/patrol-logic';

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: 'draft' | 'submitted' | 'verified';
}

interface State {
  observations: PatrolObservation[];
  points: TrackPoint[];
  segments: TrackSegment[];
  samples: Sample[];
  conflict: string | null;
  battery: number;
  samplingMode: 'normal' | 'saver';
  saverAttempts: number;
  skippedCount: number;
  syncStatus: 'idle' | 'syncing' | 'failed' | 'success';
  lastSyncError: string | null;
  syncAttempts: number;
}

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29T07:20:00', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, segmentId: null },
    { id: 'o2', time: '2026-09-29T08:05:00', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, segmentId: null },
    { id: 'o3', time: '2026-09-29T08:40:00', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, segmentId: null }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '2026-09-29T07:20:00', source: 'gps', stay: false, stayMinutes: 0, mergedCount: 1 },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '2026-09-29T08:05:00', source: 'gps', stay: false, stayMinutes: 0, mergedCount: 1 }
  ],
  segments: [],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
  conflict: null,
  battery: 100,
  samplingMode: 'normal',
  saverAttempts: 0,
  skippedCount: 0,
  syncStatus: 'idle',
  lastSyncError: null,
  syncAttempts: 0
};

/** 归一化持久化状态，补全缺失字段并重建路段、归位观察。 */
function normalizeState(raw: unknown): State {
  const base: State = {
    observations: [],
    points: [],
    segments: [],
    samples: [],
    conflict: null,
    battery: 100,
    samplingMode: 'normal',
    saverAttempts: 0,
    skippedCount: 0,
    syncStatus: 'idle',
    lastSyncError: null,
    syncAttempts: 0
  };
  const r = (raw ?? {}) as Partial<State>;
  const merged: State = {
    ...base,
    ...r,
    observations: (r.observations ?? []).map((o) => ({
      id: o.id,
      time: normalizeAt(o.time),
      note: o.note,
      risk: o.risk ?? 'low',
      sync: o.sync ?? 'queued',
      reviewed: !!o.reviewed,
      segmentId: o.segmentId ?? null
    })),
    points: (r.points ?? []).map((p) => ({
      id: p.id,
      latitude: p.latitude,
      longitude: p.longitude,
      at: normalizeAt(p.at),
      source: p.source ?? 'gps',
      stay: !!p.stay,
      stayMinutes: p.stayMinutes ?? 0,
      mergedCount: p.mergedCount ?? 1
    })),
    segments: (r.segments ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      pointIds: s.pointIds ?? [],
      startTime: s.startTime,
      endTime: s.endTime,
      synced: !!s.synced
    })),
    samples: r.samples ?? [],
    conflict: r.conflict ?? null,
    battery: r.battery ?? 100,
    samplingMode: r.samplingMode ?? 'normal',
    saverAttempts: r.saverAttempts ?? 0,
    skippedCount: r.skippedCount ?? 0,
    syncStatus: r.syncStatus ?? 'idle',
    lastSyncError: r.lastSyncError ?? null,
    syncAttempts: r.syncAttempts ?? 0
  };
  if (merged.segments.length === 0 && merged.points.length > 0) {
    merged.segments = buildSegments(merged.points, []);
  }
  assignObservationsInPlace(merged.observations, merged.segments);
  return merged;
}

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    return normalizeState(saved ? JSON.parse(saved) : seed);
  } catch {
    return normalizeState(seed);
  }
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<Omit<PatrolObservation, 'id' | 'time' | 'sync' | 'reviewed' | 'segmentId'>>) => {
      const obs: PatrolObservation = {
        id: `o-${Date.now()}`,
        time: new Date().toISOString(),
        ...action.payload,
        sync: 'queued',
        reviewed: false,
        segmentId: null
      };
      state.observations.unshift(obs);
      assignObservationsInPlace(state.observations, state.segments);
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      // 电量消耗，低到警戒线自动降频
      state.battery = Math.max(0, state.battery - BATTERY_DRAIN);
      if (state.battery <= BATTERY_LOW) state.samplingMode = 'saver';
      if (state.samplingMode === 'saver') {
        state.saverAttempts += 1;
        if (state.saverAttempts % SAVER_SKIP !== 0) {
          state.skippedCount += 1;
          return;
        }
      }
      const point: TrackPoint = {
        id: `p-${Date.now()}`,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: new Date().toISOString(),
        source: 'gps',
        stay: false,
        stayMinutes: 0,
        mergedCount: 1
      };
      state.points.push(point);
      // 容量淘汰：分批丢掉停留最短的点
      state.points = evictPoints(state.points, state.segments, state.observations);
      // 重建路段并归位观察（自动变化不解除已有归属）
      state.segments = buildSegments(state.points, state.segments);
      assignObservationsInPlace(state.observations, state.segments);
    },
    renameSegment: (state, action: PayloadAction<{ id: string; name: string }>) => {
      const seg = state.segments.find((s) => s.id === action.payload.id);
      if (seg) seg.name = action.payload.name;
    },
    mergeSegments: (state, action: PayloadAction<{ id: string }>) => {
      const idx = state.segments.findIndex((s) => s.id === action.payload.id);
      if (idx === -1 || idx === state.segments.length - 1) return;
      const a = state.segments[idx];
      const b = state.segments[idx + 1];
      // 路段改动：挂着的观察立即失效退回待归位
      for (const o of state.observations) {
        if (o.segmentId === a.id || o.segmentId === b.id) o.segmentId = null;
      }
      a.pointIds = [...new Set([...a.pointIds, ...b.pointIds])];
      const times = [a.startTime, b.startTime].sort();
      a.startTime = times[0];
      const ends = [a.endTime, b.endTime].sort();
      a.endTime = ends[ends.length - 1];
      state.segments.splice(idx + 1, 1);
    },
    deleteSegment: (state, action: PayloadAction<{ id: string }>) => {
      const idx = state.segments.findIndex((s) => s.id === action.payload.id);
      if (idx === -1) return;
      const seg = state.segments[idx];
      // 路段改动：挂着的观察立即失效退回待归位
      for (const o of state.observations) {
        if (o.segmentId === seg.id) o.segmentId = null;
      }
      const ids = new Set(seg.pointIds);
      state.points = state.points.filter((p) => !ids.has(p.id));
      state.segments.splice(idx, 1);
    },
    syncQueue: (state) => {
      if (state.syncStatus === 'syncing') return;
      const segItems = state.segments
        .filter((s) => !s.synced)
        .sort((a, b) => parseMs(a.startTime) - parseMs(b.startTime));
      const obsItems = state.observations
        .filter((o) => o.sync === 'queued')
        .sort((a, b) => parseMs(a.time) - parseMs(b.time));
      type Item = { kind: 'segment' | 'observation'; ref: TrackSegment | PatrolObservation };
      const outbox: Item[] = [
        ...segItems.map((s) => ({ kind: 'segment' as const, ref: s })),
        ...obsItems.map((o) => ({ kind: 'observation' as const, ref: o }))
      ];
      if (outbox.length === 0) {
        state.syncStatus = 'success';
        state.lastSyncError = null;
        return;
      }
      state.syncStatus = 'syncing';
      const process = (item: Item) => {
        if (item.kind === 'segment') {
          const seg = item.ref as TrackSegment;
          seg.synced = true;
          for (const o of state.observations) {
            if (o.segmentId === seg.id) o.sync = 'synced';
          }
        } else {
          (item.ref as PatrolObservation).sync = 'synced';
        }
      };
      // 模拟弱网：首次同步在第 1 项上传后掉线；重试只补没归位的，已同步路段保留不重复
      if (state.syncAttempts === 0 && outbox.length > 1) {
        process(outbox[0]);
        state.syncStatus = 'failed';
        state.lastSyncError = `网络连接中断（模拟弱网）：第 1 项上传后掉线，已保留 ${state.segments.filter((s) => s.synced).length} 个已同步路段；重试只补传未归位数据，已同步路段不重复上传。`;
      } else {
        for (const item of outbox) process(item);
        state.syncStatus = 'success';
        state.lastSyncError = null;
      }
      state.syncAttempts += 1;
    },
    recharge: (state) => {
      state.battery = 100;
      if (state.samplingMode === 'saver') {
        state.samplingMode = 'normal';
        state.saverAttempts = 0;
        state.skippedCount = 0;
      }
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft' });
    },
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => (item.sync === 'conflict' ? { ...item, sync: 'synced' } : item));
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
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
  addPoint,
  addSample,
  deleteSegment,
  mergeSegments,
  renameSegment,
  resolveConflict,
  recharge,
  reviewObservation,
  syncQueue,
  verifySample
} = slice.actions;
export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});
if (typeof window !== 'undefined') {
  store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
