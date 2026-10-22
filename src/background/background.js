// Service Worker：消息路由 + 岗位收录 + AI 调用编排 + 上下文追踪。
import { MSG, MODE, PLATFORM_META } from '../common/constants.js';
import {
  normalizeResponse, platformOfHost, matchPlatformApi, extractBossContacts, buildContactIndex, contactStatus,
} from '../common/platforms.js';
import {
  loadJobs, mergeJobs, patchJob, markJobs, pickJobsNeedingDetail, bossDetailPageUrl, isDetailReady, deleteJob, clearJobs, toggleStar, setJobMatch, setJobGreeting,
  getMatchCache, putMatchCache, clearMatchCache,
  loadBlocked, blockJobs, unblockJob, clearBlocked, loadContacts, addContacts, clearContacts,
  markJobsContacted, removeContacts,
} from '../common/jobsStore.js';
import { insertDetailTask, taskTier } from '../common/pacing.js';
import { runInBackgroundTab, tabTaskOf, isWorkerTab, reportWorkerResult, getHalt, clearHalt, isLoginHalt, setCapBypass } from './tabWorker.js';
import {
  loadSettings, saveSettings, loadProviders, saveProviders, getActiveProvider,
} from '../common/settingsStore.js';
import { loadProfile, saveProfile, clearProfile, sanitizeProfile } from '../common/profile.js';
import { sanitizeProvider } from '../common/ai/providers.js';
import { chat, chatJson, testProvider, listModels } from '../common/ai/client.js';
import {
  buildResumeExtractPrompt, buildMatchPrompt, buildGreetingPrompt, sanitizeMatch, buildTailorResumePrompt, sanitizeTailor, scoreToVerdict,
  normalizeGreetings, promptText, PROMPT_VERSION,
} from '../common/ai/prompts.js';
import { activityPenalty, activitySortKey, hrActivityTier } from '../common/activity.js';
import { evaluateJob } from '../common/filters.js';
import { redactText } from '../common/ai/privacy.js';

// 记录每个 tab 当前所处平台，供 UI 查询「当前站点」
const tabContext = new Map();

// —— 侧边栏：点击工具栏图标即打开 ——
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

// —— 统一消息入口 ——
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  handle(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 异步响应
});

async function handle(msg, sender) {
  switch (msg.type) {
    // ---------- 岗位数据流 ----------
    case MSG.JOBS_CAPTURED:
      return onJobsCaptured(msg, sender);
    case MSG.JOB_LIST_REQUEST:
      return loadJobs();
    case MSG.JOB_DELETE:
      return afterJobsChange(await deleteJob(msg.uid));
    case MSG.JOB_CLEAR_REQUEST:
      return afterJobsChange(await clearJobs());
    case MSG.JOB_STAR_TOGGLE:
      return afterJobsChange(await toggleStar(msg.uid));
    case MSG.JOB_EXPORT_REQUEST:
      return exportJobs(msg.format);
    case MSG.GREETING_SAVE:
      return afterJobsChange(await setJobGreeting(msg.uid, msg.text));
    case MSG.JOB_MARK:
      return afterJobsChange(await markJobs(Array.isArray(msg.uids) ? msg.uids : [msg.uid], { viewed: msg.viewed, dismissed: msg.dismissed }));

    // ---------- 屏蔽 ----------
    case MSG.JOB_BLOCK: {
      const { jobs: list, blocked } = await blockJobs(Array.isArray(msg.uids) ? msg.uids : [msg.uid]);
      afterJobsChange(list);
      broadcast(MSG.CONTACTS_UPDATED, {});
      return { jobs: list, blocked };
    }
    case MSG.JOB_UNBLOCK:
      return unblockJob(msg.uid);
    case MSG.BLOCKED_GET:
      return loadBlocked();
    case MSG.BLOCKED_CLEAR:
      return clearBlocked();

    // ---------- 已沟通 ----------
    case MSG.CONTACTS_CAPTURED:
      return onContactsCaptured(msg);
    case MSG.CONTACTS_GET:
      return contactsOverview();
    case MSG.CONTACTS_CLEAR:
      afterJobsChange(await clearContacts());
      return contactsOverview();
    case MSG.CONTACTS_MARK: {
      const { jobs: list, added } = await markJobsContacted(Array.isArray(msg.uids) ? msg.uids : [msg.uid]);
      if (list) afterJobsChange(list);
      broadcast(MSG.CONTACTS_UPDATED, { added });
      return { jobs: list || (await loadJobs()), added };
    }
    case MSG.CONTACTS_REMOVE: {
      const { jobs: list } = await removeContacts(Array.isArray(msg.keys) ? msg.keys : [msg.key]);
      afterJobsChange(list);
      broadcast(MSG.CONTACTS_UPDATED, {});
      return contactsOverview();
    }
    case MSG.CONTACTS_SYNC:
      return syncContacts({ force: true, windowId: msg.windowId });
    case MSG.AUTO_STATUS_GET:
      return fullAutoStatus();
    case MSG.WORKER_HALT_CLEAR:
      // 用户手动继续：除了解除熔断，本轮也不再被额度 / 时段挂起
      await setCapBypass(true);
      await clearHalt();
      await resumeDetails();
      return contactsOverview();

    // ---------- 后台标签页 ----------
    case MSG.TAB_ROLE:
      return sender.tab ? tabTaskOf(sender.tab.id) : { role: null };
    case MSG.WORKER_RESULT:
      if (sender.tab) reportWorkerResult(sender.tab.id, msg);
      return { ok: true };

    // ---------- 页面上下文 ----------
    case MSG.PAGE_CONTEXT_CHANGED:
      if (sender.tab && sender.tab.id != null) {
        const prev = tabContext.get(sender.tab.id) || {};
        tabContext.set(sender.tab.id, {
          platform: msg.platform,
          url: msg.url,
          // URL 能识别到岗位就用它；否则（如列表页详情抽屉不改 URL）保留上次 CURRENT_JOB 记下的
          jobKey: msg.jobKey || prev.jobKey || null,
          isChat: !!msg.isChat,
          at: Date.now(),
        });
      }
      return { ok: true };
    case MSG.CURRENT_JOB:
      if (sender.tab && sender.tab.id != null && !isWorkerTab(sender.tab.id)) {
        const prev = tabContext.get(sender.tab.id) || {};
        tabContext.set(sender.tab.id, {
          ...prev,
          platform: msg.platform || prev.platform,
          jobKey: msg.jobKey,
          at: Date.now(),
        });
        // 实时推给面板：让「当前岗位」跟随网站上点开的岗位切换
        broadcast(MSG.CURRENT_JOB, { tabId: sender.tab.id, platform: msg.platform, jobKey: msg.jobKey });
        markViewedOnPage(msg.platform, msg.jobKey).catch(() => {});
      }
      return { ok: true };
    case MSG.ACTIVE_CONTEXT_REQUEST:
      return getActiveContext();

    // ---------- 发送招呼语 ----------
    case MSG.SEND_GREETING:
      return sendGreetingToChat(msg.text, msg.platform, msg.url);
    case MSG.OPEN_JOB_CHAT: {
      const r = await openJobChat(msg.text, msg.platform, msg.url);
      if (msg.uid) await recordGreeted(msg.uid); // 通过插件打过招呼 = 已沟通
      return r;
    }

    // ---------- 设置 ----------
    case MSG.SETTINGS_GET:
      return loadSettings();
    case MSG.SETTINGS_SAVE:
      return saveSettings(msg.patch || {});

    // ---------- 画像 ----------
    case MSG.PROFILE_GET:
      return loadProfile();
    case MSG.PROFILE_SAVE:
      return saveProfile(msg.profile);
    case MSG.PROFILE_CLEAR:
      await clearMatchCache(); // 画像清空后匹配缓存失效
      return clearProfile();

    // ---------- AI 供应商 ----------
    case MSG.AI_PROVIDERS_GET:
      return loadProviders();
    case MSG.AI_PROVIDERS_SAVE:
      return saveProviders(msg.providers);
    case MSG.AI_PROVIDER_TEST:
      return testProvider(sanitizeProvider(msg.provider));
    case MSG.AI_PROVIDER_MODELS:
      return listModels(sanitizeProvider(msg.provider));

    // ---------- AI 能力 ----------
    case MSG.AI_RESUME_EXTRACT:
      return extractResume(msg.text);
    case MSG.AI_MATCH_SCORE:
      return scoreOne(msg.uid, msg.job, { force: msg.force, requireDetail: !!msg.requireDetail });
    case MSG.BATCH_START:
    case MSG.AI_MATCH_BATCH:
      return startBatch(msg.uids, { force: !!msg.force });
    case MSG.BATCH_STATUS:
      return batchStatus();
    case MSG.BATCH_CANCEL:
      return cancelBatch();
    case MSG.AI_TAILOR_RESUME:
      return tailorResume(msg.uid, msg.job);
    case MSG.AI_GREETING:
      return generateGreetings(msg.uid, { force: !!msg.force });
    case MSG.AI_USAGE_GET:
      return getUsage();
    case MSG.AI_USAGE_RESET:
      return resetUsage();

    // ---------- 面板控制 ----------
    case MSG.OPEN_OPTIONS:
      await openOptions(msg.section);
      return { ok: true };

    default:
      throw new Error(`未知消息类型：${msg.type}`);
  }
}

// —— 岗位收录 ——
async function onJobsCaptured(msg, sender) {
  const settings = await loadSettings();
  if (!settings.autoCapture) return { added: 0, updated: 0, skipped: true };
  const jobs = normalizeResponse(msg.platform, msg.payload, { url: msg.url, jobKey: msg.jobKey });
  if (!jobs.length) return { added: 0, updated: 0 };

  // 屏蔽名单：永远不收录；已沟通：不新增（库里已有的照常更新并打标）
  const [blockedList, contacts] = await Promise.all([loadBlocked(), loadContacts()]);
  const blocked = new Set(blockedList.map((b) => b.uid));
  const idx = buildContactIndex(contacts);
  // 只在判定出已沟通时写入：详情等残缺数据（无公司名）判不出来，不能抹掉库里已有的标记
  for (const j of jobs) {
    const st = contactStatus(j, idx);
    if (st) j.contacted = st;
    else delete j.contacted;
  }
  const accept = (raw, prev) => {
    if (blocked.has(raw.uid)) return false;
    if (prev || !settings.skipContacted) return true;
    if (raw.contacted === 'job') return false;
    return !(raw.contacted === 'company' && settings.skipContactedCompanies);
  };
  const { jobs: all, added, updated, skipped, readyUids } = await mergeJobs(jobs, {
    dedupe: settings.dedupe,
    maxJobs: settings.maxJobs,
    accept,
  });
  broadcast(MSG.JOBS_UPDATED, { count: all.length, added, updated, skipped });

  const api = matchPlatformApi(msg.url || '', msg.platform);
  const isBossList = api && api.platform === 'boss' && api.kind === 'list';
  // 已沟通记录超过 12 小时没同步：先在后台打开一次沟通页
  if (isBossList && settings.skipContacted && settings.mode !== MODE.qcwy) syncContacts({ windowId: sender.tab && sender.tab.windowId }).catch(() => {});

  // 自动匹配（可选）：只对「详情就绪」的岗位——BOSS 必须先拿到 JD 与 HR 活跃。
  // 列表刚收录的 BOSS 岗位此时还没详情，不会进来；等后台详情页读完、再次走到这里时才触发。
  batchOnReady(readyUids); // 批量分析中的岗位：详情一就绪就立即匹配
  // 自动进入下一步：有岗位详情就绪就去扫一遍「已就绪、未分析」的岗位接着分析
  if (settings.autoScore && readyUids.length) kickAutoScore();
  // BOSS 列表接口不含 JD 与 HR 活跃时间：在后台标签页逐个打开详情页补全。
  // 开了自动匹配也必须补详情，否则这些岗位永远不会被自动匹配。
  if ((settings.autoFetchDetail || settings.autoScore) && isBossList) {
    const need = pickJobsNeedingDetail(all, jobs.map((j) => j.uid));
    if (need.length) enqueueDetails(need, sender.tab);
  }
  return { added, updated, skipped, total: all.length };
}

// ============ 详情补全队列（后台标签页） ============
const detailQueue = []; // { uid, jobId, url }
const detailQueued = new Set();
const detailWaiters = new Map(); // uid -> [resolve]
let detailRunning = false;
let detailDone = 0;
let detailHalted = ''; // 非空 = 补全已挂起（原因）：队列保留，到 detailResumeAt 自动继续
let detailResumeAt = 0;
let progressTab = null; // 最近一次触发补全的列表页标签：给它的角标推进度

// 队列分三档（见 pacing.insertDetailTask）：urgent 不休息、间隔较短；batch 与普通一样按人工节奏，只是排在普通前面。
const tierOf = taskTier;

function enqueueDetails(items, tab, { front = false, batch = false } = {}) {
  if (tab && tab.id != null && !isWorkerTab(tab.id)) progressTab = tab;
  for (const it0 of items) {
    if (!it0 || !it0.url) continue;
    const it = { ...it0, urgent: front || undefined, batch: batch || undefined };
    // 已登记但不在队列里 = 正在处理中，不重复加
    if (detailQueued.has(it.uid) && !detailQueue.some((x) => x.uid === it.uid)) continue;
    detailQueued.add(it.uid);
    insertDetailTask(detailQueue, it);
  }
  if (detailHalted) persistDetailQueue();
  pushProgress();
  runDetailQueue();
}

// ============ 批量分析（后台流水线） ============
// 勾选的岗位里：详情已就绪的立即排进匹配；未就绪的 BOSS 岗位排进补全队列（批量档，人工节奏），
// 哪个详情一读完就马上匹配哪个，不必等全部补完再统一跑。补不上详情的跳过，绝不拿列表摘要凑合。
let batch = null; // { id, uids[], state: Map uid->'detail'|'queued'|'scoring'|'ok'|'fail'|'skipped', reasons: Map, force, firstErr, aborted, scoredAny }
const batchScoreQueue = [];
let batchScoring = false;

async function startBatch(uids, { force = false } = {}) {
  if (batch && batchActive()) throw new Error('已有批量分析在进行中');
  const list = Array.from(new Set(Array.isArray(uids) ? uids : []));
  batch = { id: Date.now(), uids: list, state: new Map(), reasons: new Map(), force, firstErr: '', aborted: '', scoredAny: false };
  batchScoreQueue.length = 0;
  const jobs = new Map((await loadJobs()).map((j) => [j.uid, j]));
  const needDetail = [];
  for (const uid of list) {
    const job = jobs.get(uid);
    if (!job) batchSkip(uid, '岗位已不在库中');
    else if (job.contacted) batchSkip(uid, '已沟通');
    else if (isDetailReady(job)) batchQueueScore(uid);
    else if (job.platform === 'boss' && bossDetailPageUrl(job)) {
      batch.state.set(uid, 'detail');
      needDetail.push({ uid, jobId: job.jobId, url: bossDetailPageUrl(job) });
    } else batchSkip(uid, '缺少岗位详情');
  }
  if (needDetail.length) {
    // 用户主动发起批量：「未登录」熔断可能是登录前留下的，先解除再试，仍未登录会重新熔断
    if (isLoginHalt(await getHalt())) {
      await clearHalt();
      await resumeDetails();
    }
    // 其他原因暂停中也照样排进去：挂起期间保持「待补详情」，恢复后接着补
    enqueueDetails(needDetail, null, { batch: true });
  }
  saveBatchSoon();
  return batchStatus();
}

// 批量进度存到 storage.session：后台被 Chrome 回收（侧边栏关着、补详情挂起时常见）后能接着跑
const BATCH_KEY = 'jobHelperBatchV1';
let batchSaveTimer = null;
function saveBatchSoon() {
  clearTimeout(batchSaveTimer);
  batchSaveTimer = setTimeout(saveBatch, 300);
}
async function saveBatch() {
  try {
    if (!batch) await chrome.storage.session.remove(BATCH_KEY);
    else await chrome.storage.session.set({ [BATCH_KEY]: { ...batch, state: [...batch.state], reasons: [...batch.reasons] } });
  } catch {}
}

// 后台启动时恢复：分析到一半被打断的重新排队；等详情的若不在补全队列里就重新排进去
async function restoreBatch() {
  let saved = null;
  try {
    saved = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || null;
  } catch {}
  if (batch || !saved || !Array.isArray(saved.uids)) return;
  batch = { ...saved, state: new Map(saved.state || []), reasons: new Map(saved.reasons || []) };
  if (!batchActive()) return;
  const jobs = new Map((await loadJobs()).map((j) => [j.uid, j]));
  const needDetail = [];
  for (const uid of batch.uids) {
    const st = batch.state.get(uid);
    const job = jobs.get(uid);
    if (st === 'queued' || st === 'scoring' || (st === 'detail' && job && isDetailReady(job))) {
      batch.state.set(uid, 'queued');
      batchScoreQueue.push(uid);
    } else if (st === 'detail' && !detailQueued.has(uid)) {
      if (job && bossDetailPageUrl(job)) needDetail.push({ uid, jobId: job.jobId, url: bossDetailPageUrl(job) });
      else batchSkip(uid, '缺少岗位详情');
    }
  }
  if (batchScoreQueue.length) runBatchScore();
  if (needDetail.length) enqueueDetails(needDetail, null, { batch: true });
  saveBatchSoon();
}

// 该岗位是否由正在进行的批量分析负责（排队补详情 / 待分析 / 分析中）
function inActiveBatch(uid) {
  return !!batch && !batch.aborted && ['detail', 'queued', 'scoring'].includes(batch.state.get(uid));
}

function batchActive() {
  if (!batch || batch.aborted) return false;
  return batch.uids.some((u) => ['detail', 'queued', 'scoring'].includes(batch.state.get(u)));
}

function batchSkip(uid, reason) {
  if (!batch) return;
  batch.state.set(uid, 'skipped');
  batch.reasons.set(uid, reason);
  saveBatchSoon();
}

function batchQueueScore(uid) {
  if (!batch || batch.aborted) return;
  const st = batch.state.get(uid);
  if (st === 'queued' || st === 'scoring' || st === 'ok' || st === 'fail') return;
  batch.state.set(uid, 'queued');
  batchScoreQueue.push(uid);
  saveBatchSoon();
  if (batchScoring) wakeBatch(); else runBatchScore();
}

// 收录合并后发现某岗位详情就绪：属于当前批量的，立即排进匹配
function batchOnReady(uids) {
  if (!batch || batch.aborted) return;
  for (const u of uids) if (batch.state.get(u) === 'detail') batchQueueScore(u);
}

// 补全队列处理完某岗位（成功 / 失败 / 被清空）：稍等收录合并落盘，仍未就绪则跳过
function batchOnDetailDone(uid, reason) {
  if (!batch || batch.state.get(uid) !== 'detail') return;
  const id = batch.id;
  setTimeout(async () => {
    if (!batch || batch.id !== id || batch.state.get(uid) !== 'detail') return;
    const job = (await loadJobs()).find((j) => j.uid === uid);
    if (job && isDetailReady(job)) batchQueueScore(uid);
    else batchSkip(uid, reason || '详情读取失败');
  }, 3000);
}

// 并发：同时最多 aiConcurrency 个；有新岗位排进来且有空位时立即补位
let batchWake = null;
function wakeBatch() {
  if (batchWake) batchWake();
}
async function runBatchScore() {
  if (batchScoring) return;
  batchScoring = true;
  const inflight = new Set();
  try {
    for (;;) {
      // 和自动分析一样先试探：本批还没成功过就只发 1 个
      const limit = batch && batch.scoredAny ? (await loadSettings()).aiConcurrency || 1 : 1;
      while (batchScoreQueue.length && batch && !batch.aborted && inflight.size < limit) {
        const uid = batchScoreQueue.shift();
        const task = batchScoreOne(uid).finally(() => inflight.delete(task));
        inflight.add(task);
        await sleep(300); // 错开发出
      }
      if (!inflight.size) break;
      await Promise.race([...inflight, new Promise((r) => { batchWake = r; })]);
      batchWake = null;
    }
  } finally {
    batchScoring = false;
    batchWake = null;
  }
}

async function batchScoreOne(uid) {
  if (!batch) return;
  const b = batch;
  b.state.set(uid, 'scoring');
  saveBatchSoon();
  try {
    await withKeepAlive(scoreOne(uid, null, { force: b.force, requireDetail: true }));
    b.state.set(uid, 'ok');
    b.scoredAny = true;
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    b.state.set(uid, 'fail');
    b.reasons.set(uid, em);
    if (!b.firstErr) b.firstErr = em;
    // 一个都还没成功就失败：多半是供应商 / 画像 / 网络配置问题，后面必然全挂，中止整批
    if (!b.scoredAny && !b.aborted) {
      b.aborted = `分析失败：${em}`;
      stopBatchDetails();
    }
  } finally {
    if (b === batch) saveBatchSoon();
  }
}

// 把本批还在排队补详情的岗位撤出补全队列
function stopBatchDetails() {
  if (!batch) return;
  for (let i = detailQueue.length - 1; i >= 0; i--) {
    const it = detailQueue[i];
    if (it.batch && batch.state.get(it.uid) === 'detail') {
      detailQueue.splice(i, 1);
      detailQueued.delete(it.uid);
      resolveDetailWaiters(it.uid);
    }
  }
  for (const u of batch.uids) if (['detail', 'queued'].includes(batch.state.get(u))) batchSkip(u, '已停止');
  batchScoreQueue.length = 0;
  persistDetailQueue();
}

function cancelBatch() {
  if (batch && batchActive()) {
    batch.aborted = '已手动停止';
    stopBatchDetails();
    saveBatchSoon();
  }
  return batchStatus();
}

function batchStatus() {
  if (!batch) return { running: false, total: 0 };
  const count = (k) => batch.uids.filter((u) => batch.state.get(u) === k).length;
  const skippedReasons = {};
  for (const u of batch.uids) {
    if (batch.state.get(u) !== 'skipped') continue;
    const r = batch.reasons.get(u) || '未知';
    skippedReasons[r] = (skippedReasons[r] || 0) + 1;
  }
  return {
    id: batch.id,
    running: batchActive(),
    total: batch.uids.length,
    detail: count('detail'),
    queued: count('queued'),
    scoring: count('scoring'),
    ok: count('ok'),
    fail: count('fail'),
    skipped: count('skipped'),
    skippedReasons,
    // 补全挂起中、且本批还有岗位在等详情：界面显示暂停原因与恢复按钮
    paused: detailHalted && count('detail') ? detailHalted : '',
    resumeAt: detailResumeAt,
    firstErr: batch.firstErr,
    aborted: batch.aborted,
    // 仍在进行中的岗位（UI 显示转圈）
    pendingUids: batch.uids.filter((u) => ['detail', 'queued', 'scoring'].includes(batch.state.get(u))),
  };
}

// 并发处理：最多 detailConcurrency 个同时在补（tabWorker 里还会把「打开」错开）；
// 有一个补完、或有新岗位排进来，就立即补位。
let wakeDetail = null;
async function runDetailQueue() {
  if (detailRunning) {
    if (wakeDetail) wakeDetail();
    return;
  }
  detailRunning = true;
  const state = { noJd: 0, timeouts: 0 };
  const inflight = new Set();
  try {
    for (;;) {
      const limit = Math.max(1, (await loadSettings()).pacing.detailConcurrency);
      // 挂起时不再打开新的，只放行用户点分析插队的（urgent 排在最前）
      while (detailQueue.length && (!detailHalted || detailQueue[0].urgent) && inflight.size < limit + (detailQueue[0].urgent ? 1 : 0)) {
        const it = pickNextDetail();
        const task = processDetail(it, state).finally(() => inflight.delete(task));
        inflight.add(task);
      }
      if (!inflight.size) break;
      await Promise.race([...inflight, new Promise((r) => { wakeDetail = r; })]);
      wakeDetail = null;
    }
  } finally {
    detailRunning = false;
    wakeDetail = null;
    if (!detailQueue.length) setCapBypass(false); // 手动继续的这一轮补完了，恢复正常额度
    pushProgress();
  }
}

// 用户等着要的先处理；其余在同档的前几个里随机挑，不严格按列表顺序一个个点
function pickNextDetail() {
  const tier = tierOf(detailQueue[0]);
  let sameTier = 0;
  while (sameTier < detailQueue.length && tierOf(detailQueue[sameTier]) === tier) sameTier++;
  const pick = tier === 0 ? 0 : Math.floor(Math.random() * Math.min(3, sameTier));
  return detailQueue.splice(pick, 1)[0];
}

// 自动补全（非用户点击、非批量）只在用户正看着 BOSS 时进行：切到 51job 等其他站点就不再
// 打开 BOSS 后台标签页。被跳过的岗位下次浏览 BOSS 列表时会重新排队。
async function userOnBoss() {
  try {
    if ((await loadSettings()).mode === MODE.qcwy) return false;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return !!tab && platformOfHost(new URL(tab.url || '').hostname) === 'boss';
  } catch {
    return false;
  }
}

async function processDetail(it, state) {
  if (!it.urgent && !it.batch && !(await userOnBoss())) {
    detailQueued.delete(it.uid);
    resolveDetailWaiters(it.uid, '');
    pushProgress();
    return;
  }
  const res = await runInBackgroundTab(it.url, 'detail', {
    timeoutMs: 30000,
    windowId: progressTab ? progressTab.windowId : undefined,
    urgent: !!it.urgent,
  });
  if (res.skipped || res.haltReason) {
    // 没读成是因为被拦（熔断 / 额度 / 时段 / 登录页 / 验证页），不是这个岗位的问题：放回队列，挂起等恢复
    insertDetailTask(detailQueue, it);
    await suspendDetails(res.skipped || res.haltReason, res.retryMs);
    return;
  }
  detailQueued.delete(it.uid);
  // 读取失败的原因分开记：超时多半是网络慢，读不到 JD 多半是页面结构变了
  resolveDetailWaiters(it.uid, res.ok ? '' : res.timeout ? '详情页加载超时' : res.closed ? '详情页被关闭' : '详情页读不到岗位描述');
  if (res.ok) {
    state.noJd = 0;
    state.timeouts = 0;
    detailDone++;
    if (detailHalted) resumeDetails(); // 插队的读成功了，说明已经不再被拦
  } else if (res.timeout) {
    // 同时开着几个页面时，网络一卡会一起超时：门槛随并发数放宽，避免一次卡顿就整体暂停
    const limit = 2 * Math.max(1, (await loadSettings()).pacing.detailConcurrency) + 1;
    if (++state.timeouts >= limit) await suspendDetails(`详情页连续 ${limit} 次加载超时（网络慢？），已暂停补全`, 10 * 60 * 1000);
  } else if (res.noJd) {
    if (++state.noJd >= 3) await suspendDetails('详情页连续 3 次读不到岗位描述（页面结构可能变了），已暂停补全', 15 * 60 * 1000);
  }
  // 用户自己关掉了后台标签页（closed）等：不计入失败
  pushProgress();
}

// 挂起补全：队列保留（存到 storage.session，后台被回收也不丢），到时间由闹钟恢复。
// 有熔断就等熔断结束；其他原因（时段 / 额度 / 空闲 / 连续失败）过 ms 后再试，试的时候被拦不会打开页面。
const DETAIL_RESUME_ALARM = 'jh-detail-resume';
const DETAIL_QUEUE_KEY = 'jobHelperDetailQueueV1';
async function suspendDetails(reason, ms = 10 * 60 * 1000) {
  detailHalted = reason;
  const halt = await getHalt();
  detailResumeAt = halt ? halt.until : Date.now() + ms;
  // 用户点分析插队的等不了这么久：立即结束等待，让界面马上看到原因
  for (let i = detailQueue.length - 1; i >= 0; i--) {
    const x = detailQueue[i];
    if (!x.urgent) continue;
    detailQueue.splice(i, 1);
    detailQueued.delete(x.uid);
    resolveDetailWaiters(x.uid);
  }
  try {
    chrome.alarms.create(DETAIL_RESUME_ALARM, { when: detailResumeAt + 1000 });
  } catch {}
  await persistDetailQueue();
  pushProgress();
}

async function resumeDetails() {
  try {
    await chrome.alarms.clear(DETAIL_RESUME_ALARM);
  } catch {}
  await restoreDetailQueue();
  detailHalted = '';
  detailResumeAt = 0;
  await persistDetailQueue();
  pushProgress();
  if (detailQueue.length) runDetailQueue();
}

async function persistDetailQueue() {
  try {
    if (detailHalted && detailQueue.length) {
      await chrome.storage.session.set({ [DETAIL_QUEUE_KEY]: { items: detailQueue, reason: detailHalted, resumeAt: detailResumeAt } });
    } else {
      await chrome.storage.session.remove(DETAIL_QUEUE_KEY);
    }
  } catch {}
}

// 后台重启后把挂起的队列读回内存，返回存的挂起信息
async function restoreDetailQueue() {
  let saved = null;
  try {
    saved = (await chrome.storage.session.get(DETAIL_QUEUE_KEY))[DETAIL_QUEUE_KEY] || null;
  } catch {}
  for (const it of (saved && Array.isArray(saved.items) ? saved.items : [])) {
    if (!it || !it.uid || !it.url || detailQueued.has(it.uid)) continue;
    detailQueued.add(it.uid);
    insertDetailTask(detailQueue, it);
  }
  return saved;
}

try {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === DETAIL_RESUME_ALARM) resumeDetails().catch(() => {});
  });
} catch {}
// 后台（重新）启动：先读回挂起的补全队列与批量进度；还没到恢复时间就继续挂着，到了就接着补
(async () => {
  const saved = await restoreDetailQueue();
  const suspended = !!saved && detailQueue.length > 0 && saved.resumeAt > Date.now();
  if (suspended) {
    detailHalted = saved.reason || '详情补全已暂停';
    detailResumeAt = saved.resumeAt;
    try {
      chrome.alarms.create(DETAIL_RESUME_ALARM, { when: detailResumeAt + 1000 });
    } catch {}
  }
  await restoreBatch(); // 在挂起状态定下之后：它补排的详情任务要服从挂起
  if (saved && detailQueue.length && !suspended) await resumeDetails();
})().catch(() => {});

function resolveDetailWaiters(uid, reason = detailHalted) {
  batchOnDetailDone(uid, reason);
  const list = detailWaiters.get(uid);
  if (!list) return;
  detailWaiters.delete(uid);
  list.forEach((r) => r());
}

// ============ 自动分析 ============
// 待分析列表不放在内存里，而是每次从岗位库算出来：详情已就绪、还没分析、未沟通、未被本地筛选剔除的岗位。
// 这样插件后台被 Chrome 回收（空闲 30 秒、或 AI 请求太久）后也不会丢——每分钟的闹钟和后台启动时都会接着跑。
// 串行执行，HR 最活跃的先分析；同一岗位连续失败 AUTO_MAX_FAILS 次后不再自动重试（可手动分析）。
const AUTO_MAX_FAILS = 2;
const AUTO_ALARM = 'jh-auto-score';
let autoRunning = false;
let autoStatus = { running: false, pending: 0, done: 0, lastError: '', lastErrorAt: 0 };

function setAutoStatus(patch) {
  autoStatus = { ...autoStatus, ...patch };
  broadcast(MSG.AUTO_STATUS, { status: fullAutoStatus() });
}

// 给侧边栏的状态：自动分析进度 + 后台补详情（是否挂起、原因、何时自动继续），挂起提示不只在批量分析时显示
function fullAutoStatus() {
  return { ...autoStatus, detail: { running: detailRunning, pending: detailQueue.length, halted: detailHalted, resumeAt: detailResumeAt } };
}

// 在网站上打开了某个已收录岗位 = 看过。只记第一次，避免每次切换都写库
async function markViewedOnPage(platform, jobKey) {
  if (!platform || !jobKey) return;
  const uid = `${platform}:${jobKey}`;
  const job = (await loadJobs()).find((j) => j.uid === uid);
  if (job && !job.viewedAt) afterJobsChange(await markJobs([uid], { viewed: true }));
}

function autoCandidates(jobs, settings) {
  return jobs.filter(
    (j) =>
      isDetailReady(j) &&
      !j.match &&
      !j.contacted &&
      !j.dismissedAt && // 标了不感兴趣的不花 AI 调用；恢复后会重新进入候选
      (j.autoScoreFails || 0) < AUTO_MAX_FAILS &&
      !inActiveBatch(j.uid) && // 正在批量分析里的交给批量，避免同一岗位分析两次
      !scoringInFlight.has(j.uid) &&
      (!settings.filters.enabled || evaluateJob(j, settings.filters).keep),
  );
}

const kickAutoScore = debounce(() => {
  if (autoRunning) {
    if (autoWake) autoWake();
    return;
  }
  runAutoScore().catch(() => {});
}, 800);

let autoPausedUntil = 0;
let autoWake = null; // 运行中有新岗位就绪时唤醒，空位立即补上
// 并发：同时最多 aiConcurrency 个分析在跑；每完成一个就重新从岗位库算候选、补位（新就绪的岗位能马上插进来）
async function runAutoScore() {
  if (autoRunning || Date.now() < autoPausedUntil) return;
  autoRunning = true;
  const inflight = new Map(); // uid -> Promise
  const runStartDone = autoStatus.done;
  try {
    for (;;) {
      const [jobs, settings, provider] = await Promise.all([loadJobs(), loadSettings(), getActiveProvider()]);
      if (!settings.autoScore || !provider) break;
      if (Date.now() < autoPausedUntil) break; // 某个请求遇到鉴权 / 限流，停止补位（进行中的照常完成）
      const cands = autoCandidates(jobs, settings).filter((j) => !inflight.has(j.uid));
      cands.sort((a, b) => activitySortKey(a) - activitySortKey(b)); // HR 最活跃的先分析
      setAutoStatus({ running: cands.length + inflight.size > 0, pending: cands.length + inflight.size });
      // 先试探：本轮还没有成功过就只发 1 个，成功后再放开到并发上限——Key 无效时只白费 1 次请求而不是 N 次
      const limit = autoStatus.done > runStartDone ? settings.aiConcurrency || 1 : 1;
      const toStart = cands.slice(0, Math.max(0, limit - inflight.size));
      for (const job of toStart) {
        const task = autoScoreOne(job).finally(() => inflight.delete(job.uid));
        inflight.set(job.uid, task);
        await sleep(300); // 错开发出，避免同一瞬间打满供应商
      }
      // 注意：错开的这段时间里刚发出的请求可能已经完成，inflight 为空不代表没活了——只有既没发新的也没在跑的才结束
      if (!toStart.length && !inflight.size) break;
      if (!inflight.size) continue;
      await Promise.race([...inflight.values(), new Promise((r) => { autoWake = r; })]);
      autoWake = null;
    }
    await Promise.allSettled(inflight.values());
  } finally {
    autoRunning = false;
    autoWake = null;
    setAutoStatus({ running: false, pending: 0 });
  }
}

async function autoScoreOne(job) {
  try {
    await withKeepAlive(scoreOne(job.uid, job, { requireDetail: true }));
    setAutoStatus({ done: autoStatus.done + 1, lastError: '' });
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    setAutoStatus({ lastError: em, lastErrorAt: Date.now() });
    // 鉴权 / 额度 / 限流：不是这个岗位的问题，不记失败次数；暂停一段时间再试，避免白白请求
    if (/429|rate.?limit|频繁|限流/i.test(em)) {
      autoPausedUntil = Date.now() + 2 * 60 * 1000;
      return;
    }
    if (/401|402|403|invalid.*key|api.?key|余额|额度|quota|未配置|unauthori/i.test(em)) {
      autoPausedUntil = Date.now() + 10 * 60 * 1000;
      return;
    }
    // 其他错误（如模型输出无法解析）记到岗位上，连续失败到上限后不再自动重试
    const cur = (await loadJobs()).find((j) => j.uid === job.uid);
    await patchJob(job.uid, { autoScoreFails: ((cur && cur.autoScoreFails) || 0) + 1, autoScoreError: em });
  }
}

// AI 请求期间每 20 秒调一次扩展 API，重置 Service Worker 的空闲计时，避免请求还没返回后台就被回收
function withKeepAlive(promise) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return promise.finally(() => clearInterval(t));
}

// 每分钟兜底一次；后台（重新）启动时也接着跑
try {
  chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === AUTO_ALARM) kickAutoScore();
  });
} catch {}
setTimeout(() => kickAutoScore(), 3000);

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// 匹配前确保详情就绪（JD + HR 活跃）：未就绪时插队打开详情页，等它读完（最多 60 秒）
async function ensureDetail(job) {
  if (!job || job.platform !== 'boss' || isDetailReady(job)) return;
  const url = bossDetailPageUrl(job);
  if (!url) return;
  const halt = await getHalt();
  if (halt && !isLoginHalt(halt)) return; // 「未登录」不拦：插队任务是 urgent，会打开一次重试
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 60000);
    const list = detailWaiters.get(job.uid) || [];
    list.push(() => { clearTimeout(timer); resolve(); });
    detailWaiters.set(job.uid, list);
    enqueueDetails([{ uid: job.uid, jobId: job.jobId, url }], null, { front: true });
  });
}

// 用户在自己的标签页里从 BOSS 登录页跳走（登录完成），立即解除「未登录」熔断
const loginPageTabs = new Set();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || isWorkerTab(tabId)) return;
  let u;
  try { u = new URL(info.url); } catch { return; }
  if (!/(^|\.)zhipin\.com$/.test(u.hostname)) {
    loginPageTabs.delete(tabId);
    return;
  }
  if (/^\/web\/user\/?$/.test(u.pathname)) {
    loginPageTabs.add(tabId);
    return;
  }
  if (!loginPageTabs.delete(tabId)) return;
  getHalt().then(async (h) => {
    if (!isLoginHalt(h)) return;
    await clearHalt();
    await resumeDetails();
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => loginPageTabs.delete(tabId));

function pushProgress() {
  broadcast(MSG.AUTO_STATUS, { status: fullAutoStatus() });
  if (!progressTab || progressTab.id == null) return;
  chrome.tabs
    .sendMessage(progressTab.id, { type: MSG.DETAIL_PROGRESS, done: detailDone, pending: detailQueue.length, halted: detailHalted, resumeAt: detailResumeAt })
    .catch(() => {});
}

// ============ 已沟通记录 ============
const CONTACTS_SYNC_KEY = 'jobHelperContactsSyncAtV1';
const CONTACTS_SYNC_NEXT_KEY = 'jobHelperContactsNextSyncV1';
// 同步间隔 9–15 小时随机，不固定在整 12 小时
const nextSyncDelayMs = () => (9 + Math.random() * 6) * 3600 * 1000;
const BOSS_CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
let contactsSyncing = null;

async function onContactsCaptured(msg) {
  const entries = Array.isArray(msg.entries) ? msg.entries : extractBossContacts(msg.payload);
  if (!entries.length) return { added: 0 };
  const { added, jobs } = await addContacts(entries, 'chat');
  if (jobs) afterJobsChange(jobs);
  if (added) broadcast(MSG.CONTACTS_UPDATED, { added });
  return { added };
}

// 后台打开沟通页，让页面自己加载会话列表，由 content-script 嗅探读取后关闭
function syncContacts({ force = false, windowId } = {}) {
  if (contactsSyncing) return contactsSyncing;
  contactsSyncing = (async () => {
    const got = await chrome.storage.local.get(CONTACTS_SYNC_NEXT_KEY);
    const nextAt = got[CONTACTS_SYNC_NEXT_KEY] || 0;
    if (!force && Date.now() < nextAt) return contactsOverview();
    // 先记时间：失败也不在下个周期内反复重试
    await chrome.storage.local.set({ [CONTACTS_SYNC_KEY]: Date.now(), [CONTACTS_SYNC_NEXT_KEY]: Date.now() + nextSyncDelayMs() });
    const res = await runInBackgroundTab(BOSS_CHAT_URL, 'contacts', { timeoutMs: 30000, windowId, urgent: force });
    const overview = await contactsOverview();
    if (!res.ok) overview.error = res.skipped || res.haltReason || (res.timeout ? '沟通页加载超时' : '沟通页读取失败');
    return overview;
  })().finally(() => {
    contactsSyncing = null;
  });
  return contactsSyncing;
}

async function contactsOverview() {
  const [contacts, got, halt] = await Promise.all([loadContacts(), chrome.storage.local.get(CONTACTS_SYNC_KEY), getHalt()]);
  return {
    contacts,
    companies: new Set(contacts.map((c) => c.company).filter(Boolean)).size,
    syncedAt: got[CONTACTS_SYNC_KEY] || 0,
    halt,
  };
}

// 通过插件打过招呼的岗位记为已沟通
async function recordGreeted(uid) {
  const job = (await loadJobs()).find((j) => j.uid === uid);
  if (!job) return;
  const { jobs } = await addContacts([{ jobId: job.jobId, title: job.title, company: job.company, hrName: job.hrName }], 'greeting');
  if (jobs) afterJobsChange(jobs);
}

// 打开设置页并定位到某一节（#ai / #profile …）；已开着就切过去，不重复开
async function openOptions(section) {
  if (!section) return chrome.runtime.openOptionsPage();
  const base = chrome.runtime.getURL('options.html');
  const url = `${base}#${section}`;
  const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(base));
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

function afterJobsChange(list) {
  broadcast(MSG.JOBS_UPDATED, { count: list.length });
  return list;
}

async function getActiveContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let platform = null;
  let url = '';
  let jobKey = null;
  let isChat = false;
  if (tab) {
    url = tab.url || '';
    try {
      platform = platformOfHost(new URL(url).hostname);
    } catch {}
    const ctx = tabContext.get(tab.id);
    if (ctx) {
      if (!platform) platform = ctx.platform;
      jobKey = ctx.jobKey || null;
      isChat = !!ctx.isChat;
    }
  }
  return {
    platform,
    url,
    jobKey,
    isChat,
    platformName: platform ? PLATFORM_META[platform].name : '',
  };
}

// —— 一键把招呼语发给 HR ——
// 策略：找到目标平台已打开的「沟通/聊天」标签页，交由其 content-script 做 DOM 自动填入+发送。
// 不逆向 IM 协议、不伪造请求，等价于用户手动在聊天框里打字并点发送，风险最低。
// url 存在时（批量发送场景）：先把该标签页导航到对应岗位详情页，再由 content-script 点「立即沟通」开聊天并发送。
// —— 新建标签页打开岗位并自动进入与 HR 的沟通 ——
// 在当前窗口新开一个标签页并激活（视图跳过去），保留用户正在浏览的标签不关闭。
// 新标签加载完成后，让其 content-script 自动点「立即沟通」开聊天，并尽力填入招呼语；
// 填不进（BOSS 聊天框常被混淆）时招呼语已在剪贴板，用户 Ctrl+V 手动粘贴即可。
async function openJobChat(text, platform, url) {
  const target = String(url || '').trim();
  const content = String(text || '').trim();
  if (!target) throw new Error('该岗位没有可打开的链接');

  // 新建标签页并激活（保留当前标签）
  const tab = await chrome.tabs.create({ url: target, active: true });
  try {
    await waitTabComplete(tab.id);
  } catch {
    // 加载超时也继续尝试，content-script 可能已就绪
  }

  // content-script 自动点「立即沟通」进入聊天，并尽力填入
  try {
    const res = await sendMessageWithRetry(tab.id, { type: MSG.SEND_GREETING, text: content });
    if (res && res.ok) return { ok: true, tabId: tab.id, mode: res.mode || 'sent' };
    // 聊天已尝试打开但未能自动填入：退回手动粘贴
    return { ok: true, tabId: tab.id, mode: 'opened', note: (res && res.error) || '' };
  } catch (e) {
    return { ok: true, tabId: tab.id, mode: 'opened', note: e instanceof Error ? e.message : String(e) };
  }
}

// 等待新标签页加载完成（+ 少量沉淀时间给 SPA 渲染）
function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err);
      else setTimeout(resolve, 1500); // SPA 渲染沉淀
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // 创建时可能已加载完成，主动查一次兜底
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
  });
}

async function sendGreetingToChat(text, platform, url) {
  const content = String(text || '').trim();
  if (!content) throw new Error('招呼语为空');

  const hostGlobs = platform && PLATFORM_META[platform]
    ? PLATFORM_META[platform].hosts.map((host) => `*://${host}/*`)
    : ['*://*.zhipin.com/*', '*://*.51job.com/*'];

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: hostGlobs });
  } catch {
    tabs = [];
  }
  if (!tabs.length) {
    throw new Error('未找到已打开的 BOSS/51job 页面，请先在网站上打开对应平台');
  }

  // 优先当前激活标签，其次最近使用
  tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0));

  // 批量发送：把首选标签导航到目标岗位页，等页面就绪
  if (url) {
    const tab = tabs[0];
    try {
      if (!sameJobPage(tab.url, url)) {
        await navigateAndWait(tab.id, url);
      }
      const res = await sendMessageWithRetry(tab.id, { type: MSG.SEND_GREETING, text: content });
      if (res && res.ok) return { ok: true, tabId: tab.id, mode: res.mode || 'dom' };
      throw new Error((res && res.error) || '未定位到聊天输入框');
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  // 单发：在已打开的标签里直接发（当前页应已是岗位/聊天页）
  const errors = [];
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.SEND_GREETING, text: content });
      if (res && res.ok) {
        try { await chrome.tabs.update(tab.id, { active: true }); } catch {}
        return { ok: true, tabId: tab.id, mode: res.mode || 'dom' };
      }
      if (res && res.error) errors.push(res.error);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const detail = errors.find((x) => x && !/Receiving end does not exist/i.test(x));
  throw new Error(detail || '未定位到聊天输入框，请确认已打开与 HR 的聊天窗口后再试');
}

// 是否已在同一岗位页（避免重复导航）
function sameJobPage(curUrl, targetUrl) {
  if (!curUrl || !targetUrl) return false;
  const id = (u) => {
    const m = String(u).match(/job_detail\/([\w~-]+)\.html/) || String(u).match(/\/job\/(\d+)/) || String(u).match(/\/(\d+)\.html/);
    return m ? m[1] : null;
  };
  const a = id(curUrl), b = id(targetUrl);
  return !!a && a === b;
}

// 导航标签页并等待加载完成（+ 少量沉淀时间给 SPA 渲染）
function navigateAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err);
      else setTimeout(resolve, 1500); // SPA 渲染沉淀
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }).catch((e) => finish(e));
  });
}

// 向 content-script 发消息，带重试（导航后 content-script 可能尚未就绪）
async function sendMessageWithRetry(tabId, msg, tries = 6, gap = 700) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg);
      if (res) return res;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (!/Receiving end does not exist/i.test(lastErr)) throw new Error(lastErr);
    }
    await sleep(gap);
  }
  throw new Error(lastErr || 'content-script 未就绪');
}

// —— 简历抽取 ——
async function extractResume(text) {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('尚未配置 AI 供应商，请先到设置页添加');
  const settings = await loadSettings();
  const clean = settings.privacy.redactPII ? redactText(String(text || '')) : String(text || '');
  if (!clean.trim()) throw new Error('简历内容为空');
  // 不写死 maxTokens：交由供应商设置（设置页的 max tokens）决定，否则该配置项形同虚设
  const draft = await callAi(provider, buildResumeExtractPrompt(clean));
  return sanitizeProfile(draft); // 返回草稿，由前端展示给用户确认后再入库
}

// ============ AI 调用：本地缓存 + 供应商前缀缓存 + 用量统计 ============
// 本地缓存键 = 岗位 uid + 「实际发给 AI 的全部内容 + 模型 + 提示词版本」的哈希：
//  - 只要发出去的字节一样（画像、岗位、隐私设置都没变），就直接复用上次的结果，不再请求；
//  - 改名字（不发给 AI）、HR 活跃度变化（不发给 AI，由程序扣分）都不会让缓存失效；
//  - 换了 uid 但内容完全相同的岗位（同一岗位重新发布、换了链接）也能复用。
function aiCacheKey(uid, provider, prompt, kind = 'm') {
  return `${uid}::${kind}${hashStr(`${PROMPT_VERSION}|${provider.protocol}|${provider.model}|${promptText(prompt)}`)}`;
}

async function lookupAiCache(key) {
  const cache = await getMatchCache();
  if (cache[key]) return cache[key];
  const suffix = key.slice(key.indexOf('::'));
  const other = Object.keys(cache).find((k) => k.endsWith(suffix));
  return other ? cache[other] : null;
}

// 前缀预热：供应商缓存要等第一个请求返回后才能被读到。同一前缀（system + 画像）近几分钟没用过时，
// 先只放一个请求出去，其余等它回来再发，这样后面的请求都能命中缓存，而不是并发地各付一次全价。
const WARM_MS = 4 * 60 * 1000;
const prefixWarm = new Map(); // 前缀哈希 -> { at: 上次成功时间, pending: Promise | null }
async function withWarmPrefix(prompt, fn) {
  const sys = prompt.find((m) => m.role === 'system');
  const user = prompt.find((m) => m.role === 'user');
  const head = Array.isArray(user && user.content) ? user.content.filter((c) => c.cache).map((c) => c.text).join('\n') : '';
  const key = hashStr(`${sys ? sys.content : ''}|${head}`);
  for (;;) {
    const w = prefixWarm.get(key);
    if (w && Date.now() - w.at < WARM_MS) break; // 已经是热的
    if (w && w.pending) {
      await w.pending.catch(() => {});
      continue;
    }
    // 冷的：由这个请求负责预热
    const pending = fn();
    prefixWarm.set(key, { at: w ? w.at : 0, pending });
    try {
      const r = await pending;
      prefixWarm.set(key, { at: Date.now(), pending: null });
      return r;
    } catch (e) {
      prefixWarm.set(key, { at: w ? w.at : 0, pending: null });
      throw e;
    }
  }
  const r = await fn();
  prefixWarm.set(key, { at: Date.now(), pending: null });
  return r;
}

// 所有 AI 请求都走这里：并发闸门 + 用量统计
async function callAi(provider, prompt, { warm = false } = {}) {
  const run = () => withAiSlot(() => chatJson(provider, prompt, { json: true, onUsage: recordUsage }));
  return warm ? withWarmPrefix(prompt, run) : run();
}

// —— 用量统计：调用次数、输入 / 命中缓存 / 输出 token、本地缓存命中（直接省掉的请求） ——
const USAGE_KEY = 'jobHelperAiUsageV1';
let usageChain = Promise.resolve();
function bumpUsage(patch) {
  usageChain = usageChain
    .then(async () => {
      const got = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY];
      const u = got && typeof got === 'object' ? got : { since: Date.now(), calls: 0, input: 0, cached: 0, output: 0, localHits: 0 };
      for (const [k, v] of Object.entries(patch)) u[k] = (u[k] || 0) + v;
      await chrome.storage.local.set({ [USAGE_KEY]: u });
    })
    .catch(() => {});
  return usageChain;
}
function recordUsage(u) {
  bumpUsage({ calls: 1, input: u.input, cached: u.cached, output: u.output });
}
async function getUsage() {
  await usageChain;
  const got = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY];
  return got && typeof got === 'object' ? got : { since: 0, calls: 0, input: 0, cached: 0, output: 0, localHits: 0 };
}
async function resetUsage() {
  await usageChain;
  await chrome.storage.local.remove(USAGE_KEY);
  return getUsage();
}

// —— 匹配打分（单个） ——
// 同一岗位同时只跑一次分析：手动点「AI 分析」时自动 / 批量流水线可能正在分析它，复用进行中的结果，不重复花 token
const scoringInFlight = new Map(); // uid -> Promise<match>
function scoreOne(uid, jobArg, opts = {}) {
  const key = uid || (jobArg && jobArg.uid);
  const running = scoringInFlight.get(key);
  if (running && !opts.force) return running;
  const p = scoreOneNow(uid, jobArg, opts).finally(() => {
    if (scoringInFlight.get(key) === p) scoringInFlight.delete(key);
  });
  scoringInFlight.set(key, p);
  return p;
}

async function loadAiContext(uid, jobArg, { requireDetail = false } = {}) {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('尚未配置 AI 供应商，请先到设置页添加');
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  // 以库里最新数据为准（UI 传来的可能是补全详情之前的旧快照）
  const findStored = async () => (await loadJobs()).find((j) => j.uid === (uid || (jobArg && jobArg.uid)));
  let job = (await findStored()) || jobArg;
  if (!job) throw new Error('岗位不存在');
  // BOSS 岗位详情未就绪（缺 JD / HR 活跃）：先在后台打开详情页补全，再分析
  if (!isDetailReady(job) && !requireDetail) {
    await ensureDetail(job);
    job = (await findStored()) || job;
  }
  if (requireDetail && !isDetailReady(job)) throw new Error('岗位详情（JD / HR 活跃）未就绪，已跳过');
  return { provider, profile, job, aiOpts: { includeCompany: settings.privacy.sendCompanyName } };
}

// requireDetail：批量 / 自动匹配要求详情必须就绪，未就绪直接报错跳过，绝不拿列表摘要凑合分析
async function scoreOneNow(uid, jobArg, { force = false, requireDetail = false } = {}) {
  const { provider, profile, job, aiOpts } = await loadAiContext(uid, jobArg, { requireDetail });
  const prompt = buildMatchPrompt(profile, job, aiOpts);
  const key = aiCacheKey(job.uid, provider, prompt);

  let base = force ? null : await lookupAiCache(key);
  if (base) bumpUsage({ localHits: 1 });
  else {
    // 不写死 maxTokens：推理模型会先用 reasoning_content 吃掉预算，硬编码 1024 会导致正文 JSON 被截断
    base = sanitizeMatch(await callAi(provider, prompt, { warm: true }));
    await putMatchCache(key, base); // 缓存的是 AI 原始结论；活跃度扣分每次按当前活跃度现算
  }
  const match = finalizeMatch(base, job);
  await setJobMatch(job.uid, match);
  if (job.autoScoreFails) await patchJob(job.uid, { autoScoreFails: 0, autoScoreError: '' });
  broadcast(MSG.JOBS_UPDATED, { uid: job.uid, scored: true });
  return match;
}

// AI 结论 + 程序统一处理的部分：HR 活跃度扣分、停招提示；重新分析时保留已经生成过的招呼语
function finalizeMatch(base, job) {
  const prev = job.match;
  const risks = [...(base.risks || [])];
  const tier = hrActivityTier(job);
  if (tier === 4 && !risks.some((r) => /未活跃|停招/.test(r))) risks.push('HR 长期未活跃，岗位可能已停招');
  else if (tier === 3 && !risks.some((r) => /活跃/.test(r))) risks.push('HR 本月才活跃过，回复可能较慢');
  let m = { ...base, risks };
  if (!hasGreetings(m) && prev && hasGreetings(prev)) m = { ...m, greetings: prev.greetings, greeting: prev.greeting };
  return applyActivityPenalty(m, job);
}

function hasGreetings(m) {
  const g = normalizeGreetings(m || {});
  return !!(g.short || g.standard || g.detailed);
}

// —— 招呼语（按需生成）：与匹配分析共用 system + 画像前缀，命中供应商缓存时只付岗位部分的输入 ——
const greetingInFlight = new Map();
function generateGreetings(uid, opts = {}) {
  const running = greetingInFlight.get(uid);
  if (running && !opts.force) return running;
  const p = generateGreetingsNow(uid, opts).finally(() => {
    if (greetingInFlight.get(uid) === p) greetingInFlight.delete(uid);
  });
  greetingInFlight.set(uid, p);
  return p;
}

async function generateGreetingsNow(uid, { force = false } = {}) {
  const { provider, profile, job, aiOpts } = await loadAiContext(uid, null);
  if (!job.match) throw new Error('请先完成匹配分析');
  const prompt = buildGreetingPrompt(profile, job, job.match, aiOpts);
  const key = aiCacheKey(job.uid, provider, prompt, 'g');
  let hit = force ? null : await lookupAiCache(key);
  if (hit) bumpUsage({ localHits: 1 });
  else {
    hit = { greetings: normalizeGreetings(await callAi(provider, prompt, { warm: true })), at: new Date().toISOString() };
    await putMatchCache(key, hit);
  }
  const greetings = normalizeGreetings(hit);
  if (!greetings.standard) throw new Error('AI 没有返回招呼语，请重试');
  // 以写入时库里的匹配结果为准（生成期间可能被重新分析过）
  const fresh = (await loadJobs()).find((j) => j.uid === job.uid);
  const base = (fresh && fresh.match) || job.match;
  await setJobMatch(job.uid, { ...base, greetings, greeting: greetings.standard });
  broadcast(MSG.JOBS_UPDATED, { uid: job.uid });
  return greetings;
}

// —— 简历定制建议（按岗位 JD，不落库） ——
// 只返回建议给前端会话内展示，不写入岗位库/画像/缓存，符合「简历数据仅本会话使用」。
async function tailorResume(uid, jobArg) {
  const { provider, profile, job, aiOpts } = await loadAiContext(uid, jobArg);
  const prompt = buildTailorResumePrompt(profile, job, aiOpts);
  // 不写死 maxTokens：交由供应商设置决定
  return sanitizeTailor(await callAi(provider, prompt, { warm: true }));
}

// 全局 AI 并发闸门：自动分析、批量、手动分析、简历建议加起来同时最多 aiConcurrency 个请求
let aiActive = 0;
const aiWaiters = [];
async function withAiSlot(fn) {
  const limit = (await loadSettings()).aiConcurrency || 1;
  while (aiActive >= limit) await new Promise((r) => aiWaiters.push(r));
  aiActive++;
  try {
    return await fn();
  } finally {
    aiActive--;
    aiWaiters.splice(0).forEach((r) => r());
  }
}

// HR 活跃度扣分由程序统一处理（同档同扣），保留 AI 原始分便于展示
function applyActivityPenalty(match, job) {
  const penalty = activityPenalty(job);
  if (!penalty) return match;
  const score = Math.max(0, match.score - penalty);
  return { ...match, rawScore: match.score, activityPenalty: penalty, score, verdict: scoreToVerdict(score) };
}

// 53 位哈希（cyrb53）：缓存键用，碰撞概率远低于 32 位
function hashStr(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

async function exportJobs(format) {
  const jobs = await loadJobs();
  if (format === 'csv') {
    const cols = ['platform', 'title', 'company', 'salaryText', 'city', 'district', 'experience', 'degree', 'companyIndustry', 'companyScale', 'address', 'hrActiveText', 'contacted', 'url'];
    const head = cols.join(',');
    const rows = jobs.map((j) =>
      cols.map((c) => `"${String(j[c] ?? '').replace(/"/g, '""')}"`).join(','),
    );
    return { format: 'csv', content: '﻿' + [head, ...rows].join('\n'), count: jobs.length };
  }
  return { format: 'json', content: JSON.stringify(jobs, null, 2), count: jobs.length };
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 清理关闭的 tab 上下文
chrome.tabs.onRemoved.addListener((tabId) => tabContext.delete(tabId));
