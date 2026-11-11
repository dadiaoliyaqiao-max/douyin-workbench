import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ReportStore } from './report-store.mjs';
import { DashboardActions, assertOwner, safePath } from './actions.mjs';
import { getDispatchUi } from '../session-dispatch/ui-bridge.mjs';
import { CONTROLLER, WORKSPACE, sameDirectory } from '../session-dispatch/core-v3.mjs?v=0.3.0';

export const name = 'douyin-sidebar-dashboard';
export const inject = ['connection', 'webServer', 'agents', 'workingDirectory', 'tools'];
const METHODS = {
  clientReady: ['controllerSessionId'],
  listCards: ['controllerSessionId'],
  listReports: ['controllerSessionId', 'key'],
  getReport: ['controllerSessionId', 'reportId'],
  saveScript: ['controllerSessionId', 'reportId', 'baseRevision', 'content'],
  updateModule: ['controllerSessionId', 'key', 'actionId'],
  createScript: ['controllerSessionId', 'reportId', 'videoId', 'actionId', 'requirement'],
  deepDive: ['controllerSessionId', 'reportId', 'videoId', 'actionId'],
  getDeepDive: ['controllerSessionId', 'reportId', 'videoId'],
  adjustScript: ['controllerSessionId', 'reportId', 'actionId', 'requirement'],
};
export function validateArgs(method, args) {
  const keys = METHODS[method];
  if (!keys || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== keys.length || !keys.every(k => Object.hasOwn(args, k) && typeof args[k] === 'string')) {
    const error = new Error('请求参数不合法'); error.code = 'BAD_REQUEST'; throw error;
  }
  if (JSON.stringify(args).length > 1100000) { const e = new Error('请求太大'); e.code = 'TOO_LARGE'; throw e; }
}
export function makeHandler({ store, actions, contextCheck = async () => {}, onClientReady = async () => ({ ready: true }) }) {
  return async (method, args, signal, peer) => {
    try {
      validateArgs(method, args); assertOwner(peer, args.controllerSessionId);
      signal?.throwIfAborted(); await contextCheck();
      let value;
      switch (method) {
        case 'clientReady': value = await onClientReady(); break;
        case 'listCards': value = await actions.cards(peer, args.controllerSessionId, signal); break;
        case 'listReports': value = { reports: await store.listReports(args.key) }; break;
        case 'getReport': value = await store.getReport(args.reportId); break;
        case 'saveScript': value = await store.saveScript({ reportId: args.reportId, baseRevision: args.baseRevision, content: args.content }); break;
        case 'updateModule': value = await actions.update(peer, args, signal); break;
        case 'createScript': value = await actions.createScript(peer, args, signal); break;
        case 'deepDive': value = await actions.deepDive(peer, args, signal); break;
        case 'getDeepDive': value = await store.deepDive(args.reportId, args.videoId); break;
        case 'adjustScript': value = await actions.adjustScript(peer, args, signal); break;
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: typeof error.code === 'string' ? error.code : 'DASHBOARD_ERROR', message: String(error.message ?? error).slice(0, 1000), details: {} } };
    }
  };
}

const COVER_HEADERS = {
  'Cache-Control': 'private, max-age=300',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

/** Serve one cover only for ids the store can resolve to a validated workspace image. */
export function makeCoverHandler(store) {
  return async request => {
    const url = new URL(request.url);
    const found = await store.cover(url.searchParams.get('reportId'), url.searchParams.get('videoId'));
    if (!found) return new Response(request.method === 'HEAD' ? null : 'not found', { status: 404, headers: COVER_HEADERS });
    const headers = { ...COVER_HEADERS, 'Content-Type': found.type };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(found.size) } });
    try {
      const bytes = await readFile(found.absolute);
      return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } });
    } catch {
      return new Response('unavailable', { status: 404, headers: COVER_HEADERS });
    }
  };
}

/** Serve one report-relative image (homepage screenshot etc.) resolved by the store. */
export function makeAssetHandler(store) {
  return async request => {
    const url = new URL(request.url);
    const found = await store.asset(url.searchParams.get('reportId'), url.searchParams.get('path'));
    if (!found) return new Response(request.method === 'HEAD' ? null : 'not found', { status: 404, headers: COVER_HEADERS });
    const headers = { ...COVER_HEADERS, 'Content-Type': found.type };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(found.size) } });
    try {
      const bytes = await readFile(found.absolute);
      return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } });
    } catch {
      return new Response('unavailable', { status: 404, headers: COVER_HEADERS });
    }
  };
}

// Fixed-scope engineering inspection of this already-running GUI. No arbitrary
// JS, cookies, other tabs, Electron flags, server restart, or browser profile reads.
async function inspectExistingGui(action, root) {
  let electron;
  try { electron = createRequire(import.meta.url)('electron'); }
  catch (error) { throw new Error(`当前宿主未提供Electron页面检查：${String(error.message ?? error).slice(0,300)}；请在现用GUI刷新后人工验收`); }
  const pages = electron.webContents?.getAllWebContents().filter(w => {
    try { return new URL(w.getURL()).origin === 'http://127.0.0.1:22802'; } catch { return false; }
  }) ?? [];
  if (pages.length !== 1) throw new Error(`当前GUI匹配页面数量为${pages.length}，不自动选择或切换其他页面`);
  const page = pages[0];
  if (action === 'reload') {
    // Never discard user text in the visible composer/editor.
    const dirty = await page.executeJavaScript(`Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')).some(e => (e.value || e.textContent || '').trim().length > 0)`);
    if (dirty) throw new Error('页面有未提交文字，停止自动刷新；请用户保存后手动刷新');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { page.removeListener('did-finish-load', done); reject(new Error('GUI刷新超时')); }, 20000);
      const done = () => { clearTimeout(timeout); resolve(); };
      page.once('did-finish-load', done); page.reload();
    });
  }
  if (action === 'screenshot') {
    const dir = await safePath(root, 'control/ui-engineering/screenshots', { createDirectory: true });
    const filename = `dashboard-${randomUUID()}.png`;
    await writeFile(path.join(dir, filename), (await page.capturePage()).toPNG(), { flag: 'wx' });
    return { screenshot: path.relative(root, path.join(dir, filename)), pageId: page.id };
  }
  return page.executeJavaScript(`(() => { const plugin = document.querySelector('[data-plugin="workspace-sidebar-dashboard"]'); return { origin: location.origin, pathname: location.pathname, readyState: document.readyState, pluginPresent: !!plugin, pluginText: plugin?.innerText?.slice(0,5000) ?? null, labels: Array.from(document.querySelectorAll('button')).map(e=>e.innerText.trim()).filter(t=>['业务工作台','对标账号','参考视频','原创剧本','复盘','情报'].includes(t)) }; })()`);
}

export async function apply(ctx) {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  if (!sameDirectory(root, WORKSPACE)) throw new Error('Dashboard root differs from approved workspace');
  const diagnosticDir = path.join(root, 'control', 'sidebar-dashboard');
  await mkdir(diagnosticDir, { recursive: true });
  const diagnosticFile = path.join(diagnosticDir, `load-${process.pid}.json`);
  const loadNote = (stage, error) => writeFile(diagnosticFile, JSON.stringify({ version: '1.0.2', pid: process.pid, stage, at: new Date().toISOString(), ...(error ? { error: String(error.message ?? error).slice(0, 2000), stack: String(error.stack ?? '').slice(0, 4000) } : {}) }, null, 2) + '\n');
  await loadNote('apply-started');
  const contextCheck = async () => {
    const agent = ctx.agents.get(CONTROLLER);
    if (!agent || agent.id !== agent.session.id || !sameDirectory(await realpath(ctx.workingDirectory.get(agent.session)), root)) throw new Error('总管身份或工作区不匹配');
  };
  const store = new ReportStore({ root });
  const actions = new DashboardActions({ root, store, dispatch: getDispatchUi });
  const clientFile = path.join(diagnosticDir, `client-${process.pid}.json`);
  const handler = makeHandler({ store, actions, contextCheck, onClientReady: async () => {
    const ready = { ready: true, version: '1.0.1', pid: process.pid, at: new Date().toISOString(), controllerSessionId: CONTROLLER };
    await writeFile(clientFile, JSON.stringify(ready, null, 2) + '\n'); return ready;
  } });
  // Current 0.2.1-rc.5 exposes rpc.handle(), but its getter can lose the
  // consumer Fiber while closing over the route owner. Supplying this already
  // injected Fiber to the same native register() keeps its admit()/Origin/auth
  // gate and gives route disposal to this plugin lifecycle.
  try { ctx.connection.register(ctx, '/douyin-dashboard', handler); }
  catch (error) { await loadNote('rpc-registration-failed', error); throw error; }
  // Covers are served only for an authenticated owner browser and only when the
  // report store resolves the opaque ids back to a validated workspace path.
  try {
    ctx.connection.fetch.register({
      path: '/api/douyin-cover',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: makeCoverHandler(store),
    });
  } catch (error) { await loadNote('cover-route-failed', error); throw error; }
  try {
    ctx.connection.fetch.register({
      path: '/api/douyin-asset',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: makeAssetHandler(store),
    });
  } catch (error) { await loadNote('asset-route-failed', error); throw error; }
  await loadNote('rpc-registered');
  const dir = await safePath(root, 'control/sidebar-dashboard', { createDirectory: true });
  const hostFile = path.join(dir, `host-${process.pid}.json`);
  const loaded = { version: '1.0.0', pid: process.pid, loadedAt: new Date().toISOString(), controllerSessionId: CONTROLLER, root, channel: '/douyin-dashboard', state: 'loaded', authenticatedCarrier: 'connection.rpc' };
  await writeFile(hostFile, JSON.stringify(loaded, null, 2) + '\n');
  const registered = new WeakSet();
  function attach(agent) {
    if (agent.session?.id !== CONTROLLER || registered.has(agent)) return;
    registered.add(agent);
    ctx.effect(() => agent.ctx.tools.register({
      name: 'dashboard_ui_verify',
      description: 'Inspect or capture only the current existing dashboard GUI; reload refuses unsaved text. Engineering verification only, never dispatches business tasks.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'reload', 'screenshot'] } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: 30000, isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (exec.agent?.session?.id !== CONTROLLER || !['inspect','reload','screenshot'].includes(args.action) || Object.keys(args).length !== 1) throw new Error('Invalid GUI verification request');
        await contextCheck(); return JSON.stringify(await inspectExistingGui(args.action, root), null, 2);
      },
    }));
  }
  const current = ctx.agents.get(CONTROLLER); if (current) attach(current);
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.effect(() => async () => writeFile(hostFile, JSON.stringify({ ...loaded, state: 'disposed', disposedAt: new Date().toISOString() }, null, 2) + '\n'));
}
