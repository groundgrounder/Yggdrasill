import {test, assert, fs, path, example, fixture} from './helpers.mjs';
import {runCli} from '../cli/ygg.mjs';
import {formatWorldbook} from '../core/format.mjs';
import {parse as parseWithOptions} from 'yaml';
import {parseYaml} from '../core/yaml.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import os from 'node:os';

const hash = value => createHash('sha256').update(value).digest('hex');
const readText = file => fs.readFile(file, 'utf8');
const readValue = async file => parseYaml(await readText(file));
const sortedKeys = value => Object.keys(value);

async function tempRoot(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-format-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return path.join(directory, '世界书');
}

async function put(root, name, text) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, text);
  return file;
}

async function cli(args) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}});
  return {code, stdout, stderr};
}

async function treeHashes(root) {
  const out = {};
  async function walk(directory, prefix) {
    for (const child of await fs.readdir(directory, {withFileTypes: true})) {
      if (child.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${child.name}` : child.name, file = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) await walk(file, relative);
      else if (child.isFile()) out[relative] = hash(await fs.readFile(file));
    }
  }
  await walk(root, '');
  return out;
}

async function temporaryFiles(root) {
  const found = [];
  async function walk(directory) {
    for (const child of await fs.readdir(directory, {withFileTypes: true})) {
      if (child.isDirectory()) await walk(path.join(directory, child.name));
      else if (child.name.includes('.ygg-format-')) found.push(path.join(directory, child.name));
    }
  }
  await walk(root);
  return found;
}

test('格式-1：契约键顺序、块式缩进、空集合与列表顺序', async t => {
  const root = await tempRoot(t);
  await put(root, '角色/甲/角色组.yaml', `档案:
  - 档案ID: 乙档案
    适用版本: [乙]
    默认: true
  - 档案ID: 甲档案
    适用版本: [甲]
    前置档案: 乙档案
    生效条件: {事件确认: {分支ID: 拜师, 事件ID: 拜师}}
自定义B: 二
版本:
  - 版本ID: 乙
    显示名: 乙
    别名: [阿乙]
  - 版本ID: 甲
    显示名: 甲
    别名: [阿甲]
显示名: 甲组
自定义A: 一
空列表: []
空映射: {}
`);
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), ['项目', '文件', '异常', '已写入']);
  assert.deepEqual(report.已写入.map(item => item.文件), ['角色/甲/角色组.yaml']);
  const value = await readValue(path.join(root, '角色/甲/角色组.yaml'));
  assert.deepEqual(sortedKeys(value), ['显示名', '版本', '档案', '空列表', '空映射', '自定义A', '自定义B']);
  assert.deepEqual(value.版本.map(item => item.版本ID), ['乙', '甲']);
  assert.deepEqual(value.档案.map(item => item.档案ID), ['乙档案', '甲档案']);
  assert.deepEqual(sortedKeys(value.版本[0]), ['版本ID', '显示名', '别名']);
  assert.deepEqual(sortedKeys(value.档案[0]), ['档案ID', '适用版本', '默认']);
  assert.deepEqual(sortedKeys(value.档案[1]), ['档案ID', '适用版本', '前置档案', '生效条件']);
  assert.deepEqual(sortedKeys(value.档案[1].生效条件.事件确认), ['事件ID', '分支ID']);
  const text = await readText(path.join(root, '角色/甲/角色组.yaml'));
  assert.match(text, /别名:\n      - 阿乙/u);
  assert.match(text, /^空列表: \[\]$/mu);
  assert.match(text, /^空映射: \{\}$/mu);
  assert.doesNotMatch(text, /\[阿乙\]/u);
});

test('格式-2：事件、档案正文、文本容器与特殊标量', async t => {
  const root = await tempRoot(t);
  await put(root, '历史/事件/甲/事件.txt', `分支:
  - 变化:
      - {值: 灯塔, 操作: 设定, 路径: 角色.甲.所在}
      - {值: 关系, 操作: 新增, 路径: 角色.甲.关系}
    分支结果: 结果
    分支条件: 条件
    分支ID: 分支一
    自定义: x
  - 分支ID: 分支二
    分支条件: 条件二
    分支结果: 结果二
默认分支: 分支一
触发时间: {最晚: 潮历071年01月02日, 最早: 潮历071年01月01日}
核心参与者: []
关联事件: []
事件ID: 甲
事件标题: 标题
事件概要: 概要
主类型: 关系
标签: [甲]
事件结果: [乙]
确认策略: 条件确认
自定义Z: z
自定义A: a
`);
  await put(root, '角色/甲/档案/甲/基本信息.txt', `能力特征:
  技能补充:
    - {个体限制: [限制], 技能ID: 技能, 个体表现: [表现]}
  特征: [特征]
惯用手: 右手。
出身: 出身。
种族: 人类。
出生年: 潮历058年。
性别: 男。
称号: [学徒]
姓名: 甲
`);
  await put(root, '世界概况/样.txt', `说明: |-
  第一行
  第二行
保留: |+
  带尾

编号: "0123"
真假: "true"
数字样式: "1.50"
长行: ${'很长的句子。'.repeat(30)}
`);
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const event = await readValue(path.join(root, '历史/事件/甲/事件.txt'));
  assert.deepEqual(sortedKeys(event), ['事件ID', '事件标题', '事件概要', '主类型', '标签', '事件结果', '触发时间', '确认策略', '核心参与者', '关联事件', '默认分支', '分支', '自定义A', '自定义Z']);
  assert.deepEqual(sortedKeys(event.触发时间), ['最早', '最晚']);
  assert.deepEqual(event.分支.map(item => item.分支ID), ['分支一', '分支二']);
  assert.deepEqual(sortedKeys(event.分支[0]), ['分支ID', '分支条件', '分支结果', '变化', '自定义']);
  assert.deepEqual(event.分支[0].变化.map(item => item.路径), ['角色.甲.所在', '角色.甲.关系']);
  assert.deepEqual(sortedKeys(event.分支[0].变化[0]), ['路径', '操作', '值']);
  const eventText = await readText(path.join(root, '历史/事件/甲/事件.txt'));
  assert.match(eventText, /^核心参与者: \[\]$/mu);
  assert.match(eventText, /^关联事件: \[\]$/mu);

  const basic = await readValue(path.join(root, '角色/甲/档案/甲/基本信息.txt'));
  assert.deepEqual(sortedKeys(basic), ['姓名', '称号', '性别', '出生年', '种族', '出身', '能力特征', '惯用手']);
  assert.deepEqual(sortedKeys(basic.能力特征), ['特征', '技能补充']);
  assert.deepEqual(sortedKeys(basic.能力特征.技能补充[0]), ['技能ID', '个体表现', '个体限制']);

  const container = await readValue(path.join(root, '世界概况/样.txt'));
  assert.equal(container.说明, '第一行\n第二行');
  assert.equal(container.保留, '带尾\n\n');
  assert.equal(container.编号, '0123');
  assert.equal(container.真假, 'true');
  assert.equal(container.数字样式, '1.50');
  assert.equal(container.长行, '很长的句子。'.repeat(30));
  const containerText = await readText(path.join(root, '世界概况/样.txt'));
  assert.match(containerText, /^说明: \|-$/mu);
  assert.match(containerText, /^保留: \|\+$/mu);
  assert.match(containerText, /^编号: "0123"$/mu);
  assert.match(containerText, /^真假: "true"$/mu);
  assert.match(containerText, /^数字样式: "1.50"$/mu);
  assert.equal(containerText.split('\n').find(line => line.startsWith('长行: ')).length, '长行: '.length + '很长的句子。'.repeat(30).length);
});

test('格式-3：注释、别名与合并关系保留', async t => {
  const root = await tempRoot(t);
  await put(root, '角色/甲/角色组.yaml', `# 文件头
档案: &档案
  - 档案ID: 甲档案
    默认: true
# 版本之前
版本:
  - 版本ID: 甲
    别名: [阿甲] # 别名行内
显示名: 甲组 # 显示名行内
副本: *档案
基础: &基础 {甲: 一}
合并:
  <<: *基础
  乙: 二
`);
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const text = await readText(path.join(root, '角色/甲/角色组.yaml'));
  for (const comment of ['# 文件头', '# 版本之前', '# 别名行内', '# 显示名行内']) {
    assert.equal(text.split(comment).length - 1, 1, comment);
  }
  assert.match(text, /^# 文件头\n\n/u);
  assert.ok(text.indexOf('&档案') < text.indexOf('*档案'));
  assert.ok(text.indexOf('&基础') < text.indexOf('*基础'));
  const value = await readValue(path.join(root, '角色/甲/角色组.yaml'));
  assert.equal(value.副本, value.档案);
  assert.deepEqual(parseYaml(text).合并, {'<<': {甲: '一'}, 乙: '二'});
  assert.deepEqual(parseWithOptions(text, {merge: true}).合并, {甲: '一', 乙: '二'});
});

test('格式-4：重复键、循环别名、坏语法与根节点错误不写文件', async t => {
  const root = await tempRoot(t);
  const files = {
    '角色/甲/角色组.yaml': '显示名: 甲\n显示名: 乙\n',
    '世界概况/循环.txt': '甲: &甲 {乙: *甲}\n',
    '历史/事件/甲/事件.txt': '事件ID: [坏语法\n',
    '角色/乙/档案/乙/基本信息.txt': '- 甲\n',
  };
  const before = {};
  for (const [name, text] of Object.entries(files)) {
    const file = await put(root, name, text);
    before[name] = hash(await fs.readFile(file));
  }
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.异常.length, 4);
  for (const entry of report.文件) {
    assert.equal(entry.状态, '解析失败');
    assert.equal(entry.新哈希, null);
    assert.ok(entry.解析异常);
  }
  for (const [name] of Object.entries(files)) {
    assert.equal(hash(await fs.readFile(path.join(root, name))), before[name], name);
  }
  assert.deepEqual(await temporaryFiles(root), []);
});

test('格式-5：CLI 检查、只写差异、二次幂等与 JSON 四区', async t => {
  const root = await fixture(t);
  const before = await treeHashes(root);
  const first = await cli(['format', root, '--json']);
  assert.equal(first.code, 1);
  const check = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(check), ['项目', '文件', '异常', '已写入']);
  assert.ok(check.项目.差异 > 0);
  assert.equal(check.项目.已写入, 0);
  assert.deepEqual(check.异常, []);
  assert.deepEqual(check.已写入, []);
  for (const entry of check.文件) {
    assert.deepEqual(Object.keys(entry).slice(0, 5), ['文件', '状态', '原哈希', '新哈希', '解析异常']);
    assert.match(entry.原哈希, /^[0-9a-f]{64}$/u);
    assert.match(entry.新哈希, /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(await treeHashes(root), before);
  const differences = check.文件.filter(entry => entry.状态 === '有差异').map(entry => entry.文件);
  const written = check.文件.filter(entry => entry.状态 === '无差异').map(entry => entry.文件);
  assert.ok(differences.length > 0);
  assert.ok(written.length > 0);

  const write = await cli(['format', root, '--write', '--json']);
  assert.equal(write.code, 0, write.stderr);
  const changed = JSON.parse(write.stdout);
  assert.deepEqual(changed.已写入.map(entry => entry.文件), differences);
  assert.equal(changed.项目.已写入, differences.length);
  assert.deepEqual(changed.异常, []);
  for (const entry of changed.文件) {
    if (differences.includes(entry.文件)) assert.equal(entry.状态, '已格式化');
    else assert.equal(entry.状态, '无差异');
  }
  const afterWrite = await treeHashes(root);
  for (const name of differences) assert.notEqual(afterWrite[name], before[name], name);
  for (const name of written) assert.equal(afterWrite[name], before[name], name);
  for (const item of changed.已写入) assert.equal(afterWrite[item.文件], item.新哈希);

  const second = await cli(['format', root, '--json']);
  assert.equal(second.code, 0, second.stderr);
  const clean = JSON.parse(second.stdout);
  assert.equal(clean.项目.差异, 0);
  assert.deepEqual(clean.异常, []);
  assert.deepEqual(clean.已写入, []);
  for (const entry of clean.文件) {
    assert.equal(entry.状态, '无差异');
    assert.equal(entry.原哈希, entry.新哈希);
    assert.equal(entry.原哈希, afterWrite[entry.文件]);
  }

  const again = await cli(['format', root, '--write', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).已写入, []);
  assert.deepEqual(await treeHashes(root), afterWrite);
  assert.deepEqual(await temporaryFiles(root), []);
});

test('格式-6：CLI 用法、非法路径与混用参数', async t => {
  const root = await fixture(t);
  const before = await treeHashes(root);
  const mixed = await cli(['format', root, '--check', '--write']);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /用法/u);
  assert.deepEqual(await treeHashes(root), before);
  assert.equal((await cli(['format'])).code, 1);
  assert.equal((await cli(['format', root, '--unknown'])).code, 1);
  const missing = await cli(['format', path.join(root, '不存在'), '--json']);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).异常.length, 1);
  const file = path.join(root, '世界概况/海况与雾季.txt');
  assert.equal((await cli(['format', file, '--json'])).code, 1);
  const link = path.join(path.dirname(root), '链接世界书');
  await fs.symlink(root, link);
  t.after(() => fs.unlink(link).catch(() => {}));
  assert.equal((await cli(['format', link, '--json'])).code, 1);
  const defaultCheck = await cli(['format', root]);
  assert.equal(defaultCheck.code, 1);
  assert.match(defaultCheck.stdout, /有差异/u);
  assert.deepEqual(await treeHashes(root), before);
  const checkFlag = await cli(['format', root, '--check', '--json']);
  assert.equal(checkFlag.code, 1);
  const writeFlag = await cli(['format', root, '--write']);
  assert.equal(writeFlag.code, 0, writeFlag.stderr);
  assert.match(writeFlag.stdout, /已写入/u);
});

test('格式-7：写入失败、权限保留与原子临时文件', async t => {
  const root = await fixture(t);
  const file = path.join(root, '角色/灯塔学徒/角色组.yaml');
  const original = await fs.readFile(file);
  const failingFs = {...fs, rename: async () => { throw new Error('模拟重命名失败'); }};
  const failed = await formatWorldbook(root, {write: true, fs: failingFs});
  assert.ok(failed.异常.length > 0);
  assert.ok(failed.文件.some(entry => entry.状态 === '写入失败'));
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await temporaryFiles(root), []);

  await fs.chmod(file, 0o640);
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.deepEqual(await temporaryFiles(root), []);
  assert.deepEqual(parseYaml(await readText(file)), parseYaml(original.toString('utf8')));

  if (process.getuid?.() !== 0) {
    const directory = path.join(root, '角色/灯塔学徒');
    await fs.writeFile(file, '档案: []\n显示名: 甲\n');
    await fs.chmod(directory, 0o555);
    try {
      const denied = await cli(['format', root, '--write', '--json']);
      assert.equal(denied.code, 1);
      assert.ok(JSON.parse(denied.stdout).异常.length > 0);
    } finally { await fs.chmod(directory, 0o755); }
    await fs.chmod(file, 0o000);
    try {
      const unreadable = await cli(['format', root, '--json']);
      assert.equal(unreadable.code, 1);
      assert.ok(JSON.parse(unreadable.stdout).文件.some(entry => entry.状态 === '读取失败'));
    } finally { await fs.chmod(file, 0o640); }
  }
});

test('格式-8：真实输入不变、符号链接不跟随', async t => {
  const realBefore = await treeHashes(example);
  const root = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-outside-'));
  t.after(() => fs.rm(outside, {recursive: true, force: true}));
  const outsideFile = await put(outside, '角色/外部/角色组.yaml', '显示名: 外部\n');
  const outsideHash = hash(await fs.readFile(outsideFile));
  await fs.symlink(outside, path.join(root, '角色/链接组'));
  await fs.symlink(outsideFile, path.join(root, '世界概况/链接.txt'));
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await treeHashes(example), realBefore);
  assert.equal(hash(await fs.readFile(outsideFile)), outsideHash);
  assert.ok((await fs.lstat(path.join(root, '角色/链接组'))).isSymbolicLink());
  assert.ok((await fs.lstat(path.join(root, '世界概况/链接.txt'))).isSymbolicLink());
});

test('格式-9：格式化前后检查结果不变，条目顺序按声明', async t => {
  const root = await fixture(t);
  const before = await checkWorldbook(root, {sampling: false});
  const result = await cli(['format', root, '--write', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const after = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(after.errors, before.errors);
  assert.deepEqual(after.hints, before.hints);

  const entryRoot = await tempRoot(t);
  await put(entryRoot, '设定/条目库.yaml', `技能:
  分法: 按种类
  分级: [门类]
  字段:
    来源: {取值: [习得, 天生]}
    门类: {取值: [灯语]}
    效果: {形态: 文本}
`);
  await put(entryRoot, '技能/灯语/灯语·短讯.txt', `效果: 效果。
自定义B: b
技能ID: 灯语·短讯
门类: 灯语
名称: 短讯
自定义A: a
来源: 习得
`);
  const entryResult = await cli(['format', entryRoot, '--write', '--json']);
  assert.equal(entryResult.code, 0, entryResult.stderr);
  const entry = await readValue(path.join(entryRoot, '技能/灯语/灯语·短讯.txt'));
  assert.deepEqual(sortedKeys(entry), ['技能ID', '名称', '来源', '门类', '效果', '自定义A', '自定义B']);
});

test('格式-10：全量真实世界书副本幂等、语义与检查不退化', async t => {
  const root = await fixture(t);
  const original = {};
  for (const name of Object.keys(await treeHashes(root))) original[name] = await readValue(path.join(root, name));
  const before = await checkWorldbook(root, {sampling: false});
  const first = await cli(['format', root, '--write', '--json']);
  assert.equal(first.code, 0, first.stderr);
  const second = await cli(['format', root, '--json']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).项目.差异, 0);
  for (const [name, value] of Object.entries(original)) {
    assert.ok(isDeepStrictEqual(value, await readValue(path.join(root, name))), name);
  }
  const after = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(after.errors, before.errors);
  assert.deepEqual(after.hints, before.hints);
});

test('ROUTE-F04-格式：分支专属文本按契约键序且二次往返幂等', async t => {
  const root = await tempRoot(t);
  const file = await put(root, '历史/事件/乙/事件.txt', `分支:
  - 变化: []
    隐秘信息: [分支隐秘。]
    公开信息: [分支公开。]
    影响范围: 分支影响。
    事件概要: 分支概要。
    分支结果: 结果
    分支条件: 条件
    分支ID: 分支一
默认分支: 分支一
核心参与者: []
确认策略: 条件确认
事件结果: [剧情条件变化]
触发时间: {最晚: 潮历001年01月02日, 最早: 潮历001年01月01日}
标签: [天灾]
主类型: 世界
事件概要: 顶层概要。
事件ID: 乙
`);
  const first = await cli(['format', root, '--write', '--json']);
  assert.equal(first.code, 0, first.stderr);
  const text = await readText(file), branchText = text.slice(text.indexOf('分支:'));
  const order = ['分支ID:', '分支条件:', '分支结果:', '事件概要:', '影响范围:', '公开信息:', '隐秘信息:', '变化:'];
  const positions = order.map(token => branchText.indexOf(token));
  assert.ok(positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])), text);
  assert.equal((await cli(['format', root, '--check', '--json'])).code, 0);
  assert.equal((await cli(['format', root, '--write', '--json'])).code, 0);
  assert.equal(await readText(file), text);
});
