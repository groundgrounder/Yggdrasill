import {test, assert, fixture, edit, read, write, oldGroup, loadProtocol, changedProtocol, eventFile, S, W, C, D, time, change, errorCode, fogGate, record,
  eventStatus, evaluate, initializationPreview, confirmInitialization, currentAbility, availableSkills,
  confirmDynamicEvent, confirmPending, pendingEvents, chainStatus} from './protocol-helpers.mjs';
const {protocol: p} = await loadProtocol();
const P0 = S(p, '071-02-05');
const P1 = W(p, P0, {当前地点: {地标: '灯塔', 场景: '工具间'}}).state;
const P2 = W(p, P1, {当前地点: {地标: '灯塔', 场景: '值守室'}}).state;
const P3 = W(p, P2, {在场: {秦守: true}}).state;
const P4 = W(p, P3, {当前地点: {地标: '码头区', 场景: '栈桥'}}).state;
const T0 = S(p, '074'), D0 = S(p, '072'), Q0 = S(p, '071-01-05');
const U0 = S(p, '071-04-19'), U1 = structuredClone(U0); U1.世界.当前时间 = time('071-04-25');
const pending = [{事件ID: '大雾之夜', 分支ID: '发生'}, {事件ID: '学徒守灯', 分支ID: '重燃灯塔'}, {事件ID: '白棠在码头', 分支ID: '在家等候'}];
const locationCondition = (id, place) => ({角色状态: {角色组ID: id, 字段: '所在', 属于: [place]}});
const confirmDeparture = state => confirmDynamicEvent(p, state, {事件ID: '学徒辞别', 摘要: '学徒向秦守辞行', 实际参与者: ['灯塔学徒'], 变化: [], 结束事件串: '学徒修习'});

test('运行-1：初始候选与缺场景', () => {
  assert.deepEqual(eventStatus(p, P0, '夜间值守'), {状态: '候选', 分支: ['完成']}); assert.deepEqual(eventStatus(p, P0, '学修船'), {状态: '不适用'});
});
test('运行-2：写当前地点只改变场景', () => {
  assert.deepEqual(eventStatus(p, P1, '学修船'), {状态: '候选', 分支: ['学会']}); assert.deepEqual(P1.角色, P0.角色);
});
test('运行-3：确认学修船与自动初始化秦守', () => {
  const result = C(p, P1, '学修船', '学会');
  assert.deepEqual(result.已写入, ['学修船', '初次登场·秦守']);
  assert.deepEqual(result.state.事件, {...P1.事件, 学修船: record('学会', '071-02-05', ['灯塔学徒', '秦守']),
    '初次登场·秦守': record('初始化', '071-02-05', ['秦守'])});
  assert.deepEqual(result.state.角色.秦守, {关系: {灯塔学徒: '师徒'}, 技艺: {灯语: '名匠', 修船: '匠人'}, 名望: '匠人',
    装备: {'工具·铜扳手': {状态: '完好', 位置: '随身工具袋'}}, 已初始化: true});
  assert.deepEqual(result.state.角色.灯塔学徒.技艺, {灯语: '学徒', 修船: '学徒'});
});
test('运行-4：确认预设事件幂等', () => {
  const state = C(p, P1, '学修船', '学会').state, result = C(p, state, '学修船', '学会');
  assert.deepEqual(result.已写入, []); assert.deepEqual(result.state, state);
});
test('运行-5：非候选、未知分支与未启用参与者', () => {
  assert.throws(() => C(p, P1, '出师考核', '通过'), errorCode('协议.事件状态'));
  assert.throws(() => C(p, P1, '夜间值守', '出海'), errorCode('协议.参数'));
  assert.throws(() => C(p, P1, '夜间值守', '完成', {实际参与者: ['周岚']}), errorCode('协议.参与者'));
});
test('运行-6：缺综合实力的自建玩家使分支门槛未知', () => {
  assert.deepEqual(eventStatus(p, P2, '秦守讲旧事'), {状态: '候选', 分支: ['讲述']});
});
test('运行-7：在场触发自动初始化与实力分支', () => {
  assert.deepEqual(W(p, P2, {在场: {秦守: true}}).已写入, ['初次登场·秦守']);
  assert.deepEqual(eventStatus(p, P3, '秦守讲旧事'), {状态: '候选', 分支: ['讲述', '讲述并示范']});
});
test('运行-8：离场保存写入前地标', () => {
  const result = W(p, P3, {当前地点: {地标: '码头区', 场景: '栈桥'}, 在场: {秦守: false}});
  assert.equal(result.state.角色.秦守.所在, '灯塔'); assert.equal(evaluate(p, result.state, locationCondition('秦守', '灯塔')), true);
});
test('运行-9：在场角色随当前地点移动', () => {
  assert.equal(evaluate(p, P4, locationCondition('秦守', '雾港')), true); assert.equal(evaluate(p, P4, locationCondition('秦守', '灯塔')), false);
  assert.equal(Object.hasOwn(P4.角色.秦守, '所在'), false);
});
test('运行-10：在场写所在、时间倒退、未启用角色在场均拒绝', () => {
  for (const [state, params] of [[P4, {所在: {秦守: '灯塔'}}], [P3, {当前时间: time('071-02-04')}], [P3, {在场: {周岚: true}}]])
    assert.throws(() => W(p, state, params), errorCode('协议.场景'));
});
test('运行-11：从未出场的自动角色可直接写在场', () => {
  const result = W(p, Q0, {在场: {秦守: true}}); assert.deepEqual(result.已写入, ['初次登场·秦守']); assert.equal(result.state.角色.秦守.已初始化, true);
});
test('运行-12：显式初始化空起点也封存', () => {
  assert.throws(() => W(p, Q0, {在场: {灯塔学徒: true}}), errorCode('协议.场景'));
  const result = confirmInitialization(p, Q0, '灯塔学徒');
  assert.deepEqual(result.已写入, ['初次登场·灯塔学徒']); assert.deepEqual(result.state.角色.灯塔学徒, {已初始化: true});
  assert.deepEqual(result.state.事件, {'初次登场·灯塔学徒': record('初始化', '071-01-05', ['灯塔学徒'])});
  assert.equal(W(p, result.state, {在场: {灯塔学徒: true}}).state.角色.灯塔学徒.在场, true);
});
test('运行-13：扮演角色在写地点后视为在场', () => {
  const state = S(p, '071-01-05', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}});
  const result = W(p, state, {当前地点: {地标: '码头区', 场景: '栈桥'}});
  assert.deepEqual(result.已写入, []); assert.equal(evaluate(p, result.state, {角色已出场: {角色组ID: '灯塔学徒'}}), true);
  assert.equal(evaluate(p, result.state, locationCondition('灯塔学徒', '码头区')), true);
  assert.throws(() => W(p, result.state, {在场: {灯塔学徒: true}}), errorCode('协议.场景'));
});
test('运行-14：晚期开局初始化预览只补缺值', () => {
  assert.deepEqual(initializationPreview(p, T0, '灯塔学徒'), {档案ID: '林澜·守塔期', 能力: {技艺: {修船: '熟手'}}, 装备: []});
});
test('运行-15：初始化保留能力、集合与装备且只执行一次', () => {
  const result = confirmInitialization(p, T0, '灯塔学徒');
  assert.deepEqual(result.已写入, ['初次登场·灯塔学徒']); assert.deepEqual(result.state.事件, {...T0.事件, '初次登场·灯塔学徒': record('初始化', '074', ['灯塔学徒'])});
  assert.deepEqual(result.state.角色.灯塔学徒, {...T0.角色.灯塔学徒, 技艺: {灯语: '匠人', 修船: '熟手'}, 已初始化: true});
  assert.deepEqual(confirmInitialization(p, result.state, '灯塔学徒').已写入, []);
});
test('运行-16：秦守完整起点与未启用角色', () => {
  assert.deepEqual(initializationPreview(p, T0, '秦守'), {档案ID: '秦守·守塔期', 能力: {技艺: {灯语: '名匠', 修船: '匠人'}, 名望: '匠人'},
    装备: [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '随身工具袋'}]});
  assert.equal(initializationPreview(p, T0, '周岚'), null); assert.throws(() => confirmInitialization(p, T0, '周岚'), errorCode('协议.初始化'));
});
test('运行-17：能力只读本局、技能按库顺序', () => {
  assert.deepEqual(currentAbility(p, T0, '灯塔学徒'), {技艺: {灯语: '匠人'}, 名望: '熟手', 天赋: ['雾中视·辨影'], 习惯: ['每刻钟查一次灯芯']});
  assert.deepEqual(availableSkills(p, T0, '灯塔学徒'), ['灯语·短讯', '灯语·长夜信号', '雾中视·辨影']);
});
test('运行-18：初始化后修船技能可用', () => {
  assert.deepEqual(availableSkills(p, confirmInitialization(p, T0, '灯塔学徒').state, '灯塔学徒'), ['修船·补帆', '灯语·短讯', '灯语·长夜信号', '雾中视·辨影']);
});
test('运行-19：缺失集合输出空列表、未启用角色无能力与技能', () => {
  assert.deepEqual(currentAbility(p, T0, '白棠'), {天赋: [], 习惯: []}); assert.equal(currentAbility(p, T0, '周岚'), null);
  assert.deepEqual(availableSkills(p, T0, '周岚'), []);
});
test('运行-20：移除等级记录阻止初始化补回', () => {
  const state = D(p, T0, [change('技艺.灯语', '移除')]).state;
  assert.deepEqual(state.角色.灯塔学徒.能力移除记录, ['技艺.灯语']);
  assert.deepEqual(confirmInitialization(p, state, '灯塔学徒').state.角色.灯塔学徒.技艺, {修船: '熟手'});
});
test('运行-21：恢复能力清除移除记录的空键', () => {
  const state = confirmInitialization(p, D(p, T0, [change('技艺.灯语', '移除')]).state, '灯塔学徒').state;
  const result = D(p, state, [change('技艺.灯语', '提升', '学徒')], {事件ID: '测试2'});
  assert.equal(result.state.角色.灯塔学徒.技艺.灯语, '学徒'); assert.equal(Object.hasOwn(result.state.角色.灯塔学徒, '能力移除记录'), false);
});
test('运行-22：提升不降级、设定可降级', () => {
  assert.equal(D(p, T0, [change('技艺.灯语', '提升', '熟手')]).state.角色.灯塔学徒.技艺.灯语, '匠人');
  assert.equal(D(p, T0, [change('技艺.灯语', '设定', '熟手')]).state.角色.灯塔学徒.技艺.灯语, '熟手');
});
test('运行-23：数值从零起算并按范围截断', () => {
  assert.equal(D(p, T0, [change('好感度.秦守', '增加', 95)]).state.角色.灯塔学徒.好感度.秦守, 100);
  assert.equal(D(p, T0, [change('角色.秦守.好感度.白棠', '减少', 30)]).state.角色.秦守.好感度.白棠, -30);
});
test('运行-24：装备新增保留原有、设定覆盖', () => {
  const value = {状态: '破损', 位置: '灯室'};
  assert.deepEqual(D(p, T0, [change('装备.灯具·风暴灯', '新增', value)]).state.角色.灯塔学徒.装备, T0.角色.灯塔学徒.装备);
  assert.deepEqual(D(p, T0, [change('装备.灯具·风暴灯', '设定', value)]).state.角色.灯塔学徒.装备, {'灯具·风暴灯': value});
});
test('运行-25：集合不重复、移除不存在成员无副作用', () => {
  for (const item of [change('知识', '新增', '秦守在雾夜守住了灯'), change('知识', '移除', '不存在的知识')])
    assert.deepEqual(D(p, T0, [item]).state.角色.灯塔学徒.知识, T0.角色.灯塔学徒.知识);
});
test('运行-26：二层世界字段、剧情标记与玩家持久状态', () => {
  const state = D(p, T0, [change('世界.天气', '设定', '晴'), change('世界.剧情标记.雾季', '设定', '已过'), change('角色.玩家.知识', '新增', '一条')]).state;
  assert.equal(state.世界.天气, '晴'); assert.equal(state.世界.剧情标记.雾季, '已过'); assert.deepEqual(state.角色.玩家, {知识: ['一条']});
});
test('运行-27：拒绝未启用主体与映射键、协议字段和非法能力值', () => {
  for (const item of [change('角色.周岚.知识', '新增', '一条'), change('关系.周岚', '设定', '师徒'),
    change('已初始化', '设定', true), change('技艺.灯语', '提升', '宗师')]) assert.throws(() => D(p, T0, [item]), errorCode('协议.变化'));
});
test('运行-28：变化失败整次调用保持原子性', () => {
  const before = structuredClone(T0);
  assert.throws(() => D(p, T0, [change('知识', '新增', '一条'), change('技艺.灯语', '提升', '宗师')]), errorCode('协议.变化'));
  assert.deepEqual(T0, before);
});
test('运行-29：绕过协议写入非法等级后读取报错', () => {
  const state = structuredClone(T0); state.角色.灯塔学徒.技艺.灯语 = '宗师';
  assert.throws(() => currentAbility(p, state, '灯塔学徒'), errorCode('协议.能力取值'));
});
test('运行-30：动态事件可结束进行中的事件串', () => {
  const result = confirmDeparture(D0); assert.deepEqual(result.已写入, ['学徒辞别']);
  assert.deepEqual(result.state.事件, {...D0.事件, 学徒辞别: {...record('完成', '072', ['灯塔学徒']), 摘要: '学徒向秦守辞行', 结束事件串: '学徒修习'}});
  assert.equal(chainStatus(p, result.state, '学徒修习'), '已结束');
});
test('运行-31：不能结束已结束或不存在的事件串', () => {
  assert.throws(() => D(p, D0, [], {结束事件串: '雾夜余波'}), errorCode('协议.事件状态'));
  assert.throws(() => D(p, D0, [], {结束事件串: '不存在'}), errorCode('协议.参数'));
});
test('运行-32：动态事件保留ID、非法ID与缺摘要', () => {
  for (const id of ['拜师', '初次登场·秦守', '甲.乙', '__proto__', 'constructor', 'prototype', ''])
    assert.throws(() => D(p, D0, [], {事件ID: id}), errorCode('协议.参数'));
  assert.throws(() => confirmDynamicEvent(p, D0, {事件ID: '测试', 变化: []}), errorCode('协议.参数'));
});
test('运行-33：动态事件幂等', () => {
  const state = confirmDeparture(D0).state, result = confirmDeparture(state); assert.deepEqual(result.已写入, []); assert.deepEqual(result.state, state);
});
test('运行-34：动态参与者启用状态与自建玩家', () => {
  assert.throws(() => D(p, D0, [], {实际参与者: ['周岚']}), errorCode('协议.参与者'));
  assert.deepEqual(D(p, D0, [], {实际参与者: ['玩家']}).state.事件.测试.实际参与者, ['玩家']);
});
test('运行-35：动态实际参与者触发自动初始化', () => {
  assert.deepEqual(D(p, D0, [], {事件ID: '秦守来访', 实际参与者: ['秦守']}).已写入, ['秦守来访', '初次登场·秦守']);
});
test('运行-36：待登记按历史求解顺序选分支', () => { assert.deepEqual(pendingEvents(p, U1), pending); });
test('运行-37：待登记草稿中的记录与变化参与全部读取', () => {
  const before = structuredClone(U1);
  assert.deepEqual(eventStatus(p, U1, '大雾之夜'), {状态: '待登记', 分支ID: '发生'});
  assert.deepEqual(eventStatus(p, U1, '港务署问责'), {状态: '已排除'});
  assert.equal(evaluate(p, U1, {剧情标记: {标记ID: '灯塔状态', 比较: '等于', 值: '重燃'}}), true);
  assert.equal(chainStatus(p, U1, '雾夜余波'), '已结束'); assert.deepEqual(U1, before);
});
test('运行-38：待登记不允许更换分支，确认与全部登记结果相同', () => {
  assert.throws(() => C(p, U1, '学徒守灯', '独自守灯'), errorCode('协议.事件状态'));
  const result = C(p, U1, '学徒守灯', '重燃灯塔'), other = confirmPending(p, U1);
  assert.deepEqual(result, other); assert.deepEqual(result.已写入, pending.map(item => item.事件ID));
  for (const item of pending) assert.equal(result.state.事件[item.事件ID].实际时间, time('071-04-20'));
});
test('运行-39：协议推进时间的待登记结果一致', () => {
  assert.deepEqual(W(p, U0, {当前时间: time('071-04-25')}), confirmPending(p, U1));
});
test('运行-40：绕过协议改变所在导致待登记分支漂移', () => {
  const state = structuredClone(U1); state.角色.灯塔学徒.所在 = '码头区';
  assert.deepEqual(pendingEvents(p, state), pending.map(item => item.事件ID === '学徒守灯' ? {...item, 分支ID: '在镇上听闻'} : item));
});
test('运行-41：协议先登记再处理走动', () => {
  const state = W(p, U0, {当前时间: time('071-04-25'), 所在: {灯塔学徒: '码头区'}}).state;
  assert.equal(state.事件.学徒守灯.分支, '重燃灯塔'); assert.equal(state.角色.灯塔学徒.所在, '码头区');
});
test('运行-42：待登记忽略较晚记录倒流解锁的事件', async t => {
  const {protocol} = await changedProtocol(t, eventFile('大雾之夜'), event => { event.门槛 = {事件确认: {事件ID: '出师考核', 分支ID: '通过'}}; });
  const v0 = S(protocol, '071-04-19'), v1 = W(protocol, v0, {当前时间: time('071-04-25')});
  assert.deepEqual(v1.已写入, []); assert.deepEqual(eventStatus(protocol, v1.state, '大雾之夜'), {状态: '已排除'});
  const v2 = W(protocol, v1.state, {当前时间: time('072-02-01')}).state, result = C(protocol, v2, '出师考核', '通过');
  assert.deepEqual(result.已写入, ['出师考核', '初次登场·秦守']); assert.deepEqual(pendingEvents(protocol, result.state), []);
});
test('运行-43：新事件违反既有排斥时原子拒绝', async t => {
  const {protocol} = await changedProtocol(t, eventFile('白棠在码头'), event => { event.门槛 = fogGate; });
  const state = S(protocol, '071-04-21', {角色组: {周岚: {启用: true}}}), before = structuredClone(state);
  assert.equal(state.事件.白棠在码头.分支, '在家等候');
  assert.throws(() => C(protocol, state, '港务署问责', '问责秦守'), errorCode('协议.排斥冲突')); assert.deepEqual(state, before);
});

test('边界-未封卷：所有写入统一拒绝', () => {
  for (const action of [() => C(p, {}, '拜师', '拜师'), () => D(p, {}, []), () => confirmPending(p, {}),
    () => confirmInitialization(p, {}, '秦守'), () => W(p, {}, {})]) assert.throws(action, errorCode('协议.未封卷'));
});
test('边界-参与者：核心在前且去重、扮演模式拒绝玩家', () => {
  const state = C(p, P1, '学修船', '学会', {实际参与者: ['白棠', '秦守', '白棠', '玩家']}).state;
  assert.deepEqual(state.事件.学修船.实际参与者, ['灯塔学徒', '秦守', '白棠', '玩家']);
  const roleplay = S(p, '071-02-05', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}});
  assert.throws(() => D(p, roleplay, [], {实际参与者: ['玩家']}), errorCode('协议.参与者'));
});
test('边界-参数：拒绝畸形参数与保留映射键，不污染原型', () => {
  for (const action of [() => D(p, T0, [{路径: 1, 操作: '设定', 值: '晴'}]),
    () => D(p, T0, [change('角色.constructor.知识', '新增', '一条')]),
    () => D(p, T0, [change('角色.玩家.关系.周岚', '设定', '师徒')])]) assert.throws(action, errorCode('协议.变化'));
  for (const params of [{在场: null}, {所在: []}, {在场: {秦守: '是'}}, {在场: {constructor: true}},
    {当前地点: {地标: 'constructor', 场景: '门口'}}, {所在: {秦守: 'constructor'}}, {当前时间: 123}])
    assert.throws(() => W(p, T0, params), errorCode('协议.参数'));
  assert.equal(Object.hasOwn(Object.prototype, '知识'), false);
});
test('边界-能力：空集合优先、单值等级移除与恢复', () => {
  const state = structuredClone(T0); state.角色.灯塔学徒.习惯 = [];
  assert.deepEqual(confirmInitialization(p, state, '灯塔学徒').state.角色.灯塔学徒.习惯, []);
  const removed = D(p, T0, [change('名望', '移除')]).state;
  assert.deepEqual(removed.角色.灯塔学徒.能力移除记录, ['名望']); assert.equal(Object.hasOwn(currentAbility(p, removed, '灯塔学徒'), '名望'), false);
  const restored = D(p, removed, [change('名望', '设定', '学徒')], {事件ID: '恢复名望'}).state;
  assert.equal(restored.角色.灯塔学徒.名望, '学徒'); assert.equal(Object.hasOwn(restored.角色.灯塔学徒, '能力移除记录'), false);
});
test('边界-幂等写入：仍先登记其它待登记事件', () => {
  const result = C(p, U1, '拜师', '拜师'); assert.deepEqual(result, confirmPending(p, U1)); assert.notEqual(result.state, U1);
});
test('边界-分支门槛：确认时不能选未知门槛分支', () => {
  assert.throws(() => C(p, P2, '秦守讲旧事', '讲述并示范'), errorCode('协议.事件状态'));
});
test('边界-分支排斥：已确认分支的none也须重算', async t => {
  const {protocol} = await changedProtocol(t, eventFile('白棠在码头'), event => {
    event.分支.find(branch => branch.分支ID === '在家等候').门槛 = {none: [{事件确认: {事件ID: '港务署问责'}}]};
  });
  const state = S(protocol, '071-04-21', {角色组: {周岚: {启用: true}}}), before = structuredClone(state);
  assert.throws(() => C(protocol, state, '港务署问责', '问责秦守'), errorCode('协议.排斥冲突')); assert.deepEqual(state, before);
});
test('边界-排斥代入：其它叶子未知时any不可误判为不成立', async t => {
  const {protocol} = await changedProtocol(t, eventFile('白棠在码头'), event => {
    event.门槛 = {any: [{角色启用: {角色组ID: '周岚'}}, {none: [{事件确认: {事件ID: '港务署问责'}}]}]};
  });
  const state = S(protocol, '071-04-21', {角色组: {周岚: {启用: true}}});
  assert.ok(C(protocol, state, '港务署问责', '问责秦守').已写入.includes('港务署问责'));
});
test('边界-排斥代入：嵌套none保留组合语义', async t => {
  const {protocol} = await changedProtocol(t, eventFile('白棠在码头'), event => {
    event.门槛 = {none: [{all: [{事件确认: {事件ID: '港务署问责'}}, {事件确认: {事件ID: '补考'}}]}]};
  });
  const state = S(protocol, '071-04-21', {角色组: {周岚: {启用: true}}});
  assert.ok(C(protocol, state, '港务署问责', '问责秦守').已写入.includes('港务署问责'));
});

test('边界-玩家映射键：自建模式可写，扮演模式拒绝玩家主体', () => {
  const state = D(p, T0, [change('角色.秦守.关系.玩家', '设定', '相识')]).state;
  assert.equal(state.角色.秦守.关系.玩家, '相识'); assert.deepEqual(currentAbility(p, state, '秦守'), {天赋: [], 习惯: []});
  const roleplay = S(p, '074', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}});
  assert.throws(() => D(p, roleplay, [change('角色.玩家.知识', '新增', '一条')]), errorCode('协议.变化'));
});
test('边界-综合实力声明：人数条件不依赖名望字段名', async t => {
  const root = await fixture(t);
  await edit(root, '设定/能力.yaml', ability => {
    delete ability.维度.名望.综合实力;
    ability.维度.威势 = {类型: '单值等级', 等级: '技艺', 综合实力: true};
  });
  await edit(root, oldGroup, group => { group.档案[0].初始能力.威势 = '匠人'; });
  const {protocol} = await loadProtocol(root);
  const state = W(protocol, S(protocol, '071-02-05'), {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}).state;
  assert.equal(evaluate(protocol, state, {在场实力人数: {最低实力: '匠人', 最少人数: 1}}), true);
  assert.equal(state.角色.秦守.威势, '匠人');
});
test('边界-码点排序：同刻事件的补充平面汉字排在基本平面之后', async t => {
  const root = await fixture(t), template = await read(root, eventFile('大雾之夜'));
  for (const id of ['𠀀灯', '龟灯']) await write(root, eventFile(id), {...template, 事件ID: id,
    触发时间: {最早: time('069-01-01'), 最晚: time('069-01-01')}});
  const {protocol} = await loadProtocol(root), state = S(protocol, '070');
  assert.deepEqual(Object.keys(state.事件), ['龟灯', '𠀀灯']);
});
test('边界-历史求解：none只认已经写入的事件', async t => {
  const root = await fixture(t), template = await read(root, eventFile('大雾之夜'));
  for (const [id, other] of [['甲灯', '乙灯'], ['乙灯', '甲灯']]) await write(root, eventFile(id), {...template, 事件ID: id,
    触发时间: {最早: time('069-01-01'), 最晚: time('069-01-01')}, 门槛: {none: [{事件确认: {事件ID: other}}]}});
  const {protocol} = await loadProtocol(root), state = S(protocol, '070');
  assert.deepEqual(state.事件, {乙灯: record('发生', '069-01-01', []), 甲灯: {状态: 2}});
});
test('边界-自动初始化：档案异常时跳过，显式确认报初始化错误', async t => {
  const {protocol} = await changedProtocol(t, oldGroup, group => {
    delete group.档案[0].默认; group.档案[0].生效条件 = {当前时间: {比较: '小于', 值: time('070')}};
  });
  const state = S(protocol, '071-01-05'), result = W(protocol, state, {在场: {秦守: true}});
  assert.deepEqual(result.已写入, []); assert.deepEqual(result.state.角色.秦守, {在场: true});
  assert.throws(() => confirmInitialization(protocol, state, '秦守'), errorCode('协议.初始化'));
});
