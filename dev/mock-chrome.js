// 开发预览用的 chrome API 模拟：让 popup/sidepanel/options 能在普通浏览器里渲染，
// 便于视觉走查与捕获渲染期 JS 错误。仅用于本地预览，不进扩展包。
(function () {
  const listeners = [];
  const tabRemoved = [];
  let tabSeq = 100;
  // 内存态后端
  const state = {
    settings: {
      mode: 'auto', autoCapture: true, autoScore: true, showBadge: true, dedupe: true, maxJobs: 800,
      activeProviderId: 'demo',
      privacy: { redactPII: true, sendCompanyName: true, confirmBeforeSend: false },
      filters: { enabled: false, keywordsInclude: [], keywordsExclude: [], riskKeywords: ['外包','驻场','猎头'], cities: [], salaryMinK: null, salaryMaxK: null, experience: [], degrees: [], excludeCompanies: [] },
      autoApply: {
        enabled: true, dailyTime: '09:00', keywords: ['前端'], cityName: '广州', cityCode: '101280100',
        scrolls: 4, experience: [], salaryMinK: null, salaryMaxK: null, hrActiveMaxTier: 3,
        threshold: 70, dailyCollectCap: 50, dailyCap: 20, includeCompanyContacted: true,
        applyForeground: true, applyGapMinSec: 5, applyGapMaxSec: 12, applyKeepTab: false,
      },
    },
    providers: [
      { id: 'demo', name: 'DeepSeek 深度求索', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo', model: 'deepseek-chat', anthropicVersion: '', extraHeaders: {}, temperature: 0.3, maxTokens: 2048, discoveredModels: ['deepseek-chat','deepseek-reasoner'] },
    ],
    profile: {
      schemaVersion: 1,
      target: { jobTitles: ['前端工程师','Web 前端'], cities: ['广州'], salaryMinK: 18, salaryMaxK: 30, industries: ['互联网'], companySizes: [], workModes: [] },
      basics: { name: '', yearsOfExperience: 4, education: '本科', currentTitle: '高级前端工程师' },
      capabilities: { skills: ['React','TypeScript','Vue','Webpack'], strengths: ['组件库建设','性能优化'], industryExperience: ['电商','SaaS'] },
      workSummary: '4年前端开发经验，主导过多个中后台项目。', projectSummary: '设计并落地公司组件库，覆盖 30+ 业务。', highlights: ['首屏加载优化 40%','沉淀通用组件库'],
      preference: { avoidKeywords: ['外包'], dealbreakers: [], notes: '' },
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    },
    jobs: [
      { uid:'boss:demo1', platform:'boss', jobId:'demo1', title:'高级前端工程师', salaryText:'25-40K·14薪', salaryMinK:25, salaryMaxK:40, city:'广州', district:'天河区·珠江新城', experience:'3-5年', degree:'本科', skills:['React','TypeScript','Node.js'], tags:['五险一金','弹性工作'], welfare:['补充医疗','年度体检'], company:'某互联网大厂', companyIndustry:'互联网', companyScale:'10000人以上', companyType:'', companyStage:'已上市', hrName:'', hrTitle:'技术经理', hrActiveText:'刚刚活跃', hrActiveAt:new Date(Date.now()-20*60000).toISOString(), description:'', url:'https://www.zhipin.com/job_detail/demo1.html', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:true,
        match:{ score:88, verdict:'strong', reasons:['React/TS 技能高度契合','有中后台与组件库经验','城市与薪资匹配'], gaps:['缺少大规模 SSR 经验'], risks:[], summary:'技能与经历高度匹配，建议优先沟通。',
          greetings:{
            short:'您好，4年前端，精通 React/TS，做过组件库建设，对这个高级前端岗位很感兴趣。',
            standard:'您好，我有4年前端经验，精通 React 与 TypeScript，曾主导公司组件库建设并将首屏性能优化40%，对贵司这个高级前端岗位很感兴趣，期待进一步交流。',
            detailed:'您好，我有4年前端开发经验，技术栈以 React 与 TypeScript 为主。在上家公司主导了通用组件库的建设，覆盖 30+ 业务线，并通过懒加载与打包优化把首屏加载时间降低了 40%。看到贵司这个高级前端岗位对组件化与性能有要求，与我的经历高度契合，希望有机会进一步沟通。',
          },
          greeting:'您好，我有4年前端经验，精通 React 与 TypeScript，曾主导公司组件库建设并将首屏性能优化40%，对贵司这个高级前端岗位很感兴趣，期待进一步交流。', at:new Date().toISOString() } },
      { uid:'qcwy:demo2', platform:'qcwy', jobId:'demo2', title:'Web前端开发工程师', salaryText:'1.5-2.5万·13薪', salaryMinK:15, salaryMaxK:25, city:'广州', district:'海珠区', experience:'1-3年', degree:'本科', skills:['Vue','JavaScript','CSS'], tags:['双休','带薪年假'], welfare:['五险一金'], company:'某科技有限公司', companyIndustry:'计算机软件', companyScale:'150-500人', companyType:'民营', companyStage:'', hrName:'', hrTitle:'HR', description:'岗位职责：负责公司前端产品开发……', url:'https://jobs.51job.com/demo2.html', publishedAt:'2026-09-18', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false, match:null },
      { uid:'boss:demo3', platform:'boss', jobId:'demo3', title:'前端外包驻场', salaryText:'12-18K', salaryMinK:12, salaryMaxK:18, city:'深圳', district:'南山区', experience:'3-5年', degree:'大专', skills:['jQuery','HTML'], tags:['外包'], welfare:[], company:'XX外包服务公司', companyIndustry:'人力资源', companyScale:'500-999人', companyType:'', companyStage:'', hrName:'', hrTitle:'招聘', hrActiveText:'半年前活跃', hrActiveAt:new Date(Date.now()-3*3600000).toISOString(), description:'', url:'', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false, match:{ score:38, verdict:'weak', reasons:['基础技能匹配'], gaps:['技术栈偏旧'], risks:['疑似外包驻场'], summary:'匹配度偏低，注意外包性质。', greeting:'', at:new Date().toISOString() } },
      { uid:'boss:demo4', platform:'boss', jobId:'demo4', title:'前端开发工程师（中后台）', salaryText:'20-30K·13薪', salaryMinK:20, salaryMaxK:30, city:'广州', district:'番禺区·万博', experience:'3-5年', degree:'本科', skills:['Vue','TypeScript','微前端'], tags:['双休'], welfare:['五险一金','餐补'], company:'某企业服务公司', companyIndustry:'企业服务', companyScale:'500-999人', companyType:'', companyStage:'B轮', hrName:'', hrTitle:'HRBP', hrActiveText:'本月活跃', hrActiveAt:new Date(Date.now()-90*60000).toISOString(), address:'广州番禺区万博中心', experienceJd:'5年以上', description:'岗位职责：负责中后台系统前端开发……任职要求：5年以上前端经验，熟悉 Vue 与微前端……', url:'https://www.zhipin.com/job_detail/demo4.html', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false,
        match:{ score:66, rawScore:72, activityPenalty:6, verdict:'good', eligible:true, blockers:[], dims:{skill:80,experience:62,requirement:70,location:85}, reasons:['Vue/TS 技能匹配','中后台经验契合'], gaps:['JD 正文要求 5 年以上，当前 4 年'], risks:[], summary:'整体匹配，经验年限略差；HR 本月活跃，已按活跃度扣分。', greeting:'', at:new Date().toISOString() } },
      { uid:'boss:demo5', platform:'boss', jobId:'demo5', title:'React 前端工程师', salaryText:'22-35K', salaryMinK:22, salaryMaxK:35, city:'广州', district:'天河区·科韵路', experience:'3-5年', degree:'本科', skills:['React','Next.js'], tags:[], welfare:[], company:'某 SaaS 公司', companyIndustry:'互联网', companyScale:'100-499人', companyType:'', companyStage:'A轮', hrName:'', hrTitle:'招聘者', hrActiveText:'3日内活跃', hrActiveAt:new Date(Date.now()-40*60000).toISOString(), description:'', url:'https://www.zhipin.com/job_detail/demo5.html', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false, match:null },
    ],
    blocked: [
      { uid:'boss:b1', platform:'boss', title:'前端驻场（银行项目）', company:'XX人力外包', at:new Date().toISOString() },
    ],
    // 模拟「当前查看的岗位」上下文（可用 __mockSwitchJob 切换来验证实时跟随）
    ctx: { platform:'boss', url:'https://www.zhipin.com/job_detail/demo1.html', jobKey:'demo1', isChat:false },
  };

  // 投递清单演示数据：直接复用岗位库里有匹配分的 BOSS 岗位
  state.applyItems = state.jobs
    .filter((j) => j.platform === 'boss' && j.match && j.match.score >= 70)
    .map((j) => ({
      uid: j.uid, jobId: j.jobId, platform: j.platform, title: j.title, company: j.company,
      salaryText: j.salaryText, city: j.city, district: j.district, experience: j.experience, degree: j.degree,
      hrActiveText: j.hrActiveText, url: j.url, score: j.match.score, verdict: j.match.verdict,
      summary: j.match.summary, hasGreeting: !!(j.match.greetings && j.match.greetings.standard),
      greetingPreview: '', companyContacted: j.contacted === 'company', status: 'pending',
      addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

  function mockApplyStatus() {
    const items = state.applyItems || [];
    const counts = { total: items.length, applying: 0, pending: 0, applied: 0, rejected: 0, failed: 0, skipped: 0 };
    for (const it of items) if (counts[it.status] != null) counts[it.status]++;
    return {
      enabled: state.settings.autoApply.enabled,
      config: state.settings.autoApply,
      collect: { date: '2026-10-31', count: Math.min(12, state.settings.autoApply.dailyCollectCap), cap: state.settings.autoApply.dailyCollectCap },
      search: { running: false, lastSearchDate: '2026-10-31', lastSearchAt: Date.now() - 3600000, lastSearchStatus: 'ok', lastSearchError: '', lastSearchCount: 3, nextRunAt: Date.now() + 6 * 3600000 },
      batch: { date: '2026-10-31', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items, counts },
      run: { state: 'idle', total: 0, done: 0, failed: 0, current: '', startedAt: 0, finishedAt: 0, error: '', stopRequested: false },
    };
  }

  // 广播给所有 onMessage 监听者（模拟真实扩展的 chrome.runtime.sendMessage 广播）
  function broadcast(msg) {
    listeners.forEach((fn) => { try { fn(msg, {}, () => {}); } catch {} });
  }

  function respond(msg) {
    const t = msg.type;
    switch (t) {
      case 'SETTINGS_GET': return state.settings;
      case 'SETTINGS_SAVE':
        state.settings = { ...state.settings, ...msg.patch, privacy:{...state.settings.privacy,...(msg.patch&&msg.patch.privacy)}, filters:{...state.settings.filters,...(msg.patch&&msg.patch.filters)}, autoApply:{...state.settings.autoApply,...(msg.patch&&msg.patch.autoApply)} };
        return state.settings;
      case 'JOB_LIST_REQUEST': return state.jobs;
      case 'JOB_STAR_TOGGLE': state.jobs = state.jobs.map(j=>j.uid===msg.uid?{...j,star:!j.star}:j); return state.jobs;
      case 'JOB_DELETE': state.jobs = state.jobs.filter(j=>j.uid!==msg.uid); return state.jobs;
      case 'JOB_CLEAR_REQUEST': state.jobs = []; return state.jobs;
      case 'JOB_BLOCK': { const ids=new Set(msg.uids||[msg.uid]); state.blocked=[...(state.blocked||[]), ...state.jobs.filter(j=>ids.has(j.uid)).map(j=>({uid:j.uid,platform:j.platform,title:j.title,company:j.company,at:new Date().toISOString()}))]; state.jobs=state.jobs.filter(j=>!ids.has(j.uid)); return { jobs: state.jobs, blocked: state.blocked }; }
      case 'JOB_UNBLOCK': state.blocked=(state.blocked||[]).filter(b=>b.uid!==msg.uid); return state.blocked;
      case 'BLOCKED_GET': return state.blocked||[];
      case 'BLOCKED_CLEAR': state.blocked=[]; return [];
      case 'CONTACTS_MARK': { const ids=new Set(msg.uids||[msg.uid]); state.jobs=state.jobs.map(j=>ids.has(j.uid)?{...j,contacted:'job'}:j); setTimeout(()=>broadcast({ type:'JOBS_UPDATED' }),0); return { jobs: state.jobs, added: ids.size }; }
      case 'AUTO_STATUS_GET': {
        // ?pause=quota|login|verify 预览补详情暂停提示；?error=1 预览自动分析出错
        const q = new URLSearchParams(location.search);
        const reasons = { quota:'今日后台补全已达 120 次上限', login:'BOSS 未登录，后台补全已暂停', verify:'BOSS 触发安全验证，后台补全暂停 30 分钟' };
        const halted = reasons[q.get('pause')] || '';
        const detail = { running: !halted, pending: halted ? 8 : 0, halted, resumeAt: halted ? Date.now() + 47 * 60000 : 0 };
        if (q.get('error')) return { running:false, pending:0, done:12, lastError:'AI 接口返回 401：API Key 无效或已过期', lastErrorAt:Date.now()-60000, detail };
        return { running:true, pending:5, done:12, lastError:'', lastErrorAt:0, detail };
      }
      case 'CONTACTS_REMOVE':
      case 'CONTACTS_GET': case 'CONTACTS_SYNC': case 'CONTACTS_CLEAR': case 'WORKER_HALT_CLEAR': return { contacts: [{ company:'示例科技', title:'前端', jobId:'', source:'chat' }, { company:'某云计算公司', title:'Web 前端', jobId:'', source:'greeting' }, { company:'某游戏公司', title:'H5 开发', jobId:'', source:'manual' }], companies: 3, syncedAt: Date.now(), halt: null };
      case 'JOB_EXPORT_REQUEST': return { format: msg.format||'json', content: JSON.stringify(state.jobs,null,2), count: state.jobs.length };
      case 'JOB_MARK': {
        const ids = new Set(msg.uids || [msg.uid]);
        const now = new Date().toISOString();
        const pick = (flag, prev) => (flag === undefined ? prev : flag ? prev || now : undefined);
        state.jobs = state.jobs.map(j => ids.has(j.uid) ? { ...j, viewedAt: pick(msg.viewed, j.viewedAt), dismissedAt: pick(msg.dismissed, j.dismissedAt) } : j);
        return state.jobs;
      }
      case 'GREETING_SAVE': state.jobs = state.jobs.map(j=>j.uid===msg.uid?{...j,greetingDraft:msg.text}:j); return state.jobs;
      case 'ACTIVE_CONTEXT_REQUEST': return { platform:state.ctx.platform, url:state.ctx.url, jobKey:state.ctx.jobKey, isChat:state.ctx.isChat, platformName: state.ctx.platform==='boss'?'BOSS 直聘':'前程无忧 51job' };
      case 'SEND_GREETING': console.log('[mock] SEND_GREETING:', msg.text); return { ok:true, mode:'sent' };
      case 'AUTO_APPLY_STATUS_GET': case 'AUTO_APPLY_RUN_NOW': case 'APPLY_REFRESH':
        return msg.type === 'AUTO_APPLY_RUN_NOW' ? { started: true } : mockApplyStatus();
      case 'APPLY_ITEM_MARK': {
        const ids = new Set(msg.uids || []);
        state.applyItems = (state.applyItems || []).map((it) => ids.has(it.uid) ? { ...it, status: msg.status, updatedAt: new Date().toISOString() } : it);
        return mockApplyStatus();
      }
      case 'APPLY_START': {
        const ids = new Set(msg.uids || []);
        state.applyItems = (state.applyItems || []).map((it) => ids.has(it.uid) && it.status === 'pending' ? { ...it, status: 'applied', appliedAt: new Date().toISOString() } : it);
        setTimeout(() => broadcast({ type: 'APPLY_UPDATED' }), 0);
        return { started: true, total: ids.size };
      }
      case 'APPLY_STOP': return { stopping: true };
      case 'OPEN_SIDEPANEL': return { ok: true };
      case 'AI_PROVIDERS_GET': return state.providers;
      case 'AI_PROVIDERS_SAVE': state.providers = msg.providers; return state.providers;
      case 'AI_PROVIDER_TEST': return { ok:true, message:'连接成功', sample:'正常' };
      case 'AI_PROVIDER_MODELS': return ['deepseek-chat','deepseek-reasoner'];
      case 'PROFILE_GET': return state.profile;
      case 'PROFILE_SAVE': state.profile = msg.profile; return state.profile;
      case 'PROFILE_CLEAR': state.profile = null; return null;
      case 'AI_RESUME_EXTRACT': return { target:{jobTitles:['产品经理'],cities:['上海'],industries:[]}, basics:{yearsOfExperience:5,education:'硕士'}, capabilities:{skills:['需求分析','Axure'],strengths:['数据驱动'],industryExperience:['金融']}, workSummary:'5年产品经验', projectSummary:'', highlights:['DAU 提升30%'] };
      case 'AI_MATCH_SCORE': { const m={score:76,verdict:'good',eligible:true,blockers:[],dims:{skill:82,experience:70,requirement:75,location:90},reasons:['演示打分','React/TS 与岗位技能吻合'],gaps:['缺少大规模 SSR 经验'],risks:[],summary:'演示总评：技能匹配度较高',at:new Date().toISOString()}; state.jobs=state.jobs.map(j=>j.uid===msg.uid?{...j,match:m}:j); return m; }
      case 'AI_GREETING': {
        const g = { short:'演示：精简版招呼语', standard:'演示：标准版招呼语，点出与岗位最相关的两点经历。', detailed:'演示：详细版招呼语……' };
        state.jobs = state.jobs.map(j=>j.uid===msg.uid&&j.match?{...j,match:{...j.match,greetings:g,greeting:g.standard}}:j);
        return g;
      }
      case 'AI_USAGE_GET': case 'AI_USAGE_RESET':
        return msg.type === 'AI_USAGE_RESET' ? { since: Date.now(), calls:0, input:0, cached:0, output:0, localHits:0 } : { since: Date.now()-3*86400000, calls: 86, input: 214000, cached: 151000, output: 38200, localHits: 41 };
      case 'AI_MATCH_BATCH': return (msg.uids||[]).map(u=>({uid:u,ok:true,score:70}));
      case 'BATCH_START': case 'BATCH_STATUS': case 'BATCH_CANCEL': {
        // ?batch=1 预览批量进行中的底栏进度
        if (new URLSearchParams(location.search).get('batch')) return { running:true, total:10, detail:3, queued:1, scoring:1, ok:4, fail:1, skipped:0, skippedReasons:{}, paused: new URLSearchParams(location.search).get('pause') ? '今日后台补全已达 120 次上限' : '', resumeAt: Date.now()+47*60000, pendingUids:['boss:demo5'] }; const n=(msg.uids||[]).length; return { running:false, total:n, detail:0, queued:0, scoring:0, ok:n, fail:0, skipped:0, skippedReasons:{}, pendingUids:[] }; }
      case 'AI_TAILOR_RESUME': return {
        matchedSkills:['React','TypeScript','组件库建设','性能优化'],
        missingSkills:['大规模 SSR'],
        keywordsToAlign:['中后台','组件化','首屏性能','工程化'],
        summaryDraft:'4年前端开发经验，精通 React 与 TypeScript，主导过通用组件库建设覆盖 30+ 业务，并将首屏加载优化 40%。熟悉中后台复杂场景与前端工程化，能快速融入高级前端岗位。',
        bulletSuggestions:['把「负责组件开发」改写为「主导通用组件库建设，覆盖 30+ 业务线」','突出「首屏加载优化 40%」并前置到经历首条','将 Webpack 相关内容归纳为「前端工程化」以对齐 JD'],
        tips:['面试可能考察组件库设计与性能优化细节，准备具体量化案例','JD 提到中后台，突出复杂表单/权限相关项目经验'],
        note:'',
        at:new Date().toISOString(),
      };
      case 'OPEN_OPTIONS': console.log('[mock] openOptionsPage'); return { ok:true };
      case 'OPEN_SIDEPANEL': console.log('[mock] open sidepanel'); return { ok:true };
      case 'OPEN_JOB_CHAT': {
        if (!msg.url) throw new Error('该岗位没有可打开的链接');
        state.lastChatOpen = { url: msg.url, platform: msg.platform, text: msg.text, at: Date.now() };
        console.log('[mock] OPEN_JOB_CHAT (new active tab):', msg.url);
        return { ok:true, mode:'opened', tabId: 199 };
      }
      default: return { ok:true };
    }
  }

  // 用真实的 mergeSettings 补齐默认设置（节奏预设、并发等新字段），避免预览缺字段
  const ready = import('../src/common/settingsStore.js')
    .then((m) => { state.settings = m.mergeSettings(state.settings); })
    .catch((e) => console.warn('[mock] mergeSettings 加载失败', e));

  window.chrome = {
    runtime: {
      lastError: null,
      id: 'dev-mock',
      sendMessage: (msg, cb) => ready.then(() => {
        let env;
        try { env = { ok:true, data: respond(msg) }; }
        catch (e) { env = { ok:false, error: e instanceof Error ? e.message : String(e) }; }
        if (typeof cb === 'function') setTimeout(()=>cb(env), 30);
        return env;
      }),
      onMessage: { addListener: (fn)=>listeners.push(fn), removeListener: ()=>{} },
      openOptionsPage: () => console.log('[mock] openOptionsPage'),
      getURL: (p) => '/' + p,
    },
    storage: { local: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } },
    // 测试辅助：模拟用户在网站上点开另一个岗位（触发 CURRENT_JOB 广播）
    __mockSwitchJob: (platform, jobKey, isChat) => {
      state.ctx = { platform, jobKey, isChat: !!isChat, url: platform==='boss'?`https://www.zhipin.com/web/geek/jobs`:`https://we.51job.com/pc/search` };
      broadcast({ type: 'CURRENT_JOB', platform, jobKey });
    },
    // 测试辅助：__mockCloseTab() 模拟关掉最近一次用 tabs.create 打开的标签页
    __mockCloseTab: () => { const id = tabSeq; tabRemoved.forEach((fn) => fn(id)); },
    tabs: {
      query: async()=>[{ id:1, windowId:1, url:'https://www.zhipin.com/web/geek/jobs' }],
      create: async (o) => { console.log('[mock] tabs.create', o.url); return { id: ++tabSeq, url: o.url }; },
      onRemoved: { addListener: (fn) => tabRemoved.push(fn) },
    },
    sidePanel: { open: async()=>console.log('[mock] sidePanel.open'), setPanelBehavior: async()=>{} },
    downloads: { download: async(o)=>{ console.log('[mock] download', o.filename); return 1; } },
  };
})();
