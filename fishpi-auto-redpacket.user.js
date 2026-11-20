// ==UserScript==
// @name         new鱼排红包
// @namespace    https://github.com/Mairo/fishpi-redpacket
// @version      1.3.2
// @description  new.fishpi.cn / fishpi.cn 聊天室自动抢红包：实时监听、规则过滤、猜拳概率推荐、设置面板、统计日志
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
  const WS_URL = 'wss://fishpi.cn/api/v3/realtime';
  const SCRIPT_VER = '1.3.2';
  /* 聊天室页面白名单：只有这些路径才启动实时通道（其他 fishpi 页面零网络请求） */
  const CHAT_PATH_RE = /^\/(cr|chat|chat-room)(\/|$)/;
  const WS_LOCK_KEY = 'fp_ar_ws_owner'; // 跨标签页单实例锁（GM 存储，全域共享）
  const WS_LOCK_TTL = 15000; // 锁心跳有效期
  const PACKET_TYPES = ['random', 'average', 'specify', 'heartbeat', 'rockPaperScissors'];
  const TYPE_LABEL = {
    random: '拼手气',
    average: '平分',
    specify: '专属',
    heartbeat: '心跳',
    rockPaperScissors: '猜拳',
  };

  /* 猜拳：0 石头 1 剪刀 2 布 */
  const GESTURE_LABEL = ['石头', '剪刀', '布'];
  const BEATS = [2, 0, 1]; // BEATS[x] = 能赢 x 的招：石头→布，剪刀→石头，布→剪刀
  const PREBEAT = [1, 2, 0]; // PREBEAT[g] = 输给 g 的招（BEATS 的逆映射）

  const DEFAULT_SETTINGS = {
    enabled: true, // 总开关
    skipSpecify: true, // 跳过非指定给我的专属红包
    skipOwn: true, // 跳过自己发的
    allowHeartbeat: false, // 心跳红包可能倒扣积分，默认不抢
    autoGesture: true, // 猜拳自动随机出招
    smartGesture: true, // 猜拳出招用统计推荐（关闭则随机）
    rpsMaxPrincipal: 2000, // 猜拳红包金额上限，0=不限（防大额包倒扣）
    minPrincipal: 0, // 最低本金阈值（积分）
    blacklist: '', // 发送者黑名单（userName，逗号分隔）
    randomDelayMin: 800, // 随机延迟下限 ms（放慢出手，让别人有机会）
    randomDelayMax: 3000, // 随机延迟上限 ms
    minClaimInterval: 1500, // 两次领取最小间隔 ms
    dailyLimit: 50, // 每日成功领取上限，0 = 不限
    manualStats: true, // 统计手动领取
    replyEnabled: true, // 抢到后自动回复
    replyText: '谢谢老板的红包🧧', // 回复内容，支持 {发送者} {金额}
    toast: true, // 页面内提示
    gmNotify: false, // 浏览器通知（页面不可见时）
  };

  const DEFAULT_STATS = {
    total: 0, // 领到的包数
    points: 0, // 累计积分
    skipped: 0, // 跳过次数
    failed: 0, // 失败次数
    byDay: {}, // { '2026-11-17': { count, points } }
    log: [], // 最近 100 条日志
  };

  /* 猜拳统计：按发送者的历史出招分布 + 全局分布 + 我的战绩 */
  const DEFAULT_RPS = {
    bySender: {}, // { userName: { g: [石头,剪刀,布], n } }
    global: [0, 0, 0],
    mine: { win: 0, lose: 0, tie: 0, points: 0 },
  };

  const KEY_SETTINGS = 'fp_ar_settings';
  const KEY_STATS = 'fp_ar_stats';
  const KEY_RPS = 'fp_ar_rps';

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
      console.error('[自动抢红包] 存储失败', e);
    }
  }

  let settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON(KEY_SETTINGS, DEFAULT_SETTINGS));
  let stats = Object.assign({}, DEFAULT_STATS, loadJSON(KEY_STATS, DEFAULT_STATS));
  if (!stats.byDay || typeof stats.byDay !== 'object') stats.byDay = {};
  if (!Array.isArray(stats.log)) stats.log = [];

  let rps = Object.assign({}, DEFAULT_RPS, loadJSON(KEY_RPS, DEFAULT_RPS));
  if (!rps.bySender || typeof rps.bySender !== 'object') rps.bySender = {};
  if (!Array.isArray(rps.global) || rps.global.length !== 3) rps.global = [0, 0, 0];
  if (!rps.mine || typeof rps.mine !== 'object') rps.mine = Object.assign({}, DEFAULT_RPS.mine);
  let lastRpsHint = null; // 最近一次猜拳推荐（内存态，不落盘）

  const saveSettings = () => saveJSON(KEY_SETTINGS, settings);
  const saveStats = () => saveJSON(KEY_STATS, stats);
  const saveRps = () => saveJSON(KEY_RPS, rps);

  // v1.3.0 一次性迁移：旧默认太激进（150/800ms），换成“放慢出手”默认值
  // 仅当值仍是旧默认时才替换，不覆盖升级后手改的配置
  if (settings.__v !== 130) {
    if (Number(settings.randomDelayMax) <= 150) settings.randomDelayMax = 3000;
    if (!Number(settings.randomDelayMin)) settings.randomDelayMin = 800;
    if (Number(settings.minClaimInterval) <= 800) settings.minClaimInterval = 1500;
    settings.__v = 130;
    saveSettings();
  }

  /* ================================================================
   * 日志 / 提示
   * ================================================================ */
  function todayKey(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function log(kind, text) {
    const entry = { t: Date.now(), kind, text };
    stats.log.push(entry);
    if (stats.log.length > 100) stats.log = stats.log.slice(-100);
    saveStats();
    renderLog();
    renderBadge();
    if (kind === 'fail' || kind === 'error') console.warn('[自动抢红包]', text);
    else console.log('[自动抢红包]', text);
  }

  let toastTimer = null;
  function toast(msg, type) {
    if (!settings.toast && type !== 'error') return;
    if (!document.body) return; // document-start 阶段 body 可能还不存在
    let el = document.getElementById('fp-ar-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fp-ar-toast';
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
   * HTTP（GM_xmlhttpRequest，自动携带 fishpi.cn Cookie）
   * ================================================================ */
  /* ---------------------------------------------------------------
   * token 获取策略（v1.3.1）：
   * 1. 优先复用 GM 缓存的 token
   * 2. 监听页面自身的 Authorization 头 / 官方 refresh 响应，捕获官方刷新的 token
   * 3. 以上都没有才自己调 refresh（带跨标签页锁 + 冷却，避免与官方抢 refresh 导致登录失效）
   * --------------------------------------------------------------- */
  const KEY_TOKEN = 'fp_ar_token';
  const KEY_RLOCK = 'fp_ar_rlock';
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

  // 监听页面 fetch/XHR：捕获官方请求带的 Authorization 与官方 refresh 响应里的新 token
  function installTokenCapture() {
    try {
      const W = unsafeWindow;
      if (W.fetch && !W.fetch.__fpTokHook) {
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
        wrapped.__fpTokHook = true;
        W.fetch = wrapped;
      }
      const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (proto && !proto.__fpTokHook) {
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
        proto.__fpTokHook = true;
      }
    } catch (e) {
      /* ignore */
    }
  }
  installTokenCapture();

  /* 全局串行节流：所有 v3 请求过同一个 250ms 间隔闸，避免连发触发频控 */
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

    // 兜底：GM_xmlhttpRequest（页面 fetch 因 CSP/CORS 失败时使用）
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

    // 优先页面原生 fetch：与官方前端同源策略完全一致（页面 Origin + Cookie）
    // 服务端会校验 Origin/Referer（chrome-extension:// 来源会被 403）
    return fetch(url, init).then(
      (r) => r.text().then((t) => parse(r.status, r.headers.get('retry-after') ? 'retry-after: ' + r.headers.get('retry-after') : '', t)),
      () => gmFallback()
    );
  }

  class ApiError extends Error {
    constructor(msg, code, status) {
      super(msg);
      this.code = code;
      this.status = status;
    }
  }

  let refreshCooldownUntil = 0; // 自己刷新后的冷却（期间优先等捕获）
  let refreshChain = Promise.resolve(); // 同页串行

  function refreshToken() {
    // 同页串行 + 冷却：避免连发 refresh
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
    const lockKey = KEY_RLOCK;
    let lock = 0;
    try {
      lock = Number(GM_getValue(lockKey, 0)) || 0;
    } catch (e) {
      /* ignore */
    }
    if (lock > Date.now()) {
      for (let i = 0; i < 20 && !accessToken && Date.now() < lock; i++) await sleep(300);
      if (accessToken) return accessToken;
    }
    try {
      GM_setValue(lockKey, String(Date.now() + 8000));
    } catch (e) {
      /* ignore */
    }

    // 与官方前端一致：auth 接口不携带 Authorization，仅靠 Cookie
    const r = await rawRequest('POST', '/api/v3/auth/refresh', {}, undefined, true);
    if (r.status === 429) {
      const m = /retry-after\s*:\s*(\d+)/i.exec(r.responseHeaders || '');
      rateLimitUntil = Date.now() + (m ? Number(m[1]) : 60) * 1000;
      refreshCooldownUntil = Date.now() + 30000;
      throw new ApiError('操作过于频繁（429），请稍后', 'rate_limited', 429);
    }
    if (!r.json || r.json.code !== 0 || !r.json.data || typeof r.json.data.accessToken !== 'string') {
      refreshCooldownUntil = Date.now() + 30000; // 失败也冷却，防止反复撞官方
      throw new ApiError((r.json && r.json.msg) || '获取登录凭据失败，请先登录 fishpi.cn', r.json ? r.json.code : 'no_response', r.status);
    }
    saveToken(r.json.data.accessToken);
    refreshCooldownUntil = Date.now() + 30000;
    try {
      GM_setValue(lockKey, '0');
    } catch (e) {
      /* ignore */
    }
    return accessToken;
  }

  let rateLimitUntil = 0; // 429 退避截止时间戳

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
      // 可能 token 过期：优先采用新捕获的，没有才自己刷
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
      const waitSec = m ? Number(m[1]) : 60;
      rateLimitUntil = Date.now() + waitSec * 1000;
      log('error', `接口被限流，暂停自动抢 ${waitSec} 秒`);
      throw new ApiError('操作过于频繁（429）', 'rate_limited', 429);
    }
    if (!r.json) throw new ApiError('接口返回非 JSON（' + r.status + '）', 'invalid_response', r.status);
    if (r.json.code !== 0) {
      throw new ApiError(r.json.msg || '请求失败', r.json.code, r.status);
    }
    return r.json.data;
  }

  /* ================================================================
   * 账号信息
   * ================================================================ */
  let myId = '';
  let myUserName = '';

  async function loadMe() {
    const me = await api('GET', '/api/v3/me');
    myId = String(me.id || me.oId || '');
    myUserName = me.userName || '';
    renderPanelHeader();
    log('info', `已登录：${myUserName || myId || '未知用户'}`);
  }

  /* ================================================================
   * 实时通道
   * 策略（三层）：
   *   1. 优先 hook 页面自己的 WebSocket——官方前端已自行换 ticket、连接、
   *      重连、心跳，脚本被动窃听消息，完全不发 ticket 请求（根治 429）
   *   2. 页面通道未就绪 → 走自有 WS 兜底（换 ticket），但先抢
   *      跨标签页单实例锁，多标签只允许一个连接
   *   3. 429 时等待 max(指数退避, 限流窗口)，不再撞墙
   * ================================================================ */
  let ws = null;
  let wsTicket = '';
  let wsPingTimer = null;
  let wsReconnectTimer = null;
  let wsBackoff = 5000; // 5s 起步
  let wsConnected = false;
  let ownWsRunning = false;

  /* --- 页面通道（hook）状态 --- */
  let pageChatWs = null; // 承载聊天通道的页面 WS 实例
  let pageChatReady = false; // 页面聊天通道当前是否就绪
  let wsConnecting = false; // 自有 WS 正在建立（防并发）
  let realtimeStartAt = 0;
  let lockHeld = false;

  function isChatPage() {
    return CHAT_PATH_RE.test(location.pathname);
  }

  function wsStatus() {
    return wsConnected ? 'connected' : 'disconnected';
  }

  /* --- 跨标签页单实例锁（GM 存储跨标签页/跨子域共享） --- */
  const lockId = Math.random().toString(36).slice(2);
  let lockRenewTimer = null;

  function readLock() {
    try {
      return JSON.parse(GM_getValue(WS_LOCK_KEY, '') || 'null');
    } catch (e) {
      return null;
    }
  }
  function acquireWsLock() {
    const cur = readLock();
    if (cur && cur.id !== lockId && Date.now() - (cur.t || 0) < WS_LOCK_TTL) return false;
    try {
      GM_setValue(WS_LOCK_KEY, JSON.stringify({ id: lockId, t: Date.now() }));
    } catch (e) {
      return false;
    }
    lockHeld = true;
    if (!lockRenewTimer) lockRenewTimer = setInterval(renewWsLock, 5000);
    return true;
  }
  function renewWsLock() {
    try {
      GM_setValue(WS_LOCK_KEY, JSON.stringify({ id: lockId, t: Date.now() }));
    } catch (e) {
      /* ignore */
    }
  }
  function releaseWsLock() {
    if (lockRenewTimer) {
      clearInterval(lockRenewTimer);
      lockRenewTimer = null;
    }
    if (!lockHeld) return;
    lockHeld = false;
    const cur = readLock();
    if (cur && cur.id === lockId) {
      try {
        GM_setValue(WS_LOCK_KEY, '');
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* --- hook 页面 WebSocket：在页面建连前拦截，窃听实时消息 --- */
  let creatingOwnWs = false; // 自建 WS 期间，hook 不再把它当页面通道

  function installWsHook() {
    try {
      const Orig = unsafeWindow.WebSocket;
      if (!Orig || Orig.__fpArHooked) return;
      const Wrapped = function (url, protocols) {
        const inst = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
        try {
          if (!creatingOwnWs && String(url).indexOf('/api/v3/realtime') !== -1) tapPageWs(inst);
        } catch (e) {
          /* ignore */
        }
        return inst;
      };
      Wrapped.prototype = Orig.prototype;
      Wrapped.CONNECTING = Orig.CONNECTING;
      Wrapped.OPEN = Orig.OPEN;
      Wrapped.CLOSING = Orig.CLOSING;
      Wrapped.CLOSED = Orig.CLOSED;
      Wrapped.__fpArHooked = true;
      unsafeWindow.WebSocket = Wrapped;
    } catch (e) {
      console.warn('[自动抢红包] 页面 WebSocket hook 失败', e);
    }
  }

  function tapPageWs(inst) {
    inst.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m && m.type === 'ready' && m.data && m.data.channel === 'chat') {
        pageChatWs = inst;
        pageChatReady = true;
      }
      handleWsMessage(m, false);
    });
    inst.addEventListener('close', () => {
      if (pageChatWs === inst) {
        pageChatWs = null;
        pageChatReady = false;
        wsConnected = false;
        setIndicator();
      }
    });
    inst.addEventListener('error', () => {
      /* close 会统一处理 */
    });
  }

  /* --- 自有 WS 兜底 --- */
  let lastReconnectLog = 0;
  let lastPageReadyLog = 0;
  function scheduleReconnect(reason) {
    if (wsReconnectTimer) return;
    // 等待取「自身指数退避」与「限流窗口剩余」的较大者，不再撞 429
    const rateWait = Math.max(0, rateLimitUntil - Date.now());
    const jitter = 0.8 + Math.random() * 0.4;
    const wait = Math.max(Math.round(wsBackoff * jitter), rateWait);
    if (reason && Date.now() - lastReconnectLog > 60000) {
      lastReconnectLog = Date.now();
      log('info', `实时通道断开（${reason}），${Math.round(wait / 1000)}s 后重连`);
    }
    setIndicator();
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWS();
    }, wait);
    wsBackoff = Math.min(Math.max(wsBackoff * 2, 5000), 600000); // 5s → 10min
  }

  function stopOwnWs() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    wsConnecting = false;
    stopPing();
    if (ws) {
      try {
        ws.onclose = null; // 避免 close 再次触发重连
        ws.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    }
    releaseWsLock();
    ownWsRunning = false;
    wsConnected = pageChatReady;
    setIndicator();
  }

  async function connectWS() {
    if (!isChatPage()) return; // 已离开聊天室
    if (pageChatReady) return; // 页面通道已就绪，无需兜底
    if (wsConnecting || ownWsRunning || wsReconnectTimer) return;

    // 先抢单实例锁（纯本地存储，不发网络请求），失败则安静等待，不打 ticket 接口
    if (!acquireWsLock()) {
      scheduleReconnect('其他标签页占用实时通道');
      return;
    }

    wsConnecting = true;
    try {
      const t = await api('POST', '/api/v3/chat/realtime-ticket', {});
      wsTicket = t.ticket || '';
      if (!wsTicket) throw new Error('未获取到 ticket');
    } catch (e) {
      wsConnecting = false;
      scheduleReconnect('获取 ticket 失败：' + e.message);
      return;
    }

    try {
      creatingOwnWs = true;
      ws = new WebSocket(WS_URL);
    } catch (e) {
      wsConnecting = false;
      scheduleReconnect('创建 WebSocket 失败');
      return;
    } finally {
      creatingOwnWs = false;
    }

    wsConnecting = false;
    ownWsRunning = true;
    wsBackoff = 5000;
    const self = ws; // 局部引用，避免 stopOwnWs 置空后回调出错

    self.onopen = () => {
      try {
        self.send(JSON.stringify({ type: 'authenticate', ticket: wsTicket }));
      } catch (e) {
        /* ignore */
      }
    };
    self.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handleWsMessage(m, true);
    };
    self.onerror = () => {
      /* onclose 会统一处理 */
    };
    self.onclose = () => {
      stopPing();
      wsConnected = pageChatReady;
      setIndicator();
      scheduleReconnect();
    };
  }

  function stopPing() {
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
  }

  function handleWsMessage(m, isOwn) {
    switch (m.type) {
      case 'authentication.required':
        if (isOwn && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'authenticate', ticket: wsTicket }));
        break;
      case 'ready': {
        if (m.data && m.data.channel === 'chat') {
          if (isOwn) {
            wsConnected = true;
            wsBackoff = 5000;
            setIndicator();
            log('info', '实时通道已连接（自有）');
            stopPing();
            wsPingTimer = setInterval(() => {
              if (ws && ws.readyState === 1) {
                try {
                  ws.send(JSON.stringify({ type: 'ping' }));
                } catch (e) {
                  /* ignore */
                }
              }
            }, 25000);
          } else {
            // 页面自己的通道就绪：亮绿灯 + 若兜底 WS 在跑则停掉它（省 ticket）
            wsConnected = true;
            setIndicator();
            if (Date.now() - lastPageReadyLog > 60000) {
              lastPageReadyLog = Date.now();
              log('info', '实时通道已连接（监听页面通道）');
            }
            if (ownWsRunning) stopOwnWs();
          }
        }
        break;
      }
      case 'chat.message.created':
        onChatMessage(m.data && m.data.message);
        break;
      case 'chat.red_packet.claimed':
        onPacketClaimed(m.data);
        break;
      case 'chat.sync_required':
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  /* --- 监督循环：页面通道健康就不发任何请求，不健康才启用兜底 --- */
  let superviseTimer = null;
  function supervise() {
    if (!isChatPage()) return;
    if (pageChatReady) {
      if (ownWsRunning) stopOwnWs();
      return;
    }
    // 给页面通道留 15s 启动时间，避免抢跑打 ticket
    if (realtimeStartAt && Date.now() - realtimeStartAt < 15000) return;
    if (!ownWsRunning && !wsReconnectTimer && !wsConnecting) connectWS();
  }

  function initRealtime() {
    if (superviseTimer) return;
    realtimeStartAt = Date.now();
    superviseTimer = setInterval(supervise, 10000);
    setTimeout(supervise, 8000);
  }

  function stopRealtime() {
    if (superviseTimer) {
      clearInterval(superviseTimer);
      superviseTimer = null;
    }
    stopOwnWs();
    wsConnected = pageChatReady; // 页面通道状态交给 tap 事件管理，此处不重置
    realtimeStartAt = 0;
    setIndicator();
  }

  /* ================================================================
   * 抢包流水线
   * ================================================================ */
  const grabQueue = [];
  let draining = false;
  const attemptedPackets = new Set(); // 已进入抢包流程的包（防重复入队）
  const countedPackets = new Set(); // 已记账的包（脚本抢的 + 手动统计的，防双计）

  function onChatMessage(msg) {
    if (!msg) return;
    const isPacket = msg.type === 'redPacket' || (msg.card && msg.card.type === 'redPacket');
    if (!isPacket) return;
    const packetId = String(msg.id || (msg.redPacket && msg.redPacket.id) || '');
    if (!packetId) return;
    if (attemptedPackets.has(packetId)) return;

    if (!settings.enabled) {
      // 总开关关闭：不入队、不去重——手动领取仍可被「统计手动领取」捕获
      log('info', '发现红包但总开关关闭，已忽略');
      return;
    }
    attemptedPackets.add(packetId);
    if (attemptedPackets.size > 500) {
      const arr = Array.from(attemptedPackets);
      attemptedPackets.clear();
      arr.slice(-300).forEach((x) => attemptedPackets.add(x));
    }

    const senderName = (msg.author && (msg.author.userName || msg.author.userNickname)) || '';
    log('info', `发现红包消息（来自 ${senderName || '未知'}），加入队列`);
    grabQueue.push({ packetId, senderName });
    if (!draining) drainQueue();
  }

  async function drainQueue() {
    draining = true;
    while (grabQueue.length > 0) {
      const item = grabQueue.shift();
      try {
        await grabOne(item.packetId, item.senderName);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'rate_limited') {
          // 频控：把剩余队列退回，等暂停结束
          grabQueue.unshift(item);
          const wait = Math.max(rateLimitUntil - Date.now(), 1000);
          await sleep(wait);
          continue;
        }
        stats.failed += 1;
        log('fail', `抢包失败：${e.message}`);
      }
      const gap = Number(settings.minClaimInterval) || 0;
      await sleep(gap + Math.floor(Math.random() * 400));
    }
    draining = false;
  }

  async function grabOne(packetId, senderName) {
    // 1. 拉取红包详情
    const p = await api('GET', `/api/v3/chat/red-packets/${packetId}`);
    const sender = p.sender || {};
    const senderLabel = sender.userName || senderName || '未知';
    const type = p.type;
    const count = Number(p.count) || 0;
    const got = Number(p.got) || 0;
    const money = Number(p.money) || 0;
    const principal = money * (type === 'average' || type === 'specify' ? count : 1);

    // 2. 过滤规则
    const skip = (why) => {
      stats.skipped += 1;
      log('skip', `跳过红包（${TYPE_LABEL[type] || type || '未知'}，${senderLabel}）：${why}`);
    };

    if (p.legacy) return skip('旧版红包不支持');
    if (!PACKET_TYPES.includes(type)) return skip('未知红包类型 ' + type);
    if (p.currentUserClaim) return skip('已抢过');
    if (got >= count) return skip('已被抢完');
    if (settings.skipOwn && myId && String(sender.id) === String(myId)) return skip('自己发的');
    if (settings.skipSpecify && type === 'specify' && Array.isArray(p.recipientIds) && !p.recipientIds.includes(String(myId))) {
      return skip('专属红包但不是给我的');
    }
    if (isBlacklisted(sender.userName)) return skip('发送者在黑名单');
    if (principal < (Number(settings.minPrincipal) || 0)) return skip(`本金 ${principal} 低于阈值 ${settings.minPrincipal}`);
    if (type === 'rockPaperScissors' && Number(settings.rpsMaxPrincipal) > 0 && principal > Number(settings.rpsMaxPrincipal)) {
      return skip(`猜拳红包金额 ${principal} 超过上限 ${settings.rpsMaxPrincipal}`);
    }
    if (type === 'heartbeat' && !settings.allowHeartbeat) return skip('心跳红包未开启（可能倒扣积分）');

    // 猜拳：先给出概率推荐并记录（即使未开自动出招，也提示可手动抢）
    let rpsRec = null;
    if (type === 'rockPaperScissors') {
      rpsRec = recommendGesture(sender.userName || senderLabel);
      lastRpsHint = {
        time: Date.now(),
        sender: senderLabel,
        probs: rpsRec.probs,
        n: rpsRec.n,
        source: rpsRec.source,
        gesture: rpsRec.gesture,
      };
      log('info', `猜拳：${rpsHintText(rpsRec, senderLabel)}`);
      if (!settings.autoGesture) return skip('猜拳自动出招未开启（推荐已给出，可手动抢）');
    }

    const today = todayKey();
    const day = stats.byDay[today] || { count: 0, points: 0 };
    if (Number(settings.dailyLimit) > 0 && day.count >= Number(settings.dailyLimit)) {
      return skip(`今日已抢 ${day.count} 个，达到上限 ${settings.dailyLimit}`);
    }

    // 3. 随机延迟：[下限, 上限] 区间随机，放慢出手让其他人也有机会
    const delayMin = Math.max(0, Number(settings.randomDelayMin) || 0);
    const delayMax = Math.max(delayMin, Number(settings.randomDelayMax) || 0);
    if (delayMax > 0) await sleep(delayMin + Math.floor(Math.random() * (delayMax - delayMin)));

    // 4. 领取
    const body = {};
    if (type === 'heartbeat') body.riskAccepted = true;
    if (type === 'rockPaperScissors') {
      body.riskAccepted = true;
      // 智能推荐开启时用统计推荐的招，否则随机
      body.gesture = settings.smartGesture && rpsRec ? rpsRec.gesture : Math.floor(Math.random() * 3);
    }
    const key = genIdempotencyKey();
    const res = await api('POST', `/api/v3/chat/red-packets/${packetId}/claims`, body, { 'Idempotency-Key': key });

    // 5. 记账
    const amount = Number(res && res.amount) || 0;
    stats.total += 1;
    stats.points += amount;
    const day2 = stats.byDay[today] || { count: 0, points: 0 };
    day2.count += 1;
    day2.points += amount;
    stats.byDay[today] = day2;

    if (type === 'rockPaperScissors') updateRpsRecord(sender.userName || senderLabel, res || {});

    let extra = '';
    if (type === 'rockPaperScissors' && res && res.outcome) {
      const oc = { win: '赢了', lose: '输了', tie: '平局' }[res.outcome] || res.outcome;
      const myG = GESTURE_LABEL[Number(res.gesture)] || '?';
      extra = `（猜拳${oc}，我出${myG}）`;
    }
    const sign = amount > 0 ? '+' : '';
    countedPackets.add(String(packetId)); // 已记账，防止领取事件重复统计
    if (countedPackets.size > 500) {
      const arr = Array.from(countedPackets);
      countedPackets.clear();
      arr.slice(-300).forEach((x) => countedPackets.add(x));
    }
    log('grab', `抢到 ${sign}${amount} 积分（${TYPE_LABEL[type] || type}红包，来自 ${senderLabel}）${extra}`);
    toast(`🧧 抢到 ${sign}${amount} 积分${extra}`, amount >= 0 ? 'success' : 'warn');
    browserNotify('摸鱼派抢红包', `抢到 ${sign}${amount} 积分（来自 ${senderLabel}）`);
    renderStats();
    renderRps();
    renderBadge();
    scheduleReply(senderLabel, amount);
  }

  function onPacketClaimed(data) {
    if (!data) return;
    renderBadge();
    if (!settings.manualStats) return;
    if (data.kind && data.kind !== 'claim') return;
    // 领取人是自己才记（事件里有 actor，但不含金额，需拉详情补）
    const actorId = data.actor && String(data.actor.id || '');
    const actorName = (data.actor && (data.actor.userName || data.actor.userNickname)) || '';
    const isMe = (myId && actorId && actorId === myId) || (myUserName && actorName === myUserName);
    if (!isMe) return;
    // 脚本自己抢的包已记账；稍等再复查 countedPackets，避免与 grabOne 记账抢跑
    recordManualClaim(String(data.packetId));
  }

  const manualPending = new Set();
  function recordManualClaim(packetId) {
    if (!packetId || countedPackets.has(packetId) || manualPending.has(packetId)) return;
    manualPending.add(packetId);
    setTimeout(() => {
      (async () => {
        try {
          if (countedPackets.has(packetId)) return; // 已被脚本流程记账
          const p = await api('GET', `/api/v3/chat/red-packets/${packetId}`);
          const claim = p.currentUserClaim;
          if (!claim || countedPackets.has(packetId)) return;
          countedPackets.add(packetId);
          const amount = Number(claim.amount) || 0;
          const today = todayKey();
          stats.total += 1;
          stats.points += amount;
          const day = stats.byDay[today] || { count: 0, points: 0 };
          day.count += 1;
          day.points += amount;
          stats.byDay[today] = day;
          const sender = (p.sender && (p.sender.userName || '')) || '';
          const typeLabel = TYPE_LABEL[p.type] || p.type || '红包';
          if (p.type === 'rockPaperScissors') updateRpsRecord(sender, claim);
          const sign = amount > 0 ? '+' : '';
          log('grab', `手动抢到 ${sign}${amount} 积分（${typeLabel}，来自 ${sender || '未知'}）`);
          toast(`🧧 手动抢到 ${sign}${amount} 积分`, 'success');
          renderStats();
          renderRps();
          renderBadge();
          scheduleReply(sender, amount);
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'rate_limited')) log('fail', `手动统计失败：${e.message}`);
        } finally {
          manualPending.delete(packetId);
        }
      })();
    }, 1000); // 等 1s：让脚本自己的记账先落地，避免双计
  }

  function isBlacklisted(userName) {
    if (!settings.blacklist || !userName) return false;
    return String(settings.blacklist)
      .split(/[,，\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(String(userName).toLowerCase());
  }

  /* ================================================================
   * 猜拳统计与推荐
   * 说明：对方“当前这一把”的出招服务端不下发（抢完才揭晓），
   * 这里做的是基于历史出招习惯的经验概率预测。
   * ================================================================ */
  function pct(x) {
    return Math.round(x * 100) + '%';
  }

  // 由「我出的招 + 输赢结果」反推对方出的招
  function deriveSenderGesture(myGesture, outcome) {
    if (![0, 1, 2].includes(myGesture)) return -1;
    if (outcome === 'tie') return myGesture;
    if (outcome === 'win') return PREBEAT[myGesture]; // 我赢 → 他出的是被我克制的
    if (outcome === 'lose') return BEATS[myGesture]; // 我输 → 他出的是克制我的
    return -1;
  }

  function updateRpsRecord(senderUserName, res) {
    const myGesture = Number(res.gesture);
    const outcome = String(res.outcome || '');
    const s = deriveSenderGesture(myGesture, outcome);
    if (s < 0) return;
    const key = senderUserName || '未知';
    if (!rps.bySender[key]) rps.bySender[key] = { g: [0, 0, 0], n: 0 };
    const bucket = rps.bySender[key];
    bucket.g[s] += 1;
    bucket.n += 1;
    rps.global[s] += 1;
    if (outcome === 'win') rps.mine.win += 1;
    else if (outcome === 'lose') rps.mine.lose += 1;
    else rps.mine.tie += 1;
    rps.mine.points += Number(res.amount) || 0;
    saveRps();
  }

  // 经验概率（拉普拉斯平滑）：优先该发送者历史，其次全局，都没有则等概率
  function rpsProbabilities(senderUserName) {
    const laplace = (arr) => {
      const s = arr[0] + arr[1] + arr[2] + 3;
      return [(arr[0] + 1) / s, (arr[1] + 1) / s, (arr[2] + 1) / s];
    };
    const b = senderUserName && rps.bySender[senderUserName];
    if (b && b.n >= 5) return { probs: laplace(b.g), n: b.n, source: 'sender' };
    const g = rps.global;
    const total = g[0] + g[1] + g[2];
    if (total >= 10) return { probs: laplace(g), n: total, source: 'global' };
    return { probs: [1 / 3, 1 / 3, 1 / 3], n: 0, source: 'none' };
  }

  // 推荐出招：克制「对方概率最高」的那一招（等价于我方胜率最大的选择）
  function recommendGesture(senderUserName) {
    const r = rpsProbabilities(senderUserName);
    let maxIdx = 0;
    if (r.probs[1] > r.probs[maxIdx]) maxIdx = 1;
    if (r.probs[2] > r.probs[maxIdx]) maxIdx = 2;
    return { gesture: BEATS[maxIdx], predicts: maxIdx, probs: r.probs, n: r.n, source: r.source };
  }

  function rpsHintText(rec, senderLabel) {
    const p = rec.probs.map(pct);
    const src =
      rec.source === 'sender' ? `样本${rec.n}` : rec.source === 'global' ? `全局样本${rec.n}` : '无历史数据，按等概率';
    return `${senderLabel}出招习惯 ${GESTURE_LABEL[0]}${p[0]} / ${GESTURE_LABEL[1]}${p[1]} / ${GESTURE_LABEL[2]}${p[2]}（${src}），推荐出${GESTURE_LABEL[rec.gesture]}`;
  }

  /* ================================================================
   * 抢到后自动回复
   * ================================================================ */
  let lastReplyAt = 0;

  function scheduleReply(senderLabel, amount) {
    if (!settings.replyEnabled) return;
    if (Number(amount) < 0) return; // 猜拳输了不回复
    if (Date.now() - lastReplyAt < 10000) return; // 10s 内连抢只回第一条（防刷屏）
    lastReplyAt = Date.now();
    const delay = 1500 + Math.floor(Math.random() * 1500);
    setTimeout(() => sendReply(senderLabel, amount), delay);
  }

  async function sendReply(senderLabel, amount) {
    try {
      let content = String(settings.replyText || '').trim();
      if (!content) return;
      content = content
        .replace(/\{发送者\}/g, senderLabel || '老板')
        .replace(/\{金额\}/g, (Number(amount) > 0 ? '+' : '') + Number(amount));
      if (content.length > 4096) content = content.slice(0, 4096);
      await api('POST', '/api/v3/chat/messages', { content, client: 'Web/PC网页端' }, { 'Idempotency-Key': genIdempotencyKey() });
      log('info', `已自动回复：${content}`);
    } catch (e) {
      log('fail', `自动回复失败：${e.message}`);
    }
  }

  function genIdempotencyKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'fp-ar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ================================================================
   * UI：样式
   * ================================================================ */
  function applyStyles() {
    GM_addStyle(`
#fp-ar-fab{position:fixed;right:14px;bottom:110px;width:44px;height:44px;border-radius:50%;background:#e8443a;color:#fff;border:none;font-size:20px;cursor:pointer;z-index:2147483000;box-shadow:0 4px 12px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;user-select:none}
#fp-ar-fab .dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#9e9e9e;border:2px solid #fff}
#fp-ar-fab .dot.connected{background:#4caf50}
#fp-ar-fab .badge{position:absolute;top:-6px;left:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#ff9800;color:#fff;font-size:11px;line-height:18px;text-align:center;font-weight:bold}
#fp-ar-toast{position:fixed;top:70px;left:50%;transform:translateX(-50%) translateY(-12px);background:rgba(30,30,30,.92);color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;z-index:2147483001;opacity:0;pointer-events:none;transition:all .25s ease;max-width:80vw}
#fp-ar-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#fp-ar-toast.warn{background:rgba(230,150,20,.95)}
#fp-ar-toast.error{background:rgba(200,50,50,.95)}
#fp-ar-panel{position:fixed;right:14px;bottom:164px;width:340px;max-height:70vh;background:#1e1f24;color:#e8e8ea;border:1px solid #3a3b42;border-radius:12px;z-index:2147483001;display:none;flex-direction:column;box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:13px;overflow:hidden}
#fp-ar-panel.open{display:flex}
#fp-ar-panel .fp-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#26272e;border-bottom:1px solid #3a3b42;cursor:move;user-select:none}
#fp-ar-panel .fp-title{font-weight:bold;font-size:14px}
#fp-ar-panel .fp-user{font-size:11px;color:#9a9ba3;margin-top:2px}
#fp-ar-panel .fp-close{background:none;border:none;color:#9a9ba3;font-size:18px;cursor:pointer;padding:0 4px}
#fp-ar-panel .fp-close:hover{color:#fff}
#fp-ar-panel .fp-tabs{display:flex;background:#26272e;border-bottom:1px solid #3a3b42}
#fp-ar-panel .fp-tab{flex:1;padding:8px 0;text-align:center;cursor:pointer;color:#9a9ba3;user-select:none}
#fp-ar-panel .fp-tab.active{color:#fff;background:#1e1f24;border-bottom:2px solid #e8443a}
#fp-ar-panel .fp-body{padding:12px 14px;overflow-y:auto;flex:1}
#fp-ar-panel .fp-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
#fp-ar-panel .fp-row label{flex:1;cursor:pointer}
#fp-ar-panel .fp-row input[type=number],#fp-ar-panel .fp-row input[type=text]{width:110px;background:#14151a;border:1px solid #3a3b42;color:#e8e8ea;border-radius:6px;padding:5px 8px;font-size:13px}
#fp-ar-panel .fp-row input[type=checkbox]{width:16px;height:16px;accent-color:#e8443a;cursor:pointer}
#fp-ar-panel .fp-hint{font-size:11px;color:#8a8b93;margin:-4px 0 10px;line-height:1.5}
#fp-ar-panel .fp-btn{background:#e8443a;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}
#fp-ar-panel .fp-btn.ghost{background:#3a3b42}
#fp-ar-panel .fp-btn:hover{filter:brightness(1.1)}
#fp-ar-panel .fp-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
#fp-ar-panel .fp-stat{background:#26272e;border-radius:8px;padding:10px}
#fp-ar-panel .fp-stat .v{font-size:20px;font-weight:bold;color:#ffb74d}
#fp-ar-panel .fp-stat .k{font-size:11px;color:#9a9ba3;margin-top:2px}
#fp-ar-panel .fp-log{max-height:34vh;overflow-y:auto;font-size:12px;line-height:1.6}
#fp-ar-panel .fp-log .e{padding:3px 6px;border-radius:4px;margin-bottom:3px;background:#26272e;word-break:break-all}
#fp-ar-panel .fp-log .e.grab{border-left:3px solid #4caf50}
#fp-ar-panel .fp-log .e.skip{border-left:3px solid #9e9e9e;color:#b9bac2}
#fp-ar-panel .fp-log .e.fail,#fp-ar-panel .fp-log .e.error{border-left:3px solid #e8443a;color:#ff8a80}
#fp-ar-panel .fp-log .e.info{border-left:3px solid #42a5f5}
#fp-ar-panel .fp-log .t{color:#7a7b83;margin-right:6px}
#fp-ar-panel .fp-foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #3a3b42;background:#26272e}
  `);
  }

  /* ================================================================
   * UI：面板
   * ================================================================ */
  let activeTab = 'settings';

  function buildUI() {
    if (document.getElementById('fp-ar-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'fp-ar-fab';
    fab.title = '摸鱼派自动抢红包';
    fab.innerHTML = '🧧<span class="dot"></span><span class="badge" style="display:none">0</span>';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'fp-ar-panel';
    panel.innerHTML = `
      <div class="fp-head" id="fp-ar-drag">
        <div>
          <div class="fp-title">🧧 自动抢红包 <span style="font-size:11px;color:#8a8b93">v${SCRIPT_VER}</span></div>
          <div class="fp-user" id="fp-ar-user">未连接</div>
        </div>
        <button class="fp-close" id="fp-ar-close" title="关闭">✕</button>
      </div>
      <div class="fp-tabs">
        <div class="fp-tab active" data-tab="settings">设置</div>
        <div class="fp-tab" data-tab="stats">统计</div>
        <div class="fp-tab" data-tab="rps">猜拳</div>
        <div class="fp-tab" data-tab="log">日志</div>
      </div>
      <div class="fp-body" id="fp-ar-body"></div>
      <div class="fp-foot">
        <button class="fp-btn" id="fp-ar-save">保存设置</button>
        <button class="fp-btn ghost" id="fp-ar-toggle">停用</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#fp-ar-close').addEventListener('click', togglePanel);
    panel.querySelectorAll('.fp-tab').forEach((el) => {
      el.addEventListener('click', () => {
        activeTab = el.dataset.tab;
        panel.querySelectorAll('.fp-tab').forEach((x) => x.classList.toggle('active', x === el));
        renderBody();
      });
    });
    panel.querySelector('#fp-ar-save').addEventListener('click', saveFromForm);
    panel.querySelector('#fp-ar-toggle').addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      saveSettings();
      log('info', settings.enabled ? '已启用自动抢红包' : '已停用自动抢红包');
      renderToggleBtn();
      renderBadge();
    });

    makeDraggable(panel, panel.querySelector('#fp-ar-drag'));
    renderBody();
    renderToggleBtn();
    renderBadge();
    setIndicator();
  }

  function togglePanel() {
    const panel = document.getElementById('fp-ar-panel');
    if (!panel) return;
    const open = panel.classList.toggle('open');
    if (open) renderBody();
  }

  function renderPanelHeader() {
    const el = document.getElementById('fp-ar-user');
    if (el) el.textContent = myUserName ? `已登录：${myUserName}` : myId ? `已登录：${myId}` : '未连接';
  }

  function setIndicator() {
    const dot = document.querySelector('#fp-ar-fab .dot');
    if (dot) dot.className = 'dot' + (wsConnected ? ' connected' : '');
    renderPanelHeader();
  }

  function renderBadge() {
    const badge = document.querySelector('#fp-ar-fab .badge');
    if (!badge) return;
    const day = stats.byDay[todayKey()] || { count: 0 };
    if (day.count > 0) {
      badge.style.display = '';
      badge.textContent = String(day.count);
    } else {
      badge.style.display = 'none';
    }
  }

  function renderToggleBtn() {
    const btn = document.getElementById('fp-ar-toggle');
    if (!btn) return;
    btn.textContent = settings.enabled ? '停用' : '启用';
    btn.style.background = settings.enabled ? '#3a3b42' : '#4caf50';
  }

  function renderBody() {
    const body = document.getElementById('fp-ar-body');
    if (!body) return;
    if (activeTab === 'settings') renderSettingsForm(body);
    else if (activeTab === 'stats') renderStats(body);
    else if (activeTab === 'rps') renderRps(body);
    else renderLog(body);
  }

  function renderSettingsForm(body) {
    body.innerHTML = `
      <div class="fp-row"><label for="s-enabled">启用自动抢红包</label><input type="checkbox" id="s-enabled" ${settings.enabled ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-skipSpecify">跳过非指定给我的专属红包</label><input type="checkbox" id="s-skipSpecify" ${settings.skipSpecify ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-skipOwn">跳过自己发的红包</label><input type="checkbox" id="s-skipOwn" ${settings.skipOwn ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-allowHeartbeat">允许抢心跳红包</label><input type="checkbox" id="s-allowHeartbeat" ${settings.allowHeartbeat ? 'checked' : ''}></div>
      <div class="fp-hint">⚠️ 心跳红包有倒扣积分的风险，默认不抢。</div>
      <div class="fp-row"><label for="s-autoGesture">猜拳红包自动出招</label><input type="checkbox" id="s-autoGesture" ${settings.autoGesture ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-smartGesture">出招用统计推荐</label><input type="checkbox" id="s-smartGesture" ${settings.smartGesture ? 'checked' : ''}></div>
      <div class="fp-hint">⚠️ 猜拳有输赢，输了可能倒扣积分。推荐基于对手历史出招习惯（单人样本≥5 才生效，否则用全局），关闭则随机出招。</div>
      <div class="fp-row"><label for="s-minPrincipal">最低本金阈值（积分）</label><input type="number" id="s-minPrincipal" min="0" value="${Number(settings.minPrincipal) || 0}"></div>
      <div class="fp-row"><label for="s-rpsMaxPrincipal">猜拳红包金额上限（0=不限）</label><input type="number" id="s-rpsMaxPrincipal" min="0" value="${Number(settings.rpsMaxPrincipal) || 0}"></div>
      <div class="fp-hint">⚠️ 猜拳输了可能倒扣积分，金额超过上限的猜拳包直接跳过。</div>
      <div class="fp-row"><label for="s-blacklist">发送者黑名单（逗号分隔）</label><input type="text" id="s-blacklist" placeholder="user1, user2" value="${escapeAttr(settings.blacklist)}"></div>
      <div class="fp-row"><label for="s-randomDelayMin">随机延迟下限（ms）</label><input type="number" id="s-randomDelayMin" min="0" max="10000" value="${Number(settings.randomDelayMin) || 0}"></div>
      <div class="fp-row"><label for="s-randomDelayMax">随机延迟上限（ms）</label><input type="number" id="s-randomDelayMax" min="0" max="10000" value="${Number(settings.randomDelayMax) || 0}"></div>
      <div class="fp-hint">红包出现后在下限~上限之间随机等待才出手（默认 800~3000ms），让其他人有机会，也可以降低风控风险。</div>
      <div class="fp-row"><label for="s-minClaimInterval">领取最小间隔（ms）</label><input type="number" id="s-minClaimInterval" min="0" max="10000" value="${Number(settings.minClaimInterval) || 0}"></div>
      <div class="fp-row"><label for="s-dailyLimit">每日抢包上限（0=不限）</label><input type="number" id="s-dailyLimit" min="0" value="${Number(settings.dailyLimit) || 0}"></div>
      <div class="fp-row"><label for="s-manualStats">统计手动领取</label><input type="checkbox" id="s-manualStats" ${settings.manualStats ? 'checked' : ''}></div>
      <div class="fp-hint">开启后，你手动点的红包也会记入统计（猜拳战绩一并更新）；只统计脚本在后台运行时抢到的。</div>
      <div class="fp-row"><label for="s-replyEnabled">抢到后自动回复</label><input type="checkbox" id="s-replyEnabled" ${settings.replyEnabled ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-replyText">回复内容</label><input type="text" id="s-replyText" style="width:150px" value="${escapeAttr(settings.replyText)}"></div>
      <div class="fp-hint">支持占位符 <code>{发送者}</code> <code>{金额}</code>。抢到 1.5~3s 后发送；10 秒内连抢只回一条；猜拳输了不回复。</div>
      <div class="fp-row"><label for="s-toast">页面内弹出提示</label><input type="checkbox" id="s-toast" ${settings.toast ? 'checked' : ''}></div>
      <div class="fp-row"><label for="s-gmNotify">浏览器通知（页面不可见时）</label><input type="checkbox" id="s-gmNotify" ${settings.gmNotify ? 'checked' : ''}></div>
      <div class="fp-hint">随机延迟 + 最小间隔不建议设为 0：既降低风控风险，也给其他玩家留机会。</div>
    `;
  }

  function saveFromForm() {
    const $ = (id) => document.getElementById(id);
    if (!$('s-enabled')) return;
    settings.enabled = $('s-enabled').checked;
    settings.skipSpecify = $('s-skipSpecify').checked;
    settings.skipOwn = $('s-skipOwn').checked;
    settings.allowHeartbeat = $('s-allowHeartbeat').checked;
    settings.autoGesture = $('s-autoGesture').checked;
    settings.smartGesture = $('s-smartGesture').checked;
    settings.minPrincipal = Math.max(0, Number($('s-minPrincipal').value) || 0);
    settings.rpsMaxPrincipal = Math.max(0, Number($('s-rpsMaxPrincipal').value) || 0);
    settings.blacklist = $('s-blacklist').value.trim();
    settings.randomDelayMin = Math.min(10000, Math.max(0, Number($('s-randomDelayMin').value) || 0));
    settings.randomDelayMax = Math.min(10000, Math.max(0, Number($('s-randomDelayMax').value) || 0));
    settings.minClaimInterval = Math.min(10000, Math.max(0, Number($('s-minClaimInterval').value) || 0));
    settings.dailyLimit = Math.max(0, Number($('s-dailyLimit').value) || 0);
    settings.manualStats = $('s-manualStats').checked;
    settings.replyEnabled = $('s-replyEnabled').checked;
    settings.replyText = $('s-replyText').value;
    settings.toast = $('s-toast').checked;
    settings.gmNotify = $('s-gmNotify').checked;
    saveSettings();
    toast('设置已保存', 'info');
    log('info', '设置已保存');
    renderToggleBtn();
    renderBadge();
  }

  function renderStats(body) {
    if (!body) {
      if (activeTab !== 'stats') return; // 不覆盖其他 Tab 的内容
      body = document.getElementById('fp-ar-body');
      if (!body) return;
    }
    const day = stats.byDay[todayKey()] || { count: 0, points: 0 };
    body.innerHTML = `
      <div class="fp-stats">
        <div class="fp-stat"><div class="v">${stats.points}</div><div class="k">累计抢到积分</div></div>
        <div class="fp-stat"><div class="v">${stats.total}</div><div class="k">累计抢到个数</div></div>
        <div class="fp-stat"><div class="v">${day.points}</div><div class="k">今日积分</div></div>
        <div class="fp-stat"><div class="v">${day.count}</div><div class="k">今日个数</div></div>
        <div class="fp-stat"><div class="v">${stats.skipped}</div><div class="k">跳过次数</div></div>
        <div class="fp-stat"><div class="v">${stats.failed}</div><div class="k">失败次数</div></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="fp-btn ghost" id="fp-ar-reset-stats">重置统计</button>
        <button class="fp-btn ghost" id="fp-ar-export">导出日志</button>
      </div>
    `;
    body.querySelector('#fp-ar-reset-stats').addEventListener('click', () => {
      if (!confirm('确定重置所有统计数据？（日志一并清空）')) return;
      stats = Object.assign({}, DEFAULT_STATS, { byDay: {}, log: [] });
      saveStats();
      renderStats();
      renderBadge();
      log('info', '统计已重置');
    });
    body.querySelector('#fp-ar-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fishpi-redpacket-log-${todayKey()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function renderRps(body) {
    if (!body) {
      if (activeTab !== 'rps') return; // 不覆盖其他 Tab 的内容
      body = document.getElementById('fp-ar-body');
      if (!body) return;
    }
    const mine = rps.mine;
    const g = rps.global;
    const gN = g[0] + g[1] + g[2];
    const gP = gN ? g.map((x) => pct(x / gN)) : ['33%', '33%', '33%'];
    const senders = Object.entries(rps.bySender)
      .filter(([, b]) => b && b.n > 0)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 5);
    const hint = lastRpsHint;
    const hintAge = hint ? Math.round((Date.now() - hint.time) / 1000) : 0;
    const hintSrc = !hint
      ? ''
      : hint.source === 'sender'
        ? `对手样本${hint.n}`
        : hint.source === 'global'
          ? `全局样本${hint.n}`
          : '无历史，等概率';

    body.innerHTML = `
      <div class="fp-stats">
        <div class="fp-stat"><div class="v">${mine.win}</div><div class="k">赢</div></div>
        <div class="fp-stat"><div class="v">${mine.tie}</div><div class="k">平</div></div>
        <div class="fp-stat"><div class="v">${mine.lose}</div><div class="k">负</div></div>
        <div class="fp-stat"><div class="v">${mine.points}</div><div class="k">猜拳盈亏积分</div></div>
      </div>
      <div class="fp-hint" style="margin-top:0">最近推荐：${
        hint
          ? `${escapeHtml(hint.sender)} → <b style="color:#ffb74d">推荐出${GESTURE_LABEL[hint.gesture]}</b>（${hintAge}s 前，${hintSrc}）`
          : '暂无（等待猜拳红包出现）'
      }</div>
      <div class="fp-hint">全局出招分布：${GESTURE_LABEL[0]}${gP[0]} / ${GESTURE_LABEL[1]}${gP[1]} / ${GESTURE_LABEL[2]}${gP[2]}（样本 ${gN}）</div>
      <div style="margin-top:4px;font-weight:bold">对手出招习惯 Top ${senders.length}</div>
      <div class="fp-log" style="margin-top:6px">
        ${
          senders.length
            ? senders
                .map(([name, b]) => {
                  const p = b.g.map((x) => pct(x / b.n));
                  return `<div class="e info"><b>${escapeHtml(name)}</b>（${b.n}次）：${GESTURE_LABEL[0]}${p[0]} / ${GESTURE_LABEL[1]}${p[1]} / ${GESTURE_LABEL[2]}${p[2]}</div>`;
                })
                .join('')
            : '<div class="e skip">暂无数据——每抢完一个猜拳包会自动记录对方出招</div>'
        }
      </div>
      <div class="fp-hint">说明：对方当前出招由服务端隐藏（抢完才揭晓），此处为基于历史习惯的概率预测，样本越多越准。</div>
      <div style="margin-top:8px"><button class="fp-btn ghost" id="fp-ar-reset-rps">重置猜拳数据</button></div>
    `;
    body.querySelector('#fp-ar-reset-rps').addEventListener('click', () => {
      if (!confirm('确定清空猜拳统计与推荐数据？')) return;
      rps = JSON.parse(JSON.stringify(DEFAULT_RPS));
      lastRpsHint = null;
      saveRps();
      renderRps();
      log('info', '猜拳数据已重置');
    });
  }

  function renderLog(body) {
    body = body || document.getElementById('fp-ar-body');
    if (!body || activeTab !== 'log') return;
    const entries = stats.log.slice().reverse();
    body.innerHTML =
      `<div class="fp-log" id="fp-ar-log">` +
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
    foot.innerHTML = `<button class="fp-btn ghost" id="fp-ar-clear-log">清空日志</button>`;
    body.appendChild(foot);
    foot.querySelector('#fp-ar-clear-log').addEventListener('click', () => {
      stats.log = [];
      saveStats();
      renderLog();
    });
  }

  function makeDraggable(el, handle) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - 80);
      const y = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 40);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /* ================================================================
   * 启动
   * ================================================================ */
  let sessionStarted = false;

  function ensureSession() {
    if (sessionStarted) return;
    if (!isChatPage()) return; // 非聊天室页面：不建 UI、不发任何网络请求
    sessionStarted = true;

    applyStyles();
    buildUI();
    log('info', `脚本已启动 v${SCRIPT_VER}`);

    // 启动错峰：UI → 间隔 → 账号信息 → 间隔 → 实时通道，避免连发触发频控
    (async () => {
      await sleep(300);
      try {
        await loadMe();
      } catch (e) {
        log('error', '获取账号信息失败：' + e.message);
        toast('获取账号信息失败：' + e.message, 'error');
      }
      await sleep(300);
      initRealtime();
    })();

    GM_registerMenuCommand('⏯ 自动抢红包：开/关', () => {
      settings.enabled = !settings.enabled;
      saveSettings();
      log('info', settings.enabled ? '已启用自动抢红包（菜单）' : '已停用自动抢红包（菜单）');
      renderToggleBtn();
      renderBadge();
    });
    GM_registerMenuCommand('🧧 打开抢红包面板', togglePanel);
    GM_registerMenuCommand('🔄 重连实时通道', () => {
      stopOwnWs();
      wsBackoff = 5000;
      supervise();
    });
  }

  /* SPA 路由监听：进出聊天室时启停实时通道（非聊天页零请求） */
  function syncPageState() {
    ensureSession();
    if (!sessionStarted) return;
    if (isChatPage()) initRealtime();
    else stopRealtime();
  }

  // document-start 立即安装 hook，抢在页面脚本创建 WebSocket 之前
  installWsHook();

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
