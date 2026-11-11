// DSH Edge Bridge relay — 本机回环 relay，供 Edge 扩展长轮询。
// 与 Chrome 版 relay（127.0.0.1:8787，DSH 桌面后台任务托管）互不干扰：
// 本 relay 固定 127.0.0.1:8788，只服务本目录 extension/ 装载的 Edge 扩展。
// 仅本机访问，不做端口转发、不读取浏览器凭据。
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const HOST = '127.0.0.1';

/** 等待扩展领取的命令 */
const queue = [];
/** id -> {ok, result, error} */
const results = new Map();
let lastSeen = 0;
let polls = 0;
let served = 0;
const beacons = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(cmd, params) {
  const id = randomUUID();
  queue.push({ id, cmd, params: params || {} });
  return id;
}

async function waitResult(id, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = results.get(id);
    if (r) {
      results.delete(id);
      return r;
    }
    await sleep(80);
  }
  return { ok: false, error: 'timeout: Edge 扩展没有响应（检查扩展是否已加载、relay 是否在跑）' };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function readBody(req) {
  let b = '';
  for await (const chunk of req) b += chunk;
  if (!b) return {};
  try { return JSON.parse(b); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === '/status') {
      return json(res, 200, {
        connected: lastSeen > 0 && Date.now() - lastSeen < 40000,
        lastSeenAgoMs: lastSeen ? Date.now() - lastSeen : null,
        queued: queue.length,
        pollRequests: polls,
        commandsServed: served,
        beacons: beacons.slice(-30),
      });
    }

    if (url.pathname === '/beacon') {
      const message = url.searchParams.get('m') || '';
      beacons.push({ at: new Date().toISOString(), message });
      if (beacons.length > 500) beacons.shift();
      return json(res, 200, { ok: true, count: beacons.length });
    }

    if (url.pathname === '/poll') {
      polls++;
      lastSeen = Date.now();
      const wait = Math.min(Number(url.searchParams.get('wait') || 20000), 25000);
      const deadline = Date.now() + wait;
      while (queue.length === 0 && Date.now() < deadline) {
        await sleep(150);
      }
      lastSeen = Date.now();
      const batch = queue.splice(0, 20);
      served += batch.length;
      return json(res, 200, batch);
    }

    if (url.pathname === '/result' && req.method === 'POST') {
      const { id, ok, result, error } = await readBody(req);
      lastSeen = Date.now();
      if (id) results.set(id, { ok: !!ok, result, error });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      const { cmd, params, timeout } = await readBody(req);
      if (!cmd) return json(res, 400, { ok: false, error: 'missing cmd' });
      const id = enqueue(cmd, params);
      const r = await waitResult(id, Number(timeout) || 45000);
      return json(res, 200, { id, ...r });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return json(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[edge-bridge] listening on http://${HOST}:${PORT}`);
  console.log('[edge-bridge] Edge 扩展应从 /poll 领取命令；客户端向 /rpc 发命令');
});
