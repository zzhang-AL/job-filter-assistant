import { MSG, MODE } from '../common/constants.js';
import { scoreProfile, sanitizeProfile, mergeDraft } from '../common/profile.js';
import { PRESETS, PROTOCOLS, PROTOCOL_LABELS, providerFromPreset, validateProvider, isProviderUsable } from '../common/ai/providers.js';
import { send, h, toast, toList, debounce, fmtTime } from './ui-common.js';
import { parseResumeFile } from './resumeParser.js';
import { PACING_PRESETS } from '../common/pacing.js';
import { BOSS_CITY_CODES, EXPERIENCE_OPTIONS, HR_ACTIVE_OPTIONS } from '../common/autoApply.js';
import { contactKey } from '../common/platforms.js';
import { evaluateJob } from '../common/filters.js';
import { icon } from './icons.js';
import { iconBtn, notice, opt } from './components.js';

const navEl = document.getElementById('nav');
const mainEl = document.getElementById('main');

let settings = null;
let providers = [];
let profile = null;
let halt = null; // 后台补全熔断（自动化页提示 + 导航角标）
let applyStatus = null; // 今日投递清单 / 每日搜索状态

const SECTIONS = [
  { id: 'profile', icon: 'user', label: '个人画像', desc: 'AI 用它判断岗位是否匹配、生成招呼语和简历建议。画像越完整，结果越准。', render: renderProfile },
  { id: 'ai', icon: 'plug', label: 'AI 接口', desc: '兼容 OpenAI / Anthropic / Gemini 等协议，可接入任意兼容供应商或本地模型。只有「当前启用」的那个会被调用。', render: renderAi },
  { id: 'filters', icon: 'filter', label: '岗位筛选', desc: '本地规则先过一遍（不消耗 AI）。不满足条件的岗位不会出现在侧边栏列表里。', render: renderFilters },
  { id: 'automation', icon: 'zap', label: '自动化', desc: '浏览时自动收录、后台补全 BOSS 详情、自动 AI 分析，以及后台标签页的节奏。', render: renderAutomation },
  { id: 'autoapply', icon: 'send', label: '自动投递', desc: '每天定时刷 BOSS、补详情、AI 匹配，生成待确认清单；你点确认后才逐个点「立即沟通」。', render: renderAutoApply },
  { id: 'lists', icon: 'block', label: '已沟通与屏蔽', desc: '沟通过的岗位不再重复收录和匹配；屏蔽的岗位永久不再收录，清空岗位库也不影响。', render: renderLists },
  { id: 'privacy', icon: 'shield', label: '隐私与数据', desc: '发送给 AI 的数据范围、岗位数据的导出与清理。所有数据只保存在本机浏览器。', render: renderPrivacy },
];
// 旧链接兼容：原「通用与隐私」拆成了「自动化」和「隐私与数据」
const SECTION_ALIAS = { general: 'automation' };
let current = 'profile';

async function boot() {
  await reloadAll();
  window.addEventListener('hashchange', route);
  route();
}

async function reloadAll() {
  let ov;
  [settings, providers, profile, ov, applyStatus] = await Promise.all([
    send(MSG.SETTINGS_GET),
    send(MSG.AI_PROVIDERS_GET),
    send(MSG.PROFILE_GET),
    send(MSG.CONTACTS_GET).catch(() => null),
    send(MSG.AUTO_APPLY_STATUS_GET).catch(() => null),
  ]);
  profile = sanitizeProfile(profile);
  halt = ov && ov.halt;
}

// 以 #section 为准：刷新、从侧边栏「去配置」跳过来都能直达对应一节
function route() {
  const id = location.hash.slice(1);
  current = SECTIONS.some((s) => s.id === id) ? id : SECTION_ALIAS[id] || 'profile';
  renderNav();
  const sec = SECTIONS.find((s) => s.id === current);
  mainEl.innerHTML = '';
  mainEl.appendChild(renderHead(sec));
  sec.render();
  window.scrollTo(0, 0);
}

function go(id) {
  if (location.hash.slice(1) === id) route();
  else location.hash = id;
}

// ============================================================
//  导航（带状态角标）与保存状态
// ============================================================
function navBadge(id) {
  if (id === 'profile') {
    const sc = scoreProfile(profile).score;
    return { text: `${sc}%`, tone: sc >= 60 ? 'ok' : 'warn', title: `画像完整度 ${sc}%` };
  }
  if (id === 'ai') {
    const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
    if (!active) return { text: '未配置', tone: 'warn' };
    if (!isProviderUsable(active)) return { text: '待完善', tone: 'warn', title: '当前启用的供应商缺少 Base URL / 模型 / API Key' };
    return null;
  }
  if (id === 'filters') return settings.filters.enabled ? { text: '已启用', tone: 'ok' } : null;
  if (id === 'automation' && halt) return { text: '已暂停', tone: 'warn', title: halt.reason };
  if (id === 'autoapply') {
    const pending = (applyStatus && applyStatus.batch && applyStatus.batch.counts && applyStatus.batch.counts.pending) || 0;
    if (pending) return { text: `${pending} 待投`, tone: 'warn', title: '今日投递清单待确认' };
    return settings.autoApply.enabled ? { text: '已开启', tone: 'ok' } : null;
  }
  return null;
}

function renderNav() {
  navEl.innerHTML = '';
  for (const s of SECTIONS) {
    const badge = navBadge(s.id);
    navEl.appendChild(
      h('button', {
        class: 'nav-item' + (s.id === current ? ' active' : ''),
        'aria-current': s.id === current ? 'page' : null,
        onclick: () => go(s.id),
      }, [
        icon(s.icon, { cls: 'nav-ico' }),
        h('span', { class: 'nav-label', text: s.label }),
        badge ? h('span', { class: `nav-badge tone-${badge.tone}`, text: badge.text, title: badge.title || '' }) : null,
      ]),
    );
  }
}

// 只刷新导航角标（输入时不整页重绘）
function refreshNav() {
  renderNav();
}

let saveEl = null;
let saving = 0;
let savedTimer = null;
function renderHead(sec) {
  saveEl = h('div', { class: 'save-state', 'aria-live': 'polite' });
  setSaveState('idle');
  return h('div', { class: 'sec-head' }, [
    h('div', { class: 'sec-head-text' }, [h('h1', { class: 'sec-title', text: sec.label }), h('div', { class: 'sec-desc', text: sec.desc })]),
    saveEl,
  ]);
}

function setSaveState(state, msg) {
  if (!saveEl) return;
  saveEl.className = 'save-state is-' + state;
  saveEl.replaceChildren(
    ...(state === 'saving'
      ? [h('span', { class: 'spinner spinner-sm' }), '保存中…']
      : state === 'error'
      ? [icon('alert', { size: 14 }), '保存失败']
      : state === 'saved'
      ? [icon('check', { size: 14 }), '已保存']
      : [icon('check', { size: 14 }), '修改会自动保存']),
  );
  if (msg) saveEl.title = msg;
}

// 所有保存都经过这里：顶部显示「保存中 / 已保存 / 保存失败」
async function track(promise) {
  saving++;
  clearTimeout(savedTimer);
  setSaveState('saving');
  try {
    const r = await promise;
    if (--saving === 0) {
      setSaveState('saved');
      savedTimer = setTimeout(() => setSaveState('idle'), 2500);
    }
    return r;
  } catch (e) {
    saving--;
    setSaveState('error', e.message);
    toast(`保存失败：${e.message}`, true);
    throw e;
  }
}

async function saveSettings(patch) {
  settings = await track(send(MSG.SETTINGS_SAVE, { patch }));
  refreshNav();
  return settings;
}
const saveProviders = async (list) => {
  providers = await track(send(MSG.AI_PROVIDERS_SAVE, { providers: list }));
  refreshNav();
  return providers;
};

// ============================================================
//  通用表单件
// ============================================================
function panel(title, desc, children = [], extra = {}) {
  return h('section', { class: 'panel' + (extra.cls ? ' ' + extra.cls : '') }, [
    title || extra.aside
      ? h('div', { class: 'panel-head' }, [
          h('div', {}, [
            title ? h('h2', { class: 'panel-title', text: title }) : null,
            desc ? h('div', { class: 'panel-desc', text: desc }) : null,
          ]),
          extra.aside || null,
        ])
      : null,
    ...children,
  ]);
}

function field(label, control, { hint, key, cls } = {}) {
  return h('div', { class: 'field' + (cls ? ' ' + cls : ''), dataset: key ? { field: key } : undefined }, [
    h('label', { text: label }),
    control,
    hint ? h('div', { class: 'field-hint', text: hint }) : null,
  ]);
}

// 开关行：整行可点（label 包住），说明文字在下
function setRow(label, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'set-row is-toggle' }, [
    h('div', { class: 'set-text' }, [h('div', { class: 's-label', text: label }), desc ? h('div', { class: 's-desc', text: desc }) : null]),
    h('span', { class: 'switch' }, [input, h('span', { class: 'slider' })]),
  ]);
}

function ctlRow(label, desc, control) {
  return h('div', { class: 'set-row' }, [
    h('div', { class: 'set-text' }, [h('div', { class: 's-label', text: label }), desc ? h('div', { class: 's-desc', text: desc }) : null]),
    h('div', { class: 'set-ctl' }, [control]),
  ]);
}

// 数字输入：改完（回车 / 失焦 / 点上下箭头）才保存；保存后显示规整后的值（越界会被收回到范围内）
function numInput({ value, min, max, unit, width = 76, onCommit }) {
  const input = h('input', { type: 'number', min, max, value: value ?? '', style: `width:${width}px` });
  input.addEventListener('change', async () => {
    const shown = await onCommit(input.value === '' ? null : Number(input.value));
    if (shown !== undefined) {
      // 越界值会被后台收敛（如 500 → 100）；无论是否失焦都回写，避免界面显示的值和实际保存值不一致
      if (String(shown ?? '') !== input.value) {
        input.classList.add('invalid');
        setTimeout(() => input.classList.remove('invalid'), 1200);
      }
      input.value = shown ?? '';
    }
  });
  return unit ? h('span', { class: 'num-wrap' }, [input, h('span', { class: 'num-unit', text: unit })]) : input;
}

// 标签编辑器：chip + 输入，回车 / 逗号 / 粘贴多项添加，退格删最后一个
function tagEditor(values, onChange, placeholder) {
  const arr = Array.isArray(values) ? [...values] : [];
  const wrap = h('div', { class: 'tag-editor' });
  const input = h('input', { type: 'text', placeholder: placeholder || '回车添加' });

  const chip = (v, i) =>
    h('span', { class: 'chip chip-accent' }, [
      h('span', { text: v }),
      h('button', {
        class: 'chip-x',
        type: 'button',
        title: `移除「${v}」`,
        'aria-label': `移除 ${v}`,
        onclick: (e) => {
          e.stopPropagation();
          arr.splice(i, 1);
          onChange([...arr]);
          draw(true);
        },
      }, [icon('close', { size: 10 })]),
    ]);
  function draw(focus) {
    wrap.replaceChildren(...arr.map(chip), input);
    input.placeholder = arr.length ? '' : placeholder || '回车添加';
    if (focus) input.focus();
  }
  function commit() {
    let changed = false;
    for (const p of toList(input.value)) {
      if (!arr.some((x) => x.toLowerCase() === p.toLowerCase())) {
        arr.push(p);
        changed = true;
      }
    }
    input.value = '';
    if (changed) {
      onChange([...arr]);
      draw(document.activeElement === input);
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !input.value && arr.length) {
      arr.pop();
      onChange([...arr]);
      draw(true);
    }
  });
  input.addEventListener('paste', () => setTimeout(() => /[,，、;；\n]/.test(input.value) && commit(), 0));
  input.addEventListener('blur', commit);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) input.focus(); });
  draw(false);
  return wrap;
}

function segmented(options, value, onPick) {
  return h('div', { class: 'segmented', role: 'radiogroup' },
    options.map(([v, label]) =>
      h('button', { class: value === v ? 'active' : '', role: 'radio', 'aria-checked': value === v ? 'true' : 'false', text: label, onclick: () => onPick(v) }),
    ),
  );
}

// 确认弹窗：Esc / 点遮罩取消，确认按钮执行期间显示进行中
function showModal({ title, body, confirmText = '确认', danger = false, onConfirm }) {
  const prevFocus = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const ok = h('button', {
    class: 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'),
    text: confirmText,
    onclick: async () => {
      ok.disabled = true;
      ok.textContent = '处理中…';
      try {
        await onConfirm();
        close();
      } catch (e) {
        ok.disabled = false;
        ok.textContent = confirmText;
        toast(e.message, true);
      }
    },
  });
  backdrop.appendChild(
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('h3', { text: title }),
      h('p', { text: body }),
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn', text: '取消', onclick: close }), ok]),
    ]),
  );
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  ok.focus();
}

function showBusy(text) {
  const label = h('div', { text });
  const el = h('div', { class: 'busy-overlay' }, [h('span', { class: 'spinner big-spinner' }), label]);
  document.body.appendChild(el);
  return { setText: (t) => { label.textContent = t; }, close: () => el.remove() };
}

// ============================================================
//  个人画像
// ============================================================
let draft = null; // AI 抽取草稿待确认
let importMode = 'file'; // file | text

// 完整度里「待补充」的项 -> 表单字段，点了直接跳过去
const MISSING_FIELD = {
  目标岗位: 'jobTitles', 目标城市: 'cities', 期望薪资: 'salaryMinK', 工作年限: 'yearsOfExperience', 最高学历: 'education',
  当前职位: 'currentTitle', 专业技能: 'skills', 优势亮点: 'strengths', 行业经验: 'industryExperience', 工作经历: 'workSummary', '项目/成就': 'projectSummary',
};

function renderProfile() {
  const scoreBox = h('div', { class: 'score-card' });
  mainEl.appendChild(scoreBox);
  fillScore(scoreBox);

  mainEl.appendChild(renderImport());
  renderProfileForm().forEach((p) => mainEl.appendChild(p));

  mainEl.appendChild(
    panel('清除画像', '清空全部画像字段，并让已有的匹配分缓存失效。不可撤销。', [], {
      cls: 'danger-zone',
      aside: h('button', { class: 'btn btn-danger', text: '清除画像', onclick: confirmClearProfile }),
    }),
  );
}

function fillScore(box) {
  const ps = scoreProfile(profile);
  const ring = h('div', { class: 'ring' + (ps.score >= 60 ? ' ok' : '') }, [h('span', { text: ps.score + '%' })]);
  ring.style.setProperty('--p', ps.score);
  box.replaceChildren(
    ring,
    h('div', { class: 'score-info' }, [
      h('div', { class: 'score-title', text: ps.missing.length ? `完整度 ${ps.completed}/${ps.total} 项` : '画像已经填齐了' }),
      ps.missing.length
        ? h('div', { class: 'missing' }, [
            h('span', { class: 'missing-label', text: '还缺：' }),
            ...ps.missing.map((m) =>
              h('button', { class: 'chip chip-link', text: m, title: '跳到这一项', onclick: () => focusField(MISSING_FIELD[m]) }),
            ),
          ])
        : h('div', { class: 'missing', text: '可以随时补充项目经历和成就，让招呼语更具体。' }),
    ]),
  );
}

function focusField(key) {
  const el = key && mainEl.querySelector(`[data-field="${key}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // 重新触发高亮动画
  el.classList.add('flash');
  const input = el.querySelector('input, textarea');
  if (input) setTimeout(() => input.focus({ preventScroll: true }), 300);
}

function renderImport() {
  const body = h('div');
  const p = panel('从简历导入', '文件只在本机解析成文本，再交给 AI 抽取；抽取结果要你确认后才写入画像。', [body], {
    aside: segmented([['file', '上传文件'], ['text', '粘贴文本']], importMode, (v) => { importMode = v; route(); }),
  });

  if (importMode === 'file') {
    const fileInput = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,.json', hidden: true });
    const zone = h('div', { class: 'upload-zone', role: 'button', tabindex: '0' }, [
      h('div', { class: 'up-icon' }, [icon('upload', { size: 26 })]),
      h('div', { class: 'up-main', text: '点击选择简历，或把文件拖到这里' }),
      h('div', { class: 'up-sub', text: '支持 PDF / DOCX / TXT' }),
    ]);
    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
    body.append(zone, fileInput);
  } else {
    const pasteArea = h('textarea', { placeholder: '把简历全文粘贴到这里…', rows: 7 });
    body.append(
      pasteArea,
      h('div', { class: 'row', style: 'margin-top:10px' }, [
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const t = pasteArea.value.trim();
            if (!t) return toast('请先粘贴简历文本', true);
            extract(t);
          },
        }, [icon('spark'), 'AI 抽取画像']),
      ]),
    );
  }
  if (draft) body.appendChild(renderDraft());
  return p;
}

async function handleFile(file) {
  const overlay = showBusy('正在解析简历文件…');
  try {
    const { text } = await parseResumeFile(file);
    overlay.close();
    await extract(text);
  } catch (e) {
    overlay.close();
    toast(e.message, true);
  }
}

async function extract(text) {
  if (!providers.length) {
    toast('从简历抽取需要先配置 AI 接口', true);
    return go('ai');
  }
  const overlay = showBusy('AI 正在抽取画像…');
  try {
    draft = sanitizeProfile(await send(MSG.AI_RESUME_EXTRACT, { text }));
    toast('抽取完成，请确认后写入');
    route();
    const box = mainEl.querySelector('.draft-box');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    toast(e.message, true);
  } finally {
    overlay.close();
  }
}

function renderDraft() {
  const d = draft;
  const rows = [
    ['目标岗位', d.target.jobTitles],
    ['目标城市', d.target.cities],
    ['期望薪资', d.target.salaryMinK ? `${d.target.salaryMinK}-${d.target.salaryMaxK || ''}k` : ''],
    ['工作年限', d.basics.yearsOfExperience ? d.basics.yearsOfExperience + ' 年' : ''],
    ['学历', d.basics.education],
    ['当前职位', d.basics.currentTitle],
    ['技能', d.capabilities.skills],
    ['优势', d.capabilities.strengths],
    ['行业经验', d.capabilities.industryExperience],
    ['工作概述', d.workSummary],
    ['项目概述', d.projectSummary],
    ['核心成就', d.highlights],
  ].filter(([, v]) => v && v.length);
  return h('div', { class: 'draft-box' }, [
    h('div', { class: 'draft-head' }, [icon('spark'), h('span', { text: `AI 抽取到 ${rows.length} 项，确认后写入画像` })]),
    h('dl', { class: 'draft-preview' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: Array.isArray(v) ? v.join('、') : String(v) })])),
    h('div', { class: 'draft-actions' }, [
      h('button', {
        class: 'btn btn-primary',
        title: '已有内容保留，新内容补充进去',
        text: '合并到画像',
        onclick: async () => {
          profile = sanitizeProfile(await track(send(MSG.PROFILE_SAVE, { profile: mergeDraft(profile, draft) })));
          draft = null;
          toast('已合并到画像');
          route();
        },
      }),
      h('button', {
        class: 'btn',
        text: '用它替换现有画像',
        onclick: () => showModal({
          title: '替换现有画像？',
          body: '现有画像会被抽取结果整体覆盖（没抽到的项会变空）。',
          confirmText: '替换',
          onConfirm: async () => {
            profile = sanitizeProfile(await track(send(MSG.PROFILE_SAVE, { profile: draft })));
            draft = null;
            toast('已替换画像');
            route();
          },
        }),
      }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', text: '放弃', onclick: () => { draft = null; route(); } }),
    ]),
  ]);
}

function renderProfileForm() {
  const p = profile;
  const save = debounce(async () => {
    profile = sanitizeProfile(await track(send(MSG.PROFILE_SAVE, { profile })));
    const box = mainEl.querySelector('.score-card');
    if (box) fillScore(box);
    refreshNav();
  }, 600);

  const text = (obj, key, ph, type = 'text') => {
    const input = h('input', { type, value: obj[key] ?? '', placeholder: ph || '', min: type === 'number' ? 0 : null });
    input.addEventListener('input', () => {
      obj[key] = type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      save();
    });
    return input;
  };
  const list = (obj, key, ph) => tagEditor(obj[key], (arr) => { obj[key] = arr; save(); }, ph);
  const area = (obj, key, ph) => {
    const ta = h('textarea', { placeholder: ph || '', rows: 3 });
    ta.value = obj[key] || '';
    ta.addEventListener('input', () => { obj[key] = ta.value; save(); });
    return ta;
  };

  return [
    panel('求职目标', '决定哪些岗位算「对口」。', [
      field('目标岗位', list(p.target, 'jobTitles', '如 前端工程师，回车添加'), { key: 'jobTitles' }),
      field('目标城市', list(p.target, 'cities', '如 广州'), { key: 'cities' }),
      h('div', { class: 'grid-3' }, [
        field('期望月薪下限', h('span', { class: 'num-wrap' }, [text(p.target, 'salaryMinK', '如 15', 'number'), h('span', { class: 'num-unit', text: 'k' })]), { key: 'salaryMinK' }),
        field('期望月薪上限', h('span', { class: 'num-wrap' }, [text(p.target, 'salaryMaxK', '如 25', 'number'), h('span', { class: 'num-unit', text: 'k' })])),
        field('目标行业', list(p.target, 'industries', '如 互联网')),
      ]),
    ]),
    panel('个人基础', null, [
      h('div', { class: 'grid-3' }, [
        field('工作年限', h('span', { class: 'num-wrap' }, [text(p.basics, 'yearsOfExperience', '如 3', 'number'), h('span', { class: 'num-unit', text: '年' })]), { key: 'yearsOfExperience' }),
        field('最高学历', text(p.basics, 'education', '如 本科'), { key: 'education' }),
        field('当前 / 最近职位', text(p.basics, 'currentTitle', '如 高级前端'), { key: 'currentTitle' }),
      ]),
      field('姓名', text(p.basics, 'name', '可留空'), { hint: '只在本机展示，默认不发送给 AI' }),
    ]),
    panel('能力与经历', '技能和经历是匹配打分的主要依据。', [
      field('专业技能', list(p.capabilities, 'skills', '如 React、TypeScript'), { key: 'skills' }),
      field('优势亮点', list(p.capabilities, 'strengths', '一句一条'), { key: 'strengths' }),
      field('行业经验', list(p.capabilities, 'industryExperience', '如 电商、金融'), { key: 'industryExperience' }),
      field('工作经历概述', area(p, 'workSummary', '一段话概述工作经历'), { key: 'workSummary' }),
      field('项目经历概述', area(p, 'projectSummary', '代表性项目'), { key: 'projectSummary' }),
      field('核心成就', list(p, 'highlights', '可量化的成果，一条一个'), { hint: '招呼语和简历建议会优先引用这里的内容' }),
    ]),
    panel('偏好与禁区', '告诉 AI 你不想要什么。', [
      field('规避关键词', list(p.preference, 'avoidKeywords', '如 外包、驻场'), { hint: '命中会在匹配分析里列为风险' }),
      field('硬性排除', list(p.preference, 'dealbreakers', '如 需要出差'), { hint: '命中会直接判为不匹配' }),
      field('给 AI 的额外说明', area(p.preference, 'notes', '任何想让 AI 知道的补充')),
    ]),
  ];
}

function confirmClearProfile() {
  showModal({
    title: '清除个人画像？',
    body: '将清空全部画像字段，并使已生成的岗位匹配分缓存失效。此操作不可撤销。',
    confirmText: '确认清除',
    danger: true,
    onConfirm: async () => {
      profile = sanitizeProfile(await track(send(MSG.PROFILE_CLEAR)));
      toast('画像已清除');
      route();
    },
  });
}

// ============================================================
//  AI 接口
// ============================================================
const expandedProv = new Set(); // 展开编辑的供应商（会话态）；默认只展开当前启用的
let focusProvId = null; // 刚添加的供应商：渲染后滚过去并聚焦 API Key

function renderAi() {
  if (!providers.length) {
    mainEl.appendChild(
      notice({ tone: 'tip', ic: 'plug', title: '还没有配置 AI 接口', desc: '在下方选一个预设（DeepSeek、OpenAI、通义等）添加，填上 API Key 和模型就能用。' }),
    );
  }
  const activeId = settings.activeProviderId || (providers[0] && providers[0].id);
  if (activeId && !expandedProv.size) expandedProv.add(activeId);
  for (const prov of providers) mainEl.appendChild(renderProviderCard(prov, prov.id === activeId));

  if (providers.length) mainEl.appendChild(renderUsagePanel());

  const presetSel = h('select', { class: 'preset-select' }, PRESETS.map((p) => opt(p.key, p.name + (p.hint ? ` — ${p.hint}` : ''))));
  mainEl.appendChild(
    panel('添加供应商', '选一个预设一键创建，或选「自定义供应商」手动填写。', [
      h('div', { class: 'row' }, [
        presetSel,
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const prov = providerFromPreset(presetSel.value);
            await saveProviders([...providers, prov]);
            if (!settings.activeProviderId) await saveSettings({ activeProviderId: prov.id });
            expandedProv.add(prov.id);
            focusProvId = prov.id;
            toast('已添加，填上 API Key 和模型就能用');
            route();
          },
        }, [icon('plus'), '添加']),
      ]),
    ]),
  );

  if (focusProvId) {
    const card = mainEl.querySelector(`[data-prov="${focusProvId}"]`);
    focusProvId = null;
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const key = card.querySelector('input[data-key="apiKey"]');
      if (key) setTimeout(() => key.focus({ preventScroll: true }), 300);
    }
  }
}

// 用量与缓存：本地缓存直接省掉的请求 + 供应商前缀缓存命中的输入 token
function renderUsagePanel() {
  const body = h('div', { class: 'usage-body', text: '加载中…' });
  const reset = h('button', { class: 'linklike muted', text: '清零' });
  const p = panel('用量与缓存', '同一岗位、同一画像不会重复请求；连续分析多个岗位时，固定的提示词和画像部分会命中供应商的前缀缓存，只按约一成价格计费。', [body], { aside: reset });
  const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
  const fill = (u) => {
    if (!u.calls && !u.localHits) {
      body.replaceChildren(h('div', { class: 'muted', text: '还没有 AI 调用记录' }));
      return;
    }
    const rate = u.input ? Math.round((u.cached / u.input) * 100) : 0;
    const saved = u.localHits && u.calls + u.localHits ? Math.round((u.localHits / (u.calls + u.localHits)) * 100) : 0;
    const stat = (label, value, sub, tone) =>
      h('div', { class: 'usage-stat' + (tone ? ' ' + tone : '') }, [h('div', { class: 'usage-value', text: value }), h('div', { class: 'usage-label', text: label }), sub ? h('div', { class: 'usage-sub', text: sub }) : null]);
    body.replaceChildren(
      h('div', { class: 'usage-grid' }, [
        stat('AI 请求', `${u.calls} 次`, u.since ? `自 ${new Date(u.since).toLocaleDateString('zh-CN')}` : ''),
        stat('本地缓存复用', `${u.localHits} 次`, `省掉了 ${saved}% 的请求`, u.localHits ? 'good' : ''),
        stat('输入命中供应商缓存', `${rate}%`, `${fmt(u.cached)} / ${fmt(u.input)} token`, rate >= 30 ? 'good' : ''),
        stat('输出', `${fmt(u.output)} token`, u.calls ? `平均每次 ${Math.round(u.output / u.calls)}` : ''),
      ]),
      u.calls >= 5 && !u.cached
        ? h('div', { class: 'field-hint', text: '供应商没有返回缓存命中：可能是这个供应商 / 模型不支持前缀缓存，或提示词加画像还没达到它的最低缓存长度。DeepSeek、OpenAI、Gemini、通义、Claude 都支持。' })
        : '', // replaceChildren 会把 null 当成文字，这里用空串
    );
  };
  send(MSG.AI_USAGE_GET).then(fill).catch((e) => body.replaceChildren(h('div', { class: 'muted', text: e.message })));
  reset.addEventListener('click', async () => fill(await send(MSG.AI_USAGE_RESET)));
  return p;
}

function provStatus(prov) {
  const v = validateProvider(prov);
  if (!v.ok) return { tone: 'warn', text: '待完善', title: v.errors.join('；') };
  if (!isProviderUsable(prov)) return { tone: 'warn', text: '缺 API Key' };
  return null;
}

function renderProviderCard(prov, isActive) {
  const open = expandedProv.has(prov.id);
  const status = provStatus(prov);
  const commit = debounce(() => saveProviders(providers), 500);
  const bind = (key, { type = 'text', ph = '' } = {}) => {
    const input = h('input', { type, value: prov[key] ?? '', placeholder: ph, dataset: { key } });
    input.addEventListener('input', () => {
      prov[key] = type === 'number' ? Number(input.value) : input.value;
      commit();
    });
    return input;
  };

  let host = '';
  try { host = new URL(prov.baseUrl).host; } catch {}
  const toggle = () => {
    if (open) expandedProv.delete(prov.id);
    else expandedProv.add(prov.id);
    route();
  };

  const head = h('div', { class: 'prov-head' }, [
    h('button', { class: 'prov-toggle', 'aria-expanded': open ? 'true' : 'false', onclick: toggle }, [
      icon('chevron', { cls: 'prov-chevron' + (open ? ' open' : '') }),
      h('span', { class: 'prov-name', text: prov.name || '未命名供应商' }),
    ]),
    isActive ? h('span', { class: 'prov-badge', text: '当前启用' }) : null,
    status ? h('span', { class: 'chip chip-orange', text: status.text, title: status.title || '' }) : null,
    h('div', { class: 'spacer' }),
    !isActive
      ? h('button', {
          class: 'btn btn-sm',
          text: '设为启用',
          onclick: async () => {
            await saveSettings({ activeProviderId: prov.id });
            expandedProv.add(prov.id);
            toast(`已启用 ${prov.name}`);
            route();
          },
        })
      : null,
  ]);
  const summary = h('div', { class: 'prov-summary', text: [PROTOCOL_LABELS[prov.protocol], prov.model || '未填模型', host].filter(Boolean).join(' · ') });

  const card = h('div', { class: 'prov-card' + (isActive ? ' active' : '') + (open ? ' open' : ''), dataset: { prov: prov.id } }, [head, summary]);
  if (!open) return card;

  const protoSel = h('select', {}, PROTOCOLS.map((p) => opt(p, PROTOCOL_LABELS[p])));
  protoSel.value = prov.protocol;
  protoSel.addEventListener('change', async () => {
    prov.protocol = protoSel.value;
    await saveProviders(providers);
    route();
  });

  const modelInput = bind('model', { ph: '如 gpt-4o-mini' });
  const modelList = h('datalist', { id: `models-${prov.id}` }, prov.discoveredModels.map((m) => opt(m, m)));
  modelInput.setAttribute('list', `models-${prov.id}`);
  // datalist 在部分 Chrome / 扩展页面里点击时不会弹候选（没有可见的箭头），
  // 拉取到模型后再给一个真正的 <select>，保证“展开下拉框”一定可用。
  const modelSelect = prov.discoveredModels.length
    ? h('select', { class: 'model-select', 'aria-label': '选择已拉取的模型' }, [
        opt('', `选择模型（${prov.discoveredModels.length} 个）`),
        ...prov.discoveredModels.map((m) => opt(m, m)),
      ])
    : null;
  if (modelSelect) {
    modelSelect.value = prov.discoveredModels.includes(prov.model) ? prov.model : '';
    modelSelect.addEventListener('change', async () => {
      if (!modelSelect.value) return;
      prov.model = modelSelect.value;
      modelInput.value = prov.model;
      await saveProviders(providers);
      toast(`已选择模型 ${prov.model}`);
    });
    // 手动改模型 ID 时同步下拉，避免两个控件显示不同模型
    modelInput.addEventListener('input', () => {
      const v = modelInput.value.trim();
      modelSelect.value = prov.discoveredModels.includes(v) ? v : '';
    });
  }

  const keyInput = bind('apiKey', { type: 'password', ph: 'sk-...' });
  const keyWrap = h('div', { class: 'secret' }, [
    keyInput,
    iconBtn('eye', '显示 / 隐藏', (e) => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      e.currentTarget.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    }),
  ]);

  const advWrap = h('div', { class: 'adv', hidden: true }, [
    prov.protocol === 'anthropic' ? field('anthropic-version', bind('anthropicVersion', { ph: '2023-06-01' })) : null,
    h('div', { class: 'grid-2' }, [
      field('temperature', bind('temperature', { type: 'number', ph: '0.3' }), { hint: '越低越稳定，分析建议 0.2–0.4' }),
      field('max tokens', bind('maxTokens', { type: 'number', ph: '2048' })),
    ]),
    field('自定义请求 URL', bind('requestUrl', { ph: '留空则用 Base URL 自动拼接' })),
    field('自定义模型列表 URL', bind('modelsUrl', { ph: '留空则用 Base URL/models' })),
    field('额外请求头（JSON）', extraHeadersEditor(prov, commit)),
  ]);
  const advToggle = h('button', { class: 'linklike adv-toggle', 'aria-expanded': 'false' }, [icon('chevron', { size: 12, cls: 'adv-chevron' }), '高级设置']);
  advToggle.addEventListener('click', () => {
    advWrap.hidden = !advWrap.hidden;
    advToggle.setAttribute('aria-expanded', String(!advWrap.hidden));
    advToggle.classList.toggle('open', !advWrap.hidden);
  });

  const resultEl = h('div', { class: 'test-slot' });
  card.appendChild(
    h('div', { class: 'prov-body' }, [
      h('div', { class: 'grid-2' }, [field('名称', bind('name')), field('协议', protoSel)]),
      field('API Base URL', bind('baseUrl', { ph: 'https://api.example.com/v1' })),
      h('div', { class: 'grid-2' }, [
        field(prov.protocol === 'gemini' ? 'API Key（通过 query 传递）' : 'API Key', keyWrap, { hint: '只保存在本机' }),
        field('模型 ID', h('div', { class: 'model-field' }, [modelInput, modelList, modelSelect].filter(Boolean)), { hint: prov.discoveredModels.length ? `已拉取 ${prov.discoveredModels.length} 个模型，可从下拉框选择，也可直接输入` : '可点「拉取模型列表」获取候选' }),
      ]),
      advToggle,
      advWrap,
      resultEl,
      h('div', { class: 'prov-actions' }, [
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => testProv(prov, resultEl) }, [icon('send'), '测试连接']),
        h('button', { class: 'btn btn-sm', onclick: () => fetchModels(prov, resultEl) }, [icon('download'), '拉取模型列表']),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-sm btn-ghost danger-text',
          onclick: () => showModal({
            title: `删除「${prov.name}」？`,
            body: isActive ? '这是当前启用的供应商，删除后会自动启用列表里的下一个。' : '删除后需要重新填写 API Key。',
            confirmText: '删除',
            danger: true,
            onConfirm: async () => {
              await saveProviders(providers.filter((x) => x.id !== prov.id));
              if (settings.activeProviderId === prov.id) await saveSettings({ activeProviderId: providers[0]?.id || '' });
              expandedProv.delete(prov.id);
              toast('已删除');
              route();
            },
          }),
        }, [icon('trash'), '删除']),
      ]),
    ]),
  );
  return card;
}

function extraHeadersEditor(prov, commit) {
  const ta = h('textarea', { rows: 2, placeholder: '{"X-Custom":"value"}' });
  const err = h('div', { class: 'field-hint err', hidden: true, text: '不是合法的 JSON 对象，暂不保存' });
  ta.value = Object.keys(prov.extraHeaders || {}).length ? JSON.stringify(prov.extraHeaders) : '';
  ta.addEventListener('input', () => {
    const v = ta.value.trim();
    let obj = {};
    try {
      if (v) obj = JSON.parse(v);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    } catch {
      ta.classList.add('invalid');
      err.hidden = false;
      return;
    }
    ta.classList.remove('invalid');
    err.hidden = true;
    prov.extraHeaders = obj;
    commit();
  });
  return h('div', {}, [ta, err]);
}

function setResult(el, tone, text) {
  el.replaceChildren(
    tone === 'busy'
      ? h('div', { class: 'test-result' }, [h('span', { class: 'spinner spinner-sm' }), text])
      : h('div', { class: `test-result test-${tone}` }, [icon(tone === 'ok' ? 'check' : 'alert', { size: 14 }), h('span', { text })]),
  );
}

async function testProv(prov, el) {
  const v = validateProvider(prov);
  if (!v.ok) return setResult(el, 'err', '配置有误：' + v.errors.join('；'));
  setResult(el, 'busy', '测试中…');
  try {
    const r = await send(MSG.AI_PROVIDER_TEST, { provider: prov });
    if (r.ok) setResult(el, 'ok', `${r.message}${r.sample ? '（模型回复：' + r.sample + '）' : ''}`);
    else setResult(el, 'err', r.message);
  } catch (e) {
    setResult(el, 'err', e.message);
  }
}

async function fetchModels(prov, el) {
  setResult(el, 'busy', '拉取模型中…');
  try {
    const list = await send(MSG.AI_PROVIDER_MODELS, { provider: prov });
    prov.discoveredModels = Array.isArray(list) ? list : [];
    await saveProviders(providers);
    if (!prov.discoveredModels.length) {
      setResult(el, 'err', '接口没有返回模型列表。部分供应商不支持列出模型，可手动填写模型 ID，或在「高级设置」里填写自定义模型列表 URL。');
      return;
    }
    toast(`发现 ${prov.discoveredModels.length} 个模型，可在模型 ID 下方下拉框选择`);
    route();
  } catch (e) {
    setResult(el, 'err', e.message + '（部分供应商不支持列出模型，可手动填写模型 ID）');
  }
}

// ============================================================
//  岗位筛选
// ============================================================
function renderFilters() {
  const f = settings.filters;
  const preview = h('div', { class: 'filter-preview' });
  let previewJobs = null;
  const updatePreview = () => fillFilterPreview(preview, previewJobs, f);
  send(MSG.JOB_LIST_REQUEST).then((list) => { previewJobs = list; updatePreview(); }).catch(() => {});

  const save = debounce(() => saveSettings({ filters: f }), 400);
  const changed = () => { updatePreview(); save(); };
  const list = (key, ph) => tagEditor(f[key], (arr) => { f[key] = arr; changed(); }, ph);
  const num = (key, ph) => {
    const input = h('input', { type: 'number', min: 0, value: f[key] ?? '', placeholder: ph });
    input.addEventListener('input', () => { f[key] = input.value === '' ? null : Number(input.value); changed(); });
    return h('span', { class: 'num-wrap' }, [input, h('span', { class: 'num-unit', text: 'k/月' })]);
  };

  const body = h('div', { class: 'filter-body' + (f.enabled ? '' : ' is-off') });
  mainEl.appendChild(
    panel(null, null, [
      setRow('启用本地筛选', '关闭时收录并显示全部岗位，只标注风险词', f.enabled, (v) => {
        f.enabled = v;
        body.classList.toggle('is-off', !v);
        changed();
      }),
      preview,
    ]),
  );

  body.append(
    panel('关键词', '在岗位名、JD、标签里查找；不区分大小写。', [
      field('包含关键词', list('keywordsInclude', '如 前端、React'), { hint: '配置后，岗位至少要命中其中一个' }),
      field('排除关键词', list('keywordsExclude', '如 电销、催收'), { hint: '命中任一就隐藏' }),
      field('风险词', list('riskKeywords', '如 外包、驻场'), { hint: '只在卡片上标红提示，不隐藏' }),
      field('屏蔽公司', list('excludeCompanies', '公司名关键词'), { hint: '公司名包含就隐藏' }),
      field('工作地址排除词', list('addressExclude', '如 银行、软件园'), { hint: '地址包含就隐藏，比如驻场在银行的岗位。BOSS 的详细地址要补全详情后才有' }),
    ]),
    panel('条件', null, [
      field('城市', list('cities', '如 广州、深圳'), { hint: '包含任一即保留' }),
      h('div', { class: 'grid-2' }, [field('薪资下限', num('salaryMinK', '如 12')), field('薪资上限', num('salaryMaxK', '如 30'))]),
      h('div', { class: 'grid-2' }, [
        field('经验偏好', list('experience', '如 1-3年'), { hint: '软提示，不硬性剔除' }),
        field('学历偏好', list('degrees', '如 本科'), { hint: '软提示，不硬性剔除' }),
      ]),
      setRow('隐藏 HR 长期未活跃的岗位', 'HR 数月 / 半年未活跃的岗位不显示（关闭时仍会标红并排到最后）', !!f.excludeStaleHr, (v) => { f.excludeStaleHr = v; changed(); }),
    ]),
  );
  mainEl.appendChild(body);
}

// 实时预览：按当前规则，岗位库里有多少会被隐藏、主要原因
function fillFilterPreview(el, jobs, f) {
  if (!jobs) {
    el.replaceChildren(h('span', { class: 'muted', text: '正在统计岗位库…' }));
    return;
  }
  if (!jobs.length) {
    el.replaceChildren(icon('info', { size: 14 }), h('span', { text: '岗位库还是空的，收录岗位后这里会显示规则的效果' }));
    return;
  }
  if (!f.enabled) {
    el.replaceChildren(icon('info', { size: 14 }), h('span', { text: `未启用：岗位库 ${jobs.length} 个岗位全部显示` }));
    return;
  }
  const reasons = new Map();
  let hidden = 0;
  for (const j of jobs) {
    const ev = evaluateJob(j, f);
    if (ev.keep) continue;
    hidden++;
    for (const r of ev.reasons.length ? ev.reasons : ['不满足条件']) reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  el.replaceChildren(
    icon(hidden ? 'filter' : 'check', { size: 14 }),
    h('span', {}, [
      h('b', { text: hidden ? `按当前规则，岗位库 ${jobs.length} 个岗位中会隐藏 ${hidden} 个` : `按当前规则，岗位库 ${jobs.length} 个岗位都会显示` }),
      top.length ? h('span', { class: 'muted', text: '　' + top.map(([r, n]) => `${r} ${n}`).join(' · ') }) : null,
    ]),
  );
}

// ============================================================
//  自动化
// ============================================================
function renderAutomation() {
  if (halt) {
    mainEl.appendChild(
      notice({
        tone: 'warn',
        ic: 'pause',
        title: '后台补全已暂停',
        desc: `${halt.reason}${halt.until ? `，${fmtTime(halt.until)} 后自动恢复` : ''}`,
        actions: [{
          label: '解除暂停',
          primary: true,
          onClick: async () => {
            const r = await send(MSG.WORKER_HALT_CLEAR);
            halt = r && r.halt;
            toast('已解除暂停');
            route();
          },
        }],
      }),
    );
  }

  mainEl.appendChild(
    panel('运行模式', '自动 = 跟随当前打开的招聘站点；也可以锁定只看某一个平台。', [
      segmented([[MODE.auto, '自动'], [MODE.boss, 'BOSS 直聘'], [MODE.qcwy, '前程无忧']], settings.mode, async (v) => {
        await saveSettings({ mode: v });
        route();
      }),
    ]),
  );

  const save = (patch) => saveSettings(patch);
  mainEl.appendChild(
    panel('自动流程', '收录 → 补全详情 → AI 匹配，每一步都可以单独关掉。', [
      setRow('自动收录岗位', '浏览招聘网站的岗位列表时自动收录', settings.autoCapture, (v) => save({ autoCapture: v })),
      setRow('BOSS 后台补全详情', '在后台标签页逐个打开详情页，读取 JD 与 HR 活跃时间后关闭。插件不直接请求平台接口；按下方节奏限速，遇到验证页自动暂停', settings.autoFetchDetail, (v) => save({ autoFetchDetail: v })),
      setRow('自动 AI 分析', '详情就绪后自动做匹配分析（消耗 AI token）', settings.autoScore, (v) => save({ autoScore: v })),
      setRow('去重', '同一个岗位只保留一条', settings.dedupe, (v) => save({ dedupe: v })),
      setRow('页面角标', '在招聘网站页面右下角显示收录进度', settings.showBadge, (v) => save({ showBadge: v })),
      ctlRow('AI 同时分析数', '自动、批量、手动合计（1–8）。受 AI 供应商限流约束，遇到限流会自动暂停 2 分钟',
        numInput({ value: settings.aiConcurrency, min: 1, max: 8, unit: '个', onCommit: async (v) => (await save({ aiConcurrency: v ?? 1 })).aiConcurrency })),
    ]),
  );
  mainEl.appendChild(renderPacingPanel());
}

function pacingSummary(p) {
  return `同时 ${p.detailConcurrency} 个 · 间隔 ${p.gapMinSec}–${p.gapMaxSec} 秒 · 每小时最多 ${p.hourlyCap} 个`;
}

function renderPacingPanel() {
  const body = h('div');
  const tag = h('span');
  const p = panel('后台标签页节奏', '补全详情、同步沟通页时打开后台标签页的节奏。时长都在区间内偏态随机（多数偏短、偶尔较长）。你主动点「AI 分析」触发的补全不休息、只用较短间隔。', [body], { aside: tag });

  const savePacing = async (patch) => (await saveSettings({ pacing: patch })).pacing;
  const currentPreset = () => {
    const cur = settings.pacing;
    return Object.keys(PACING_PRESETS).find((k) => Object.entries(PACING_PRESETS[k]).every(([f, v]) => f === 'label' || cur[f] === v)) || 'custom';
  };

  const num = (key, opts = {}) =>
    numInput({ value: settings.pacing[key], width: 70, ...opts, onCommit: async (v) => { const np = await savePacing({ [key]: v }); draw(false); return np[key]; } });
  const range = (label, desc, kMin, kMax, unit) =>
    ctlRow(label, desc, h('span', { class: 'range' }, [num(kMin), h('span', { class: 'range-sep', text: '–' }), num(kMax), h('span', { class: 'num-unit', text: unit })]));

  function draw(full = true) {
    const preset = currentPreset();
    tag.replaceChildren(preset === 'custom' ? h('span', { class: 'chip chip-accent', text: '自定义' }) : h('span'));
    const cards = h('div', { class: 'preset-cards', role: 'radiogroup' },
      Object.entries(PACING_PRESETS).map(([k, v]) =>
        h('button', {
          class: 'preset-card' + (preset === k ? ' active' : ''),
          role: 'radio',
          'aria-checked': preset === k ? 'true' : 'false',
          onclick: async () => {
            const { label, ...vals } = v;
            await savePacing(vals);
            draw();
          },
        }, [
          h('div', { class: 'preset-name' }, [v.label, k === 'standard' ? h('span', { class: 'preset-rec', text: '推荐' }) : null]),
          h('div', { class: 'preset-desc', text: pacingSummary(v) }),
        ]),
      ),
    );
    if (!full) {
      // 只改了某个数值：刷新预设高亮，不重建输入框（避免丢焦点）
      const old = body.querySelector('.preset-cards');
      if (old) old.replaceWith(cards);
      return;
    }

    const hours = h('input', { type: 'text', value: settings.pacing.activeHours, placeholder: '08:00-23:30', style: 'width:130px' });
    hours.addEventListener('change', async () => {
      const v = hours.value.trim();
      const ok = !v || /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(v);
      hours.classList.toggle('invalid', !ok);
      if (!ok) return toast('格式应为 08:00-23:30，留空表示不限', true);
      await savePacing({ activeHours: v });
    });

    body.replaceChildren(
      cards,
      ctlRow('同时打开标签页', '同时补几个岗位的详情（1–5）。越多越快，被平台判定异常的风险也越高；打开时刻仍会错开', num('detailConcurrency', { min: 1, max: 5, unit: '个' })),
      range('打开间隔', '两次打开之间等多久（同时开 N 个时平均间隔约为它的 1/N，最短 1.5 秒）', 'gapMinSec', 'gapMaxSec', '秒'),
      range('页面停留', '读完数据后在页面上停多久再关（JD 越长停得越久）', 'dwellMinSec', 'dwellMaxSec', '秒'),
      range('每看几个休息一次', '处理了随机若干个之后歇一会儿', 'breakEveryMin', 'breakEveryMax', '个'),
      range('休息时长', null, 'breakMinSec', 'breakMaxSec', '秒'),
      ctlRow('上限', '每小时 / 每天最多打开的后台标签页数。到了上限会暂停，侧边栏可以「立即继续」', h('span', { class: 'range' }, [
        num('hourlyCap', { min: 1, max: 1000, unit: '/ 时', width: 80 }),
        num('dailyCap', { min: 1, max: 5000, unit: '/ 天', width: 80 }),
      ])),
      ctlRow('活跃时段', '只在这个时段内自动运行，可跨午夜；留空不限', hours),
      setRow('电脑空闲时暂停', '超过 3 分钟没有键盘鼠标操作就暂停，回来后继续', settings.pacing.onlyWhenActive, (v) => savePacing({ onlyWhenActive: v })),
      setRow('停留时慢慢滚动', '在详情页停留期间分几次向下滚动，像在阅读', settings.pacing.simulateScroll, (v) => savePacing({ simulateScroll: v })),
    );
  }
  draw();
  return p;
}

// ============================================================
//  自动投递
// ============================================================
function renderAutoApply() {
  const cfg = settings.autoApply;
  const save = debounce(() => saveSettings({ autoApply: cfg }), 350);
  const saveNow = () => saveSettings({ autoApply: cfg });
  const changed = () => { refreshNav(); save(); };

  mainEl.appendChild(
    notice({
      tone: 'warn',
      ic: 'alert',
      title: '自动投递会真实点击「立即沟通」',
      desc: '每天定时在后台打开 BOSS 搜索页收录岗位，完成后生成待确认清单；只有你在侧边栏点「确认投递」后，才会逐个打开岗位页点「立即沟通」。不会自动发送任何聊天消息。请控制数量、保持默认节奏，并遵守平台服务条款。',
    }),
  );

  // —— 状态 ——
  const statusBox = h('div', { class: 'auto-status' });
  let pollTimer = null;
  const refresh = async () => {
    try {
      applyStatus = await send(MSG.AUTO_APPLY_STATUS_GET);
    } catch {}
    paint(applyStatus);
    refreshNav();
    schedulePoll();
  };
  const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (current !== 'autoapply' || !applyStatus) return;
    if (applyStatus.search?.running || applyStatus.run?.state === 'running') {
      pollTimer = setTimeout(() => { if (current === 'autoapply') refresh().catch(() => {}); }, 2500);
    }
  };
  const paint = (st) => {
    statusBox.replaceChildren();
    if (!st) {
      statusBox.appendChild(h('div', { class: 'muted', text: '正在读取状态…' }));
      return;
    }
    const s = st.search || {};
    const counts = (st.batch && st.batch.counts) || {};
    const run = st.run || {};
    if (s.running) {
      statusBox.appendChild(notice({ tone: 'tip', ic: 'refresh', compact: true, title: '正在自动搜索 BOSS…', desc: '会依次搜索配置的岗位关键词；完成后自动补详情、AI 匹配，并把新岗位补进今日清单。' }));
    } else if (s.lastSearchStatus === 'error') {
      statusBox.appendChild(notice({ tone: 'warn', ic: 'alert', compact: true, title: '上次自动搜索失败', desc: s.lastSearchError || '未知错误' }));
    } else if (s.lastSearchStatus === 'empty') {
      statusBox.appendChild(notice({ tone: 'info', ic: 'info', compact: true, title: '上次搜索没有新增岗位', desc: s.lastSearchError || '' }));
    } else if (s.lastSearchStatus === 'capped') {
      statusBox.appendChild(notice({ tone: 'info', ic: 'info', compact: true, title: '今日自动收录已达上限', desc: s.lastSearchError || '' }));
    } else if (s.lastSearchAt) {
      statusBox.appendChild(notice({ tone: 'tip', ic: 'check', compact: true, title: `上次搜索：${fmtTime(s.lastSearchAt)}`, desc: `新增 ${s.lastSearchCount || 0} 个岗位` }));
    }
    if (!settings.autoScore) {
      statusBox.appendChild(notice({ tone: 'warn', ic: 'alert', compact: true, title: '自动 AI 分析未开启', desc: '投递清单依赖匹配分，请先到「自动化」开启自动 AI 分析。', actions: [{ label: '去开启', primary: true, onClick: () => go('automation') }] }));
    }

    const stat = h('div', { class: 'auto-stats' }, [
      statCell('待确认', counts.pending || 0, 'accent'),
      statCell('已沟通', counts.applied || 0, 'green'),
      statCell('已关闭', counts.rejected || 0, 'muted'),
      statCell('清单日期', st.batch?.date || '—', 'muted'),
    ]);
    statusBox.appendChild(stat);
    const collect = st.collect || {};
    const listCap = (st.config && st.config.dailyCap) || 0;
    statusBox.appendChild(
      h('div', { class: 'auto-collect', text: `今日自动收录 ${collect.count || 0} / ${collect.cap || 0} 个岗位（用于补详情与 AI 匹配）` }),
    );
    statusBox.appendChild(
      h('div', { class: 'auto-collect', text: `今日清单 ${counts.total || 0} / ${listCap || 0} 个（含已关闭 / 已投 / 已跳过）` }),
    );

    if (run.state === 'running') {
      const done = (run.done || 0) + (run.failed || 0);
      const pct = run.total ? Math.round((done / run.total) * 100) : 0;
      statusBox.appendChild(
        h('div', { class: 'auto-run' }, [
          h('div', { class: 'auto-run-head' }, [
            h('span', { class: 'spinner spinner-sm' }),
            h('b', { text: `正在投递 ${done} / ${run.total}` }),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn btn-xs', text: '停止', onclick: async () => { await send(MSG.APPLY_STOP).catch(() => {}); toast('已请求停止，当前岗位完成后结束'); refresh(); } }),
          ]),
          h('div', { class: 'auto-progress' }, [h('span', { class: 'auto-progress-fill', style: `width:${pct}%` })]),
        ]),
      );
    } else if (run.state === 'done' || run.state === 'stopped' || run.state === 'error') {
      const tone = run.state === 'error' ? 'warn' : 'tip';
      statusBox.appendChild(notice({
        tone,
        ic: run.state === 'error' ? 'alert' : 'check',
        compact: true,
        title: run.state === 'error' ? '上次投递中断' : run.state === 'stopped' ? '投递已停止' : '上次投递完成',
        desc: `成功 ${run.done || 0} 个${run.failed ? ` · 失败 ${run.failed} 个` : ''}${run.error ? ` · ${run.error}` : ''}`,
      }));
    }

    const next = s.nextRunAt ? fmtTime(s.nextRunAt) : '';
    statusBox.appendChild(
      h('div', { class: 'auto-actions' }, [
        h('button', { class: 'btn btn-sm btn-primary', disabled: s.running, onclick: runNow }, [icon('zap'), '立即运行一次']),
        h('button', { class: 'btn btn-sm', onclick: refreshList }, [icon('refresh'), '刷新今日清单']),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: openSidePanelUi }, [icon('external'), '在侧边栏查看']),
        next ? h('span', { class: 'auto-next', text: `下次自动运行：${next}` }) : null,
      ]),
    );
  };
  async function runNow() {
    try {
      const r = await send(MSG.AUTO_APPLY_RUN_NOW);
      toast(r && r.started ? '已开始每日搜索，完成后清单会自动更新' : '任务已经在运行');
      setTimeout(refresh, 800);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function refreshList() {
    try {
      applyStatus = await send(MSG.APPLY_REFRESH);
      paint(applyStatus);
      refreshNav();
      toast('今日清单已更新');
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function openSidePanelUi() {
    try {
      const w = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: w.id });
    } catch {
      send(MSG.OPEN_SIDEPANEL).catch(() => {});
    }
  }

  paint(applyStatus);
  schedulePoll();
  mainEl.appendChild(panel('今日状态', '清单每天生成一次；之后补完详情 / 匹配的岗位会自动追加，已确认或已关闭的不会被覆盖。', [statusBox]));

  // —— 每日搜索配置 ——
  const timeInput = h('input', { type: 'time', value: cfg.dailyTime, style: 'width:120px' });
  timeInput.addEventListener('change', async () => {
    if (!timeInput.value) return;
    cfg.dailyTime = timeInput.value;
    await saveNow();
    refresh();
  });

  const cityNames = Object.keys(BOSS_CITY_CODES);
  const citySel = h('select', {}, [...cityNames.map((n) => opt(n, n === '全国' ? '全国（不限城市）' : n)), opt('custom', '其他（手动填编码）')]);
  citySel.value = cityNames.includes(cfg.cityName) ? cfg.cityName : 'custom';
  const codeInput = h('input', { type: 'text', value: cfg.cityCode, placeholder: '如 101280100', style: 'width:150px' });
  citySel.addEventListener('change', () => {
    if (citySel.value !== 'custom') {
      cfg.cityName = citySel.value;
      cfg.cityCode = BOSS_CITY_CODES[citySel.value];
      codeInput.value = cfg.cityCode;
    } else {
      // 手动填编码时不做本地城市名过滤（只靠搜索 URL 的 city= 限定）
      cfg.cityName = '自定义';
    }
    changed();
  });
  codeInput.addEventListener('change', () => {
    const v = codeInput.value.trim();
    if (v && !/^\d{6,12}$/.test(v)) return toast('城市编码应为 6–12 位数字，可在 BOSS 城市页 URL 的 city= 后找到', true);
    cfg.cityCode = v || BOSS_CITY_CODES[cfg.cityName] || '100010000';
    codeInput.value = cfg.cityCode;
    const mapped = BOSS_CITY_CODES[cfg.cityName];
    // 手改编码且与当前城市不匹配：切换为「自定义」，避免用旧城市名做本地过滤
    if (citySel.value === 'custom' || !cityNames.includes(cfg.cityName) || (v && mapped && v !== mapped)) {
      cfg.cityName = '自定义';
      citySel.value = 'custom';
    }
    changed();
  });

  const expChips = multiChips(EXPERIENCE_OPTIONS, cfg.experience, (arr) => { cfg.experience = arr; changed(); });
  const salary = (key, ph) => {
    const input = h('input', { type: 'number', min: 0, value: cfg[key] ?? '', placeholder: ph });
    input.addEventListener('input', () => { cfg[key] = input.value === '' ? null : Number(input.value); changed(); });
    return h('span', { class: 'num-wrap' }, [input, h('span', { class: 'num-unit', text: 'k/月' })]);
  };

  const hrSel = h('select', {}, HR_ACTIVE_OPTIONS.map(([v, l]) => opt(String(v), l)));
  hrSel.value = String(cfg.hrActiveMaxTier);
  hrSel.addEventListener('change', () => { cfg.hrActiveMaxTier = Number(hrSel.value); changed(); });

  mainEl.appendChild(
    panel('每日搜索', '定时在后台打开 BOSS 搜索页，让页面自己加载岗位列表并向下滚动；插件只读页面已经取回的数据。', [
      setRow('启用每日自动搜索', '到达设定时间后自动运行；Chrome 没开时会顺延，错过太久不会在深夜补跑', cfg.enabled, (v) => {
        cfg.enabled = v;
        saveNow();
        refreshNav();
        if (v && !settings.autoScore) toast('提醒：还需要到「自动化」开启自动 AI 分析，清单才有匹配分', true);
        refresh();
      }),
      ctlRow('每天运行时间', '建议设置在电脑通常开机的时段。自动任务不受活跃时段限制，但仍受每小时 / 每天上限和验证熔断保护', timeInput),
      field('岗位关键词', tagEditor(cfg.keywords, (arr) => { cfg.keywords = arr; changed(); }, '如 前端、React；可填多个'), { hint: '多个关键词会依次搜索；留空不会运行' }),
      h('div', { class: 'grid-2' }, [
        field('城市', citySel, { hint: '选择常用城市，或选「其他」后填写编码' }),
        field('城市编码', codeInput, { hint: 'BOSS 搜索页 URL 里 city= 后面的数字' }),
      ]),
      field('工作年限要求', expChips, { hint: '可多选；按岗位年限区间重叠判断。不选 = 不限' }),
      h('div', { class: 'grid-2' }, [field('薪资下限', salary('salaryMinK', '如 15')), field('薪资上限', salary('salaryMaxK', '如 35'))]),
      field('HR 活跃要求', hrSel, { hint: '详情补齐后按 HR 最近活跃时间判断；越活跃越可能在招' }),
      h('div', { class: 'grid-2' }, [
        ctlRow('每次滚动', '每次搜索向下滚动几次，越多收录越多，也越慢', numInput({ value: cfg.scrolls, min: 1, max: 10, unit: '次', onCommit: async (v) => { cfg.scrolls = v ?? 4; const s = await saveSettings({ autoApply: cfg }); return s.autoApply.scrolls; } })),
        ctlRow('匹配分门槛', '低于这个分数的岗位不进清单', numInput({ value: cfg.threshold, min: 0, max: 100, unit: '分', onCommit: async (v) => { cfg.threshold = v ?? 70; const s = await saveSettings({ autoApply: cfg }); return s.autoApply.threshold; } })),
      ]),
      ctlRow('每日最多收录', '每天自动搜索最多新收录多少个岗位用于补详情和 AI 匹配；达到上限当天不再收录', numInput({ value: cfg.dailyCollectCap, min: 1, max: 300, unit: '个', onCommit: async (v) => { cfg.dailyCollectCap = v ?? 50; const s = await saveSettings({ autoApply: cfg }); refresh(); return s.autoApply.dailyCollectCap; } })),
      ctlRow('每日清单上限', '每天最多纳入多少个岗位；已关闭 / 已投 / 已跳过的也占当天名额，第二天重新计算', numInput({ value: cfg.dailyCap, min: 1, max: 100, unit: '个', onCommit: async (v) => { cfg.dailyCap = v ?? 20; const s = await saveSettings({ autoApply: cfg }); refresh(); return s.autoApply.dailyCap; } })),
      setRow('保留已沟通公司的其他岗位', '已沟通过的公司，其「未沟通」的岗位仍然纳入清单；已沟通过的岗位本身永远跳过', cfg.includeCompanyContacted, (v) => { cfg.includeCompanyContacted = v; saveNow(); refresh(); }),
    ]),
  );

  mainEl.appendChild(
    panel('确认后如何打开', '用户点「确认投递」后，按清单顺序逐个打开岗位页并点「立即沟通」。只发起沟通，不自动发消息。', [
      setRow('前台打开页面', '关闭时在后台标签页点击（不抢焦点，但你看不到过程）', cfg.applyForeground, (v) => { cfg.applyForeground = v; saveNow(); }),
      setRow('点完保留标签页', '关闭时进入沟通页后自动关掉标签页；开启则留着让你接着聊', cfg.applyKeepTab, (v) => { cfg.applyKeepTab = v; saveNow(); }),
      ctlRow('投递间隔', '两个岗位之间随机等待，避免连续点击', h('span', { class: 'range' }, [
        numInput({ value: cfg.applyGapMinSec, min: 5, max: 120, unit: '秒', width: 70, onCommit: async (v) => { cfg.applyGapMinSec = v ?? 5; const s = await saveSettings({ autoApply: cfg }); return s.autoApply.applyGapMinSec; } }),
        h('span', { class: 'range-sep', text: '–' }),
        numInput({ value: cfg.applyGapMaxSec, min: 5, max: 300, unit: '秒', width: 70, onCommit: async (v) => { cfg.applyGapMaxSec = v ?? 12; const s = await saveSettings({ autoApply: cfg }); return s.autoApply.applyGapMaxSec; } }),
      ])),
    ]),
  );
}

function multiChips(options, values, onChange) {
  const set = new Set(Array.isArray(values) ? values : []);
  const wrap = h('div', { class: 'chip-row' });
  const draw = () => {
    wrap.replaceChildren(
      ...options.map((v) =>
        h('button', {
          type: 'button',
          class: 'chip chip-toggle' + (set.has(v) ? ' active' : ''),
          'aria-pressed': set.has(v) ? 'true' : 'false',
          text: v,
          onclick: () => {
            if (set.has(v)) set.delete(v);
            else set.add(v);
            onChange([...set]);
            draw();
          },
        }),
      ),
    );
  };
  draw();
  return wrap;
}

function statCell(label, value, tone) {
  return h('div', { class: 'auto-stat' }, [
    h('div', { class: 'auto-stat-n' + (tone ? ' tone-' + tone : ''), text: String(value) }),
    h('div', { class: 'auto-stat-l', text: label }),
  ]);
}

// ============================================================
//  已沟通与屏蔽
// ============================================================
const LIST_PAGE = 50;

// 可搜索的行列表：rows 为 [{ key, title, sub, chip?, onRemove, removeTitle }]
function searchableList({ placeholder, empty }) {
  let rows = [];
  let q = '';
  let limit = LIST_PAGE;
  const search = h('input', { type: 'text', placeholder, class: 'list-search' });
  const box = h('div', { class: 'item-list' });
  const draw = () => {
    const ql = q.trim().toLowerCase();
    const hits = ql ? rows.filter((r) => `${r.title} ${r.sub || ''}`.toLowerCase().includes(ql)) : rows;
    box.replaceChildren(
      ...[
        ...(hits.length
        ? hits.slice(0, limit).map((r) =>
            h('div', { class: 'item-row' }, [
              h('div', { class: 'item-text' }, [h('div', { class: 'item-title', text: r.title }), r.sub ? h('div', { class: 'item-sub', text: r.sub }) : null]),
              r.chip ? h('span', { class: 'chip', text: r.chip }) : null,
              h('button', { class: 'btn btn-xs', text: r.removeText || '移除', title: r.removeTitle || '', onclick: r.onRemove }),
            ]),
          )
        : [h('div', { class: 'item-empty', text: ql ? '没有匹配的记录' : empty })]),
        hits.length > limit
          ? h('button', { class: 'linklike item-more', text: `再显示 ${Math.min(LIST_PAGE, hits.length - limit)} 条（共 ${hits.length} 条）`, onclick: () => { limit += LIST_PAGE; draw(); } })
          : null,
      ].filter(Boolean), // replaceChildren 会把 null 当成文字
    );
  };
  search.addEventListener('input', () => { q = search.value; limit = LIST_PAGE; draw(); });
  return {
    search,
    box,
    set(next) {
      rows = next;
      search.hidden = rows.length < 8; // 条目少时不需要搜索
      draw();
    },
  };
}

function renderLists() {
  const save = (patch) => saveSettings(patch);

  // —— 已沟通 ——
  const cInfo = h('div', { class: 'list-info', text: '加载中…' });
  const contacts = searchableList({ placeholder: '搜索公司或岗位', empty: '还没有已沟通记录' });
  const syncBtn = h('button', { class: 'btn btn-sm btn-primary' }, [icon('refresh'), '立即同步']);
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.replaceChildren(h('span', { class: 'spinner spinner-sm' }), '同步中…');
    try {
      const r = await send(MSG.CONTACTS_SYNC);
      if (r.error) toast(r.error, true);
      else toast(`同步完成，共 ${r.companies} 家公司`);
    } catch (e) {
      toast(e.message, true);
    }
    syncBtn.disabled = false;
    syncBtn.replaceChildren(icon('refresh'), '立即同步');
    fillContacts();
  });

  mainEl.appendChild(
    panel('已沟通', '来源：BOSS 沟通页（后台打开读取会话列表后自动关闭，每 9–15 小时自动同步；你自己打开沟通页时也会顺带同步）、插件里打过招呼的岗位、手动标记。', [
      setRow('跳过已沟通的岗位', '不再收录，批量 / 自动匹配也跳过', settings.skipContacted, (v) => save({ skipContacted: v })),
      setRow('跳过已沟通公司的其他岗位', '沟通过的公司，它的其他岗位也不再收录', settings.skipContactedCompanies, (v) => save({ skipContactedCompanies: v })),
      h('div', { class: 'list-toolbar' }, [cInfo, h('div', { class: 'spacer' }), syncBtn]),
      contacts.search,
      contacts.box,
      h('div', { class: 'list-foot' }, [
        h('button', {
          class: 'linklike danger-text',
          text: '清空已沟通记录',
          onclick: () => showModal({
            title: '清空已沟通记录？',
            body: '只清本地记录，不影响 BOSS 上的会话；下次同步会重新获取。',
            confirmText: '清空',
            danger: true,
            onConfirm: async () => { await send(MSG.CONTACTS_CLEAR); toast('已清空'); fillContacts(); },
          }),
        }),
      ]),
    ]),
  );

  const SRC = { chat: '沟通页', greeting: '插件打招呼', manual: '手动标记', auto_apply: '自动投递' };
  async function fillContacts() {
    try {
      const r = await send(MSG.CONTACTS_GET);
      halt = r.halt;
      refreshNav();
      cInfo.textContent = `${r.contacts.length} 条记录 · ${r.companies} 家公司 · 上次同步 ${r.syncedAt ? fmtTime(r.syncedAt) : '从未'}`;
      contacts.set(
        r.contacts.slice().reverse().map((c) => ({
          title: c.company || c.hrName || '未知公司',
          sub: c.title || '',
          chip: SRC[c.source] || c.source || '',
          removeText: '撤销',
          removeTitle: '删除这条记录，该岗位 / 公司会重新被收录',
          onRemove: async () => {
            await send(MSG.CONTACTS_REMOVE, { key: contactKey(c) });
            fillContacts();
          },
        })),
      );
    } catch (e) {
      cInfo.textContent = e.message;
    }
  }
  fillContacts();

  // —— 屏蔽 ——
  const blocked = searchableList({ placeholder: '搜索屏蔽的岗位', empty: '还没有屏蔽的岗位' });
  const clearAll = h('button', { class: 'btn btn-sm btn-ghost danger-text', text: '全部解除', hidden: true });
  mainEl.appendChild(
    panel('屏蔽的岗位', '在侧边栏「⋯ → 屏蔽该岗位」加入。解除后，再次浏览到时会重新收录。', [blocked.search, blocked.box], { aside: clearAll }),
  );
  async function fillBlocked() {
    const list = await send(MSG.BLOCKED_GET).catch(() => []);
    clearAll.hidden = !list.length;
    clearAll.onclick = () => showModal({
      title: '解除全部屏蔽？',
      body: `将解除 ${list.length} 个岗位的屏蔽。`,
      confirmText: '全部解除',
      danger: true,
      onConfirm: async () => { await send(MSG.BLOCKED_CLEAR); fillBlocked(); },
    });
    blocked.set(
      list.slice().reverse().map((b) => ({
        title: b.title || b.uid,
        sub: [b.company, b.at ? new Date(b.at).toLocaleDateString('zh-CN') : ''].filter(Boolean).join(' · '),
        chip: b.platform === 'boss' ? 'BOSS' : '51job',
        removeText: '解除',
        onRemove: async () => { await send(MSG.JOB_UNBLOCK, { uid: b.uid }); toast('已解除屏蔽'); fillBlocked(); },
      })),
    );
  }
  fillBlocked();
}

// ============================================================
//  隐私与数据
// ============================================================
function renderPrivacy() {
  const save = (patch) => saveSettings(patch);
  mainEl.appendChild(
    panel('发送给 AI 的数据', 'API Key 与全部数据只保存在本机；分析时只把必要的内容发给你配置的 AI 供应商。', [
      setRow('发送前脱敏', '隐去手机号、邮箱、联系方式、个人链接等', settings.privacy.redactPII, (v) => save({ privacy: { redactPII: v } })),
      setRow('发送岗位的公司名', '公司名一般是公开的招聘信息，发送可以提升分析质量', settings.privacy.sendCompanyName, (v) => save({ privacy: { sendCompanyName: v } })),
      setRow('打开沟通前确认招呼语', '在侧边栏点「打开沟通并复制」时，先弹窗确认要发送的内容', settings.privacy.confirmBeforeSend, (v) => save({ privacy: { confirmBeforeSend: v } })),
    ]),
  );

  mainEl.appendChild(
    panel('岗位数据', null, [
      ctlRow('岗位库上限', '超出后按最近出现时间淘汰（收藏的不淘汰）',
        numInput({ value: settings.maxJobs, min: 50, max: 5000, unit: '个', width: 90, onCommit: async (v) => (await save({ maxJobs: v || 800 })).maxJobs })),
      ctlRow('导出岗位库', '全部已收录岗位；侧边栏里也可以勾选后导出详细表格', h('div', { class: 'row' }, [
        h('button', { class: 'btn btn-sm', onclick: () => exportData('csv') }, [icon('download'), 'CSV']),
        h('button', { class: 'btn btn-sm', onclick: () => exportData('json') }, [icon('download'), 'JSON']),
      ])),
    ]),
  );

  mainEl.appendChild(
    panel('清空岗位库', '删除全部已收录岗位和分析结果。屏蔽名单、已沟通记录、个人画像不受影响。不可撤销。', [], {
      cls: 'danger-zone',
      aside: h('button', {
        class: 'btn btn-danger',
        text: '清空岗位库',
        onclick: () => showModal({
          title: '清空岗位库？', body: '删除全部已收录岗位，不可撤销。', confirmText: '清空', danger: true,
          onConfirm: async () => { await send(MSG.JOB_CLEAR_REQUEST); toast('已清空岗位库'); },
        }),
      }),
    }),
  );

  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch {}
  mainEl.appendChild(h('div', { class: 'about', text: `岗位筛选助手${version ? ' v' + version : ''} · 数据只保存在本机浏览器` }));
}

async function exportData(format) {
  try {
    const res = await send(MSG.JOB_EXPORT_REQUEST, { format });
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    const url = URL.createObjectURL(new Blob([res.content], { type: mime }));
    const ts = new Date().toISOString().slice(0, 10);
    await chrome.downloads.download({ url, filename: `岗位收录-${ts}.${format}`, saveAs: true });
    toast(`已导出 ${res.count} 个岗位`);
  } catch (e) {
    toast(e.message, true);
  }
}

boot();
