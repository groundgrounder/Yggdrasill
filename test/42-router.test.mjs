import {test, assert, fs, path, fixture, edit, remove, loadRouting, R0, U1, route, renderContext, messages,
  S, W, time, currentAbility, availableSkills, eventStatus, pendingEvents} from './router-helpers.mjs';

function ids(items = []) { return items.map(item => item.事件ID); }

test('R0：路由只读且结果稳定', async () => {
  const {protocol, router} = await loadRouting();
  const state = R0(protocol), before = structuredClone(state), first = route(router, state, messages), second = route(router, state, messages);
  assert.deepEqual(state, before); assert.deepEqual(first, second);
  assert.deepEqual(first.context.事件.已确认经历.map(item => item.事件ID), ['拜师', '夜间值守', '大雾之夜', '学徒守灯']);
  assert.deepEqual(first.context.事件.候选.map(item => item.事件ID), ['出师考核', '秦守讲旧事']);
  assert.deepEqual(first.context.被提及角色, [{角色组ID: '白棠', 显示名: '白棠', 别名: ['棠小姐']}]);
  assert.deepEqual(first.context.条目.技能.map(item => item.技能ID ?? item.说明), ['技能', '雾中视·辨影', '灯语', '灯语·长夜信号']);
  assert.deepEqual(first.context.条目.装备.map(item => item.装备ID ?? item.说明), ['装备', '工具·铜扳手']);
  assert.deepEqual(first.context.条目.地点.map(item => item.地点ID ?? item.说明), ['地点', '灯塔', '雾港', '北湾']);
  assert.equal(first.audit.条目.技能.略过.find(item => item.条目ID === '航海·夜航').原因, '不可用');
  assert.deepEqual(first.context.在场角色.map(item => item.角色组ID), ['灯塔学徒', '秦守', '玩家']);
  assert.deepEqual(first.context.在场角色[0].当前能力, currentAbility(protocol, state, '灯塔学徒'));
  assert.deepEqual(first.context.在场角色[0].可用技能, availableSkills(protocol, state, '灯塔学徒'));
  assert.deepEqual(first.context.事件.候选[0].分支.map(item => item.分支ID), eventStatus(protocol, state, '出师考核').分支);
});

test('R1：渲染顺序、原文部分与自定义标签', async () => {
  const {protocol, router} = await loadRouting();
  const result = route(router, R0(protocol), messages), rendered = renderContext(result.context);
  const order = ['协议', '世界概况', '世界状态', '在场角色', '被提及角色', '条目', '事件'].map(name => rendered.indexOf(`<${name}>`));
  assert.ok(order.every((position, index) => index === 0 || position > order[index - 1]));
  assert.ok(rendered.includes(`<协议>\n${result.context.协议}\n</协议>`));
  assert.ok(rendered.includes(`<世界概况>\n${result.context.世界概况}\n</世界概况>`));
  const custom = renderContext(result.context, Object.fromEntries(Object.keys(result.context).map(key => [key, `自定义${key}`])));
  assert.ok(custom.includes('<自定义协议>')); assert.ok(!custom.includes('<协议>'));
  const yamlPart = rendered.match(/<世界状态>\n([\s\S]*?)\n<\/世界状态>/u)[1];
  const {parseYaml} = await import('../core/yaml.mjs'); assert.deepEqual(parseYaml(yamlPart), result.context.世界状态);
});

test('R2a-e：经历、候选、条目预算按整项与摘要规则处理', async () => {
  const cases = [
    [{经历: {条数: 2}}, ['拜师', '夜间值守'], []],
    [{经历: {字符: 220}}, ['拜师', '夜间值守'], ['拜师']],
    [{候选: {条数: 1}}, ['出师考核'], []],
    [{候选: {条数: 0}}, [], ['拜师', '学徒守灯', '夜间值守', '大雾之夜']],
    [{条目字符: {技能: 184}}, ['雾中视·辨影'], ['灯语·长夜信号']],
  ];
  for (const [settings, expected, secondary] of cases) {
    const {protocol, router} = await loadRouting(undefined, settings), result = route(router, R0(protocol), messages);
    if (settings.经历?.字符 === 220) {
      assert.deepEqual(ids(result.context.事件.已确认经历), expected);
      assert.equal(result.context.事件.已确认经历.find(item => item.事件ID === '拜师').角色位置, undefined);
    } else if (settings.候选) assert.deepEqual(ids(result.context.事件.候选), expected);
    else if (settings.条目字符) assert.deepEqual(result.context.条目.技能.filter(item => item.技能ID).map(item => item.技能ID), expected);
    else if (settings.候选?.条数 === 0) {
      assert.deepEqual(ids(result.context.事件.已确认经历), ['拜师', '夜间值守', '学徒守灯', '大雾之夜']);
      assert.deepEqual(result.audit.经历.选入.map(item => item.事件ID), secondary);
    } else assert.deepEqual(ids(result.context.事件.已确认经历), expected);
    if (secondary.length && settings.条目字符) assert.equal(result.audit.条目.技能.略过[0].原因, '超出字符');
  }
});

test('R3：待登记作为已发生状态输出但不进入已确认经历', async () => {
  const {protocol, router} = await loadRouting(), result = route(router, U1(protocol), []);
  assert.deepEqual(ids(result.context.事件.待登记), ['大雾之夜', '学徒守灯', '白棠在码头']);
  assert.ok(result.context.事件.待登记.every(item => item.已经发生 === true && item.角色位置 === undefined));
  assert.equal(result.context.事件.已确认经历, undefined);
  assert.deepEqual(pendingEvents(protocol, U1(protocol)).map(item => item.事件ID), ids(result.context.事件.待登记));
  assert.deepEqual(result.context.世界状态.进行中事件串.map(item => item.事件串ID), ['学徒修习']);
});

test('R6-R7：有效本局缓存、档案异常与显式初始化', async t => {
  const {protocol, router} = await loadRouting(), state = R0(protocol), baseline = route(router, state, messages);
  assert.deepEqual(baseline.context.事件.候选[0].分支.map(item => item.分支ID), eventStatus(protocol, state, '出师考核').分支);
  const root = await fixture(t);
  await edit(root, '角色/灯塔学徒/角色组.yaml', group => { delete group.档案.find(item => item.档案ID === '林澜·学徒期').前置档案; });
  const changed = await loadRouting(root), result = route(changed.router, R0(changed.protocol), messages);
  assert.deepEqual(result.context.在场角色.find(item => item.角色组ID === '灯塔学徒'), {角色组ID: '灯塔学徒', 显示名: '林澜'});
  assert.ok(result.audit.异常.some(item => item.类型 === '档案冲突'));
  assert.equal(result.context.事件.待初始化, undefined);
});

test('R8：扮演模式没有玩家项，扮演角色标记并列待初始化', async () => {
  const {protocol, router} = await loadRouting(), state = W(protocol, S(protocol, '072', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}}),
    {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}).state, result = route(router, state, messages);
  const player = result.context.在场角色.find(item => item.角色组ID === '灯塔学徒');
  assert.equal(player.玩家扮演, true); assert.equal(result.context.在场角色.some(item => item.角色组ID === '玩家'), false);
  assert.deepEqual(result.context.事件.待初始化.map(item => item.角色组ID), ['灯塔学徒']);
});

test('R9：自建玩家档案、地点链与地点相关经历', async () => {
  const {protocol, router} = await loadRouting(), state = W(protocol, S(protocol, '072', {玩家: {模式: '自建', 档案: {姓名: '海生', 出生年: '潮历050年'}}}),
    {当前地点: {地标: '码头区', 场景: '栈桥'}}).state, result = route(router, state, []);
  const player = result.context.在场角色[0];
  assert.deepEqual(player, {...player, 角色组ID: '玩家', 显示名: '海生', 年龄: 22, 档案: {姓名: '海生', 出生年: '潮历050年'}});
  assert.deepEqual(result.context.条目.地点.map(item => item.地点ID ?? item.说明), ['地点', '码头区', '雾港', '北湾']);
  assert.deepEqual(ids(result.context.事件.已确认经历), ['大雾之夜', '白棠在码头']);
  assert.equal(result.context.事件.候选, undefined);
});

test('路由边界：消息、状态与未知地点异常', async () => {
  const {protocol, router} = await loadRouting(), state = R0(protocol);
  assert.throws(() => route(router, state, '消息'));
  assert.throws(() => route(router, state, [1]));
  const changed = structuredClone(state); changed.世界.当前地点.地标 = '未知地点';
  const result = route(router, changed, []); assert.ok(result.audit.异常.some(item => item.类型 === '地点异常'));
});
