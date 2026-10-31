// 投递清单 / 历史 / 每日搜索状态：storage.local 读写。
// 所有写操作都串行化（与 jobsStore 同理）：清单整理、投递结果、用户确认可能同时发生，
// 整份读改写交错会互相覆盖。
import { STORAGE_KEYS } from './constants.js';

const BATCH_KEY = STORAGE_KEYS.applyBatch;
const HISTORY_KEY = STORAGE_KEYS.applyHistory;
const STATE_KEY = STORAGE_KEYS.autoApplyState;
const HISTORY_MAX = 2000;

let writeChain = Promise.resolve();
function locked(fn) {
  return (...args) => {
    const run = writeChain.then(() => fn(...args));
    writeChain = run.catch(() => {});
    return run;
  };
}

export async function loadApplyBatch() {
  const got = await chrome.storage.local.get(BATCH_KEY);
  const b = got[BATCH_KEY];
  if (!b || typeof b !== 'object' || !Array.isArray(b.items)) return { date: '', createdAt: '', updatedAt: '', items: [] };
  return b;
}

export async function saveApplyBatch(batch) {
  await chrome.storage.local.set({ [BATCH_KEY]: batch && typeof batch === 'object' ? batch : { date: '', items: [] } });
}

// 在写锁内读出 → 交给 fn 修改 → 写回；fn 返回 null/undefined 表示没有变化，跳过整份写回。
export const updateApplyBatch = locked(async (fn) => {
  const cur = await loadApplyBatch();
  const next = await fn(cur);
  if (!next) return cur;
  await saveApplyBatch(next);
  return next;
});

export async function loadApplyHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  const h = got[HISTORY_KEY];
  return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
}

export const addApplyHistory = locked(async (entries) => {
  const cur = await loadApplyHistory();
  const now = new Date().toISOString();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.uid) continue;
    cur[e.uid] = { uid: e.uid, title: e.title || '', company: e.company || '', at: e.at || now };
  }
  // 只保留最近 HISTORY_MAX 条，避免无限增长
  const list = Object.values(cur).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const next = Object.fromEntries(list.slice(0, HISTORY_MAX).map((e) => [e.uid, e]));
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
});

export const clearApplyHistory = locked(async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
});

export async function loadAutoApplyState() {
  const got = await chrome.storage.local.get(STATE_KEY);
  const s = got[STATE_KEY];
  return {
    lastSearchDate: '',
    lastSearchAt: 0,
    lastSearchStatus: '',
    lastSearchError: '',
    lastSearchCount: 0,
    ...(s && typeof s === 'object' ? s : {}),
  };
}

export const saveAutoApplyState = locked(async (patch) => {
  const cur = await loadAutoApplyState();
  const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
});

// 批量更新清单条目状态（确认 / 忽略 / 投递结果）；items 里不存在的 uid 忽略
export const markApplyItems = locked(async (uids, patch) => {
  const want = new Set(Array.isArray(uids) ? uids : [uids]);
  const cur = await loadApplyBatch();
  const now = new Date().toISOString();
  const next = {
    ...cur,
    updatedAt: now,
    items: cur.items.map((it) => (want.has(it.uid) ? { ...it, ...patch, updatedAt: now } : it)),
  };
  await saveApplyBatch(next);
  return next;
});
