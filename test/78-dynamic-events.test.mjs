import fs from 'node:fs/promises';
import {test, assert, path, project} from './helpers.mjs';
import {loadProtocol, S} from './protocol-helpers.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {applyCommands} from '../core/commands.mjs';
import {loadRouter, route} from '../core/router.mjs';
import {
  buildKeepRecord, createBookkeeper, isBetterOutcome, lostEffects, runKeeperLoop,
} from '../adapter/bookkeeper.mjs';

const full = (patch = {}) => ({
  时间: {方式: '不变', 日期: '', 事件ID: ''},
  地点: {地标: '', 场景: ''},
  在场: [],
  发生的事件: [],
  新情况: [],
  ...patch,
});

const syntheticEvent = (id, gate) => ({
  id,
  内容: {
    事件ID: id,
    事件标题: id,
    事件概要: `${id}概要。`,
    主类型: '日常',
    标签: ['雾港'],
    事件结果: ['关系变动'],
    触发时间: {最早: '潮历071年04月01日', 最晚: '潮历071年04月30日'},
    确认策略: '条件确认',
    核心参与者: ['灯塔学徒'],
    门槛: gate,
    默认分支: '发生',
    分支: [{分支ID: '发生', 分支条件: '条件成立时发生。', 分支结果: '发生。', 变化: []}],
  },
  角色位置: [],
});

test('YG-DYN-01-A2：实际参与者 Schema 枚举与端到端路由召回（自建/扮演/单人在场与非法参与者拒绝）', async () => {
  const {protocol, router} = await loadRouter(path.join(project, 'test/fixtures/雾港/世界书'), {fs, path});
  const keeper = createBookkeeper({protocol, catalog: router.catalog, decl: router.decl});

  // 1. 自建模式 Schema：包含所有已启用角色组与 '玩家'，不含未启用角色组
  const selfState = S(protocol, '071-04-01', {角色组: {周岚: {启用: false}}});
  const selfReq = keeper.request(selfState, {input: '', narration: '玩家与学徒在灯室约定暗号。'});
  const selfEnum = selfReq.schema.value.properties.新情况.items.properties.实际参与者.items.enum;
  assert.ok(selfEnum.includes('玩家'), '自建模式实际参与者应包含 玩家');
  assert.ok(selfEnum.includes('灯塔学徒') && selfEnum.includes('秦守'), '应包含已启用角色组');
  assert.ok(!selfEnum.includes('周岚'), '未启用角色组不得进入实际参与者枚举');

  // 2. 扮演模式 Schema：包含扮演角色组与其他已启用角色组，绝不含 '玩家'
  const rpBase = S(protocol, '071-04-01', {
    角色组: {周岚: {启用: false}},
    玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'},
  });
  const rpReq = keeper.request(rpBase, {input: '', narration: '学徒与秦守在灯室夜谈。'});
  const rpEnum = rpReq.schema.value.properties.新情况.items.properties.实际参与者.items.enum;
  assert.ok(rpEnum.includes('灯塔学徒') && rpEnum.includes('秦守'), '扮演模式应包含扮演角色组与其他已启用角色组');
  assert.ok(!rpEnum.includes('玩家'), '扮演模式实际参与者不得包含 玩家');
  assert.ok(!rpEnum.includes('周岚'), '扮演模式未启用角色组不得进入实际参与者枚举');

  // 3. 自建模式端到端：keeper.run 记入带 实际参与者 的动态事件，route() 在消息不提事件ID时凭 共同经历 召回
  const selfScene = applyCommands(protocol, selfState, [
    {确认初始化: {角色组ID: '灯塔学徒'}},
    {写场景: {当前地点: {地标: '灯塔', 场景: '灯室'}, 在场: {灯塔学徒: true}}},
  ]).state;
  const selfRun = keeper.run(selfScene, full({
    在场: ['灯塔学徒'],
    新情况: [{
      事件ID: '灯室立约',
      摘要: '学徒与玩家在灯室定下守夜暗号。',
      实际参与者: ['玩家', '灯塔学徒', '灯塔学徒'],
      结束事件串: '',
      变化: [],
    }],
  }));
  assert.deepEqual(selfRun.失败, []);
  assert.ok(selfRun.已写入.includes('灯室立约'));
  assert.deepEqual(selfRun.state.事件.灯室立约.实际参与者, ['玩家', '灯塔学徒'], '实际参与者应去重保序');
  const selfRouted = route(router, selfRun.state, ['今晚浪声很大，海风有些凉。']);
  const selfPicked = selfRouted.context.事件?.已确认经历?.find(item => item.事件ID === '灯室立约');
  assert.deepEqual(selfPicked, {
    事件ID: '灯室立约',
    摘要: '学徒与玩家在灯室定下守夜暗号。',
    实际时间: '潮历071年04月01日',
  });
  assert.equal(selfRouted.audit.经历.选入.find(item => item.事件ID === '灯室立约')?.理由, '共同经历');

  // 4. 扮演模式端到端：共同经历（扮演角色组 + 同伴在场）与 在场者经历（仅扮演角色组在场）
  const rpScene = applyCommands(protocol, rpBase, [
    {确认初始化: {角色组ID: '灯塔学徒'}},
    {确认初始化: {角色组ID: '秦守'}},
    {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}},
  ]).state;
  const rpRunShared = keeper.run(rpScene, full({
    在场: ['秦守'],
    新情况: [{
      事件ID: '校灯夜谈',
      摘要: '灯塔学徒与秦守校对灯芯并谈及旧账。',
      实际参与者: ['灯塔学徒', '秦守'],
      结束事件串: '',
      变化: [],
    }],
  }));
  assert.deepEqual(rpRunShared.失败, []);
  const rpRoutedShared = route(router, rpRunShared.state, ['窗外只有潮水声。']);
  assert.ok(rpRoutedShared.context.事件?.已确认经历?.some(
    item => item.事件ID === '校灯夜谈' && item.摘要 === '灯塔学徒与秦守校对灯芯并谈及旧账。' && item.实际时间 === '潮历071年04月01日',
  ));
  assert.equal(rpRoutedShared.audit.经历.选入.find(item => item.事件ID === '校灯夜谈')?.理由, '共同经历');

  // 秦守离场后记入仅含扮演角色组的动态事件：凭 在场者经历 召回
  const rpRunSolo = keeper.run(rpRunShared.state, full({
    在场: [],
    新情况: [{
      事件ID: '独守孤灯',
      摘要: '灯塔学徒独自擦拭镜面并记下潮汐刻度。',
      实际参与者: ['灯塔学徒'],
      结束事件串: '',
      变化: [],
    }],
  }));
  assert.deepEqual(rpRunSolo.失败, []);
  const rpRoutedSolo = route(router, rpRunSolo.state, ['天快亮了。']);
  assert.ok(rpRoutedSolo.context.事件?.已确认经历?.some(
    item => item.事件ID === '独守孤灯' && item.摘要 === '灯塔学徒独自擦拭镜面并记下潮汐刻度。',
  ));
  assert.equal(rpRoutedSolo.audit.经历.选入.find(item => item.事件ID === '独守孤灯')?.理由, '在场者经历');

  // 5. 扮演模式拒绝 '玩家' 与未启用角色组（Schema 拒绝 + toCommands 转换层防错）
  for (const [label, badParticipants] of [['扮演模式填玩家', ['玩家']], ['未启用角色组', ['周岚']]]) {
    assert.throws(
      () => keeper.run(rpScene, full({
        在场: ['秦守'],
        新情况: [{事件ID: '非法参与', 摘要: '不应写入。', 实际参与者: badParticipants, 结束事件串: '', 变化: []}],
      })),
      error => error.code === '记账.JSON' && /不在允许值内：新情况\[0\]\.实际参与者\[0\]/.test(error.message),
      label,
    );
    const conv = keeper.toCommands(rpScene, full({
      地点: {地标: '码头区', 场景: '栈桥'},
      在场: ['秦守'],
      新情况: [
        {事件ID: '非法参与', 摘要: '不应写入。', 实际参与者: badParticipants, 结束事件串: '', 变化: []},
        {事件ID: '合法同行', 摘要: '应保留。', 实际参与者: ['灯塔学徒', '秦守'], 结束事件串: '', 变化: []},
      ],
    }));
    assert.equal(conv.errors.length, 1, label);
    assert.ok(conv.commands.some(cmd => cmd.写场景?.当前地点?.地标 === '码头区'), `${label} 不应破坏同轮合法地点`);
    assert.ok(conv.commands.some(cmd => cmd.动态事件?.事件ID === '合法同行'), `${label} 不应破坏同轮合法动态事件`);
    assert.ok(!conv.commands.some(cmd => cmd.动态事件?.事件ID === '非法参与'), `${label} 不应生成非法动态事件`);
  }
});

test('YG-DYN-01-A3：结束事件串与记账 facts（进行中枚举、提前结束与下游门槛联动、非法拒绝）', async () => {
  const {protocol: baseProtocol, catalog: baseCatalog, decl} = await loadProtocol();

  // 构造带依赖 事件串状态: 已结束 的后续预设事件的内存副本，不修改夹具文件
  const catalog = structuredClone(baseCatalog);
  catalog.events.push(syntheticEvent('学徒另谋生路', {事件串状态: {事件串ID: '学徒修习', 状态: '已结束'}}));
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});

  // 1. 存在进行中事件串：facts 含 进行中事件串（事件串ID + 概述），schema 枚举含 '' 与进行中事件串 ID
  const ongoingState = S(protocol, '071-04-01');
  assert.equal(protocol.chainStatus(ongoingState, '学徒修习'), '进行中');
  assert.equal(protocol.chainStatus(ongoingState, '雾夜余波'), '未开始');
  assert.equal(protocol.eventStatus(ongoingState, '学徒另谋生路').状态, '不适用');

  const ongoingReq = keeper.request(ongoingState, {input: '', narration: '学徒向秦守辞行。'});
  assert.match(ongoingReq.prompts[0].content, /进行中事件串:/);
  assert.match(ongoingReq.prompts[0].content, /事件串ID: 学徒修习/);
  assert.match(ongoingReq.prompts[0].content, /概述: 学徒拜秦守为师，在灯塔学艺。/);
  assert.doesNotMatch(ongoingReq.prompts[0].content, /事件串ID: 雾夜余波/);
  assert.deepEqual(
    ongoingReq.schema.value.properties.新情况.items.properties.结束事件串.enum,
    ['', '学徒修习'],
  );

  // 2. 无进行中事件串：facts 为 []，schema 枚举仅为 ['']
  const idleState = S(protocol, '071-04-01', {历史选择: {拜师: '未拜师'}});
  assert.equal(protocol.chainStatus(idleState, '学徒修习'), '已结束');
  const idleReq = keeper.request(idleState, {input: '', narration: '平静的一天。'});
  assert.match(idleReq.prompts[0].content, /进行中事件串: \[\]/);
  assert.deepEqual(idleReq.schema.value.properties.新情况.items.properties.结束事件串.enum, ['']);

  // 3. 填入合法进行中 结束事件串：命令成功执行，事件串变为 已结束，依赖 事件串状态: 已结束 的预设事件即时成为 候选
  const endedRun = keeper.run(ongoingState, full({
    新情况: [{
      事件ID: '中途辞师',
      摘要: '学徒决定提前结束灯塔修习，离开师门。',
      实际参与者: ['灯塔学徒', '秦守'],
      结束事件串: '学徒修习',
      变化: [],
    }],
  }));
  assert.deepEqual(endedRun.失败, []);
  assert.ok(endedRun.已写入.includes('中途辞师'));
  assert.equal(endedRun.state.事件.中途辞师.结束事件串, '学徒修习');
  assert.equal(protocol.chainStatus(endedRun.state, '学徒修习'), '已结束');
  assert.equal(protocol.eventStatus(endedRun.state, '学徒另谋生路').状态, '候选');

  // 4. 非进行中或不存在的 结束事件串：Schema 拒绝；转换层报错误且不破坏同轮其他合法命令
  for (const badChain of ['雾夜余波', '不存在的事件串']) {
    assert.throws(
      () => keeper.run(ongoingState, full({
        新情况: [{事件ID: '乱结串', 摘要: '不应写入。', 实际参与者: ['灯塔学徒'], 结束事件串: badChain, 变化: []}],
      })),
      error => error.code === '记账.JSON' && /不在允许值内：新情况\[0\]\.结束事件串/.test(error.message),
      badChain,
    );
    const conv = keeper.toCommands(ongoingState, full({
      地点: {地标: '码头区', 场景: '栈桥'},
      新情况: [
        {事件ID: '乱结串', 摘要: '不应写入。', 实际参与者: ['灯塔学徒'], 结束事件串: badChain, 变化: []},
        {事件ID: '同轮合法事', 摘要: '记下合法事件。', 实际参与者: ['灯塔学徒'], 结束事件串: '', 变化: []},
      ],
    }));
    assert.equal(conv.errors.length, 1, badChain);
    assert.match(conv.errors[0], /新情况的结束事件串不在进行中/);
    assert.equal(conv.commands.length, 2, `${badChain} 不应破坏同轮其他合法命令`);
    const applied = applyCommands(protocol, ongoingState, conv.commands);
    assert.deepEqual(applied.失败, []);
    assert.equal(applied.state.世界.当前地点.地标, '码头区');
    assert.ok(applied.已写入.includes('同轮合法事'));
    assert.ok(!('乱结串' in applied.state.事件));
  }
  assert.equal(baseProtocol.chainStatus(S(baseProtocol, '071-04-01'), '学徒修习'), '进行中');
});

test('YG-DYN-01-A4：放行 变化: []、防倒退保护、校验边界与状态总线驱动后续预设事件', async () => {
  const {catalog: baseCatalog, decl} = await loadProtocol();
  const catalog = structuredClone(baseCatalog);
  catalog.events.push(
    syntheticEvent('熄灯应急', {剧情标记: {标记ID: '灯塔状态', 比较: '等于', 值: '熄灭'}}),
    syntheticEvent('师徒反目后续', {角色状态: {角色组ID: '秦守', 字段: '关系.灯塔学徒', 属于: ['疏远']}}),
    syntheticEvent('码头汇合', {角色状态: {角色组ID: '秦守', 字段: '所在', 属于: ['码头区']}}),
  );
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});
  const base = S(protocol, '071-04-01');

  // 0. RULES 收紧口径核对
  const req = keeper.request(base, {input: '', narration: '日常对话。'});
  assert.match(req.prompts[0].content, /宁缺毋滥/);
  assert.match(req.prompts[0].content, /实际参与者/);
  assert.match(req.prompts[0].content, /结束事件串/);
  assert.match(req.prompts[0].content, /可为空列表/);

  // 1. 放行 变化: [] 并受 runKeeperLoop / lostEffects / isBetterOutcome 防倒退保护
  const pureEvent = {
    事件ID: '纯剧情约定',
    摘要: '学徒与秦守约定次月大潮前修补雾号。',
    实际参与者: ['灯塔学徒', '秦守'],
    结束事件串: '',
    变化: [],
  };
  const pureRun = keeper.run(base, full({新情况: [pureEvent]}));
  assert.deepEqual(pureRun.失败, []);
  assert.ok(pureRun.已写入.includes('纯剧情约定'));
  assert.equal(pureRun.commands.length, 1);
  assert.deepEqual(pureRun.commands[0], {
    动态事件: {
      事件ID: '纯剧情约定',
      摘要: '学徒与秦守约定次月大潮前修补雾号。',
      实际参与者: ['灯塔学徒', '秦守'],
      变化: [],
    },
  });
  assert.equal(pureRun.state.事件.纯剧情约定.状态, 1);
  assert.deepEqual(pureRun.state.事件.纯剧情约定.实际参与者, ['灯塔学徒', '秦守']);

  const badEvent = {
    事件ID: '坏路径项',
    摘要: '触发协议失败。',
    实际参与者: ['灯塔学徒'],
    结束事件串: '',
    变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}],
  };
  const partialReply = JSON.stringify(full({新情况: [pureEvent, badEvent]}));
  const emptyReply = JSON.stringify(full({}));
  const partialOutcome = keeper.run(base, JSON.parse(partialReply));
  const emptyOutcome = keeper.run(base, JSON.parse(emptyReply));
  assert.ok(lostEffects(emptyOutcome, partialOutcome, base).includes('已写入：纯剧情约定'));
  assert.equal(isBetterOutcome(emptyOutcome, partialOutcome, base), false);

  let idx = 0;
  const loop = await runKeeperLoop({
    keeper, base, input: '', narration: '修补雾号的约定。',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2,
    call: async () => (idx++ === 0 ? partialReply : emptyReply),
  });
  const rec = buildKeepRecord({base, loop, config: {方式: '同一模型', 应答格式: '提示词'}, debugging: false});
  assert.equal(rec.记账.状态, '部分失败');
  assert.ok(rec.已写入.includes('纯剧情约定'));
  assert.equal(rec.命令.length, 1);
  assert.equal(rec.本局.事件.纯剧情约定.状态, 1);

  // 2. 校验边界：空 事件ID、与预设事件重名、空 摘要 仍报 记账.结果 且不写入
  const badMeta = keeper.run(base, full({
    新情况: [
      {事件ID: '  ', 摘要: '空ID', 实际参与者: [], 结束事件串: '', 变化: []},
      {事件ID: '拜师', 摘要: '与预设重名', 实际参与者: [], 结束事件串: '', 变化: []},
      {事件ID: '缺摘要事件', 摘要: '   ', 实际参与者: [], 结束事件串: '', 变化: []},
    ],
  }));
  assert.equal(badMeta.commands.length, 0);
  assert.equal(badMeta.失败.length, 3);
  assert.ok(badMeta.失败.every(item => item.错误码 === '记账.结果'));
  assert.ok(!('缺摘要事件' in badMeta.state.事件));

  // 3. 状态总线变化（世界.剧情标记.* / 角色.*.关系.* / 角色.*.所在）驱动读取该状态的后续预设事件成为 候选
  assert.equal(protocol.eventStatus(base, '熄灯应急').状态, '不适用');
  assert.equal(protocol.eventStatus(base, '师徒反目后续').状态, '不适用');
  assert.equal(protocol.eventStatus(base, '码头汇合').状态, '不适用');

  const busRun = keeper.run(base, full({
    新情况: [{
      事件ID: '夜班争执',
      摘要: '灯塔熄灭后秦守与学徒生隙，秦守独自前往码头区。',
      实际参与者: ['灯塔学徒', '秦守'],
      结束事件串: '',
      变化: [
        {路径: '世界.剧情标记.灯塔状态', 操作: '设定', 值: '熄灭'},
        {路径: '角色.秦守.关系.灯塔学徒', 操作: '设定', 值: '疏远'},
        {路径: '角色.秦守.所在', 操作: '设定', 值: '码头区'},
      ],
    }],
  }));
  assert.deepEqual(busRun.失败, []);
  assert.equal(busRun.state.世界.剧情标记.灯塔状态, '熄灭');
  assert.equal(busRun.state.角色.秦守.关系.灯塔学徒, '疏远');
  assert.equal(busRun.state.角色.秦守.所在, '码头区');
  assert.equal(protocol.eventStatus(busRun.state, '熄灯应急').状态, '候选');
  assert.equal(protocol.eventStatus(busRun.state, '师徒反目后续').状态, '候选');
  assert.equal(protocol.eventStatus(busRun.state, '码头汇合').状态, '候选');
});
