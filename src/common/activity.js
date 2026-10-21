// HR 活跃度分档：用于排序（活跃优先）、标注（长期未活跃醒目提示）、匹配分扣减。
// BOSS 的活跃描述形如：在线 / 刚刚活跃 / 今日活跃 / 3日内活跃 / 本周活跃 / 2周内活跃 / 本月活跃 /
// 2月内活跃 … 5月内活跃 / 近半年活跃 / 半年前活跃。

// 档位：0 很活跃 … 4 数月 / 半年未活跃；null = 未知
export const ACTIVITY_TIERS = [
  { tier: 0, label: '很活跃', penalty: 0 },
  { tier: 1, label: '近几天活跃', penalty: 0 },
  { tier: 2, label: '两周内活跃', penalty: 3 },
  { tier: 3, label: '本月活跃', penalty: 6 },
  { tier: 4, label: '数月未活跃', penalty: 12 },
];

export function hrActivityTier(job) {
  const t = String((job && job.hrActiveText) || '').trim();
  if (!t) return job && job.hrOnline === true ? 0 : null;
  if (/在线|刚刚|今日|今天/.test(t)) return 0;
  if (/[1-3一二三]\s*日内|[1-3一二三]\s*天内|本周/.test(t)) return 1;
  if (/[2两二]\s*周内/.test(t)) return 2;
  if (/本月|[1一]\s*个?月内/.test(t)) return 3;
  if (/[2-9二三四五六七八九两]\s*个?月|半年|年/.test(t)) return 4;
  return null;
}

// 是否需要重点标注（数月 / 半年未活跃）
export function isStaleHr(job) {
  return hrActivityTier(job) === 4;
}

// 匹配分扣减（由程序统一扣，不让 AI 自行估算，保证同档同扣）
export function activityPenalty(job) {
  const tier = hrActivityTier(job);
  return tier == null ? 0 : ACTIVITY_TIERS[tier].penalty;
}

// 排序键：越小越靠前。未知活跃度排在「两周内」与「本月」之间，不因缺数据被埋没也不被抬高。
export function activitySortKey(job) {
  const tier = hrActivityTier(job);
  return tier == null ? 2.5 : tier;
}
