// 平台适配层：把 BOSS / 51job 各自的原始接口响应，归一化为统一岗位对象。
// 字段依据 D:\boss分析 与 D:\前程分析 的真机逆向样本确定，非猜测。
import { PLATFORM } from './constants.js';

// 统一岗位 schema：
// { uid, platform, jobId, title, salaryText, salaryMinK, salaryMaxK,
//   city, district, experience, degree, skills[], tags[], welfare[],
//   company, companyIndustry, companyScale, companyType, companyStage,
//   hrName, hrTitle, hrOnline, hrActiveText, hrActiveAt, address, description, url, publishedAt,
//   raw{关键凭据}, savedAt }

// —— URL 判定：命中即认为是可嗅探的岗位列表/详情接口 ——
// 页面请求常用相对地址（如 /wapi/zpgeek/search/joblist.json），platformHint 给出所在平台，用它的域名补全；
// 没有提示时无法判断来源，相对地址一律不认。
const PLATFORM_ORIGIN = { [PLATFORM.boss]: 'https://www.zhipin.com', [PLATFORM.qcwy]: 'https://we.51job.com' };
export function matchPlatformApi(urlStr, platformHint) {
  let u;
  try {
    u = new URL(urlStr, PLATFORM_ORIGIN[platformHint] || 'https://x');
  } catch {
    return null;
  }
  const host = u.hostname;
  const path = u.pathname;
  // BOSS：/wapi/zpgeek/(search/joblist | pc/recommend/job/list | job/detail).json
  if (/(^|\.)zhipin\.com$/i.test(host)) {
    if (/\/wapi\/zpgeek\/(search\/joblist|pc\/recommend\/job\/list|mobile\/search\/joblist)\.json/.test(path)) {
      return { platform: PLATFORM.boss, kind: 'list' };
    }
    if (/\/wapi\/zpgeek\/(job\/detail|pc\/recommend\/job\/detail)\.json/.test(path)) {
      return { platform: PLATFORM.boss, kind: 'detail' };
    }
  }
  // 51job：we.51job.com/api/job/search-pc | search-h5
  if (/(^|\.)51job\.com$/i.test(host)) {
    if (/\/api\/job\/search-(pc|h5)/.test(path)) {
      return { platform: PLATFORM.qcwy, kind: 'list' };
    }
  }
  return null;
}

// —— 从站点 host 推断平台 ——
export function platformOfHost(host = '') {
  if (/(^|\.)zhipin\.com$/i.test(host)) return PLATFORM.boss;
  if (/(^|\.)51job\.com$/i.test(host)) return PLATFORM.qcwy;
  return null;
}

// —— 解析入口：给定平台 + 原始响应，返回归一化岗位数组 ——
// opts.url：详情接口的请求 URL；用于从 query 取 encryptJobId，保证 uid 与「当前岗位」信号一致。
// opts.jobKey：调用方已知的岗位标识（详情补全队列按 securityId 请求，URL 里没有 encryptJobId）。
export function normalizeResponse(platform, payload, opts = {}) {
  try {
    if (platform === PLATFORM.boss) return normalizeBoss(payload, opts);
    if (platform === PLATFORM.qcwy) return normalizeQcwy(payload);
  } catch (e) {
    return [];
  }
  return [];
}

// 从详情请求 URL 里取岗位标识（与 collector.jobKeyFromDetail 同源，保证 uid 对得上）
function jobKeyFromUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const q = new URL(urlStr, 'https://x').searchParams;
    return str(q.get('encryptJobId') || q.get('jobId') || q.get('jobid'));
  } catch {
    return '';
  }
}

// ============ BOSS 直聘 ============
// 信封 {code, message, zpData}；code===0 成功；列表在 zpData.jobList[]
function normalizeBoss(payload, opts = {}) {
  if (!isObj(payload)) return [];
  if (payload.code !== 0 && payload.code !== '0') return [];
  const zp = payload.zpData || {};
  const list = zp.jobList || zp.recommendJobList || (Array.isArray(zp) ? zp : []);
  if (Array.isArray(list) && list.length) return list.map(bossJob).filter(Boolean);
  const urlKey = str(opts.jobKey) || jobKeyFromUrl(opts.url);
  // 详情接口：无 jobList，改为 zpData.jobInfo（+ brandComInfo/bossInfo）单条
  if (zp.jobInfo) {
    const one = bossDetailJob(zp, urlKey);
    return one ? [one] : [];
  }
  // 悬停卡片接口 job/card.json：zpData.jobCard 单条，同样带 JD 与 HR 活跃时间
  if (zp.jobCard) {
    const one = bossCardJob(zp.jobCard, urlKey);
    return one ? [one] : [];
  }
  return [];
}

// 详情响应结构与列表不同：岗位在 zpData.jobInfo，公司在 zpData.brandComInfo，HR 在 zpData.bossInfo。
// 字段名依 D:\boss分析\probe_boss_detail.mjs 探针记录（showSkills/degreeName/locationName…）。
// 关键：只回填「非空」字段——mergeJobs 是 {...prev,...raw} 覆盖式合并，空串会抹掉列表已抓到的好数据。
function bossDetailJob(zp, urlKey = '') {
  const info = zp.jobInfo || {};
  const brand = zp.brandComInfo || {};
  const boss = zp.bossInfo || {};
  // uid 必须与「当前岗位」信号(collector 从 URL query 取的 encryptJobId)一致，否则面板匹配不上。
  // 所以 URL 里的 key 优先，其次才用响应体字段。
  const jobId = str(urlKey) || str(info.encryptId) || str(info.encryptJobId) || str(info.jobId);
  if (!jobId) return null;
  const salaryText = str(info.salaryDesc);
  const [minK, maxK] = parseSalary(salaryText);
  const full = {
    uid: `${PLATFORM.boss}:${jobId}`,
    platform: PLATFORM.boss,
    jobId,
    title: str(info.jobName),
    salaryText,
    salaryMinK: minK,
    salaryMaxK: maxK,
    city: str(info.locationName) || str(info.cityName),
    district: joinNonEmpty([info.areaDistrict, info.businessDistrict], '·'),
    experience: str(info.experienceName) || str(info.jobExperience),
    degree: str(info.degreeName) || str(info.jobDegree),
    // 详情的经验 / 学历要求比列表标签更准：打标后，之后再从列表收录到同一岗位也不覆盖
    experienceFrom: str(info.experienceName) || str(info.jobExperience) ? 'detail' : '',
    degreeFrom: str(info.degreeName) || str(info.jobDegree) ? 'detail' : '',
    experienceJd: extractExperienceFromJd(str(info.postDescription) || str(info.jobDesc) || str(info.postDesc)),
    skills: arrStr(info.showSkills) || arrStr(info.skills),
    tags: arrStr(info.jobLabels),
    welfare: arrStr(brand.welfareList) || arrStr(info.welfareList),
    company: str(brand.brandName),
    companyIndustry: str(brand.industryName) || str(brand.brandIndustry),
    companyScale: str(brand.scaleName) || str(brand.brandScaleName),
    companyStage: str(brand.stageName) || str(brand.brandStageName),
    hrName: str(boss.name) || str(boss.bossName),
    hrTitle: str(boss.title) || str(boss.bossTitle),
    ...bossActive(boss.activeTimeDesc, boss.bossOnline),
    address: str(info.address) || str(info.locationAddress), // 详细工作地址（列表接口只有区/商圈）
    description: str(info.postDescription) || str(info.jobDesc) || str(info.postDesc),
    url: jobId ? `https://www.zhipin.com/job_detail/${jobId}.html` : '',
    raw: {
      encryptJobId: jobId,
      securityId: str(info.securityId),
      encryptBrandId: str(brand.encryptBrandId),
    },
  };
  // 剔除空值，避免覆盖列表已有数据（uid/platform/jobId 始终保留）
  return pruneEmpty(full, ['uid', 'platform', 'jobId']);
}

// 悬停卡片（job/card.json）：字段平铺在 jobCard 上，规则同详情——只回填非空字段
function bossCardJob(c, urlKey = '') {
  const jobId = str(urlKey) || str(c.encryptJobId) || str(c.encryptId);
  if (!jobId) return null;
  return pruneEmpty({
    uid: `${PLATFORM.boss}:${jobId}`,
    platform: PLATFORM.boss,
    jobId,
    title: str(c.jobName),
    hrName: str(c.bossName),
    hrTitle: str(c.bossTitle),
    ...bossActive(c.activeTimeDesc, c.online),
    address: str(c.address),
    description: str(c.postDescription),
    experienceJd: extractExperienceFromJd(str(c.postDescription)),
  }, ['uid', 'platform', 'jobId']);
}

// HR 活跃状态：activeTimeDesc 形如「刚刚活跃 / 3日内活跃 / 本月活跃」；在线时可能为空，用「在线」补位。
// hrActiveAt 记录观测时间——活跃描述是相对时间，脱离观测时刻就没意义。
function bossActive(desc, online) {
  const text = str(desc) || (online === true ? '在线' : '');
  return {
    hrOnline: typeof online === 'boolean' ? online : undefined,
    hrActiveText: text,
    hrActiveAt: text ? new Date().toISOString() : '',
  };
}

// 去掉空字符串、空数组、null/undefined 的字段（keep 列表里的键无条件保留）
function pruneEmpty(obj, keep = []) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keep.includes(k)) { out[k] = v; continue; }
    if (v == null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (isObj(v)) {
      const inner = pruneEmpty(v, []);
      if (Object.keys(inner).length === 0) continue;
      out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function bossJob(o) {
  if (!isObj(o)) return null;
  const jobId = str(o.encryptJobId) || str(o.jobId);
  if (!jobId && !str(o.jobName)) return null;
  const salaryText = str(o.salaryDesc);
  const [minK, maxK] = parseSalary(salaryText);
  const url = o.encryptJobId
    ? `https://www.zhipin.com/job_detail/${o.encryptJobId}.html`
    : str(o.jobHref);
  return {
    uid: `${PLATFORM.boss}:${jobId}`,
    platform: PLATFORM.boss,
    jobId,
    title: str(o.jobName),
    salaryText,
    salaryMinK: minK,
    salaryMaxK: maxK,
    city: str(o.cityName),
    district: joinNonEmpty([o.areaDistrict, o.businessDistrict], '·'),
    experience: str(o.jobExperience),
    degree: str(o.jobDegree),
    skills: arrStr(o.skills),
    tags: arrStr(o.jobLabels),
    welfare: arrStr(o.welfareList),
    company: str(o.brandName),
    companyIndustry: str(o.brandIndustry),
    companyScale: str(o.brandScaleName),
    companyType: '',
    companyStage: str(o.brandStageName),
    hrName: str(o.bossName),
    hrTitle: str(o.bossTitle),
    hrOnline: !!o.bossOnline, // 列表只有在线布尔值，具体活跃时间需详情接口
    description: '', // BOSS 列表不含 JD 正文，需详情接口
    url,
    publishedAt: '',
    raw: {
      securityId: str(o.securityId),
      encryptJobId: str(o.encryptJobId),
      encryptBrandId: str(o.encryptBrandId),
      lid: str(o.lid),
    },
  };
}

// 从 JD 正文里找明确写出的经验年限要求，如「3年以上」「3-5年」「五年及以上」。
// 只认紧挨「经验 / 工作 / 开发」等字样的说法，「优先 / 加分」这种软要求不算；找不到返回空串。
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function extractExperienceFromJd(text) {
  const s = str(text);
  if (!s) return '';
  const n = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十])';
  const re = new RegExp(`${n}\\s*(?:[-~至到]\\s*${n}\\s*)?年(以上|及以上|或以上)?[^，。；;,\\n]{0,12}?(经验|工作|开发|从业)`, 'g');
  let m;
  while ((m = re.exec(s))) {
    // 同一句里带「优先 / 加分」的是软要求
    const tail = s.slice(m.index, m.index + m[0].length + 8);
    if (/优先|加分|更佳|最好/.test(tail)) continue;
    const v = (x) => (x in CN_NUM ? CN_NUM[x] : Number(x));
    const a = v(m[1]);
    if (!(a > 0 && a <= 20)) continue;
    if (m[2]) return `${a}-${v(m[2])}年`;
    return m[3] ? `${a}年以上` : `${a}年`;
  }
  return '';
}

// ============ BOSS 沟通页：已沟通的公司/岗位 ============
// 沟通页会话列表（/wapi/zprelation/friend/*）与会话详情（/wapi/zpchat/geek/getBossData）的响应。
// 各接口结构不一，这里宽松地在 zpData 里找「带公司名或岗位 ID 的对象」，每个视作一条沟通记录。
export function extractBossContacts(payload) {
  if (!isObj(payload) || (payload.code !== 0 && payload.code !== '0')) return [];
  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (depth > 4 || node == null) return;
    if (Array.isArray(node)) {
      node.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (!isObj(node)) return;
    const company = str(node.brandName) || str(node.companyName) || str(node.brandComName) || str(node.comName);
    const jobId = str(node.encryptJobId) || str(node.jobEncryptId);
    if (company || jobId) {
      const c = { jobId, title: str(node.jobName) || str(node.positionName), company, hrName: str(node.name) || str(node.bossName) };
      const key = contactKey(c);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
    for (const v of Object.values(node)) if (typeof v === 'object') visit(v, depth + 1);
  };
  visit(payload.zpData, 0);
  return out;
}

// 公司名归一：去空白、全角括号统一、小写，用于跨接口精确比对
export function normCompany(s) {
  return str(s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
}

export function contactKey(c) {
  if (!c) return '';
  if (c.jobId) return `job:${c.jobId}`;
  const co = normCompany(c.company);
  if (!co) return '';
  return c.title ? `pair:${co}|${str(c.title)}` : `co:${co}`;
}

// 由沟通记录建索引，供收录/匹配时快速判定
export function buildContactIndex(contacts) {
  const jobIds = new Set();
  const pairs = new Set();
  const companies = new Set();
  for (const c of Array.isArray(contacts) ? contacts : []) {
    if (c.jobId) jobIds.add(c.jobId);
    const co = normCompany(c.company);
    if (co) {
      companies.add(co);
      if (c.title) pairs.add(`${co}|${str(c.title)}`);
    }
  }
  return { jobIds, pairs, companies };
}

// 岗位的沟通状态：'job' = 沟通过这个岗位；'company' = 沟通过这家公司的其他岗位；'' = 未沟通
export function contactStatus(job, idx) {
  if (!job || !idx) return '';
  if (job.jobId && idx.jobIds.has(job.jobId)) return 'job';
  const co = normCompany(job.company);
  if (!co) return '';
  if (idx.pairs.has(`${co}|${str(job.title)}`)) return 'job';
  return idx.companies.has(co) ? 'company' : '';
}

// ============ 前程无忧 51job ============
// 信封 {status, message, resultbody}；status==="1" 成功；列表在 resultbody.job.items[]
function normalizeQcwy(payload) {
  if (!isObj(payload)) return [];
  const okStatus = payload.status === '1' || payload.status === 1;
  if (!okStatus && !payload.resultbody) return [];
  const rb = payload.resultbody || payload.resultBody || {};
  const items = (rb.job && rb.job.items) || rb.items || [];
  if (!Array.isArray(items)) return [];
  return items.map(qcwyJob).filter(Boolean);
}

function qcwyJob(o) {
  if (!isObj(o)) return null;
  const jobId = str(o.jobId);
  if (!jobId && !str(o.jobName)) return null;
  const salaryText = str(o.provideSalaryString);
  let minK = numK(o.jobSalaryMin);
  let maxK = numK(o.jobSalaryMax);
  if (minK == null && maxK == null) {
    [minK, maxK] = parseSalary(salaryText);
  }
  const area = o.jobAreaLevelDetail || {};
  return {
    uid: `${PLATFORM.qcwy}:${jobId}`,
    platform: PLATFORM.qcwy,
    jobId,
    title: str(o.jobName),
    salaryText,
    salaryMinK: minK,
    salaryMaxK: maxK,
    city: str(area.cityString) || firstArea(o.jobAreaString),
    district: str(area.districtString) || restArea(o.jobAreaString),
    experience: str(o.workYearString),
    degree: str(o.degreeString),
    skills: qcwyTags(o),
    tags: arrStr(o.jobTags),
    welfare: qcwyWelfare(o.jobWelfareCodeDataList),
    company: str(o.fullCompanyName) || str(o.companyName),
    companyIndustry: str(o.coIndustryText) || str(o.industryType1Str),
    companyScale: str(o.companySizeString),
    companyType: str(o.companyTypeString),
    companyStage: '',
    hrName: str(o.hrName),
    hrTitle: str(o.hrPosition),
    description: str(o.jobDescribe), // 51job 列表直接带完整 JD
    experienceJd: extractExperienceFromJd(str(o.jobDescribe)),
    url: str(o.jobHref),
    publishedAt: str(o.issueDateString) || str(o.confirmDateString),
    raw: {
      encCoId: str(o.encCoId),
      coId: str(o.coId),
      funcType1Code: str(o.funcType1Code),
    },
  };
}

function qcwyTags(o) {
  // jobTags 里混了经验/学历/技能/福利，取中间偏技能的词；这里保守用 jobTags 去掉明显的经验学历
  const tags = arrStr(o.jobTags);
  return tags.filter((t) => !/^\d|年$|本科|大专|硕士|博士|学历|应届|经验/.test(t)).slice(0, 12);
}

function qcwyWelfare(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => str(x && x.chineseTitle)).filter(Boolean);
}

// ============ 工具函数 ============
function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function str(x) {
  return typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim();
}
function arrStr(x) {
  if (!Array.isArray(x)) return [];
  const seen = new Set();
  const out = [];
  for (const v of x) {
    const s = str(typeof v === 'object' && v ? v.name || v.jobTagName || v.labelName : v);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
function joinNonEmpty(arr, sep) {
  return arr.map(str).filter(Boolean).join(sep);
}
function firstArea(s) {
  const parts = str(s).split(/[·\-]/);
  return parts[0] || '';
}
function restArea(s) {
  const parts = str(s).split(/[·\-]/);
  return parts.slice(1).join('·');
}
function numK(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 1000) * 10) / 10; // 元 -> 千元
}

// 解析中文薪资串："1.1-1.8万·13薪" / "10-13K·13薪" / "5千-1万" / "8-12k"
// 返回 [minK, maxK]（千元/月）。解析不出返回 [null, null]。
export function parseSalary(text) {
  const s = str(text);
  if (!s) return [null, null];
  // 抓取 "数字[单位]-数字[单位]" 或单值
  const unit = (u) => (u === '万' || u === 'w' || u === 'W' ? 10 : u === '千' || u === 'k' || u === 'K' ? 1 : null);
  const re = /(\d+(?:\.\d+)?)\s*([万千kKwW])?\s*[-~到]\s*(\d+(?:\.\d+)?)\s*([万千kKwW])?/;
  const m = s.match(re);
  if (m) {
    const u2 = unit(m[4]) ?? unit(m[2]) ?? 1; // 末位单位优先，缺省按千元
    const u1 = unit(m[2]) ?? u2;
    let lo = parseFloat(m[1]) * u1;
    let hi = parseFloat(m[3]) * u2;
    lo = round1(lo);
    hi = round1(hi);
    if (lo > hi) [lo, hi] = [hi, lo];
    return [lo, hi];
  }
  // 单值
  const m2 = s.match(/(\d+(?:\.\d+)?)\s*([万千kKwW])/);
  if (m2) {
    const v = round1(parseFloat(m2[1]) * (unit(m2[2]) ?? 1));
    return [v, v];
  }
  return [null, null];
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
