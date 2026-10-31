// ISOLATED world collector：接收 sniffer 的 postMessage，转发给 background；
// 追踪当前页面平台；提供 DOM 兜底抓取（当接口嗅探未命中时）；
// 页面内显示一个极简的收录状态角标。
(function () {
  const CHANNEL = 'job-helper:sniffer';
  const MSG = {
    JOBS_CAPTURED: 'JOBS_CAPTURED',
    PAGE_CONTEXT_CHANGED: 'PAGE_CONTEXT_CHANGED',
    SEND_GREETING: 'SEND_GREETING',
    CURRENT_JOB: 'CURRENT_JOB',
    CONTACTS_CAPTURED: 'CONTACTS_CAPTURED',
    TAB_ROLE: 'TAB_ROLE',
    WORKER_RESULT: 'WORKER_RESULT',
    DETAIL_PROGRESS: 'DETAIL_PROGRESS',
    WORKER_HALT_CLEAR: 'WORKER_HALT_CLEAR',
    APPLY_CLICK: 'APPLY_CLICK',
  };

  // 判断嗅探到的 URL 是「列表」还是「岗位详情/卡片」
  function apiKind(urlStr) {
    let path = '';
    try {
      path = new URL(urlStr, location.href).pathname;
    } catch {
      return 'list';
    }
    if (/\/wapi\/zprelation\/friend\/|\/wapi\/zpchat\/geek\/getBossData\.json/.test(path)) return 'contacts';
    if (/\/wapi\/zpgeek\/(job\/detail(?:\/[a-z]+)?|job\/card|geek\/job\/detail)\.json/.test(path)) return 'detail';
    if (/\/api\/job\/detail/.test(path)) return 'detail';
    return 'list';
  }

  // 从详情请求里取出岗位标识（BOSS: encryptJobId；51job: jobid）
  function jobKeyFromDetail(url, payload) {
    // 1) 优先请求 URL 上的查询参数
    try {
      const q = new URL(url, location.href).searchParams;
      const fromQuery = q.get('encryptJobId') || q.get('jobId') || q.get('jobid');
      if (fromQuery) return fromQuery;
    } catch {}
    // 2) 回退：从响应体里挖（字段名依平台而异，尽量宽松）
    try {
      const zp = payload && (payload.zpData || payload.resultbody || payload.resultBody);
      const info = zp && (zp.jobInfo || (zp.job && zp.job.item) || zp);
      if (info) {
        const k = info.encryptId || info.encryptJobId || info.jobId || info.jobid;
        if (k) return String(k);
      }
    } catch {}
    return null;
  }

  function platformOfHost(host) {
    if (/(^|\.)zhipin\.com$/i.test(host)) return 'boss';
    if (/(^|\.)51job\.com$/i.test(host)) return 'qcwy';
    return null;
  }
  const PLATFORM = platformOfHost(location.hostname);

  function send(type, extra) {
    try {
      chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
    } catch {}
  }
  // 需要 background 回包时用它；失败返回 null
  async function request(type, extra) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...extra });
      return res && res.ok ? res.data : null;
    } catch {
      return null;
    }
  }

  let captured = 0;

  // —— 接收 sniffer 转发 ——
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== CHANNEL) return;
    // 页面请求多用相对地址，转成完整地址再交给后台（后台据此判断是不是列表接口，决定是否自动补详情 / 匹配）
    try {
      d.url = new URL(d.url, location.href).href;
    } catch {}
    const kind = apiKind(d.url);
    if (kind === 'contacts') {
      // 沟通页会话列表：交给 background 解析出已沟通的公司/岗位
      send(MSG.CONTACTS_CAPTURED, { platform: d.platform, payload: d.payload });
      return;
    }
    if (kind === 'detail') {
      // 点开某个岗位：上报「当前岗位」，让面板实时切换
      const jobKey = jobKeyFromDetail(d.url, d.payload);
      if (jobKey) send(MSG.CURRENT_JOB, { platform: d.platform, jobKey });
      // 详情响应同样丢给归一化：命中列表结构则收录，否则被安全忽略
      send(MSG.JOBS_CAPTURED, { platform: d.platform, url: d.url, payload: d.payload });
      return;
    }
    if (d.platform === 'boss') {
      recordBossOnline(d.payload); // 记录每个岗位的 HR 在线状态
      recordListMeta(d.payload); // 记录岗位 → 公司/岗位名，用于隐藏已沟通的卡片
    }
    send(MSG.JOBS_CAPTURED, { platform: d.platform, url: d.url, payload: d.payload });
    captured++;
    flashBadge();
    scheduleReapplyFresh(); // 新一批卡片渲染后，若排序开着则重排
  });

  // —— 识别当前详情页岗位标识 & 是否聊天页 ——
  function detectJobKey() {
    const u = location.href;
    if (PLATFORM === 'boss') {
      // 详情页：/job_detail/<encryptId>.html；地理列表页详情抽屉不改 URL，识别不到属正常
      const m = u.match(/job_detail\/([\w~-]+)\.html/) || u.match(/[?&]jobId=([\w~-]+)/);
      return m ? m[1] : null;
    }
    if (PLATFORM === 'qcwy') {
      const m = u.match(/\/job\/(\d+)/) || u.match(/jobs\.51job\.com\/[^/]*\/(\d+)\.html/) || u.match(/[?&]jobid=(\d+)/i);
      return m ? m[1] : null;
    }
    return null;
  }
  // 是否处于沟通/聊天页（用于 UI 提示「可直接发送」）
  function detectChat() {
    const u = location.href.toLowerCase();
    if (PLATFORM === 'boss') return /\/chat|\/geek\/chat|zhipin\.com\/web\/geek\/chat/.test(u) || !!document.querySelector('.chat-input, .conversation-message, #chat-input');
    if (PLATFORM === 'qcwy') return /\/im|message|chat/.test(u) || !!document.querySelector('.im-input, .message-input, [class*="chat-input"]');
    return false;
  }

  // —— 上报页面上下文 ——
  function reportContext() {
    send(MSG.PAGE_CONTEXT_CHANGED, {
      platform: PLATFORM,
      url: location.href,
      jobKey: detectJobKey(),
      isChat: detectChat(),
    });
  }
  reportContext();
  // 首次加载即在聊天页（点「立即沟通」整页跳转过来的场景）：接力填入暂存招呼语。
  // MutationObserver 只在后续 URL 变化时触发，初次加载得在这里主动消费一次。
  if (detectChat()) setTimeout(() => { consumePendingGreetingOnChatPage().catch(() => {}); }, 800);
  // SPA 路由变化监听
  let lastUrl = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reportContext();
      // 若刚跳进聊天页（SPA 软跳转场景），也尝试接力填入暂存招呼语
      if (detectChat()) setTimeout(() => { consumePendingGreetingOnChatPage().catch(() => {}); }, 800);
    }
  });
  try {
    obs.observe(document, { subtree: true, childList: true });
  } catch {}

  // —— 极简状态角标（Apple 风：胶囊、毛玻璃） ——
  let badgeEl = null;
  let badgeTimer = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.className = 'jobhelper-capture-badge';
    badgeEl.innerHTML = '<span class="jh-dot"></span><span class="jh-text">已收录 0</span><span class="jh-actions"></span>';
    badgeEl.addEventListener('click', () => {
      send('OPEN_SIDEPANEL', {});
    });
    // 补全挂起时的按钮：不触发角标本身的点击
    badgeEl.querySelector('.jh-actions').addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : '';
      if (!act) return;
      e.stopPropagation();
      if (act === 'login') window.open('https://www.zhipin.com/web/user/?ka=header-login', '_blank');
      else if (act === 'resume') send(MSG.WORKER_HALT_CLEAR, {});
    });
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }
  function flashBadge() {
    if (!roleReady || tabRole) return; // 后台任务页 / 角色未确认前不显示收录角标
    const el = ensureBadge();
    const halted = detailProgress.halted;
    let text = `已收录 ${captured} 次`;
    if (halted) {
      const min = Math.ceil(((detailProgress.resumeAt || 0) - Date.now()) / 60000);
      text += ` · 详情补全已暂停${min > 0 ? `（约 ${min} 分钟后继续）` : ''}`;
    } else if (detailProgress.done || detailProgress.pending) text += ` · 详情 ${detailProgress.done}/${detailProgress.done + detailProgress.pending}`;
    el.querySelector('.jh-text').textContent = text;
    el.querySelector('.jh-actions').innerHTML = halted
      ? (/未登录/.test(halted) ? '<button data-act="login">去登录</button>' : '') + '<button data-act="resume">继续</button>'
      : '';
    el.title = halted || '';
    el.classList.toggle('jh-halted', !!halted);
    el.classList.add('jh-active');
    clearTimeout(badgeTimer);
    // 挂起时一直显示，方便直接点「继续 / 去登录」
    if (!halted) badgeTimer = setTimeout(() => el.classList.remove('jh-active'), 1600);
  }

  // —— DOM 兜底：当接口嗅探长时间未命中时，从可见卡片粗略抓取 ——
  // 仅作为兜底，字段不如接口完整。默认延迟启动，命中过接口则不启用。
  function domFallback() {
    if (captured > 0 || !PLATFORM || !roleReady || tabRole) return;
    const jobs = PLATFORM === 'boss' ? scrapeBoss() : scrapeQcwy();
    if (jobs.length) {
      // 包装成接口信封形状，复用 background 的归一化
      const payload = PLATFORM === 'boss'
        ? { code: 0, zpData: { jobList: jobs } }
        : { status: '1', resultbody: { job: { items: jobs } } };
      send(MSG.JOBS_CAPTURED, { platform: PLATFORM, url: location.href + '#dom', payload });
      captured++;
      flashBadge();
    }
  }

  function txt(el, sel) {
    const n = el.querySelector(sel);
    return n ? n.textContent.trim() : '';
  }

  function scrapeBoss() {
    const cards = document.querySelectorAll('.job-card-wrap, .job-card-wrapper, li.job-card-box');
    const out = [];
    cards.forEach((c) => {
      const jobName = txt(c, '.job-name') || txt(c, '.job-title');
      if (!jobName) return;
      out.push({
        jobId: c.getAttribute('data-jobid') || jobName,
        encryptJobId: '',
        jobName,
        salaryDesc: txt(c, '.salary') || txt(c, '.job-salary'),
        cityName: txt(c, '.job-area') || txt(c, '.company-location'),
        areaDistrict: '',
        jobExperience: '',
        jobDegree: '',
        skills: Array.from(c.querySelectorAll('.tag-list li, .job-card-footer .tag-list li')).map((x) => x.textContent.trim()),
        jobLabels: [],
        welfareList: [],
        brandName: txt(c, '.company-name') || txt(c, '.boss-name'),
        brandIndustry: txt(c, '.company-tag-list li'),
        brandScaleName: '',
        brandStageName: '',
      });
    });
    return out;
  }

  function scrapeQcwy() {
    const cards = document.querySelectorAll('.joblist-item, .j_joblist .e, [class*="joblist-item"]');
    const out = [];
    cards.forEach((c) => {
      const jobName = txt(c, '.jname') || txt(c, '.job-title') || txt(c, 'a[title]');
      if (!jobName) return;
      out.push({
        jobId: c.getAttribute('data-jobid') || jobName,
        jobName,
        provideSalaryString: txt(c, '.sal') || txt(c, '.salary'),
        jobAreaString: txt(c, '.d.at') || txt(c, '.area'),
        workYearString: '',
        degreeString: '',
        jobTags: Array.from(c.querySelectorAll('.tags .tag, .job-tags span')).map((x) => x.textContent.trim()),
        fullCompanyName: txt(c, '.cname') || txt(c, '.company-name'),
        companyName: txt(c, '.cname'),
        coIndustryText: txt(c, '.dc.at'),
        companySizeString: '',
        companyTypeString: '',
        jobDescribe: '',
        jobHref: (c.querySelector('a[href]') || {}).href || '',
      });
    });
    return out;
  }

  if (PLATFORM) {
    setTimeout(domFallback, 6000); // 给接口嗅探留出时间，再兜底
  }

  // ============================================================
  //  后台标签页协作（插件不直接向平台发请求）
  //  background 为补全详情 / 同步已沟通，会在后台打开真实页面；本脚本在这些页面里
  //  读取页面自己加载出来的数据，回报后由 background 关闭标签页。
  //  普通浏览时同样会读取（用户自己打开详情页 / 沟通页也能顺带补全）。
  // ============================================================
  let tabRole = null; // 'detail' | 'contacts' | 'search' | null（null = 用户自己打开的页面）
  let roleReady = false; // TAB_ROLE 查询完成前不注入角标 / 兜底抓取，避免污染后台任务页
  const detailProgress = { done: 0, pending: 0, halted: '', resumeAt: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== MSG.DETAIL_PROGRESS) return false;
    detailProgress.done = msg.done || 0;
    detailProgress.pending = msg.pending || 0;
    detailProgress.halted = msg.halted || '';
    detailProgress.resumeAt = msg.resumeAt || 0;
    flashBadge();
    return false;
  });

  // 平台的安全验证 / 登录页：后台任务遇到它必须立即停下
  function detectBlockedPage() {
    const p = location.pathname;
    if (/\/web\/user\/(safe|verify)|verify-slider|security-check|\/web\/passport/i.test(p)) return 'verify';
    if (/^\/web\/user\/?$/.test(p) || /[?&]ka=header-login/.test(location.search)) return 'login';
    const t = (document.body && document.body.innerText || '').slice(0, 400);
    if (/安全验证|异常访问|访问行为异常/.test(t)) return 'verify';
    return '';
  }

  // 详情页上弹出的登录框（未登录时 BOSS 可能不跳转、而是盖一层登录弹窗）。只在读不到 JD 时调用，避免误判
  function detectLoginPrompt() {
    const boxes = document.querySelectorAll('[class*="login-dialog"], [class*="login-box"], [class*="sign-form"], [class*="login-wrap"], .boss-login-dialog');
    for (const el of boxes) {
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      if (/登录|注册/.test(el.innerText || '')) return true;
    }
    return /(扫码登录|验证码登录|密码登录)/.test((document.body && document.body.innerText || '').slice(0, 3000));
  }

  // —— 岗位详情页：读取 JD 正文与 HR 活跃时间 ——
  // 独立详情页 /job_detail/<id>.html 为服务端渲染，JD 在 .job-sec-text，活跃时间在 .boss-active-time。
  async function scrapeDetailPage() {
    const m = location.pathname.match(/job_detail\/([\w~-]+)\.html/);
    if (!m) return null;
    const jdEl = await waitFor(() => document.querySelector('.job-detail-section .job-sec-text, .job-sec-text'), 12000, 400);
    if (!jdEl) {
      // 读不到 JD：页面可能后来才跳到验证 / 登录，或在详情页上弹了登录框——这些要熔断，不算这个岗位读取失败
      const blocked = detectBlockedPage() || (detectLoginPrompt() ? 'login' : '');
      return blocked ? { jobKey: m[1], ok: false, blocked } : { jobKey: m[1], ok: false, noJd: true };
    }
    // HR 活跃区块可能比 JD 晚渲染：再等一会儿（在线的 HR 只有在线标记、没有活跃时间文字）
    await waitFor(() => document.querySelector('.boss-active-time, .boss-online-tag'), 3000, 300);
    const active = document.querySelector('.boss-active-time');
    const online = !!document.querySelector('.boss-online-tag');
    const addrEl = document.querySelector('.location-address, .job-location .location-address');
    // 详情页顶部的经验 / 学历要求（BOSS 的 class 原文即拼作 text-experiece）
    const expEl = document.querySelector('.job-banner .text-experiece, .job-banner .text-experience, .text-experiece');
    const degEl = document.querySelector('.job-banner .text-degree, .text-degree');
    const payload = {
      code: 0,
      zpData: {
        jobInfo: {
          encryptId: m[1],
          postDescription: (jdEl.innerText || jdEl.textContent || '').trim(),
          address: addrEl ? addrEl.textContent.trim() : '',
          experienceName: expEl ? expEl.textContent.trim() : '',
          degreeName: degEl ? degEl.textContent.trim() : '',
        },
        bossInfo: {
          activeTimeDesc: active ? active.textContent.trim() : '',
          bossOnline: online,
        },
      },
    };
    send(MSG.JOBS_CAPTURED, { platform: 'boss', url: location.href.split('#')[0] + '#dom-detail', payload, jobKey: m[1] });
    return { jobKey: m[1], ok: true, textLength: payload.zpData.jobInfo.postDescription.length };
  }

  // —— 沟通页：DOM 兜底读取会话列表里的公司名（接口嗅探为主）——
  // 会话项结构：.name-box 内依次为 HR 名 / 公司名 / HR 职位。
  function scrapeChatList() {
    const out = [];
    document.querySelectorAll('.user-list li .name-box, [class*="user-list"] [class*="name-box"]').forEach((box) => {
      const spans = Array.from(box.querySelectorAll('span')).map((x) => x.textContent.trim()).filter(Boolean);
      if (spans.length >= 2) out.push({ hrName: spans[0], company: spans[1] });
    });
    return out;
  }

  async function runChatPage() {
    await waitFor(() => document.querySelector('.user-list li, [class*="user-list"] li'), 10000, 400);
    await sleep(1500); // 等会话列表接口响应落地
    const entries = scrapeChatList();
    if (entries.length) send(MSG.CONTACTS_CAPTURED, { platform: 'boss', entries });
    return { ok: true, count: entries.length };
  }

  // —— 搜索页（每日自动刷 BOSS）：页面自己加载列表，我们只负责慢慢往下滚，触发后续分页 ——
  // 岗位数据由 sniffer 捕获的 joblist 接口送回后台，这里只回报「滚了几次、看到多少卡片」。
  async function runSearchPage(task) {
    if (!/\/web\/geek\/job/.test(location.pathname)) {
      const blocked = detectBlockedPage();
      return blocked ? { ok: false, blocked } : { ok: false, error: '不在 BOSS 搜索页' };
    }
    const first = await waitFor(
      () => document.querySelector('.job-card-wrap, li.job-card-box, .job-card-wrapper'),
      15000,
      400,
    );
    if (!first) {
      const blocked = detectBlockedPage() || (detectLoginPrompt() ? 'login' : '');
      return blocked ? { ok: false, blocked } : { ok: false, error: '搜索页没有加载出岗位', noCards: true };
    }
    const scrolls = Math.max(0, Math.min(12, Number(task && task.scrolls) || 0));
    let lastCards = countJobCards();
    let lastCaptured = captured;
    let stalls = 0;
    for (let i = 0; i < scrolls; i++) {
      await sleep(1200 + Math.random() * 1800);
      const target = nearestScrollable(findJobListContainer());
      const beforeCards = countJobCards();
      const beforeCaptured = captured;
      const viewport = target === document.scrollingElement ? innerHeight : target.clientHeight || innerHeight;
      // 后台标签页会节流 smooth 滚动，这里用即时滚动；滚动后等卡片或接口响应增长再继续
      target.scrollBy({ top: Math.max(400, viewport * 0.85), behavior: 'auto' });
      if (target !== document.scrollingElement) window.scrollBy({ top: 120, behavior: 'auto' });
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        await sleep(350);
        if (countJobCards() > beforeCards || captured > beforeCaptured) break;
      }
      const blocked = detectBlockedPage();
      if (blocked) return { ok: false, blocked };
      const n = countJobCards();
      // 隐藏标签页里卡片可能被虚拟列表回收，单看 DOM 数量会误判「到底了」；
      // 同时看 sniffer 捕获次数（每加载一页 joblist 都会 +1）。
      const grew = n > lastCards || captured > lastCaptured;
      stalls = grew ? 0 : stalls + 1;
      lastCards = n;
      lastCaptured = captured;
      if (stalls >= 2) break; // 连续两次滚动都没有新数据：到底了
    }
    await sleep(1200); // 等最后一个 joblist 响应落地，再让后台关标签页
    return { ok: true, count: lastCards };
  }

  // 后台任务页读完数据后，像人一样在页面上停留一会儿再关；详情页按 JD 长度多看几秒，并分几次慢慢往下滚
  async function humanDwell(task, textLength = 0) {
    if (!task || !task.dwellMs) return;
    const ms = Math.min(task.dwellMaxMs || task.dwellMs, task.dwellMs + Math.min(6000, textLength * 5));
    const end = Date.now() + ms;
    if (task.scroll) {
      const steps = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < steps && Date.now() < end; i++) {
        const slot = (end - Date.now()) / (steps - i);
        await sleep(slot * (0.5 + Math.random() * 0.8));
        try {
          window.scrollBy({ top: 150 + Math.random() * 450, behavior: 'smooth' });
        } catch {}
      }
    }
    const rest = end - Date.now();
    if (rest > 0) await sleep(rest);
  }

  async function initPageRole() {
    if (PLATFORM !== 'boss') {
      roleReady = true;
      return;
    }
    try {
      const task = await request(MSG.TAB_ROLE, {});
      tabRole = task && task.role ? task.role : null;
      const blocked = detectBlockedPage();
      if (blocked) {
        if (tabRole) send(MSG.WORKER_RESULT, { role: tabRole, ok: false, blocked });
        return;
      }
      if (tabRole === 'search') {
        try {
          const res = await runSearchPage(task);
          send(MSG.WORKER_RESULT, { role: 'search', ...res });
        } catch (e) {
          send(MSG.WORKER_RESULT, { role: 'search', ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (/\/job_detail\//.test(location.pathname)) {
        const res = await scrapeDetailPage();
        if (tabRole === 'detail') {
          if (res && res.ok) await humanDwell(task, res.textLength || 0);
          send(MSG.WORKER_RESULT, { role: 'detail', ...(res || { ok: false }) });
        }
      } else if (detectChat()) {
        const res = await runChatPage();
        if (tabRole === 'contacts') {
          await humanDwell(task);
          send(MSG.WORKER_RESULT, { role: 'contacts', ...res });
        }
      } else if (tabRole) {
        send(MSG.WORKER_RESULT, { role: tabRole, ok: false });
      }
    } finally {
      roleReady = true;
      // 用户自己打开的列表 / 详情页：启用「HR 活跃优先」按钮和隐藏已沟通卡片（含详情页的推荐列表）
      if (!tabRole && !detectChat()) initBossListUi();
    }
  }
  initPageRole().catch(() => { roleReady = true; });

  // ============================================================
  //  一键发送招呼语：DOM 自动化（等价于用户手动在聊天框打字并点发送）
  //  安全：仅在识别到聊天输入框时才填入；找不到就报错，绝不误填到搜索框。
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== MSG.SEND_GREETING) return false;
    (async () => {
      try {
        const r = await fillAndSend(String(msg.text || ''));
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // 异步响应
  });

  // —— 自动投递：在岗位详情页点「立即沟通」 ——
  // 只发起沟通，不自动发送任何消息；招呼语只在有草稿时预填进聊天框，发不发由用户决定。
  let lastApplyClick = { key: '', at: 0 };
  async function autoClickStartChat(text, expectedJobId) {
    const blocked = detectBlockedPage();
    if (blocked) return { ok: false, blocked };
    const m = location.pathname.match(/job_detail\/([\w~-]+)\.html/);
    const jobKey = m ? m[1] : '';
    // 目标岗位校验：岗位下架后可能被重定向到别的岗位 / 非详情页，绝不能对着错误页面点沟通
    if (expectedJobId && jobKey !== String(expectedJobId)) {
      return { ok: false, error: '当前页面岗位与清单不一致（可能已下架或跳转），已跳过' };
    }
    // 已经在聊天页：上一次点击已经进来了，或用户自己打开了聊天
    if (detectChat()) {
      const input = await waitFor(findChatInput, 8000);
      return input ? { ok: true, mode: 'chat' } : { ok: false, error: '聊天页输入框未出现' };
    }
    // 后台重试同一条 APPLY_CLICK 时不重复点：导航前的一次点击已经发出，再点会变成「继续沟通」
    if (lastApplyClick.key === (jobKey || location.href) && Date.now() - lastApplyClick.at < 60000) {
      return { ok: true, mode: 'clicked', repeat: true };
    }
    const start = await waitFor(findStartChatButton, 10000);
    if (!start) {
      const b = detectBlockedPage() || (detectLoginPrompt() ? 'login' : '');
      return b ? { ok: false, blocked: b } : { ok: false, error: '未找到「立即沟通」按钮（页面结构可能变了）' };
    }
    // 详情页上必须落在主操作区（岗位 banner / 详情容器 / 页面顶部已知主按钮），否则宁可失败也不乱点
    const inDetailScope = !!start.closest('.job-banner, .job-detail-container, .job-detail-box, .job-detail, .job-op, .job-detail-header, .job-primary');
    const mainClass = start.matches('a.btn-startchat, .btn-startchat, a.op-btn-chat, .op-btn-chat');
    const nearTop = start.getBoundingClientRect().top < innerHeight * 0.6;
    if (jobKey && !inDetailScope && !(mainClass && nearTop)) {
      return { ok: false, error: '找到的沟通按钮不在岗位主操作区，已跳过' };
    }
    if (isInsideJobCard(start)) return { ok: false, error: '找到的沟通按钮属于岗位卡片，已跳过' };
    const label = (start.textContent || '').trim();
    if (/继续沟通/.test(label)) return { ok: true, mode: 'already' };
    if (!/立即沟通|马上沟通|开始聊天/.test(label)) return { ok: false, error: `按钮文字不是立即沟通：${label}` };
    if (text) await savePendingGreeting(text); // 进入聊天页后由新页面接力填入，不自动发送
    lastApplyClick = { key: jobKey || location.href, at: Date.now() };
    // 先让本次 sendResponse 送达 background，再点击：导航会销毁当前 content-script、断开消息端口
    setTimeout(() => { try { start.click(); } catch {} }, 150);
    return { ok: true, mode: 'clicked' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== MSG.APPLY_CLICK) return false;
    (async () => {
      try {
        sendResponse(await autoClickStartChat(String(msg.text || ''), msg.jobId));
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  });

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // 定位聊天输入框：优先各平台已知选择器，再退化到「可见的大号可编辑元素」启发式
  function findChatInput() {
    const known = PLATFORM === 'boss'
      ? ['#chat-input', '.chat-input', '.conversation-editor [contenteditable]', '.chat-editor [contenteditable]', 'textarea.input-area']
      : ['.im-input textarea', '.message-input textarea', '[class*="chat-input"] textarea', '.im-editor [contenteditable]', 'textarea[placeholder*="消息"]', 'textarea[placeholder*="聊"]'];
    for (const sel of known) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    // 启发式兜底：页面里可见、可编辑、位于视口下半部、面积较大的编辑区
    const cands = Array.from(document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"]'))
      .filter(isVisible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > window.innerHeight * 0.4 && r.width > 120;
      });
    if (!cands.length) return null;
    // 取最靠下、最宽的一个（聊天框通常在底部且横向铺满）
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.top - ra.top) || (rb.width - ra.width);
    });
    return cands[0];
  }

  // 找发送按钮（在输入框附近优先）
  function findSendButton(input) {
    const byText = (root) =>
      Array.from(root.querySelectorAll('button, a, [role="button"], .btn-send, .send-message, .btn-v2'))
        .filter(isVisible)
        .find((b) => /发\s*送|send/i.test((b.textContent || b.getAttribute('title') || '')));
    // 先在输入框的容器里找
    let scope = input;
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) scope = scope.parentElement;
    return (scope && byText(scope)) || byText(document) || null;
  }

  // 找「开始/继续沟通」按钮：岗位详情页/列表抽屉里点它会（整页）跳转到聊天页。
  // 优先用真机实测确认的稳定 class；文字匹配作兜底（class 改版时仍能命中）。
  // 自动投递时尤其要避开列表卡片里的「立即沟通」——那会点开别的岗位，所以卡片内的按钮一律排除。
  function isInsideJobCard(el) {
    return !!el.closest('.job-card-wrap, .job-card-wrapper, .job-card-box, li.job-card-box, .rec-job-list, .job-list-box, .job-list-container');
  }
  function findStartChatButton() {
    const textOk = (b) => {
      const t = (b.textContent || '').trim();
      if (t.length > 12) return false;
      return PLATFORM === 'boss'
        ? /立即沟通|继续沟通|马上沟通|开始聊天/.test(t)
        : /立即沟通|继续沟通|在线沟通|聊一聊|投递并沟通/.test(t);
    };
    if (PLATFORM === 'boss') {
      // 实测：列表页抽屉 = a.op-btn-chat；独立详情页 = a.btn-startchat
      for (const sel of ['a.op-btn-chat', 'a.btn-startchat', '.op-btn-chat', '.btn-startchat']) {
        const el = document.querySelector(sel);
        if (el && isVisible(el) && !isInsideJobCard(el)) return el;
      }
    }
    // 主按钮一般在详情顶部：优先在详情容器里找，避免误点推荐卡片的沟通按钮
    for (const scopeSel of ['.job-banner', '.job-detail-container', '.job-detail-box', '.job-detail', '.job-op']) {
      const scope = document.querySelector(scopeSel);
      if (!scope) continue;
      const hit = Array.from(scope.querySelectorAll('a, button, [role="button"]')).find((b) => isVisible(b) && textOk(b) && !isInsideJobCard(b));
      if (hit) return hit;
    }
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], .btn, .op-btn, .btn-startchat, .start-chat'));
    return nodes.filter(isVisible).filter((b) => !isInsideJobCard(b)).find(textOk) || null;
  }

  // 轮询等待某元素出现（用于等按钮/输入框在 SPA 里渲染出来）
  async function waitFor(fn, maxMs, gap = 300) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 >= maxMs) return null;
      await new Promise((r) => setTimeout(r, gap));
    }
  }

  // —— 跨导航接力：暂存招呼语 ——
  // 实测：BOSS 点「立即沟通」是整页跳转到 /web/geek/chat，会销毁当前 content-script。
  // 故点击前把招呼语存进 storage，跳转后由聊天页新加载的 content-script 取出填入。
  const PENDING_KEY = 'jobHelperPendingGreetingV1';
  function savePendingGreeting(text) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [PENDING_KEY]: { text, platform: PLATFORM, at: Date.now() } }, () => resolve());
      } catch { resolve(); }
    });
  }
  // 一次性读取并清除（避免下次进聊天页误填旧招呼语）
  function takePendingGreeting() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(PENDING_KEY, (obj) => {
          const p = obj && obj[PENDING_KEY];
          chrome.storage.local.remove(PENDING_KEY, () => {});
          // 90 秒过期：超时的视为失效，不填
          if (p && p.text && Date.now() - (p.at || 0) < 90000) resolve(p);
          else resolve(null);
        });
      } catch { resolve(null); }
    });
  }

  // 聊天页接力：若本页是聊天页且有暂存招呼语，等输入框出现后填入（不自动发送，交用户确认）
  let pendingConsumed = false;
  async function consumePendingGreetingOnChatPage() {
    if (pendingConsumed || !detectChat()) return;
    pendingConsumed = true; // 同步占位，避免 init 与 MutationObserver 并发导致重复填入
    // 后台同步用的沟通页不能抢走用户前台打招呼的暂存招呼语（占位不释放，本页不再尝试）
    const role = await request(MSG.TAB_ROLE, {});
    if (role && role.role) return;
    // 先等输入框出现，再取 pending：直接进聊天页时会话未选中、输入框可能延迟或不渲染，
    // 若先取走 pending 再等，渲染失败就把招呼语弄丢了。等到输入框才消费，更稳。
    const input = await waitFor(findChatInput, 10000);
    if (!input) { pendingConsumed = false; return; } // 释放占位，等会话选中后由后续触发补填；招呼语仍在剪贴板
    const pending = await takePendingGreeting();
    if (!pending) return; // 已被其他触发消费
    setInputValue(input, pending.text);
  }

  // 写入值：textarea/input 与 contenteditable 分别处理，并派发框架能感知的事件
  function setInputValue(el, text) {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      el.textContent = '';
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  // 策略（真机实测校准）：
  //  - 已在聊天页（有 #chat-input）：直接填入招呼语，不自动发送（交用户确认，规避误发/封号）。
  //  - 在详情页/列表页（有「立即沟通」按钮、无输入框）：点它会整页跳转到 /web/geek/chat，
  //    会销毁当前 content-script。故先把招呼语存进 storage，再点按钮；跳转后由聊天页
  //    新加载的 content-script 接力填入（见 consumePendingGreetingOnChatPage）。
  async function fillAndSend(text) {
    const content = text.trim();
    if (!content) return { ok: false, error: '招呼语为空' };

    // 情形 A：已在聊天页，直接填（收紧到 detectChat，避免详情页启发式兜底误命中可编辑元素）
    let input = detectChat() ? findChatInput() : null;
    if (input) {
      setInputValue(input, content);
      return { ok: true, mode: 'filled', note: '已填入聊天框，请确认后发送' };
    }

    // 情形 B：等「立即沟通」按钮渲染出来
    const start = await waitFor(findStartChatButton, 6000);
    if (!start) {
      // 兜底：也许输入框正在延迟渲染
      input = await waitFor(findChatInput, 2000);
      if (input) {
        setInputValue(input, content);
        return { ok: true, mode: 'filled', note: '已填入聊天框，请确认后发送' };
      }
      return { ok: false, error: '未找到聊天入口。请在岗位详情页或聊天列表页再试（需能看到「立即沟通」或聊天输入框）。' };
    }

    // 点它会整页跳转 → 先存 pending，再点；跳转后聊天页接力填入。
    await savePendingGreeting(content);
    // 延迟点击，确保本次 sendResponse 先送达 background，再触发导航（导航会断开消息端口）
    setTimeout(() => { try { start.click(); } catch {} }, 150);
    return { ok: true, mode: 'navigating', note: '正在打开与 HR 的沟通窗口并填入招呼语' };
  }

  // ============================================================
  //  BOSS「HR 活跃优先」排序按钮（仅 BOSS）
  //  背景：BOSS 列表/详情接口都不返回岗位发布时间（已真机核实），
  //  故无法做真正的「按发布时间」排序。此按钮用 HR 在线状态(bossOnline)
  //  作为「岗位还新鲜/在招」的近似信号，把 HR 在线的岗位排到最前。
  //  纯前端重排已渲染的卡片，不发额外请求、不改数据。
  // ============================================================
  const bossOnlineMap = new Map(); // encryptJobId -> bossOnline(bool)
  let freshOn = false; // 排序开关
  let reapplyTimer = null;
  const originalIndex = new WeakMap(); // 卡片元素 -> 初始 DOM 次序，用于关闭时还原

  function recordBossOnline(payload) {
    try {
      const zp = payload && payload.zpData;
      const list = zp && (zp.jobList || zp.recommendJobList);
      if (!Array.isArray(list)) return;
      for (const j of list) {
        const id = j && (j.encryptJobId || j.jobId);
        if (!id) continue;
        bossOnlineMap.set(String(id), !!j.bossOnline);
        // 长时间不刷新页面时，推荐 / 搜索列表可能积累很多岗位；只保留最近 2000 个
        if (bossOnlineMap.size > 2000) bossOnlineMap.delete(bossOnlineMap.keys().next().value);
      }
    } catch {}
  }

  function scheduleReapplyFresh() {
    if (PLATFORM !== 'boss' || tabRole || !bossListUiInited) return;
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => {
      ensureFreshButton();
      if (freshOn) applyFreshSort();
      applyHiddenCards();
    }, 300);
  }

  // 找装所有岗位卡片的列表容器（推荐页 ul.rec-job-list；搜索页兜底）
  function findJobListContainer() {
    const known = document.querySelector('ul.rec-job-list, .job-list-box, .search-job-result ul, .job-list-container ul');
    if (known) return known;
    // 兜底：含最多卡片的公共父
    const cards = document.querySelectorAll('.job-card-wrap, li.job-card-box, .job-card-wrapper');
    if (!cards.length) return null;
    const count = new Map();
    cards.forEach((c) => {
      const p = c.closest('li') ? c.closest('li').parentElement : c.parentElement && c.parentElement.parentElement;
      if (p) count.set(p, (count.get(p) || 0) + 1);
    });
    let best = null, n = 0;
    count.forEach((v, k) => { if (v > n) { n = v; best = k; } });
    return best;
  }

  // 卡片本身通常不是滚动容器（列表常把 ul 撑开，真正滚动的是外层 div / window）。
  // 从卡片容器往上找第一个能滚的元素，找不到就用文档滚动区。
  function nearestScrollable(el) {
    let n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function countJobCards() {
    return document.querySelectorAll('.job-card-wrap, li.job-card-box, .job-card-wrapper').length;
  }

  // 列表容器里，每个「岗位行」= 容器的直接子元素
  function getJobRows(container) {
    if (!container) return [];
    return Array.from(container.children).filter((row) => row.querySelector('.job-card-wrap, .job-card-box, a[href*="job_detail"]'));
  }

  function rowEncryptId(row) {
    const a = row.querySelector('a[href*="job_detail"]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/job_detail\/([\w~-]+)\.html/);
    return m ? m[1] : null;
  }
  // 该行 HR 是否在线：先查接口捕获，再退化到 DOM 上的在线标记
  function rowOnline(row) {
    const id = rowEncryptId(row);
    if (id && bossOnlineMap.has(id)) return bossOnlineMap.get(id);
    return !!row.querySelector('.online-tag, [class*="online"]');
  }

  function applyFreshSort() {
    const container = findJobListContainer();
    if (!container) return;
    const rows = getJobRows(container);
    if (rows.length < 2) return;
    // 记录初始次序（仅首次）
    rows.forEach((row, i) => { if (!originalIndex.has(row)) originalIndex.set(row, i); });
    // 稳定排序：在线优先，组内保持原次序
    const sorted = rows.slice().sort((a, b) => {
      const oa = rowOnline(a) ? 0 : 1;
      const ob = rowOnline(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0);
    });
    // 只有次序变化时才动 DOM，避免闪烁
    let changed = false;
    for (let i = 0; i < sorted.length; i++) if (rows[i] !== sorted[i]) { changed = true; break; }
    if (changed) sorted.forEach((row) => container.appendChild(row));
    markFreshRows(rows);
  }

  function restoreOrder() {
    const container = findJobListContainer();
    if (!container) return;
    const rows = getJobRows(container);
    rows.sort((a, b) => (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0));
    rows.forEach((row) => container.appendChild(row));
    rows.forEach((row) => row.classList.remove('jh-fresh-row'));
  }

  // 给在线岗位行加一个小标记，便于一眼识别
  function markFreshRows(rows) {
    rows.forEach((row) => {
      if (rowOnline(row)) row.classList.add('jh-fresh-row');
      else row.classList.remove('jh-fresh-row');
    });
  }

  // —— 注入按钮 ——
  let freshBtn = null;
  function ensureFreshButton() {
    if (PLATFORM !== 'boss') return;
    if (freshBtn && document.contains(freshBtn)) return;
    const anchor = findFilterBarAnchor();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jh-fresh-btn' + (freshOn ? ' jh-on' : '');
    btn.innerHTML = '<span class="jh-fresh-dot"></span><span class="jh-fresh-label">HR 活跃优先</span>';
    btn.title = 'BOSS 未提供岗位发布时间，此排序按 HR 在线/活跃度把更可能在招的岗位排到前面';
    btn.addEventListener('click', () => {
      freshOn = !freshOn;
      btn.classList.toggle('jh-on', freshOn);
      if (freshOn) applyFreshSort();
      else restoreOrder();
    });
    freshBtn = btn;
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(btn, anchor); // 放在筛选栏「清空」等锚点前
      btn.classList.remove('jh-floating');
    } else {
      btn.classList.add('jh-floating'); // 兜底：浮动在列表右上
      (document.body || document.documentElement).appendChild(btn);
    }
  }

  // 定位筛选栏锚点：返回一个「插入基准元素」，按钮插到它前面。
  // 依 2026-09 真机 DOM：筛选栏 = .c-filter-condition.filter-condition-inner，
  // 末端是 a.clear-search-btn(「清空」)——插在它前面正好落在筛选项右侧。
  function findFilterBarAnchor() {
    const clear = document.querySelector('.clear-search-btn');
    if (clear && isVisible(clear)) return clear;
    const inner = document.querySelector('.c-filter-condition.filter-condition-inner, .filter-condition-inner, .c-filter-condition');
    if (inner && isVisible(inner)) {
      // 没有清空按钮时，追加到筛选栏末尾（用一个占位末元素作基准）
      return inner.lastElementChild || inner;
    }
    // 退化：找一个含多个筛选项文字的容器，返回其最后一个子节点作锚
    const kw = ['薪资待遇', '工作经验', '学历要求', '公司行业', '公司规模'];
    let best = null, score = 0;
    document.querySelectorAll('div,ul,section').forEach((d) => {
      if (d.children.length < 3 || d.children.length > 16) return;
      const t = d.textContent || '';
      if (t.length > 600) return;
      const s = kw.filter((k) => t.indexOf(k) >= 0).length;
      if (s > score) { score = s; best = d; }
    });
    return best && score >= 3 ? best.lastElementChild : null;
  }

  // ============================================================
  //  BOSS 列表页：隐藏已屏蔽 / 已沟通的岗位卡片
  //  只改本页 DOM 的显示，不发请求、不改平台数据；规则与收录一致（读同一份 storage）。
  // ============================================================
  const STORE = { settings: 'jobHelperSettingsV1', blocked: 'jobHelperBlockedV1', contacts: 'jobHelperContactsV1' };
  const listMeta = new Map(); // encryptJobId -> { company, title }
  let hideRules = null;

  function recordListMeta(payload) {
    try {
      const zp = payload && payload.zpData;
      const list = zp && (zp.jobList || zp.recommendJobList);
      if (!Array.isArray(list)) return;
      for (const j of list) {
        const id = j && (j.encryptJobId || j.jobId);
        if (!id) continue;
        listMeta.set(String(id), { company: String(j.brandName || ''), title: String(j.jobName || '') });
        if (listMeta.size > 2000) listMeta.delete(listMeta.keys().next().value);
      }
    } catch {}
  }

  // 与 common/platforms.js 的 normCompany / contactStatus 保持一致（此处为独立副本）
  const normCompany = (s) => String(s || '').trim().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();

  function loadHideRules() {
    try {
      chrome.storage.local.get([STORE.settings, STORE.blocked, STORE.contacts], (got) => {
        const st = got[STORE.settings] || {};
        const blocked = new Set();
        for (const b of got[STORE.blocked] || []) {
          if (b && typeof b.uid === 'string' && b.uid.startsWith('boss:')) blocked.add(b.uid.slice(5));
        }
        const jobIds = new Set();
        const pairs = new Set();
        const companies = new Set();
        for (const c of got[STORE.contacts] || []) {
          if (!c) continue;
          if (c.jobId) jobIds.add(c.jobId);
          const co = normCompany(c.company);
          if (co) {
            companies.add(co);
            if (c.title) pairs.add(`${co}|${String(c.title).trim()}`);
          }
        }
        hideRules = {
          blocked, jobIds, pairs, companies,
          skipContacted: st.skipContacted !== false,
          skipCompanies: st.skipContactedCompanies !== false,
        };
        applyHiddenCards();
      });
    } catch {}
  }

  function cardShouldHide(id, meta) {
    const r = hideRules;
    if (!r) return false;
    if (id && r.blocked.has(id)) return true;
    if (!r.skipContacted) return false;
    if (id && r.jobIds.has(id)) return true;
    const co = normCompany(meta.company);
    if (!co) return false;
    if (r.pairs.has(`${co}|${meta.title.trim()}`)) return true;
    return r.skipCompanies && r.companies.has(co);
  }

  function applyHiddenCards() {
    if (PLATFORM !== 'boss' || !hideRules) return;
    document.querySelectorAll('.job-card-wrap, li.job-card-box, .job-card-wrapper').forEach((card) => {
      const row = card.closest('li') || card;
      const a = card.querySelector('a[href*="job_detail"]') || (card.matches('a[href*="job_detail"]') ? card : null);
      const m = a && a.getAttribute('href').match(/job_detail\/([\w~-]+)\.html/);
      const id = m ? m[1] : '';
      const meta = listMeta.get(id) || {
        company: txt(card, '.boss-name') || txt(card, '.company-name'),
        title: txt(card, '.job-name') || txt(card, '.job-title'),
      };
      row.classList.toggle('jh-hidden-row', cardShouldHide(id, meta));
    });
  }

  // 列表页的「HR 活跃优先」/ 隐藏已沟通卡片只在用户自己浏览的标签里启用。
  // 后台搜索标签也匹配这些选择器，隐藏行或重排会影响滚动加载，必须在 worker 标签里跳过。
  let bossListUiInited = false;
  function initBossListUi() {
    if (PLATFORM !== 'boss' || bossListUiInited) return;
    bossListUiInited = true;
    loadHideRules();
    // 侧边栏里屏蔽 / 同步了已沟通 / 改了设置：立即刷新本页卡片
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[STORE.settings] || changes[STORE.blocked] || changes[STORE.contacts]) loadHideRules();
      });
    } catch {}
    injectFreshStyles();
    // 首屏与后续渲染都尝试注入按钮
    const kick = () => { ensureFreshButton(); if (freshOn) applyFreshSort(); };
    setTimeout(kick, 1200);
    setTimeout(kick, 3000);
    // 列表/筛选栏因 SPA 重渲染时，补注入 + 重排
    try {
      new MutationObserver(() => scheduleReapplyFresh()).observe(document.body || document.documentElement, {
        subtree: true, childList: true,
      });
    } catch {}
  }

  function injectFreshStyles() {
    if (document.getElementById('jh-fresh-style')) return;
    const css = `
      .jh-fresh-btn{display:inline-flex;align-items:center;gap:6px;margin:0 8px;padding:5px 12px;
        font-size:13px;font-weight:500;color:#00a6a7;background:rgba(0,166,167,0.10);
        border:1px solid rgba(0,166,167,0.35);border-radius:16px;cursor:pointer;line-height:1.2;
        font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;transition:all .18s;vertical-align:middle;}
      .jh-fresh-btn:hover{background:rgba(0,166,167,0.16);}
      .jh-fresh-btn.jh-on{color:#fff;background:#00a6a7;border-color:#00a6a7;}
      .jh-fresh-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85;}
      .jh-fresh-btn.jh-floating{position:fixed;top:120px;right:20px;z-index:99998;
        box-shadow:0 4px 16px rgba(0,0,0,.12);background:#fff;}
      .jh-fresh-btn.jh-floating.jh-on{background:#00a6a7;color:#fff;}
      .jh-hidden-row{display:none !important;}
      .jh-fresh-row{position:relative;}
      .jh-fresh-row::after{content:"HR活跃";position:absolute;top:8px;right:8px;z-index:2;
        font-size:11px;font-weight:600;color:#00a6a7;background:rgba(0,166,167,0.12);
        padding:1px 7px;border-radius:8px;pointer-events:none;}
    `;
    const style = document.createElement('style');
    style.id = 'jh-fresh-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  if (PLATFORM === 'boss') {
    // 后台任务页的角色还没确认，等 initPageRole 决定是否启用列表页 UI
  }
})();
