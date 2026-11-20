// ==UserScript==
// @name         new鱼排宠物助手
// @namespace    https://github.com/Mairo/fishpi-auto-pet
// @version      1.2.0
// @description  new.fishpi.cn / fishpi.cn 宠物系统自动助手：自动照顾、自动安排活动与领奖、自动休息、小铺补货、每日补给、故事奖励、合成、多标签页互斥
// @author       Mairo
// @match        https://new.fishpi.cn/*
// @match        https://fishpi.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      fishpi.cn
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   * 常量与配置
   * ================================================================ */
  const API_BASE = 'https://fishpi.cn';
  const SCRIPT_VER = '1.2.0';
  const PAGES_PATH_RE = /^\/pets(\/|$)/; // 只在宠物页面运行

  const ACTIVITY_LABEL = { outing: '外出', course: '学校', work: '兼职', rest: '休息' };

  const DEFAULT_SETTINGS = {
    ver: '', // 设置结构版本（升级时做一次迁移）
    enabled: true, // 总开关
    autoCare: true, // 自动照顾（喂食/浇水/玩耍）
    autoSchedule: true, // 自动安排活动 + 领奖
    autoRest: true, // 精力不足自动休息
    autoCoffee: true, // 精力不足先喝咖啡（每日 3 杯），喝不到才休息
    priority: '', // 旧版字段（已废弃，仅用于迁移）
    strategy: 'balanced', // 活动策略：balanced 均衡 / exp 快速涨经验 / coins 快速金币
    careThreshold: 20, // 低于此值开始照顾（饥饿/口渴/心情）
    energyRestThreshold: 25, // 低于此精力值就休息
    minEnergyForActivity: 10, // 精力低于此值不安排任何活动（安全边际）
    pollInterval: 10, // 状态检查间隔（秒）
    autoSupply: true, // 自动领每日补给
    autoRestock: true, // 家园小铺自动补货（只买口粮）
    foodBuyThreshold: 5, // 口粮低于此值就补
    foodBuyTarget: 10, // 补到多少件
    autoStory: true, // 自动领故事奖励
    autoCraft: true, // 自动合成（材料够就做）
    autoBrawlFight: true, // 乱斗：每日闯关 3 场拿材料
    autoBrawlUpgrade: true, // 乱斗：材料够就强化出战武器
    earlyWake: true, // 精力够了提前叫醒
    singleTab: true, // 多标签页只让一个跑
    reloadOnClaim: true, // 领奖/叫醒后刷新页面同步
    toast: true,
    gmNotify: false,
  };

  const KEY_SETTINGS = 'fp_pet_settings';
  const KEY_LOG = 'fp_pet_log';

  // 三种策略：权重表示「同样的 1 点精力，优先换回什么」
  const STRATEGY_LABEL = { balanced: '均衡发展', exp: '快速涨经验', coins: '快速金币' };
  const STRATEGY_WEIGHT = {
    // 金币/经验/熟练度 三样都要，经验和熟练度稍加权（成长更慢、更值钱）
    balanced: { coins: 1, experience: 2, proficiency: 3 },
    // 经验 > 熟练度 > 金币，基本会去打学习类
    exp: { coins: 0.2, experience: 6, proficiency: 5 },
    // 金币压倒一切，基本会去做兼职
    coins: { coins: 5, experience: 0.5, proficiency: 0.5 },
  };

  /* ================================================================
   * 存储
   * ================================================================ */
  function loadJSON(key, def) {
    try {
      const raw = GM_getValue(key, '');
      if (!raw) return JSON.parse(JSON.stringify(def));
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? Object.assign(JSON.parse(JSON.stringify(def)), v) : JSON.parse(JSON.stringify(def));
    } catch (e) {
      return JSON.parse(JSON.stringify(def));
    }
  }
  function saveJSON(key, val) {
    try {
      GM_setValue(key, JSON.stringify(val));
    } catch (e) {
      console.error('[宠物助手] 存储失败', e);
    }
  }

  let settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON(KEY_SETTINGS, DEFAULT_SETTINGS));
  let logEntries = loadJSON(KEY_LOG, []);
  if (!Array.isArray(logEntries)) logEntries = [];

  const saveSettings = () => saveJSON(KEY_SETTINGS, settings);
  const saveLog = () => saveJSON(KEY_LOG, logEntries);

  // v1.0.5 迁移：恢复总开关；旧默认阈值换新默认值；旧的「优先级字符串」转换成新策略
  if (settings.ver !== SCRIPT_VER) {
    settings.enabled = true;
    if (num(settings.careThreshold, 0) === 30) settings.careThreshold = 20;
    if (num(settings.energyRestThreshold, 0) === 40) settings.energyRestThreshold = 25;
    if (num(settings.minEnergyForActivity, 0) === 20) settings.minEnergyForActivity = 10;
    if (num(settings.pollInterval, 0) === 45) settings.pollInterval = 10;
    // 旧默认 work,outing,course 实际效果就是「只做兼职」→ 映射为快速金币
    if (typeof settings.priority === 'string' && settings.priority) {
      const first = settings.priority.split(/[,，\s]+/)[0];
      settings.strategy = first === 'work' ? 'coins' : first === 'course' ? 'exp' : 'balanced';
    }
    if (!STRATEGY_LABEL[settings.strategy]) settings.strategy = 'balanced';
    delete settings.priority;
    delete settings.smartPick;
    settings.ver = SCRIPT_VER;
    saveSettings();
  }

  /* ================================================================
   * 日志 / 提示
   * ================================================================ */
  function log(kind, text) {
    const entry = { t: Date.now(), kind, text };
    logEntries.push(entry);
    if (logEntries.length > 120) logEntries = logEntries.slice(-80);
    saveLog();
    renderLog();
    if (kind === 'fail' || kind === 'error') console.warn('[宠物助手]', text);
    else console.log('[宠物助手]', text);
  }

  let toastTimer = null;
  function toast(msg, type) {
    if (!settings.toast && type !== 'error') return;
    if (!document.body) return;
    let el = document.getElementById('fp-pet-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fp-pet-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = (type || 'info') + ' show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = '';
    }, 3000);
  }

  function browserNotify(title, body) {
    if (!settings.gmNotify) return;
    try {
      GM_notification({ title, text: body, timeout: 4000 });
    } catch (e) {
      /* ignore */
    }
  }

  /* ================================================================
   * HTTP（页面 fetch 优先，GM_xhr 兜底，250ms 串行节流）
   * token 策略（v1.0.2）：GM 缓存 → 捕获官方 token → 兜底自己 refresh（带锁+冷却）
   * ================================================================ */
  const KEY_TOKEN = 'fp_pet_token';
  const KEY_RLOCK = 'fp_pet_rlock';
  let accessToken = '';
  try {
    accessToken = GM_getValue(KEY_TOKEN, '') || '';
  } catch (e) {
    /* ignore */
  }

  function saveToken(t, fromOfficial) {
    if (!t || t === accessToken) return;
    accessToken = t;
    try {
      GM_setValue(KEY_TOKEN, t);
    } catch (e) {
      /* ignore */
    }
    // token 只有在「变化」时才记这一行，方便确认官方链路在喂 token
    if (fromOfficial) {
      try {
        log('info', '已同步官方 token');
      } catch (e) {
        /* ignore */
      }
    }
  }
  function loadCachedToken() {
    try {
      return GM_getValue(KEY_TOKEN, '') || '';
    } catch (e) {
      return '';
    }
  }

  function grabAuthHeader(h) {
    try {
      if (!h) return;
      let v = null;
      if (typeof Headers !== 'undefined' && h instanceof Headers) v = h.get('Authorization');
      else if (Array.isArray(h)) {
        for (let i = 0; i < h.length; i++) {
          const kv = h[i];
          if (kv && String(kv[0]).toLowerCase() === 'authorization') v = kv[1];
        }
      } else if (typeof h === 'object') {
        const k = Object.keys(h).find((x) => x.toLowerCase() === 'authorization');
        if (k) v = h[k];
      }
      const m = /^Bearer\s+(.+)$/i.exec(String(v || '').trim());
      if (m && m[1]) saveToken(m[1], true);
    } catch (e) {
      /* ignore */
    }
  }

  function installTokenCapture() {
    try {
      const W = unsafeWindow;
      // 用本脚本独有的标记，避免和其他脚本（如红包助手）的 __fpTokHook 互相顶掉
      if (W.fetch && !W.fetch.__fpPetTokHook) {
        const origFetch = W.fetch;
        const wrapped = function (input, init) {
          try {
            if (init && init.headers) grabAuthHeader(init.headers);
            else if (typeof Request !== 'undefined' && input instanceof Request) grabAuthHeader(input.headers);
          } catch (e) {
            /* ignore */
          }
          const p = origFetch.apply(this, arguments);
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (/\/api\/v3\/auth\/refresh(\?|$)/.test(url)) {
              Promise.resolve(p).then((res) => {
                try {
                  res
                    .clone()
                    .json()
                    .then((j) => {
                      if (j && j.code === 0 && j.data && typeof j.data.accessToken === 'string') saveToken(j.data.accessToken);
                    })
                    .catch(() => {});
                } catch (e) {
                  /* ignore */
                }
              }, () => {});
            }
          } catch (e) {
            /* ignore */
          }
          return p;
        };
        wrapped.__fpPetTokHook = true;
        W.fetch = wrapped;
      }
      const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (proto && !proto.__fpPetTokHook) {
        const origSRH = proto.setRequestHeader;
        proto.setRequestHeader = function (k, v) {
          try {
            if (String(k).toLowerCase() === 'authorization') {
              const m = /^Bearer\s+(.+)$/i.exec(String(v));
              if (m && m[1]) saveToken(m[1], true);
            }
          } catch (e) {
            /* ignore */
          }
          return origSRH.apply(this, arguments);
        };
        proto.__fpPetTokHook = true;
      }
    } catch (e) {
      /* ignore */
    }
  }
  installTokenCapture();

  let reqChain = Promise.resolve();
  let nextReqAt = 0;
  const REQ_GAP = 250;

  function rawRequest(method, path, body, headers, noAuth) {
    const run = () => {
      const now = Date.now();
      const wait = Math.max(0, nextReqAt - now);
      nextReqAt = Math.max(now, nextReqAt) + REQ_GAP;
      return (wait > 0 ? sleep(wait) : Promise.resolve()).then(() => doRawRequest(method, path, body, headers, noAuth));
    };
    const p = reqChain.then(run, run);
    reqChain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  function doRawRequest(method, path, body, headers, noAuth) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (accessToken && !noAuth) h['Authorization'] = 'Bearer ' + accessToken;
    const url = API_BASE + path;
    const init = { method, headers: h, credentials: 'include' };
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);

    const parse = (status, responseHeaders, text) => {
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        /* 非 JSON */
      }
      return { status, json, text, responseHeaders };
    };

    const gmFallback = () =>
      new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers: h,
          data: init.body,
          timeout: 15000,
          onload(r) {
            resolve(parse(r.status, r.responseHeaders || '', r.responseText));
          },
          onerror() {
            reject(new Error('网络请求失败：' + path));
          },
          ontimeout() {
            reject(new Error('请求超时：' + path));
          },
        });
      });

    // 页面原生 fetch：Origin/Cookie 与官方一致；服务端校验请求来源
    // 加超时，避免连接挂起时整个请求队列（reqChain）被永久堵住
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    const reqInit = ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init;
    return fetch(url, reqInit)
      .then(
        (r) => r.text().then((t) => parse(r.status, r.headers.get('retry-after') ? 'retry-after: ' + r.headers.get('retry-after') : '', t)),
        () => gmFallback()
      )
      .then(
        (v) => {
          if (timer) clearTimeout(timer);
          return v;
        },
        (e) => {
          if (timer) clearTimeout(timer);
          throw e;
        }
      );
  }

  class ApiError extends Error {
    constructor(msg, code, status) {
      super(msg);
      this.code = code;
      this.status = status;
    }
  }

  let rateLimitUntil = 0; // 429 退避截止
  let rateLimitHits = 0; // 连续 429 次数（用于指数退避）

  let refreshCooldownUntil = 0;
  let refreshChain = Promise.resolve();

  function refreshToken() {
    const p = refreshChain.then(() => doRefreshToken(), () => doRefreshToken());
    refreshChain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  async function doRefreshToken() {
    // 冷却期内：先等页面捕获的 token（官方刷新比我们自己刷安全）
    if (Date.now() < refreshCooldownUntil) {
      for (let i = 0; i < 10 && !accessToken; i++) await sleep(300);
      if (accessToken) return accessToken;
    }
    // 跨标签页锁：多标签同时 refresh 会互相作废对方的凭据
    let lock = 0;
    try {
      lock = Number(GM_getValue(KEY_RLOCK, 0)) || 0;
    } catch (e) {
      /* ignore */
    }
    if (lock > Date.now()) {
      for (let i = 0; i < 20 && !accessToken && Date.now() < lock; i++) await sleep(300);
      if (accessToken) return accessToken;
    }
    try {
      GM_setValue(KEY_RLOCK, String(Date.now() + 8000));
    } catch (e) {
      /* ignore */
    }

    const r = await rawRequest('POST', '/api/v3/auth/refresh', {}, undefined, true);
    if (r.status === 429) {
      const m = /retry-after\s*:\s*(\d+)/i.exec(r.responseHeaders || '');
      rateLimitUntil = Date.now() + (m ? Number(m[1]) : 60) * 1000;
      refreshCooldownUntil = Date.now() + 30000;
      throw new ApiError('操作过于频繁（429），请稍后', 'rate_limited', 429);
    }
    if (!r.json || r.json.code !== 0 || !r.json.data || typeof r.json.data.accessToken !== 'string') {
      refreshCooldownUntil = Date.now() + 30000;
      throw new ApiError((r.json && r.json.msg) || '获取登录凭据失败，请先登录 fishpi.cn', r.json ? r.json.code : 'no_response', r.status);
    }
    saveToken(r.json.data.accessToken);
    refreshCooldownUntil = Date.now() + 30000;
    try {
      GM_setValue(KEY_RLOCK, '0');
    } catch (e) {
      /* ignore */
    }
    return accessToken;
  }

  async function api(method, path, body, headers) {
    if (Date.now() < rateLimitUntil) {
      throw new ApiError('接口频控暂停中', 'rate_limited', 429);
    }
    if (!accessToken) {
      // 先给页面一点时间带出官方 token（避免与官方抢 refresh），等不到才自己刷
      for (let i = 0; i < 5 && !accessToken; i++) await sleep(200);
      if (!accessToken) await refreshToken();
    }
    let r = await rawRequest(method, path, body, headers);
    if (r.status === 401) {
      const cached = loadCachedToken();
      if (cached && cached !== accessToken) {
        accessToken = cached;
      } else {
        // 当前 token 已被服务端拒绝：清掉缓存里的废 token 再强制刷新，
        // 否则 refreshToken() 的冷却分支会把同一个废 token 原样返回，重试必然再 401
        accessToken = '';
        try {
          GM_setValue(KEY_TOKEN, '');
        } catch (e) {
          /* ignore */
        }
        await refreshToken();
      }
      r = await rawRequest(method, path, body, headers);
    }
    if (r.status === 429) {
      const m = /retry-after\s*:\s*(\d+)/i.exec(r.responseHeaders || '');
      const base = m ? Number(m[1]) : 60;
      rateLimitHits = Math.min(rateLimitHits + 1, 5);
      // 连续 429 指数退避：60s → 120s → 240s → 300s（上限 5 分钟）
      const waitSec = Math.min(300, Math.max(base, 30 * Math.pow(2, rateLimitHits - 1)));
      rateLimitUntil = Date.now() + waitSec * 1000;
      log('fail', `⚠️ 429 限流：${method} ${path}，退避 ${waitSec} 秒（连续第 ${rateLimitHits} 次）`);
      throw new ApiError('操作过于频繁（429）', 'rate_limited', 429);
    }
    if (!r.json) throw new ApiError('接口返回非 JSON（' + r.status + '）', 'invalid_response', r.status);
    if (r.json.code === 'pet_verification_required') {
      // 风控要求验证：单独记事件，便于统计触发频率与触发前的操作
      log('error', `⚠️ 触发人机验证要求：${method} ${path}（pet_verification_required）`);
      throw new ApiError(r.json.msg || '需要人机验证', 'pet_verification_required', r.status);
    }
    if (r.json.code !== 0) {
      throw new ApiError(r.json.msg || '请求失败', r.json.code, r.status);
    }
    rateLimitHits = 0;
    return r.json.data;
  }

  /* ================================================================
   * 宠物接口
   * ================================================================ */
  let petState = null; // 宠物本体（GET /api/v3/me/pet 的 data.pet）
  let petData = null; // 完整 data（wallet / income / inventory / dailySupply）
  let serverOffset = 0; // 服务端时间 - 本地时间（ms），用于活动倒计时校准
  let catalog = null; // GET /api/v3/pets/catalog 的 data
  let catalogVersion = null;
  let riskState = { verificationRequired: false, retryAt: 0, expiresAt: 0 };
  let activityDumped = false; // 活动结构 dump 一次，便于排障

  function getCatalog() {
    return api('GET', '/api/v3/pets/catalog');
  }
  function getPetState() {
    return api('GET', '/api/v3/me/pet');
  }
  function getRisk() {
    return api('GET', '/api/v3/me/pet/risk');
  }
  function getBrawlProfile() {
    return api('GET', '/api/v3/me/pet/brawl');
  }
  // 咖啡状态：price/energy/dailyLimit/remaining/balance/version
  function getCoffee() {
    return api('GET', '/api/v3/me/pet/coffee');
  }
  // 乱斗写操作（闯关/强化等）：与官方一致，走 Idempotency-Key
  async function brawlAct(path, body, label) {
    const headers = { 'Idempotency-Key': opKey() };
    const r = await api('POST', `/api/v3/me/pet/brawl${path}`, body, headers);
    log('info', `${label}成功`);
    toast(`✅ ${label}`, 'info');
    return r;
  }

  // 动作/领奖统一走 Idempotency-Key
  function opKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'fp-pet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function act(kind, body, label) {
    const headers = { 'Idempotency-Key': opKey() };
    const r = await api('POST', `/api/v3/me/pet/${kind}`, body, headers);
    log('info', `${label}成功`);
    toast(`✅ ${label}`, 'info');
    return r;
  }

  async function doAction(action, label, extra) {
    const body = Object.assign({ petId: petState.id, action }, extra || {});
    return act('actions', body, label);
  }

  async function startActivity(kind, entryId) {
    const body = { petId: petState.id, kind, entryId, activityVersion: catalog.activityVersion };
    return act('activities', body, `安排活动「${ACTIVITY_LABEL[kind] || kind}」`);
  }

  async function claimActivity(activityId) {
    const body = { petId: petState.id, activityId };
    return act('activities/claim', body, '领取活动成果');
  }

  async function startRest() {
    return doAction('rest', '安排休息');
  }

  async function wakeRest() {
    return doAction('wake', '叫醒休息');
  }

  /* ================================================================
   * 宠物数据读取（兼容多种字段）
   * ================================================================ */
  function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function petName() {
    return (petState && petState.name) || '宠物';
  }

  function activityEndsAt(a) {
    if (!a) return 0;
    const cands = [a.endsAt, a.endAt, a.finishAt, a.finishesAt];
    for (const c of cands) {
      const n = num(c, 0);
      // 兼容毫秒/秒两种时间戳
      if (n > 1e12) return n;
      if (n > 1e9) return n * 1000;
    }
    return 0;
  }

  function activityLeftSec(a) {
    const end = activityEndsAt(a);
    if (!end) return 0;
    const nowMs = Date.now() + serverOffset;
    return Math.max(0, Math.round((end - nowMs) / 1000));
  }

  // catalog 里找活动条目（按 id 匹配），拿时长/精力消耗等
  function findEntry(entryId) {
    if (!catalog) return null;
    const lists = [catalog.entries, catalog.activities, catalog.activityEntries, catalog.jobs, catalog.places, catalog.courses];
    for (const list of lists) {
      if (Array.isArray(list)) {
        const hit = list.find((x) => x && String(x.id) === String(entryId));
        if (hit) return hit;
      }
    }
    // 兜底：深度找 id 匹配
    return deepFind(catalog, entryId, 0);
  }

  function deepFind(obj, entryId, depth) {
    if (!obj || depth > 4) return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = deepFind(item, entryId, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof obj === 'object') {
      if (obj.id && String(obj.id) === String(entryId)) return obj;
      for (const k of Object.keys(obj)) {
        const r = deepFind(obj[k], entryId, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // 可用活动条目列表（catalog 结构：places=外出 / courses=学校 / jobs=兼职，
  // 条目本身没有 kind 字段，v1.0.2 在这里判断 kind 导致永远拿不到条目）
  function activityEntriesByKind() {
    const map = { outing: [], course: [], work: [] };
    if (!catalog) return map;
    const pick = (list) => (Array.isArray(list) ? list.filter((x) => x && x.id) : []);
    map.outing = pick(catalog.places);
    map.course = pick(catalog.courses);
    map.work = pick(catalog.jobs);
    // 兜底：兼容条目自带 kind/type 的结构
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const k = node.kind || node.type;
      if (k && map[k]) {
        const id = String(node.id || node.entryId || '');
        if (id && !map[k].some((x) => String(x.id) === id)) map[k].push(node);
      }
      Object.values(node).forEach(visit);
    };
    if (!map.outing.length || !map.course.length || !map.work.length) visit(catalog);
    return map;
  }

  // 三种活动类型
  const ALL_KINDS = ['work', 'outing', 'course'];
  const KIND_LABEL = { work: '兼职', outing: '外出', course: '学习' };

  // 休息恢复速率（精力/小时）：优先用 catalog 规则，缺省 20（从实测倒推）
  function restEnergyPerHour() {
    const rules = catalog && catalog.rules;
    const r = rules && num(rules.restEnergyPerHour, 0);
    return r > 0 ? r : 20;
  }

  function strategy() {
    return STRATEGY_WEIGHT[settings.strategy] ? settings.strategy : 'balanced';
  }

  // 今日成长已满 → 经验权重失效，一切按金币选
  function expCapped() {
    const g = petState && petState.growthToday;
    if (!g) return false;
    const limit = num(g.limit, 0);
    return limit > 0 && num(g.used, 0) >= limit;
  }

  // 实际生效的策略（成长满时自动降级为刷金币）
  function effectiveStrategy() {
    return expCapped() ? 'coins' : strategy();
  }

  function strategyOptions(selected) {
    return Object.keys(STRATEGY_LABEL)
      .map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${STRATEGY_LABEL[k]}</option>`)
      .join('');
  }

  /* ---- 宠物数据/冷却/背包辅助 ---- */
  function serverNow() {
    return Date.now() + serverOffset;
  }

  function invQty(itemId) {
    const inv = (petData && petData.inventory) || [];
    const hit = inv.find((x) => x && x.itemId === itemId);
    return hit ? num(hit.quantity, 0) : 0;
  }

  // 喂食必须带 itemId（服务端只认背包里的口粮道具）
  function foodItemId() {
    const items = (catalog && catalog.items) || [];
    const inv = (petData && petData.inventory) || [];
    for (const it of inv) {
      if (!it || num(it.quantity, 0) <= 0) continue;
      const def = items.find((x) => x && x.id === it.itemId);
      if (def && def.category === 'food') return it.itemId;
    }
    if (items.some((x) => x && x.id === 'food') && invQty('food') > 0) return 'food';
    return '';
  }

  // 服务端动作冷却（careAvailableAt.feed / .water / cooldowns.play）
  function careCooldown(kind) {
    const p = petState || {};
    const now = serverNow();
    if (kind === 'feed' || kind === 'water') {
      const ca = p.careAvailableAt || {};
      return num(ca[kind], 0) > now;
    }
    const cd = p.cooldowns || {};
    return num(cd[kind], 0) > now;
  }

  function skillExp(skillId) {
    const list = (petState && petState.skills) || [];
    const hit = list.find((s) => s && s.id === skillId);
    return hit ? num(hit.experience, 0) : 0;
  }

  // 活动条目前置条件（技能经验 / 兼职的等级要求）
  function requirementsMet(entry, kind) {
    const reqs = Array.isArray(entry && entry.requirements) ? entry.requirements : [];
    for (const r of reqs) {
      if (!r) continue;
      if (skillExp(r.skillId) < num(r.experience, 0)) return false;
    }
    if (kind === 'work' && entry && entry.requirement) {
      if (skillExp(entry.requirement.skillId) < num(entry.requirement.experience, 0)) return false;
    }
    return true;
  }

  // 性价比打分：收益 ÷ (活动时长 + 恢复该活动精力所需休息时长)
  // 精力不是瓶颈——休息是按固定速率恢复的，真正的代价是「时间」（活动时长 + 回蓝时长）
  function strategyScore(entry) {
    const r = (entry && entry.rewards) || {};
    const w = STRATEGY_WEIGHT[effectiveStrategy()];
    const gain = num(r.coins, 0) * w.coins + num(r.experience, 0) * w.experience + num(r.proficiency, 0) * w.proficiency;
    const energy = num(entry && entry.cost && entry.cost.energy, 0);
    const rate = restEnergyPerHour();
    // 活动时长 + 精力÷恢复速率（小时换算成毫秒）
    const cycleMs = Math.max(1, num(entry && entry.durationMs, 0) + (energy / rate) * 3600000);
    return gain / cycleMs;
  }

  /* ---- 小铺 / 每日补给 / 故事 / 合成 ---- */
  function foodItemsInCatalog() {
    return ((catalog && catalog.items) || []).filter((x) => x && x.category === 'food');
  }

  function foodStock() {
    const list = foodItemsInCatalog();
    if (!list.length) return invQty('food');
    return list.reduce((n, it) => n + invQty(it.id), 0);
  }

  // 只买最便宜的口粮（同价取饱食度更高的）
  function cheapestFood() {
    const list = foodItemsInCatalog().filter((x) => x.price != null && num(x.price, 0) > 0);
    list.sort(
      (a, b) =>
        num(a.price, 0) - num(b.price, 0) ||
        num(b.effects && b.effects.hunger, 0) - num(a.effects && a.effects.hunger, 0)
    );
    return list[0] || null;
  }

  let lastShopWarnAt = 0;
  function shopWarn(text) {
    if (Date.now() - lastShopWarnAt < 10 * 60 * 1000) return;
    lastShopWarnAt = Date.now();
    log('fail', text);
    browserNotify('宠物助手', text);
  }

  // 家园小铺补货：口粮低于阈值 → 买最便宜的口粮补到目标数量
  async function tryRestock() {
    if (!catalog || !petData || !petState) return false;
    const th = Math.max(1, num(settings.foodBuyThreshold, 5));
    const target = Math.max(th, num(settings.foodBuyTarget, 10));
    const stock = foodStock();
    if (stock >= th) return false;
    const item = cheapestFood();
    if (!item) {
      shopWarn('小铺里没有可购买的口粮');
      return false;
    }
    const price = num(item.price, 0);
    const coins = num(petData.wallet && petData.wallet.coins, 0);
    const qty = Math.min(10, target - stock, Math.floor(coins / price));
    if (qty <= 0) {
      shopWarn(`金币不足：${item.name} 单价 ${price}，当前只有 ${coins} 金币`);
      return false;
    }
    await act(
      'purchases',
      { petId: petState.id, itemId: item.id, quantity: qty, catalogVersion: catalog.version },
      `补货 ${item.name}×${qty}`
    );
    log('grab', `小铺补货：${item.name} ×${qty}，花费 ${price * qty} 金币（补后口粮 ${stock + qty}）`);
    return true;
  }

  // 每日补给（金币 + 口粮，一天一次）
  async function trySupply() {
    if (!petData || !petState) return false;
    const ds = petData.dailySupply || {};
    if (ds.claimed || !petData.today) return false;
    await act('supplies', { expectedDate: petData.today }, '领取每日补给');
    return true;
  }

  // 故事奖励（completedSteps 满了就能领）
  async function tryStories() {
    if (!catalog || !petData || !petState) return false;
    const ready = (petData.stories || []).find((s) => s && s.status === 'claimable');
    if (!ready) return false;
    const meta = (catalog.stories || []).find((s) => s && s.id === ready.id);
    await act(
      'stories/claim',
      { petId: petState.id, storyId: ready.id, catalogVersion: catalog.version },
      `领取故事「${(meta && meta.name) || ready.id}」奖励`
    );
    return true;
  }

  // 合成：材料够、技能够、还没解锁图鉴的配方
  async function tryCraft() {
    if (!catalog || !petData || !petState) return false;
    const unlocked = new Set((petData.collections || []).map((c) => String(c && c.id)));
    const coins = num(petData.wallet && petData.wallet.coins, 0);
    for (const r of catalog.recipes || []) {
      if (!r || !r.collectionId) continue;
      if (unlocked.has(String(r.collectionId))) continue; // 已解锁，不再重复合成
      if (num(r.coins, 0) > coins) continue;
      if ((r.requirements || []).some((q) => skillExp(q.skillId) < num(q.experience, 0))) continue;
      if ((r.ingredients || []).some((ing) => invQty(ing.itemId) < num(ing.quantity, 0))) continue;
      await act(
        'crafts',
        { petId: petState.id, recipeId: r.id, catalogVersion: catalog.version },
        `合成「${r.name || r.id}」`
      );
      return true;
    }
    return false;
  }

  /* ---- 宠物乱斗：每日闯关 + 武器强化 ---- */
  let brawlProfile = null; // GET /api/v3/me/pet/brawl 缓存
  let brawlFetchedAt = 0;
  const BRAWL_TTL = 60000; // 档案 60 秒一刷（动作后强制刷新）

  async function loadBrawlProfile(force) {
    if (!force && brawlProfile && Date.now() - brawlFetchedAt < BRAWL_TTL) return brawlProfile;
    const p = await getBrawlProfile();
    brawlProfile = p;
    brawlFetchedAt = Date.now();
    return p;
  }

  // 解锁条件：有宠物且等级达到 minLevel
  function brawlUnlocked(p) {
    return !!(p && p.petId && num(p.level, 0) >= num(p.minLevel, 1));
  }

  // 出战配装：已拥有武器里选强化等级最高的；招式用 PvP 已保存的（没有就官方默认 SPLASH）
  function brawlLoadout(p) {
    const levels = (p && p.levels) || {};
    let weapon = 'SPOON';
    let best = -1;
    for (const w of Object.keys(levels)) {
      const lv = num(levels[w], 0);
      if (lv > best) {
        best = lv;
        weapon = w;
      }
    }
    const skill = (p && p.pvp && p.pvp.skill) || 'SPLASH';
    return { weapon, skill };
  }

  // 有没有「马上要处理」的宠物事务（有就先让路，乱斗不抢优先级）
  function brawlUrgent(p) {
    const a = p && p.activity;
    if (!a) return false;
    const left = activityLeftSec(a);
    if (a.kind === 'rest') {
      const energy = num(p.energy, 0);
      const enough = energy >= Math.max(num(settings.energyRestThreshold, 25), num(settings.minEnergyForActivity, 10));
      return left <= 0 || (settings.earlyWake && enough);
    }
    return a.status === 'claimable' || left <= 0;
  }

  // 每日闯关：rewardCount < rewards.length（3）时打一场
  // 选关：能推进就推进（cleared+1），推满了就重刷最高关拿每日奖励
  async function tryBrawlFight() {
    if (stepBlocked('乱斗闯关')) return false;
    const p = await loadBrawlProfile(false);
    if (!brawlUnlocked(p)) {
      blockStep('乱斗闯关', 10 * 60 * 1000); // 没解锁/没宠物，10 分钟后再看
      return false;
    }
    const rewards = p.rewards || [];
    if (num(p.rewardCount, 0) >= rewards.length) {
      blockStep('乱斗闯关', 30 * 60 * 1000); // 今日 3 场奖励领完，半小时后再看（跨天自动恢复）
      return false;
    }
    const cleared = num(p.cleared, 0);
    const unlocked = Math.max(1, num(p.unlocked, 1));
    const stages = Math.max(1, num(p.stages, 3));
    const stage = Math.min(cleared < unlocked ? cleared + 1 : Math.max(1, cleared), unlocked, stages);
    const { weapon, skill } = brawlLoadout(p);
    const before = num(p.rewardCount, 0);
    const res = await brawlAct(
      '/matches',
      { petId: p.petId, version: p.version, weapon, skill, stage, practice: false },
      `乱斗闯关（第 ${stage} 关）`
    );
    // 读战报记结果（胜负 + 材料），失败不影响主流程
    try {
      if (res && res.matchId) {
        const m = await api('GET', `/api/v3/me/pet/brawl/matches/${res.matchId}`);
        const w = num(m && m.winner, -1);
        const label = w === 0 ? '胜利' : w === 1 ? '落败' : '平局';
        const rw = num(m && m.reward, 0);
        log('info', `乱斗第 ${stage} 关：${label}${rw ? `，获得 ${rw} 材料` : ''}`);
      }
    } catch (e) {
      /* 战报读不到不碍事 */
    }
    // 档案强制刷新，核对每日奖励进度
    const p2 = await loadBrawlProfile(true);
    if (num(p2.rewardCount, 0) <= before) {
      // 没吃到奖励（多半是没打赢）：歇 10 分钟再试，避免连败刷请求
      blockStep('乱斗闯关', 10 * 60 * 1000);
      log('fail', '乱斗本场未计入每日奖励，10 分钟后再试');
    }
    return true;
  }

  // 武器强化：出战武器材料够就升一级（直升路径，官方「材料强化」按钮同款）
  async function tryBrawlUpgrade() {
    if (stepBlocked('乱斗强化')) return false;
    const p = await loadBrawlProfile(false);
    if (!brawlUnlocked(p)) {
      blockStep('乱斗强化', 10 * 60 * 1000);
      return false;
    }
    const { weapon } = brawlLoadout(p);
    const level = num((p.levels || {})[weapon], 0);
    const maxUpgrade = num(p.maxUpgrade, 20);
    if (level >= maxUpgrade) {
      blockStep('乱斗强化', 60 * 60 * 1000); // 满级了，1 小时后再看
      return false;
    }
    const cost = num((p.costs || [])[level], 0);
    if (!cost || num(p.materials, 0) < cost) return false; // 材料不够，安静等闯关攒
    await brawlAct(
      '/upgrade',
      { petId: p.petId, version: p.version, weapon, level },
      `强化武器 ${weapon} → +${level + 1}（-${cost} 材料）`
    );
    brawlFetchedAt = 0; // 强化后强制重读档案
    return true;
  }

  /* ---- 领奖后刷新页面（同步官方界面） ---- */
  const KEY_RELOAD = 'fp_pet_last_reload';
  function reloadForSync(why) {
    if (!settings.reloadOnClaim) return false;
    if (!PAGES_PATH_RE.test(location.pathname)) return false;
    let last = 0;
    try {
      last = Number(GM_getValue(KEY_RELOAD, 0)) || 0;
    } catch (e) {
      /* ignore */
    }
    if (Date.now() - last < 20000) return false; // 20 秒内不重复刷新，防循环
    try {
      GM_setValue(KEY_RELOAD, Date.now());
    } catch (e) {
      /* ignore */
    }
    log('info', why + '，刷新页面同步界面');
    setTimeout(() => location.reload(), 600);
    return true;
  }

  /* ---- 多标签页互斥（避免多个标签同时动作、加倍触发风控） ---- */
  const KEY_OWNER = 'fp_pet_owner';
  const OWNER_TTL = 30000;
  const ownerId = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  let isOwner = false;

  function readOwner() {
    try {
      const raw = GM_getValue(KEY_OWNER, '');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function heartbeatOwner() {
    if (!settings.singleTab) {
      isOwner = true;
      return true;
    }
    const now = Date.now();
    const cur = readOwner();
    if (!cur || cur.id === ownerId || !cur.until || cur.until < now) {
      try {
        GM_setValue(KEY_OWNER, JSON.stringify({ id: ownerId, until: now + OWNER_TTL }));
      } catch (e) {
        /* ignore */
      }
      isOwner = true;
    } else {
      isOwner = false;
    }
    return isOwner;
  }

  function releaseOwner() {
    if (!isOwner) return;
    try {
      const cur = readOwner();
      if (cur && cur.id === ownerId) GM_setValue(KEY_OWNER, JSON.stringify({ id: ownerId, until: 0 }));
    } catch (e) {
      /* ignore */
    }
    isOwner = false;
  }

  /* ================================================================
   * 风控（geetest）检测
   * ================================================================ */
  let riskLogState = ''; // ''=首查 / ok / cooldown / verify —— 只在状态变化时记日志
  let riskLastCheckAt = 0;

  async function checkRisk() {
    try {
      const r = await getRisk();
      const prev = riskLogState;
      riskState.verificationRequired = !!r.verificationRequired;
      riskState.retryAt = num(r.retryAt, 0);
      riskState.expiresAt = num(r.expiresAt, 0);
      // 观测：状态变化才记日志（平时静默，避免刷屏）
      let cur = 'ok';
      if (riskState.retryAt > serverNow()) cur = 'cooldown';
      else if (riskState.verificationRequired) cur = 'verify';
      if (cur !== prev) {
        riskLogState = cur;
        if (!prev) {
          log('info', '风控首次检查：' + (cur === 'ok' ? '正常' : cur === 'cooldown' ? `冷却中（剩 ${Math.ceil((riskState.retryAt - serverNow()) / 1000)} 秒）` : '需要人机验证'));
        } else if (cur === 'ok') {
          log('info', '风控状态恢复正常');
        } else if (cur === 'cooldown') {
          log('fail', `⚠️ 风控触发冷却：${Math.ceil((riskState.retryAt - serverNow()) / 1000)} 秒后可继续（记下这条发生前的操作节奏）`);
        } else {
          log('error', '⚠️ 风控要求人机验证（记下这条发生前的操作节奏）');
        }
      }
      riskLastCheckAt = Date.now();
      return riskState;
    } catch (e) {
      // risk 接口失败不阻塞（可能是未登录等），保持上次状态
      return riskState;
    }
  }

  function riskExpired() {
    if (!riskState.expiresAt) return false;
    return Date.now() >= riskState.expiresAt * (riskState.expiresAt < 1e12 ? 1000 : 1);
  }

  let riskPausedUntil = 0;
  let riskNoticeAt = 0;
  const RISK_COOLDOWN = 5 * 60 * 1000;

  // 风控只做「冷却暂停」，不再把总开关关掉（v1.0.2 会写死 enabled=false，重载后永远不跑）
  function pauseForRisk(reason) {
    riskPausedUntil = Date.now() + RISK_COOLDOWN;
    if (Date.now() - riskNoticeAt > 60000) {
      riskNoticeAt = Date.now();
      log('error', reason + '（5 分钟后自动重试）');
      toast(`⚠️ 需要人机验证：请在宠物页面手动喂食/玩耍一次过掉滑块，助手 5 分钟后自动继续`, 'error');
      browserNotify('宠物助手', reason);
    }
    statusLine('风控冷却中，等待自动重试（可手动操作一次解除）');
  }

  function resumeFromRisk() {
    if (riskPausedUntil) {
      riskPausedUntil = 0;
      riskNoticeAt = 0;
      log('info', '已手动恢复，立即继续');
    }
  }

  /* ================================================================
   * 自动化循环（状态机）
   * ================================================================ */
  let ticking = false;
  let tickTimer = null;
  let soonTimer = null;
  let tickStartedAt = 0;
  let watchdogTimer = null;
  let lastRiskAt = 0;
  let ownerTimer = null;

  // 看门狗：某次 tick 卡死（请求挂起等）超过 90 秒就强制解锁，避免永远停摆
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (ticking && tickStartedAt && Date.now() - tickStartedAt > 90000) {
        ticking = false;
        tickStartedAt = 0;
        log('fail', '上一轮检查卡住超过 90 秒，已强制恢复');
      }
    }, 15000);
  }

  // 动作成功后来一轮快速复查，不用等下一轮定时检查
  function scheduleSoon(ms) {
    if (soonTimer) clearTimeout(soonTimer);
    soonTimer = setTimeout(() => {
      soonTimer = null;
      tick();
    }, Math.max(500, ms || 1500));
  }

  // 维护类动作失败后的冷却，避免每 10 秒重试同一条报错
  const stepCooldown = {};
  function stepBlocked(name) {
    return Date.now() < (stepCooldown[name] || 0);
  }
  function blockStep(name, ms) {
    stepCooldown[name] = Date.now() + ms;
  }

  function maintenanceSteps() {
    return [
      ['每日补给', settings.autoSupply, trySupply],
      ['故事奖励', settings.autoStory, tryStories],
      ['小铺补货', settings.autoRestock, tryRestock],
      ['自动合成', settings.autoCraft, tryCraft],
    ];
  }

  async function tick() {
    if (ticking || !settings.enabled) return;
    if (Date.now() < riskPausedUntil) return; // 风控冷却中，别空转请求
    if (Date.now() < rateLimitUntil) {
      statusLine(`接口频控退避中（还剩 ${Math.ceil((rateLimitUntil - Date.now()) / 1000)} 秒）`);
      return;
    }
    if (!heartbeatOwner()) {
      statusLine('另一个标签页正在运行，本页待命');
      return;
    }
    ticking = true;
    tickStartedAt = Date.now();
    try {
      // 1. 风控检查（60 秒一次，省接口）
      if (Date.now() - lastRiskAt > 60000) {
        await checkRisk();
        lastRiskAt = Date.now();
        if (riskState.verificationRequired && !riskExpired()) {
          pauseForRisk('服务端要求人机验证，自动化已暂停');
          return;
        }
      }

      // 2. 拉状态
      let st;
      try {
        st = await getPetState();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'rate_limited') return;
        if (e instanceof ApiError && e.status === 429) return;
        log('fail', '获取宠物状态失败：' + e.message);
        return;
      }
      if (!st) return;
      // 服务端返回 {wallet, dailySupply, pet, serverNow}——宠物本体在 pet 字段
      petData = st;
      petState = st.pet || null;
      if (st.serverNow) serverOffset = num(st.serverNow, 0) - Date.now();
      if (!petState) {
        statusLine('未领养宠物或数据为空');
        renderStatus();
        return;
      }

      // 2.5 乱斗：每日闯关 / 武器强化（不依赖宠物空闲；有待领奖、该叫醒等紧急事务先让路）
      if ((settings.autoBrawlFight || settings.autoBrawlUpgrade) && !brawlUrgent(petState)) {
        try {
          let done = false;
          if (settings.autoBrawlFight) done = await tryBrawlFight();
          if (!done && settings.autoBrawlUpgrade) done = await tryBrawlUpgrade();
          if (done) {
            scheduleSoon(5000 + Math.random() * 5000);
            return;
          }
        } catch (e) {
          if (isRiskError(e)) {
            pauseForRisk('乱斗触发风控，已暂停');
            return;
          }
          log('fail', '乱斗失败：' + e.message + '（10 分钟后再试）');
          blockStep('乱斗闯关', 10 * 60 * 1000);
          blockStep('乱斗强化', 10 * 60 * 1000);
        }
      }

      // 3. 活动处理
      const a = petState.activity;
      if (a && !activityDumped) {
        activityDumped = true;
        try {
          log('info', '活动原始结构：' + JSON.stringify(a));
        } catch (e) {
          /* ignore */
        }
      }
      if (a && a.kind !== 'rest') {
        // 到点即可领取（服务端在 endsAt 之后才把 status 标为 claimable）
        const canClaim = a.status === 'claimable' || (!!a.id && activityLeftSec(a) <= 0);
        if (canClaim && a.id) {
          try {
            const res = await claimActivity(a.id);
            logReward(res, ACTIVITY_LABEL[a.kind] || a.kind);
            petState.activity = null;
            renderStatus();
            if (!reloadForSync('活动已领奖')) scheduleSoon(2000); // 不刷新时马上安排下一个活动
            return;
          } catch (e) {
            if (isRiskError(e)) {
              pauseForRisk('领奖触发风控，已暂停');
              return;
            }
            log('fail', '领取活动失败：' + e.message);
          }
          return;
        }
        // running：显示倒计时
        const left = activityLeftSec(a);
        if (left > 0) {
          statusLine(`进行中：${ACTIVITY_LABEL[a.kind] || a.kind}（还剩 ${fmtDur(left)}）`);
          renderStatus();
          if (left <= 180) scheduleSoon((left + 2) * 1000); // 快结束时提前来收
          return;
        }
        // 到点但还没 claimable：等待下一次轮询
        statusLine(`活动即将完成：${ACTIVITY_LABEL[a.kind] || a.kind}`);
        renderStatus();
        return;
      }

      if (a && a.kind === 'rest') {
        const left = activityLeftSec(a);
        const energy = num(petState.energy, 0);
        const enough = energy >= Math.max(num(settings.energyRestThreshold, 25), num(settings.minEnergyForActivity, 10));
        if (left > 0 && !(settings.earlyWake && enough)) {
          statusLine(`休息中（还剩 ${fmtDur(left)}）`);
          renderStatus();
          return;
        }
        // 休息到点，或精力已经够用 → 叫醒
        if (settings.autoRest) {
          try {
            await wakeRest();
            petState.activity = null;
            statusLine(left > 0 ? `精力 ${energy}，已提前叫醒` : '休息结束，已叫醒');
            renderStatus();
            if (!reloadForSync('休息结束')) scheduleSoon(2000);
            return;
          } catch (e) {
            if (isRiskError(e)) {
              pauseForRisk('叫醒触发风控，已暂停');
              return;
            }
            log('fail', '叫醒失败：' + e.message);
          }
        }
        renderStatus();
        return;
      }

      // 4. 每日补给 / 故事奖励 / 小铺补货 / 合成（都要求空闲，服务端同样限制）
      for (const [label, on, fn] of maintenanceSteps()) {
        if (!on || stepBlocked(label)) continue;
        let done = false;
        try {
          done = await fn();
        } catch (e) {
          if (isRiskError(e)) {
            pauseForRisk(label + '触发风控，已暂停');
            return;
          }
          log('fail', label + '失败：' + e.message + '（5 分钟后再试）');
          blockStep(label, 5 * 60 * 1000);
        }
        if (done) {
          scheduleSoon(2000);
          return;
        }
      }

      // 5. 照顾检查
      if (settings.autoCare) {
        const done = await tryCare();
        if (done) {
          scheduleSoon(5000 + Math.random() * 5000); // 照顾动作之间留点间隔，少触发风控
          return; // 做了一件照顾，稍后继续
        }
      }

      // 6. 安排活动
      if (settings.autoSchedule) {
        const done = await trySchedule();
        if (done) {
          scheduleSoon(2000);
          return;
        }
      }

      statusLine('待机中（已按阈值处理）');
      renderStatus();
    } catch (e) {
      if (isRiskError(e)) {
        pauseForRisk('操作触发风控，已暂停');
      } else {
        log('fail', '循环异常：' + (e && e.message));
      }
    } finally {
      ticking = false;
      tickStartedAt = 0;
    }
  }

  function isRiskError(e) {
    if (!(e instanceof ApiError)) return false;
    if (e.code === 'pet_verification_required') return true;
    const msg = String(e.message || '');
    return msg.includes('验证') || msg.includes('captcha') || msg.includes('geetest') || msg.includes('risk');
  }

  let lastCareWarnAt = 0;
  function careWarn(text) {
    if (Date.now() - lastCareWarnAt < 10 * 60 * 1000) return;
    lastCareWarnAt = Date.now();
    log('info', text);
  }

  async function tryCare() {
    const th = Number(settings.careThreshold) || 20;
    const p = petState;
    const jobs = [];
    if (num(p.hunger, 0) < th) {
      const itemId = foodItemId();
      if (!itemId) careWarn('背包里没有口粮，暂时无法自动喂食');
      else if (!careCooldown('feed')) jobs.push(['feed', '喂食', { itemId }]);
    }
    if (num(p.water, 0) < th && !careCooldown('water')) jobs.push(['water', '浇水']);
    if (num(p.mood, 0) < th && !careCooldown('play') && num(p.energy, 100) >= 10) jobs.push(['play', '玩耍']);
    if (!jobs.length) return false;
    // 每轮只做一件，避免连续动作触发风控
    const [action, label, extra] = jobs[0];
    try {
      await doAction(action, label, extra);
      statusLine(`已自动${label}`);
      renderStatus();
      return true;
    } catch (e) {
      if (isRiskError(e)) {
        pauseForRisk(`${label}触发风控，已暂停`);
        return true;
      }
      log('fail', `${label}失败：${e.message}`);
      return false;
    }
  }

  /* ---- 宠物咖啡：精力低先喝咖啡（积分换精力，立刻生效），省下 4 小时睡眠 ---- */
  async function tryCoffee(energy) {
    if (stepBlocked('咖啡') || !petState || !petData) return false;
    if (petState.activity) return false; // 官方限制：休息或活动结束后才能购买
    if (num(energy, 0) >= 100) return false;
    const st = await getCoffee();
    if (!st || !st.enabled) {
      blockStep('咖啡', 60 * 60 * 1000); // 服务端关闭了咖啡，1 小时后再看
      return false;
    }
    if (num(st.remaining, 0) <= 0) {
      blockStep('咖啡', 30 * 60 * 1000); // 今日次数用完，半小时后再看（跨天自动恢复）
      return false;
    }
    if (num(st.balance, 0) < num(st.price, 0)) {
      blockStep('咖啡', 30 * 60 * 1000); // 积分不够，半小时内大概率还是不够
      return false;
    }
    const gain = num(st.energy, 30);
    await act(
      'coffee',
      { petId: petState.id, expectedDate: petData.today || st.today, version: st.version },
      `购买咖啡（${num(st.price, 64)} 积分 → +${gain} 精力，今日剩 ${num(st.remaining, 1) - 1} 杯）`
    );
    return true;
  }

  async function trySchedule() {
    const p = petState;
    const energy = num(p.energy, 100);
    const coins = petData && petData.wallet ? num(petData.wallet.coins, 0) : 0;
    const incomeLeft = petData && petData.income ? num(petData.income.remaining, Infinity) : Infinity;
    const minEnergy = Number(settings.minEnergyForActivity) || 0;
    const restThreshold = Number(settings.energyRestThreshold) || 0;

    // 精力太低 → 休息
    if (energy < minEnergy || (settings.autoRest && energy < restThreshold)) {
      // 有咖啡先喝咖啡：立刻 +30 精力继续干活，比睡 4 小时划算；喝不到才安排休息
      if (settings.autoCoffee) {
        try {
          if (await tryCoffee(energy)) {
            statusLine(`精力 ${energy}，先喝咖啡恢复`);
            renderStatus();
            return true;
          }
        } catch (e) {
          if (isRiskError(e)) {
            pauseForRisk('购买咖啡触发风控，已暂停');
            return true;
          }
          log('fail', '购买咖啡失败：' + e.message + '（10 分钟后再试）');
          blockStep('咖啡', 10 * 60 * 1000);
        }
      }
      if (settings.autoRest) {
        try {
          await startRest();
          statusLine(`精力 ${energy}，安排休息`);
          renderStatus();
          return true;
        } catch (e) {
          if (isRiskError(e)) {
            pauseForRisk('安排休息触发风控，已暂停');
            return true;
          }
          log('fail', '安排休息失败：' + e.message);
        }
      }
      statusLine(`精力 ${energy}，等待休息（自动休息已关）`);
      renderStatus();
      return false;
    }

    if (!catalog) {
      statusLine('宠物目录还没加载好，稍后重试');
      renderStatus();
      return false;
    }

    // 三种类型的条目放在一起，按当前策略的性价比统一排序
    const entries = activityEntriesByKind();
    const candidates = [];
    for (const kind of ALL_KINDS) {
      // 兼职受每日收入上限限制
      if (kind === 'work' && incomeLeft <= 0) continue;
      for (const entry of entries[kind] || []) {
        if (!requirementsMet(entry, kind)) continue;
        // cost = {coins, energy, hunger, water}，服务端会按这四项校验
        const cost = entry && entry.cost && typeof entry.cost === 'object' ? entry.cost : {};
        const costCoins = num(cost.coins, 0);
        const costEnergy = num(cost.energy, 0);
        if (coins < costCoins) continue;
        if (num(p.hunger, 0) < num(cost.hunger, 0)) continue;
        if (num(p.water, 0) < num(cost.water, 0)) continue;
        if (energy < costEnergy) continue;
        if (energy - costEnergy < minEnergy) continue;
        candidates.push({ kind, entry, score: strategyScore(entry) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const c of candidates) {
      const kind = c.kind;
      const entryId = String(c.entry.id || c.entry.entryId);
      try {
        await startActivity(kind, entryId);
        statusLine(`已安排「${ACTIVITY_LABEL[kind] || kind}」`);
        renderStatus();
        return true;
      } catch (e) {
        if (isRiskError(e)) {
          pauseForRisk('安排活动触发风控，已暂停');
          return true;
        }
        // 这个条目不可用（冷却/每日上限），试下一个
        log('info', `${ACTIVITY_LABEL[kind] || kind} 不可用（${e.message}），尝试下一个`);
      }
    }
    statusLine('没有可安排的活动（可能冷却/精力不足）');
    renderStatus();
    return false;
  }

  function logReward(res, label) {
    const parts = [];
    if (res && typeof res === 'object') {
      for (const k of ['coins', 'experience', 'food', 'mood', 'proficiency']) {
        if (res[k] != null) parts.push(`${k} +${res[k]}`);
      }
    }
    log('grab', `「${label}」领奖成功${parts.length ? '：' + parts.join('、') : ''}`);
    toast(`🎁 「${label}」领奖成功`, 'success');
    browserNotify('宠物助手', `「${label}」已领奖`);
  }

  function statusLine(text) {
    const el = document.getElementById('fp-pet-statusline');
    if (el) el.textContent = text;
  }

  function fmtDur(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  }

  function startLoop() {
    if (tickTimer) return;
    startWatchdog();
    heartbeatOwner();
    if (!ownerTimer) ownerTimer = setInterval(heartbeatOwner, 5000);
    tickTimer = setInterval(tick, Math.max(10, Number(settings.pollInterval) || 10) * 1000);
    tick();
  }
  function stopLoop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (soonTimer) {
      clearTimeout(soonTimer);
      soonTimer = null;
    }
    if (ownerTimer) {
      clearInterval(ownerTimer);
      ownerTimer = null;
    }
    releaseOwner();
  }

  /* ================================================================
   * UI
   * ================================================================ */
  // document-start 阶段 head 可能还不存在，包一层就绪保护
  const petCss = `
#fp-pet-fab{position:fixed;right:70px;bottom:110px;width:44px;height:44px;border-radius:50%;background:#26a69a;color:#fff;border:none;font-size:20px;cursor:grab;z-index:2147483000;box-shadow:0 4px 12px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none;touch-action:none}
#fp-pet-fab.dragging{cursor:grabbing;opacity:.85}
#fp-pet-fab .dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#9e9e9e;border:2px solid #fff}
#fp-pet-fab .dot.on{background:#4caf50}
#fp-pet-toast{position:fixed;top:70px;left:50%;transform:translateX(-50%) translateY(-12px);background:rgba(30,30,30,.92);color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;z-index:2147483001;opacity:0;pointer-events:none;transition:all .25s ease;max-width:80vw}
#fp-pet-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#fp-pet-toast.warn{background:rgba(230,150,20,.95)}
#fp-pet-toast.error{background:rgba(200,50,50,.95)}
#fp-pet-panel{position:fixed;right:14px;bottom:164px;width:360px;max-height:74vh;background:#1e1f24;color:#e8e8ea;border:1px solid #3a3b42;border-radius:12px;z-index:2147483001;display:none;flex-direction:column;box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:13px;overflow:hidden}
#fp-pet-panel.open{display:flex}
#fp-pet-panel .pp-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#26272e;border-bottom:1px solid #3a3b42;user-select:none}
#fp-pet-panel .pp-title{font-weight:bold;font-size:14px}
#fp-pet-panel .pp-close{background:none;border:none;color:#9a9ba3;font-size:18px;cursor:pointer;padding:0 4px}
#fp-pet-panel .pp-tabs{display:flex;background:#26272e;border-bottom:1px solid #3a3b42}
#fp-pet-panel .pp-tab{flex:1;padding:8px 0;text-align:center;cursor:pointer;color:#9a9ba3;user-select:none}
#fp-pet-panel .pp-tab.active{color:#fff;background:#1e1f24;border-bottom:2px solid #26a69a}
#fp-pet-panel .pp-body{padding:12px 14px;overflow-y:auto;flex:1}
#fp-pet-panel .pp-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
#fp-pet-panel .pp-row label{flex:1;cursor:pointer}
#fp-pet-panel .pp-row input[type=number],#fp-pet-panel .pp-row input[type=text],#fp-pet-panel .pp-row select{width:110px;background:#14151a;border:1px solid #3a3b42;color:#e8e8ea;border-radius:6px;padding:5px 8px;font-size:13px}
#fp-pet-panel .pp-row input[type=checkbox]{width:16px;height:16px;accent-color:#26a69a;cursor:pointer}
#fp-pet-panel .pp-hint{font-size:11px;color:#8a8b93;margin:-4px 0 10px;line-height:1.5}
#fp-pet-panel .pp-btn{background:#26a69a;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}
#fp-pet-panel .pp-btn.ghost{background:#3a3b42}
#fp-pet-panel .pp-btn:hover{filter:brightness(1.1)}
#fp-pet-panel .pp-stat{background:#26272e;border-radius:8px;padding:10px;margin-bottom:8px}
#fp-pet-panel .pp-bar{height:10px;background:#14151a;border-radius:5px;overflow:hidden;margin-top:4px}
#fp-pet-panel .pp-bar i{display:block;height:100%;border-radius:5px}
#fp-pet-panel .pp-log{max-height:36vh;overflow-y:auto;font-size:12px;line-height:1.6}
#fp-pet-panel .pp-log .e{padding:3px 6px;border-radius:4px;margin-bottom:3px;background:#26272e;word-break:break-all}
#fp-pet-panel .pp-log .e.grab{border-left:3px solid #4caf50}
#fp-pet-panel .pp-log .e.fail,#fp-pet-panel .pp-log .e.error{border-left:3px solid #e8443a;color:#ff8a80}
#fp-pet-panel .pp-log .e.info{border-left:3px solid #42a5f5}
#fp-pet-panel .pp-log .t{color:#7a7b83;margin-right:6px}
`;
  (function injectCss() {
    if (document.head) {
      GM_addStyle(petCss);
    } else {
      document.addEventListener('DOMContentLoaded', () => GM_addStyle(petCss), { once: true });
    }
  })();

  /* ================================================================
   * UI：面板
   * ================================================================ */
  let activeTab = 'status';

  /* ---- 悬浮图标：可拖动 + 记住位置（避开其他脚本的图标） ---- */
  const KEY_FAB_POS = 'fp_pet_fab_pos';
  const FAB_SIZE = 44;
  let fabDragMoved = false;

  function loadFabPos() {
    try {
      const raw = GM_getValue(KEY_FAB_POS, '');
      const p = raw ? JSON.parse(raw) : null;
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) return p;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function saveFabPos(left, top) {
    try {
      GM_setValue(KEY_FAB_POS, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
    } catch (e) {
      /* ignore */
    }
  }

  function viewportSize() {
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 0,
      h: window.innerHeight || document.documentElement.clientHeight || 0,
    };
  }

  function clampFabPos(left, top) {
    const v = viewportSize();
    return {
      left: Math.min(Math.max(0, left), Math.max(0, v.w - FAB_SIZE)),
      top: Math.min(Math.max(0, top), Math.max(0, v.h - FAB_SIZE)),
    };
  }

  function applyFabPos(fab) {
    const p = loadFabPos();
    if (!p) return; // 没拖过就沿用 CSS 里的默认位置
    const c = clampFabPos(p.left, p.top);
    fab.style.left = c.left + 'px';
    fab.style.top = c.top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  function resetFabPos() {
    try {
      GM_setValue(KEY_FAB_POS, '');
    } catch (e) {
      /* ignore */
    }
    const fab = document.getElementById('fp-pet-fab');
    if (fab) {
      fab.style.left = '';
      fab.style.top = '';
      fab.style.right = '';
      fab.style.bottom = '';
    }
    log('info', '悬浮图标位置已重置');
  }

  // 面板跟着图标走：优先贴在图标上方，放不下就放到下方，左右自动收进屏幕
  function positionPanel() {
    const panel = document.getElementById('fp-pet-panel');
    const fab = document.getElementById('fp-pet-fab');
    if (!panel || !fab) return;
    const v = viewportSize();
    const r = fab.getBoundingClientRect();
    const pw = Math.min(360, Math.max(240, v.w - 16));
    panel.style.width = pw + 'px';
    let left = r.right - pw;
    left = Math.min(Math.max(8, left), Math.max(8, v.w - pw - 8));
    const ph = panel.offsetHeight || 0;
    let top = r.top - 10 - ph;
    if (!ph || top < 8) top = ph ? Math.min(r.bottom + 10, v.h - ph - 8) : Math.max(8, r.top - 10);
    top = Math.max(8, top);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function makeFabDraggable(fab) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let pointerId = null;

    fab.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const r = fab.getBoundingClientRect();
      dragging = true;
      fabDragMoved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      originLeft = r.left;
      originTop = r.top;
      pointerId = ev.pointerId;
      try {
        fab.setPointerCapture(pointerId);
      } catch (e) {
        /* ignore */
      }
      fab.classList.add('dragging');
    });

    fab.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!fabDragMoved && Math.abs(dx) + Math.abs(dy) < 4) return; // 手抖不算拖动
      fabDragMoved = true;
      const c = clampFabPos(originLeft + dx, originTop + dy);
      fab.style.left = c.left + 'px';
      fab.style.top = c.top + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove('dragging');
      if (pointerId != null) {
        try {
          fab.releasePointerCapture(pointerId);
        } catch (e) {
          /* ignore */
        }
      }
      pointerId = null;
      if (!fabDragMoved) return;
      const r = fab.getBoundingClientRect();
      saveFabPos(r.left, r.top);
      const panel = document.getElementById('fp-pet-panel');
      if (panel && panel.classList.contains('open')) positionPanel();
    };
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);
  }

  function buildUI() {
    if (document.getElementById('fp-pet-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'fp-pet-fab';
    fab.title = '宠物自动助手（可拖动）';
    fab.innerHTML = '🐾<span class="dot"></span>';
    fab.addEventListener('click', () => {
      if (fabDragMoved) {
        fabDragMoved = false; // 刚拖完，别顺手把面板开/关一次
        return;
      }
      togglePanel();
    });
    makeFabDraggable(fab);
    document.body.appendChild(fab);
    applyFabPos(fab);

    const panel = document.createElement('div');
    panel.id = 'fp-pet-panel';
    panel.innerHTML = `
      <div class="pp-head">
        <div>
          <div class="pp-title">🐾 宠物自动助手 <span style="font-size:11px;color:#8a8b93">v${SCRIPT_VER}</span></div>
          <div style="font-size:11px;color:#9a9ba3;margin-top:2px" id="fp-pet-statusline">待机中</div>
        </div>
        <button class="pp-close" id="fp-pet-close" title="关闭">✕</button>
      </div>
      <div class="pp-tabs">
        <div class="pp-tab active" data-tab="status">状态</div>
        <div class="pp-tab" data-tab="settings">设置</div>
        <div class="pp-tab" data-tab="log">日志</div>
      </div>
      <div class="pp-body" id="fp-pet-body"></div>
      <div style="display:flex;gap:8px;padding:10px 14px;border-top:1px solid #3a3b42;background:#26272e">
        <button class="pp-btn" id="fp-pet-save">保存设置</button>
        <button class="pp-btn ghost" id="fp-pet-toggle">停用</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#fp-pet-close').addEventListener('click', togglePanel);
    panel.querySelectorAll('.pp-tab').forEach((el) => {
      el.addEventListener('click', () => {
        activeTab = el.dataset.tab;
        panel.querySelectorAll('.pp-tab').forEach((x) => x.classList.toggle('active', x === el));
        renderBody();
      });
    });
    panel.querySelector('#fp-pet-save').addEventListener('click', saveFromForm);
    panel.querySelector('#fp-pet-toggle').addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      saveSettings();
      log('info', settings.enabled ? '已启用宠物助手' : '已停用宠物助手');
      renderToggleBtn();
      if (settings.enabled) {
        resumeFromRisk();
        startLoop();
      } else stopLoop();
    });

    renderBody();
    renderToggleBtn();
    setDot();

    // 窗口尺寸变化时把图标和面板收回屏幕内
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => {
        const f = document.getElementById('fp-pet-fab');
        if (f && loadFabPos()) {
          const r = f.getBoundingClientRect();
          const c = clampFabPos(r.left, r.top);
          f.style.left = c.left + 'px';
          f.style.top = c.top + 'px';
        }
        const p = document.getElementById('fp-pet-panel');
        if (p && p.classList.contains('open')) positionPanel();
      });
    }
  }

  function togglePanel() {
    const panel = document.getElementById('fp-pet-panel');
    if (!panel) return;
    const open = panel.classList.toggle('open');
    if (open) {
      renderBody();
      positionPanel();
      // 等面板渲染出真实高度再定一次位置，避免超出屏幕
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(positionPanel);
    }
  }

  function renderBody() {
    const body = document.getElementById('fp-pet-body');
    if (!body) return;
    if (activeTab === 'status') renderStatus(body);
    else if (activeTab === 'settings') renderSettings(body);
    else renderLog(body);
  }

  function renderToggleBtn() {
    const btn = document.getElementById('fp-pet-toggle');
    if (!btn) return;
    btn.textContent = settings.enabled ? '停用' : '启用';
    btn.style.background = settings.enabled ? '#3a3b42' : '#4caf50';
  }

  function setDot() {
    const dot = document.querySelector('#fp-pet-fab .dot');
    if (dot) dot.className = 'dot' + (settings.enabled ? ' on' : '');
  }

  function bar(label, value, color) {
    const v = Math.max(0, Math.min(100, num(value, 0)));
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:38px;color:#9a9ba3;font-size:12px">${label}</span>
        <div class="pp-bar" style="flex:1"><i style="width:${v}%;background:${color}"></i></div>
        <span style="width:36px;text-align:right;font-size:12px">${Math.round(v)}</span>
      </div>`;
  }

  // 风控状态显示行（观测用）
  function riskLineHtml() {
    if (!riskLastCheckAt) return '风控：未检查';
    const t = new Date(riskLastCheckAt);
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${p(t.getHours())}:${p(t.getMinutes())}`;
    if (riskState.retryAt > serverNow()) return `风控：<span style="color:#ffb74d">冷却中（剩 ${Math.ceil((riskState.retryAt - serverNow()) / 1000)} 秒）</span>（${ts} 检查）`;
    if (riskState.verificationRequired) return `风控：<span style="color:#ff8a80">需要人机验证</span>（${ts} 检查）`;
    return `风控：正常（${ts} 检查，60s 一次）`;
  }

  function renderStatus(body) {
    if (!body) {
      if (activeTab !== 'status') return;
      body = document.getElementById('fp-pet-body');
      if (!body) return;
    }
    const p = petState;
    if (!p) {
      body.innerHTML = `<div class="pp-hint">暂无宠物状态——点击「保存设置」或等待下一次自动检查。</div>
        <div class="pp-hint">如果一直为空，请确认：① 已在 fishpi.cn 登录；② 宠物页面能正常显示；③ 控制台没有报错。</div>`;
      return;
    }
    const a = p.activity;
    const aLabel = a ? (ACTIVITY_LABEL[a.kind] || a.kind) : '无';
    const aState = a ? (a.status || (a.kind === 'rest' ? 'rest' : '')) : '';
    const left = a ? activityLeftSec(a) : 0;
    const entries = activityEntriesByKind();
    const wallet = (petData && petData.wallet) || {};
    const income = (petData && petData.income) || {};
    const ds = (petData && petData.dailySupply) || {};
    const collections = (petData && petData.collections) || [];
    const totalCollections = (catalog && catalog.collections) || [];
    const stories = (petData && petData.stories) || [];
    const claimableStories = stories.filter((s) => s && s.status === 'claimable').length;
    const totalStories = (catalog && catalog.stories) || [];
    const food = cheapestFood();
    body.innerHTML = `
      <div class="pp-stat">
        <div style="display:flex;justify-content:space-between"><b>${escapeHtml(p.name || '宠物')}</b><span style="color:#9a9ba3">Lv. ${num(p.level, 1)}</span></div>
        ${bar('饥饿', p.hunger, '#ef5350')}
        ${bar('口渴', p.water, '#42a5f5')}
        ${bar('心情', p.mood, '#ab47bc')}
        ${bar('精力', p.energy, '#66bb6a')}
        ${bar('友谊', p.friendship, '#ffa726')}
        <div style="font-size:11px;color:#8a8b93;margin-top:6px">经验 ${num(p.experience, 0)}　当前：${aLabel}${aState ? '（' + (aState === 'running' ? '进行中' : aState === 'claimable' ? '可领取' : aState) + '）' : ''}${left > 0 ? ' 还剩 ' + fmtDur(left) : ''}</div>
      </div>
      <div class="pp-stat">
        <div style="font-weight:bold;margin-bottom:4px">资源</div>
        <div style="font-size:11px;color:#8a8b93">金币 ${num(wallet.coins, 0)}　口粮 ${foodStock()} 件　今日兼职 ${num(income.earned, 0)}/${num(income.limit, 0)}</div>
        <div style="font-size:11px;color:#8a8b93;margin-top:4px">今日成长 ${num((p.growthToday || {}).used, 0)}/${num((p.growthToday || {}).limit, 0)}${expCapped() ? '（<span style="color:#ff8a80">已满，经验失效</span>）' : ''}</div>
        <div style="font-size:11px;color:#8a8b93;margin-top:4px">${riskLineHtml()}</div>
        <div style="font-size:11px;color:#8a8b93;margin-top:4px">每日补给：${ds.claimed ? '已领' : '未领'}　图鉴 ${collections.length}/${totalCollections.length || '?'}　故事 ${claimableStories} 个可领</div>
        <div style="font-size:11px;color:#8a8b93;margin-top:4px">补货：口粮 &lt; ${num(settings.foodBuyThreshold, 5)} 时买 ${food ? escapeHtml(food.name) + ' @ ' + num(food.price, 0) : '（无可购口粮）'}</div>
      </div>
      <div class="pp-stat">
        <div style="font-weight:bold;margin-bottom:4px">今日安排</div>
        <div style="font-size:11px;color:#8a8b93">策略：${STRATEGY_LABEL[effectiveStrategy()]}${expCapped() ? '（成长已满，由「' + STRATEGY_LABEL[strategy()] + '」自动切换）' : ''}　每轮检查 ${settings.pollInterval}s</div>
        <div style="font-size:11px;color:#8a8b93;margin-top:4px">活动条目数：外出 ${entries.outing.length} / 学校 ${entries.course.length} / 兼职 ${entries.work.length}　故事 ${stories.length}/${totalStories.length || '?'}</div>
      </div>
      <div class="pp-hint">助手逻辑：状态检查 → 领奖/叫醒 → 每日补给 → 故事奖励 → 补货 → 合成 → 照顾 → 安排活动。</div>
    `;
  }

  function renderSettings(body) {
    if (!body) {
      if (activeTab !== 'settings') return;
      body = document.getElementById('fp-pet-body');
      if (!body) return;
    }
    body.innerHTML = `
      <div class="pp-row"><label for="p-enabled">启用自动助手</label><input type="checkbox" id="p-enabled" ${settings.enabled ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoCare">自动照顾（喂食/浇水/玩耍）</label><input type="checkbox" id="p-autoCare" ${settings.autoCare ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoSchedule">自动安排活动 + 领奖</label><input type="checkbox" id="p-autoSchedule" ${settings.autoSchedule ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoRest">精力不足自动休息</label><input type="checkbox" id="p-autoRest" ${settings.autoRest ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoCoffee">精力不足先喝咖啡（喝不到才休息）</label><input type="checkbox" id="p-autoCoffee" ${settings.autoCoffee ? 'checked' : ''}></div>
      <div class="pp-hint">咖啡：64 积分换 30 精力、立刻生效，每天限 3 杯；比睡 4 小时划算。次数用完/积分不够/有活动在身时自动回退到休息。</div>
      <div class="pp-row"><label for="p-strategy">活动策略</label><select id="p-strategy">${strategyOptions(STRATEGY_WEIGHT[settings.strategy] ? settings.strategy : 'balanced')}</select></div>
      <div class="pp-hint">均衡发展：金币、经验、熟练度都拿；快速涨经验：优先经验/熟练度高的（学习类）；快速金币：优先金币多的（兼职类）。三种类型按「收益 ÷（时长 + 回蓝时间）」比拼——精力用休息按固定速率恢复，所以真正稀缺的是时间。今日成长涨满后会自动临时切换为刷金币。</div>
      <div class="pp-row"><label for="p-careThreshold">照顾阈值（低于此值）</label><input type="number" id="p-careThreshold" min="0" max="100" value="${num(settings.careThreshold, 20)}"></div>
      <div class="pp-row"><label for="p-energyRestThreshold">休息阈值（精力低于此值）</label><input type="number" id="p-energyRestThreshold" min="0" max="100" value="${num(settings.energyRestThreshold, 25)}"></div>
      <div class="pp-row"><label for="p-minEnergyForActivity">活动最低精力</label><input type="number" id="p-minEnergyForActivity" min="0" max="100" value="${num(settings.minEnergyForActivity, 10)}"></div>
      <div class="pp-hint">低于「活动最低精力」时不安排任何活动并休息，避免把精力耗光。</div>
      <div class="pp-row"><label for="p-earlyWake">精力够了提前叫醒</label><input type="checkbox" id="p-earlyWake" ${settings.earlyWake ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-pollInterval">状态检查间隔（秒）</label><input type="number" id="p-pollInterval" min="10" max="600" value="${num(settings.pollInterval, 10)}"></div>
      <div class="pp-hint">默认 10 秒。服务端有频控，触发 429 会自动退避（最长 5 分钟）。</div>
      <div class="pp-row"><label for="p-autoSupply">自动领每日补给</label><input type="checkbox" id="p-autoSupply" ${settings.autoSupply ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoRestock">家园小铺自动补货（只买口粮）</label><input type="checkbox" id="p-autoRestock" ${settings.autoRestock ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-foodBuyThreshold">口粮低于此件数就补</label><input type="number" id="p-foodBuyThreshold" min="1" max="99" value="${num(settings.foodBuyThreshold, 5)}"></div>
      <div class="pp-row"><label for="p-foodBuyTarget">补到多少件</label><input type="number" id="p-foodBuyTarget" min="1" max="99" value="${num(settings.foodBuyTarget, 10)}"></div>
      <div class="pp-hint">只买最便宜的口粮；单次最多 10 件，金币不够会跳过并在日志提示。</div>
      <div class="pp-row"><label for="p-autoStory">自动领故事奖励</label><input type="checkbox" id="p-autoStory" ${settings.autoStory ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoCraft">自动合成（材料够就做）</label><input type="checkbox" id="p-autoCraft" ${settings.autoCraft ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoBrawlFight">乱斗：每日闯关拿材料</label><input type="checkbox" id="p-autoBrawlFight" ${settings.autoBrawlFight ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-autoBrawlUpgrade">乱斗：材料够就强化武器</label><input type="checkbox" id="p-autoBrawlUpgrade" ${settings.autoBrawlUpgrade ? 'checked' : ''}></div>
      <div class="pp-hint">乱斗需宠物达到解锁等级。闯关每天 3 场奖励，打满自动停；强化优先升「已拥有里等级最高」的武器，材料由闯关产出。不影响照顾/活动循环。</div>
      <div class="pp-row"><label for="p-singleTab">多标签页只跑一个</label><input type="checkbox" id="p-singleTab" ${settings.singleTab ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-reloadOnClaim">领奖/叫醒后刷新页面</label><input type="checkbox" id="p-reloadOnClaim" ${settings.reloadOnClaim ? 'checked' : ''}></div>
      <div class="pp-hint">刷新会重启脚本（设置/日志不丢），20 秒内只刷一次。</div>
      <div class="pp-row"><label for="p-toast">页面内提示</label><input type="checkbox" id="p-toast" ${settings.toast ? 'checked' : ''}></div>
      <div class="pp-row"><label for="p-gmNotify">浏览器通知</label><input type="checkbox" id="p-gmNotify" ${settings.gmNotify ? 'checked' : ''}></div>
      <div class="pp-hint">服务端有风控与每日上限：遇到「需要人机验证」时，请在宠物页面手动操作一次过掉滑块，助手会自动继续。</div>
    `;
  }

  function saveFromForm() {
    const $ = (id) => document.getElementById(id);
    if (!$('p-enabled')) {
      // 只有在「设置」Tab 才有表单；不在时先切过去，避免读到 null 直接报错
      activeTab = 'settings';
      renderBody();
      toast('已切到设置页，请再点一次「保存设置」', 'info');
      return;
    }
    const wasEnabled = settings.enabled;
    settings.enabled = $('p-enabled').checked;
    settings.autoCare = $('p-autoCare').checked;
    settings.autoSchedule = $('p-autoSchedule').checked;
    settings.autoRest = $('p-autoRest').checked;
    settings.autoCoffee = $('p-autoCoffee').checked;
    // 活动策略下拉：非法值退回均衡发展
    const stEl = $('p-strategy');
    settings.strategy = stEl && STRATEGY_WEIGHT[stEl.value] ? stEl.value : 'balanced';
    settings.careThreshold = Math.min(100, Math.max(0, Number($('p-careThreshold').value) || 0));
    settings.energyRestThreshold = Math.min(100, Math.max(0, Number($('p-energyRestThreshold').value) || 0));
    settings.minEnergyForActivity = Math.min(100, Math.max(0, Number($('p-minEnergyForActivity').value) || 0));
    settings.earlyWake = $('p-earlyWake').checked;
    settings.pollInterval = Math.min(600, Math.max(10, Number($('p-pollInterval').value) || 10));
    settings.autoSupply = $('p-autoSupply').checked;
    settings.autoRestock = $('p-autoRestock').checked;
    settings.foodBuyThreshold = Math.min(99, Math.max(1, Number($('p-foodBuyThreshold').value) || 5));
    settings.foodBuyTarget = Math.max(settings.foodBuyThreshold, Math.min(99, Number($('p-foodBuyTarget').value) || 10));
    settings.autoStory = $('p-autoStory').checked;
    settings.autoCraft = $('p-autoCraft').checked;
    settings.autoBrawlFight = $('p-autoBrawlFight').checked;
    settings.autoBrawlUpgrade = $('p-autoBrawlUpgrade').checked;
    settings.singleTab = $('p-singleTab').checked;
    settings.reloadOnClaim = $('p-reloadOnClaim').checked;
    settings.toast = $('p-toast').checked;
    settings.gmNotify = $('p-gmNotify').checked;
    saveSettings();
    toast('设置已保存', 'info');
    log('info', '设置已保存');
    renderToggleBtn();
    setDot();
    if (settings.enabled && !wasEnabled) {
      resumeFromRisk();
      startLoop();
    }
    if (!settings.enabled && wasEnabled) stopLoop();
  }

  function renderLog(body) {
    if (!body) {
      if (activeTab !== 'log') return;
      body = document.getElementById('fp-pet-body');
      if (!body) return;
    }
    const entries = logEntries.slice().reverse();
    body.innerHTML =
      `<div class="pp-log">` +
      (entries.length
        ? entries
            .map((e) => {
              const d = new Date(e.t);
              const p = (n) => String(n).padStart(2, '0');
              const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
              return `<div class="e ${e.kind}"><span class="t">${ts}</span>${escapeHtml(e.text)}</div>`;
            })
            .join('')
        : `<div class="e info">暂无日志</div>`) +
      `</div>`;
    const foot = document.createElement('div');
    foot.style.marginTop = '8px';
    foot.innerHTML = `<button class="pp-btn ghost" id="fp-pet-clear-log">清空日志</button>`;
    body.appendChild(foot);
    foot.querySelector('#fp-pet-clear-log').addEventListener('click', () => {
      logEntries = [];
      saveLog();
      renderLog();
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ================================================================
   * 启动
   * ================================================================ */
  let started = false;

  function ensureSession() {
    if (started) return;
    if (!PAGES_PATH_RE.test(location.pathname)) return; // 只在宠物页面运行
    started = true;

    buildUI();
    log('info', `宠物助手已启动 v${SCRIPT_VER}`);

    (async () => {
      // 先拉 catalog（决定活动条目与时长），再开循环；失败会自动重试
      const loadCatalog = async () => {
        try {
          catalog = await getCatalog();
          catalogVersion = catalog && catalog.activityVersion;
          log('info', '已加载宠物目录');
          try {
            const rl = (catalog && catalog.rules) || {};
            log(
              'info',
              `服务端规则：回蓝 ${num(rl.restEnergyPerHour, 0)}/时、休息上限 ${Math.round(num(rl.restDurationMs, 0) / 60000)} 分钟、成长上限 ${num(rl.growthDailyLimit, 0)}/日、每日金币 ${num(rl.dailyCoins, 0)}、每日口粮 ${num(rl.dailyFood, 0)}`
            );
          } catch (e) {
            /* ignore */
          }
          try {
            const em = activityEntriesByKind();
            for (const k of ['outing', 'course', 'work']) {
              if (em[k].length) log('info', `目录条目[${k}] 示例：` + JSON.stringify(em[k][0]).slice(0, 500));
            }
          } catch (e) {
            /* ignore */
          }
          return true;
        } catch (e) {
          log('fail', '加载宠物目录失败：' + e.message + '（15 秒后重试）');
          return false;
        }
      };
      const ok = await loadCatalog();
      if (!ok) setTimeout(loadCatalog, 15000);
      if (settings.enabled) startLoop();
    })();

    GM_registerMenuCommand('🐾 宠物助手：开/关', () => {
      settings.enabled = !settings.enabled;
      saveSettings();
      log('info', settings.enabled ? '已启用宠物助手（菜单）' : '已停用宠物助手（菜单）');
      renderToggleBtn();
      setDot();
      if (settings.enabled) {
        resumeFromRisk();
        startLoop();
      } else stopLoop();
    });
    GM_registerMenuCommand('🐾 打开宠物助手面板', togglePanel);
    GM_registerMenuCommand('🐾 重置图标位置', resetFabPos);
    GM_registerMenuCommand('🐾 立即检查一次', () => tick());
  }

  // SPA 路由监听：进出宠物页面时启停（离开后零请求）
  function syncPageState() {
    ensureSession();
    if (!started) return;
    if (PAGES_PATH_RE.test(location.pathname)) {
      if (settings.enabled) startLoop();
    } else {
      stopLoop();
    }
  }

  // 关页/刷新时立刻交还锁，其他标签页不用等 30 秒 TTL 过期
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', releaseOwner);
    window.addEventListener('beforeunload', releaseOwner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncPageState();
      setInterval(syncPageState, 3000);
    });
  } else {
    syncPageState();
    setInterval(syncPageState, 3000);
  }
})();
