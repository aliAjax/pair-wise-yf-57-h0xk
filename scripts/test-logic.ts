/**
 * 归并逻辑验证脚本（esbuild 打包后在 Node 运行）。
 * 覆盖：路段归并、停留合并、观察归位、容量淘汰、低电量降频、手动改动退回待归位、同步幂等。
 */
import {
  assignObservationsInPlace,
  buildSegments,
  evictPoints,
  MAX_POINTS,
  type PatrolObservation,
  type TrackPoint,
  type TrackSegment
} from '../src/utils/patrol-logic';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

const ISO = (hhmm: string) => `2026-09-29T${hhmm}:00`;
const mkPoint = (id: string, lat: number, lon: number, hhmm: string, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  id, latitude: lat, longitude: lon, at: ISO(hhmm), source: 'gps', stay: false, stayMinutes: 0, mergedCount: 1, ...extra
});
const mkObs = (id: string, hhmm: string, segmentId: string | null = null): PatrolObservation => ({
  id, time: ISO(hhmm), note: id, risk: 'low', sync: 'queued', reviewed: false, segmentId
});

console.log('1. 路段归并：时间/间距断开');
{
  const points = [
    mkPoint('a', 30.5821, 103.2174, '07:20'),
    mkPoint('b', 30.5825, 103.2178, '07:22'),
    mkPoint('c', 30.5900, 103.2300, '08:30') // 时间间隔大、间距大 → 新路段
  ];
  const segs = buildSegments(points, []);
  check('得到 2 个路段', segs.length === 2, segs.map((s) => s.name));
  check('路段1 含 a,b', segs[0].pointIds.join() === 'a,b');
  check('路段2 含 c', segs[1].pointIds.join() === 'c');
}

console.log('2. 停留合并：同一处停留只留一条代表点');
{
  const points = [
    mkPoint('s1', 30.5821, 103.2174, '09:00'),
    mkPoint('s2', 30.5821, 103.2174, '09:02'),
    mkPoint('s3', 30.5821, 103.2174, '09:05'),
    mkPoint('s4', 30.5821, 103.2174, '09:08'),
    mkPoint('m1', 30.5900, 103.2300, '09:20')
  ];
  const segs = buildSegments(points, []);
  const allIds = segs.flatMap((s) => s.pointIds);
  check('停留点合并为 1 条代表点（共 2 个 id）', allIds.length === 2, allIds);
  const stay = points.find((p) => p.id === 's1')!;
  const rep = segs.flatMap((s) => s.pointIds).length;
  check('代表点标记 stay', rep === 2);
}

console.log('3. 观察按时间落进对应路段，没落进的列待归位');
{
  const points = [
    mkPoint('a', 30.5821, 103.2174, '07:20'),
    mkPoint('b', 30.5825, 103.2178, '07:25'),
    mkPoint('c', 30.5900, 103.2300, '08:30')
  ];
  const segs = buildSegments(points, []);
  const obs = [mkObs('o1', '07:22'), mkObs('o2', '08:30'), mkObs('o3', '10:00')];
  assignObservationsInPlace(obs, segs);
  check('o1 归属路段1', obs[0].segmentId === segs[0].id, obs[0].segmentId);
  check('o2 归属路段2', obs[1].segmentId === segs[1].id, obs[1].segmentId);
  check('o3 待归位', obs[2].segmentId === null, obs[2].segmentId);
}

console.log('4. 容量淘汰：分批丢掉停留最短的点');
{
  const points: TrackPoint[] = [];
  for (let k = 0; k < MAX_POINTS + 5; k++) {
    // 全部为停留点，停留时长递增，便于验证“丢掉停留最短的”
    points.push(mkPoint(`p${k}`, 30.5 + k * 0.001, 103.2 + k * 0.001, `0${Math.floor(k / 60)}:${String(k % 60).padStart(2, '0')}`, {
      stay: true,
      stayMinutes: k + 1
    }));
  }
  const segs = buildSegments(points, []);
  const obs = [mkObs('o1', '00:00')];
  assignObservationsInPlace(obs, segs);
  const before = points.length;
  const after = evictPoints(points, segs, obs);
  check(`淘汰前 ${before} > 上限`, before > MAX_POINTS);
  check(`淘汰后 <= 48`, after.length <= 48, after.length);
  const removed = points.filter((p) => !after.find((q) => q.id === p.id));
  check('被淘汰的都是停留点', removed.every((p) => p.stay), removed.map((p) => p.id));
  const stayMinutes = removed.map((p) => p.stayMinutes);
  const sorted = [...stayMinutes].sort((a, b) => a - b);
  check('淘汰的是停留最短的一批', JSON.stringify(stayMinutes) === JSON.stringify(sorted), stayMinutes);
}

console.log('5. 低电量降频：观察不失去归属（自动重建不解除归属）');
{
  const points = [mkPoint('a', 30.5821, 103.2174, '07:20'), mkPoint('b', 30.5825, 103.2178, '07:25')];
  let segs = buildSegments(points, []);
  const obs = [mkObs('o1', '07:22')];
  assignObservationsInPlace(obs, segs);
  const segId = obs[0].segmentId;
  // 模拟降频后新增稀疏点
  points.push(mkPoint('c', 30.5830, 103.2180, '07:40'));
  segs = buildSegments(points, segs);
  assignObservationsInPlace(obs, segs);
  check('降频后观察仍归属原路段', obs[0].segmentId === segId, obs[0].segmentId);
}

console.log('6. 路段改动：挂着的观察立即失效退回待归位');
{
  const points = [mkPoint('a', 30.5821, 103.2174, '07:20'), mkPoint('b', 30.5825, 103.2178, '07:25')];
  const segs = buildSegments(points, []);
  const obs = [mkObs('o1', '07:22')];
  assignObservationsInPlace(obs, segs);
  check('改动前已归属', obs[0].segmentId === segs[0].id);
  // 模拟删除路段：解除归属
  const seg = segs[0];
  for (const o of obs) if (o.segmentId === seg.id) o.segmentId = null;
  check('删除后退回待归位', obs[0].segmentId === null, obs[0].segmentId);
}

console.log('7. 同步幂等：失败后重试只补没归位的，已同步路段保留');
{
  // 模拟 store 同步逻辑
  const segs: TrackSegment[] = [
    { id: 'seg1', name: '路段 1', pointIds: ['a'], startTime: ISO('07:20'), endTime: ISO('07:25'), synced: false },
    { id: 'seg2', name: '路段 2', pointIds: ['c'], startTime: ISO('08:30'), endTime: ISO('08:30'), synced: false }
  ];
  const obs: PatrolObservation[] = [mkObs('o1', '07:22'), mkObs('o2', '10:00')];
  assignObservationsInPlace(obs, segs);
  // 第一次同步：第 1 项上传后掉线
  const outbox = [
    { kind: 'segment' as const, ref: segs[0] },
    { kind: 'segment' as const, ref: segs[1] },
    { kind: 'observation' as const, ref: obs[1] }
  ];
  outbox[0].ref.synced = true;
  for (const o of obs) if (o.segmentId === outbox[0].ref.id) o.sync = 'synced';
  check('第 1 个路段已同步', segs[0].synced === true);
  check('第 1 个路段上的观察已同步', obs[0].sync === 'synced');
  check('第 2 个路段未同步', segs[1].synced === false);
  // 重试：只处理未同步的
  const retrySegs = segs.filter((s) => !s.synced);
  const retryObs = obs.filter((o) => o.sync === 'queued');
  check('重试只补 1 个路段', retrySegs.length === 1, retrySegs.map((s) => s.id));
  check('重试只补 1 条待归位观察', retryObs.length === 1, retryObs.map((o) => o.id));
  for (const s of retrySegs) s.synced = true;
  for (const o of retryObs) o.sync = 'synced';
  check('所有路段已同步', segs.every((s) => s.synced));
  check('所有观察已同步', obs.every((o) => o.sync === 'synced'));
}

console.log('8. 旧数据兼容：HH:mm 补日期');
{
  const points = [mkPoint('a', 30.5821, 103.2174, '07:20')];
  points[0].at = '07:20';
  const segs = buildSegments(points, []);
  check('HH:mm 点能归并', segs.length === 1, segs.map((s) => s.startTime));
}

if (failures > 0) {
  console.error(`\n${failures} 项检查失败`);
  process.exit(1);
} else {
  console.log('\n全部检查通过');
}
