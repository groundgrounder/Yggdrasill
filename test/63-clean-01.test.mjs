import {
  test, assert, fs, path, project, example, fixture, edit,
} from './helpers.mjs';
import {loadProtocol, S} from './protocol-helpers.mjs';
import {
  compileWorldbook, createCalendar, createProtocol, referenceExists, timelineEnd, WhatIfError,
  readDeclarations, validateDeclarations, loadWorldbook,
} from '../core/index.mjs';
import {runCli} from '../cli/ygg.mjs';
import {startViewServer} from '../view/server.mjs';

const eventFile = id => `历史/事件/${id}/事件.txt`;

async function cli(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {...options,
    stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}});
  return {code, stdout, stderr};
}

async function lineCount(file) {
  const text = await fs.readFile(path.join(project, file), 'utf8');
  return text.replace(/\n$/u, '').split('\n').length;
}

test('清理-01-A1：compileWorldbook 返回完整三段结果且缺注入显式报错', async () => {
  const {raw, issues: readIssues} = await readDeclarations(example, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(example, {fs, path, decl: compiled.decl});
  const actual = await compileWorldbook(example, {fs, path});
  assert.deepEqual(actual.readIssues, readIssues);
  assert.deepEqual(actual.loadIssues, loadIssues);
  assert.deepEqual(actual.compiled.issues, compiled.issues);
  assert.deepEqual(actual.issues, [...readIssues, ...compiled.issues, ...loadIssues]);
  assert.equal(actual.decl.calendar.前缀, '潮历');
  assert.equal(actual.catalog.events.length, 13);
  await assert.rejects(compileWorldbook(example), /注入/u);
  await assert.rejects(compileWorldbook(example, {fs}), /注入/u);
});

test('清理-01-A1：日历暴露 yearDays 与 formatDay，正反例与边界一致', () => {
  const calendar = createCalendar({前缀: '潮历', 年位数: 4, 月数: 4, 每月天数: [31, 28, 31, 30]});
  assert.equal(calendar.yearDays, 120);
  const cases = [[0, '潮历0000年01月01日'], [30, '潮历0000年01月31日'], [31, '潮历0000年02月01日'],
    [58, '潮历0000年02月28日'], [59, '潮历0000年03月01日'], [89, '潮历0000年03月31日'],
    [90, '潮历0000年04月01日'], [119, '潮历0000年04月30日'], [120, '潮历0001年01月01日'],
    [120 * 71 + 9, '潮历0071年01月10日']];
  for (const [day, text] of cases) {
    assert.equal(calendar.formatDay(day), text, String(day));
    assert.equal(calendar.time(text)?.[0], day, String(day));
  }
  for (let day = 0; day < 120 * 3; day++) assert.equal(calendar.time(calendar.formatDay(day))?.[0], day, String(day));
  for (const day of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 120 * 10000]) assert.equal(calendar.formatDay(day), null, String(day));
  const eleven = createCalendar({前缀: '潮历', 年位数: 11, 月数: 1, 每月天数: 1});
  assert.equal(eleven.formatDay(123), '潮历00000000123年01月01日');
  assert.equal(eleven.formatDay(10 ** 11), null);
});

test('清理-01-A1：timelineEnd 导出，空事件与非法时间抛出稳定错误码', async () => {
  const {catalog, decl} = await loadProtocol();
  assert.equal(timelineEnd(catalog, decl), '潮历074年');
  assert.throws(() => timelineEnd({...catalog, events: []}, decl),
    error => error instanceof WhatIfError && error.code === 'if.时间轴为空');
  const broken = structuredClone(catalog);
  broken.events[0].内容.触发时间.最晚 = '潮历坏';
  assert.throws(() => timelineEnd(broken, decl),
    error => error instanceof WhatIfError && error.code === 'if.时间轴'
      && error.message.includes(broken.events[0].id) && error.message.includes('潮历坏'));
});

test('清理-01-A1：referenceExists 支持玩家与重复条目口径', () => {
  const catalog = {groups: [{id: '甲'}], eventIds: ['事件甲'],
    entries: {装备: [{id: '工具'}, {id: '工具'}], 地点: [{id: '灯塔'}]}};
  assert.equal(referenceExists('玩家', '角色组', catalog), false);
  assert.equal(referenceExists('玩家', '角色组', catalog, {allowPlayer: true}), true);
  assert.equal(referenceExists('甲', '角色组', catalog), true);
  assert.equal(referenceExists('事件甲', '事件', catalog), true);
  assert.equal(referenceExists('工具', '装备', catalog), false);
  assert.equal(referenceExists('工具', '装备', catalog, {uniqueEntry: false}), true);
  assert.equal(referenceExists('灯塔', '地点', catalog), true);
});

test('清理-01-A2：protocol 与 app.js 行数上限，拆分文件存在', async () => {
  assert.ok(await lineCount('core/protocol.mjs') <= 550);
  assert.ok(await lineCount('view/public/app.js') <= 400);
  for (const file of ['core/protocol/changes.mjs', 'core/protocol/history.mjs']) await fs.access(path.join(project, file));
});

test('清理-01-A2：六个写命令每次只做一次封卷前置校验', async () => {
  const {catalog, decl} = await loadProtocol();
  const checks = [];
  const protocol = createProtocol({catalog, decl, onCheckState: (state, sealed) => { if (sealed) checks.push(sealed); }});
  const state = S(protocol, '071-02-05');
  const commands = [
    ['confirmPending', () => protocol.confirmPending(state)],
    ['confirmEvent', () => protocol.confirmEvent(state, {事件ID: '拜师', 分支ID: '拜师'})],
    ['confirmDynamicEvent', () => protocol.confirmDynamicEvent(state, {事件ID: '清理计数', 摘要: '计数', 变化: []})],
    ['confirmInitialization', () => protocol.confirmInitialization(state, '灯塔学徒')],
    ['writeScene', () => protocol.writeScene(state, {})],
    ['writePendingItem', () => protocol.writePendingItem(state, {操作: '移除', 字段路径: '角色.灯塔学徒.知识'})],
  ];
  for (const [name, action] of commands) {
    checks.length = 0;
    assert.doesNotThrow(action, name);
    assert.deepEqual(checks, [true], name);
  }
});

test('清理-01-A2：state 非法且 params 非法时仍先报 state 校验错误', async () => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '071-02-05');
  state.额外 = 1;
  const commands = [
    ['confirmPending', () => protocol.confirmPending(state)],
    ['confirmEvent', () => protocol.confirmEvent(state, {事件ID: 123})],
    ['confirmDynamicEvent', () => protocol.confirmDynamicEvent(state, {事件ID: 123})],
    ['confirmInitialization', () => protocol.confirmInitialization(state, 123)],
    ['writeScene', () => protocol.writeScene(state, {未知: 1})],
    ['writePendingItem', () => protocol.writePendingItem(state, {操作: '坏'})],
  ];
  for (const [name, action] of commands) {
    assert.throws(action, error => error?.name === 'ProtocolError' && error.code === '协议.参数'
      && error.message.includes('本局变量'), name);
  }
});

test('清理-01-A3：runCli 对 trace/if/preview/format/check 透传注入的 fs 与 path', async t => {
  const root = await fixture(t);
  const logical = '/虚拟世界';
  const map = value => {
    const resolved = path.resolve(String(value));
    const worldbook = `${logical}/世界书`, author = `${logical}/作者资料`;
    if (resolved === logical) return path.dirname(root);
    if (resolved === worldbook) return root;
    if (resolved.startsWith(`${worldbook}/`)) return path.join(root, resolved.slice(worldbook.length + 1));
    if (resolved === author) return path.join(path.dirname(root), '作者资料');
    if (resolved.startsWith(`${author}/`)) return path.join(path.dirname(root), '作者资料', resolved.slice(author.length + 1));
    throw Object.assign(new Error(`ENOENT: ${resolved}`), {code: 'ENOENT'});
  };
  const counts = {readFile: 0, readdir: 0, stat: 0, lstat: 0, access: 0};
  const virtualFs = {};
  for (const name of Object.keys(counts)) virtualFs[name] = (value, ...args) => {
    counts[name]++;
    return fs[name](map(value), ...args);
  };
  let pathCalls = 0;
  const injectedPath = new Proxy(path, {get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => { pathCalls++; return value(...args); };
  }});
  const environment = {cwd: logical, fs: virtualFs, path: injectedPath};
  const reset = () => {
    for (const name of Object.keys(counts)) counts[name] = 0;
    pathCalls = 0;
  };
  reset();
  const trace = await cli(['trace', '世界书', '事件:拜师', '--json'], environment);
  assert.equal(trace.code, 0, trace.stdout + trace.stderr);
  assert.equal(JSON.parse(trace.stdout).对象.对象键, '事件:拜师');
  assert.ok(pathCalls > 0 && counts.readFile > 0 && counts.readdir > 0);
  reset();
  const ifResult = await cli(['if', '世界书', '--json', '--方案', '码头少年'], environment);
  assert.equal(ifResult.code, 0, ifResult.stdout + ifResult.stderr);
  assert.equal(JSON.parse(ifResult.stdout).输入.时间轴末尾, '潮历074年');
  assert.ok(pathCalls > 0 && counts.readFile > 0 && counts.readdir > 0);
  reset();
  const preview = await cli(['preview', '世界书', '秦守', '--json'], environment);
  assert.equal(preview.code, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).开局, '潮历074年');
  assert.ok(pathCalls > 0 && counts.readFile > 0 && counts.readdir > 0);
  reset();
  const format = await cli(['format', '世界书', '--check', '--json'], environment);
  const formatValue = JSON.parse(format.stdout);
  assert.equal(formatValue.项目.目录, `${logical}/世界书`);
  assert.equal(formatValue.项目.异常, 0);
  assert.ok(pathCalls > 0 && counts.readFile > 0 && counts.readdir > 0);
  reset();
  const check = await cli(['check', '世界书', '--json', '--static-only'], environment);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(JSON.parse(check.stdout).errors.length, 0);
  assert.ok(pathCalls > 0 && counts.readFile > 0 && counts.readdir > 0);
  const view = await cli(['view', '--help'], environment);
  assert.equal(view.code, 0);
  assert.match(view.stdout, /用法：ygg view/u);
});

test('清理-01-A3：预览缺省时间轴错误、开局缺省与非法时间保持 预览.时间轴', async t => {
  const emptyRoot = await fixture(t);
  await fs.rm(path.join(emptyRoot, '历史', '事件'), {recursive: true, force: true});
  const axis = await cli(['preview', emptyRoot, '秦守', '--json']);
  assert.equal(axis.code, 1);
  assert.equal(JSON.parse(axis.stdout).异常[0].规则, '预览.时间轴');
  const opening = await cli(['preview', emptyRoot, '秦守', '--开局', '潮历074年', '--json']);
  assert.equal(opening.code, 0, opening.stdout + opening.stderr);
  assert.equal(JSON.parse(opening.stdout).开局, '潮历074年');

  const badRoot = await fixture(t);
  await edit(badRoot, eventFile('拜师'), event => { event.触发时间.最晚 = '潮历坏'; });
  const invalid = await cli(['preview', badRoot, '秦守', '--json']);
  assert.equal(invalid.code, 1);
  const invalidValue = JSON.parse(invalid.stdout);
  assert.equal(invalidValue.异常[0].规则, '预览.时间轴');
  assert.match(invalidValue.异常[0].说明, /拜师/u);
  assert.match(invalidValue.异常[0].说明, /潮历坏/u);
});

test('清理-01-A4：静态白名单返回四个脚本模块，穿越仍 404', async t => {
  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '审阅');
  const app = await startViewServer({worldbook: root, storage, port: 0, repoRoot: project});
  t.after(() => app.close());
  for (const asset of ['/app.js', '/dom.js', '/canvas-views.js', '/inspector.js']) {
    const response = await fetch(app.url + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), /^text\/javascript/u, asset);
    assert.ok((await response.text()).length > 1000, asset);
  }
  for (const target of ['/../view/server.mjs', '/%2e%2e/view/server.mjs', '/public/dom.js']) {
    assert.equal((await fetch(app.url + target)).status, 404, target);
  }
});

test('清理-01-A5：概述两个命令清单一致，docs 相对链接全部有效', async t => {
  const overview = await fs.readFile(path.join(project, 'docs/00-概述.md'), 'utf8');
  const lines = overview.split('\n');
  const first = lines.find(line => line.includes('命令行工具 `ygg`'));
  const second = lines.find(line => line.includes('作者工具已交付六个命令行子命令'));
  assert.ok(first && second);
  for (const command of ['check', 'trace', 'if', 'preview', 'view', 'format']) {
    assert.ok(first.includes(`\`${command}\``), command);
    assert.ok(second.includes(`\`${command}\``), command);
  }
  const broken = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = await fs.readFile(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        let target = match[1].trim();
        if (/^(https?:|mailto:|#)/u.test(target)) continue;
        target = target.replace(/^<|>$/gu, '').split('#')[0];
        if (!target) continue;
        try { await fs.access(path.resolve(path.dirname(file), target)); }
        catch { broken.push(`${path.relative(project, file)} -> ${target}`); }
      }
    }
  }
  await walk(path.join(project, 'docs'));
  assert.deepEqual(broken, []);
  t.diagnostic(`docs 链接检查完成：${broken.length} 条失效`);
});
