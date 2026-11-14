import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {test, assert, fs, path, example, project, fixture, edit, finding, assertIssues}
  from './helpers.mjs';
import {readDeclarations, validateDeclarations, loadWorldbook, whatIf} from '../core/index.mjs';
import {analyzeEventTree, chainStructure} from '../core/graph.mjs';
import {createProtocol} from '../core/protocol.mjs';

const execute = promisify(execFile);
const cli = path.join(project, 'cli/ygg.mjs');

async function real(args) {
  try {
    const result = await execute(process.execPath, [cli, ...args], {cwd: project, maxBuffer: 4 * 1024 * 1024});
    return {status: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    return {status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function runJson(args) {
  const result = await real([...args, '--json']);
  return {...result, value: result.stdout ? JSON.parse(result.stdout) : null};
}

function impact(result, id) {
  return result.影响面.find(item => item.事件ID === id);
}

async function inputHash() {
  const files = [];
  for (const root of [example, path.join(path.dirname(example), '作者资料')]) {
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files.push([file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
      }
    }
    await walk(root);
  }
  files.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return createHash('sha256').update(files.map(([file, hash]) => `${hash}  ${file}\n`).join('')).digest('hex');
}

test('如果-1：真实 CLI 五条入口成功，默认无差异且重复逐字一致', async () => {
  const commands = [
    ['--方案', '码头少年'], ['--排除', '拜师'], ['--分支', '出师考核:未通过'],
    ['--停用角色组', '周岚'], [],
  ];
  const outputs = [];
  for (const options of commands) {
    const result = await runJson(['if', example, ...options]);
    assert.equal(result.status, 0, result.stderr);
    outputs.push(result);
  }
  assert.deepEqual(outputs[3].value.没发生, []);
  assert.deepEqual(outputs[3].value.新发生, []);
  assert.deepEqual(outputs[3].value.分支不同, []);
  assert.deepEqual(outputs[3].value.停住的事件串, []);
  const empty = outputs[4].value;
  assert.deepEqual(Object.keys(empty), ['输入', '没发生', '新发生', '分支不同', '停住的事件串', '影响面', '异常']);
  assert.equal(empty.输入.时间轴末尾, '潮历074年');
  for (const partition of ['没发生', '新发生', '分支不同', '停住的事件串']) assert.deepEqual(empty[partition], []);
  assert.deepEqual(empty.异常, []);

  const repeated = await runJson(['if', example]);
  assert.equal(repeated.status, 0);
  assert.equal(repeated.stdout, outputs[4].stdout);
  const human = await real(['if', example]);
  assert.equal(human.status, 0);
  for (const heading of ['输入', '没发生', '新发生', '分支不同', '停住的事件串', '影响面', '异常'])
    assert.match(human.stdout, new RegExp(heading, 'u'));
});

test('如果-2：方案差异使用真实事件与分支', async () => {
  const result = await runJson(['if', example, '--方案', '码头少年']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.value.没发生, ['出师考核', '夜间值守', '正式守灯']);
  assert.deepEqual(result.value.新发生, []);
  assert.deepEqual(result.value.分支不同, [
    {事件ID: '学徒守灯', 默认分支: '重燃灯塔', if分支: '在镇上听闻'},
    {事件ID: '拜师', 默认分支: '拜师', if分支: '未拜师'},
  ]);
  assert.deepEqual(result.value.停住的事件串, []);
  assert.equal(result.value.输入.方案, '码头少年');
  assert.equal(result.value.输入.时间轴末尾, '潮历074年');

  const excluded = await runJson(['if', example, '--排除', '拜师']);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.deepEqual(excluded.value.没发生, ['出师考核', '夜间值守', '拜师', '正式守灯']);
  assert.deepEqual(excluded.value.分支不同, [{事件ID: '学徒守灯', 默认分支: '重燃灯塔', if分支: '在镇上听闻'}]);
});

test('如果-3：指定分支、补考路径与新发生事件', async () => {
  const result = await runJson(['if', example, '--分支', '出师考核:未通过']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.value.没发生, []);
  assert.deepEqual(result.value.新发生, ['补考']);
  assert.deepEqual(result.value.分支不同, [{事件ID: '出师考核', 默认分支: '通过', if分支: '未通过'}]);
  assert.deepEqual(result.value.停住的事件串, []);
  assert.deepEqual(result.value.输入.分支, [{事件ID: '出师考核', 分支ID: '未通过'}]);
});

test('如果-4：停住事件串由协议状态推出，汇合路径不误报', async () => {
  const stopped = await runJson(['if', example, '--排除', '出师考核']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(stopped.value.停住的事件串, ['学徒修习']);
  assert.deepEqual(stopped.value.没发生, ['出师考核', '正式守灯']);

  const merged = await runJson(['if', example, '--排除', '补考']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.deepEqual(merged.value.没发生, []);
  assert.deepEqual(merged.value.新发生, []);
  assert.deepEqual(merged.value.分支不同, []);
  assert.deepEqual(merged.value.停住的事件串, []);
});

test('如果-4b：停住与进行中仍可达结局分别判定', async () => {
  const {raw} = await readDeclarations(example, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(example, {fs, path, decl});
  const chain = catalog.chains.find(item => item.id === '学徒修习');
  chain.内容.结局 = [{事件ID: '补考'}];

  const protocol = createProtocol({catalog, decl});
  const state = protocol.seal({开局时间: '潮历074年'});
  assert.equal(protocol.chainStatus(state, '学徒修习'), '进行中');
  assert.notEqual(state.事件?.补考?.状态, 1);
  const structure = chainStructure(catalog, chain, analyzeEventTree(catalog, decl));
  assert.deepEqual(structure.结局可达, [{事件ID: '补考'}]);

  const result = whatIf(catalog, decl, {世界书: example});
  assert.deepEqual(result.没发生, []);
  assert.deepEqual(result.新发生, []);
  assert.deepEqual(result.分支不同, []);
  assert.deepEqual(result.停住的事件串, []);
  assert.deepEqual(result.异常, []);

  chain.内容.结局 = [{事件ID: '正式守灯'}];
  const stoppedProtocol = createProtocol({catalog, decl});
  const stoppedState = stoppedProtocol.seal({
    开局时间: '潮历074年', 历史选择: {出师考核: '未发生'},
  });
  assert.equal(stoppedProtocol.chainStatus(stoppedState, '学徒修习'), '进行中');
  assert.notEqual(stoppedState.事件?.正式守灯?.状态, 1);
  const stopped = whatIf(catalog, decl, {世界书: example, 排除: ['出师考核']});
  assert.deepEqual(stopped.停住的事件串, ['学徒修习']);
  assert.deepEqual(stopped.异常, []);
});

test('如果-5：影响面复用 impactOf，引用位置来自统一索引', async () => {
  const result = await runJson(['if', example]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(impact(result.value, '拜师').下游,
    ['出师考核', '夜间值守', '学修船', '正式守灯', '补考']);
  assert.deepEqual(impact(result.value, '大雾之夜').下游, ['学徒守灯', '港务署问责', '白棠在码头']);
  assert.deepEqual(impact(result.value, '补考').下游, []);
  assert.ok(impact(result.value, '拜师').引用位置.some(item => item.来源事件ID === '夜间值守'
    && item.目标事件ID === '拜师' && item.字段 === '门槛'));
});

test('如果-6：方案与自定义覆盖叠加，同项覆盖方案', async () => {
  const result = await runJson(['if', example, '--方案', '码头少年', '--分支', '拜师:拜师']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.输入.方案, '码头少年');
  assert.deepEqual(result.value.输入.分支, [{事件ID: '拜师', 分支ID: '拜师'}]);
  assert.deepEqual(result.value.没发生, []);
  assert.deepEqual(result.value.新发生, []);
  assert.deepEqual(result.value.分支不同, []);
  assert.deepEqual(result.value.停住的事件串, []);
});

test('如果-7：停用真实角色只影响依赖它的内容', async t => {
  const root = await fixture(t);
  await edit(root, '角色/周岚/角色组.yaml', group => { group.默认启用 = true; });
  const baseline = await runJson(['if', root]);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.deepEqual(baseline.value.没发生, []);
  const disabled = await runJson(['if', root, '--停用角色组', '周岚']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(disabled.value.没发生, ['港务署问责']);
  assert.deepEqual(disabled.value.新发生, []);
  assert.deepEqual(disabled.value.分支不同, []);
  assert.deepEqual(disabled.value.停住的事件串, []);
});

test('如果-8：未知对象、参数冲突、非法参数与封卷冲突均非零', async t => {
  const cases = [
    [['--方案', '不存在'], 'if.方案不存在'],
    [['--排除', '不存在'], 'if.事件不存在'],
    [['--分支', '出师考核:不存在'], 'if.分支不存在'],
    [['--停用角色组', '不存在'], 'if.角色组不存在'],
    [['--排除', '拜师', '--分支', '拜师:拜师'], 'if.参数冲突'],
    [['--分支', '出师考核:通过', '--分支', '出师考核:未通过'], 'if.参数冲突'],
    [['--未知'], 'if.参数'],
    [['--分支', '出师考核'], 'if.参数'],
    [['--排除'], 'if.参数'],
    [['多余'], 'if.参数'],
    [['--方案', '码头少年', '--方案', '补考之年'], 'if.参数'],
  ];
  for (const [options, code] of cases) {
    const result = await runJson(['if', example, ...options]);
    assert.equal(result.status, 1, `${options.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.ok(result.value.异常.some(item => item.规则 === code), `${options.join(' ')}：${JSON.stringify(result.value.异常)}`);
  }

  const root = await fixture(t);
  await edit(root, '角色/周岚/角色组.yaml', group => { group.默认启用 = true; });
  await edit(root, '历史/事件/白棠在码头/事件.txt', event => {
    event.门槛 = {all: [{事件确认: {事件ID: '大雾之夜'}}, {none: [{事件确认: {事件ID: '港务署问责'}}]}]};
  });
  const conflict = await runJson(['if', root]);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.value.异常[0].规则, '封卷.配置冲突');
});

test('如果-9：核心与 CLI 只读、确定且不改输入', async () => {
  const before = await inputHash();
  const first = await runJson(['if', example, '--方案', '码头少年']);
  const second = await runJson(['if', example, '--方案', '码头少年']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(await inputHash(), before);

  const {raw} = await readDeclarations(example, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(example, {fs, path, decl});
  const catalogBefore = structuredClone(catalog), declBefore = structuredClone(decl);
  const direct = whatIf(catalog, decl, {世界书: example, 方案: '码头少年'});
  assert.deepEqual(catalog, catalogBefore);
  assert.deepEqual(decl, declBefore);
  assert.deepEqual(direct, whatIf(catalog, decl, {世界书: example, 方案: '码头少年'}));
});

test('如果-10：畸形分支在封卷时报告 if.计算失败', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/接手商会账目/事件.txt', event => { event.分支 = [null]; });
  const result = await runJson(['if', root]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(Object.keys(result.value),
    ['输入', '没发生', '新发生', '分支不同', '停住的事件串', '影响面', '异常']);
  assertIssues(result.value.异常, [finding('if.计算失败', 'if', {说明: ['门槛']})], '如果-10');
  for (const partition of ['没发生', '新发生', '分支不同', '停住的事件串', '影响面'])
    assert.deepEqual(result.value[partition], [], partition);
});
