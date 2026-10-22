import {test, assert, loadRouting, S, U1, time, writePendingItem, applyCommands, errorCode, change, W} from './router-helpers.mjs';
const {protocol: p} = await loadRouting();
const state = S(p, '072');
const item = {字段路径: '角色.秦守.关系.灯塔学徒', 候选值: ['信任', '师徒'], 事件ID: '学徒守灯', 说明: '雾夜之后秦守是否更信任学徒'};
const add = (source = state, values = {}) => writePendingItem(p, source, {操作: '新增', ...item, ...values});
test('待定-1：新增待定项不产生事件记录且不修改输入', () => {
  const before = structuredClone(state), result = add();
  assert.deepEqual(result.state.待定项, [item]); assert.deepEqual(result.已写入, []); assert.deepEqual(state, before);
  result.state.待定项[0].候选值.push('友好'); assert.deepEqual(item.候选值, ['信任', '师徒']);
});
test('待定-2：同字段路径替换', () => assert.deepEqual(add(add().state, {候选值: ['信任']}).state.待定项, [{...item, 候选值: ['信任']}]));
test('待定-3：移除与重复移除幂等', () => {
  const params = {操作: '移除', 字段路径: item.字段路径};
  const removed = writePendingItem(p, add().state, params);
  assert.deepEqual(removed.state.待定项, []); assert.deepEqual(writePendingItem(p, removed.state, params), removed);
});
for (const [label, params] of [
  ['未知字段', {字段路径: '角色.秦守.力量'}], ['在场', {字段路径: '角色.秦守.在场'}], ['所在', {字段路径: '角色.秦守.所在'}],
  ['无事件记录', {事件ID: '出师考核'}], ['状态二', {事件ID: '港务署问责'}], ['空候选值', {候选值: []}], ['未知操作', {操作: '修改'}],
]) test(`待定-4：${label}报协议参数`, () => assert.throws(() => add(state, params), errorCode('协议.参数')));
test('待定-5：未启用角色、扮演玩家拒绝，自建玩家允许', () => {
  assert.throws(() => add(state, {字段路径: '角色.周岚.知识'}), errorCode('协议.变化'));
  const roleplay = S(p, '072', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}});
  assert.throws(() => add(roleplay, {字段路径: '角色.玩家.知识'}), errorCode('协议.变化'));
  assert.equal(add(state, {字段路径: '角色.玩家.知识'}).state.待定项[0].字段路径, '角色.玩家.知识');
  assert.throws(() => add(roleplay, {字段路径: '角色.秦守.关系.玩家'}), errorCode('协议.变化'));
});
test('待定-6：先登记待登记，再校验事件记录', () => {
  const result = add(U1(p), {事件ID: '大雾之夜'});
  assert.deepEqual(result.已写入, ['大雾之夜', '学徒守灯', '白棠在码头']);
  assert.equal(result.state.待定项[0].事件ID, '大雾之夜');
});
test('待定-边界：完整字段格、非法路径与缺失参数', () => {
  for (const field of ['世界.剧情标记.雾季', '世界.天气', '角色.秦守.身体状态.健康', '角色.秦守.技艺.灯语',
    '角色.秦守.天赋', '角色.秦守.名望', '角色.秦守.装备.工具·铜扳手']) assert.equal(add(state, {字段路径: field}).state.待定项[0].字段路径, field);
  for (const field of ['角色.秦守.关系', '角色.秦守.身体状态', '角色.秦守.装备', '角色.秦守.已初始化',
    '角色.秦守.能力移除记录', '角色.秦守.技艺.拳法', '角色.秦守.装备.不存在', '角色.秦守.__proto__', '角色..知识'])
    assert.throws(() => add(state, {字段路径: field}), errorCode('协议.参数'));
  for (const key of ['候选值', '事件ID', '说明']) {
    const params = {操作: '新增', ...item}; delete params[key];
    assert.throws(() => writePendingItem(p, state, params), errorCode('协议.参数'));
  }
  assert.throws(() => add({}, {}), errorCode('协议.未封卷'));
});
test('待定-边界：失败不登记待登记且不自动写候选值', () => {
  const original = U1(p), before = structuredClone(original);
  assert.throws(() => add(original, {事件ID: '出师考核'}), errorCode('协议.参数')); assert.deepEqual(original, before);
  assert.deepEqual(add(state, {候选值: ['待剧情明确', {待判: true}]}).state.角色, state.角色);
});
test('命令-1：逐条提交，失败后继续，汇总写入与序号', () => {
  const commands = [
    {写场景: {当前时间: time('072-02-01')}}, {确认事件: {事件ID: '出师考核', 分支ID: '未通过'}},
    {确认事件: {事件ID: '补考', 分支ID: '通过'}},
    {动态事件: {事件ID: '学徒自省', 摘要: '学徒反复练习第二道灯号', 实际参与者: ['灯塔学徒'],
      变化: [change('知识', '新增', '第二道灯号要先听风门')]}},
  ];
  const before = structuredClone(commands), result = applyCommands(p, state, commands);
  assert.deepEqual(result.已写入, ['出师考核', '初次登场·秦守', '学徒自省']);
  assert.deepEqual(result.失败.map(({说明, ...item}) => item), [{序号: 3, 命令: '确认事件', 错误码: '协议.事件状态'}]);
  assert.deepEqual(result.state.角色.灯塔学徒.知识, ['秦守在雾夜守住了灯', '秦守说灯号还差一口气', '第二道灯号要先听风门']);
  assert.deepEqual(commands, before);
});
for (const [label, invalid] of [['多键映射', {写场景: {}, 待定项: {}}], ['未知命令', {开船: {}}],
  ['非映射参数', {写场景: '向前'}], ['字符串命令', '写场景']]) test(`命令-2：${label}失败不影响前后命令`, () => {
  const result = applyCommands(p, state, [{写场景: {当前时间: time('072-02-01')}}, invalid,
    {动态事件: {事件ID: '听风', 摘要: '学徒听风', 变化: []}}]);
  assert.deepEqual(result.已写入, ['听风']); assert.equal(result.state.世界.当前时间, time('072-02-01'));
  assert.equal(result.失败.length, 1); assert.equal(result.失败[0].序号, 2); assert.equal(result.失败[0].错误码, '协议.参数');
});
test('命令-3：命令不是列表则抛出协议参数', () => {
  for (const commands of [undefined, null, {}, '命令']) assert.throws(() => applyCommands(p, state, commands), errorCode('协议.参数'));
});
test('命令-4：待定项命令等于直接写入', () => {
  const result = applyCommands(p, state, [{待定项: {操作: '新增', ...item}}]);
  const {失败, ...written} = result;
  assert.deepEqual(失败, []); assert.deepEqual(written, add());
});
test('命令-边界：确认初始化参数校验，空命令不写入', () => {
  assert.deepEqual(applyCommands(p, state, []), {state, 已写入: [], 失败: []});
  const result = applyCommands(p, state, [{确认初始化: {角色组ID: '灯塔学徒'}}, {确认初始化: {角色组ID: '秦守', 多余: true}}]);
  assert.deepEqual(result.已写入, ['初次登场·灯塔学徒']); assert.equal(result.失败[0].错误码, '协议.参数');
});
