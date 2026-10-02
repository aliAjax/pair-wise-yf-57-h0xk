import { createContext, useContext, type ReactNode } from 'react';

const messages = {
  title: '野外巡护离线调查',
  sync: '同步队列',
  review: '负责人复核',
  save: '保存现场记录',
  segments: '归并路段',
  pending: '待归位观察',
  battery: '电量',
  sampling: '采样频率',
  capacity: '轨迹点容量',
  retry: '重试同步',
  merge: '合并路段',
  rename: '重命名',
  delete: '删除',
  recharge: '充电',
  stay: '停留',
  points: '轨迹点',
  observations: '观察记录',
  trackAndSample: '轨迹与样本',
  lowBattery: '电量低于警戒线，已自动降低采样频率，观察归属不受影响'
};
const I18nContext = createContext(messages);
export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={messages}>{children}</I18nContext.Provider>;
}
export const useI18n = () => useContext(I18nContext);
