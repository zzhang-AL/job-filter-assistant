// 设置与 AI 供应商列表的 storage 读写。
import { STORAGE_KEYS, defaultSettings, defaultFilters } from './constants.js';
import { sanitizeProviderList } from './ai/providers.js';
import { sanitizePacing } from './pacing.js';
import { sanitizeAutoApply } from './autoApply.js';

const SET_KEY = STORAGE_KEYS.settings;
const PROV_KEY = STORAGE_KEYS.aiProviders;

export async function loadSettings() {
  const got = await chrome.storage.local.get(SET_KEY);
  return mergeSettings(got[SET_KEY]);
}
export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = mergeSettings({
    ...cur,
    ...patch,
    filters: { ...cur.filters, ...(patch && patch.filters) },
    privacy: { ...cur.privacy, ...(patch && patch.privacy) },
    pacing: { ...cur.pacing, ...(patch && patch.pacing) },
    autoApply: { ...cur.autoApply, ...(patch && patch.autoApply) },
  });
  await chrome.storage.local.set({ [SET_KEY]: next });
  return next;
}

export function mergeSettings(input) {
  const d = defaultSettings();
  if (!isObj(input)) return d;
  // 迁移：
  //  rev<2：旧版本默认不自动分析，现在改为收录后自动进入「补详情 → AI 匹配」
  //  rev<3：仍是旧「标准」额度（60/时、300/天，未自定义过）的升到新标准额度
  const rev = input.settingsRev || 0;
  const migrated = {};
  if (rev < 2) migrated.autoScore = true;
  if (rev < 3) {
    const p = isObj(input.pacing) ? input.pacing : {};
    if ((p.hourlyCap == null || p.hourlyCap === 60) && (p.dailyCap == null || p.dailyCap === 300)) {
      migrated.pacing = { ...p, hourlyCap: d.pacing.hourlyCap, dailyCap: d.pacing.dailyCap };
    }
  }
  if (rev < 4) {
    const a = isObj(input.autoApply) ? input.autoApply : {};
    // 旧默认是前台打开（会抢焦点）；新默认改为后台标签页执行
    if (a.applyForeground !== false) migrated.autoApply = { ...a, applyForeground: false };
  }
  if (rev < d.settingsRev) migrated.settingsRev = d.settingsRev;
  return {
    ...d,
    ...input,
    ...migrated,
    privacy: { ...d.privacy, ...(isObj(input.privacy) ? input.privacy : {}) },
    filters: { ...defaultFilters(), ...(isObj(input.filters) ? input.filters : {}) },
    pacing: sanitizePacing({ ...d.pacing, ...(isObj(input.pacing) ? input.pacing : {}), ...(migrated.pacing || {}) }),
    autoApply: sanitizeAutoApply({ ...d.autoApply, ...(isObj(input.autoApply) ? input.autoApply : {}), ...(migrated.autoApply || {}) }),
    aiConcurrency: clampInt(input.aiConcurrency, d.aiConcurrency, 1, 8),
  };
}

export async function loadProviders() {
  const got = await chrome.storage.local.get(PROV_KEY);
  return sanitizeProviderList(got[PROV_KEY]);
}
export async function saveProviders(list) {
  const clean = sanitizeProviderList(list);
  await chrome.storage.local.set({ [PROV_KEY]: clean });
  return clean;
}

// 取当前启用的供应商（settings.activeProviderId 指向；否则取第一个可用）
export async function getActiveProvider() {
  const [settings, providers] = await Promise.all([loadSettings(), loadProviders()]);
  if (!providers.length) return null;
  const byId = providers.find((p) => p.id === settings.activeProviderId);
  return byId || providers[0];
}

function clampInt(v, def, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
}

function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
