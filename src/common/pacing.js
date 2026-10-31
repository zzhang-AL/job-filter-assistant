// 后台标签页节奏：尽量模拟人工浏览的随机性（间隔、停留、休息、活跃时段），全部可在设置页调整。
// 纯函数，便于单测；随机源可注入。

// 预设：越稳健越慢、越像人。
// detailConcurrency：同时开几个后台标签页（像人一口气中键点开几个岗位再逐个看）；
// 开得越多越快，但被平台判定为异常的风险也越高。
export const PACING_PRESETS = {
  careful: {
    label: '稳健',
    detailConcurrency: 1,
    gapMinSec: 10, gapMaxSec: 45,
    dwellMinSec: 6, dwellMaxSec: 20,
    breakEveryMin: 6, breakEveryMax: 12,
    breakMinSec: 120, breakMaxSec: 480,
    hourlyCap: 40, dailyCap: 200,
  },
  standard: {
    label: '标准',
    detailConcurrency: 2,
    gapMinSec: 6, gapMaxSec: 25,
    dwellMinSec: 4, dwellMaxSec: 15,
    breakEveryMin: 8, breakEveryMax: 15,
    breakMinSec: 60, breakMaxSec: 240,
    hourlyCap: 120, dailyCap: 500,
  },
  fast: {
    label: '较快',
    detailConcurrency: 3,
    gapMinSec: 4, gapMaxSec: 12,
    dwellMinSec: 3, dwellMaxSec: 8,
    breakEveryMin: 12, breakEveryMax: 20,
    breakMinSec: 45, breakMaxSec: 120,
    hourlyCap: 240, dailyCap: 1000,
  },
};

// 两次打开标签页之间的间隔（毫秒）：区间内偏态随机，再按并发数摊薄——
// 并发 N 时平均每 gap/N 打开一个，吞吐约为单开的 N 倍；最短 1.5 秒，不会一瞬间全部弹出
export function launchGapMs(p, rand = Math.random) {
  const n = Math.max(1, p.detailConcurrency || 1);
  return Math.max(1500, (sampleSkewed(p.gapMinSec, p.gapMaxSec, rand) * 1000) / n);
}

export function defaultPacing() {
  const { label, ...p } = PACING_PRESETS.standard;
  return {
    ...p,
    activeHours: '08:00-23:30', // 只在这个时段内自动打开后台标签页；留空 = 不限
    onlyWhenActive: true, // 电脑空闲（无键鼠操作）时暂停
    simulateScroll: true, // 停留期间分几次慢慢往下滚动页面
  };
}

// 规整用户输入：数值收敛到合理区间，min/max 顺序纠正
export function sanitizePacing(input) {
  const d = defaultPacing();
  const o = input && typeof input === 'object' ? input : {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  };
  const pair = (kMin, kMax, lo, hi) => {
    let a = num(o[kMin], d[kMin], lo, hi);
    let b = num(o[kMax], d[kMax], lo, hi);
    if (a > b) [a, b] = [b, a];
    return [a, b];
  };
  const [gapMinSec, gapMaxSec] = pair('gapMinSec', 'gapMaxSec', 2, 600);
  const [dwellMinSec, dwellMaxSec] = pair('dwellMinSec', 'dwellMaxSec', 1, 120);
  const [breakEveryMin, breakEveryMax] = pair('breakEveryMin', 'breakEveryMax', 1, 200);
  const [breakMinSec, breakMaxSec] = pair('breakMinSec', 'breakMaxSec', 0, 3600);
  return {
    detailConcurrency: num(o.detailConcurrency, d.detailConcurrency, 1, 5),
    gapMinSec, gapMaxSec, dwellMinSec, dwellMaxSec,
    breakEveryMin, breakEveryMax, breakMinSec, breakMaxSec,
    hourlyCap: num(o.hourlyCap, d.hourlyCap, 1, 1000),
    dailyCap: num(o.dailyCap, d.dailyCap, 1, 5000),
    activeHours: typeof o.activeHours === 'string' ? o.activeHours.trim() : d.activeHours,
    onlyWhenActive: typeof o.onlyWhenActive === 'boolean' ? o.onlyWhenActive : d.onlyWhenActive,
    simulateScroll: typeof o.simulateScroll === 'boolean' ? o.simulateScroll : d.simulateScroll,
  };
}

// 偏态随机（对数正态）：人的操作间隔多数偏短、偶尔很长。
// 中位数落在区间 35% 处，超出区间则重抽，多次失败退回均匀分布。返回 [min, max] 内的数。
export function sampleSkewed(min, max, rand = Math.random) {
  if (!(max > min)) return min;
  const median = min + (max - min) * 0.35;
  const mu = Math.log(median);
  const sigma = 0.5;
  for (let i = 0; i < 6; i++) {
    // Box–Muller
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const x = Math.exp(mu + sigma * z);
    if (x >= min && x <= max) return x;
  }
  return min + rand() * (max - min);
}

export function randInt(min, max, rand = Math.random) {
  return Math.floor(min + rand() * (max - min + 1));
}

// 是否在活跃时段内。spec 形如 "08:00-23:30"，支持跨午夜 "22:00-02:00"；空/非法 = 不限。
export function inActiveHours(spec, date = new Date()) {
  const m = String(spec || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

// —— 详情补全队列的分档插入 ——
// urgent（用户单个点了分析，等着要）> batch（批量分析前置补全）> daily（每日自动搜索的补全）> 普通（列表收录后的补全）。
// daily 档不需要用户正停在 BOSS 页，也不受活跃时段限制（用户明确预约了每日任务）。
export const taskTier = (it) => (it.urgent ? 0 : it.batch ? 1 : it.daily ? 2 : 3);

// 把任务插进队列：已在队列里且新档更高则提档，否则不动；插在同档末尾。就地修改 queue，返回是否新加入。
export function insertDetailTask(queue, task) {
  const i = queue.findIndex((x) => x.uid === task.uid);
  let it = task;
  if (i >= 0) {
    const prev = queue[i];
    if (taskTier(task) >= taskTier(prev)) return false;
    queue.splice(i, 1);
    it = { ...prev, urgent: task.urgent, batch: task.batch || prev.batch, daily: task.daily || prev.daily };
  }
  const at = queue.findIndex((x) => taskTier(x) > taskTier(it));
  if (at < 0) queue.push(it);
  else queue.splice(at, 0, it);
  return i < 0;
}
