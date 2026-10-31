// 后台标签页任务：插件自身不向平台发任何请求。
// 需要补全数据时，在后台（不激活）打开真实页面，让页面像用户访问一样自己加载，
// 由该页 content-script 读取、停留一会儿后回报 WORKER_RESULT，随即关闭标签页。
// 节奏尽量模拟人工（见 common/pacing.js，可在设置页调整）：
//  - 同一时间只开一个后台标签页，两次之间偏态随机间隔；
//  - 每处理若干个（随机）就休息一段（随机）；
//  - 只在活跃时段内运行，电脑空闲时暂停；每小时 / 每天有上限；
//  - 遇到验证 / 登录页立即熔断。
import { loadSettings } from '../common/settingsStore.js';
import { sampleSkewed, randInt, inActiveHours, launchGapMs } from '../common/pacing.js';

const HALT_KEY = 'jobHelperWorkerHaltV1'; // { until, reason }
const DAILY_KEY = 'jobHelperWorkerDailyV1'; // { day, count }
const HOURLY_KEY = 'jobHelperWorkerHourlyV1'; // 最近一小时打开的时间戳
const OPEN_KEY = 'jobHelperWorkerTabsV1'; // storage.session：仍开着的后台标签页 id
const CAP_BYPASS_KEY = 'jobHelperWorkerCapBypassV1'; // storage.session：{ until }，用户手动「立即继续」后本轮不受时段 / 额度限制
const IDLE_THRESHOLD_SEC = 180; // 超过 3 分钟无键鼠操作视为离开
const IDLE_WAIT_MAX_MS = 15 * 60 * 1000; // 离开时最多等 15 分钟，仍未回来就放弃本轮

const workers = new Map(); // tabId -> { role, finish }
// 并发：最多同时开 detailConcurrency 个后台标签页；「打开」这一步串行（节奏间隔在这里），打开后各自等结果
let launchChain = Promise.resolve();
let activeTabs = 0;
const slotWaiters = [];
let lastRunAt = 0; // 上一次打开标签页的时间
let sinceBreak = 0; // 距上次休息处理了几个
let breakAfter = 0; // 本轮处理到第几个时休息（随机）

export function tabRoleOf(tabId) {
  const w = workers.get(tabId);
  return w ? w.role : null;
}

// 给后台任务页的 content-script：角色 + 停留节奏（读完数据后在页面上停留多久、是否慢慢滚动）
export function tabTaskOf(tabId) {
  const w = workers.get(tabId);
  if (!w) return { role: null };
  return { role: w.role, dwellMs: Math.round(w.dwellSec.base * 1000), dwellMaxMs: Math.round(w.dwellSec.max * 1000), scroll: w.dwellSec.scroll, scrolls: w.scrolls || 0 };
}

let currentPacing = null;
function dwellFor(role) {
  const p = currentPacing;
  if (!p) return { base: 3, max: 6, scroll: false };
  // 搜索页由 content-script 自己控制滚动节奏，读完立刻回报，不额外停留
  if (role === 'search') return { base: 1, max: 2, scroll: false };
  return {
    base: sampleSkewed(p.dwellMinSec, p.dwellMaxSec),
    max: p.dwellMaxSec,
    scroll: role === 'detail' && p.simulateScroll,
  };
}

export function isWorkerTab(tabId) {
  return workers.has(tabId);
}

// content-script 回报结果
export function reportWorkerResult(tabId, result) {
  const w = workers.get(tabId);
  if (w) w.finish(result || { ok: false });
}

// Service Worker 被回收重启后，内存里的任务表丢失：关掉上一轮遗留的后台标签页，避免它们一直开着
(async () => {
  try {
    const got = await chrome.storage.session.get(OPEN_KEY);
    const ids = Array.isArray(got[OPEN_KEY]) ? got[OPEN_KEY] : [];
    await chrome.storage.session.set({ [OPEN_KEY]: [] });
    for (const id of ids) chrome.tabs.remove(id).catch(() => {});
  } catch {}
})();

async function trackOpen(tabId, open) {
  try {
    const got = await chrome.storage.session.get(OPEN_KEY);
    const ids = new Set(Array.isArray(got[OPEN_KEY]) ? got[OPEN_KEY] : []);
    if (open) ids.add(tabId);
    else ids.delete(tabId);
    await chrome.storage.session.set({ [OPEN_KEY]: Array.from(ids) });
  } catch {}
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const w = workers.get(tabId);
  if (w) w.finish({ ok: false, closed: true });
});

export async function getHalt() {
  const got = await chrome.storage.local.get(HALT_KEY);
  const h = got[HALT_KEY];
  return h && h.until > Date.now() ? h : null;
}

export async function setHalt(reason, ms, kind = '') {
  await chrome.storage.local.set({ [HALT_KEY]: { until: Date.now() + ms, reason, kind } });
}

// 「未登录」熔断：用户登录后就该失效（旧记录没有 kind，按原因文字判断）
export function isLoginHalt(h) {
  return !!h && (h.kind === 'login' || /未登录/.test(h.reason || ''));
}

export async function clearHalt() {
  await chrome.storage.local.remove(HALT_KEY);
}

// 用户手动「立即继续」：本轮队列补完前（最多到今天结束）不再按活跃时段 / 每小时 / 每天额度挂起，
// 否则额度没变、一继续马上又被同一个原因暂停。打开间隔、熔断照旧。
export async function setCapBypass(on) {
  try {
    if (!on) return await chrome.storage.session.remove(CAP_BYPASS_KEY);
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    await chrome.storage.session.set({ [CAP_BYPASS_KEY]: { until: end.getTime() } });
  } catch {}
}

async function capBypassed() {
  try {
    const b = (await chrome.storage.session.get(CAP_BYPASS_KEY))[CAP_BYPASS_KEY];
    return !!b && b.until > Date.now();
  } catch {
    return false;
  }
}

// 每天额度：用完返回原因（当天不再继续）；打开成功才计数
async function dailyExceeded(p) {
  const day = new Date().toISOString().slice(0, 10);
  const got = await chrome.storage.local.get(DAILY_KEY);
  const daily = got[DAILY_KEY] && got[DAILY_KEY].day === day ? got[DAILY_KEY].count : 0;
  return daily >= p.dailyCap ? `今日后台补全已达 ${p.dailyCap} 次上限` : '';
}

// 每小时额度：满了返回还要等多久（毫秒），未满返回 0。满了是等，不是放弃整个队列
async function hourlyWaitMs(p) {
  const got = await chrome.storage.local.get(HOURLY_KEY);
  const hourAgo = Date.now() - 3600 * 1000;
  const hourly = (Array.isArray(got[HOURLY_KEY]) ? got[HOURLY_KEY] : []).filter((t) => t > hourAgo).sort((a, b) => a - b);
  if (hourly.length < p.hourlyCap) return 0;
  return hourly[hourly.length - p.hourlyCap] + 3600 * 1000 - Date.now() + 1000;
}

async function countQuota() {
  const day = new Date().toISOString().slice(0, 10);
  const got = await chrome.storage.local.get([DAILY_KEY, HOURLY_KEY]);
  const cur = got[DAILY_KEY] && got[DAILY_KEY].day === day ? got[DAILY_KEY] : { day, count: 0 };
  cur.count++;
  const hourAgo = Date.now() - 3600 * 1000;
  const hourly = (Array.isArray(got[HOURLY_KEY]) ? got[HOURLY_KEY] : []).filter((t) => t > hourAgo);
  hourly.push(Date.now());
  await chrome.storage.local.set({ [DAILY_KEY]: cur, [HOURLY_KEY]: hourly });
}

// 用户是否在用电脑（无 idle 权限时视为在用）
async function userActive() {
  try {
    const state = await chrome.idle.queryState(IDLE_THRESHOLD_SEC);
    return state === 'active';
  } catch {
    return true;
  }
}

// 运行前的人工节奏检查：返回 { reason, retryMs? }，reason 非空表示本轮放弃，retryMs 是建议多久后再试。
// urgent：用户刚点了「AI 分析」等，人就在跟前——不休息、只用较短的间隔。
// scheduled：用户预约的每日任务（如每天 9 点自动刷 BOSS）——不受活跃时段与电脑空闲限制，
// 但仍受每小时 / 每天上限、打开间隔、验证熔断约束。
// ignoreCaps：只给每日搜索页用。搜索本身一天只有几次，不应该被补详情的额度耗尽而整个跳过。
async function paceBeforeOpen(p, urgent, scheduled = false, ignoreCaps = false) {
  if (!(await capBypassed())) {
    if (!scheduled && !inActiveHours(p.activeHours)) return { reason: `不在设定的活跃时段（${p.activeHours}）` };
    if (!ignoreCaps) {
      const daily = await dailyExceeded(p);
      if (daily) return { reason: daily };
      // 本小时额度满了：不在这里干等（界面看不到原因，像卡死），交给调用方挂起，到最早那次滑出一小时窗口时再继续
      const hourWait = await hourlyWaitMs(p);
      if (hourWait > 0) return { reason: `近一小时后台补全已达 ${p.hourlyCap} 次上限`, retryMs: hourWait };
    }
  }
  if (urgent) {
    const gap = Math.max(1500, sampleSkewed(p.gapMinSec, Math.min(p.gapMaxSec, p.gapMinSec * 2)) * 1000 / Math.max(1, p.detailConcurrency));
    const wait = lastRunAt + gap - Date.now();
    if (wait > 0) await keepAliveSleep(wait);
    return {};
  }
  if (!scheduled && p.onlyWhenActive && !(await userActive())) {
    // 人离开了：等回来再继续，太久就放弃本轮（下次浏览列表时会重新排队）
    const t0 = Date.now();
    while (!(await userActive())) {
      if (Date.now() - t0 > IDLE_WAIT_MAX_MS) return { reason: '电脑长时间空闲，后台补全已暂停' };
      await keepAliveSleep(15000);
    }
  }
  // 每处理若干个就休息一段，像人看一会儿就停下（预约任务不额外休息，避免整条流水线拖到第二天）
  if (!scheduled) {
    if (!breakAfter) breakAfter = randInt(p.breakEveryMin, p.breakEveryMax);
    if (sinceBreak >= breakAfter) {
      await keepAliveSleep(sampleSkewed(p.breakMinSec, p.breakMaxSec) * 1000);
      sinceBreak = 0;
      breakAfter = randInt(p.breakEveryMin, p.breakEveryMax);
    }
  }
  // 与上一次打开之间的随机间隔（按并发数摊薄；第一个也等，不在列表刚加载完就立刻打开）
  const gap = launchGapMs(p);
  const wait = Math.max(lastRunAt + gap - Date.now(), lastRunAt ? 0 : gap);
  if (wait > 0) await keepAliveSleep(wait);
  return {};
}

// 在后台标签页打开 url，等待 content-script 回报（或超时），然后关闭。
// 返回 { ok, blocked?, ... } ；被熔断 / 额度 / 时段限制时返回 { ok:false, skipped: 原因, retryMs?: 建议多久后再试 }。
// 同时最多 detailConcurrency 个在进行（urgent 可多占一个，用户点了分析不必排在后台补全后面）。
export async function runInBackgroundTab(url, role, { timeoutMs = 30000, windowId, urgent = false, scheduled = false, scrolls = 0, ignoreCaps = false } = {}) {
  const limit = Math.max(1, (await loadSettings()).pacing.detailConcurrency) + (urgent ? 1 : 0);
  await acquireSlot(limit);
  try {
    // 「打开」串行：节奏检查、间隔、计数都在这里，保证打开时刻是错开的
    const launch = launchChain.then(async () => {
      const halt = await getHalt();
      // 用户刚点了分析（urgent）时，「未登录」熔断不拦：可能已经登录了，打开一次试试，仍未登录会重新熔断
      if (halt && !(urgent && isLoginHalt(halt))) return { skipped: halt.reason };
      const p = (await loadSettings()).pacing;
      currentPacing = p;
      const pace = await paceBeforeOpen(p, urgent, scheduled, ignoreCaps);
      if (pace.reason) return { skipped: pace.reason, retryMs: pace.retryMs };
      const halt2 = await getHalt(); // 等待期间可能被别的标签页触发了熔断
      if (halt2 && !(urgent && isLoginHalt(halt2))) return { skipped: halt2.reason };
      await countQuota();
      lastRunAt = Date.now();
      sinceBreak++;
      // 超时要覆盖页面停留时长
      return await openTab(url, role, timeoutMs + p.dwellMaxSec * 1000, windowId, scrolls); // { wait }
    });
    launchChain = launch.catch(() => {});
    const l = await launch;
    if (l.skipped) return { ok: false, skipped: l.skipped, retryMs: l.retryMs };
    const result = await l.wait;
    // 只开一个时保持原来的节奏：间隔从上一个页面关掉之后算（看完、停一下、再点下一个）
    if (currentPacing && currentPacing.detailConcurrency <= 1) lastRunAt = Date.now();
    if (result.blocked) {
      const why = result.blocked === 'login' ? 'BOSS 未登录，后台补全已暂停' : 'BOSS 触发安全验证，后台补全暂停 30 分钟';
      await setHalt(why, result.blocked === 'login' ? 10 * 60 * 1000 : 30 * 60 * 1000, result.blocked);
      result.haltReason = why;
    } else if (result.ok) {
      // 读取成功说明登录态正常，残留的「未登录」熔断作废
      const h = await getHalt();
      if (isLoginHalt(h)) await clearHalt();
    }
    return result;
  } finally {
    releaseSlot();
  }
}

async function acquireSlot(limit) {
  while (activeTabs >= limit) await new Promise((r) => slotWaiters.push(r));
  activeTabs++;
}

function releaseSlot() {
  activeTabs--;
  slotWaiters.splice(0).forEach((r) => r()); // 全部唤醒，各自按自己的上限重新判断
}

// 打开标签页，返回 { wait }：wait 是「等它出结果」的 Promise。包在对象里返回——
// 直接返回 Promise 会被 async/await 自动展开，变成等页面读完才返回，下一个就没法并发打开了
async function openTab(url, role, timeoutMs, windowId, scrolls = 0) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false, ...(windowId != null ? { windowId } : {}) });
  } catch (e) {
    // 原窗口可能已经关闭：退回当前窗口再试一次，避免整条补全队列被一个失效 windowId 拖死
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e2) {
      return { wait: Promise.resolve({ ok: false, error: e2 instanceof Error ? e2.message : String(e2) }) };
    }
  }
  const wait = new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ping);
      workers.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
      trackOpen(tab.id, false);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, timeout: true }), timeoutMs);
    const ping = setInterval(keepAlive, 20000); // 页面停留期间保持后台存活
    workers.set(tab.id, { role, finish, dwellSec: dwellFor(role), scrolls });
    trackOpen(tab.id, true);
  });
  return { wait };
}

// MV3 Service Worker 空闲 30 秒会被回收，单纯 setTimeout 不能续命；
// 调用任一扩展 API 会重置空闲计时，长等待期间每 20 秒调一次。
function keepAlive() {
  chrome.runtime.getPlatformInfo().catch(() => {});
}

async function keepAliveSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    keepAlive();
    await new Promise((r) => setTimeout(r, Math.min(20000, end - Date.now())));
  }
}
