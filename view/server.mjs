// 本地 HTTP 外壳与 API。只监听 127.0.0.1；所有写入都要一次性令牌与同源校验。
import http from 'node:http';
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {whatIf} from '../core/what-if.mjs';
import {loadProject, loadViewData} from './data.mjs';
import {assertStorage, createViewStore, MAX_BODY, ViewError} from './store.mjs';

const PUBLIC_DIR = defaultPath.join(defaultPath.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dom.js', ['dom.js', 'text/javascript; charset=utf-8']],
  ['/canvas-views.js', ['canvas-views.js', 'text/javascript; charset=utf-8']],
  ['/inspector.js', ['inspector.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
  + "form-action 'none'; object-src 'none'";
const IF_KEYS = ['方案', '排除', '分支', '停用角色组'];

function headers(extra = {}) {
  return {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, ...extra};
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const text = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, headers({'Content-Type': type, 'Content-Length': Buffer.byteLength(text)}));
  res.end(text);
}

function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = error instanceof Error ? error.message : '请求失败';
  if (res.headersSent) { res.destroy(); return; }
  send(res, status, {error: message});
}

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new ViewError('请求过大', 413);
  const chunks = [];
  let length = 0, oversized = false;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) oversized = true;
    else chunks.push(chunk);
  }
  if (oversized) throw new ViewError('请求过大', 413);
  return Buffer.concat(chunks).toString('utf8');
}

function assertObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ViewError('请求须为对象', 400);
  return input;
}

function ifOptions(input, worldbookName) {
  assertObject(input);
  const unknown = Object.keys(input).filter(key => !IF_KEYS.includes(key));
  if (unknown.length) throw new ViewError(`如果视图含未知字段：${unknown.join('、')}`, 400);
  const options = {世界书: worldbookName};
  if (input.方案 !== undefined && input.方案 !== null && input.方案 !== '') options.方案 = input.方案;
  for (const key of ['排除', '分支', '停用角色组']) if (input[key] !== undefined) options[key] = input[key];
  return options;
}

export async function startViewServer({worldbook, storage, port = 4317, host = '127.0.0.1',
  repoRoot = null, fs = defaultFs, path = defaultPath, now = () => Date.now(), check} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ViewError('端口须为 0 至 65535 的整数', 400);
  if (host !== '127.0.0.1') throw new ViewError('作者视图只监听 127.0.0.1', 400);
  const resolved = await assertStorage({worldbook, storage, repoRoot, fs, path});
  const store = createViewStore({worldbook: resolved.worldbook, storage: resolved.storage, fs, path, now, check});
  const token = randomUUID();
  const allowedHosts = new Set();
  const allowedOrigins = new Set();

  const handler = async (req, res) => {
    const hostHeader = req.headers.host;
    if (!hostHeader || !allowedHosts.has(hostHeader)) return send(res, 403, {error: '仅允许本地访问'});
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      return send(res, 403, {error: '请求来源不符'});
    let url;
    try { url = new URL(req.url, `http://${hostHeader}`); }
    catch { return send(res, 400, {error: '请求地址不合法'}); }

    if (req.method === 'GET') {
      const entry = STATIC.get(url.pathname);
      if (entry) {
        const [name, type] = entry;
        try { return send(res, 200, await fs.readFile(path.join(PUBLIC_DIR, name), 'utf8'), type); }
        catch (error) { return send(res, 500, {error: `无法读取页面资源：${error.message}`}); }
      }
      if (url.pathname === '/api/data') {
        const [data, review] = await Promise.all([
          loadViewData(resolved.worldbook, {fs, path}),
          store.readState(),
        ]);
        return send(res, 200, {...data, token, review,
          服务: {地址: `http://${hostHeader}`, 端口: server.address().port,
            存储: resolved.storage, 世界书: resolved.worldbook}});
      }
      return send(res, 404, {error: '没有此资源'});
    }

    if (req.method !== 'POST') return send(res, 405, {error: '不支持的方法'});
    if (req.headers['x-review-token'] !== token)
      return send(res, 403, {error: '写入需来自本地审阅页面'});
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return send(res, 403, {error: '写入需来自本地审阅页面'});
    const body = await readBody(req);
    let input;
    try { input = assertObject(JSON.parse(body)); }
    catch (error) {
      if (error instanceof ViewError) throw error;
      return send(res, 400, {error: 'JSON 格式不正确'});
    }
    if (url.pathname === '/api/preview') return send(res, 200, await store.preview(input));
    if (url.pathname === '/api/save') return send(res, 200, await store.save(input));
    if (url.pathname === '/api/review') return send(res, 200, await store.saveState(input));
    if (url.pathname === '/api/if') {
      const project = await loadProject(resolved.worldbook, {fs, path});
      const options = ifOptions(input, path.basename(resolved.worldbook));
      const result = whatIf(project.catalog, project.decl, {...options, issues: project.issues});
      return send(res, 200, result);
    }
    return send(res, 404, {error: '没有此操作'});
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => sendError(res, error));
  });
  server.requestTimeout = 90_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    const fail = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(port, host);
  });
  const actual = server.address().port;
  const url = `http://${host}:${actual}`;
  allowedHosts.add(`127.0.0.1:${actual}`);
  allowedHosts.add(`localhost:${actual}`);
  allowedOrigins.add(`http://127.0.0.1:${actual}`);
  allowedOrigins.add(`http://localhost:${actual}`);

  return {
    server, store, token, url, port: actual, host,
    worldbook: resolved.worldbook, storage: resolved.storage,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}
