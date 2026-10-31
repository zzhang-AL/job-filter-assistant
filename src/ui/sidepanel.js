import { MSG, MODE } from '../common/constants.js';
import { scoreProfile } from '../common/profile.js';
import { applyFilters } from '../common/filters.js';
import { hrActivityTier, activitySortKey, isStaleHr } from '../common/activity.js';
import { APPLY_STATUS_LABELS } from '../common/autoApply.js';
import { VERDICT_LABELS, GREETING_LEVELS, normalizeGreetings, DIM_LABELS } from '../common/ai/prompts.js';
import { send, h, toast, debounce, fmtTime } from './ui-common.js';
import { icon } from './icons.js';
import { iconBtn, emptyState, notice, openMenu, isMenuOpen, onMenuClosed, opt } from './components.js';
import { buildDetailedCsv } from './exportCsv.js';

const app = document.getElementById('app');

let jobs = [];
let settings = null;
let profile = null;
let providers = [];
let activeCtx = null; // 当前激活标签页上下文：{platform, jobKey, isChat}
const scoring = new Set(); // 正在打分的 uid

// 视图状态
const view = {
  tab: 'library', // library | apply | current
  sub: 'info', // 当前岗位子页：info | company | greeting
  greetLevel: 'standard', // 招呼语档位：short | standard | detailed
  search: '',
  verdict: 'all',
  sort: 'active', // 默认 HR 活跃优先
  platform: 'all',
};
let lastMode = null; // 上次同步到筛选的平台模式
// 本地预览用：dev/sidepanel.html?tab=apply 可直接打开投递页；正式侧边栏没有这个参数
try {
  const devTab = new URLSearchParams(location.search).get('tab');
  if (devTab === 'apply' || devTab === 'current') view.tab = devTab;
} catch {}
let selectedUid = null; // 手动选中的「当前岗位」；null 时按页面自动识别
const greetingCache = new Map(); // uid -> 编辑中的招呼语文本（会话态）
let greetingTextarea = null; // 当前渲染的招呼语输入框引用
const tailorCache = new Map(); // uid -> 简历定制建议（仅会话态，不落库）
const tailoring = new Set(); // 正在生成简历建议的 uid
const greeting = new Set(); // 正在生成招呼语的 uid
const greetTried = new Set(); // 本次打开侧边栏已自动生成过招呼语的 uid（失败不自动重试）
const greetFailed = new Map(); // uid -> 生成失败原因
const checked = new Set(); // 岗位库中勾选的 uid（批量操作）
let batchBusy = false; // 批量分析进行中（禁用按钮 + 防重入）
let autoStatus = null; // 后台状态 { running, pending, done, lastError, lastErrorAt, detail: { running, pending, halted, resumeAt } }
let batchState = null; // 批量进行中的最新进度（底栏进度条），即 BATCH_STATUS 的返回值
let batchStopping = false;
let applyStatus = null; // 今日投递清单 + 每日搜索状态 + 投递进度
const applyChecked = new Set(); // 投递清单里勾选的 uid
let applyAutoSelKey = ''; // 已经自动全选过的清单日期（每天只自动选一次，不覆盖用户取消）
let applyRefreshTimer = null;
let dismissedErrorAt = 0; // 关掉过的自动分析错误（按出错时间记，新错误照常提示）
// 点「打开原岗位」后该页会被收录（刷新最近出现、补上 HR 活跃），卡片不能因此跳位：排序沿用点击时的值（会话态）
const sortFrozen = new Map(); // uid -> { lastSeenAt, savedAt, hrActiveText, hrOnline }
// 不感兴趣：标完先原地折叠成一行（列表不跳、可撤销），换筛选 / 排序后才移进「不感兴趣」分组
const dismissedHere = new Set();
let lastListKey = '';
// 用「原岗位」打开的标签页被关掉 = 看完了：卡片上问一句要不要标不感兴趣
const openedTabs = new Map(); // tabId -> uid
const reviewing = new Set(); // 正在显示「看完了？」提示的 uid
const REVIEW_TTL = 3 * 60 * 1000;

async function boot() {
  await reload();
  // 后台有正在进行的批量（侧边栏关掉期间仍在跑，或后台重启后恢复的）：接上进度
  send(MSG.BATCH_STATUS).then((st) => {
    if (st && st.running && !batchBusy) watchBatch(st);
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === MSG.JOBS_UPDATED || msg.type === MSG.CONTACTS_UPDATED) {
      // 自动流水线运行时这类广播很密（每补一个详情、每出一个分数都会发），合并成一次刷新
      reloadSoon();
    } else if (msg.type === MSG.AUTO_STATUS) {
      autoStatus = msg.status;
      updateStatus();
    } else if (msg.type === MSG.APPLY_UPDATED) {
      // 搜索进度 / 投递进度可能很密：合并刷新，避免每个岗位都重绘
      clearTimeout(applyRefreshTimer);
      applyRefreshTimer = setTimeout(async () => {
        const wasRunning = !!(applyStatus && applyStatus.run && applyStatus.run.state === 'running');
        await refreshApplyStatus();
        if (view.tab !== 'apply') return;
        const nowRunning = !!(applyStatus && applyStatus.run && applyStatus.run.state === 'running');
        // 投递进行中只刷新状态条和底栏，避免每投一个岗位整页重绘、列表滚回顶部；
        // 结束那一次要整页重绘，才能把卡片上的「投递中」换成最终状态。
        if (wasRunning && nowRunning) {
          const old = document.getElementById('sp-apply-status');
          if (old) old.replaceWith(renderApplyStatusBar());
          fillApplyBottom(document.getElementById('sp-apply-bottom'));
        } else {
          render();
        }
      }, 300);
    } else if (msg.type === MSG.CURRENT_JOB) {
      // 网站上点开了新岗位：取消手动固定，跟随网站，实时刷新当前岗位视图
      onCurrentJobChanged();
    }
  });
}

// 暂停提示里的「约 N 分钟后自动继续」要走表
setInterval(() => {
  if (autoStatus && autoStatus.detail && autoStatus.detail.halted) updateStatus();
}, 30000);

// 「/」聚焦搜索框（不在输入时）
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || isTyping() || view.tab !== 'library') return;
  const input = app.querySelector('.sp-search input');
  if (!input) return;
  e.preventDefault();
  input.focus();
});

async function onCurrentJobChanged() {
  selectedUid = null;
  await refreshContext();
  if (view.tab === 'current') render();
}

const reloadSoon = debounce(() => reload({ background: true }), 600);

// background：由后台广播触发的刷新。用户正在输入（招呼语、搜索框）时先不重绘，等失焦后再补，避免打断输入
let pendingRender = false;
function isTyping() {
  const el = document.activeElement;
  if (!el || !app.contains(el)) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)) || el.isContentEditable;
}
onMenuClosed(() => {
  if (pendingRender && !isTyping()) render();
});
app.addEventListener('focusout', () => {
  if (!pendingRender) return;
  setTimeout(() => {
    if (pendingRender && !isTyping()) {
      pendingRender = false;
      render();
    }
  }, 0);
});

async function reload({ background = false } = {}) {
  try {
    [jobs, settings, profile, providers, activeCtx] = await Promise.all([
      send(MSG.JOB_LIST_REQUEST),
      send(MSG.SETTINGS_GET),
      send(MSG.PROFILE_GET),
      send(MSG.AI_PROVIDERS_GET),
      send(MSG.ACTIVE_CONTEXT_REQUEST).catch(() => null),
    ]);
    autoStatus = await send(MSG.AUTO_STATUS_GET).catch(() => autoStatus);
    await refreshApplyStatus();
    // 平台筛选以用户最后一次的选择为准（侧边栏重开也保留）；只有模式设置真的被改了才跟随模式。
    // 后台刷新（收录、标记已沟通、出分数等）不能覆盖用户手动点选的平台
    if (lastMode === null) {
      lastMode = settings.mode;
      view.platform = loadPlatformFilter() || modePlatform(settings.mode);
    } else if (settings.mode !== lastMode) {
      lastMode = settings.mode;
      setPlatformFilter(modePlatform(settings.mode));
    }
  } catch (e) {
    app.innerHTML = '';
    app.appendChild(emptyState('alert', '加载失败', e.message));
    return;
  }
  if (background && isTyping()) {
    // 焦点在搜索框：只刷新列表（不动输入框），新收录的岗位照常出现；其他输入（招呼语等）等失焦再重绘
    if (view.tab === 'library' && document.activeElement && document.activeElement.closest('.sp-search')) {
      refreshLibraryList();
      return;
    }
    pendingRender = true;
    return;
  }
  // 投递页：后台每投一个岗位都会广播，重绘时保留滚动位置，避免列表不断跳回顶部
  if (view.tab === 'apply') {
    const old = app.querySelector('.sp-list');
    const top = old ? old.scrollTop : 0;
    render();
    const next = app.querySelector('.sp-list');
    if (next) next.scrollTop = top;
    return;
  }
  render();
}

async function refreshApplyStatus() {
  applyStatus = await send(MSG.AUTO_APPLY_STATUS_GET).catch(() => applyStatus);
  syncApplySelection(applyStatus);
  return applyStatus;
}

// 每天第一次看到清单时清空勾选；默认不勾选任何岗位，必须由用户主动「全选待确认」再确认。
// 投递会真实发起沟通，不能因为默认全选而误触。
function syncApplySelection(st) {
  const items = (st && st.batch && st.batch.items) || [];
  const day = (st && st.batch && st.batch.date) || '';
  if (day && day !== applyAutoSelKey) {
    applyAutoSelKey = day;
    applyChecked.clear();
  }
  const alive = new Set(items.filter((it) => it.status === 'pending').map((it) => it.uid));
  for (const uid of [...applyChecked]) if (!alive.has(uid)) applyChecked.delete(uid);
}

const PLATFORM_FILTER_KEY = 'jobHelperSpPlatform';
const modePlatform = (mode) => (mode === MODE.auto ? 'all' : mode);
function loadPlatformFilter() {
  try {
    const v = localStorage.getItem(PLATFORM_FILTER_KEY);
    return ['all', 'boss', 'qcwy'].includes(v) ? v : null;
  } catch {
    return null;
  }
}
function setPlatformFilter(v) {
  view.platform = v;
  try {
    localStorage.setItem(PLATFORM_FILTER_KEY, v);
  } catch {}
}

async function refreshContext() {
  try {
    activeCtx = await send(MSG.ACTIVE_CONTEXT_REQUEST);
  } catch {
    activeCtx = null;
  }
}

// —— 当前岗位解析：优先手动选中，其次按页面识别 ——
function currentJob() {
  if (selectedUid) {
    const j = jobs.find((x) => x.uid === selectedUid);
    if (j) return j;
  }
  return pageJob();
}

// 当前网页上打开的岗位（已收录的才有）
function pageJob() {
  if (!activeCtx || !activeCtx.platform || !activeCtx.jobKey) return null;
  const uid = `${activeCtx.platform}:${activeCtx.jobKey}`;
  return jobs.find((x) => x.uid === uid) || null;
}

function greetingsOf(match) {
  return normalizeGreetings(match || {});
}

// 招呼语当前应显示的文本：编辑态 > 已存草稿 > AI 生成的对应档位
function greetingValueFor(job) {
  if (greetingTextarea && greetingTextarea.dataset.uid === job.uid) return greetingTextarea.value;
  if (greetingCache.has(job.uid)) return greetingCache.get(job.uid);
  if (job.greetingDraft) return job.greetingDraft;
  return greetingsOf(job.match)[view.greetLevel] || '';
}

// 已沟通的岗位按设置隐藏（与收录规则一致）；屏蔽的岗位已移出岗位库
function hiddenAsContacted(j) {
  if (!j.contacted || !settings.skipContacted) return false;
  return j.contacted === 'job' || settings.skipContactedCompanies;
}

const verdictOf = (j) => (j.match ? j.match.verdict : 'unscored');

// 除匹配档以外的筛选（平台 / 本地筛选规则 / 搜索）：匹配档 chip 上的计数基于它
function baseJobs() {
  let list = jobs.filter((j) => !hiddenAsContacted(j));
  if (view.platform !== 'all') list = list.filter((j) => j.platform === view.platform);
  list = applyFilters(list, settings.filters);
  const q = view.search.trim().toLowerCase();
  if (q) {
    list = list.filter((j) =>
      [j.title, j.company, j.city, (j.skills || []).join(' '), (j.tags || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }
  return list;
}

// 不感兴趣的岗位只在「不感兴趣」筛选里出现；本次刚标的留在原位（折叠显示）
const inMainList = (j) => !j.dismissedAt || dismissedHere.has(j.uid);

function visibleJobs() {
  let list = baseJobs();
  if (view.verdict === 'dismissed') list = list.filter((j) => j.dismissedAt);
  else {
    list = list.filter(inMainList);
    if (view.verdict !== 'all') list = list.filter((j) => verdictOf(j) === view.verdict);
  }
  const byScore = (a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1);
  const byRecent = (a, b) => (b.lastSeenAt || b.savedAt || '').localeCompare(a.lastSeenAt || a.savedAt || '');
  let cmp;
  if (view.sort === 'score') cmp = byScore;
  else if (view.sort === 'salary') cmp = (a, b) => (b.salaryMaxK ?? b.salaryMinK ?? 0) - (a.salaryMaxK ?? a.salaryMinK ?? 0);
  else if (view.sort === 'recent') cmp = byRecent;
  else cmp = (a, b) => activitySortKey(a) - activitySortKey(b) || byScore(a, b) || byRecent(a, b); // HR 活跃优先，同档按匹配分
  // 任何排序下，HR 数月 / 半年未活跃的都沉到最后
  const sortView = (j) => (sortFrozen.has(j.uid) ? { ...j, ...sortFrozen.get(j.uid) } : j);
  return list
    .map((j) => [sortView(j), j])
    .sort(([a], [b]) => (isStaleHr(a) - isStaleHr(b)) || cmp(a, b))
    .map(([, j]) => j);
}

// 重绘会重建滚动容器，需要还原滚动位置：
//  - 岗位库列表：按「平台 / 匹配档 / 排序 / 搜索」分别记住位置（存 localStorage），
//    切到「当前岗位」再回来、侧边栏关掉重开、后台刷新都回到原处；换了筛选条件则用该条件自己的位置
//  - 当前岗位详情：只在同一岗位、同一子页重绘时还原（换岗位 / 子页签从顶部开始）
const LIST_SCROLL_KEY = 'jobHelperSpListScroll';
const listScroll = loadListScroll();
let lastViewKey = '';
function loadListScroll() {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_SCROLL_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
const saveListScroll = debounce(() => {
  try {
    localStorage.setItem(LIST_SCROLL_KEY, JSON.stringify(listScroll));
  } catch {}
}, 300);
const listScrollKey = () => [view.platform, view.verdict, view.sort, view.search.trim()].join('|');

function render() {
  // 菜单开着时先不重绘（后台广播很密，会把菜单连同锚点一起冲掉），关掉菜单后补上
  if (isMenuOpen()) {
    pendingRender = true;
    return;
  }
  const cur = view.tab === 'current' ? currentJob() : null;
  const viewKey = view.tab === 'current' ? `current|${cur ? cur.uid : ''}|${view.sub}` : 'library';
  // 同一视图的重绘（后台广播刷新、点星标等）不再播放淡入动画，否则整列卡片会一起闪一下
  app.classList.toggle('no-anim', viewKey === lastViewKey);
  const curBody = viewKey === lastViewKey ? app.querySelector('.cur-body') : null;
  const curTop = curBody ? curBody.scrollTop : 0;
  lastViewKey = viewKey;
  if (view.tab === 'library' && listScrollKey() !== lastListKey) {
    lastListKey = listScrollKey();
    dismissedHere.clear();
  }
  renderNow();
  if (view.tab === 'current') {
    const el = app.querySelector('.cur-body');
    if (el && curTop) el.scrollTop = curTop;
    return;
  }
  const list = app.querySelector('.sp-list');
  if (!list) return;
  const key = listScrollKey();
  if (listScroll[key]) list.scrollTop = listScroll[key];
  list.addEventListener('scroll', () => {
    listScroll[listScrollKey()] = list.scrollTop;
    saveListScroll();
  }, { passive: true });
}

function renderNow() {
  pendingRender = false;
  greetingTextarea = null;
  app.innerHTML = '';

  if (view.tab === 'current') {
    app.appendChild(renderTopBar(0, 'current'));
    app.appendChild(renderCurrent());
    return;
  }

  if (view.tab === 'apply') {
    app.appendChild(renderTopBar(0, 'apply'));
    app.appendChild(renderApplyStatusBar());
    const listEl = h('div', { class: 'sp-list apply-list' });
    fillApplyList(listEl);
    app.appendChild(listEl);
    app.appendChild(renderApplyBottom());
    return;
  }

  const list = visibleJobs();
  app.appendChild(renderTopBar(list.length, 'library'));
  app.appendChild(h('div', { id: 'sp-status', class: 'sp-status' }));
  updateStatus();

  const listEl = h('div', { class: 'sp-list' });
  fillList(listEl, list);
  app.appendChild(listEl);
  app.appendChild(renderBottom(list));
}

function fillList(listEl, list) {
  listEl.innerHTML = '';
  if (!list.length) {
    const any = jobs.some((j) => !hiddenAsContacted(j));
    const filtered = any && (view.search.trim() || view.verdict !== 'all' || view.platform !== 'all');
    listEl.appendChild(
      emptyState(
        any ? 'search' : 'inbox',
        any ? '没有符合条件的岗位' : '还没有收录岗位',
        any ? '换个关键词，或放宽平台 / 匹配档筛选' : '打开 BOSS直聘 或 前程无忧 浏览岗位，列表里的岗位会自动收录到这里',
        filtered ? { label: '清除筛选', onClick: clearFilters } : null,
      ),
    );
  } else {
    for (const job of list) listEl.appendChild(renderCard(job));
  }
}

function clearFilters() {
  view.search = '';
  view.verdict = 'all';
  setPlatformFilter('all');
  render();
}

// 搜索时只换列表内容、计数、筛选计数与底栏，顶栏里的搜索框保持不动
function refreshLibraryList() {
  const listEl = app.querySelector('.sp-list');
  if (view.tab !== 'library' || !listEl) return render();
  const list = visibleJobs();
  fillList(listEl, list);
  listEl.scrollTop = listScroll[listScrollKey()] || 0;
  const count = document.getElementById('sp-count');
  if (count) count.textContent = countText(list.length);
  const filters = document.getElementById('sp-filters');
  if (filters) filters.replaceWith(renderFilters());
  updateBatchBar();
}

function countText(shown) {
  const total = jobs.filter((j) => !hiddenAsContacted(j)).length;
  return shown === total ? `共 ${total} 个岗位` : `显示 ${shown} / 共 ${total} 个岗位`;
}

// —— 顶栏：标题 + 顶级 Tab（岗位库/当前岗位）+（岗位库时）搜索、排序、筛选 ——
function renderTopBar(shown, mode) {
  const head = h('div', { class: 'sp-head' }, [
    h('div', { class: 'sp-logo', text: '🎯' }),
    h('div', { class: 'sp-head-text' }, [
      h('div', { class: 'sp-title', text: '岗位面板' }),
      h('div', { class: 'sp-count', id: 'sp-count', text: mode === 'library' ? countText(shown) : mode === 'apply' ? applyCountText() : ctxLabel() }),
    ]),
    h('div', { class: 'spacer' }),
    mode === 'current'
      ? iconBtn('refresh', '重新识别网页上打开的岗位', async () => {
          selectedUid = null;
          await refreshContext();
          render();
        })
      : mode === 'apply'
        ? iconBtn('refresh', '刷新今日投递清单', async () => {
            try {
              await send(MSG.APPLY_REFRESH);
              await refreshApplyStatus();
              render();
              toast('清单已刷新');
            } catch (e) {
              toast(e.message, true);
            }
          })
        : null,
    iconBtn('gear', '设置', () => send(MSG.OPEN_OPTIONS)),
  ]);

  const pendingApply = (applyStatus && applyStatus.batch && applyStatus.batch.counts && applyStatus.batch.counts.pending) || 0;
  const tabs = h('div', { class: 'sp-tabs', role: 'tablist' }, [
    tabBtn('library', '岗位库'),
    tabBtn('apply', pendingApply ? `投递 ${pendingApply}` : '投递'),
    tabBtn('current', '当前岗位'),
  ]);
  const children = [head, tabs];

  if (mode === 'library') {
    const searchInput = h('input', { type: 'text', placeholder: '搜索岗位 / 公司 / 技能', title: '按 / 快速聚焦', value: view.search });
    const searchBox = h('div', { class: 'sp-search' + (view.search ? ' has-value' : '') }, [
      icon('search', { cls: 'sp-search-ico' }),
      searchInput,
      h('button', {
        class: 'sp-search-clear',
        title: '清空搜索',
        'aria-label': '清空搜索',
        onclick: () => {
          searchInput.value = '';
          searchBox.classList.remove('has-value');
          applySearch();
          searchInput.focus();
        },
      }, [icon('close', { size: 12 })]),
    ]);
    // 只刷新列表、不整页重绘：重建输入框会打断中文输入法组字、丢光标。
    // 组字中（拼音还没上屏）不筛选；停顿 400ms 或按回车再应用
    const applySearch = () => {
      if (view.search === searchInput.value) return;
      view.search = searchInput.value;
      refreshLibraryList();
    };
    const applySoon = debounce(applySearch, 400);
    searchInput.addEventListener('input', (e) => {
      searchBox.classList.toggle('has-value', !!searchInput.value);
      if (!e.isComposing) applySoon();
    });
    searchInput.addEventListener('compositionend', applySoon);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) applySearch();
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchBox.classList.remove('has-value');
        applySearch();
        searchInput.blur();
      }
    });

    // 平台筛选用下拉、和排序并排：只收录了一个平台时不显示
    let platSel = null;
    if (new Set(jobs.map((j) => j.platform)).size > 1 || view.platform !== 'all') {
      platSel = h('select', { class: 'sp-select' + (view.platform !== 'all' ? ' active' : ''), title: '平台', 'aria-label': '平台' }, [
        opt('all', '全部平台'),
        opt('boss', 'BOSS'),
        opt('qcwy', '51job'),
      ]);
      platSel.value = view.platform;
      platSel.addEventListener('change', () => { setPlatformFilter(platSel.value); render(); });
    }

    const sortSel = h('select', { class: 'sp-select', title: '排序方式', 'aria-label': '排序方式' }, [
      opt('active', '活跃优先'),
      opt('score', '匹配分优先'),
      opt('recent', '最近收录'),
      opt('salary', '薪资最高'),
    ]);
    sortSel.value = view.sort;
    sortSel.addEventListener('change', () => { view.sort = sortSel.value; render(); });

    children.push(h('div', { class: 'sp-toolbar' }, [searchBox, platSel, sortSel]), renderFilters());
  }

  return h('div', { class: 'sp-top' }, children);
}

// 匹配档筛选，带计数（基于当前平台 / 搜索），一眼看出各档有多少
function renderFilters() {
  const all = baseJobs();
  const base = all.filter((j) => !j.dismissedAt);
  const dismissedN = all.length - base.length;
  const countOf = (v) => (v === 'dismissed' ? dismissedN : v === 'all' ? base.length : base.filter((j) => verdictOf(j) === v).length);
  const chip = (active, label, onclick, n) =>
    h('button', { class: 'filter-chip' + (active ? ' active' : ''), onclick, 'aria-pressed': active ? 'true' : 'false' }, [
      label,
      n != null ? h('span', { class: 'chip-n', text: String(n) }) : null,
    ]);

  return h('div', { class: 'sp-filters', id: 'sp-filters' },
    [['all', '全部'], ['strong', '强匹配'], ['good', '较匹配'], ['fair', '一般'], ['unscored', '未分析'], ['dismissed', '不感兴趣']]
      .filter(([v]) => v !== 'dismissed' || dismissedN || view.verdict === v)
      .map(([v, label]) => chip(view.verdict === v, label, () => { view.verdict = v; render(); }, countOf(v))),
  );
}

function tabBtn(key, label) {
  const active = view.tab === key;
  return h('button', {
    class: 'sp-tab' + (active ? ' active' : ''),
    role: 'tab',
    'aria-selected': active ? 'true' : 'false',
    text: label,
    onclick: async () => {
      if (view.tab === key) return;
      view.tab = key;
      if (key === 'current') await refreshContext();
      if (key === 'apply') await refreshApplyStatus();
      render();
    },
  });
}

function ctxLabel() {
  const job = currentJob();
  if (job) return `${job.platform === 'boss' ? 'BOSS' : '51job'} · ${job.company || '当前岗位'}`;
  if (activeCtx && activeCtx.platformName) return `${activeCtx.platformName} · 未匹配到收录岗位`;
  return '未识别到岗位页面';
}

function jobMenuItems(job) {
  return [
    job.viewedAt
      ? { icon: 'eye', label: '标为没看过', onClick: () => markJobsUi([job.uid], { viewed: false }) }
      : { icon: 'eye', label: '标为看过', hint: '卡片变淡，排序不变', onClick: () => markJobsUi([job.uid], { viewed: true }) },
    job.contacted !== 'job'
      ? { icon: 'chat', label: '标记为已沟通', hint: '不再收录，也不参与批量 / 自动匹配', onClick: () => markContactedUi([job.uid]) }
      : null,
    { icon: 'block', label: '屏蔽该岗位', hint: '移出岗位库，之后不再收录', danger: true, onClick: () => blockJobsUi([job.uid]) },
    { icon: 'trash', label: '从岗位库删除', hint: '再次浏览到时会重新收录', danger: true, onClick: () => deleteJobUi(job) },
  ].filter(Boolean);
}

// ============ 岗位库卡片 ============
function scoreBox(job, title) {
  const m = job.match;
  const busy = scoring.has(job.uid);
  return h('button', { class: 'jc-score', title: busy ? '分析中…' : title || (m ? '点击重新分析' : '点击 AI 分析'), disabled: busy, onclick: () => analyze(job, !!m) },
    m
      ? [h('span', { class: `score-badge verdict-${m.verdict}`, text: String(m.score) }), h('span', { class: 'lbl', text: VERDICT_LABELS[m.verdict] || '' })]
      : busy
      ? [h('span', { class: 'score-badge score-pending' }, [h('span', { class: 'spinner' })]), h('span', { class: 'lbl', text: '分析中' })]
      : [h('span', { class: 'score-badge score-empty', text: '—' }), h('span', { class: 'lbl', text: '未分析' })],
  );
}

function renderCard(job) {
  if (job.dismissedAt) return renderDismissedCard(job);
  const m = job.match;
  const busy = scoring.has(job.uid);
  const risks = (job._filter && job._filter.risks) || [];

  const tags = [];
  const act = activityChip(job);
  if (act) tags.push(act);
  if (job.contacted) tags.push(contactedChip(job));
  if (!m && (job.autoScoreFails || 0) >= 2) {
    tags.push(h('span', { class: 'chip chip-red', text: '自动分析失败', title: `${job.autoScoreError || ''}（已不再自动重试，可点「AI 分析」手动重试）` }));
  }
  for (const r of risks.slice(0, 2)) tags.push(h('span', { class: 'chip chip-red', text: '⚠ ' + r }));
  for (const t of (job.skills.length ? job.skills : job.tags).slice(0, 4)) tags.push(h('span', { class: 'chip', text: t }));

  const meta = [job.city && job.city + (job.district ? ' · ' + job.district : ''), job.experience, job.degree, job.companyScale].filter(Boolean);

  const isChecked = checked.has(job.uid);
  const cb = h('input', { type: 'checkbox', 'aria-label': `勾选 ${job.title}` });
  cb.checked = isChecked;
  cb.addEventListener('change', () => {
    if (cb.checked) checked.add(job.uid);
    else checked.delete(job.uid);
    card.classList.toggle('is-checked', cb.checked);
    updateBatchBar();
  });

  const card = h('div', {
    class: 'job-card fade-up' + (isChecked ? ' is-checked' : '') + (isStaleHr(job) ? ' is-stale' : '') + (job.viewedAt ? ' is-viewed' : '') + (reviewing.has(job.uid) ? ' is-reviewing' : ''),
  }, [
    reviewing.has(job.uid) ? reviewStrip(job) : null,
    h('div', { class: 'jc-head' }, [
      h('label', { class: 'jc-check', title: '勾选后可批量分析 / 导出' }, [cb]),
      h('div', { class: 'jc-main', title: '查看详情', onclick: () => openCurrent(job, 'info') }, [
        h('div', { class: 'jc-title-row' }, [
          h('div', { class: 'jc-title', text: job.title, title: job.title }),
          job.salaryText ? h('div', { class: 'jc-salary', text: job.salaryText }) : null,
        ]),
        h('div', { class: 'jc-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
        h('div', { class: 'jc-meta' }, [
          h('span', { class: `plat plat-${job.platform}`, text: job.platform === 'boss' ? 'BOSS' : '51job' }),
          job.viewedAt ? h('span', { class: 'jc-viewed', title: `看过 · ${fmtTime(job.viewedAt)}` }, [icon('eye', { size: 12 }), '看过']) : null,
          meta.length ? h('span', { class: 'jc-meta-text', text: meta.join(' · '), title: meta.join(' · ') }) : null,
        ]),
      ]),
      scoreBox(job),
    ]),
    m && m.summary ? h('div', { class: `jc-summary tone-${m.verdict}`, text: m.summary, title: m.summary }) : null,
    tags.length ? h('div', { class: 'jc-tags' }, tags) : null,
    h('div', { class: 'jc-actions' }, [
      h('button', { class: 'btn btn-sm' + (m ? '' : ' btn-tonal'), disabled: busy, onclick: () => analyze(job, !!m) }, [
        icon('spark'),
        busy ? '分析中…' : m ? '重新分析' : 'AI 分析',
      ]),
      h('button', { class: 'btn btn-sm', onclick: () => openCurrent(job, 'greeting') }, [icon('chat'), '打招呼']),
      h('div', { class: 'spacer' }),
      iconBtn('star', job.star ? '取消收藏' : '收藏', () => toggleStar(job), job.star ? 'starred' : ''),
      job.url ? iconBtn('external', '打开原岗位（看过后关掉标签页，这里会问要不要标不感兴趣）', () => openOriginal(job)) : null,
      iconBtn('eyeOff', '不感兴趣：折叠并移到「不感兴趣」，不像屏蔽那样移出岗位库，可随时恢复', () => setDismissedUi([job.uid], true)),
      iconBtn('more', '更多操作', (e) => openMenu(e.currentTarget, jobMenuItems(job))),
    ]),
  ]);
  return card;
}

// 不感兴趣的岗位：折叠成一行，点开仍可看详情；右侧撤销 / 恢复
function renderDismissedCard(job) {
  const justNow = dismissedHere.has(job.uid);
  // 只在「不感兴趣」筛选里给勾选框：用来批量恢复
  let cb = null;
  if (view.verdict === 'dismissed') {
    cb = h('input', { type: 'checkbox', 'aria-label': `勾选 ${job.title}` });
    cb.checked = checked.has(job.uid);
    cb.addEventListener('change', () => {
      if (cb.checked) checked.add(job.uid);
      else checked.delete(job.uid);
      updateBatchBar();
    });
  }
  return h('div', { class: 'job-card is-dismissed' + (justNow ? ' fade-up' : '') }, [
    cb ? h('label', { class: 'jc-check' }, [cb]) : null,
    h('div', { class: 'jc-main jc-dismissed-main', title: '查看详情', onclick: () => openCurrent(job, 'info') }, [
      icon('eyeOff', { size: 14, cls: 'jc-dismissed-ico' }),
      h('span', { class: 'jc-dismissed-title', text: job.title }),
      h('span', { class: 'jc-dismissed-sub', text: [job.company, job.salaryText].filter(Boolean).join(' · ') }),
    ]),
    h('button', { class: 'btn btn-xs', title: justNow ? '撤销：恢复到列表' : '移回岗位列表', onclick: () => setDismissedUi([job.uid], false) }, [
      icon('undo'),
      justNow ? '撤销' : '恢复',
    ]),
  ]);
}

// 刚关掉「原岗位」标签页时卡片顶部的提示：一键标不感兴趣 / 收藏，或关掉
function reviewStrip(job) {
  return h('div', { class: 'jc-review' }, [
    h('span', { class: 'jc-review-text', text: '刚看完这个岗位？' }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn btn-xs', onclick: () => setDismissedUi([job.uid], true) }, [icon('eyeOff'), '不感兴趣']),
    job.star ? null : h('button', { class: 'btn btn-xs', onclick: () => { reviewing.delete(job.uid); toggleStar(job); } }, [icon('star'), '收藏']),
    h('button', { class: 'notice-close', title: '保留，不再提示', 'aria-label': '关闭提示', onclick: () => { reviewing.delete(job.uid); render(); } }, [icon('close', { size: 12 })]),
  ]);
}

// HR 活跃标签：很活跃绿色、两周 / 本月橙色、数月 / 半年红色醒目
function activityChip(job) {
  const tier = hrActivityTier(job);
  if (tier == null) return null;
  const text = job.hrActiveText || '在线';
  const cls = tier <= 1 ? 'chip chip-green' : tier <= 3 ? 'chip chip-orange' : 'chip chip-red';
  const title = hrActiveTitle(job) + (tier === 4 ? '；HR 长期未活跃，岗位可能已停招，已排到最后' : '');
  return h('span', { class: cls, text: tier === 4 ? `⚠ HR ${text}` : `HR ${text}`, title });
}

// ============ 状态提示（列表上方） ============
// 列表上方的状态：补详情暂停 > 自动分析进度 / 出错 > 配置引导，各自一条，样式统一
function updateStatus() {
  const el = document.getElementById('sp-status');
  if (!el) return;
  const items = [];
  const st = autoStatus || {};
  const d = st.detail || {};

  if (d.halted && d.pending) items.push(pauseNotice(d));

  const autoOn = settings && settings.autoScore;
  if (autoOn && st.running && st.pending) {
    const extra = d.pending && !d.halted ? `，后台还在补 ${d.pending} 个详情` : '';
    items.push(notice({ tone: 'info', compact: true, ic: h('span', { class: 'spinner spinner-sm' }), title: `自动分析中 · 还剩 ${st.pending} 个${extra}` }));
  } else if (d.pending && !d.halted && d.running) {
    items.push(notice({ tone: 'info', compact: true, ic: h('span', { class: 'spinner spinner-sm' }), title: `后台补详情中 · 还剩 ${d.pending} 个（按人工节奏）` }));
  } else if (autoOn && st.lastError && Date.now() - (st.lastErrorAt || 0) < 30 * 60 * 1000 && st.lastErrorAt !== dismissedErrorAt) {
    items.push(notice({
      tone: 'error',
      ic: 'alert',
      title: '自动分析出错',
      desc: st.lastError,
      actions: [{ label: '检查 AI 设置', onClick: () => send(MSG.OPEN_OPTIONS, { section: 'ai' }) }],
      onClose: () => { dismissedErrorAt = st.lastErrorAt; updateStatus(); },
    }));
  }

  if (settings) {
    const ps = scoreProfile(profile);
    if (!providers.length) {
      items.push(notice({ tone: 'tip', ic: 'plug', title: '还没有配置 AI 接口', desc: '配置后才能分析匹配度、生成招呼语和简历建议', actions: [{ label: '去配置', primary: true, onClick: () => send(MSG.OPEN_OPTIONS, { section: 'ai' }) }] }));
    } else if (ps.score < 40) {
      items.push(notice({ tone: 'tip', ic: 'user', title: `个人画像完整度 ${ps.score}%`, desc: '上传简历或补全技能、期望后，AI 匹配会更准', actions: [{ label: '去完善', onClick: () => send(MSG.OPEN_OPTIONS, { section: 'profile' }) }] }));
    }
  }

  el.replaceChildren(...items);
}

const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const BOSS_JOBS_URL = 'https://www.zhipin.com/web/geek/jobs';

function resumeInText(resumeAt) {
  const min = Math.ceil(((resumeAt || 0) - Date.now()) / 60000);
  if (min <= 0) return '即将自动继续';
  if (min < 60) return `约 ${min} 分钟后自动继续`;
  const at = new Date(resumeAt);
  const sameDay = at.toDateString() === new Date().toDateString();
  return `${sameDay ? '' : '明天 '}${at.toTimeString().slice(0, 5)} 自动继续`;
}

// 补详情挂起：按原因给出对应操作（登录 / 去验证 / 立即继续）
function pauseNotice(d) {
  const reason = d.halted;
  const kind = /未登录/.test(reason) ? 'login' : /验证/.test(reason) ? 'verify' : /上限|活跃时段/.test(reason) ? 'quota' : 'other';
  const actions =
    kind === 'login'
      ? [
          { label: '去登录', primary: true, onClick: () => chrome.tabs.create({ url: BOSS_LOGIN_URL }) },
          { label: '已登录，继续', onClick: resumeDetailsUi },
        ]
      : kind === 'verify'
      ? [
          { label: '去完成验证', primary: true, onClick: () => chrome.tabs.create({ url: BOSS_JOBS_URL }) },
          { label: '已验证，继续', onClick: resumeDetailsUi },
        ]
      : [{ label: '立即继续', primary: true, onClick: resumeDetailsUi }];
  const tail =
    kind === 'login'
      ? '登录完成后会自动继续'
      : kind === 'quota'
      ? `${resumeInText(d.resumeAt)}；点「立即继续」本轮补完前不再受额度和时段限制`
      : resumeInText(d.resumeAt);
  return notice({ tone: 'warn', ic: 'pause', title: `后台补详情已暂停 · ${d.pending} 个待补`, desc: `${reason}。${tail}`, actions });
}

async function resumeDetailsUi() {
  try {
    await send(MSG.WORKER_HALT_CLEAR);
    if (autoStatus && autoStatus.detail) autoStatus = { ...autoStatus, detail: { ...autoStatus.detail, halted: '' } };
    updateStatus();
    toast('已继续补全详情');
  } catch (e) {
    toast(e.message, true);
  }
}

function contactedChip(job) {
  return job.contacted === 'job'
    ? h('span', { class: 'chip chip-orange', text: '已沟通', title: '你已和该岗位 HR 沟通过，批量/自动匹配会跳过' })
    : h('span', { class: 'chip chip-orange', text: '已沟通该公司', title: '你沟通过这家公司的其他岗位' });
}

async function toggleStar(job) {
  try {
    jobs = await send(MSG.JOB_STAR_TOGGLE, { uid: job.uid });
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteJobUi(job) {
  try {
    jobs = await send(MSG.JOB_DELETE, { uid: job.uid });
    checked.delete(job.uid);
    if (selectedUid === job.uid) selectedUid = null;
    render();
    toast('已从岗位库删除');
  } catch (e) {
    toast(e.message, true);
  }
}

// 手动标记已沟通（比如在 App 上聊过、插件没同步到）
async function markContactedUi(uids) {
  if (!uids.length) return;
  try {
    const r = await send(MSG.CONTACTS_MARK, { uids });
    jobs = r.jobs;
    uids.forEach((u) => checked.delete(u));
    render();
    const hidden = settings.skipContacted ? '，已从列表隐藏' : '';
    toast(`已标记 ${uids.length} 个岗位为已沟通${hidden}（可在设置 → 已沟通与屏蔽中撤销）`);
  } catch (e) {
    toast(e.message, true);
  }
}

// 屏蔽：从岗位库移除并加入屏蔽名单，后续不再收录
async function blockJobsUi(uids) {
  if (!uids.length) return;
  try {
    const r = await send(MSG.JOB_BLOCK, { uids });
    jobs = r.jobs;
    uids.forEach((u) => checked.delete(u));
    if (selectedUid && uids.includes(selectedUid)) selectedUid = null;
    render();
    toast(`已屏蔽 ${uids.length} 个岗位，之后不再收录（可在设置中解除）`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function openOriginal(job) {
  // 多次点击以第一次为准，记的是卡片原本的位置
  if (!sortFrozen.has(job.uid)) {
    sortFrozen.set(job.uid, { lastSeenAt: job.lastSeenAt, savedAt: job.savedAt, hrActiveText: job.hrActiveText, hrOnline: job.hrOnline });
  }
  reviewing.delete(job.uid);
  const tab = await chrome.tabs.create({ url: job.url });
  if (tab && tab.id != null) openedTabs.set(tab.id, job.uid);
  if (!job.viewedAt) markJobsUi([job.uid], { viewed: true });
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    const uid = openedTabs.get(tabId);
    if (!uid) return;
    openedTabs.delete(tabId);
    const job = jobs.find((j) => j.uid === uid);
    if (!job || job.dismissedAt || job.contacted === 'job') return;
    reviewing.add(uid);
    setTimeout(() => {
      if (reviewing.delete(uid)) render();
    }, REVIEW_TTL);
    render();
  });
} catch {}

// 看过 / 不感兴趣：{ viewed?, dismissed? }，true 标记、false 清除
async function markJobsUi(uids, flags) {
  try {
    jobs = await send(MSG.JOB_MARK, { uids, ...flags });
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

async function setDismissedUi(uids, dismissed) {
  if (!uids.length) return;
  uids.forEach((u) => {
    reviewing.delete(u);
    checked.delete(u);
    if (dismissed) dismissedHere.add(u);
    else dismissedHere.delete(u);
  });
  await markJobsUi(uids, { dismissed });
  if (uids.length > 1) toast(dismissed ? `已将 ${uids.length} 个岗位标为不感兴趣，可在「不感兴趣」里恢复` : `已恢复 ${uids.length} 个岗位`);
}

function openCurrent(job, sub) {
  selectedUid = job.uid;
  view.tab = 'current';
  view.sub = sub || 'info';
  render();
}

// ============ 当前岗位模块 ============
function renderCurrent() {
  const job = currentJob();
  const body = h('div', { class: 'cur-body' });

  if (!job) {
    const onSite = activeCtx && activeCtx.platform;
    body.appendChild(
      emptyState(
        'compass',
        onSite ? '这个页面的岗位还没收录' : '没有识别到岗位页面',
        onSite ? '在网站上打开岗位详情后点右上角刷新；也可以从岗位库里挑一个' : '在 BOSS直聘 / 51job 打开岗位详情会自动跟随；也可以从岗位库里挑一个',
        { label: '去岗位库选择', onClick: () => { view.tab = 'library'; render(); } },
      ),
    );
    return body;
  }

  // 从岗位库点进来的，和网页上正开着的不是同一个：提示一下，可一键切回跟随网页
  const onPage = pageJob();
  if (selectedUid && onPage && onPage.uid !== job.uid) {
    body.appendChild(notice({
      tone: 'tip',
      compact: true,
      ic: 'pin',
      title: '正在查看从岗位库选中的岗位',
      actions: [{ label: '切到网页上的岗位', onClick: () => { selectedUid = null; render(); } }],
    }));
  }

  // 岗位头部：标题/薪资/公司 + 匹配分 + 常用操作
  body.appendChild(
    h('div', { class: 'cur-head' }, [
      h('div', { class: 'cur-head-top' }, [
        h('div', { class: 'cur-head-main' }, [
          h('div', { class: 'cur-title', text: job.title }),
          job.salaryText ? h('div', { class: 'cur-salary', text: job.salaryText }) : null,
          h('div', { class: 'cur-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
          job.contacted || activityChip(job) ? h('div', { class: 'jc-tags' }, [activityChip(job), job.contacted ? contactedChip(job) : null]) : null,
        ]),
        scoreBox(job),
      ]),
      h('div', { class: 'cur-actions' }, [
        job.url ? h('button', { class: 'btn btn-xs', onclick: () => openOriginal(job) }, [icon('external'), '原岗位']) : null,
        h('button', { class: 'btn btn-xs' + (job.star ? ' starred' : ''), onclick: () => toggleStar(job) }, [icon('star'), job.star ? '已收藏' : '收藏']),
        job.dismissedAt
          ? h('button', { class: 'btn btn-xs is-on', title: '移回岗位列表', onclick: () => setDismissedUi([job.uid], false) }, [icon('undo'), '已标不感兴趣 · 恢复'])
          : h('button', { class: 'btn btn-xs', title: '折叠并移到「不感兴趣」，可随时恢复', onclick: () => setDismissedUi([job.uid], true) }, [icon('eyeOff'), '不感兴趣']),
        h('div', { class: 'spacer' }),
        iconBtn('more', '更多操作', (e) => openMenu(e.currentTarget, jobMenuItems(job))),
      ]),
    ]),
  );

  body.appendChild(
    h('div', { class: 'segmented subtabs', role: 'tablist' }, [
      subBtn('info', '岗位信息'),
      subBtn('company', '公司画像'),
      subBtn('resume', '简历建议'),
      subBtn('greeting', '打招呼'),
    ]),
  );

  const panel = h('div', { class: 'cur-panel fade-up' });
  if (view.sub === 'info') renderJobInfo(panel, job);
  else if (view.sub === 'company') renderCompany(panel, job);
  else if (view.sub === 'resume') renderResumeAdvice(panel, job);
  else renderGreeting(panel, job);
  body.appendChild(panel);

  return body;
}

function subBtn(key, label) {
  const active = view.sub === key;
  return h('button', {
    class: active ? 'active' : '',
    role: 'tab',
    'aria-selected': active ? 'true' : 'false',
    text: label,
    onclick: () => { view.sub = key; render(); },
  });
}

function secTitle(text, tone) {
  return h('div', { class: 'cur-sec-title' + (tone ? ` sec-${tone}` : ''), text });
}

function needAiNotice() {
  return notice({ tone: 'tip', ic: 'plug', title: '还没有配置 AI 接口', desc: '配置后才能使用这个功能', actions: [{ label: '去配置', primary: true, onClick: () => send(MSG.OPEN_OPTIONS, { section: 'ai' }) }] });
}

function renderJobInfo(panel, job) {
  const facts = [];
  const factRow = (k, v) => (v ? facts.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v, title: v })])) : null);
  factRow('薪资', job.salaryText);
  factRow('城市', job.city + (job.district ? ' · ' + job.district : ''));
  // 经验以详情为准；JD 正文写明的年限与标签不同时一并显示
  factRow('经验', [job.experience, job.experienceJd && job.experienceJd !== job.experience ? `JD 写明 ${job.experienceJd}` : ''].filter(Boolean).join(' · '));
  factRow('学历', job.degree);
  factRow('平台', job.platform === 'boss' ? 'BOSS 直聘' : '前程无忧 51job');
  factRow('地址', job.address);
  if (facts.length) panel.appendChild(h('div', { class: 'cur-facts' }, facts));

  // 匹配分析放在前面：这是打开详情最想看的
  panel.appendChild(secTitle('匹配分析'));
  if (job.match) {
    panel.appendChild(renderAnalysis(job.match));
  } else {
    const busy = scoring.has(job.uid);
    panel.appendChild(
      providers.length
        ? notice({
            tone: 'tip',
            ic: 'spark',
            title: busy ? 'AI 正在分析…' : '还没有分析这个岗位',
            desc: '对照你的画像给出匹配分、差距和三档招呼语',
            actions: busy ? [] : [{ label: 'AI 分析', primary: true, onClick: () => analyze(job, false) }],
          })
        : needAiNotice(),
    );
  }

  const skills = job.skills && job.skills.length ? job.skills : job.tags;
  if (skills && skills.length) {
    panel.appendChild(secTitle('技能 / 标签'));
    panel.appendChild(h('div', { class: 'jc-tags' }, skills.slice(0, 20).map((t) => h('span', { class: 'chip', text: t }))));
  }
  if (job.welfare && job.welfare.length) {
    panel.appendChild(secTitle('福利'));
    panel.appendChild(h('div', { class: 'jc-tags' }, job.welfare.slice(0, 20).map((t) => h('span', { class: 'chip chip-green', text: t }))));
  }
  panel.appendChild(secTitle('岗位描述'));
  panel.appendChild(
    job.description
      ? h('div', { class: 'cur-jd', text: job.description })
      : h('div', { class: 'cur-hint', text: job.platform === 'boss' ? '还没读到岗位描述：后台会按人工节奏补全，也可以点「原岗位」打开看看' : '暂无岗位描述' }),
  );
}

function renderAnalysis(m) {
  const box = h('div', { class: 'jc-analysis' }, [
    m.summary ? h('div', { class: `summary tone-${m.verdict}`, text: m.summary }) : null,
    m.activityPenalty
      ? h('div', { class: 'cur-note', text: `因 HR 活跃度已扣 ${m.activityPenalty} 分（扣分前 ${m.rawScore}）` })
      : null,
  ]);
  // 硬门槛提示（存在明确不匹配的强制要求时醒目提示，但不隐藏分数——由你自己判断是否投递）
  if (m.eligible === false && m.blockers && m.blockers.length) {
    const gate = h('div', { class: 'gate-warn' }, [h('div', { class: 'gate-title' }, [icon('alert', { size: 14 }), '存在硬性门槛'])]);
    gate.appendChild(h('ul', {}, m.blockers.map((b) => h('li', { text: b }))));
    box.appendChild(gate);
  }
  // 四维分项分
  if (m.dims) {
    const dimBox = h('div', { class: 'dim-box' });
    ['skill', 'experience', 'requirement', 'location'].forEach((k) => {
      const v = m.dims[k];
      if (v == null) return;
      dimBox.appendChild(
        h('div', { class: 'dim-row' }, [
          h('span', { class: 'dim-k', text: DIM_LABELS[k] }),
          h('span', { class: 'dim-bar' }, [h('span', { class: 'dim-fill' + (v >= 75 ? ' hi' : v < 50 ? ' lo' : ''), style: `width:${v}%` })]),
          h('span', { class: 'dim-v', text: String(v) }),
        ]),
      );
    });
    if (dimBox.children.length) box.appendChild(dimBox);
  }
  if (m.reasons && m.reasons.length) {
    box.appendChild(h('h5', { class: 'sec-ok', text: '契合点' }));
    box.appendChild(h('ul', {}, m.reasons.map((r) => h('li', { text: r }))));
  }
  if (m.gaps && m.gaps.length) {
    box.appendChild(h('h5', { class: 'sec-gap', text: '差距 / 需补齐' }));
    box.appendChild(h('ul', {}, m.gaps.map((r) => h('li', { text: r }))));
  }
  if (m.risks && m.risks.length) {
    box.appendChild(h('h5', { class: 'sec-risk', text: '风险提示' }));
    box.appendChild(h('ul', {}, m.risks.map((r) => h('li', { class: 'risk-line', text: r }))));
  }
  return box;
}

function renderCompany(panel, job) {
  const rows = [];
  const row = (k, v) => (v ? rows.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v, title: v })])) : null);
  row('公司', job.company);
  row('行业', job.companyIndustry);
  row('规模', job.companyScale);
  row('性质', job.companyType);
  row('阶段', job.companyStage);
  row('HR', [job.hrName, job.hrTitle].filter(Boolean).join(' · '));
  row('HR 活跃', job.hrActiveText ? `${job.hrActiveText}（${fmtTime(job.hrActiveAt)} 观测）` : job.hrOnline ? '在线' : '');

  if (rows.length) {
    panel.appendChild(h('div', { class: 'cur-facts' }, rows));
  } else {
    panel.appendChild(h('div', { class: 'cur-hint', text: '暂无公司信息（该平台列表接口未返回，或浏览详情后可补全）' }));
  }
  panel.appendChild(h('div', { class: 'cur-note', text: '公司画像基于岗位接口返回的公开信息整理，仅供参考。' }));
}

function renderGreeting(panel, job) {
  if (!providers.length) {
    panel.appendChild(needAiNotice());
    return;
  }
  if (!job.match) {
    const busy = scoring.has(job.uid);
    panel.appendChild(notice({
      tone: 'tip',
      ic: 'spark',
      title: busy ? 'AI 正在分析…' : '先做一次匹配分析',
      desc: '分析完成后会按匹配要点生成精简 / 标准 / 详细三档招呼语',
      actions: busy ? [] : [{ label: '分析并生成招呼语', primary: true, onClick: () => analyze(job, false) }],
    }));
    return;
  }
  // 招呼语按需生成：自动 / 批量分析不再顺带生成（省输出 token），第一次打开这里时生成一次
  if (!hasGreetings(job.match)) {
    const busy = greeting.has(job.uid);
    const failed = greetFailed.get(job.uid);
    if (!busy && !failed && !greetTried.has(job.uid)) {
      greetTried.add(job.uid);
      setTimeout(() => generateGreetingUi(job), 0);
    }
    panel.appendChild(
      failed
        ? notice({ tone: 'error', ic: 'alert', title: '招呼语生成失败', desc: failed, actions: [{ label: '重试', primary: true, onClick: () => generateGreetingUi(job) }] })
        : h('div', { class: 'cur-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'AI 正在按匹配要点写招呼语…' })]),
    );
    return;
  }

  // 档位切换
  const levelSeg = h(
    'div',
    { class: 'segmented greet-levels' },
    GREETING_LEVELS.map((lv) =>
      h('button', {
        class: view.greetLevel === lv.key ? 'active' : '',
        text: lv.label,
        onclick: () => {
          view.greetLevel = lv.key;
          // 切换档位时用该档 AI 文案覆盖编辑区（并存为草稿）
          const text = greetingsOf(job.match)[lv.key] || '';
          greetingCache.set(job.uid, text);
          persistGreeting(job.uid, text);
          render();
        },
      }),
    ),
  );
  panel.appendChild(h('div', { class: 'greet-head' }, [secTitle('招呼语'), h('div', { class: 'spacer' }), levelSeg]));

  const value = greetingValueFor(job);
  const ta = h('textarea', { class: 'greet-editor', rows: 6, placeholder: '编辑要发送给 HR 的招呼语…' });
  ta.value = value;
  ta.dataset.uid = job.uid;
  greetingTextarea = ta;
  const counter = h('span', { class: 'greet-count', text: `${value.length} 字` });
  ta.addEventListener('input', () => {
    greetingCache.set(job.uid, ta.value);
    counter.textContent = `${ta.value.length} 字`;
    persistGreetingDebounced(job.uid, ta.value);
  });
  panel.appendChild(ta);

  const onChat = activeCtx && activeCtx.isChat;
  panel.appendChild(
    h('div', { class: 'greet-meta' }, [
      h('span', {
        class: 'greet-hint' + (onChat ? ' ok' : ''),
        text: onChat ? '已在聊天页，可直接填入' : '修改会自动保存为草稿',
      }),
      h('div', { class: 'spacer' }),
      counter,
    ]),
  );

  panel.appendChild(
    h('div', { class: 'greet-tools' }, [
      h('button', { class: 'btn btn-sm', disabled: greeting.has(job.uid), onclick: () => regenerateGreeting(job) }, [
        icon('refresh'),
        greeting.has(job.uid) ? '生成中…' : '重新生成',
      ]),
      h('button', { class: 'btn btn-sm', onclick: () => copyText(greetingValueFor(job)) }, [icon('copy'), '复制']),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm btn-primary',
        title: '新建标签页打开该岗位并进入与 HR 的沟通（当前标签保留），招呼语同时复制到剪贴板',
        onclick: () => sendGreeting(job),
      }, [icon('send'), '打开沟通并复制']),
    ]),
  );
  panel.appendChild(h('div', { class: 'cur-note', text: '会在新标签页进入与 HR 的聊天，招呼语已复制，在聊天框 Ctrl+V 粘贴即可。' }));
}

// —— 简历建议子页：基于画像 + 该岗位 JD，给出定制简历的建议（只建议、不落库） ——
function renderResumeAdvice(panel, job) {
  if (!providers.length) {
    panel.appendChild(needAiNotice());
    return;
  }
  const hasProfile = profile && scoreProfile(profile).score > 0;
  if (!hasProfile) {
    panel.appendChild(notice({
      tone: 'tip',
      ic: 'user',
      title: '先完善个人画像',
      desc: '简历建议基于你的画像生成：上传简历或手动填写都可以',
      actions: [{ label: '去完善', primary: true, onClick: () => send(MSG.OPEN_OPTIONS, { section: 'profile' }) }],
    }));
    return;
  }

  const busy = tailoring.has(job.uid);
  const advice = tailorCache.get(job.uid);

  panel.appendChild(
    h('div', { class: 'greet-head' }, [
      secTitle('简历定制建议'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm' + (advice ? '' : ' btn-primary'), disabled: busy, onclick: () => tailorAdvice(job) }, [
        icon(advice ? 'refresh' : 'spark'),
        busy ? '生成中…' : advice ? '重新生成' : '生成建议',
      ]),
    ]),
  );
  panel.appendChild(h('div', { class: 'cur-note', style: 'margin-top:0', text: '针对该岗位 JD 给出调整建议，不改你的原简历；只在本次打开侧边栏期间保留。' }));

  if (busy && !advice) {
    panel.appendChild(h('div', { class: 'cur-loading' }, [h('span', { class: 'spinner' }), h('span', { text: 'AI 正在分析…' })]));
    return;
  }
  if (!advice) return;

  const sec = (title, tone, node) => {
    panel.appendChild(secTitle(title, tone));
    panel.appendChild(node);
  };
  const chips = (list, cls) => h('div', { class: 'jc-tags' }, list.map((t) => h('span', { class: cls, text: t })));
  const bullets = (list) => h('ul', { class: 'advice-list' }, list.map((t) => h('li', { text: t })));

  if (advice.matchedSkills.length) sec('可突出的匹配点', 'ok', chips(advice.matchedSkills, 'chip chip-green'));
  if (advice.keywordsToAlign.length) sec('建议对齐的岗位关键词', 'info', chips(advice.keywordsToAlign, 'chip chip-accent'));
  if (advice.missingSkills.length) sec('暂未体现（如实指出，勿编造）', 'gap', chips(advice.missingSkills, 'chip chip-orange'));

  if (advice.summaryDraft) {
    panel.appendChild(
      h('div', { class: 'greet-head' }, [
        secTitle('自我评价草稿'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-xs', onclick: () => copyText(advice.summaryDraft) }, [icon('copy'), '复制']),
      ]),
    );
    panel.appendChild(h('div', { class: 'cur-jd', text: advice.summaryDraft }));
  }
  if (advice.bulletSuggestions.length) sec('经历改写建议', 'info', bullets(advice.bulletSuggestions));
  if (advice.tips.length) sec('投递提醒', 'gap', bullets(advice.tips));
  if (advice.note) panel.appendChild(h('div', { class: 'cur-note', text: advice.note }));
}

async function tailorAdvice(job) {
  if (tailoring.has(job.uid)) return;
  if (!providers.length) {
    toast('尚未配置 AI 接口，请先到设置页添加', true);
    return;
  }
  tailoring.add(job.uid);
  render();
  try {
    const advice = await send(MSG.AI_TAILOR_RESUME, { uid: job.uid, job });
    tailorCache.set(job.uid, advice);
    toast('简历建议已生成');
  } catch (e) {
    toast(`生成失败：${e.message}`, true);
  } finally {
    tailoring.delete(job.uid);
    render();
  }
}

// ============ 底栏：批量进度 / 已选操作 / 默认操作 ============
// ============ 投递清单 ============
function applyCountText() {
  if (!applyStatus) return '投递清单';
  const c = (applyStatus.batch && applyStatus.batch.counts) || {};
  const date = (applyStatus.batch && applyStatus.batch.date) || '';
  const closed = c.rejected ? ` · 已关闭 ${c.rejected}` : '';
  return `${date ? date + ' · ' : ''}待确认 ${c.pending || 0} · 已沟通 ${c.applied || 0}${closed}`;
}

function renderApplyStatusBar() {
  const box = h('div', { class: 'sp-status', id: 'sp-apply-status' });
  const st = applyStatus;
  if (!st) {
    box.appendChild(h('div', { class: 'muted', text: '正在读取投递清单…' }));
    return box;
  }
  const s = st.search || {};
  if (s.running) {
    box.appendChild(notice({ tone: 'tip', ic: 'refresh', compact: true, title: '正在自动搜索 BOSS…', desc: '完成后自动补详情、AI 匹配，新岗位会补进今日清单' }));
  } else if (s.lastSearchStatus === 'error') {
    box.appendChild(notice({ tone: 'warn', ic: 'alert', compact: true, title: '上次自动搜索失败', desc: s.lastSearchError || '未知错误' }));
  } else if (s.lastSearchStatus === 'empty') {
    box.appendChild(notice({ tone: 'info', ic: 'info', compact: true, title: '上次搜索没有新增岗位', desc: s.lastSearchError || '' }));
  } else if (s.lastSearchStatus === 'capped') {
    box.appendChild(notice({ tone: 'info', ic: 'info', compact: true, title: '今日自动收录已达上限', desc: s.lastSearchError || '' }));
  }
  const run = st.run || {};
  if (run.state === 'error' && run.error) {
    box.appendChild(notice({ tone: 'warn', ic: 'alert', compact: true, title: '上次投递中断', desc: run.error }));
  }
  return box;
}

function sortedApplyItems(items) {
  const rank = { pending: 0, failed: 1, applied: 2, skipped: 3, rejected: 4 };
  return items.slice().sort((a, b) => {
    const ra = rank[a.status] == null ? 9 : rank[a.status];
    const rb = rank[b.status] == null ? 9 : rank[b.status];
    return ra !== rb ? ra - rb : (Number(b.score) || 0) - (Number(a.score) || 0);
  });
}

function fillApplyList(listEl) {
  listEl.innerHTML = '';
  const all = sortedApplyItems((applyStatus && applyStatus.batch && applyStatus.batch.items) || []);
  // 已关闭的岗位从清单里移除，只留在统计里；避免关闭后还占着列表
  const items = all.filter((it) => it.status !== 'rejected');
  if (!items.length) {
    const cfg = (applyStatus && applyStatus.config) || {};
    const counts = (applyStatus && applyStatus.batch && applyStatus.batch.counts) || {};
    if (all.length) {
      listEl.appendChild(
        emptyState(
          'check',
          '今天的投递清单已处理完',
          `已关闭 ${counts.rejected || 0} 个岗位；明天会重新生成清单，也可以在设置里调高每日清单上限。`,
          { label: '刷新清单', onClick: refreshApplyUi },
        ),
      );
      return;
    }
    const hasKeywords = Array.isArray(cfg.keywords) && cfg.keywords.length > 0;
    listEl.appendChild(
      emptyState(
        'send',
        '今天还没有待投递岗位',
        hasKeywords
          ? `每天 ${cfg.dailyTime || '09:00'} 自动搜索并生成清单；也可以现在手动跑一次。匹配分达到 ${cfg.threshold ?? 70} 的未沟通岗位会出现在这里。`
          : '先到设置 → 自动投递配置岗位关键词、城市和筛选条件。',
        hasKeywords
          ? { label: '立即搜索 BOSS', onClick: runDailySearchUi }
          : { label: '去设置自动投递', onClick: () => send(MSG.OPEN_OPTIONS, { section: 'autoapply' }) },
      ),
    );
    return;
  }
  for (const it of items) listEl.appendChild(renderApplyCard(it));
}

function renderApplyCard(it) {
  const pending = it.status === 'pending';
  const running = !!(applyStatus && applyStatus.run && applyStatus.run.state === 'running');
  const canEdit = pending && !running;
  const on = applyChecked.has(it.uid);
  const cb = h('input', { type: 'checkbox' });
  cb.checked = on;
  cb.disabled = !canEdit;
  const card = h('div', { class: 'job-card apply-card' + (on ? ' is-checked' : '') + (pending ? '' : ' is-done') });
  cb.addEventListener('change', () => {
    if (cb.checked) applyChecked.add(it.uid);
    else applyChecked.delete(it.uid);
    card.classList.toggle('is-checked', cb.checked);
    fillApplyBottom(document.getElementById('sp-apply-bottom'));
  });
  const statusChip = h('span', { class: 'apply-status status-' + it.status, text: APPLY_STATUS_LABELS[it.status] || it.status });
  const meta = [it.city, it.district, it.experience].filter(Boolean).join(' · ');
  const children = [
    h('div', { class: 'jc-head' }, [
      pending ? h('label', { class: 'jc-check' }, [cb]) : h('span', { class: 'jc-check' }),
      h('div', { class: 'jc-main', onclick: () => openOriginal(it) }, [
        h('div', { class: 'jc-title-row' }, [
          h('div', { class: 'jc-title', text: it.title || '（未命名岗位）' }),
          h('div', { class: 'jc-salary', text: it.salaryText || '面议' }),
        ]),
        h('div', { class: 'jc-company', text: it.company || '' }),
        meta ? h('div', { class: 'jc-meta' }, [h('span', { class: 'jc-meta-text', text: meta })]) : null,
      ]),
      h('div', { class: 'apply-side' }, [
        h('div', { class: 'apply-score', text: String(it.score || 0) }),
        statusChip,
        (it.status === 'pending' || it.status === 'failed') && !running
          ? h('button', {
              class: 'linklike muted apply-close',
              text: '不想要',
              title: '不想要：从清单关闭，并从以后推荐中排除（可在岗位库恢复）',
              onclick: (e) => { e.stopPropagation(); rejectApplyItem(it); },
            })
          : null,
      ]),
    ]),
    it.summary ? h('div', { class: 'jc-summary tone-' + (it.verdict || 'fair'), text: it.summary }) : null,
    h('div', { class: 'jc-tags' }, [
      it.hrActiveText ? activityChip(it) : null,
      it.companyContacted ? h('span', { class: 'chip chip-orange', text: '同公司其他岗位' }) : null,
      it.hasGreeting ? h('span', { class: 'chip', text: '有招呼语草稿' }) : null,
    ].filter(Boolean)),
    it.note ? h('div', { class: 'apply-note', text: it.note }) : null,
    it.status === 'failed'
      ? h('div', { class: 'apply-card-actions' }, [
          h('button', { class: 'linklike', text: '重试', onclick: (e) => { e.stopPropagation(); retryApplyItem(it); } }),
        ])
      : null,
  ].filter(Boolean);
  card.append(...children);
  return card;
}

function renderApplyBottom() {
  const bar = h('div', { class: 'sp-bottom', id: 'sp-apply-bottom' });
  fillApplyBottom(bar);
  return bar;
}

function fillApplyBottom(bar) {
  if (!bar) return;
  bar.innerHTML = '';
  bar.className = 'sp-bottom';
  const st = applyStatus;
  const run = st && st.run;
  if (run && run.state === 'running') {
    bar.classList.add('is-batch');
    const done = (run.done || 0) + (run.failed || 0);
    const pct = run.total ? Math.round((done / run.total) * 100) : 0;
    bar.appendChild(
      h('div', { class: 'batch-panel' }, [
        h('div', { class: 'batch-head' }, [
          icon('send', { cls: 'batch-ico' }),
          h('span', { class: 'batch-title', text: `正在投递 ${done} / ${run.total}` }),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn btn-xs btn-danger', text: '停止', onclick: stopApplyUi }),
        ]),
        h('div', { class: 'progress' }, [h('span', { class: 'progress-fill', style: `width:${pct}%` })]),
        run.current ? h('div', { class: 'batch-sub', text: '正在打开岗位页并点击「立即沟通」…' }) : null,
      ]),
    );
    return;
  }
  const items = (st && st.batch && st.batch.items) || [];
  const pending = items.filter((it) => it.status === 'pending');
  const selected = pending.filter((it) => applyChecked.has(it.uid));
  if (selected.length) {
    bar.classList.add('has-sel');
    bar.appendChild(
      h('div', { class: 'sel-row' }, [
        h('span', { class: 'sel-count', text: `已选 ${selected.length} 个` }),
        selected.length === pending.length
          ? null
          : h('button', { class: 'linklike', text: `全选待确认（${pending.length}）`, onclick: selectAllApply }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'linklike muted', text: '取消选择', onclick: () => { applyChecked.clear(); render(); } }),
      ]),
    );
    bar.appendChild(
      h('div', { class: 'sel-actions' }, [
        h('button', { class: 'btn btn-sm btn-primary grow', onclick: confirmApply }, [icon('send'), `确认投递 ${selected.length} 个`]),
        h('button', { class: 'btn btn-sm', text: '关闭所选', onclick: closeApplySelected }),
        iconBtn('more', '更多', (e) =>
          openMenu(e.currentTarget, [
            { icon: 'refresh', label: '刷新清单', hint: '把新匹配的岗位补进来', onClick: refreshApplyUi },
            { icon: 'gear', label: '自动投递设置', hint: '搜索条件、时间和每日上限', onClick: () => send(MSG.OPEN_OPTIONS, { section: 'autoapply' }) },
          ]),
        ),
      ]),
    );
    return;
  }
  bar.appendChild(
    h('button', { class: 'btn btn-sm btn-ghost', disabled: !pending.length, onclick: selectAllApply }, [
      icon('check'),
      `全选待确认（${pending.length}）`,
    ]),
  );
  bar.appendChild(h('div', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'btn btn-sm', onclick: refreshApplyUi }, [icon('refresh'), '刷新清单']));
}

async function refreshApplyUi() {
  try {
    await send(MSG.APPLY_REFRESH);
    await refreshApplyStatus();
    render();
    toast('清单已刷新');
  } catch (e) {
    toast(e.message, true);
  }
}

async function runDailySearchUi() {
  try {
    const r = await send(MSG.AUTO_APPLY_RUN_NOW);
    toast(r && r.started ? '已开始自动搜索，完成后清单会自动更新' : '搜索已经在进行中');
    await refreshApplyStatus();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function selectAllApply() {
  const items = (applyStatus && applyStatus.batch && applyStatus.batch.items) || [];
  for (const it of items) if (it.status === 'pending') applyChecked.add(it.uid);
  render();
}

async function confirmApply() {
  const items = (applyStatus && applyStatus.batch && applyStatus.batch.items) || [];
  const uids = items.filter((it) => it.status === 'pending' && applyChecked.has(it.uid)).map((it) => it.uid);
  if (!uids.length) return;
  if (!confirm(`确认向选中的 ${uids.length} 个岗位发起沟通？\n\n会依次打开岗位页并点击「立即沟通」，不会自动发送聊天消息。`)) return;
  try {
    await send(MSG.APPLY_START, { uids });
    applyChecked.clear();
    await refreshApplyStatus();
    render();
    toast('开始投递；请保持 Chrome 运行，可随时点「停止」');
  } catch (e) {
    toast(e.message, true);
  }
}

async function closeApplySelected() {
  const uids = [...applyChecked].filter(Boolean);
  if (!uids.length) return;
  try {
    await send(MSG.APPLY_ITEM_MARK, { uids, status: 'rejected' });
    applyChecked.clear();
    await refreshApplyStatus();
    render();
    toast(`已关闭 ${uids.length} 个岗位，以后不再推荐`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function rejectApplyItem(it) {
  try {
    await send(MSG.APPLY_ITEM_MARK, { uids: [it.uid], status: 'rejected' });
    applyChecked.delete(it.uid);
    await refreshApplyStatus();
    render();
    toast(`已关闭「${it.title || '该岗位'}」，以后不再推荐`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function retryApplyItem(it) {
  try {
    await send(MSG.APPLY_ITEM_MARK, { uids: [it.uid], status: 'pending' });
    applyChecked.add(it.uid);
    await refreshApplyStatus();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

async function stopApplyUi() {
  try {
    await send(MSG.APPLY_STOP);
    toast('已请求停止，当前岗位完成后结束');
    await refreshApplyStatus();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderBottom(list) {
  const bar = h('div', { class: 'sp-bottom', id: 'sp-bottom-bar' });
  fillBottom(bar, list);
  return bar;
}

// 就地刷新底栏（勾选变化时不整页重渲，避免丢失滚动位置）
function updateBatchBar() {
  const bar = document.getElementById('sp-bottom-bar');
  if (bar) fillBottom(bar, visibleJobs());
}

function fillBottom(bar, list) {
  bar.innerHTML = '';
  bar.className = 'sp-bottom';
  const n = checked.size;
  if (view.verdict !== 'dismissed') list = list.filter((j) => !j.dismissedAt);
  const total = list.length;

  // 批量进行中：进度条常驻底栏（原来是每 2.5 秒弹一次 toast）
  if (batchBusy && batchState) {
    bar.classList.add('is-batch');
    bar.appendChild(renderBatchProgress(batchState));
    return;
  }

  if (n > 0) {
    const allSelected = total > 0 && list.every((j) => checked.has(j.uid));
    bar.classList.add('has-sel');
    bar.appendChild(
      h('div', { class: 'sel-row' }, [
        h('span', { class: 'sel-count', text: `已选 ${n} 个` }),
        allSelected
          ? null
          : h('button', { class: 'linklike', text: `全选可见（${total}）`, onclick: () => { list.forEach((j) => checked.add(j.uid)); render(); } }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'linklike muted', text: '取消选择', onclick: () => { checked.clear(); render(); } }),
      ]),
    );
    bar.appendChild(
      h('div', { class: 'sel-actions' }, [
        h('button', { class: 'btn btn-sm btn-primary grow', disabled: batchBusy, onclick: () => batchAnalyze(checkedJobs()) }, [icon('spark'), `批量分析 ${n} 个`]),
        h('button', { class: 'btn btn-sm', onclick: () => batchExport(checkedJobs()) }, [icon('download'), '导出']),
        iconBtn('more', '更多批量操作', (e) =>
          openMenu(e.currentTarget, [
            view.verdict === 'dismissed'
              ? { icon: 'undo', label: `恢复（${n}）`, hint: '移回岗位列表', onClick: () => setDismissedUi(Array.from(checked), false) }
              : { icon: 'eyeOff', label: `不感兴趣（${n}）`, hint: '折叠并移到「不感兴趣」，可随时恢复', onClick: () => setDismissedUi(Array.from(checked), true) },
            { icon: 'chat', label: `标记已沟通（${n}）`, hint: '不再收录，也不参与批量 / 自动匹配', onClick: () => markContactedUi(Array.from(checked)) },
            {
              icon: 'block',
              label: `屏蔽（${n}）`,
              hint: '移出岗位库，之后不再收录',
              danger: true,
              onClick: () => { if (confirm(`屏蔽选中的 ${n} 个岗位？之后不再收录（可在设置中解除）。`)) blockJobsUi(Array.from(checked)); },
            },
          ]),
        ),
      ]),
    );
    return;
  }

  bar.appendChild(
    h('button', { class: 'btn btn-sm btn-ghost', disabled: total === 0, title: '勾选全部可见岗位，再批量分析 / 导出', onclick: () => { list.forEach((j) => checked.add(j.uid)); render(); } }, [
      icon('check'),
      `全选（${total}）`,
    ]),
  );
  bar.appendChild(h('div', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'btn btn-sm', onclick: exportJobs }, [icon('download'), '导出全部']));
  bar.appendChild(
    iconBtn('more', '更多', (e) =>
      openMenu(e.currentTarget, [
        {
          icon: 'trash',
          label: '清空岗位库',
          hint: '删除所有已收录岗位，不可撤销',
          danger: true,
          onClick: async () => {
            if (!confirm('确定清空所有已收录岗位？此操作不可撤销。')) return;
            jobs = await send(MSG.JOB_CLEAR_REQUEST);
            checked.clear();
            render();
            toast('已清空岗位库');
          },
        },
      ]),
    ),
  );
}

function renderBatchProgress(st) {
  const done = st.ok + st.fail + st.skipped;
  const pct = st.total ? Math.round((done / st.total) * 100) : 0;
  const parts = [];
  if (st.detail) parts.push(st.paused ? `${st.detail} 个等补详情（已暂停，见上方）` : `补详情 ${st.detail}`);
  if (st.queued + st.scoring) parts.push(`AI 分析中 ${st.queued + st.scoring}`);
  if (st.ok) parts.push(`成功 ${st.ok}`);
  if (st.fail) parts.push(`失败 ${st.fail}`);
  if (st.skipped) parts.push(`跳过 ${st.skipped}`);
  return h('div', { class: 'batch-panel' }, [
    h('div', { class: 'batch-head' }, [
      st.paused ? icon('pause', { cls: 'batch-ico paused' }) : h('span', { class: 'spinner spinner-sm' }),
      h('span', { class: 'batch-title', text: `批量分析 ${done} / ${st.total}` }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-xs btn-danger', disabled: batchStopping, text: batchStopping ? '正在停止…' : '停止', onclick: stopBatch }),
    ]),
    h('div', { class: 'progress' + (st.paused ? ' paused' : '') }, [h('span', { class: 'progress-fill', style: `width:${pct}%` })]),
    parts.length ? h('div', { class: 'batch-sub', text: parts.join(' · ') }) : null,
  ]);
}

function checkedJobs() {
  return jobs.filter((j) => checked.has(j.uid));
}

// ============ 招呼语持久化 ============
function persistGreeting(uid, text) {
  send(MSG.GREETING_SAVE, { uid, text }).catch(() => {});
}
const persistGreetingDebounced = debounce((uid, text) => persistGreeting(uid, text), 500);

async function sendGreeting(job) {
  const text = greetingValueFor(job).trim();
  if (!text) {
    toast('招呼语为空', true);
    return;
  }
  // 可选：发送前二次确认（设置 → 隐私 → confirmBeforeSend）
  if (settings.privacy && settings.privacy.confirmBeforeSend) {
    if (!confirm(`确认发送给 ${job.company || 'HR'}？\n\n${text}`)) return;
  }
  // 以当前文本为准，落库
  greetingCache.set(job.uid, text);
  persistGreeting(job.uid, text);
  // 先复制到剪贴板兜底（无论聊天能否自动填入，招呼语都在手上）
  copyText(text);
  if (!job.url) {
    toast('招呼语已复制，该岗位没有可打开的链接，请手动打开岗位页粘贴发送', true);
    return;
  }
  try {
    // 新建标签页打开岗位并自动进入与 HR 的沟通（保留当前浏览的标签）
    const r = await send(MSG.OPEN_JOB_CHAT, { uid: job.uid, url: job.url, platform: job.platform, text });
    if (r && r.mode === 'sent') toast('已在新标签页打开与 HR 的沟通并尝试发送，招呼语已复制备用');
    else toast('已在新标签页打开岗位并进入沟通，招呼语已复制，请在聊天框 Ctrl+V 粘贴发送');
  } catch (e) {
    // 打开失败：招呼语已复制，提示手动粘贴
    toast(`招呼语已复制，请手动打开岗位页粘贴发送（${e.message}）`, true);
  }
}

async function regenerateGreeting(job) {
  if (await generateGreetingUi(job, true)) {
    greetingCache.delete(job.uid);
    persistGreeting(job.uid, ''); // 清掉旧草稿，显示新生成的对应档位
    render();
  }
}

// 生成三档招呼语（force：不用缓存，重新写一版）
async function generateGreetingUi(job, force = false) {
  if (greeting.has(job.uid)) return false;
  greeting.add(job.uid);
  greetFailed.delete(job.uid);
  render();
  try {
    await send(MSG.AI_GREETING, { uid: job.uid, force });
    jobs = await send(MSG.JOB_LIST_REQUEST);
    if (force) toast('已重新生成招呼语');
    return true;
  } catch (e) {
    greetFailed.set(job.uid, e.message);
    toast(e.message, true);
    return false;
  } finally {
    greeting.delete(job.uid);
    render();
  }
}

function hasGreetings(m) {
  const g = greetingsOf(m);
  return !!(g.short || g.standard || g.detailed);
}

// ============ 分析 ============
async function analyze(job, force) {
  if (scoring.has(job.uid)) return;
  if (!providers.length) {
    toast('请先在设置中配置 AI 接口', true);
    send(MSG.OPEN_OPTIONS, { section: 'ai' });
    return;
  }
  scoring.add(job.uid);
  render();
  try {
    await send(MSG.AI_MATCH_SCORE, { uid: job.uid, job, force });
    jobs = await send(MSG.JOB_LIST_REQUEST);
    toast('分析完成');
  } catch (e) {
    toast(e.message, true);
  } finally {
    scoring.delete(job.uid);
    render();
  }
}

// 统一管理 batchBusy：带看门狗，任务异常挂起也能自动复位，避免批量按钮永久变灰。
let batchWatchdog = null;
function setBatchBusy(v) {
  batchBusy = v;
  clearTimeout(batchWatchdog);
  if (v) {
    batchWatchdog = setTimeout(() => {
      batchBusy = false;
      render();
      toast('批量任务超时已自动复位，请重试', true);
    }, 180000);
  }
}

// 批量分析：交给后台流水线——详情已就绪的立即匹配，未就绪的边补全边匹配（哪个详情读完就马上分析哪个）。
// 这里只轮询进度、刷新转圈与分数。
async function batchAnalyze(list) {
  if (batchBusy) return;
  if (!providers.length) {
    toast('请先在设置中配置 AI 接口', true);
    send(MSG.OPEN_OPTIONS, { section: 'ai' });
    return;
  }
  if (!list.length) return;
  setBatchBusy(true);
  render();
  let st;
  try {
    st = await send(MSG.BATCH_START, { uids: list.map((j) => j.uid) });
  } catch (e) {
    toast(e.message, true);
    setBatchBusy(false);
    render();
    return;
  }
  await watchBatch(st);
}

// 跟踪后台批量进度直到结束；侧边栏重新打开时也用它接上正在进行的批量
// 进度画在底栏（见 renderBatchProgress），挂起原因与恢复按钮在列表上方的状态提示里；结束时再 toast 汇总
async function watchBatch(st) {
  setBatchBusy(true);
  batchStopping = false;
  try {
    for (;;) {
      batchState = st;
      scoring.clear();
      (st.pendingUids || []).forEach((u) => scoring.add(u));
      jobs = await send(MSG.JOB_LIST_REQUEST).catch(() => jobs);
      render();
      if (!st.running) break;
      setBatchBusy(true); // 还在跑就续上看门狗，避免长时间补全被误判超时
      await sleep(2500);
      st = await send(MSG.BATCH_STATUS);
    }
    const reasons = Object.entries(st.skippedReasons || {}).map(([r, n]) => `${r} ${n}`).join('，');
    const summary = `批量分析完成：成功 ${st.ok}` + (st.fail ? `，失败 ${st.fail}` : '') + (st.skipped ? `，跳过 ${st.skipped}（${reasons}）` : '');
    if (st.aborted) toast(`${st.aborted}；${summary}`, true);
    else toast(summary + (st.fail && st.firstErr ? `（${st.firstErr}）` : ''), !!(st.fail || st.skipped));
  } catch (e) {
    toast(e.message, true);
  } finally {
    scoring.clear();
    batchState = null;
    batchStopping = false;
    setBatchBusy(false);
    render();
  }
}

async function stopBatch() {
  batchStopping = true;
  updateBatchBar();
  try {
    await send(MSG.BATCH_CANCEL);
  } catch (e) {
    batchStopping = false;
    updateBatchBar();
    toast(e.message, true);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// —— 批量导出：把勾选的岗位导成一份带详细分类与内容的表格（CSV，Excel/WPS 可直接打开） ——
function batchExport(list) {
  const items = Array.isArray(list) ? list : checkedJobs();
  if (!items.length) {
    toast('未选择岗位', true);
    return;
  }
  const csv = buildDetailedCsv(items);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  chrome.downloads
    .download({ url, filename: `岗位导出-${items.length}条-${ts}.csv`, saveAs: true })
    .then(() => toast(`已导出 ${items.length} 个岗位`))
    .catch(() => {
      // 无 downloads 权限时回退：新标签打开
      chrome.tabs.create({ url });
      toast(`已在新标签打开导出内容（${items.length} 个岗位）`);
    });
}

// 活跃描述是相对时间（如「3日内活跃」），附上观测时刻才有意义
function hrActiveTitle(job) {
  return job.hrActiveAt ? `观测于 ${fmtTime(job.hrActiveAt)}` : '';
}
async function exportJobs() {
  try {
    const res = await send(MSG.JOB_EXPORT_REQUEST, { format: 'csv' });
    const blob = new Blob([res.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 10);
    await chrome.downloads.download({ url, filename: `岗位收录-${ts}.csv`, saveAs: true }).catch(() => {
      chrome.tabs.create({ url });
    });
    toast(`已导出 ${res.count} 个岗位`);
  } catch (e) {
    toast(e.message, true);
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制'),
    () => toast('复制失败', true),
  );
}

boot();
