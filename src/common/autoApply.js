// 每日自动刷 BOSS + 自动投递：配置、搜索地址、本地筛选、每日清单候选。
// 纯函数（除读取常量外无副作用），便于单测；后台只负责开标签页、调 AI、执行点击。
// 注意：这里不 import constants / platforms / jobsStore，避免与 constants.js 形成循环依赖。
import { hrActivityTier } from './activity.js';

// BOSS 工作年限筛选。值与列表 / 详情里的 jobExperience 文案一致，本地按区间重叠判断。
export const EXPERIENCE_OPTIONS = ['经验不限', '在校/应届', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'];

// 常用城市编码。BOSS 的城市编码在搜索页 URL 的 city= 后面；没列出的城市可在设置里直接填编码。
export const BOSS_CITY_CODES = {
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  武汉: '101200100',
  南京: '101190100',
  西安: '101110100',
  苏州: '101190400',
  长沙: '101250100',
  郑州: '101180100',
  重庆: '101040100',
  天津: '101030100',
  厦门: '101230200',
  福州: '101230100',
  东莞: '101281600',
  佛山: '101280800',
  合肥: '101220100',
  济南: '101120100',
  青岛: '101120200',
  宁波: '101210400',
  无锡: '101190200',
  珠海: '101280700',
  中山: '101281700',
  惠州: '101280300',
  昆明: '101290100',
  大连: '101070200',
  沈阳: '101070100',
  哈尔滨: '101050100',
  长春: '101060100',
  石家庄: '101090100',
  太原: '101100100',
  南昌: '101240100',
  南宁: '101300100',
  贵阳: '101260100',
  海口: '101310100',
  兰州: '101160100',
  乌鲁木齐: '101130100',
  呼和浩特: '101080100',
  银川: '101170100',
  西宁: '101150100',
  拉萨: '101140100',
};

// HR 活跃要求：tier 越大越宽松；4 = 不限。与 activity.js 的档位一致。
export const HR_ACTIVE_OPTIONS = [
  [0, '刚刚 / 今日活跃'],
  [1, '3 日内 / 本周活跃'],
  [2, '两周内活跃'],
  [3, '本月活跃'],
  [4, '不限'],
];

export const APPLY_STATUS_LABELS = {
  applying: '投递中',
  pending: '待确认',
  rejected: '已关闭',
  applied: '已沟通',
  failed: '失败',
  skipped: '已跳过',
};

export function defaultAutoApply() {
  return {
    enabled: false,
    dailyTime: '09:00',
    keywords: [],
    cityName: '全国',
    cityCode: BOSS_CITY_CODES['全国'],
    maxScrolls: 200, // 单次搜索最多下滑多少次（安全上限；滑到底会自动提前结束）
    dailyViewTarget: 300, // 每天刷多少个岗位（含重复 / 已沟通 / 被本地筛掉的），达到就停止当天搜索
    experience: [], // 空 = 不限
    salaryMinK: null,
    salaryMaxK: null,
    hrActiveMaxTier: 3, // 默认只要「本月活跃」及以上
    threshold: 70, // 匹配分门槛
    dailyCollectCap: 50, // 每天自动搜索最多新收录多少个岗位（用于补详情 + AI 匹配）
    dailyCap: 20, // 每天最多纳入投递清单多少个（关闭的也占当天名额）
    includeCompanyContacted: true, // 已沟通公司的其他未沟通岗位也纳入
    applyForeground: false, // false = 后台标签页执行，不抢焦点
    applyGapMinSec: 5,
    applyGapMaxSec: 12,
    applyKeepTab: false, // 点完是否保留标签页
  };
}

export function sanitizeAutoApply(input) {
  const d = defaultAutoApply();
  const o = input && typeof input === 'object' ? input : {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  };
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.dailyTime || '').trim()) ? String(o.dailyTime).trim() : d.dailyTime;
  const keywords = uniq(
    (Array.isArray(o.keywords) ? o.keywords : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean),
  ).slice(0, 10);
  const cityName = typeof o.cityName === 'string' && o.cityName.trim() ? o.cityName.trim() : d.cityName;
  const cityCode = /^\d{6,12}$/.test(String(o.cityCode || '').trim())
    ? String(o.cityCode).trim()
    : BOSS_CITY_CODES[cityName] || d.cityCode;
  let salaryMinK = o.salaryMinK == null || o.salaryMinK === '' ? null : num(o.salaryMinK, null, 0, 500);
  let salaryMaxK = o.salaryMaxK == null || o.salaryMaxK === '' ? null : num(o.salaryMaxK, null, 0, 500);
  if (salaryMinK != null && salaryMaxK != null && salaryMinK > salaryMaxK) [salaryMinK, salaryMaxK] = [salaryMaxK, salaryMinK];
  const experience = uniq(
    (Array.isArray(o.experience) ? o.experience : []).filter((x) => EXPERIENCE_OPTIONS.includes(x)),
  );
  const gapMin = num(o.applyGapMinSec, d.applyGapMinSec, 5, 120);
  const gapMax = num(o.applyGapMaxSec, d.applyGapMaxSec, 5, 300);
  return {
    enabled: bool(o.enabled, d.enabled),
    dailyTime: time,
    keywords,
    cityName,
    cityCode,
    maxScrolls: num(o.maxScrolls, d.maxScrolls, 10, 2000),
    dailyViewTarget: num(o.dailyViewTarget, d.dailyViewTarget, 1, 5000),
    experience,
    salaryMinK,
    salaryMaxK,
    hrActiveMaxTier: num(o.hrActiveMaxTier, d.hrActiveMaxTier, 0, 4),
    threshold: num(o.threshold, d.threshold, 0, 100),
    dailyCollectCap: num(o.dailyCollectCap, d.dailyCollectCap, 1, 300),
    dailyCap: num(o.dailyCap, d.dailyCap, 1, 100),
    includeCompanyContacted: bool(o.includeCompanyContacted, d.includeCompanyContacted),
    applyForeground: bool(o.applyForeground, d.applyForeground),
    applyGapMinSec: Math.min(gapMin, gapMax),
    applyGapMaxSec: Math.max(gapMin, gapMax),
    applyKeepTab: bool(o.applyKeepTab, d.applyKeepTab),
  };
}

// BOSS 搜索页地址。筛选条件（年限 / 薪资 / HR 活跃）在本地判定，避免平台编码变动导致直接空结果。
export function buildBossSearchUrl(cfg, keyword) {
  const u = new URL('https://www.zhipin.com/web/geek/jobs');
  u.searchParams.set('query', String(keyword || '').trim());
  if (cfg && cfg.cityCode) u.searchParams.set('city', String(cfg.cityCode));
  return u.href;
}

// —— 日期 / 定时 ——
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

// 下一次运行时间（今天还没到就是今天，否则明天）
export function nextRunAt(hhmm, now = new Date()) {
  const t = parseHHMM(hhmm);
  if (!t) return 0;
  const at = new Date(now);
  at.setHours(t.h, t.min, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// 今天是否该跑：到点、今天还没跑过、且没有错过太久（浏览器整天没开时不在深夜补跑）
export function dailyDue(cfg, state, now = new Date(), catchUpMs = 12 * 3600 * 1000) {
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.keywords) || !cfg.keywords.length) return { due: false, reason: '未启用或没有关键词' };
  const key = dateKey(now);
  if (state && state.lastSearchDate === key) return { due: false, reason: '今天已经运行过' };
  const t = parseHHMM(cfg.dailyTime);
  if (!t) return { due: false, reason: '时间格式不对' };
  const at = new Date(now);
  at.setHours(t.h, t.min, 0, 0);
  if (now.getTime() < at.getTime()) return { due: false, at: at.getTime(), reason: '还没到时间' };
  if (now.getTime() - at.getTime() > catchUpMs) return { due: false, at: at.getTime(), missed: true, reason: '已错过今天的运行时间' };
  return { due: true, at: at.getTime(), dateKey: key };
}

// 今日还能自动收录多少个岗位（用于补详情 + AI 匹配）。
export function collectQuota(cfg, state, now = new Date()) {
  const cap = Math.max(0, Number(cfg && cfg.dailyCollectCap) || 0);
  const used = state && state.collectDate === dateKey(now) ? Math.max(0, Number(state.collected) || 0) : 0;
  return Math.max(0, cap - used);
}

// 今天已经「刷到」多少个岗位。这里的数量是搜索页列表接口返回的原始岗位数，
// 含重复 / 已沟通 / 被本地筛选掉的，与 collectQuota（真正入库、补详情的额度）分开算。
export function viewedToday(state, now = new Date()) {
  return state && state.viewDate === dateKey(now) ? Math.max(0, Number(state.viewed) || 0) : 0;
}

// 今天还要刷多少个岗位才到「每天刷岗位数」目标。
export function viewQuota(cfg, state, now = new Date()) {
  const target = Math.max(0, Number(cfg && cfg.dailyViewTarget) || 0);
  return Math.max(0, target - viewedToday(state, now));
}

// —— 条件判断 ——
const EXP_RANGES = {
  经验不限: [0, 99],
  '在校/应届': [0, 1],
  '1年以内': [0, 1],
  '1-3年': [1, 3],
  '3-5年': [3, 5],
  '5-10年': [5, 10],
  '10年以上': [10, 99],
};

export function experienceRange(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (EXP_RANGES[s]) return EXP_RANGES[s];
  // 兼容「3-5年经验」「5年以上」等写法
  const m = s.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*年/);
  if (m) return [Number(m[1]), Number(m[2])];
  const m2 = s.match(/(\d+(?:\.\d+)?)\s*年(以上|及以上|以内|以下)?/);
  if (m2) {
    const n = Number(m2[1]);
    if (/以上/.test(m2[2] || '')) return [n, 99];
    if (/以内|以下/.test(m2[2] || '')) return [0, n];
    return [n, n];
  }
  if (/应届|在校/.test(s)) return [0, 1];
  if (/不限/.test(s)) return [0, 99];
  return null;
}

function overlap(a, b) {
  return !!a && !!b && a[0] <= b[1] && b[0] <= a[1];
}

export function experienceMatches(jobExperience, wanted, strict = false) {
  const list = Array.isArray(wanted) ? wanted : [];
  if (!list.length || list.includes('经验不限')) return true;
  const jr = experienceRange(jobExperience);
  if (!jr) return !strict; // 列表阶段还没拿到年限：先放行，等详情再判
  return list.some((w) => overlap(jr, experienceRange(w)));
}

export function salaryMatches(job, cfg, strict = false) {
  if (!cfg || (cfg.salaryMinK == null && cfg.salaryMaxK == null)) return true;
  const rawMin = job && job.salaryMinK != null && job.salaryMinK !== '' ? Number(job.salaryMinK) : NaN;
  const rawMax = job && job.salaryMaxK != null && job.salaryMaxK !== '' ? Number(job.salaryMaxK) : NaN;
  const jMin = Number.isFinite(rawMin) ? rawMin : NaN;
  const jMax = Number.isFinite(rawMax) ? rawMax : NaN;
  const has = Number.isFinite(jMin) || Number.isFinite(jMax);
  if (!has) return !strict; // 「面议」/缺字段：列表阶段先放行，清单阶段不放行
  const wantMin = cfg.salaryMinK == null ? 0 : cfg.salaryMinK;
  const wantMax = cfg.salaryMaxK == null ? Infinity : cfg.salaryMaxK;
  // 只有一边有值时按「该值以上 / 以下」理解，不能把缺的一边当成同一个值
  if (Number.isFinite(jMin) && Number.isFinite(jMax)) return jMax >= wantMin && jMin <= wantMax;
  if (Number.isFinite(jMin)) return jMin <= wantMax;
  return jMax >= wantMin;
}

export function cityMatches(job, cfg, strict = false) {
  if (!cfg || !cfg.cityName || cfg.cityName === '全国' || cfg.cityName === '自定义') return true;
  const jc = String((job && job.city) || '').trim();
  if (!jc) return !strict;
  return jc.includes(cfg.cityName) || cfg.cityName.includes(jc);
}

export function hrActiveMatches(job, cfg, strict = false) {
  if (!cfg || cfg.hrActiveMaxTier >= 4) return true;
  const tier = hrActivityTier(job);
  if (tier == null) return !strict;
  return tier <= cfg.hrActiveMaxTier;
}

// 搜索阶段（列表接口）先过一遍：年限 / 薪资 / 城市 / HR 活跃。
// strict=false：字段缺失先放行，避免列表数据不全时误杀；详情阶段再用 strict 判一次。
export function matchSearchFilter(job, cfg, { strict = false } = {}) {
  const reasons = [];
  if (!job) return { keep: false, reasons: ['空岗位'] };
  if (!experienceMatches(job.experience, cfg && cfg.experience, strict)) reasons.push('工作年限不符');
  if (!salaryMatches(job, cfg, strict)) reasons.push('薪资不在范围内');
  if (!cityMatches(job, cfg, strict)) reasons.push('城市不符');
  if (!hrActiveMatches(job, cfg, strict)) reasons.push('HR 活跃度不够');
  return { keep: reasons.length === 0, reasons };
}

// 是否进入「待投递」清单。已沟通的岗位排除；已沟通公司的其他岗位按开关决定。
export function eligibleForApply(job, cfg, { history = {}, strictFilters = true } = {}) {
  if (!job || !cfg) return false;
  if (job.platform !== 'boss') return false;
  if (job.contacted === 'job') return false;
  if (job.contacted === 'company' && !cfg.includeCompanyContacted) return false;
  if (job.dismissedAt) return false;
  if (job.appliedAt) return false;
  if (history[job.uid]) return false;
  if (!detailReady(job)) return false;
  if (!job.match || !Number.isFinite(Number(job.match.score))) return false;
  // 硬门槛（经验 / 学历 / 硬性排除）由 AI 标成 eligible=false：即使分数门槛调得很低也不能投
  if (job.match.eligible === false) return false;
  if (Number(job.match.score) < cfg.threshold) return false;
  if (!job.url || !/^https:\/\/www\.zhipin\.com\/job_detail\//.test(job.url)) return false;
  return matchSearchFilter(job, cfg, { strict: strictFilters }).keep;
}

// 清单快照：只存展示与投递需要的最小字段；岗位库变了也不影响今天已生成的清单
export function applyItemFromJob(job, nowIso = new Date().toISOString()) {
  const m = job.match || {};
  const greeting = job.greetingDraft || m.greeting || (m.greetings && m.greetings.standard) || '';
  return {
    uid: job.uid,
    jobId: job.jobId,
    platform: job.platform,
    title: job.title || '',
    company: job.company || '',
    salaryText: job.salaryText || '',
    city: job.city || '',
    district: job.district || '',
    experience: job.experience || '',
    degree: job.degree || '',
    hrActiveText: job.hrActiveText || '',
    hrActiveAt: job.hrActiveAt || '',
    url: job.url,
    score: Math.round(Number(m.score) || 0),
    verdict: m.verdict || '',
    summary: m.summary || '',
    hasGreeting: !!greeting,
    greetingPreview: String(greeting).slice(0, 120),
    companyContacted: job.contacted === 'company',
    status: 'pending',
    addedAt: nowIso,
    updatedAt: nowIso,
  };
}

// 从岗位库挑出可以进今日清单的岗位：分数、门槛、已沟通、有效期、去重、每日上限。
// existing：今日清单已有条目（用于去重、算剩余名额）；history：历史已投 uid。
export function pickApplyCandidates(jobs, cfg, { existing = [], history = {}, now = new Date(), strictFilters = true } = {}) {
  if (!cfg || !Array.isArray(jobs)) return [];
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  // 每日清单上限按「当天纳入过多少个」算：已经关闭 / 跳过 / 已投的都占名额，
  // 否则用户关掉几个就会不断补新岗位，清单永远清不完。
  const used = (existing || []).length;
  const room = Math.max(0, (cfg.dailyCap || 0) - used);
  if (!room) return [];
  const seen = new Set((existing || []).map((it) => it.uid));
  const pairSeen = new Set((existing || []).map((it) => pairKey(it)));
  const out = [];
  const cands = (jobs || [])
    .filter((j) => eligibleForApply(j, cfg, { history, strictFilters }))
    .filter((j) => !seen.has(j.uid))
    .sort(compareCandidates);
  for (const j of cands) {
    if (out.length >= room) break;
    const key = pairKey(j);
    if (key && pairSeen.has(key)) continue; // 同公司同名岗位只留一条
    pairSeen.add(key);
    seen.add(j.uid);
    out.push(applyItemFromJob(j, nowIso));
  }
  return out;
}

function compareCandidates(a, b) {
  const sa = Number(a.match && a.match.score) || 0;
  const sb = Number(b.match && b.match.score) || 0;
  if (sb !== sa) return sb - sa;
  const ta = hrActivityTier(a);
  const tb = hrActivityTier(b);
  if ((ta == null ? 9 : ta) !== (tb == null ? 9 : tb)) return (ta == null ? 9 : ta) - (tb == null ? 9 : tb);
  return (Number(b.salaryMaxK) || 0) - (Number(a.salaryMaxK) || 0);
}

function pairKey(j) {
  const co = normCompany(j && j.company);
  const title = String((j && j.title) || '').trim();
  if (!co && !title) return '';
  return `${co}|${title}`;
}

// 与 jobsStore.isDetailReady 保持一致（此处为独立副本，避免循环依赖）：
// BOSS 必须读过一次详情（JD + 活跃时间），51job 列表自带 JD。
function detailReady(j) {
  if (!j || !j.description) return false;
  return j.platform === 'boss' ? !!j.detailAt : true;
}

// 与 platforms.normCompany 保持一致（此处为独立副本，避免循环依赖）
function normCompany(s) {
  return String(s || '').trim().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
}

export function countApply(items) {
  const out = { total: 0, applying: 0, pending: 0, applied: 0, rejected: 0, failed: 0, skipped: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    out.total++;
    if (out[it.status] != null) out[it.status]++;
  }
  return out;
}

// 把新候选合进今日清单：保留用户已确认 / 已关闭的状态，只追加没出现过的。
// 跨天自动开一张新清单（历史已投记录单独存，不在这里）。
export function mergeApplyBatch(batch, candidates, { dateKey: key, now = new Date() } = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const day = key || dateKey(now);
  // 跨天时保留「投递中」条目：夜里正好在投的岗位不能被新清单吞掉，
  // 否则后台跑完后 markApplyItems 找不到它，结果静默丢失。其余昨天未处理的条目按日清单规则清空。
  const carry = batch && Array.isArray(batch.items) ? batch.items.filter((it) => it.status === 'applying') : [];
  const prev = batch && batch.date === day && Array.isArray(batch.items) ? batch : { date: day, createdAt: nowIso, items: carry };
  const byUid = new Map(prev.items.map((it) => [it.uid, it]));
  let added = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.uid || byUid.has(c.uid)) continue;
    byUid.set(c.uid, c);
    added++;
  }
  const items = [...byUid.values()].sort(sortItems);
  return {
    batch: { ...prev, date: day, createdAt: prev.createdAt || nowIso, updatedAt: nowIso, items },
    added,
  };
}

function sortItems(a, b) {
  const rank = { applying: 0, pending: 1, failed: 2, applied: 3, skipped: 4, rejected: 5 };
  const ra = rank[a.status] == null ? 9 : rank[a.status];
  const rb = rank[b.status] == null ? 9 : rank[b.status];
  if (ra !== rb) return ra - rb;
  return (Number(b.score) || 0) - (Number(a.score) || 0);
}

export function uniq(list) {
  return [...new Set(Array.isArray(list) ? list : [])];
}
