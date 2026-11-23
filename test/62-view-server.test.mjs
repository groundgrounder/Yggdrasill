import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {assert, test, fs, path, project, fixture} from './helpers.mjs';
import {startViewServer} from '../view/server.mjs';
import {digest, PREVIEW_TTL} from '../view/store.mjs';
import {parseViewArgs} from '../cli/view.mjs';
import {loadViewData} from '../view/data.mjs';

async function start(t, options = {}) {
  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '审阅');
  const app = await startViewServer({worldbook: root, storage, port: 0, repoRoot: project, ...options});
  t.after(() => app.close());
  const data = await (await fetch(`${app.url}/api/data`)).json();
  return {root, storage, app, data};
}

async function post(app, route, body, headers = {}) {
  return fetch(`${app.url}${route}`, {method: 'POST', headers: {'Content-Type': 'application/json',
    'X-Review-Token': app.token, ...headers}, body: JSON.stringify(body)});
}

function request(app, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port: app.port, ...options}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end();
  });
}

async function spawnView(args, cwd = project) {
  const child = spawn(process.execPath, [path.join(project, 'cli/ygg.mjs'), 'view', ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {child, stdout: () => stdout, stderr: () => stderr};
}

async function waitForUrl(spawned) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`命令行未输出 URL：${spawned.stderr()}`)), 15_000);
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(spawned.stdout());
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    spawned.child.stdout.on('data', check);
    spawned.child.once('exit', code => {
      if (code !== null && !/http:\/\/127\.0\.0\.1:\d+/u.test(spawned.stdout())) {
        clearTimeout(timer);
        reject(new Error(`命令行提前退出：${code} ${spawned.stderr()}`));
      }
    });
    check();
  });
}

test('视图-服务-1：页面、数据、CSP 与静态资源', async t => {
  const {app, data} = await start(t);
  assert.equal(data.元数据.计数.事件, 13);
  assert.equal(data.元数据.计数.角色组, 4);
  assert.equal(data.token, app.token);
  assert.equal(data.review.revision, digest(''));
  assert.equal(data.服务.地址, app.url);
  const html = await (await fetch(app.url)).text();
  assert(html.includes('世界树'));
  assert(html.includes('/app.js'));
  assert(html.includes('相关角色'));
  const response = await fetch(app.url);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const asset of ['/app.js', '/style.css']) {
    const result = await fetch(app.url + asset);
    assert.equal(result.status, 200);
    assert((await result.text()).length > 1000);
  }
});

test('视图-服务-2：Host、Origin、令牌、类型、大小、路径与方法负例', async t => {
  const {app, data} = await start(t);
  assert.equal((await fetch(`${app.url}/api/data`, {headers: {Origin: 'http://evil.test'}})).status, 403);
  assert.equal((await fetch(`${app.url}/api/data`, {headers: {Origin: 'null'}})).status, 403);
  assert.equal((await fetch(`${app.url}/api/review`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  assert.equal((await post(app, '/api/review', {}, {'X-Review-Token': 'wrong'})).status, 403);
  assert.equal((await fetch(`${app.url}/api/review`, {method: 'POST', headers: {'Content-Type': 'text/plain', 'X-Review-Token': app.token}, body: '{}'})).status, 403);
  const oversized = await post(app, '/api/preview', {eventID: '拜师', raw: 'x'.repeat(2_600_000), revision: 'x'});
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(`${app.url}/../view/server.mjs`)).status, 404);
  assert.equal((await fetch(`${app.url}/%2e%2e/view/server.mjs`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/data`, {method: 'PUT'})).status, 405);
  const badHost = await request(app, {path: '/api/data', headers: {Host: 'evil.test'}});
  assert.equal(badHost.status, 403);
  assert.equal(data.token.length > 10, true);
});

test('视图-服务-3：如果视图与直接 whatIf 使用同一结果', async t => {
  const {root, app} = await start(t);
  const data = await loadViewData(root);
  const {whatIf} = await import('../core/what-if.mjs');
  const {loadProject} = await import('../view/data.mjs');
  const projectData = await loadProject(root);
  const expected = whatIf(projectData.catalog, projectData.decl, {方案: '码头少年', issues: projectData.issues});
  const response = await post(app, '/api/if', {方案: '码头少年'});
  assert.equal(response.status, 200);
  const actual = await response.json();
  assert.deepEqual(actual.没发生, expected.没发生);
  assert.deepEqual(actual.分支不同, expected.分支不同);
  assert.deepEqual(actual.异常, expected.异常);
  assert.equal(data.开局.方案.length, 2);
  const unknown = await post(app, '/api/if', {未知: true});
  assert.equal(unknown.status, 400);
  const missing = await post(app, '/api/if', {方案: '不存在的方案'});
  assert.equal(missing.status, 200);
  assert((await missing.json()).异常.some(item => item.规则 === 'if.方案不存在'));
});

test('视图-服务-4：HTTP 预览、保存、批注与并发 409', async t => {
  const {app} = await start(t);
  const data = await (await fetch(`${app.url}/api/data`)).json();
  const event = data.事件.find(item => item.事件ID === '拜师');
  const changed = event.原文.replace('让他到灯塔学习灯语。', '让他到灯塔学习灯语与潮汐。');
  const second = changed.replace('学习灯语与潮汐。', '学习灯语与潮汐，并记下潮位。');
  const first = await (await post(app, '/api/preview', {eventID: event.事件ID, raw: changed, revision: event.revision})).json();
  const other = await (await post(app, '/api/preview', {eventID: event.事件ID, raw: second, revision: event.revision})).json();
  assert(first.token && other.token);
  const [savedA, savedB] = await Promise.all([
    post(app, '/api/save', {token: first.token, raw: changed}),
    post(app, '/api/save', {token: other.token, raw: second}),
  ]);
  assert.deepEqual([savedA.status, savedB.status].sort(), [200, 409]);
  const current = await (await fetch(`${app.url}/api/data`)).json();
  const state = await (await post(app, '/api/review', {revision: current.review.revision,
    value: {notes: {'事件:拜师': {text: '来自 HTTP', status: '通过'}}, layout: {'事件:拜师': {x: 12, y: 34}}}})).json();
  assert(state.revision);
  const stale = await post(app, '/api/review', {revision: current.review.revision, value: {notes: {}, layout: {}}});
  assert.equal(stale.status, 409);
  const check = await (await fetch(`${app.url}/api/data`)).json();
  assert.equal(check.review.value.notes['事件:拜师'].text, '来自 HTTP');
});

test('视图-服务-5：过期的预览令牌经 HTTP 返回 409', async t => {
  let clock = 1_700_000_000_000;
  const {app} = await start(t, {now: () => clock});
  const data = await (await fetch(`${app.url}/api/data`)).json();
  const event = data.事件.find(item => item.事件ID === '拜师');
  const changed = event.原文.replace('让他到灯塔学习灯语。', '让他到灯塔学习灯语与潮汐。');
  const preview = await (await post(app, '/api/preview', {eventID: event.事件ID, raw: changed, revision: event.revision})).json();
  assert(preview.token);
  clock += PREVIEW_TTL + 1;
  const response = await post(app, '/api/save', {token: preview.token, raw: changed});
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /过期/);
});

test('视图-服务-6：命令行参数与真实进程启动', async t => {
  assert.deepEqual(parseViewArgs(['--worldbook', '世界书', '--port', '0']),
    {worldbook: '世界书', storage: null, port: 0, help: false});
  assert.throws(() => parseViewArgs([]), /缺少 --worldbook/);
  assert.throws(() => parseViewArgs(['--worldbook']), /缺少值/);
  assert.throws(() => parseViewArgs(['--worldbook', '世界书', '--port', '70000']), /65535/);
  assert.throws(() => parseViewArgs(['--worldbook', '世界书', '--wat']), /未知选项/);
  assert.equal(parseViewArgs(['--help']).help, true);

  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '命令行存储');
  const {child, stdout, stderr} = await spawnView(['--worldbook', root, '--storage', storage, '--port', '0']);
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  const url = await waitForUrl({child, stdout, stderr});
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${url}/api/data`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).元数据.计数.事件, 13);
  child.kill('SIGTERM');
  await once(child, 'exit');

  const help = await spawnView(['--help'], project);
  const [helpCode] = await once(help.child, 'exit');
  assert.equal(helpCode, 0);
  assert.match(help.stdout(), /用法：ygg view/);

  const missing = await spawnView([], project);
  const [missingCode] = await once(missing.child, 'exit');
  assert.equal(missingCode, 1);
  assert.match(missing.stderr(), /缺少 --worldbook/);

  const defaultStorage = await spawnView(['--worldbook', path.join(project, 'test/fixtures/雾港/世界书'), '--port', '0'], project);
  const [defaultCode] = await once(defaultStorage.child, 'exit');
  assert.equal(defaultCode, 1);
  assert.match(defaultStorage.stderr(), /实现仓库|世界书/);

  const defaultRoot = await fixture(t);
  const defaultProject = await spawnView(['--worldbook', defaultRoot, '--port', '0'], project);
  t.after(() => { if (!defaultProject.child.killed) defaultProject.child.kill('SIGTERM'); });
  const defaultUrl = await waitForUrl(defaultProject);
  assert.match(defaultProject.stdout(), /存储：.*作者资料\/审阅器/u);
  const defaultData = await fetch(`${defaultUrl}/api/data`);
  assert.equal(defaultData.status, 200);
  assert.equal((await defaultData.json()).元数据.计数.事件, 13);
  await assert.rejects(fs.access(path.join(path.dirname(defaultRoot), '作者资料', '审阅器')), {code: 'ENOENT'});
  defaultProject.child.kill('SIGTERM');
  await once(defaultProject.child, 'exit');
});
