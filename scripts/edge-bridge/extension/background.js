// DSH Edge Bridge — MV3 service worker（本地回环 relay 版）。
// 与 Chrome 版 DSH Browser Bridge 相同协议，但只连接 http://127.0.0.1:8788，
// 以便 Edge 与 Chrome 两个浏览器可同时各自独立工作，不抢同一条命令队列。
// 只读边界：通过 chrome.debugger 执行 CDP（Runtime.evaluate / Page.navigate 等），
// 不读取 Cookie / 密码库 / 浏览历史数据库。发布、评论、关注、投流等外部操作需用户另行授权。

const RELAY = 'http://127.0.0.1:8788';
const POLL_WAIT_MS = 8000;
const CMD_TIMEOUT_MS = 25000;

const attachedTabs = new Set();
let loopGen = 0;
let lastTick = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms on ${label}`)), ms)
    ),
  ]);
}

function log(...args) {
  console.log('[edge-bridge]', new Date().toISOString(), ...args);
}

async function post(path, payload) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withTimeout(
        fetch(RELAY + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        }),
        10000,
        'post ' + path
      );
      return await res.json().catch(() => ({}));
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw lastErr;
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 15000, 'attach');
  attachedTabs.add(tabId);
  log('attached debugger to tab', tabId);
}

async function handle(cmd, p) {
  switch (cmd) {
    case 'ping':
      return { pong: true, at: Date.now(), ua: navigator.userAgent };

    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        active: t.active,
        title: t.title,
        url: t.url,
        status: t.status,
      }));
    }

    case 'targets':
      return await chrome.debugger.getTargets();

    case 'attach':
      await ensureAttached(p.tabId);
      return { attached: true, tabId: p.tabId };

    case 'detach':
      if (attachedTabs.has(p.tabId)) {
        await withTimeout(chrome.debugger.detach({ tabId: p.tabId }), 15000, 'detach');
        attachedTabs.delete(p.tabId);
      }
      return { detached: true, tabId: p.tabId };

    case 'send':
      await ensureAttached(p.tabId);
      return await withTimeout(
        chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params || {}),
        p.timeoutMs || CMD_TIMEOUT_MS,
        'cdp ' + p.method
      );

    case 'activate':
      return await chrome.tabs.update(p.tabId, { active: true });

    case 'newTab': {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: true });
      return { id: tab.id, windowId: tab.windowId };
    }

    case 'closeTab':
      await chrome.tabs.remove(p.tabId);
      attachedTabs.delete(p.tabId);
      return { closed: true };

    case 'screenshot': {
      const tab = await chrome.tabs.get(p.tabId);
      if (!tab.active) await chrome.tabs.update(p.tabId, { active: true });
      const dataUrl = await withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
        15000,
        'captureVisibleTab'
      );
      return { dataUrl };
    }

    case 'reloadSelf':
      setTimeout(() => chrome.runtime.reload(), 200);
      return { reloading: true };

    default:
      throw new Error('unknown command: ' + cmd);
  }
}

async function pollLoop(gen) {
  log('poll loop started, gen', gen);
  while (gen === loopGen) {
    lastTick = Date.now();
    let batch = [];
    try {
      const res = await withTimeout(
        fetch(`${RELAY}/poll?wait=${POLL_WAIT_MS}`, { cache: 'no-store' }),
        POLL_WAIT_MS + 10000,
        'poll'
      );
      if (!res.ok) throw new Error('poll http ' + res.status);
      batch = await res.json();
    } catch (err) {
      log('poll failed:', String((err && err.message) || err));
      await sleep(1500);
      continue;
    }
    lastTick = Date.now();
    if (!Array.isArray(batch) || batch.length === 0) continue;
    for (const item of batch) {
      if (gen !== loopGen) break;
      try {
        const result = await handle(item.cmd, item.params || {});
        await post('/result', { id: item.id, ok: true, result });
      } catch (err) {
        const msg = String((err && err.message) || err || 'unknown error');
        log('command failed:', item.cmd, msg);
        await post('/result', { id: item.id, ok: false, error: msg }).catch(() => {});
      }
    }
  }
  log('poll loop exited, gen', gen);
}

function ensureLoop() {
  loopGen += 1;
  lastTick = Date.now();
  pollLoop(loopGen).catch((err) => log('loop died:', String((err && err.message) || err)));
}

// Watchdog: 45s 没有轮询活动就替换掉卡死的循环。
setInterval(() => {
  if (Date.now() - lastTick > 45000) {
    log('watchdog restarting loop');
    ensureLoop();
  }
}, 15000);

function boot() {
  try {
    chrome.alarms.create('edge-bridge-keepalive', { periodInMinutes: 1 });
  } catch (err) {
    log('alarm create failed:', String((err && err.message) || err));
  }
  ensureLoop();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'edge-bridge-keepalive') {
    if (Date.now() - lastTick > 20000) ensureLoop();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

boot();
