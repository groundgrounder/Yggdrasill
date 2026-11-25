import {test, assert, fs, path, project, fixture, edit, remove, read, example, eventFile, loadRouting, R0, U1, route, renderContext, messages,
  S, W, C, D, time, currentAbility, availableSkills, eventStatus, pendingEvents} from './router-helpers.mjs';

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
    [{经历: {字符: 220}}, ['夜间值守'], ['拜师']],
    [{经历: {字符: 246}}, ['拜师', '夜间值守'], []],
    [{候选: {条数: 1}}, ['出师考核'], []],
    [{候选: {条数: 0}}, [], ['拜师', '学徒守灯', '夜间值守', '大雾之夜']],
    [{条目字符: {技能: 184}}, ['雾中视·辨影'], ['灯语·长夜信号']],
  ];
  for (const [settings, expected, secondary] of cases) {
    const {protocol, router} = await loadRouting(undefined, settings), result = route(router, R0(protocol), messages);
    if (settings.经历?.字符 === 220) {
      assert.deepEqual(ids(result.context.事件.已确认经历), expected);
      assert.equal(result.audit.经历.略过.find(item => item.事件ID === '拜师').原因, '超出字符');
      assert.equal(result.audit.经历.字符, 110);
    } else if (settings.经历?.字符 === 246) {
      // 拜师完整形式 372 字符放不下，去掉角色位置后 136 字符恰好放下
      assert.deepEqual(ids(result.context.事件.已确认经历), expected);
      assert.equal(result.context.事件.已确认经历.find(item => item.事件ID === '拜师').角色位置, undefined);
      assert.equal(result.audit.经历.选入.find(item => item.事件ID === '拜师').形式, '摘要');
      assert.equal(result.audit.经历.字符, 246);
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
  const source = await read(example, eventFile('大雾之夜')), fog = result.context.事件.待登记[0];
  assert.equal(fog.影响范围, source.影响范围);
  assert.deepEqual(Object.keys(fog), ['事件ID', '事件标题', '事件概要', '影响范围', '实际时间', '分支结果', '公开信息', '隐秘信息', '已经发生']);
  assert.ok(result.context.事件.待登记.slice(1).every(item => !Object.hasOwn(item, '影响范围')));
  assert.ok(result.context.事件.待登记.every(item => item.已经发生 === true && item.角色位置 === undefined));
  assert.equal(result.context.事件.已确认经历, undefined);
  assert.deepEqual(pendingEvents(protocol, U1(protocol)).map(item => item.事件ID), ids(result.context.事件.待登记));
  assert.deepEqual(result.context.世界状态.进行中事件串.map(item => item.事件串ID), ['学徒修习']);
});

test('R4：已确认经历保留源文件的影响范围，未写时省略整键', async () => {
  const {protocol, router} = await loadRouting(), result = route(router, R0(protocol), messages);
  for (const id of ['大雾之夜', '拜师']) {
    const source = await read(example, eventFile(id)), item = result.context.事件.已确认经历.find(item => item.事件ID === id);
    assert.equal(item.影响范围, source.影响范围);
    assert.deepEqual(Object.keys(item).slice(0, 5), ['事件ID', '事件标题', '事件概要', '影响范围', '实际时间']);
  }
  assert.ok(result.context.事件.已确认经历.filter(item => !['大雾之夜', '拜师'].includes(item.事件ID))
    .every(item => !Object.hasOwn(item, '影响范围')));
  assert.ok(result.context.事件.候选.every(item => !Object.hasOwn(item, '影响范围')));
});

for (const [id, date] of [['大雾之夜', '071-04-20'], ['拜师', '071-01-10']]) {
  test(`R5：${id}作为候选时在概要与叙事条件之间输出影响范围`, async t => {
    const root = await fixture(t), source = await read(root, eventFile(id));
    await edit(root, eventFile(id), event => { event.叙事条件 = '须由叙事模型判断现场是否适合发生。'; });
    const {protocol, router} = await loadRouting(root);
    const state = W(protocol, S(protocol, date), {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}).state;
    assert.equal(eventStatus(protocol, state, id).状态, '候选');
    const result = route(router, state, []), item = result.context.事件.候选.find(item => item.事件ID === id);
    assert.equal(item.影响范围, source.影响范围);
    assert.equal(item.叙事条件, '须由叙事模型判断现场是否适合发生。');
    assert.deepEqual(Object.keys(item).slice(0, 5), ['事件ID', '事件标题', '事件概要', '影响范围', '叙事条件']);
  });
}

test('路由边界：动态事件仍只输出事件ID、摘要与实际时间', async () => {
  const {protocol, router} = await loadRouting();
  const state = D(protocol, R0(protocol), [], {事件ID: '学徒自省', 摘要: '学徒回想守灯的经历。', 实际参与者: ['灯塔学徒']}).state;
  const item = route(router, state, []).context.事件.已确认经历.find(item => item.事件ID === '学徒自省');
  assert.deepEqual(item, {事件ID: '学徒自省', 摘要: '学徒回想守灯的经历。', 实际时间: state.事件.学徒自省.实际时间});
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

test('ROUTE-F04-1：所走分支专属文本覆盖顶层，未声明回退，待登记同口径', async t => {
  const root = await fixture(t);
  await edit(root, eventFile('大雾之夜'), event => {
    event.事件概要 = '顶层大事概要。';
    event.影响范围 = '顶层大事范围。';
    event.公开信息 = ['顶层公开消息。'];
    event.隐秘信息 = ['顶层隐秘消息。'];
    Object.assign(event.分支.find(item => item.分支ID === '发生'),
      {事件概要: '发生分支概要。', 影响范围: '发生分支范围。', 公开信息: ['发生分支公开。'], 隐秘信息: ['发生分支隐秘。']});
    event.分支.push({分支ID: '未发生', 分支条件: '雾没有压进港镇。', 分支结果: '灯塔整夜亮着。', 影响范围: '未发生分支范围。', 变化: []});
  });
  const {protocol, router} = await loadRouting(root);
  const base = W(protocol, S(protocol, '071-04-19'), {当前时间: time('071-04-20')}).state;
  const historyItem = state => route(router, state, ['听说大雾之夜出事了。']).context.事件.已确认经历
    .find(item => item.事件ID === '大雾之夜');
  const occurred = historyItem(C(protocol, base, '大雾之夜', '发生').state);
  assert.deepEqual(Object.keys(occurred), ['事件ID', '事件标题', '事件概要', '影响范围', '实际时间', '分支结果', '公开信息', '隐秘信息']);
  assert.equal(occurred.事件概要, '发生分支概要。');
  assert.equal(occurred.影响范围, '发生分支范围。');
  assert.deepEqual(occurred.公开信息, ['发生分支公开。']);
  assert.deepEqual(occurred.隐秘信息, ['发生分支隐秘。']);

  // 未声明专属字段的分支逐项回退顶层，声明了的字段仍覆盖。
  const skipped = historyItem(C(protocol, base, '大雾之夜', '未发生').state);
  assert.equal(skipped.事件概要, '顶层大事概要。');
  assert.equal(skipped.影响范围, '未发生分支范围。');
  assert.deepEqual(skipped.公开信息, ['顶层公开消息。']);
  assert.deepEqual(skipped.隐秘信息, ['顶层隐秘消息。']);

  const late = structuredClone(base); late.世界.当前时间 = time('071-04-25');
  const pending = route(router, late, []).context.事件.待登记.find(item => item.事件ID === '大雾之夜');
  assert.equal(pending.事件概要, '发生分支概要。');
  assert.equal(pending.影响范围, '发生分支范围。');
  assert.deepEqual(pending.公开信息, ['发生分支公开。']);
  assert.deepEqual(pending.隐秘信息, ['发生分支隐秘。']);
  assert.equal(pending.已经发生, true);
});

test('ROUTE-F04-2：候选只输出事件顶层文本与分支三字段，绝不泄出分支专属文本', async t => {
  const root = await fixture(t);
  await edit(root, eventFile('秦守讲旧事'), event => {
    event.影响范围 = '顶层旧事范围。';
    for (const branch of event.分支) Object.assign(branch,
      {事件概要: '分支概要。', 影响范围: '分支范围。', 公开信息: ['分支公开。'], 隐秘信息: ['分支隐秘。']});
  });
  const {protocol, router} = await loadRouting(root);
  const candidate = route(router, R0(protocol), messages).context.事件.候选.find(item => item.事件ID === '秦守讲旧事');
  assert.equal(candidate.事件概要, '秦守在值守室讲起年轻时在雾里救人的经历，并示范辨认灯号。');
  assert.equal(candidate.影响范围, '顶层旧事范围。');
  assert.ok(candidate.分支.length > 0);
  for (const branch of candidate.分支) assert.deepEqual(Object.keys(branch), ['分支ID', '分支条件', '分支结果']);
  assert.ok(!Object.hasOwn(candidate, '隐秘信息'));
  assert.ok(!JSON.stringify(candidate).includes('分支概要。'));
  assert.ok(!JSON.stringify(candidate).includes('分支公开。'));
});


test('ROUTE-F09a-1：默认预算下雾港在场角色全部完整，审计与既有输出形状不变', async () => {
  const {protocol, router} = await loadRouting(), result = route(router, R0(protocol), messages);
  assert.deepEqual(result.audit.在场角色.预算, {完整人数: 6, 字符: 12000});
  assert.deepEqual(result.audit.在场角色.选入.map(item => [item.角色组ID, item.形式]),
    [['灯塔学徒', '完整'], ['秦守', '完整'], ['玩家', '完整']]);
  assert.equal(result.audit.在场角色.字符, result.audit.在场角色.选入.reduce((sum, item) => sum + item.字符, 0));
  for (const item of result.context.在场角色) assert.ok(Object.hasOwn(item, '档案'));
});

test('ROUTE-F09a-2：玩家最优先，完整名额耗尽后按码点降为精简，档案只留四项与两项', async () => {
  const {protocol, router} = await loadRouting(undefined, {在场角色: {完整人数: 1}}), result = route(router, R0(protocol), messages);
  assert.deepEqual(result.audit.在场角色.选入.map(item => [item.角色组ID, item.形式]),
    [['灯塔学徒', '精简'], ['秦守', '精简'], ['玩家', '完整']]);
  const apprentice = result.context.在场角色.find(item => item.角色组ID === '灯塔学徒');
  assert.deepEqual(Object.keys(apprentice), ['角色组ID', '显示名', '年龄', '档案', '当前能力', '可用技能', '本局状态']);
  assert.deepEqual(Object.keys(apprentice.档案), ['基本信息', '角色印象']);
  assert.deepEqual(Object.keys(apprentice.档案.基本信息), ['姓名', '称号', '性别', '种族']);
  assert.deepEqual(Object.keys(apprentice.档案.角色印象), ['核心身份', '表现禁区']);

  const compactAll = await loadRouting(undefined, {在场角色: {完整人数: 0}}), compact = route(compactAll.router, R0(compactAll.protocol), messages);
  const player = compact.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.deepEqual(Object.keys(player), ['角色组ID', '显示名', '当前能力', '可用技能']);
  assert.ok(compact.audit.在场角色.选入.every(item => item.形式 === '精简'));

  const minimal = await loadRouting(undefined, {在场角色: {完整人数: 0, 字符: 0}}), least = route(minimal.router, R0(minimal.protocol), messages);
  assert.ok(least.audit.在场角色.选入.every(item => item.形式 === '最小'));
  assert.deepEqual(least.context.在场角色.map(item => item.角色组ID), ['灯塔学徒', '秦守', '玩家']);
  for (const item of least.context.在场角色) {
    assert.equal(Object.hasOwn(item, '档案'), false);
    assert.equal(Object.hasOwn(item, '当前能力'), false);
    assert.equal(Object.hasOwn(item, '可用技能'), false);
  }
});

test('ROUTE-F09a-3：三国 12 人同场默认分级压缩、提及优先且顺序与人员不丢', async () => {
  const root = path.join(project, 'examples/三国演义/世界书'), ids = ['刘备', '关羽', '张飞', '曹操', '袁绍', '袁术', '吕布', '董卓', '孙坚', '卢植', '皇甫嵩'];
  const send = (protocol, router, text = []) => route(router, W(protocol, S(protocol, null, {开局时间: '中平001年04月02日'}),
    {当前地点: {地标: '涿县', 场景: '张榜处'}, 在场: Object.fromEntries(ids.map(id => [id, true]))}).state, text);
  const loaded = await loadRouting(root), tight = send(loaded.protocol, loaded.router);
  const fullLoaded = await loadRouting(root, {在场角色: {完整人数: 999, 字符: 999999}}), full = send(fullLoaded.protocol, fullLoaded.router);
  const expected = [...ids].sort(), actual = tight.context.在场角色.map(item => item.角色组ID);
  assert.deepEqual(actual, [...expected, '玩家']);
  assert.deepEqual(tight.audit.在场角色.选入.map(item => item.角色组ID), actual);
  assert.deepEqual(full.audit.在场角色.选入.map(item => item.角色组ID), actual);
  const forms = tight.audit.在场角色.选入.map(item => item.形式);
  assert.equal(forms.filter(form => form === '完整').length, 6);
  assert.equal(forms.filter(form => form === '精简').length, 6);
  assert.ok(tight.audit.在场角色.字符 < full.audit.在场角色.字符);
  const compact = tight.context.在场角色.find(item => tight.audit.在场角色.选入.find(entry => entry.角色组ID === item.角色组ID).形式 === '精简');
  assert.deepEqual(Object.keys(compact.档案.基本信息).every(key => ['姓名', '称号', '性别', '种族'].includes(key)), true);
  assert.deepEqual(Object.keys(compact.档案.角色印象).every(key => ['核心身份', '表现禁区'].includes(key)), true);

  const mentionedLoaded = await loadRouting(root, {在场角色: {完整人数: 2}});
  const mentioned = send(mentionedLoaded.protocol, mentionedLoaded.router, ['董卓在远处观望。']);
  const chosen = mentioned.audit.在场角色.选入;
  assert.equal(chosen.find(item => item.角色组ID === '玩家').形式, '完整');
  assert.equal(chosen.find(item => item.角色组ID === '董卓').形式, '完整');
  assert.equal(chosen.find(item => item.角色组ID === '关羽').形式, '精简');
});
