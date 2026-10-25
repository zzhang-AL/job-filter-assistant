// 岗位库：storage.local 读写、去重合并、容量淘汰、匹配分缓存。
import { STORAGE_KEYS } from './constants.js';
import { contactKey, buildContactIndex, contactStatus } from './platforms.js';

const JOBS_KEY = STORAGE_KEYS.jobs;
const CACHE_KEY = STORAGE_KEYS.matchCache;
const BLOCK_KEY = STORAGE_KEYS.blocked;
const CACHE_MAX = 1500; // 匹配缓存最多条数（超出按时间淘汰最旧的）
const CONTACT_KEY = STORAGE_KEYS.contacts;

// —— 写锁 ——
// 岗位库 / 名单 / 缓存都是「整份读出 → 修改 → 整份写回」。收录、补详情、AI 匹配并行时，
// 两次写入交错会让后写的覆盖先写的（比如刚写入的匹配分被同时进行的详情合并抹掉）。
// 所有写操作都在同一个 Service Worker 里，用一条 Promise 链串行化即可。
let writeChain = Promise.resolve();
function locked(fn) {
  return (...args) => {
    const run = writeChain.then(() => fn(...args));
    writeChain = run.catch(() => {});
    return run;
  };
}

export async function loadJobs() {
  const got = await chrome.storage.local.get(JOBS_KEY);
  const list = got[JOBS_KEY];
  return Array.isArray(list) ? list : [];
}

export async function saveJobs(list) {
  await chrome.storage.local.set({ [JOBS_KEY]: Array.isArray(list) ? list : [] });
}

// 合并新抓取的岗位到库中。dedupe=true 时按 uid 去重（更新已存在的字段）。
// accept(raw, prev)：返回 false 则跳过该条（屏蔽 / 已沟通）；prev 为库里已有记录或 undefined。
// 返回 { jobs, added, updated, skipped, addedUids, readyUids }
// readyUids：本次合并后「详情就绪」的岗位（新加入即就绪，或之前未就绪、这次补齐了），用于触发自动匹配。
async function mergeJobsUnlocked(incoming, { dedupe = true, maxJobs = 800, accept = null } = {}) {
  const now = new Date().toISOString();
  const existing = await loadJobs();
  const byUid = new Map(existing.map((j) => [j.uid, j]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const addedUids = [];
  const readyUids = [];

  for (const raw of incoming) {
    if (!raw || !raw.uid) continue;
    if (accept && !accept(raw, byUid.get(raw.uid))) {
      skipped++;
      continue;
    }
    if (dedupe && byUid.has(raw.uid)) {
      const prev = byUid.get(raw.uid);
      // 用新数据补全空字段，保留 savedAt / star / match
      const merged = {
        ...prev,
        ...raw,
        description: raw.description || prev.description,
        // 详情的 raw 不含 lid 等列表凭据，合并而非整体替换
        raw: { ...(prev.raw || {}), ...(raw.raw || {}) },
        // 列表不带活跃时间，不能让列表的再次出现抹掉详情里拿到的值
        hrActiveText: raw.hrActiveText || prev.hrActiveText || '',
        hrActiveAt: raw.hrActiveAt || prev.hrActiveAt || '',
        address: raw.address || prev.address || '',
        // 经验 / 学历以详情为准：已有详情值时，列表里的标签不覆盖
        ...(prev.experienceFrom === 'detail' && raw.experienceFrom !== 'detail'
          ? { experience: prev.experience, experienceFrom: 'detail' } : {}),
        ...(prev.degreeFrom === 'detail' && raw.degreeFrom !== 'detail'
          ? { degree: prev.degree, degreeFrom: 'detail' } : {}),
        experienceJd: raw.description ? raw.experienceJd || '' : prev.experienceJd || '',
        detailAt: raw.description ? now : prev.detailAt,
        savedAt: prev.savedAt,
        star: prev.star,
        match: prev.match,
        lastSeenAt: now,
      };
      byUid.set(raw.uid, merged);
      updated++;
      if (!isDetailReady(prev) && isDetailReady(merged)) readyUids.push(raw.uid);
    } else {
      byUid.set(raw.uid, { ...raw, detailAt: raw.description ? now : undefined, savedAt: now, lastSeenAt: now, star: false, match: null });
      added++;
      addedUids.push(raw.uid);
      if (isDetailReady(byUid.get(raw.uid))) readyUids.push(raw.uid);
    }
  }

  let list = Array.from(byUid.values());
  // 按最近出现时间倒序，超容量淘汰（保留收藏）
  list.sort((a, b) => (b.lastSeenAt || b.savedAt || '').localeCompare(a.lastSeenAt || a.savedAt || ''));
  if (list.length > maxJobs) {
    const starred = list.filter((j) => j.star);
    const rest = list.filter((j) => !j.star).slice(0, Math.max(0, maxJobs - starred.length));
    list = [...starred, ...rest];
  }

  await saveJobs(list);
  const kept = new Set(list.map((j) => j.uid));
  return { jobs: list, added, updated, skipped, addedUids, readyUids: readyUids.filter((u) => kept.has(u)) };
}

// 详情是否就绪（可以做匹配了）：
//  - BOSS：列表接口不含 JD 与 HR 活跃，必须读过一次详情（详情页 / 详情接口 / 悬停卡片）——
//    detailAt 只在拿到 JD 的那次详情读取时写入，HR 活跃时间在同一次读取里一并获取；
//  - 51job：列表接口直接带完整 JD，有 JD 即就绪。
export function isDetailReady(j) {
  if (!j || !j.description) return false;
  if (j.platform === 'boss') return !!j.detailAt;
  return true;
}

// 从给定岗位里挑出需要补抓详情的（无 JD，或详情已超过 staleMs 未刷新——HR 活跃时间会过期）。
// 只处理有独立详情页的 BOSS 岗位；沟通过的这个岗位不再补（同公司的其他岗位照常补，供匹配用）。
export function pickJobsNeedingDetail(list, uids, { staleMs = 24 * 3600 * 1000 } = {}) {
  const want = new Set(uids);
  const now = Date.now();
  return list
    .filter((j) => want.has(j.uid) && j.platform === 'boss' && j.contacted !== 'job' && bossDetailPageUrl(j))
    .filter((j) => !j.description || !j.detailAt || now - Date.parse(j.detailAt) > staleMs)
    // 列表里 HR 在线的先补（更可能在招），其余保持列表顺序
    .sort((a, b) => (b.hrOnline === true) - (a.hrOnline === true))
    .map((j) => ({ uid: j.uid, jobId: j.jobId, url: bossDetailPageUrl(j) }));
}

// BOSS 岗位详情页地址；带上列表卡片链接里同样的 lid / securityId，与用户从列表点进去一致
export function bossDetailPageUrl(j) {
  const m = String((j && j.url) || '').match(/^https:\/\/www\.zhipin\.com\/job_detail\/[\w~-]+\.html/);
  if (!m) return '';
  const q = new URLSearchParams();
  if (j.raw && j.raw.lid) q.set('lid', j.raw.lid);
  if (j.raw && j.raw.securityId) q.set('securityId', j.raw.securityId);
  const qs = q.toString();
  return qs ? `${m[0]}?${qs}` : m[0];
}

async function deleteJobUnlocked(uid) {
  const list = await loadJobs();
  const next = list.filter((j) => j.uid !== uid);
  await saveJobs(next);
  return next;
}

async function clearJobsUnlocked() {
  await chrome.storage.local.set({ [JOBS_KEY]: [] });
  return [];
}

async function toggleStarUnlocked(uid) {
  const list = await loadJobs();
  const next = list.map((j) => (j.uid === uid ? { ...j, star: !j.star } : j));
  await saveJobs(next);
  return next;
}

// 写回单个岗位的匹配分
async function setJobMatchUnlocked(uid, match) {
  const list = await loadJobs();
  const next = list.map((j) => (j.uid === uid ? { ...j, match } : j));
  await saveJobs(next);
  return next;
}

// 合并若干字段到单个岗位（如自动分析失败计数）
async function patchJobUnlocked(uid, patch) {
  const list = await loadJobs();
  const next = list.map((j) => (j.uid === uid ? { ...j, ...patch } : j));
  await saveJobs(next);
  return next;
}

// 看过 / 不感兴趣：只是浏览状态，不像屏蔽那样移出岗位库。true 记下时间、false 清除，undefined 不动
async function markJobsUnlocked(uids, { viewed, dismissed } = {}) {
  const ids = new Set(uids);
  const now = new Date().toISOString();
  const pick = (flag, prev) => (flag === undefined ? prev : flag ? prev || now : undefined);
  const list = await loadJobs();
  const next = list.map((j) => (ids.has(j.uid) ? { ...j, viewedAt: pick(viewed, j.viewedAt), dismissedAt: pick(dismissed, j.dismissedAt) } : j));
  await saveJobs(next);
  return next;
}

// 保存用户编辑后的招呼语草稿（发送前的最终文案，独立于 AI 生成的 match.greetings）
async function setJobGreetingUnlocked(uid, text) {
  const list = await loadJobs();
  const draft = String(text == null ? '' : text).slice(0, 800);
  const next = list.map((j) => (j.uid === uid ? { ...j, greetingDraft: draft } : j));
  await saveJobs(next);
  return next;
}

// —— 屏蔽名单：[{ uid, platform, title, company, at }]，与岗位库分开存，清空岗位库后依然生效 ——
export async function loadBlocked() {
  const got = await chrome.storage.local.get(BLOCK_KEY);
  return Array.isArray(got[BLOCK_KEY]) ? got[BLOCK_KEY] : [];
}

// 屏蔽：写入名单并从岗位库移除。返回 { jobs, blocked }
async function blockJobsUnlocked(uids) {
  const want = new Set(uids);
  const [list, blocked] = await Promise.all([loadJobs(), loadBlocked()]);
  const have = new Set(blocked.map((b) => b.uid));
  const now = new Date().toISOString();
  for (const j of list) {
    if (!want.has(j.uid) || have.has(j.uid)) continue;
    blocked.unshift({ uid: j.uid, platform: j.platform, title: j.title || '', company: j.company || '', at: now });
    have.add(j.uid);
  }
  const next = list.filter((j) => !want.has(j.uid));
  await chrome.storage.local.set({ [BLOCK_KEY]: blocked, [JOBS_KEY]: next });
  return { jobs: next, blocked };
}

async function unblockJobUnlocked(uid) {
  const next = (await loadBlocked()).filter((b) => b.uid !== uid);
  await chrome.storage.local.set({ [BLOCK_KEY]: next });
  return next;
}

async function clearBlockedUnlocked() {
  await chrome.storage.local.set({ [BLOCK_KEY]: [] });
  return [];
}

// —— 已沟通记录：[{ jobId, title, company, hrName, source, at }] ——
export async function loadContacts() {
  const got = await chrome.storage.local.get(CONTACT_KEY);
  return Array.isArray(got[CONTACT_KEY]) ? got[CONTACT_KEY] : [];
}

// 合并新的沟通记录，并给岗位库里对应岗位打上 contacted 标记。返回 { contacts, added, jobs }
async function addContactsUnlocked(entries, source = 'chat') {
  const contacts = await loadContacts();
  const keys = new Set(contacts.map(contactKey));
  const now = new Date().toISOString();
  let added = 0;
  for (const e of entries) {
    const c = { jobId: e.jobId || '', title: e.title || '', company: e.company || '', hrName: e.hrName || '', source, at: now };
    const k = contactKey(c);
    if (!k || keys.has(k)) continue;
    keys.add(k);
    contacts.push(c);
    added++;
  }
  if (!added) return { contacts, added, jobs: null };
  const jobs = markContacted(await loadJobs(), contacts);
  await chrome.storage.local.set({ [CONTACT_KEY]: contacts, [JOBS_KEY]: jobs });
  return { contacts, added, jobs };
}

// 手动标记已沟通：按岗位库里的岗位写入记录（source=manual）
export async function markJobsContacted(uids) {
  const want = new Set(uids);
  const picked = (await loadJobs()).filter((j) => want.has(j.uid));
  const entries = picked.map((j) => ({ jobId: j.jobId, title: j.title, company: j.company, hrName: j.hrName }));
  return addContacts(entries, 'manual');
}

// 删除指定 key（contactKey）的沟通记录，并重新计算岗位库的 contacted 标记
async function removeContactsUnlocked(keys) {
  const drop = new Set(keys);
  const contacts = (await loadContacts()).filter((c) => !drop.has(contactKey(c)));
  const jobs = markContacted(await loadJobs(), contacts);
  await chrome.storage.local.set({ [CONTACT_KEY]: contacts, [JOBS_KEY]: jobs });
  return { contacts, jobs };
}

async function clearContactsUnlocked() {
  const jobs = (await loadJobs()).map((j) => (j.contacted ? { ...j, contacted: '' } : j));
  await chrome.storage.local.set({ [CONTACT_KEY]: [], [JOBS_KEY]: jobs });
  return jobs;
}

// 按沟通记录刷新每个岗位的 contacted 字段（'job' | 'company' | ''）
export function markContacted(list, contacts) {
  const idx = buildContactIndex(contacts);
  return list.map((j) => {
    const st = contactStatus(j, idx);
    return st === (j.contacted || '') ? j : { ...j, contacted: st };
  });
}

// —— 匹配分缓存：key = uid + profile 指纹，避免画像没变时重复调用 AI ——
export async function getMatchCache() {
  const got = await chrome.storage.local.get(CACHE_KEY);
  return got[CACHE_KEY] && typeof got[CACHE_KEY] === 'object' ? got[CACHE_KEY] : {};
}
export async function setMatchCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// 写入一条匹配缓存：在写锁内读改写，并清理已不在岗位库里的岗位、超量时淘汰最旧的，防止无限增长撑满存储
async function putMatchCacheUnlocked(key, match) {
  const [cache, jobs] = await Promise.all([getMatchCache(), loadJobs()]);
  cache[key] = match;
  const alive = new Set(jobs.map((j) => j.uid));
  let entries = Object.entries(cache).filter(([k]) => alive.has(k.split('::')[0]));
  if (entries.length > CACHE_MAX) {
    entries.sort((a, b) => String((b[1] && b[1].at) || '').localeCompare(String((a[1] && a[1].at) || '')));
    entries = entries.slice(0, CACHE_MAX);
  }
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}
export const putMatchCache = locked(putMatchCacheUnlocked);
export async function clearMatchCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

// 对外暴露的写操作一律经过写锁
export const mergeJobs = locked(mergeJobsUnlocked);
export const deleteJob = locked(deleteJobUnlocked);
export const clearJobs = locked(clearJobsUnlocked);
export const toggleStar = locked(toggleStarUnlocked);
export const setJobMatch = locked(setJobMatchUnlocked);
export const setJobGreeting = locked(setJobGreetingUnlocked);
export const patchJob = locked(patchJobUnlocked);
export const markJobs = locked(markJobsUnlocked);
export const blockJobs = locked(blockJobsUnlocked);
export const unblockJob = locked(unblockJobUnlocked);
export const clearBlocked = locked(clearBlockedUnlocked);
export const addContacts = locked(addContactsUnlocked);
export const removeContacts = locked(removeContactsUnlocked);
export const clearContacts = locked(clearContactsUnlocked);
