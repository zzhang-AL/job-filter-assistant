import { MSG, MODE } from '../common/constants.js';
import { scoreProfile } from '../common/profile.js';
import { applyFilters } from '../common/filters.js';
import { hrActivityTier, activitySortKey, isStaleHr } from '../common/activity.js';
import { VERDICT_LABELS, GREETING_LEVELS, normalizeGreetings, DIM_LABELS } from '../common/ai/prompts.js';
import { send, h, toast, esc, debounce } from './ui-common.js';

const app = document.getElementById('app');

let jobs = [];
let settings = null;
let profile = null;
let providers = [];
let activeCtx = null; // 当前激活标签页上下文：{platform, jobKey, isChat}
const expanded = new Set(); // 展开分析详情的 uid（岗位库内联）
const scoring = new Set(); // 正在打分的 uid

// 视图状态
const view = {
  tab: 'library', // library | current
  sub: 'info', // 当前岗位子页：info | company | greeting
  greetLevel: 'standard', // 招呼语档位：short | standard | detailed
  search: '',
  verdict: 'all',
  sort: 'active', // 默认 HR 活跃优先
  platform: 'all',
};
let lastMode = null; // 上次同步到筛选的平台模式
let selectedUid = null; // 手动选中的「当前岗位」；null 时按页面自动识别
const greetingCache = new Map(); // uid -> 编辑中的招呼语文本（会话态）
let greetingTextarea = null; // 当前渲染的招呼语输入框引用
const tailorCache = new Map(); // uid -> 简历定制建议（仅会话态，不落库）
const tailoring = new Set(); // 正在生成简历建议的 uid
const checked = new Set(); // 岗位库中勾选的 uid（批量操作）
let batchBusy = false; // 批量分析进行中（禁用按钮 + 防重入）
let autoStatus = null; // 后台自动分析进度 { running, pending, done, lastError, lastErrorAt }
let batchPause = null; // 批量分析里补详情被挂起：{ reason, resumeAt, waiting }

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
      updateAutoLine();
    } else if (msg.type === MSG.CURRENT_JOB) {
      // 网站上点开了新岗位：取消手动固定，跟随网站，实时刷新当前岗位视图
      onCurrentJobChanged();
    }
  });
}

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
    app.innerHTML = `<div class="empty"><div class="icon">⚠️</div>${esc(e.message)}</div>`;
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
  render();
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
  if (activeCtx && activeCtx.platform && activeCtx.jobKey) {
    const uid = `${activeCtx.platform}:${activeCtx.jobKey}`;
    const j = jobs.find((x) => x.uid === uid);
    if (j) return j;
  }
  return null;
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

function visibleJobs() {
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
  if (view.verdict !== 'all') {
    if (view.verdict === 'unscored') list = list.filter((j) => !j.match);
    else list = list.filter((j) => j.match && j.match.verdict === view.verdict);
  }
  const byScore = (a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1);
  const byRecent = (a, b) => (b.lastSeenAt || b.savedAt || '').localeCompare(a.lastSeenAt || a.savedAt || '');
  let cmp;
  if (view.sort === 'score') cmp = byScore;
  else if (view.sort === 'salary') cmp = (a, b) => (b.salaryMaxK ?? b.salaryMinK ?? 0) - (a.salaryMaxK ?? a.salaryMinK ?? 0);
  else if (view.sort === 'recent') cmp = byRecent;
  else cmp = (a, b) => activitySortKey(a) - activitySortKey(b) || byScore(a, b) || byRecent(a, b); // HR 活跃优先，同档按匹配分
  // 任何排序下，HR 数月 / 半年未活跃的都沉到最后
  list.sort((a, b) => (isStaleHr(a) - isStaleHr(b)) || cmp(a, b));
  return list;
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
  const cur = view.tab === 'current' ? currentJob() : null;
  const viewKey = view.tab === 'current' ? `current|${cur ? cur.uid : ''}|${view.sub}` : 'library';
  // 同一视图的重绘（后台广播刷新、点星标等）不再播放淡入动画，否则整列卡片会一起闪一下
  app.classList.toggle('no-anim', viewKey === lastViewKey);
  const curBody = viewKey === lastViewKey ? app.querySelector('.cur-body') : null;
  const curTop = curBody ? curBody.scrollTop : 0;
  lastViewKey = viewKey;
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

  const list = visibleJobs();
  app.appendChild(renderTopBar(list.length, 'library'));

  app.appendChild(h('div', { id: 'sp-auto-line' }));
  updateAutoLine();

  const ps = scoreProfile(profile);
  if (ps.score < 40) {
    app.appendChild(
      h('div', { class: 'profile-hint', onclick: () => send(MSG.OPEN_OPTIONS) }, [
        h('span', { text: '💡' }),
        h('span', { text: `画像完整度 ${ps.score}%，完善后 AI 匹配更准 →` }),
      ]),
    );
  } else if (!providers.length) {
    app.appendChild(
      h('div', { class: 'profile-hint', onclick: () => send(MSG.OPEN_OPTIONS) }, [
        h('span', { text: '🔌' }),
        h('span', { text: '尚未配置 AI 接口，点此前往设置 →' }),
      ]),
    );
  }

  const listEl = h('div', { class: 'sp-list' });
  fillList(listEl, list);
  app.appendChild(listEl);
  app.appendChild(renderBottom(list));
}

function fillList(listEl, list) {
  listEl.innerHTML = '';
  if (!list.length) {
    listEl.appendChild(
      h('div', { class: 'empty' }, [
        h('div', { class: 'icon', text: '📭' }),
        h('div', { text: jobs.some((j) => !hiddenAsContacted(j)) ? '没有符合条件的岗位' : '还没有收录岗位' }),
        h('div', {
          class: 'tiny',
          text: jobs.some((j) => !hiddenAsContacted(j)) ? '试试调整筛选条件' : '打开 BOSS直聘 或 前程无忧 浏览岗位即可自动收录',
        }),
      ]),
    );
  } else {
    for (const job of list) listEl.appendChild(renderCard(job));
  }
}

// 搜索时只换列表内容、计数与底栏，顶栏（含搜索框）保持不动
function refreshLibraryList() {
  const listEl = app.querySelector('.sp-list');
  if (view.tab !== 'library' || !listEl) return render();
  const list = visibleJobs();
  fillList(listEl, list);
  listEl.scrollTop = listScroll[listScrollKey()] || 0;
  const count = document.getElementById('sp-count');
  if (count) count.textContent = `共 ${jobs.length} 个岗位 · 显示 ${list.length}`;
  updateBatchBar();
}

// —— 顶栏：logo + 标题 + 顶级 Tab（岗位库/当前岗位）+（岗位库时）搜索筛选 ——
function renderTopBar(shown, mode) {
  const tabsRow = h('div', { class: 'sp-tabs' }, [
    tabBtn('library', '岗位库', view.tab === 'library'),
    tabBtn('current', '当前岗位', view.tab === 'current'),
  ]);

  const titleRow = h('div', { class: 'sp-title-row' }, [
    h('div', { class: 'sp-logo', text: '🎯' }),
    h('div', {}, [
      h('div', { class: 'sp-title', text: '岗位面板' }),
      h('div', {
        class: 'sp-count',
        id: 'sp-count',
        text: mode === 'library' ? `共 ${jobs.length} 个岗位 · 显示 ${shown}` : ctxLabel(),
      }),
    ]),
    h('div', { class: 'spacer' }),
    mode === 'current'
      ? h('button', { class: 'jc-icon-btn', text: '↻', title: '刷新当前页面', onclick: async () => { await refreshContext(); render(); } })
      : null,
    h('button', { class: 'jc-icon-btn', text: '⚙️', title: '设置', onclick: () => send(MSG.OPEN_OPTIONS) }),
  ]);

  const children = [titleRow, tabsRow];

  if (mode === 'library') {
    const searchInput = h('input', { type: 'text', placeholder: '搜索岗位/公司/技能', value: view.search });
    // 只刷新列表、不整页重绘：重建输入框会打断中文输入法组字、丢光标。
    // 组字中（拼音还没上屏）不筛选；停顿 400ms 或按回车再应用
    const applySearch = () => {
      if (view.search === searchInput.value) return;
      view.search = searchInput.value;
      refreshLibraryList();
    };
    const applySoon = debounce(applySearch, 400);
    searchInput.addEventListener('input', (e) => {
      if (!e.isComposing) applySoon();
    });
    searchInput.addEventListener('compositionend', applySoon);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) applySearch();
    });

    const verdictChips = [
      ['all', '全部'],
      ['strong', '强匹配'],
      ['good', '较匹配'],
      ['fair', '一般'],
      ['unscored', '未分析'],
    ].map(([v, label]) =>
      h('button', {
        class: 'filter-chip' + (view.verdict === v ? ' active' : ''),
        text: label,
        onclick: () => { view.verdict = v; render(); },
      }),
    );

    const sortSel = h('select', { class: 'sp-sort' }, [opt('active', 'HR 活跃优先'), opt('score', '匹配分'), opt('recent', '最近收录'), opt('salary', '薪资')]);
    sortSel.value = view.sort;
    sortSel.addEventListener('change', () => { view.sort = sortSel.value; render(); });

    const platChips = [
      ['all', '全部平台'],
      ['boss', 'BOSS'],
      ['qcwy', '51job'],
    ].map(([v, label]) =>
      h('button', {
        class: 'filter-chip' + (view.platform === v ? ' active' : ''),
        text: label,
        onclick: () => { setPlatformFilter(v); render(); },
      }),
    );

    children.push(
      h('div', { class: 'sp-toolbar' }, [h('div', { class: 'sp-search' }, [searchInput])]),
      h('div', { class: 'sp-filters' }, [...platChips]),
      h('div', { class: 'sp-filters', style: 'margin-top:8px' }, [...verdictChips, sortSel]),
    );
  }

  return h('div', { class: 'sp-top' }, children);
}

function tabBtn(key, label, active) {
  return h('button', {
    class: 'sp-tab' + (active ? ' active' : ''),
    text: label,
    onclick: async () => {
      if (view.tab === key) return;
      view.tab = key;
      if (key === 'current') await refreshContext();
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

// ============ 岗位库卡片 ============
function renderCard(job) {
  const m = job.match;
  const risks = (job._filter && job._filter.risks) || [];

  const scoreBox = h(
    'div',
    { class: 'jc-score', onclick: () => analyze(job, true) },
    m
      ? [
          h('div', { class: `score-badge verdict-${m.verdict}`, text: String(m.score) }),
          h('div', { class: 'lbl', text: VERDICT_LABELS[m.verdict] || '' }),
        ]
      : scoring.has(job.uid)
      ? [h('span', { class: 'spinner' })]
      : [
          h('div', { class: 'score-badge verdict-weak', text: '?', style: 'background:var(--fill-2);color:var(--text-3)' }),
          h('div', { class: 'lbl', text: '点击分析' }),
        ],
  );

  const tags = (job.skills.length ? job.skills : job.tags).slice(0, 5).map((t) => h('span', { class: 'chip', text: t }));
  if (risks.length) {
    for (const r of risks.slice(0, 2)) tags.push(h('span', { class: 'chip chip-red', text: '⚠ ' + r }));
  }
  if (job.contacted) tags.unshift(contactedChip(job));
  if (!m && (job.autoScoreFails || 0) >= 2) {
    tags.unshift(h('span', { class: 'chip chip-red', text: '自动分析失败', title: `${job.autoScoreError || ''}（已不再自动重试，可点「AI 分析」手动重试）` }));
  }
  const act = activityChip(job);
  if (act) tags.unshift(act);

  const metaParts = [];
  metaParts.push(h('span', { class: `plat plat-${job.platform}`, text: job.platform === 'boss' ? 'BOSS' : '51job' }));
  if (job.city) metaParts.push(h('span', { text: job.city + (job.district ? ' · ' + job.district : '') }));
  if (job.experience) metaParts.push(h('span', { text: job.experience }));
  if (job.degree) metaParts.push(h('span', { text: job.degree }));
  if (job.companyScale) metaParts.push(h('span', { text: job.companyScale }));

  const isChecked = checked.has(job.uid);
  const checkbox = h('label', { class: 'jc-check', title: '勾选以批量操作' }, [
    (() => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = isChecked;
      cb.addEventListener('change', () => {
        if (cb.checked) checked.add(job.uid);
        else checked.delete(job.uid);
        card.classList.toggle('is-checked', cb.checked);
        updateBatchBar();
      });
      return cb;
    })(),
  ]);

  const card = h('div', { class: 'job-card fade-up' + (isChecked ? ' is-checked' : '') + (isStaleHr(job) ? ' is-stale' : '') }, [
    h('div', { class: 'jc-head' }, [
      checkbox,
      h('div', { class: 'jc-main clickable', title: '在「当前岗位」查看', onclick: () => openCurrent(job, 'info') }, [
        h('div', { class: 'jc-title-row' }, [
          h('div', { class: 'jc-title', text: job.title, title: job.title }),
          job.salaryText ? h('div', { class: 'jc-salary', text: job.salaryText }) : null,
        ]),
        h('div', { class: 'jc-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
        h('div', { class: 'jc-meta' }, metaParts),
        tags.length ? h('div', { class: 'jc-tags' }, tags) : null,
      ]),
      scoreBox,
    ]),
    h('div', { class: 'jc-actions' }, [
      h('button', { class: 'btn btn-sm btn-primary', text: m ? '重新分析' : 'AI 分析', onclick: () => analyze(job, true) }),
      h('button', { class: 'btn btn-sm', text: '打招呼', onclick: () => openCurrent(job, 'greeting') }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'jc-icon-btn' + (job.star ? ' starred' : ''),
        text: job.star ? '★' : '☆',
        title: '收藏',
        onclick: async () => { jobs = await send(MSG.JOB_STAR_TOGGLE, { uid: job.uid }); render(); },
      }),
      job.url
        ? h('button', { class: 'jc-icon-btn', text: '↗', title: '打开原岗位', onclick: () => chrome.tabs.create({ url: job.url }) })
        : null,
      job.contacted === 'job'
        ? null
        : h('button', {
            class: 'jc-icon-btn',
            text: '💬',
            title: '标记为已沟通：之后不再收录、不参与批量/自动匹配（可在设置中撤销）',
            onclick: () => markContactedUi([job.uid]),
          }),
      h('button', {
        class: 'jc-icon-btn',
        text: '🚫',
        title: '屏蔽：移出岗位库，之后不再收录（清空岗位库也有效）',
        onclick: () => blockJobsUi([job.uid]),
      }),
      h('button', {
        class: 'jc-icon-btn',
        text: '🗑',
        title: '删除',
        onclick: async () => { jobs = await send(MSG.JOB_DELETE, { uid: job.uid }); render(); },
      }),
    ]),
  ]);
  return card;
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

// 自动分析状态行：进行中显示剩余数；最近 30 分钟内出错显示原因（之前出错是静默的，看起来像「停了」）
function updateAutoLine() {
  const el = document.getElementById('sp-auto-line');
  if (!el) return;
  el.innerHTML = '';
  if (batchPause) el.appendChild(renderPauseHint(batchPause));
  const st = autoStatus;
  if (!st || !settings || !settings.autoScore) return;
  if (st.running && st.pending) {
    el.appendChild(h('div', { class: 'profile-hint', text: `🤖 自动分析中 · 还剩 ${st.pending} 个（详情就绪即分析）` }));
  } else if (st.lastError && Date.now() - (st.lastErrorAt || 0) < 30 * 60 * 1000) {
    el.appendChild(h('div', { class: 'profile-hint', title: st.lastError, text: `⚠️ 自动分析出错：${st.lastError.slice(0, 60)}` }));
  }
}

const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';

function resumeInText(resumeAt) {
  const min = Math.ceil(((resumeAt || 0) - Date.now()) / 60000);
  return min > 0 ? `约 ${min} 分钟后自动继续` : '即将自动继续';
}

// 补详情挂起：原因 + 立即继续 / 去登录（登录完成后会自动继续）
function renderPauseHint(p) {
  const needLogin = /未登录/.test(p.reason);
  return h('div', { class: 'profile-hint pause-hint' }, [
    h('span', { class: 'pause-text', text: `⏸ ${p.reason}，${p.waiting} 个岗位待补详情，${resumeInText(p.resumeAt)}` }),
    needLogin ? h('button', { class: 'btn btn-sm', text: '去登录', onclick: () => chrome.tabs.create({ url: BOSS_LOGIN_URL }) }) : null,
    h('button', { class: 'btn btn-sm', text: '立即继续', onclick: resumeDetailsUi }),
  ]);
}

async function resumeDetailsUi() {
  try {
    await send(MSG.WORKER_HALT_CLEAR);
    batchPause = null;
    updateAutoLine();
    toast('已解除暂停，继续补全详情');
  } catch (e) {
    toast(e.message, true);
  }
}

function contactedChip(job) {
  return job.contacted === 'job'
    ? h('span', { class: 'chip chip-orange', text: '已沟通', title: '你已和该岗位 HR 沟通过，批量/自动匹配会跳过' })
    : h('span', { class: 'chip chip-orange', text: '已沟通该公司', title: '你沟通过这家公司的其他岗位' });
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
    body.appendChild(
      h('div', { class: 'empty' }, [
        h('div', { class: 'icon', text: '🧭' }),
        h('div', { text: activeCtx && activeCtx.platform ? '未匹配到当前页面的岗位' : '未识别到岗位页面' }),
        h('div', { class: 'tiny', text: '在 BOSS/51job 打开某个岗位详情后点右上角 ↻ 刷新，或从岗位库里选择一个岗位' }),
        h('button', {
          class: 'btn btn-sm btn-primary',
          text: '去岗位库选择',
          style: 'margin-top:14px',
          onclick: () => { view.tab = 'library'; render(); },
        }),
      ]),
    );
    return body;
  }

  // 岗位头部：标题/薪资/公司 + 匹配分
  const m = job.match;
  const head = h('div', { class: 'cur-head' }, [
    h('div', { class: 'cur-head-main' }, [
      h('div', { class: 'cur-title', text: job.title }),
      job.salaryText ? h('div', { class: 'cur-salary', text: job.salaryText }) : null,
      h('div', { class: 'cur-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
      job.contacted || activityChip(job) ? h('div', { class: 'jc-tags' }, [activityChip(job), job.contacted ? contactedChip(job) : null]) : null,
    ]),
    h(
      'div',
      { class: 'jc-score', onclick: () => analyze(job, true), title: '点击重新分析' },
      m
        ? [h('div', { class: `score-badge verdict-${m.verdict}`, text: String(m.score) }), h('div', { class: 'lbl', text: VERDICT_LABELS[m.verdict] || '' })]
        : scoring.has(job.uid)
        ? [h('span', { class: 'spinner' })]
        : [h('div', { class: 'score-badge verdict-weak', text: '?', style: 'background:var(--fill-2);color:var(--text-3)' }), h('div', { class: 'lbl', text: '点击分析' })],
    ),
  ]);
  body.appendChild(head);

  // 子页签
  const sub = h('div', { class: 'segmented subtabs' }, [
    subBtn('info', '岗位信息'),
    subBtn('company', '公司画像'),
    subBtn('resume', '简历建议'),
    subBtn('greeting', '打招呼'),
  ]);
  body.appendChild(sub);

  const panel = h('div', { class: 'cur-panel fade-up' });
  if (view.sub === 'info') renderJobInfo(panel, job);
  else if (view.sub === 'company') renderCompany(panel, job);
  else if (view.sub === 'resume') renderResumeAdvice(panel, job);
  else renderGreeting(panel, job);
  body.appendChild(panel);

  return body;
}

function subBtn(key, label) {
  return h('button', {
    class: view.sub === key ? 'active' : '',
    text: label,
    onclick: () => { view.sub = key; render(); },
  });
}

function renderJobInfo(panel, job) {
  const facts = [];
  const factRow = (k, v) => (v ? facts.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v })])) : null);
  factRow('薪资', job.salaryText);
  factRow('城市', job.city + (job.district ? ' · ' + job.district : ''));
  factRow('地址', job.address);
  // 经验以详情为准；JD 正文写明的年限与标签不同时一并显示
  factRow('经验', [job.experience, job.experienceJd && job.experienceJd !== job.experience ? `JD 写明 ${job.experienceJd}` : ''].filter(Boolean).join(' · '));
  factRow('学历', job.degree);
  factRow('平台', job.platform === 'boss' ? 'BOSS 直聘' : '前程无忧 51job');
  if (facts.length) panel.appendChild(h('div', { class: 'cur-facts' }, facts));

  const skills = job.skills && job.skills.length ? job.skills : job.tags;
  if (skills && skills.length) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '技能 / 标签' }));
    panel.appendChild(h('div', { class: 'jc-tags' }, skills.slice(0, 20).map((t) => h('span', { class: 'chip', text: t }))));
  }
  if (job.welfare && job.welfare.length) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '福利' }));
    panel.appendChild(h('div', { class: 'jc-tags' }, job.welfare.slice(0, 20).map((t) => h('span', { class: 'chip chip-green', text: t }))));
  }
  if (job.description) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '岗位描述' }));
    panel.appendChild(h('div', { class: 'cur-jd', text: job.description }));
  }

  // 匹配分析
  panel.appendChild(h('div', { class: 'cur-sec-title', text: '匹配分析' }));
  if (job.match) {
    panel.appendChild(renderAnalysis(job.match));
  } else {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [
        h('span', { text: '尚未分析，' }),
        h('button', { class: 'linklike', text: '立即 AI 分析', onclick: () => analyze(job, true) }),
      ]),
    );
  }
  if (job.url) {
    panel.appendChild(
      h('button', { class: 'btn btn-sm btn-block', text: '↗ 打开原岗位页面', style: 'margin-top:14px', onclick: () => chrome.tabs.create({ url: job.url }) }),
    );
  }
  if (job.contacted !== 'job') {
    panel.appendChild(
      h('button', { class: 'btn btn-sm btn-block', text: '💬 标记为已沟通', style: 'margin-top:8px', onclick: () => markContactedUi([job.uid]) }),
    );
  }
  panel.appendChild(
    h('button', { class: 'btn btn-sm btn-block', text: '🚫 屏蔽该岗位（不再收录）', style: 'margin-top:8px', onclick: () => blockJobsUi([job.uid]) }),
  );
}

function renderAnalysis(m) {
  const box = h('div', { class: 'jc-analysis' }, [
    m.summary ? h('div', { class: 'summary', text: m.summary }) : null,
    m.activityPenalty
      ? h('div', { class: 'cur-note', text: `因 HR 活跃度已扣 ${m.activityPenalty} 分（扣分前 ${m.rawScore}）` })
      : null,
  ]);
  // 硬门槛提示（存在明确不匹配的强制要求时醒目提示，但不隐藏分数——由你自己判断是否投递）
  if (m.eligible === false && m.blockers && m.blockers.length) {
    const gate = h('div', { class: 'gate-warn' }, [h('div', { class: 'gate-title', text: '⛔ 存在硬性门槛' })]);
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
          h('span', { class: 'dim-bar' }, [h('span', { class: 'dim-fill', style: `width:${v}%` })]),
          h('span', { class: 'dim-v', text: String(v) }),
        ]),
      );
    });
    if (dimBox.children.length) box.appendChild(dimBox);
  }
  if (m.reasons && m.reasons.length) {
    box.appendChild(h('h5', { text: '✅ 契合点' }));
    box.appendChild(h('ul', {}, m.reasons.map((r) => h('li', { text: r }))));
  }
  if (m.gaps && m.gaps.length) {
    box.appendChild(h('h5', { text: '📌 差距/需补齐' }));
    box.appendChild(h('ul', {}, m.gaps.map((r) => h('li', { text: r }))));
  }
  if (m.risks && m.risks.length) {
    box.appendChild(h('h5', { text: '⚠️ 风险提示' }));
    box.appendChild(h('ul', {}, m.risks.map((r) => h('li', { class: 'risk-line', text: r }))));
  }
  return box;
}

function renderCompany(panel, job) {
  const rows = [];
  const row = (k, v) => (v ? rows.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v })])) : null);
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
  panel.appendChild(
    h('div', { class: 'cur-note', text: '公司画像基于岗位接口返回的公开信息整理，仅供参考。' }),
  );
}

function renderGreeting(panel, job) {
  if (!providers.length) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [h('span', { text: '尚未配置 AI 接口，' }), h('button', { class: 'linklike', text: '前往设置', onclick: () => send(MSG.OPEN_OPTIONS) })]),
    );
    return;
  }
  if (!job.match) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [
        h('span', { text: '先做一次匹配分析，AI 会生成三档招呼语。' }),
      ]),
    );
    panel.appendChild(
      h('button', {
        class: 'btn btn-sm btn-primary btn-block',
        text: scoring.has(job.uid) ? '分析中…' : '生成招呼语',
        disabled: scoring.has(job.uid),
        style: 'margin-top:10px',
        onclick: () => analyze(job, true),
      }),
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
  panel.appendChild(h('div', { class: 'greet-head' }, [h('span', { class: 'cur-sec-title', text: '💬 招呼语（可编辑）' }), h('div', { class: 'spacer' }), levelSeg]));

  const value = greetingValueFor(job);
  const ta = h('textarea', { class: 'greet-editor', rows: 6, placeholder: '编辑要发送给 HR 的招呼语…' });
  ta.value = value;
  ta.dataset.uid = job.uid;
  greetingTextarea = ta;
  const counter = h('div', { class: 'greet-count', text: `${value.length} 字` });
  ta.addEventListener('input', () => {
    greetingCache.set(job.uid, ta.value);
    counter.textContent = `${ta.value.length} 字`;
    persistGreetingDebounced(job.uid, ta.value);
  });
  panel.appendChild(ta);
  panel.appendChild(counter);

  // 发送状态提示
  const onChat = activeCtx && activeCtx.isChat;
  panel.appendChild(
    h('div', { class: 'greet-hint' + (onChat ? ' ok' : '') }, [
      h('span', {
        text: onChat
          ? '✓ 已在聊天页，点下方按钮尝试直接填入'
          : 'ℹ 点下方按钮会新建标签页打开岗位并自动进入与 HR 的沟通（保留当前标签），招呼语已复制，可 Ctrl+V 粘贴',
      }),
    ]),
  );

  // 操作按钮
  panel.appendChild(
    h('div', { class: 'greet-tools' }, [
      h('button', {
        class: 'btn btn-sm',
        text: scoring.has(job.uid) ? '生成中…' : '↻ 重新生成',
        disabled: scoring.has(job.uid),
        onclick: () => regenerateGreeting(job),
      }),
      h('button', { class: 'btn btn-sm', text: '📋 复制', onclick: () => copyText(greetingValueFor(job)) }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-primary', text: '打开沟通并复制', title: '新建标签页打开该岗位并自动进入与 HR 的沟通（保留当前标签），招呼语已复制，可 Ctrl+V 粘贴', onclick: () => sendGreeting(job) }),
    ]),
  );
}

// —— 简历建议子页：基于画像 + 该岗位 JD，给出定制简历的建议（只建议、不落库） ——
function renderResumeAdvice(panel, job) {
  if (!providers.length) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [h('span', { text: '尚未配置 AI 接口，' }), h('button', { class: 'linklike', text: '前往设置', onclick: () => send(MSG.OPEN_OPTIONS) })]),
    );
    return;
  }
  const hasProfile = profile && scoreProfile(profile).score > 0;
  if (!hasProfile) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [
        h('span', { text: '简历建议基于你的个人画像生成，请先在设置里完善画像（上传简历或手动填写），' }),
        h('button', { class: 'linklike', text: '前往设置', onclick: () => send(MSG.OPEN_OPTIONS) }),
      ]),
    );
    return;
  }

  const busy = tailoring.has(job.uid);
  const advice = tailorCache.get(job.uid);

  // 顶部：说明 + 生成/重新生成按钮
  panel.appendChild(
    h('div', { class: 'greet-head' }, [
      h('span', { class: 'cur-sec-title', text: '📝 简历定制建议' }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm btn-primary',
        text: busy ? '生成中…' : advice ? '↻ 重新生成' : '生成建议',
        disabled: busy,
        onclick: () => tailorAdvice(job),
      }),
    ]),
  );
  panel.appendChild(h('div', { class: 'tiny', text: '针对该岗位 JD，建议怎么调整简历去投递。仅给建议、不改你的原简历，只在本会话使用、不保存。' }));

  if (busy && !advice) {
    panel.appendChild(h('div', { class: 'cur-hint', style: 'margin-top:12px' }, [h('span', { class: 'spinner' }), h('span', { text: ' AI 正在分析…', style: 'margin-left:8px' })]));
    return;
  }
  if (!advice) return;

  const sec = (title, node) => {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: title }));
    panel.appendChild(node);
  };
  const chips = (list, cls) => h('div', { class: 'jc-tags' }, list.map((t) => h('span', { class: cls, text: t })));
  const bullets = (list) => h('ul', { class: 'advice-list' }, list.map((t) => h('li', { text: t })));

  if (advice.matchedSkills.length) sec('✅ 可突出的匹配点', chips(advice.matchedSkills, 'chip chip-green'));
  if (advice.keywordsToAlign.length) sec('🔑 建议对齐的岗位关键词', chips(advice.keywordsToAlign, 'chip'));
  if (advice.missingSkills.length) sec('📌 暂未体现（如实指出，勿编造）', chips(advice.missingSkills, 'chip chip-orange'));

  if (advice.summaryDraft) {
    sec('🧾 自我评价草稿（可直接粘贴）', h('div', { class: 'cur-jd', text: advice.summaryDraft }));
    panel.appendChild(h('button', { class: 'btn btn-sm', text: '📋 复制草稿', style: 'margin-top:8px', onclick: () => copyText(advice.summaryDraft) }));
  }
  if (advice.bulletSuggestions.length) sec('✍️ 经历改写建议', bullets(advice.bulletSuggestions));
  if (advice.tips.length) sec('💡 投递提醒', bullets(advice.tips));
  if (advice.note) panel.appendChild(h('div', { class: 'cur-hint', style: 'margin-top:10px' }, [h('span', { text: advice.note })]));
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
  const n = checked.size;

  const totalVisible = list.length;

  if (n > 0) {
    // 选中态：批量分析 / 批量导出，只作用于勾选的岗位
    const allSelected = totalVisible > 0 && n >= totalVisible;
    bar.classList.add('has-sel');
    bar.appendChild(
      h('div', { class: 'batch-wrap' }, [
        h('div', { class: 'batch-row1' }, [
          h('span', { class: 'batch-count', text: `已选 ${n}` }),
          h('button', {
            class: 'linklike',
            text: allSelected ? '取消全选' : '全选',
            onclick: () => {
              if (allSelected) checked.clear();
              else visibleJobs().forEach((j) => checked.add(j.uid));
              render();
            },
          }),
          h('button', { class: 'linklike', text: '清空选择', onclick: () => { checked.clear(); render(); } }),
        ]),
        h('div', { class: 'batch-row2' }, [
          batchBusy
            ? h('button', { class: 'btn btn-sm btn-danger', text: '停止批量分析', onclick: stopBatch })
            : h('button', { class: 'btn btn-sm btn-primary', text: `批量分析（${n}）`, onclick: () => batchAnalyze(checkedJobs()) }),
          h('button', { class: 'btn btn-sm', text: `批量导出（${n}）`, onclick: () => batchExport(checkedJobs()) }),
          h('button', { class: 'btn btn-sm', text: `标记已沟通（${n}）`, onclick: () => markContactedUi(Array.from(checked)) }),
          h('button', { class: 'btn btn-sm btn-danger', text: `批量屏蔽（${n}）`, onclick: () => blockJobsUi(Array.from(checked)) }),
        ]),
      ]),
    );
    return;
  }

  // 默认态：全选可一键勾选全部可见岗位，勾选后再批量分析/导出
  bar.classList.remove('has-sel');
  bar.appendChild(
    h('button', {
      class: 'btn btn-sm btn-primary',
      text: `全选 (${totalVisible})`,
      disabled: totalVisible === 0,
      onclick: () => { list.forEach((j) => checked.add(j.uid)); render(); },
    }),
  );
  bar.appendChild(h('div', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'btn btn-sm', text: '导出', onclick: exportJobs }));
  bar.appendChild(
    h('button', {
      class: 'btn btn-sm btn-danger',
      text: '清空',
      onclick: async () => {
        if (!confirm('确定清空所有已收录岗位？此操作不可撤销。')) return;
        jobs = await send(MSG.JOB_CLEAR_REQUEST);
        checked.clear();
        render();
        toast('已清空岗位库');
      },
    }),
  );
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
  await analyze(job, true);
  greetingCache.delete(job.uid);
  persistGreeting(job.uid, ''); // 清掉旧草稿，显示新生成的对应档位
  render();
}

// ============ 分析 ============
async function analyze(job, force) {
  if (scoring.has(job.uid)) return;
  if (!providers.length) {
    toast('请先在设置中配置 AI 接口', true);
    send(MSG.OPEN_OPTIONS);
    return;
  }
  scoring.add(job.uid);
  render();
  try {
    await send(MSG.AI_MATCH_SCORE, { uid: job.uid, job, force });
    jobs = await send(MSG.JOB_LIST_REQUEST);
    expanded.add(job.uid);
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
    send(MSG.OPEN_OPTIONS);
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
async function watchBatch(st) {
  setBatchBusy(true);
  try {
    for (;;) {
      scoring.clear();
      (st.pendingUids || []).forEach((u) => scoring.add(u));
      batchPause = st.running && st.paused ? { reason: st.paused, resumeAt: st.resumeAt, waiting: st.detail } : null;
      jobs = await send(MSG.JOB_LIST_REQUEST).catch(() => jobs);
      render();
      if (!st.running) break;
      const done = st.ok + st.fail + st.skipped;
      if (batchPause && !(st.queued + st.scoring)) {
        // 挂起期间只剩等详情的：提示原因，不刷进度（恢复按钮在列表上方）
        toast(`批量分析已暂停 ${done}/${st.total}：${st.paused}，${resumeInText(st.resumeAt)}`, true);
        setBatchBusy(true);
        await sleep(2500);
        st = await send(MSG.BATCH_STATUS);
        continue;
      }
      const parts = [`批量分析 ${done}/${st.total}`];
      if (st.detail) parts.push(`补全详情 ${st.detail}`);
      if (st.queued + st.scoring) parts.push(`AI 分析中 ${st.queued + st.scoring}`);
      toast(parts.join(' · ') + (st.detail ? '（详情按人工节奏补全，读完即分析）' : '') + '…');
      setBatchBusy(true); // 有进展就续上看门狗，避免长时间补全被误判超时
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
    batchPause = null;
    setBatchBusy(false);
    render();
  }
}

async function stopBatch() {
  try {
    await send(MSG.BATCH_CANCEL);
    toast('正在停止批量分析…');
  } catch (e) {
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

// 生成详细 CSV：按「基本信息 / 岗位要求 / 公司信息 / AI匹配分析 / 招呼语 / 其他」分类排列列
function buildDetailedCsv(items) {
  const cols = [
    // —— 分类/优先级 ——
    ['平台', (j) => (j.platform === 'boss' ? 'BOSS直聘' : '前程无忧51job')],
    ['匹配档次', (j) => (j.match ? VERDICT_LABELS[j.match.verdict] || j.match.verdict : '未分析')],
    ['匹配分', (j) => (j.match ? j.match.score : '')],
    ['是否收藏', (j) => (j.star ? '★' : '')],
    // —— 基本信息 ——
    ['岗位名称', (j) => j.title],
    ['薪资', (j) => j.salaryText],
    ['薪资下限(K/月)', (j) => (j.salaryMinK != null ? j.salaryMinK : '')],
    ['薪资上限(K/月)', (j) => (j.salaryMaxK != null ? j.salaryMaxK : '')],
    ['城市', (j) => j.city],
    ['区域', (j) => j.district],
    // —— 岗位要求 ——
    ['工作地址', (j) => j.address],
    ['工作经验', (j) => j.experience],
    ['JD写明经验', (j) => j.experienceJd],
    ['学历要求', (j) => j.degree],
    ['技能', (j) => joinList(j.skills)],
    ['岗位标签', (j) => joinList(j.tags)],
    ['福利', (j) => joinList(j.welfare)],
    // —— 公司信息 ——
    ['公司名称', (j) => j.company],
    ['所属行业', (j) => j.companyIndustry],
    ['公司规模', (j) => j.companyScale],
    ['公司性质', (j) => j.companyType],
    ['融资阶段', (j) => j.companyStage],
    ['HR', (j) => j.hrName],
    ['HR职位', (j) => j.hrTitle],
    ['HR活跃', (j) => j.hrActiveText || (j.hrOnline ? '在线' : '')],
    ['沟通状态', (j) => (j.contacted === 'job' ? '已沟通' : j.contacted === 'company' ? '已沟通该公司' : '')],
    ['活跃观测时间', (j) => fmtTime(j.hrActiveAt)],
    // —— AI 匹配分析 ——
    ['一句话总评', (j) => (j.match ? j.match.summary : '')],
    ['契合点', (j) => (j.match ? joinList(j.match.reasons) : '')],
    ['差距/需补齐', (j) => (j.match ? joinList(j.match.gaps) : '')],
    ['风险提示', (j) => (j.match ? joinList(j.match.risks) : '')],
    // —— 招呼语 ——
    ['招呼语(标准版)', (j) => (j.greetingDraft || (j.match ? normalizeGreetings(j.match).standard : ''))],
    // —— 其他 ——
    ['岗位描述', (j) => j.description],
    ['收录时间', (j) => fmtTime(j.savedAt)],
    ['最近出现', (j) => fmtTime(j.lastSeenAt)],
    ['岗位链接', (j) => j.url],
  ];
  const head = cols.map((c) => csvCell(c[0])).join(',');
  const rows = items.map((j) => cols.map((c) => csvCell(c[1](j))).join(','));
  return [head, ...rows].join('\r\n');
}

function joinList(x) {
  return Array.isArray(x) ? x.filter(Boolean).join('、') : x == null ? '' : String(x);
}
// 活跃描述是相对时间（如「3日内活跃」），附上观测时刻才有意义
function hrActiveTitle(job) {
  return job.hrActiveAt ? `观测于 ${fmtTime(job.hrActiveAt)}` : '';
}
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 单元格内换行/逗号/引号：用双引号包裹并转义内部引号
  return `"${s.replace(/"/g, '""')}"`;
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

function opt(v, label) {
  const o = document.createElement('option');
  o.value = v;
  o.textContent = label;
  return o;
}

boot();
