import os from 'node:os';
import {runContext, parseArgs} from '../cli/context.mjs';
import {previewContext, ContextError} from '../core/context-preview.mjs';
import {compileWorldbook, createProtocol, seal, writeScene, createRouter, route, renderContext,
  DEFAULT_TAGS, readSettings} from '../core/index.mjs';
import {loadProtocol, S, W} from './protocol-helpers.mjs';
import {test, assert, fs, path, project, example, fixture, edit} from './helpers.mjs';
async function run(args, options = {}) {
  const cliArgs = args[0] === 'context' ? args.slice(1) : args;
  let stdout = '', stderr = '';
  const status = await runContext(cliArgs, {cwd: project,
    stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}, ...options});
  return {status, stdout, stderr, value: stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : null};
}

async function sealedStateFile(t, value) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-context-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const file = path.join(temporary, '本局.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

test('上下文-1：封卷、方案、场景与在场均按契约输出', async () => {
  const plain = await run(['context', 'test/fixtures/雾港/世界书', '--json']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(Object.keys(plain.value), ['输入', '汇总', '预算', '审计', '正文', '异常']);
  assert.deepEqual(plain.value.异常, []);
  assert.equal(plain.value.输入.开局, '潮历074年');
  assert.equal(plain.value.输入.方案, null);
  assert.equal(plain.value.输入.地点, null);
  assert.deepEqual(plain.value.输入.在场, []);
  assert.equal(plain.value.正文, null);
  assert.ok(plain.value.汇总.总字符 > 0);
  assert.ok(plain.value.汇总.分块字符.协议 > 0);

  const plan = await run(['context', 'test/fixtures/雾港/世界书', '--方案', '码头少年', '--json']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.value.输入.开局, '潮历072年');
  assert.equal(plan.value.输入.方案, '码头少年');

  const opening = await run(['context', 'test/fixtures/雾港/世界书', '--方案', '码头少年', '--开局', '潮历073年', '--json']);
  assert.equal(opening.value.输入.开局, '潮历073年');

  const scene = await run(['context', 'test/fixtures/雾港/世界书', '--地点', '灯塔', '--场景', '值守室',
    '--在场', '秦守', '--在场', '灯塔学徒', '--消息', '棠小姐托人来问，雾季的灯号会不会改。', '--json']);
  assert.equal(scene.status, 0, scene.stderr);
  assert.deepEqual(scene.value.输入.在场, ['灯塔学徒', '秦守']);
  assert.equal(scene.value.输入.地点, '灯塔');
  assert.equal(scene.value.输入.场景, '值守室');
  assert.equal(scene.value.输入.消息.length, 1);
  assert.ok(scene.value.汇总.分块字符.在场角色 > 0);
  for (const name of ['技能', '装备', '地点', '船只']) assert.ok(name in scene.value.预算.条目, name);

  const raw = await run(['context', 'test/fixtures/雾港/世界书', '--地点', '灯塔', '--场景', '值守室',
    '--在场', '秦守', '--在场', '灯塔学徒', '--raw']);
  assert.equal(raw.status, 0, raw.stderr);
  assert.ok(raw.stdout.startsWith('<协议>\n'), '--raw 直接输出渲染正文');
  assert.ok(raw.stdout.trimEnd().endsWith('</事件>'));
  const rawJson = await run(['context', 'test/fixtures/雾港/世界书', '--地点', '灯塔', '--场景', '值守室',
    '--在场', '秦守', '--在场', '灯塔学徒', '--raw', '--json']);
  assert.equal(rawJson.value.正文, raw.stdout);
});

test('上下文-2：总字符、分块与审计和 core/router 结果完全一致', async () => {
  const root = path.join(project, 'test/fixtures/雾港/世界书');
  const {catalog, decl} = await compileWorldbook(root, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const settings = await readSettings(path.dirname(root), {fs, path, decl});
  const templates = Object.fromEntries(await Promise.all(['变量更新规则', '角色通用约束', '扮演准则'].map(async name =>
    [name, await fs.readFile(path.join(project, 'templates', `${name}.txt`), 'utf8')])));
  const router = createRouter({catalog, decl, protocol, settings, templates});
  const messages = ['棠小姐托人来问，雾季的灯号会不会改。'];
  const state = writeScene(protocol, seal(protocol, {开局时间: '潮历074年'}),
    {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {灯塔学徒: true, 秦守: true}}).state;
  const {context, audit} = route(router, state, messages);
  const rendered = renderContext(context);
  const chunks = {};
  for (const key of Object.keys(DEFAULT_TAGS)) if (Object.hasOwn(context, key))
    chunks[key] = [...renderContext({[key]: context[key]})].length;

  const result = await previewContext(root, {fs, path, 开局: '潮历074年', 地点: '灯塔', 场景: '值守室',
    在场: ['秦守', '灯塔学徒'], 消息: messages, raw: true});
  assert.equal(result.正文, rendered);
  assert.deepEqual(result.预算.经历, {已用条数: audit.经历.选入.length, 条数上限: audit.经历.预算.条数,
    已用字符: audit.经历.字符, 字符上限: audit.经历.预算.字符});
  assert.deepEqual(result.预算.候选, {已用条数: audit.候选.选入.length, 条数上限: audit.候选.预算.条数,
    已用字符: audit.候选.字符, 字符上限: audit.候选.预算.字符});
  assert.deepEqual(result.预算.条目.技能, {已用字符: audit.条目.技能.字符, 预算上限: audit.条目.技能.预算});
  assert.deepEqual(result.审计.经历.略过, audit.经历.略过);
  assert.deepEqual(result.审计.条目.技能.选入, audit.条目.技能.选入);
  assert.deepEqual(result.审计.提及, audit.提及);
});

test('上下文-3：九类错误码与非法参数', async t => {
  const cases = [];
  const add = (label, args, code, fragment = null) => cases.push({label, args, code, fragment});

  add('本局与开局冲突', ['context', 'test/fixtures/雾港/世界书', '--本局', 'x.json', '--开局', '潮历074年'], '上下文.参数');
  add('仅场景无当前地点', ['context', 'test/fixtures/雾港/世界书', '--场景', '值守室'], '上下文.参数', '本局须已有当前地点');
  add('方案不存在', ['context', 'test/fixtures/雾港/世界书', '--方案', '不存在方案'], '上下文.方案');
  add('地点不存在', ['context', 'test/fixtures/雾港/世界书', '--地点', '不存在地标'], '上下文.地点', '地标不存在');
  add('角色组不存在', ['context', 'test/fixtures/雾港/世界书', '--在场', '不存在组'], '上下文.角色组', '角色组不存在');
  add('角色组未启用', ['context', 'test/fixtures/雾港/世界书', '--在场', '周岚'], '上下文.角色组', '角色组未启用');
  add('目录不存在', ['context', 'examples/不存在的目录'], '上下文.读取失败');

  const axisRoot = await fixture(t);
  await fs.rm(path.join(axisRoot, '历史', '事件'), {recursive: true});
  add('时间轴不可确定', ['context', axisRoot], '上下文.时间轴');

  const sealRoot = await fixture(t);
  await edit(sealRoot, '历史/事件/大雾之夜/事件.txt', event => {
    event.门槛 = {none: [{事件确认: {事件ID: '学徒守灯'}}]};
  });
  add('封卷排斥冲突', ['context', sealRoot], '上下文.封卷', '排斥');

  for (const {label, args, code, fragment} of cases) {
    const result = await run([...args, '--json']);
    assert.equal(result.status, 1, label);
    assert.equal(result.value.异常[0].规则, code, label);
    if (fragment) assert.ok(result.value.异常[0].说明.includes(fragment), label);
    assert.deepEqual(result.value.汇总, null, `${label} 失败时不输出汇总`);
  }

  const broken = await fixture(t);
  await edit(broken, '设定/纪年.yaml', value => { value.年位数 = '坏'; });
  const brokenResult = await run(['context', broken, '--json']);
  assert.equal(brokenResult.status, 1);
  assert.equal(brokenResult.value.异常[0].规则, '上下文.读取失败');

  const {protocol} = await loadProtocol();
  const badJson = await sealedStateFile(t, {oops: true});
  for (const [label, value] of [['不是合法 JSON', null], ['未封卷', {开局: {已封卷: false}}]]) {
    const file = await sealedStateFile(t, value ?? {});
    if (label === '不是合法 JSON') await fs.writeFile(file, '{oops');
    const result = await run(['context', 'test/fixtures/雾港/世界书', '--本局', file, '--json']);
    assert.equal(result.status, 1, label);
    assert.equal(result.value.异常[0].规则, '上下文.本局', label);
  }
  const absent = await run(['context', 'test/fixtures/雾港/世界书', '--本局', path.join(os.tmpdir(), '不存在本局.json'), '--json']);
  assert.equal(absent.status, 1);
  assert.equal(absent.value.异常[0].规则, '上下文.本局');
  void badJson; void protocol;
});

test('上下文-4：自动初始化与 --不自动初始化、本局文件', async t => {
  const early = ['context', 'test/fixtures/雾港/世界书', '--开局', '潮历071年01月01日', '--地点', '灯塔', '--在场', '灯塔学徒'];
  const auto = await run([...early, '--json']);
  assert.equal(auto.status, 0, auto.stderr);
  assert.deepEqual(auto.value.输入.模拟初始化, ['灯塔学徒']);
  assert.ok(auto.value.汇总.分块字符.在场角色 > 0, '预初始化后在场角色可渲染');

  const strict = await run([...early, '--不自动初始化', '--json']);
  assert.equal(strict.status, 1);
  assert.equal(strict.value.异常[0].规则, '上下文.场景');
  assert.ok(strict.value.异常[0].说明.includes('角色组须先确认初始化'), strict.value.异常[0].说明);

  const {protocol} = await loadProtocol();
  const state = W(protocol, S(protocol, '072'),
    {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {灯塔学徒: true, 秦守: true}}).state;
  const file = await sealedStateFile(t, state);
  const fromState = await run(['context', path.join(project, 'test/fixtures/雾港/世界书'), '--本局', file, '--json']);
  assert.equal(fromState.status, 0, fromState.stderr);
  assert.equal(fromState.value.输入.开局, '潮历072年');
  assert.deepEqual(fromState.value.输入.模拟初始化, []);
  assert.ok(fromState.value.汇总.分块字符.在场角色 > 0);
});

test('上下文-5：previewContext 注入、只读与模板不经虚拟 fs', async t => {
  const root = path.join(project, 'test/fixtures/雾港/世界书');
  const first = await previewContext(root, {fs, path, 开局: '潮历074年', 地点: '灯塔', 场景: '值守室',
    在场: ['灯塔学徒', '秦守'], 消息: ['灯号会不会改。']});
  const second = await previewContext(root, {fs, path, 开局: '潮历074年', 地点: '灯塔', 场景: '值守室',
    在场: ['灯塔学徒', '秦守'], 消息: ['灯号会不会改。']});
  assert.deepEqual(first, second);

  const guardFs = new Proxy(fs, {get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (first, ...rest) => {
      if (['writeFile', 'mkdir', 'rm', 'rename', 'unlink', 'rmdir'].includes(String(key)))
        throw new Error(`context 不得写入：${key}`);
      if (String(key) === 'readFile' && String(first).includes('templates'))
        throw new Error('模板不得经注入 fs 读取');
      return value(first, ...rest);
    };
  }});
  const result = await previewContext(root, {fs: guardFs, path, 开局: '潮历074年',
    地点: '灯塔', 场景: '值守室', 在场: ['灯塔学徒', '秦守']});
  assert.ok(result.汇总.总字符 > 0);

  await assert.rejects(previewContext(root, {fs, path, 本局: 'a.json', 开局: '潮历074年'}),
    error => error instanceof ContextError && error.code === '上下文.参数');

  for (const args of [['--未知'], ['a', 'b'], ['--地点']]) {
    assert.throws(() => parseArgs([...args]), error => error?.code === '上下文.参数', JSON.stringify(args));
  }
  assert.throws(() => parseArgs(['a', '--开局', 'x', '--开局', 'y']), error => /只能给出一次/u.test(error.message));
  const parsed = parseArgs(['a', '--在场', '甲', '--在场', '乙', '--消息', '一句话', '--raw', '--json']);
  assert.deepEqual(parsed.在场, ['甲', '乙']);
  assert.equal(parsed.世界书, 'a');
  void t;
});

test('上下文-6：自建模式玩家在场边界', async () => {
  const scene = await run(['context', 'test/fixtures/雾港/世界书', '--地点', '灯塔',
    '--在场', '玩家', '--在场', '秦守', '--json']);
  assert.equal(scene.status, 0, scene.stderr);
  assert.deepEqual(scene.value.输入.在场, ['玩家', '秦守']);
  assert.equal(scene.value.输入.地点, '灯塔');
  assert.ok(scene.value.汇总.分块字符.在场角色 > 0, '玩家随当前地点自动在场可渲染');
  assert.ok(scene.value.汇总.分块字符.世界状态 > 0);

  const raw = await run(['context', 'test/fixtures/雾港/世界书', '--地点', '灯塔', '--在场', '玩家', '--raw']);
  assert.equal(raw.status, 0, raw.stderr);
  assert.ok(raw.stdout.includes('<在场角色>'));
  assert.ok(raw.stdout.includes('<世界状态>'));

  const missing = await run(['context', 'test/fixtures/雾港/世界书', '--在场', '玩家', '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.value.异常[0].规则, '上下文.场景');
  assert.ok(missing.value.异常[0].说明.includes('自建模式玩家在场须先指定 --地点 或本局已有当前地点'));
});
