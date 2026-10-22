import {test, assert, loadProtocol, changedProtocol, apprenticeGroup, captainGroup, S, W, time, evaluate, pendingEvents,
  eventStatus, chainStatus, resolveProfile, currentAbility, availableSkills, initializationPreview, records72, errorCode} from './protocol-helpers.mjs';
const {protocol: p} = await loadProtocol();
const s72 = S(p, '072');
const leaves = [
  ['角色启用', {角色组ID: '秦守'}, true], ['角色启用', {角色组ID: '周岚'}, false],
  ['角色版本', {角色组ID: '白棠', 版本ID: '白棠'}, true], ['角色版本', {角色组ID: '白棠', 版本ID: '白棠·船长'}, false],
  ['事件确认', {事件ID: '拜师'}, true], ['事件确认', {事件ID: '拜师', 分支ID: '未拜师'}, false], ['事件确认', {事件ID: '出师考核'}, false],
  ['事件串状态', {事件串ID: '学徒修习', 状态: '进行中'}, true], ['事件串状态', {事件串ID: '雾夜余波', 状态: '已结束'}, true],
  ['事件串状态', {事件串ID: '学徒修习', 状态: '未开始'}, false],
  ['当前时间', {比较: '小于', 值: time('073')}, true], ['当前时间', {比较: '大于等于', 值: time('072')}, true],
  ['当前时间', {比较: '小于', 值: time('072-03-01')}, false],
  ['剧情标记', {标记ID: '灯塔状态', 比较: '等于', 值: '重燃'}, true], ['剧情标记', {标记ID: '灯塔状态', 比较: '不等于', 值: '熄灭'}, true],
  ['角色状态', {角色组ID: '灯塔学徒', 字段: '关系.秦守', 属于: ['师徒']}, true],
  ['角色状态', {角色组ID: '白棠', 字段: '关系.秦守', 属于: ['陌生']}, true],
  ['角色状态', {角色组ID: '灯塔学徒', 字段: '所在', 属于: ['雾港']}, true],
  ['角色状态', {角色组ID: '周岚', 字段: '所在', 属于: ['雾港']}, false],
  ['同处', {角色组ID: ['灯塔学徒', '秦守']}, true], ['同处', {角色组ID: ['灯塔学徒', '白棠']}, false],
  ['同处', {角色组ID: ['灯塔学徒', '周岚']}, false],
  ['角色已出场', {角色组ID: '秦守'}, true], ['角色已出场', {角色组ID: '白棠'}, true], ['角色已出场', {角色组ID: '周岚'}, false],
  ['当前场景', {地标: '灯塔', 场景: '值守室'}, null], ['在场实力人数', {最低实力: '学徒', 最少人数: 1}, null],
];
leaves.forEach(([type, value, expected], index) => test(`条件-${index + 1}：${type} 正向、none 与封卷前`, () => {
  const leaf = {[type]: value};
  assert.equal(evaluate(p, s72, leaf), expected);
  assert.equal(evaluate(p, s72, {none: [leaf]}), expected === null ? null : !expected);
  assert.equal(evaluate(p, {}, leaf), null);
  assert.equal(evaluate(p, {}, {none: [leaf]}), null);
}));
test('条件-缺所在：同处为未知且取反仍为未知', async t => {
  const {protocol} = await changedProtocol(t, captainGroup, group => { delete group.初始所在; });
  const state = S(protocol, '070'), leaf = {同处: {角色组ID: ['白棠', '秦守']}};
  assert.equal(evaluate(protocol, state, leaf), null); assert.equal(evaluate(protocol, state, {none: [leaf]}), null);
});
test('档案-1：070年四角色组解析', () => {
  const state = S(p, '070');
  assert.deepEqual(['灯塔学徒', '白棠', '秦守', '周岚'].map(id => resolveProfile(p, state, id)), [
    {结果: '成立', 档案ID: '林澜·少年期'}, {结果: '成立', 档案ID: '白棠·少女期'},
    {结果: '成立', 档案ID: '秦守·守塔期'}, {结果: '未启用'}]);
});
test('档案-2：林汐在通过出师考核时切期', () => {
  assert.deepEqual(resolveProfile(p, S(p, '073', {角色组: {灯塔学徒: {版本ID: '林汐'}}}), '灯塔学徒'), {结果: '成立', 档案ID: '林汐·守塔期'});
});
test('档案-3：无前置链的成立档案按声明顺序报告冲突', async t => {
  const {protocol} = await changedProtocol(t, apprenticeGroup, group => { delete group.档案.find(profile => profile.档案ID === '林澜·守塔期').前置档案; });
  assert.deepEqual(resolveProfile(protocol, S(protocol, '074'), '灯塔学徒'), {结果: '冲突', 档案: ['林澜·学徒期', '林澜·守塔期']});
});
test('档案-4：封卷前读取', () => {
  assert.deepEqual(resolveProfile(p, {}, '灯塔学徒'), {结果: '未启用'});
  assert.deepEqual(eventStatus(p, {}, '拜师'), {状态: '未到'}); assert.equal(currentAbility(p, {}, '灯塔学徒'), null);
  assert.equal(chainStatus(p, {}, '学徒修习'), null); assert.deepEqual(pendingEvents(p, {}), []);
});
test('档案-5：可禁用待登记求解', () => {
  const state = S(p, '071-04-19'); state.世界.当前时间 = time('071-04-25');
  assert.deepEqual(resolveProfile(p, state, '灯塔学徒', {settle: false}), {结果: '成立', 档案ID: '林澜·学徒期'});
  assert.deepEqual(resolveProfile(p, state, '灯塔学徒'), {结果: '成立', 档案ID: '林澜·学徒期'});
});
test('读取-纯函数：全部读取不修改普通本局与待登记本局，返回值互不污染', () => {
  const pending = S(p, '071-04-19'); pending.世界.当前时间 = time('071-04-25');
  for (const state of [s72, pending]) {
    const before = structuredClone(state);
    evaluate(p, state, {事件确认: {事件ID: '大雾之夜'}}); pendingEvents(p, state); eventStatus(p, state, '大雾之夜');
    chainStatus(p, state, '雾夜余波'); resolveProfile(p, state, '灯塔学徒'); availableSkills(p, state, '灯塔学徒');
    const ability = currentAbility(p, state, '灯塔学徒'); ability.技艺.灯语 = '篡改';
    const preview = initializationPreview(p, state, '秦守'); preview.能力.技艺.灯语 = '篡改';
    assert.deepEqual(state, before);
  }
});
test('条件-未知字段：缺时间、缺剧情标记与三值组合', () => {
  const state = S(p, '070'); delete state.世界.当前时间; delete state.世界.剧情标记.灯塔状态;
  assert.equal(evaluate(p, state, {当前时间: {比较: '小于', 值: time('071')}}), null);
  assert.equal(evaluate(p, state, {none: [{剧情标记: {标记ID: '灯塔状态', 比较: '等于', 值: '运转'}}]}), null);
  assert.equal(evaluate(p, state, {all: [{角色启用: {角色组ID: '周岚'}}, {当前时间: {比较: '小于', 值: time('071')}}]}), false);
});

test('读取-校验：未知ID、非法成员与畸形本局不被默认为空', () => {
  for (const action of [() => eventStatus(p, s72, 'constructor'), () => initializationPreview(p, s72, '__proto__'),
    () => evaluate(p, s72, {角色启用: {角色组ID: 'constructor'}}), () => currentAbility(p, {开局: []}, '秦守'),
    () => pendingEvents(p, {...s72, 角色: []})]) assert.throws(action, errorCode('协议.参数'));
  const forged = structuredClone(s72); forged.事件.constructor = {状态: 2};
  assert.throws(() => eventStatus(p, forged, 'constructor'), errorCode('协议.参数'));
  const state = structuredClone(s72); state.角色.灯塔学徒.天赋 = ['灯语·短讯'];
  assert.throws(() => currentAbility(p, state, '灯塔学徒'), errorCode('协议.能力取值'));
});
test('读取-只读协议：外部目录变动不影响已创建协议', async () => {
  const {protocol, catalog, decl} = await loadProtocol();
  assert.equal(Object.isFrozen(protocol), true);
  catalog.events.length = 0; decl.marks.灯塔状态.length = 0;
  assert.deepEqual(S(protocol, '072').事件, records72);
});
test('条件-实力人数：达到人数优先、排除角色、未知和false的极性', () => {
  const state = W(p, S(p, '071-02-05'), {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}).state;
  for (const [value, expected] of [
    [{最低实力: '学徒', 最少人数: 1}, true], [{最低实力: '学徒', 最少人数: 2}, null],
    [{最低实力: '学徒', 最少人数: 1, 排除角色组: ['秦守']}, null],
  ]) {
    const leaf = {在场实力人数: value}; assert.equal(evaluate(p, state, leaf), expected);
    assert.equal(evaluate(p, state, {none: [leaf]}), expected === null ? null : !expected);
  }
  const roleplay = S(p, '071-02-05', {玩家: {模式: '扮演', 扮演角色组: '秦守'}});
  roleplay.世界.当前地点 = {地标: '灯塔', 场景: '值守室'};
  const initialized = p.confirmInitialization(roleplay, '秦守').state;
  const leaf = {在场实力人数: {最低实力: '名匠', 最少人数: 1}};
  assert.equal(evaluate(p, initialized, leaf), false); assert.equal(evaluate(p, initialized, {none: [leaf]}), true);
});

test('档案-共享边界：不借不适用的前置档案取代当前版本档案', async t => {
  const {protocol} = await changedProtocol(t, apprenticeGroup, group => {
    group.档案.find(profile => profile.档案ID === '林澜·学徒期').适用版本.push('林汐');
  });
  const state = S(protocol, '072', {角色组: {灯塔学徒: {版本ID: '林汐'}}});
  assert.deepEqual(resolveProfile(protocol, state, '灯塔学徒'), {结果: '冲突', 档案: ['林澜·学徒期', '林汐·学徒期']});
});
