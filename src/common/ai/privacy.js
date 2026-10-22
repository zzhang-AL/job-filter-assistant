// 发送给第三方 AI 前的隐私脱敏。默认隐去联系方式、个人链接等敏感信息。
// 岗位公司名一般是公开招聘信息，是否发送由设置控制（默认发送以提升分析质量）。

export function redactText(text) {
  let s = String(text || '');
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱已隐藏]');
  // 手机号（中国大陆）
  s = s.replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu, '[手机号已隐藏]');
  // 微信/QQ/电话等联系方式
  s = s.replace(/(?:微信|WeChat|weixin|QQ|电话|手机|联系方式|VX|vx)\s*[:：]?\s*[A-Za-z0-9_+@.-]{4,}/giu, '[联系方式已隐藏]');
  // 常见个人主页/作品集链接
  s = s.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|behance\.net|dribbble\.com|zhihu\.com|gitee\.com)\/[^\s)]+/giu,
    '[个人链接已隐藏]',
  );
  // 身份证号
  s = s.replace(/(?<!\d)\d{17}[\dXx](?!\d)/gu, '[证件号已隐藏]');
  return s;
}

// 对画像做脱敏拷贝：默认剥离本地展示用的姓名
export function redactProfileForAi(profile, { includeName = false } = {}) {
  const p = JSON.parse(JSON.stringify(profile || {}));
  if (!includeName && p.basics) p.basics.name = '';
  if (p.preference && typeof p.preference.notes === 'string') {
    p.preference.notes = redactText(p.preference.notes);
  }
  if (typeof p.workSummary === 'string') p.workSummary = redactText(p.workSummary);
  if (typeof p.projectSummary === 'string') p.projectSummary = redactText(p.projectSummary);
  return p;
}

// 对岗位做脱敏拷贝：只挑分析需要的字段（不带旧的匹配结果、招呼语草稿、凭据等），键名用中文便于模型理解
// includeActivity=false：不发 HR 活跃度（它随时间变化，会让同一岗位每次请求都不同，缓存无法命中）
export function redactJobForAi(job, { includeCompany = true, includeActivity = true } = {}) {
  const j = job || {};
  const list = (x) => (Array.isArray(x) && x.length ? x.join('、') : '');
  const out = {
    岗位名称: j.title,
    薪资: j.salaryText,
    城市: [j.city, j.district].filter(Boolean).join(' · '),
    工作地址: j.address,
    经验要求: j.experience,
    JD写明的经验要求: j.experienceJd && j.experienceJd !== j.experience ? j.experienceJd : '',
    学历要求: j.degree,
    技能标签: list(j.skills),
    岗位标签: list(j.tags),
    福利: list(j.welfare),
    公司: includeCompany ? j.company : '[公司名已隐藏]',
    公司行业: j.companyIndustry,
    公司规模: j.companyScale,
    公司性质: j.companyType,
    融资阶段: j.companyStage,
    HR职位: j.hrTitle,
    HR最近活跃: includeActivity ? hrActivityForAi(j) : '',
    岗位描述: typeof j.description === 'string' && j.description.trim()
      ? redactText(j.description).slice(0, 3000)
      : '（未获取到岗位描述正文）',
  };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

// 活跃描述是相对观测时刻的（「3日内活跃」），附上距今多久观测到的，模型才能判断是否过时
function hrActivityForAi(j) {
  const text = j.hrActiveText || (j.hrOnline ? '在线' : '');
  if (!text) return '未知';
  const at = Date.parse(j.hrActiveAt || '');
  if (!Number.isFinite(at)) return text;
  const days = Math.floor((Date.now() - at) / 86400000);
  return days >= 1 ? `${text}（${days} 天前观测）` : text;
}
