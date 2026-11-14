import {test, assert, fs, path, fixture, edit, S, D, loadProtocol, loadRouting, R0, route,
  change, errorCode, ProtocolError, time, messages, eventFile} from './router-helpers.mjs';
import {formatWorldbook} from '../core/format.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {readDeclarations, validateDeclarations} from '../core/declarations.mjs';
import {applyCommands} from '../core/commands.mjs';
import {runCli} from '../cli/ygg.mjs';
import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const failWith = (code, fragment) => error => error instanceof ProtocolError && error.code === code
  && (fragment === undefined || error.message.includes(fragment));
const clone = value => structuredClone(value);
const chars = value => [...JSON.stringify(value)].length;

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

async function objectProtocol(t) {
  const root = await fixture(t);
  await edit(root, '设定/本局变量.yaml', value => {
    value.角色.记录 = {集合: {子字段: {名称: {形态: '文本'}, 数量: {取值: ['一', '二']}}}};
    value.角色.明细 = {映射: {键: {形态: '文本'}, 值: {子字段: {状态: {取值: ['正常', '异常']}}}}};
  });
  return {...await loadProtocol(root), root};
}

async function replaceBytes(root, name, bytes) {
  await fs.writeFile(path.join(root, name), bytes);
}

test('核心-02-1：对象集合按值写入、去重和移除，文本集合不变', async t => {
  const {protocol} = await objectProtocol(t);
  const base = S(protocol, '074'), before = clone(base);
  const input = {名称: '甲', 数量: '一'};
  const first = D(protocol, base, [change('角色.灯塔学徒.记录', '新增', input)], {事件ID: '记录一'}).state;
  input.名称 = '乙';
  assert.deepEqual(first.角色.灯塔学徒.记录, [{名称: '甲', 数量: '一'}]);
  assert.deepEqual(base, before);
  const again = D(protocol, first, [change('角色.灯塔学徒.记录', '新增', {名称: '甲', 数量: '一'})], {事件ID: '记录二'}).state;
  assert.deepEqual(again.角色.灯塔学徒.记录, [{名称: '甲', 数量: '一'}]);
  const removed = D(protocol, again, [change('角色.灯塔学徒.记录', '移除', {名称: '甲', 数量: '一'})], {事件ID: '记录三'}).state;
  assert.deepEqual(removed.角色.灯塔学徒.记录, []);
  const text = D(protocol, base, [change('角色.灯塔学徒.知识', '新增', '甲')], {事件ID: '文本一'}).state;
  const textAgain = D(protocol, text, [change('角色.灯塔学徒.知识', '新增', '甲')], {事件ID: '文本二'}).state;
  const textRemoved = D(protocol, textAgain, [change('角色.灯塔学徒.知识', '移除', '甲')], {事件ID: '文本三'}).state;
  assert.deepEqual(textAgain.角色.灯塔学徒.知识, text.角色.灯塔学徒.知识);
  assert.deepEqual(textRemoved.角色.灯塔学徒.知识, base.角色.灯塔学徒.知识);
});

test('核心-02-2：undefined、NaN、函数、Date、BigInt、符号、非普通对象与环在写入前拒绝', async t => {
  const {protocol} = await objectProtocol(t);
  const base = S(protocol, '074'), before = clone(base);
  const raw = (pathName, operation, value) => ({路径: pathName, 操作: operation, 值: value});
  const cycle = {状态: '正常'};
  cycle.self = cycle;
  class Foreign { constructor() { this.状态 = '正常'; } }
  const cases = [
    ['显式 undefined：装备设定', raw('角色.灯塔学徒.装备.灯具·风暴灯', '设定', undefined), '变化.格式'],
    ['显式 undefined：知识新增', raw('角色.灯塔学徒.知识', '新增', undefined), '变化.格式'],
    ['移除带值', raw('角色.灯塔学徒.名望', '移除', '学徒'), '变化.取值'],
    ['移除带 undefined', raw('角色.灯塔学徒.名望', '移除', undefined), '变化.取值'],
    ['NaN：知识新增', raw('角色.灯塔学徒.知识', '新增', NaN), '变化.取值'],
    ['函数：身体状态设定', raw('角色.灯塔学徒.身体状态.健康', '设定', () => 1), '变化.取值'],
    ['Date：身体状态设定', raw('角色.灯塔学徒.身体状态.健康', '设定', new Date(0)), '变化.取值'],
    ['BigInt：知识新增', raw('角色.灯塔学徒.知识', '新增', 1n), '变化.取值'],
    ['符号：知识新增', raw('角色.灯塔学徒.知识', '新增', Symbol('甲')), '变化.取值'],
    ['非普通对象：映射值设定', raw('角色.灯塔学徒.明细.条目', '设定', new Foreign()), '变化.取值'],
    ['环：映射值设定', raw('角色.灯塔学徒.明细.条目', '设定', cycle), '变化.取值'],
  ];
  for (const [name, item, fragment] of cases) {
    assert.throws(() => D(protocol, base, [item], {事件ID: `拒绝${name}`}), failWith('协议.变化', fragment), name);
    assert.deepEqual(base, before, `${name}：失败后本局不变`);
    assert.equal(Object.hasOwn(base.事件, `拒绝${name}`), false, `${name}：失败不写事件`);
  }
});

test('核心-02-3：seal 先验玩家档案，畸形世界书事件保留错误码与事件ID', async t => {
  const {protocol} = await loadProtocol();
  const player = archive => sealPlayer(protocol, archive);
  assert.throws(() => player({姓名: () => '甲'}), failWith('封卷.参数'), '函数档案');
  assert.throws(() => player({姓名: new Date(0)}), failWith('封卷.参数'), 'Date 档案');
  assert.throws(() => player({姓名: 1n}), failWith('封卷.参数'), 'BigInt 档案');
  const cycle = {姓名: '甲'};
  cycle.self = cycle;
  assert.throws(() => player(cycle), failWith('封卷.参数'), '循环档案');

  const timeRoot = await fixture(t);
  await edit(timeRoot, eventFile('拜师'), event => { event.触发时间 = {最早: time('071-04-01'), 最晚: time('071-01-01')}; });
  const timeProtocol = (await loadProtocol(timeRoot)).protocol;
  assert.throws(() => S(timeProtocol, '074'), failWith('协议.参数', '拜师'));

  const changeRoot = await fixture(t);
  await edit(changeRoot, eventFile('拜师'), event => {
    event.分支[0].变化 = [{路径: '角色.不存在.知识', 操作: '新增', 值: '甲'}];
  });
  const changeProtocol = (await loadProtocol(changeRoot)).protocol;
  assert.throws(() => S(changeProtocol, '074'), failWith('协议.变化', '拜师'));
});

function sealPlayer(protocol, archive) {
  return protocol.seal({开局时间: time('074'), 玩家: {模式: '自建', 档案: archive}});
}

test('核心-02-4：路由候选逐事件隔离，审计事件异常，畸形形状不崩', async t => {
  const timeRoot = await fixture(t);
  await edit(timeRoot, eventFile('秦守讲旧事'), event => { event.触发时间 = {最早: time('071-06-01'), 最晚: time('071-01-01')}; });
  const broken = await loadRouting(timeRoot), state = R0(broken.protocol);
  const isolated = route(broken.router, state, []);
  assert.ok(isolated.context.事件.候选.some(item => item.事件ID === '出师考核'));
  assert.equal(isolated.context.事件.候选.some(item => item.事件ID === '秦守讲旧事'), false);
  assert.ok(isolated.audit.异常.some(item => item.类型 === '事件异常' && item.事件ID === '秦守讲旧事'));
  assert.equal(isolated.context.事件.已确认经历?.some(item => item.事件ID === '秦守讲旧事'), false);

  const shapeRoot = await fixture(t);
  await edit(shapeRoot, eventFile('秦守讲旧事'), event => { delete event.核心参与者; });
  const shaped = await loadRouting(shapeRoot);
  const result = route(shaped.router, R0(shaped.protocol), []);
  assert.ok(result.context.事件.候选.some(item => item.事件ID === '秦守讲旧事'));
  assert.deepEqual(result.audit.异常.filter(item => item.事件ID === '秦守讲旧事'), []);
});

test('核心-02-5：待定项的路径、候选值与事件状态在四处一致拒绝，合法项照常通过', async t => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '071-02-05');
  const base = {字段路径: '角色.灯塔学徒.知识', 候选值: ['甲'], 事件ID: '拜师', 说明: '说明'};
  const fake = [
    {...base, 字段路径: '角色.灯塔学徒.不存在'},
    {...base, 字段路径: '角色.灯塔学徒.在场'},
    {...base, 字段路径: '角色.灯塔学徒.所在'},
    {...base, 候选值: []},
    {...base, 候选值: '甲'},
    {...base, 事件ID: '潮汐号首航'},
    {...base, 事件ID: '不存在的事件'},
  ];
  for (const item of fake) {
    const copy = clone(state);
    copy.待定项 = [item];
    const before = clone(copy);
    for (const action of [
      () => protocol.eventStatus(copy, '拜师'),
      () => protocol.confirmPending(copy),
      () => protocol.writeScene(copy, {}),
      () => protocol.createReadView(copy),
    ]) assert.throws(action, errorCode('协议.参数'));
    assert.deepEqual(copy, before);
  }
  const legal = protocol.writePendingItem(state, {操作: '新增', 字段路径: '角色.灯塔学徒.知识',
    候选值: ['甲'], 事件ID: '拜师', 说明: '说明'});
  assert.deepEqual(legal.state.待定项, [{字段路径: '角色.灯塔学徒.知识', 候选值: ['甲'], 事件ID: '拜师', 说明: '说明'}]);
  assert.doesNotThrow(() => protocol.eventStatus(legal.state, '拜师'));
  assert.doesNotThrow(() => protocol.writeScene(legal.state, {}));
  assert.doesNotThrow(() => protocol.createReadView(legal.state));
});

test('核心-02-6：条目库读取失败形成异常，格式化不写文件；缺失仍合法', async t => {
  const utfRoot = await fixture(t);
  await replaceBytes(utfRoot, '设定/条目库.yaml', Buffer.from([0xff, 0xfe, 0x00]));
  const beforeUtf = await treeHashes(utfRoot);
  const utf = await formatWorldbook(utfRoot, {write: true});
  assert.equal(utf.项目.异常, 1);
  assert.deepEqual(utf.已写入, []);
  assert.deepEqual(await treeHashes(utfRoot), beforeUtf);

  const deniedRoot = await fixture(t), deniedFile = path.join(deniedRoot, '设定/条目库.yaml');
  const deniedFs = {...fs, readFile: (file, ...args) => path.resolve(String(file)) === path.resolve(deniedFile)
    ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {code: 'EACCES'}))
    : fs.readFile(file, ...args)};
  const beforeDenied = await treeHashes(deniedRoot);
  const denied = await formatWorldbook(deniedRoot, {write: true, fs: deniedFs});
  assert.equal(denied.项目.异常, 1);
  assert.deepEqual(denied.已写入, []);
  assert.ok(denied.异常[0].说明.includes('EACCES') && denied.异常[0].说明.includes(deniedFile));
  assert.deepEqual(await treeHashes(deniedRoot), beforeDenied);

  for (const [name, text] of [['重复键', '技能:\n  分法: 按种类\n技能:\n  分法: 按上下级\n'],
    ['非映射根', '- 技能\n']]) {
    const root = await fixture(t);
    await replaceBytes(root, '设定/条目库.yaml', Buffer.from(text));
    const before = await treeHashes(root), result = await formatWorldbook(root, {write: true});
    assert.equal(result.项目.异常, 1, name);
    assert.deepEqual(result.已写入, [], name);
    assert.deepEqual(await treeHashes(root), before, name);
  }

  const missingRoot = await fixture(t);
  await fs.rm(path.join(missingRoot, '设定/条目库.yaml'));
  const missing = await formatWorldbook(missingRoot, {write: false});
  assert.equal(missing.项目.异常, 0);
});

test('核心-02-6b：CLI 条目库读取失败非零退出且已写入为空', async t => {
  const root = await fixture(t);
  await replaceBytes(root, '设定/条目库.yaml', Buffer.from([0xff, 0xfe, 0x00]));
  const before = await treeHashes(root);
  let stdout = '', stderr = '';
  const code = await runCli(['format', root, '--json', '--write'], {stdout: {write: value => { stdout += value; }},
    stderr: {write: value => { stderr += value; }}});
  const result = JSON.parse(stdout);
  assert.equal(code, 1);
  assert.equal(result.项目.异常, 1);
  assert.deepEqual(result.已写入, []);
  assert.deepEqual(await treeHashes(root), before);
  assert.equal(stderr, '');
});

test('核心-02-7：空说明省略，空条目略过并审计正文为空，不输出 null', async t => {
  const emptyRoot = await fixture(t);
  await replaceBytes(emptyRoot, '技能/技能.txt', Buffer.from(''));
  await replaceBytes(emptyRoot, '技能/雾中视/雾中视.txt', Buffer.from(''));
  await replaceBytes(emptyRoot, '地点/北湾/雾港/雾港.txt', Buffer.from(''));
  await replaceBytes(emptyRoot, '装备/工具/工具·铜扳手.txt', Buffer.from(''));
  const empty = await loadRouting(emptyRoot), emptyResult = route(empty.router, R0(empty.protocol), messages);
  assert.equal(JSON.stringify(emptyResult.context).includes('null'), false);
  assert.equal(emptyResult.context.条目.技能.some(item => item.说明 === '技能'), false);
  assert.ok(emptyResult.audit.条目.地点.略过.some(item => item.条目ID === '雾港' && item.原因 === '正文为空'));
  assert.ok(emptyResult.audit.条目.装备.略过.some(item => item.条目ID === '工具·铜扳手' && item.原因 === '正文为空'));

  const descRoot = await fixture(t);
  await replaceBytes(descRoot, '技能/技能.txt', Buffer.from(''));
  const desc = await loadRouting(descRoot), descResult = route(desc.router, R0(desc.protocol), messages);
  const items = descResult.context.条目.技能;
  assert.equal(items.some(item => item.说明 === '技能'), false);
  const noDescRoot = await fixture(t);
  await fs.rm(path.join(noDescRoot, '技能/技能.txt'));
  const noDesc = await loadRouting(noDescRoot), noDescResult = route(noDesc.router, R0(noDesc.protocol), messages);
  assert.deepEqual(descResult.context.条目.技能, noDescResult.context.条目.技能);
  assert.deepEqual(descResult.audit.条目.技能, noDescResult.audit.条目.技能);
});

test('核心-02-8：年位数上限为 11，12、1.5 与 0 拒绝', async t => {
  const base = {前缀: '潮历', 月数: 4, 每月天数: [91, 91, 91, 92]};
  const eleven = createCalendar({...base, 年位数: 11});
  assert.ok(eleven.time('潮历00000000001年'));
  for (const digits of [12, 1.5, 0]) assert.throws(() => createCalendar({...base, 年位数: digits}), undefined, String(digits));

  const root = await fixture(t);
  await edit(root, '设定/纪年.yaml', value => { value.年位数 = 11; });
  let declaration = await readDeclarations(root, {fs, path});
  assert.deepEqual(validateDeclarations(declaration.raw).issues, []);
  await edit(root, '设定/纪年.yaml', value => { value.年位数 = 12; });
  declaration = await readDeclarations(root, {fs, path});
  const checked = validateDeclarations(declaration.raw);
  assert.equal(checked.decl.calendar, null);
  assert.ok(checked.issues.some(item => item.规则 === '设定.纪年'));
});

test('核心-02-9：非文本角色组ID与已记录事件的结构引用不再静默通过', async t => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '071-02-05');
  for (const action of [
    () => protocol.availableSkills(state, 123),
    () => protocol.availableSkills({}, 123),
    () => protocol.createReadView(state).availableSkills(123),
  ]) assert.throws(action, errorCode('协议.参数'));

  assert.throws(() => protocol.confirmEvent(state, {事件ID: '拜师', 分支ID: '拜师', 实际参与者: ['不存在']}),
    errorCode('协议.参数'));
  assert.throws(() => protocol.confirmEvent(state, {事件ID: '拜师', 分支ID: '拜师', 实际参与者: ['周岚']}),
    errorCode('协议.参与者'));

  const recorded = D(protocol, S(protocol, '072'), [], {事件ID: '已记录事件'});
  const base = recorded.state, before = clone(base);
  assert.throws(() => protocol.confirmDynamicEvent(base, {事件ID: '已记录事件', 摘要: '测试', 变化: [],
    实际参与者: ['不存在']}), errorCode('协议.参数'));
  assert.throws(() => protocol.confirmDynamicEvent(base, {事件ID: '已记录事件', 摘要: '测试', 变化: [],
    实际参与者: ['周岚']}), errorCode('协议.参与者'));
  assert.throws(() => protocol.confirmDynamicEvent(base, {事件ID: '已记录事件', 摘要: '测试',
    变化: [{路径: '角色.不存在.知识', 操作: '新增', 值: '甲'}]}), errorCode('协议.变化'));
  assert.throws(() => protocol.confirmDynamicEvent(base, {事件ID: '已记录事件', 摘要: '测试', 变化: [],
    结束事件串: '不存在'}), errorCode('协议.参数'));
  const idempotent = protocol.confirmDynamicEvent(base, {事件ID: '已记录事件', 摘要: '测试', 变化: [],
    实际参与者: ['灯塔学徒']});
  assert.deepEqual(idempotent.已写入, []);
  assert.deepEqual(idempotent.state, base);
  assert.deepEqual(base, before);
});

test('核心-02-9b：applyCommands 前后合法命令照常，单条失败隔离', async t => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '071-04-19');
  const result = applyCommands(protocol, state, [
    {写场景: {当前时间: time('071-04-20')}},
    {动态事件: {事件ID: '坏命令', 摘要: '测试', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: undefined}]}},
    {写场景: {当前时间: time('071-04-21')}},
  ]);
  assert.deepEqual(result.失败, [{序号: 2, 命令: '动态事件', 错误码: '协议.变化',
    说明: '变化.格式：变化：该操作的值不能为 undefined'}]);
  assert.equal(result.state.世界.当前时间, time('071-04-21'));
  assert.equal(Object.hasOwn(result.state.事件, '坏命令'), false);
});

test('核心-02-10：合法既有写入与本局形状不变', async t => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '074'), before = clone(state);
  const result = D(protocol, state, [change('角色.灯塔学徒.知识', '新增', '新知识'),
    change('角色.灯塔学徒.装备.灯具·风暴灯', '设定', {状态: '破损', 位置: '灯室'})], {事件ID: '合法动态'});
  assert.deepEqual(Object.keys(result.state), ['世界', '开局', '角色', '事件', '待定项']);
  assert.deepEqual(result.state.角色.灯塔学徒.知识, [...before.角色.灯塔学徒.知识, '新知识']);
  assert.deepEqual(result.state.角色.灯塔学徒.装备['灯具·风暴灯'], {状态: '破损', 位置: '灯室'});
  assert.deepEqual(state, before);
});
