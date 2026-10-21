// 全局常量：存储键、消息类型、平台定义。
import { defaultPacing } from './pacing.js';
// 被 background 与各 UI 页以 ES module 方式引入；content-script 侧有独立副本（见 src/content）。

export const STORAGE_KEYS = {
  settings: 'jobHelperSettingsV1',
  profile: 'jobHelperProfileV1',
  jobs: 'jobHelperJobsV1',
  aiProviders: 'jobHelperAiProvidersV1',
  matchCache: 'jobHelperMatchCacheV1',
  lastReport: 'jobHelperLastCaptureReportV1',
  blocked: 'jobHelperBlockedV1', // 屏蔽名单：独立于岗位库，清空岗位库不影响
  contacts: 'jobHelperContactsV1', // 已沟通的公司/岗位（来自 BOSS 沟通页 + 本插件打招呼）
};

// 平台标识
export const PLATFORM = {
  boss: 'boss',
  qcwy: 'qcwy', // 前程无忧 51job
};

export const PLATFORM_META = {
  [PLATFORM.boss]: {
    id: PLATFORM.boss,
    name: 'BOSS 直聘',
    short: 'BOSS',
    color: '#00a6a7',
    hosts: ['zhipin.com', 'www.zhipin.com'],
    searchUrl: 'https://www.zhipin.com/web/geek/jobs',
  },
  [PLATFORM.qcwy]: {
    id: PLATFORM.qcwy,
    name: '前程无忧 51job',
    short: '51job',
    color: '#eb6100',
    hosts: ['we.51job.com', 'www.51job.com', 'jobs.51job.com'],
    searchUrl: 'https://we.51job.com/pc/search',
  },
};

// 运行模式：auto = 跟随当前站点；其余为强制单平台视图
export const MODE = {
  auto: 'auto',
  boss: PLATFORM.boss,
  qcwy: PLATFORM.qcwy,
};

// 消息协议（background <-> content <-> UI）
export const MSG = {
  // 岗位数据流
  JOBS_CAPTURED: 'JOBS_CAPTURED', // content -> bg：嗅探到的原始岗位
  JOBS_UPDATED: 'JOBS_UPDATED', // bg -> UI：岗位库变化广播
  JOB_LIST_REQUEST: 'JOB_LIST_REQUEST', // UI -> bg：拉取岗位库
  JOB_DELETE: 'JOB_DELETE',
  JOB_CLEAR_REQUEST: 'JOB_CLEAR_REQUEST',
  JOB_STAR_TOGGLE: 'JOB_STAR_TOGGLE',
  JOB_EXPORT_REQUEST: 'JOB_EXPORT_REQUEST',
  GREETING_SAVE: 'GREETING_SAVE', // UI -> bg：保存用户编辑后的招呼语
  JOB_BLOCK: 'JOB_BLOCK', // UI -> bg：屏蔽岗位（移出岗位库，后续不再收录）
  JOB_UNBLOCK: 'JOB_UNBLOCK',
  BLOCKED_GET: 'BLOCKED_GET',
  BLOCKED_CLEAR: 'BLOCKED_CLEAR',

  // 已沟通记录
  CONTACTS_CAPTURED: 'CONTACTS_CAPTURED', // content -> bg：沟通页嗅探到的会话列表原始响应 / DOM 抓取结果
  CONTACTS_GET: 'CONTACTS_GET',
  CONTACTS_CLEAR: 'CONTACTS_CLEAR',
  CONTACTS_UPDATED: 'CONTACTS_UPDATED', // bg -> UI：已沟通/屏蔽名单变化广播
  CONTACTS_SYNC: 'CONTACTS_SYNC', // UI -> bg：后台标签页打开沟通页同步一次
  CONTACTS_MARK: 'CONTACTS_MARK', // UI -> bg：手动把岗位标记为已沟通
  CONTACTS_REMOVE: 'CONTACTS_REMOVE', // UI -> bg：删除某条已沟通记录（撤销误标）

  // 后台标签页任务（插件不直接请求平台，靠打开真实页面读取）
  TAB_ROLE: 'TAB_ROLE', // content -> bg：本标签是否为后台任务页（detail / contacts）
  WORKER_RESULT: 'WORKER_RESULT', // content -> bg：后台任务页读取完成，可关闭
  DETAIL_PROGRESS: 'DETAIL_PROGRESS', // bg -> content：详情补全进度（角标显示）
  WORKER_HALT_CLEAR: 'WORKER_HALT_CLEAR', // UI -> bg：手动解除熔断
  AUTO_STATUS: 'AUTO_STATUS', // bg -> UI：自动分析进度 / 最近错误
  AUTO_STATUS_GET: 'AUTO_STATUS_GET', // UI -> bg

  // 页面上下文
  ACTIVE_CONTEXT_REQUEST: 'ACTIVE_CONTEXT_REQUEST', // UI -> bg：当前激活标签的平台 + 当前岗位
  PAGE_CONTEXT_CHANGED: 'PAGE_CONTEXT_CHANGED', // content -> bg：平台/URL/当前岗位 变化

  // 发送招呼语（一键发给 HR）
  SEND_GREETING: 'SEND_GREETING', // UI -> bg -> content：把招呼语填入聊天框并发送

  // 当前查看的岗位（用户在网站上点开某个岗位详情时）
  CURRENT_JOB: 'CURRENT_JOB', // content -> bg -> UI：当前岗位切换（携带 platform + jobKey）

  // 设置 & 画像
  SETTINGS_GET: 'SETTINGS_GET',
  SETTINGS_SAVE: 'SETTINGS_SAVE',
  PROFILE_GET: 'PROFILE_GET',
  PROFILE_SAVE: 'PROFILE_SAVE',
  PROFILE_CLEAR: 'PROFILE_CLEAR',

  // AI 供应商
  AI_PROVIDERS_GET: 'AI_PROVIDERS_GET',
  AI_PROVIDERS_SAVE: 'AI_PROVIDERS_SAVE',
  AI_PROVIDER_TEST: 'AI_PROVIDER_TEST', // 连通性测试
  AI_PROVIDER_MODELS: 'AI_PROVIDER_MODELS', // 拉取模型列表

  // AI 能力
  AI_RESUME_EXTRACT: 'AI_RESUME_EXTRACT', // 简历文本 -> 画像草稿
  AI_MATCH_SCORE: 'AI_MATCH_SCORE', // 单岗位匹配打分
  AI_MATCH_BATCH: 'AI_MATCH_BATCH', // 批量匹配
  BATCH_START: 'BATCH_START', // UI -> bg：开始批量分析（后台流水线：详情一就绪就立即匹配）
  BATCH_STATUS: 'BATCH_STATUS', // UI -> bg：批量进度
  BATCH_CANCEL: 'BATCH_CANCEL', // UI -> bg：停止批量分析
  AI_TAILOR_RESUME: 'AI_TAILOR_RESUME', // 按岗位 JD 生成简历定制建议（不落库，会话内使用）

  // 面板控制
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  OPEN_SIDEPANEL: 'OPEN_SIDEPANEL',
  OPEN_JOB_CHAT: 'OPEN_JOB_CHAT', // 新建标签页打开岗位并自动进入与 HR 的沟通（保留当前标签），配合剪贴板手动粘贴
};

// content-script 嗅探事件的 window.postMessage 频道
export const SNIFFER_CHANNEL = 'job-helper:sniffer';

// 默认设置
export function defaultSettings() {
  return {
    mode: MODE.auto,
    autoCapture: true, // 浏览时自动收录嗅探到的岗位
    autoFetchDetail: true, // BOSS 列表滚动收录后，后台逐条补抓详情（JD 正文 + HR 活跃时间），限速串行
    skipContacted: true, // 已沟通过的岗位不再收录、不参与批量/自动匹配
    skipContactedCompanies: true, // 沟通过的公司，其其他岗位也不再收录
    autoScore: true, // 收录 → 补全详情 → 自动 AI 匹配（需已配置 AI 接口；消耗 token，可在设置中关闭）
    aiConcurrency: 3, // 同时进行的 AI 分析数（受 AI 供应商限流约束，与 BOSS 风控无关）
    settingsRev: 3, // 设置迁移版本：<2 打开 autoScore；<3 把旧「标准」额度 60/时·300/天 升到新标准
    pacing: defaultPacing(), // 后台标签页节奏（模拟人工：随机间隔 / 停留 / 休息 / 活跃时段）
    showBadge: true, // 在岗位卡片上显示匹配角标
    dedupe: true,
    maxJobs: 800, // 岗位库上限，超出按时间淘汰
    activeProviderId: '', // 当前启用的 AI 供应商
    privacy: {
      redactPII: true, // 发送前脱敏
      sendCompanyName: true, // 岗位公司名一般是公开信息，默认发送
      confirmBeforeSend: false,
    },
    filters: defaultFilters(),
  };
}

// 本地筛选规则（不消耗 AI，先过一遍）
export function defaultFilters() {
  return {
    enabled: false,
    keywordsInclude: [], // 命中任一即保留（岗位名/JD/标签）
    keywordsExclude: [], // 命中任一即排除
    riskKeywords: ['外包', '驻场', '猎头', '销售', '电销', '中介'], // 风险词标注（不强制排除）
    cities: [],
    salaryMinK: null, // 期望月薪下限（千元）
    salaryMaxK: null,
    experience: [], // 经验档位标签
    degrees: [], // 学历标签
    excludeCompanies: [], // 屏蔽公司（子串匹配）
    addressExclude: [], // 工作地址排除词（如 银行 → 驻场在银行的岗位不考虑）；详细地址在补全详情后才有
    excludeStaleHr: false, // 剔除 HR 数月 / 半年未活跃的岗位
  };
}
