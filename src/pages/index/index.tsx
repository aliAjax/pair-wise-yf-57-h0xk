import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
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
  verifySample,
  type RootState
} from '../../store';
import { fmtRange, fmtTime } from '../../utils/geo';
import './index.scss';

const MAX_POINTS = 60;
const BATTERY_LOW = 20;

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });

  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const pending = state.observations.filter((o) => o.segmentId == null);
  const unsyncedSegs = state.segments.filter((s) => !s.synced).length;
  const segName = (id: string | null) => state.segments.find((s) => s.id === id)?.name ?? '待归位';
  const pointsPct = Math.min(100, Math.round((state.points.length / MAX_POINTS) * 100));
  const batteryPct = state.battery;

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(addPoint({ latitude: 30.5 + Math.random() * 0.01, longitude: 103.2 + Math.random() * 0.01 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };

  const onRename = (id: string, name: string) => {
    const next = window.prompt('路段名称', name);
    if (next && next.trim()) dispatch(renameSegment({ id, name: next.trim() }));
  };

  const syncStatusText =
    state.syncStatus === 'syncing'
      ? '同步中…'
      : state.syncStatus === 'failed'
        ? '同步失败'
        : state.syncStatus === 'success'
          ? '同步成功'
          : '尚未同步';

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">弱网也能记录，联网后统一同步；轨迹点按时间与间距归成路段，观察自动落进对应路段。</Text>
      </View>

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
      </View>

      {/* 电量与采样频率 */}
      <View className="card">
        <View className="card-title">{t.battery} · {t.sampling}</View>
        <View className="bar">
          <View className={`bar-inner ${batteryPct <= BATTERY_LOW ? 'low' : ''}`} style={{ width: `${batteryPct}%` }} />
        </View>
        <View className="battery-row">
          <Text className="muted">{state.battery}% · {state.samplingMode === 'saver' ? '降频采样' : '正常采样'}{state.samplingMode === 'saver' ? ` · 已跳过 ${state.skippedCount} 次` : ''}</Text>
          <Button size="mini" className="mini-btn" onClick={() => dispatch(recharge())}>{t.recharge}</Button>
        </View>
        {state.samplingMode === 'saver' && <Text className="hint warn-text">{t.lowBattery}</Text>}
      </View>

      {/* 轨迹点容量 */}
      <View className="card">
        <View className="card-title">{t.capacity}<Text className="count">{state.points.length} / {MAX_POINTS}</Text></View>
        <View className="bar">
          <View className={`bar-inner ${pointsPct >= 80 ? 'warn' : ''}`} style={{ width: `${pointsPct}%` }} />
        </View>
        <Text className="hint">攒到容量上限时分批淘汰停留最短的停留点，移动轨迹点保留。</Text>
      </View>

      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      {state.conflict && (
        <View className="alert conflict">
          <Text>{state.conflict}</Text>
          <View className="alert-actions">
            <Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button>
            <Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button>
          </View>
        </View>
      )}

      {/* 同步 */}
      <View className="card">
        <View className="card-title">{t.sync}<Text className="count">{syncStatusText}</Text></View>
        <Text className="hint">待同步路段 {unsyncedSegs} 个 · 待归位观察 {pending.length} 条</Text>
        <Button className="secondary" onClick={() => dispatch(syncQueue())} disabled={state.syncStatus === 'syncing'}>
          {state.syncStatus === 'failed' ? t.retry : '模拟恢复联网并同步'}
        </Button>
        {state.syncStatus === 'failed' && state.lastSyncError && <Text className="hint warn-text">{state.lastSyncError}</Text>}
        {state.syncStatus === 'success' && <Text className="hint ok-text">同步完成：已归位路段保留，待归位观察单独上报。</Text>}
      </View>

      {/* 归并路段 */}
      <View className="card">
        <View className="card-title">{t.segments}<Text className="count">{state.segments.length} 段</Text></View>
        {state.segments.length === 0 && <Text className="muted">暂无路段，记录轨迹点后自动归并。</Text>}
        {state.segments.map((seg, idx) => {
          const segObs = state.observations.filter((o) => o.segmentId === seg.id);
          return (
            <View className="segment" key={seg.id}>
              <View className="segment-head">
                <Text className="segment-name">{seg.name}</Text>
                <Text className={`badge ${seg.synced ? 'synced' : ''}`}>{seg.synced ? '已同步' : '未同步'}</Text>
              </View>
              <Text className="muted">{fmtRange(seg.startTime, seg.endTime)} · {seg.pointIds.length} 个轨迹点</Text>
              {segObs.length > 0 && (
                <View className="segment-obs">
                  {segObs.map((o) => (
                    <Text className="obs-chip" key={o.id}>{fmtTime(o.time)} · {o.note}</Text>
                  ))}
                </View>
              )}
              <View className="segment-actions">
                <Button size="mini" className="mini-btn" onClick={() => onRename(seg.id, seg.name)}>{t.rename}</Button>
                {idx < state.segments.length - 1 && (
                  <Button size="mini" className="mini-btn" onClick={() => dispatch(mergeSegments({ id: seg.id }))}>{t.merge}</Button>
                )}
                <Button size="mini" className="mini-btn danger" onClick={() => dispatch(deleteSegment({ id: seg.id }))}>{t.delete}</Button>
              </View>
            </View>
          );
        })}
      </View>

      {/* 待归位观察 */}
      <View className="card">
        <View className="card-title">{t.pending}<Text className="count">{pending.length} 条</Text></View>
        {pending.length === 0 && <Text className="muted">所有观察均已落进对应路段。</Text>}
        {pending.map((o) => (
          <View className="observation pending" key={o.id}>
            <View>
              <Text className="obs-title">{o.risk === 'high' ? '高风险 · ' : ''}{o.note}</Text>
              <Text className="muted">{fmtTime(o.time)} · 未找到匹配路段 · {o.sync}</Text>
            </View>
            <Text className="badge pending-badge">待归位</Text>
          </View>
        ))}
      </View>

      {/* 观察记录 */}
      <View className="card">
        <View className="card-title">{t.observations}</View>
        <ScrollView scrollY className="list">
          {state.observations.map((item) => (
            <View className="observation" key={item.id}>
              <View>
                <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
                <Text className="muted">{fmtTime(item.time)} · {item.sync} · {segName(item.segmentId)}</Text>
              </View>
              <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>
                {item.reviewed ? '已复核' : '复核'}
              </Button>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* 轨迹与样本 */}
      <View className="card">
        <View className="card-title">{t.trackAndSample}</View>
        {state.points.slice(-3).map((point) => (
          <NutCell
            key={point.id}
            title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}
            description={`${fmtTime(point.at)} · ${point.source}${point.stay ? ` · ${t.stay} ${point.stayMinutes} 分钟` : ''}`}
          />
        ))}
        {state.samples.map((sample) => (
          <View className="sample" key={sample.id}>
            <Text>{sample.code} · {sample.species} × {sample.count}</Text>
            <Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>
              {sample.status === 'verified' ? '已核验' : '核验'}
            </Button>
          </View>
        ))}
      </View>

      <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
    </View>
  );
}
