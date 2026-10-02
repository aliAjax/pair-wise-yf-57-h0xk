import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  LOW_BATTERY_THRESHOLD,
  addObservation,
  addSample,
  formatDateTime,
  formatTime,
  recordTrackPoint,
  reassignPending,
  reviewObservation,
  retryPendingSync,
  samplingIntervalMinutes,
  setBattery,
  syncQueue,
  verifySample,
  type RootState,
  type RouteSegment
} from '../../store';
import './index.scss';

const formSchema = z.object({
  note: z.string().min(2, '至少填写 2 个字'),
  risk: z.enum(['low', 'medium', 'high']),
  species: z.string(),
  count: z.string(),
  at: z.string()
});
type FormValues = z.infer<typeof formSchema>;

const riskText = { low: '低风险', medium: '中风险', high: '高风险' };
const syncText: Record<string, string> = {
  local: '本地',
  queued: '待同步',
  synced: '已同步',
  conflict: '冲突',
  failed: '待归位'
};

function segmentLabel(segment: RouteSegment | undefined) {
  if (!segment) return '待归位';
  return `${segment.kind === 'stay' ? '停留' : '路段'} v${segment.version} · ${formatTime(segment.startAt)}-${formatTime(segment.endAt)}`;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1', at: '' }
  });
  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const pending = state.observations.filter((item) => !item.segmentId).length;
  const failed = state.observations.filter((item) => item.sync === 'failed').length;
  const lowBattery = state.battery <= LOW_BATTERY_THRESHOLD;
  const interval = samplingIntervalMinutes(state.battery);
  const segmentsById = new Map(state.segments.map((segment) => [segment.id, segment]));

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(recordTrackPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(recordTrackPoint({ latitude: 30.5902, longitude: 103.2261 }));
    }
  };

  const simulatePoint = (samePlace = false) => {
    const lastPoint = [...state.points].sort((a, b) => b.at - a.at)[0];
    const base = state.lastSampleAt ?? Date.now();
    const at = Math.max(Date.now(), base + interval * 60_000);
    const latitude = lastPoint && !samePlace ? lastPoint.latitude + 0.00162 : 30.5902;
    const longitude = lastPoint && !samePlace ? lastPoint.longitude + 0.0001 : 103.2261;
    dispatch(recordTrackPoint({ latitude, longitude, at, source: 'manual' }));
  };

  const submit = (values: FormValues) => {
    const at = values.at ? new Date(values.at).getTime() : Date.now();
    dispatch(addObservation({ note: values.note, risk: values.risk, at: Number.isFinite(at) ? at : Date.now() }));
    if (values.species) {
      dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    }
    reset();
  };

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">轨迹按时空合并成路段；观察先找归属，再同步，弱网重试不重建已归位数据。</Text>
    </View>

    <View className="metrics">
      <View><Text>原始轨迹点</Text><Text className="metric">{state.points.length}/10</Text></View>
      <View><Text>待归位观察</Text><Text className={`metric ${pending ? 'warn' : ''}`}>{pending}</Text></View>
      <View><Text>待同步</Text><Text className={`metric ${queued ? 'warn' : ''}`}>{queued}</Text></View>
    </View>

    {state.syncNotice && <View className="alert info"><Text>{state.syncNotice}</Text></View>}

    <View className="card">
      <View className="card-title">电量与采样</View>
      <View className="battery-row">
        <View>
          <Text className="battery">{state.battery}%</Text>
          <Text className="hint">{lowBattery ? '低电量警戒：降频采样' : '常规采样'} · 每 {interval} 分钟一个点</Text>
        </View>
        <View className="button-row">
          <Button size="mini" onClick={() => dispatch(setBattery(82))}>正常电量</Button>
          <Button size="mini" onClick={() => dispatch(setBattery(15))}>低电量 15%</Button>
        </View>
      </View>
      <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
      <View className="two">
        <Button className="secondary compact" onClick={() => simulatePoint(false)}>模拟沿同路前进</Button>
        <Button className="secondary compact" onClick={() => simulatePoint(true)}>模拟同处停留</Button>
      </View>
      <Text className="hint">同处停留的原始点会被合并；轨迹点达到上限时，按停留时间分批丢弃最短点，路段和观察归属不删。</Text>
    </View>

    <View className="card">
      <View className="card-title">现场记录</View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="物种或样本名称" {...register('species')} />
          <Input className="input" type="number" placeholder="数量" {...register('count')} />
        </View>
        <Input className="input" type="text" placeholder="观察时间，格式 2026-09-29T08:05（留空为现在）" {...register('at')} />
        <Text className="hint">观察时间留空则使用现在；时间落不进任一路段（含 90 秒容差）会列入待归位。</Text>
        <View className="risk">
          <Text>风险等级</Text>
          <select {...register('risk')}>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </View>
        <Button className="primary" formType="submit">{t.save}</Button>
      </form>
    </View>

    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{failed} 条失败</Text></View>
      <View className="two">
        <Button className="secondary compact" onClick={() => dispatch(reassignPending())}>重新归位待归位</Button>
        <Button className="primary compact" onClick={() => dispatch(syncQueue())}>回站同步</Button>
      </View>
      <Button className="secondary" onClick={() => dispatch(retryPendingSync())}>同步失败后重试（只补失败项）</Button>
      <Text className="hint">重试不会重建或重复提交已同步路段；观察必须先按时间找到归属。路段结构一变，挂接观察会立即退回待归位。</Text>
    </View>

    <View className="card">
      <View className="card-title">归组路段<Text className="count">{state.segments.length} 段</Text></View>
      <ScrollView scrollY className="segment-list">
        {state.segments.map((segment) => <View className="segment" key={segment.id}>
          <View>
            <Text className="obs-title">{segment.kind === 'stay' ? '停留代表点' : '同路路段'} · {syncText[segment.sync]}</Text>
            <Text className="muted">{formatDateTime(segment.startAt)} 至 {formatTime(segment.endAt)} · {segment.pointIds.length} 原始点 · v{segment.version}</Text>
            <Text className="muted">代表坐标 {segment.representativeLatitude.toFixed(5)}, {segment.representativeLongitude.toFixed(5)}</Text>
          </View>
        </View>)}
      </ScrollView>
      <Text className="hint">已容量清理 {state.prunedCount} 个最短停留原始点；空原始点的路段作为压缩锚点保留。</Text>
    </View>

    <View className="card">
      <View className="card-title">观察记录</View>
      <ScrollView scrollY className="list">
        {state.observations.map((item) => <View className="observation" key={item.id}>
          <View className="observation-main">
            <Text className="obs-title">{riskText[item.risk]} · {item.note}</Text>
            <Text className="muted">{formatDateTime(item.at)} · {syncText[item.sync]} · {segmentLabel(segmentsById.get(item.segmentId ?? ''))}</Text>
          </View>
          <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button>
        </View>)}
      </ScrollView>
    </View>

    <View className="card">
      <View className="card-title">轨迹与样本</View>
      {state.points.slice(-3).map((point) => (
        <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${formatDateTime(point.at)} · ${point.source}`} />
      ))}
      {state.samples.map((sample) => <View className="sample" key={sample.id}>
        <Text>{sample.code} · {sample.species} × {sample.count}</Text>
        <Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.status === 'verified' ? '已核验' : '核验'}</Button>
      </View>)}
    </View>
  </View>;
}
