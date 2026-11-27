import {
  test, assert, fs, path, fixture, read, write, edit, equipment, finding, hint, assertFindings,
} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {checkText} from '../checker/rules/text.mjs';
import {
  compileWorldbook, createProtocol, createRouter, route, roleplayBaseline,
  checkChange, formatYamlText, loadRouter,
} from '../core/index.mjs';

async function compile(root) {
  const result = await compileWorldbook(root, {fs, path});
  const errors = result.issues.filter(item => item.级别 === '错误');
  assert.deepEqual(errors, [], `编译不应报错：${JSON.stringify(errors)}`);
  return result;
}

test('YG-CUST-01-A2：装备唯一字段检查、重复声明拦截、格式化排序与文本扫描无误报', async t => {
  const root = await fixture(t);

  // 1. 唯一: true / 唯一: false 通过全量检查（0 错误）且 checkText 0 误报
  await edit(root, equipment, value => { value.唯一 = true; });
  await edit(root, '装备/灯具/灯具·风暴灯.txt', value => { value.唯一 = false; });
  const ok = await checkWorldbook(root);
  assertFindings(ok, [], '装备写唯一布尔应零错误零提示');

  const {catalog, decl} = await compile(root);
  const textIssues = checkText(catalog, decl).filter(item => item.文件 === equipment || item.文件 === '装备/灯具/灯具·风暴灯.txt');
  assert.deepEqual(textIssues, [], 'checkText 不得对唯一键产生误报');

  // 2. formatYamlText 将唯一排在 装备ID/名称 之后、其余声明字段之前且二次幂等
  const rawEquip = [
    '效果:',
    '  - 拧动螺帽时比徒手省力。',
    '装备等级: 学徒',
    '唯一: true',
    '标签: 工具',
    '装备ID: 工具·铜扳手',
    '名称: 铜扳手',
    '简介: 柄端有细锉纹的铜制扳手，用于拧紧灯架小螺帽。',
    '',
  ].join('\n');
  const first = formatYamlText(rawEquip, {
    kind: {种类: '条目', 库: '装备', 路径: ['装备', '工具', '工具·铜扳手.txt'], 文件名: '工具·铜扳手'},
    libraries: decl.libraries,
  });
  const lines = first.text.split('\n').filter(line => !line.startsWith(' ') && line.includes(':')).map(line => line.split(':')[0]);
  assert.deepEqual(lines, ['装备ID', '名称', '唯一', '标签', '装备等级', '简介', '效果']);
  const second = formatYamlText(first.text, {
    kind: {种类: '条目', 库: '装备', 路径: ['装备', '工具', '工具·铜扳手.txt'], 文件名: '工具·铜扳手'},
    libraries: decl.libraries,
  });
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);

  // 3. 非布尔唯一报 条目.形态
  await edit(root, equipment, value => { value.唯一 = '是'; });
  const badType = await checkWorldbook(root, {staticOnly: true});
  assertFindings(badType, [
    finding('条目.形态', equipment, {说明: ['唯一须为布尔']}),
    hint('抽样.未执行', '历史'),
  ], '非布尔唯一应报条目.形态');

  // 4. 在 设定/条目库.yaml 重复声明装备.字段.唯一报 设定.字段声明
  await edit(root, equipment, value => { value.唯一 = true; });
  await edit(root, '设定/条目库.yaml', value => {
    value.装备.字段.唯一 = {形态: '文本'};
  });
  const dupDecl = await checkWorldbook(root, {staticOnly: true});
  assert.ok(dupDecl.errors.some(item => item.规则 === '设定.字段声明' && item.文件 === '设定/条目库.yaml' && item.说明.includes('唯一')),
    `重复声明装备.唯一应报设定.字段声明：${JSON.stringify(dupDecl.errors)}`);
});

test('YG-CUST-01-A3：唯一装备全本局强制唯一归属（封卷剥离、初始化跳过、预设不强抢、动态/设定移交、非唯一共存）', async t => {
  const root = await fixture(t);
  // 将 工具·铜扳手 标为 唯一: true，灯具·风暴灯 保持非唯一
  await edit(root, equipment, value => { value.唯一 = true; });

  // 新增两个测试预设事件：
  // 1) 历史事件 传授扳手（海历009年）：自动确认给 秦守 新增 工具·铜扳手
  await write(root, '历史/事件/传授扳手/事件.txt', {
    事件ID: '传授扳手',
    事件概要: '秦守收下铜扳手。',
    主类型: '变动',
    标签: ['日常'],
    事件结果: ['持物变化'],
    触发时间: {最早: '潮历069年', 最晚: '潮历069年'},
    地点: ['灯塔'],
    确认策略: '自动确认',
    核心参与者: ['秦守'],
    默认分支: '收下',
    分支: [{
      分支ID: '收下',
      分支条件: '秦守收下扳手。',
      分支结果: '秦守持有铜扳手。',
      变化: [{路径: '角色.秦守.装备.工具·铜扳手', 操作: '新增', 值: {状态: '完好', 位置: '工具箱'}}],
    }],
  });
  // 2) 后续事件 补发扳手（海历010年05月01日）：分支一用 新增 给秦守，分支二用 设定 给周岚
  await write(root, '历史/事件/补发扳手/事件.txt', {
    事件ID: '补发扳手',
    事件概要: '灯塔清点工具。',
    主类型: '变动',
    标签: ['日常'],
    事件结果: ['持物变化'],
    触发时间: {最早: '潮历070年02月01日', 最晚: '潮历070年02月01日'},
    地点: ['灯塔'],
    确认策略: '仅作候选',
    核心参与者: ['秦守', '周岚'],
    默认分支: '新增不抢',
    分支: [
      {
        分支ID: '新增不抢',
        分支条件: '按惯例补发给秦守。',
        分支结果: '尝试新增给秦守。',
        变化: [{路径: '角色.秦守.装备.工具·铜扳手', 操作: '新增', 值: {状态: '完好', 位置: '腰间'}}],
      },
      {
        分支ID: '设定移交',
        分支条件: '显式交接给周岚。',
        分支结果: '周岚接管铜扳手。',
        变化: [{路径: '角色.周岚.装备.工具·铜扳手', 操作: '设定', 值: {状态: '完好', 位置: '工棚'}}],
      },
    ],
  });

  const {catalog, decl} = await compile(root);
  const protocol = createProtocol({catalog, decl});

  // 1. 封卷剥离（自建模式）：海历010年05月01日开局，历史事件 传授扳手 已把 工具·铜扳手 发给 秦守；
  // 玩家开局同时选了唯一的 工具·铜扳手 和非唯一的 灯具·风暴灯
  const sealed = protocol.seal({
    开局时间: '潮历070年02月01日',
    角色组: {周岚: {启用: true, 版本ID: '周岚'}},
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      初始装备: [
        {装备ID: '工具·铜扳手', 状态: '完好', 位置: '玩家腰包'},
        {装备ID: '灯具·风暴灯', 状态: '完好', 位置: '玩家提手'},
      ],
    },
  });
  assert.equal(sealed.事件.传授扳手?.状态, 1);
  assert.deepEqual(sealed.角色.玩家.装备['工具·铜扳手'], {状态: '完好', 位置: '玩家腰包'});
  assert.equal(Object.hasOwn(sealed.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false, '封卷末尾应剥离原主的唯一装备');

  // 2. 初始化跳过：秦守档案初始装备含 工具·铜扳手，预览与确认/出场自动初始化均应跳过
  const preview = protocol.initializationPreview(sealed, '秦守');
  assert.equal(preview.装备.some(item => item.装备ID === '工具·铜扳手'), false, '初始化预览应跳过已被他人持有的唯一装备');
  const {state: afterInit} = protocol.confirmInitialization(sealed, '秦守');
  assert.equal(Object.hasOwn(afterInit.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false, '确认初始化不得补发唯一装备');
  assert.equal(afterInit.角色.秦守.已初始化, true);

  // 非唯一装备共存：封卷到海历016年（灯塔学徒守塔期，初始装备 灯具·风暴灯），玩家与灯塔学徒可同时持有
  const nonUniqueState = protocol.seal({
    开局时间: '潮历074年',
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      初始装备: [{装备ID: '灯具·风暴灯', 状态: '完好', 位置: '玩家背包'}],
    },
  });
  const {state: afterApprenticeInit} = protocol.confirmInitialization(nonUniqueState, '灯塔学徒');
  assert.ok(afterApprenticeInit.角色.玩家.装备['灯具·风暴灯']);
  assert.ok(afterApprenticeInit.角色.灯塔学徒.装备['灯具·风暴灯'], '非唯一装备应允许双方共存');

  // 3. 预设事件 新增 不强抢：确认 补发扳手/新增不抢，玩家仍持有、秦守不得获得
  const {state: afterPresetAdd} = protocol.confirmEvent(afterInit, {事件ID: '补发扳手', 分支ID: '新增不抢'});
  assert.deepEqual(afterPresetAdd.角色.玩家.装备['工具·铜扳手'], {状态: '完好', 位置: '玩家腰包'});
  assert.equal(Object.hasOwn(afterPresetAdd.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false);

  // 4. 预设事件显式 设定 移交：确认 补发扳手/设定移交，周岚获得、玩家自动移除
  const {state: afterPresetSet} = protocol.confirmEvent(afterInit, {事件ID: '补发扳手', 分支ID: '设定移交'});
  assert.deepEqual(afterPresetSet.角色.周岚.装备['工具·铜扳手'], {状态: '完好', 位置: '工棚'});
  assert.equal(Object.hasOwn(afterPresetSet.角色.玩家?.装备 ?? {}, '工具·铜扳手'), false);

  // 5. 动态事件 新增 / 设定 移交：动态事件将 工具·铜扳手 新增给 秦守，自动从 周岚 移除
  const {state: afterDynAdd} = protocol.confirmDynamicEvent(afterPresetSet, {
    事件ID: '借用铜扳手',
    摘要: '秦守从周岚处取回铜扳手。',
    实际参与者: ['秦守', '周岚'],
    变化: [{路径: '角色.秦守.装备.工具·铜扳手', 操作: '新增', 值: {状态: '破损', 位置: '工具袋'}}],
  });
  assert.deepEqual(afterDynAdd.角色.秦守.装备['工具·铜扳手'], {状态: '破损', 位置: '工具袋'});
  assert.equal(Object.hasOwn(afterDynAdd.角色.周岚?.装备 ?? {}, '工具·铜扳手'), false);

  // 动态事件 设定 移交给玩家，自动从秦守移除
  const {state: afterDynSet} = protocol.confirmDynamicEvent(afterDynAdd, {
    事件ID: '归还铜扳手',
    摘要: '秦守将铜扳手交回玩家。',
    实际参与者: ['秦守', '玩家'],
    变化: [{路径: '角色.玩家.装备.工具·铜扳手', 操作: '设定', 值: {状态: '完好', 位置: '怀中'}}],
  });
  assert.deepEqual(afterDynSet.角色.玩家.装备['工具·铜扳手'], {状态: '完好', 位置: '怀中'});
  assert.equal(Object.hasOwn(afterDynSet.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false);

  // 6. 扮演模式封卷剥离：扮演周岚并选中 额外装备 工具·铜扳手，历史事件中秦守持有的 工具·铜扳手 被自动剥离
  const rpSealed = protocol.seal({
    开局时间: '潮历070年02月01日',
    角色组: {周岚: {启用: true, 版本ID: '周岚'}},
    玩家: {
      模式: '扮演',
      扮演角色组: '周岚',
      额外装备: [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰间'}],
    },
  });
  assert.deepEqual(rpSealed.角色.周岚.装备['工具·铜扳手'], {状态: '完好', 位置: '腰间'});
  assert.equal(Object.hasOwn(rpSealed.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false);
});

test('YG-CUST-01-A4：双模式自定义装备落盘、动态事件记账追踪与严格校验拒绝', async t => {
  const root = await fixture(t);
  const {catalog, decl} = await compile(root);
  const protocol = createProtocol({catalog, decl});

  const customItem = {名称: '祖传怀表', 说明: '黄铜外壳的旧怀表，表盖内侧刻有航道标尺。', 状态: '完好', 位置: '贴身内袋'};

  // 1. 自建模式带自定义装备封卷成功
  const customState = protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {姓名: '阿客'}, 自定义装备: [customItem]},
  });
  assert.equal(customState.角色.玩家.已初始化, true);
  assert.deepEqual(customState.角色.玩家.装备['祖传怀表'], {状态: '完好', 位置: '贴身内袋'});

  // 2. 动态事件修改状态/位置、移除并移交给已启用 NPC
  const {state: damaged} = protocol.confirmDynamicEvent(customState, {
    事件ID: '怀表受损',
    摘要: '怀表在风浪中磕碰。',
    实际参与者: ['玩家'],
    变化: [{路径: '角色.玩家.装备.祖传怀表', 操作: '设定', 值: {状态: '破损', 位置: '木盒'}}],
  });
  assert.deepEqual(damaged.角色.玩家.装备['祖传怀表'], {状态: '破损', 位置: '木盒'});

  const {state: transferred} = protocol.confirmDynamicEvent(damaged, {
    事件ID: '托付怀表',
    摘要: '玩家将怀表交给秦守保管。',
    实际参与者: ['玩家', '秦守'],
    变化: [
      {路径: '角色.玩家.装备.祖传怀表', 操作: '移除'},
      {路径: '角色.秦守.装备.祖传怀表', 操作: '新增', 值: {状态: '破损', 位置: '灯塔抽屉'}},
    ],
  });
  assert.equal(Object.hasOwn(transferred.角色.玩家.装备, '祖传怀表'), false);
  assert.deepEqual(transferred.角色.秦守.装备['祖传怀表'], {状态: '破损', 位置: '灯塔抽屉'});

  // 3. 扮演模式带自定义装备封卷成功
  const rpState = protocol.seal({
    开局时间: '潮历070年02月01日',
    角色组: {周岚: {启用: true, 版本ID: '周岚'}},
    玩家: {模式: '扮演', 扮演角色组: '周岚', 自定义装备: [customItem]},
  });
  assert.equal(rpState.角色.周岚.已初始化, true);
  assert.deepEqual(rpState.角色.周岚.装备['祖传怀表'], {状态: '完好', 位置: '贴身内袋'});

  // 4. 负例校验：重名、含点号、保留字、列表重复、非法状态、未声明虚构装备、预设事件写自定义装备
  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义装备: [{...customItem, 名称: '工具·铜扳手'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义装备: [{...customItem, 名称: '怀表.一号'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义装备: [{...customItem, 名称: '玩家'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义装备: [customItem, {...customItem}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义装备: [{...customItem, 状态: '全新'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.confirmDynamicEvent(customState, {
    事件ID: '虚构装备测试',
    摘要: '尝试写入未声明的虚构装备。',
    实际参与者: ['玩家'],
    变化: [{路径: '角色.玩家.装备.不存在的剑', 操作: '新增', 值: {状态: '完好', 位置: '腰间'}}],
  }), {code: '协议.变化'});

  const presetIssues = checkChange(
    {路径: '角色.秦守.装备.祖传怀表', 操作: '新增', 值: {状态: '完好', 位置: '桌上'}},
    {decl, catalog, preset: true, customEquipments: new Set(['祖传怀表'])},
  );
  assert.ok(presetIssues.some(item => item.规则 === '变化.映射键'), '预设事件不得允许写入自定义装备');
});

test('YG-CUST-01-A5：双模式自定义技能与额外技能/移除技能增删求值及负例校验', async t => {
  const root = await fixture(t);
  const {catalog, decl} = await compile(root);
  const protocol = createProtocol({catalog, decl});
  const allSkillOrder = catalog.entries.技能.map(item => item.id);

  // 1. 自建模式：基础能力只够 灯语: 学徒（解锁 灯语·短讯），加 额外技能 雾中视·辨影 并 移除技能 灯语·短讯
  const customState = protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      初始能力: {技艺: {灯语: '学徒'}},
      自定义技能: [{名称: '听潮辨雾', 说明: '借浪声回响判断近岸暗礁方位。', 限制: '仅在风势不大时有效。'}],
      额外技能: ['雾中视·辨影'],
      移除技能: ['灯语·短讯'],
    },
  });
  assert.deepEqual(protocol.availableSkills(customState, '玩家'), ['雾中视·辨影']);

  // 2. 扮演模式：扮演 秦守（基础能力 技艺.灯语=名匠），增删技能并验证库声明顺序
  const rpState = protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {
      模式: '扮演',
      扮演角色组: '秦守',
      能力覆写: {技艺: {灯语: '名匠'}},
      额外技能: ['雾中视·辨影'],
      移除技能: ['灯语·短讯'],
      自定义技能: [{名称: '老手修灯', 说明: '无需图纸即可拆装旧式油灯。'}],
    },
  });
  const rpSkills = protocol.availableSkills(rpState, '秦守');
  assert.equal(rpSkills.includes('灯语·短讯'), false);
  assert.equal(rpSkills.includes('雾中视·辨影'), true);
  // 校验输出严格遵循技能库声明顺序
  const indices = rpSkills.map(id => allSkillOrder.indexOf(id));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));

  // 3. 负例：重叠、不存在技能、自定义技能重名/缺必填/非法限制
  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 额外技能: ['灯语·短讯'], 移除技能: ['灯语·短讯']},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 额外技能: ['不存在的技能']},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义技能: [{名称: '重名技', 说明: '一'}, {名称: '重名技', 说明: '二'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义技能: [{名称: '缺说明'}]},
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 自定义技能: [{名称: '非法限制', 说明: '有效说明', 限制: ''}]},
  }), {code: '封卷.参数'});

  // 4. 无技能库时填写额外技能/移除技能报错
  const noSkillDecl = structuredClone(decl);
  delete noSkillDecl.libraries.技能;
  noSkillDecl.ability.技能可用 = [];
  const noSkillCatalog = structuredClone(catalog);
  delete noSkillCatalog.entries.技能;
  const noSkillProto = createProtocol({catalog: noSkillCatalog, decl: noSkillDecl});
  assert.throws(() => noSkillProto.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 额外技能: ['灯语·短讯']},
  }), {code: '封卷.参数'});
  assert.throws(() => noSkillProto.seal({
    开局时间: '潮历070年02月01日',
    玩家: {模式: '自建', 档案: {}, 移除技能: ['灯语·短讯']},
  }), {code: '封卷.参数'});
});

test('YG-CUST-01-A6：扮演模式增量定制落盘、幂等初始化与 roleplayBaseline 只读基线', async t => {
  const root = await fixture(t);
  await edit(root, equipment, value => { value.唯一 = true; });
  const {catalog, decl} = await compile(root);
  const protocol = createProtocol({catalog, decl});

  // 1. roleplayBaseline：返回指定时间与历史下的完整现状且不修改原 state
  const baseState = protocol.seal({
    开局时间: '潮历074年',
    角色组: {白棠: {启用: false, 版本ID: '白棠'}},
    玩家: {
      模式: '自建',
      档案: {姓名: '旁观者'},
      初始装备: [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '怀中'}],
    },
  });
  const snapshotBefore = structuredClone(baseState);
  const baseline = roleplayBaseline(protocol, baseState, '灯塔学徒');
  assert.equal(baseline.结果, '成立');
  assert.equal(baseline.档案ID, '林澜·守塔期');
  assert.equal(baseline.能力.技艺.灯语, '匠人');
  assert.equal(baseline.能力.技艺.修船, '熟手');
  assert.deepEqual(baseline.能力.习惯, ['每刻钟查一次灯芯']);
  assert.ok(baseline.可用技能.includes('灯语·短讯'));
  assert.deepEqual(baseline.装备['灯具·风暴灯'], {状态: '完好', 位置: '随身'});
  assert.equal(typeof baseline.所在, 'string');
  assert.deepEqual(baseState, snapshotBefore, 'roleplayBaseline 不得修改传入 state');

  // 尊重唯一装备已被他人持有时的跳过（玩家持有 工具·铜扳手，秦守基线装备中应跳过）
  const qinBaseline = protocol.roleplayBaseline(baseState, '秦守');
  assert.equal(qinBaseline.结果, '成立');
  assert.equal(Object.hasOwn(qinBaseline.装备, '工具·铜扳手'), false);

  // 未启用角色返回 {结果: '未启用'}
  assert.deepEqual(protocol.roleplayBaseline(baseState, '白棠'), {结果: '未启用'});

  // 2. 扮演模式增量定制：等级映射部分键覆写、单值等级覆盖、集合清空、移除能力、额外装备、移除装备
  const customized = protocol.seal({
    开局时间: '潮历074年',
    玩家: {
      模式: '扮演',
      扮演角色组: '灯塔学徒',
      能力覆写: {
        技艺: {灯语: '名匠'},
        名望: '熟手',
        习惯: [],
      },
      移除能力: ['技艺.修船'],
      移除装备: ['灯具·风暴灯'],
      额外装备: [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰带'}],
    },
  });
  const run = customized.角色.灯塔学徒;
  assert.equal(run.已初始化, true);
  assert.equal(run.技艺.灯语, '名匠');
  assert.equal(Object.hasOwn(run.技艺, '修船'), false);
  assert.deepEqual(run.能力移除记录, ['技艺.修船']);
  assert.equal(run.名望, '熟手');
  assert.deepEqual(run.习惯, []);
  assert.equal(Object.hasOwn(run.装备, '灯具·风暴灯'), false);
  assert.deepEqual(run.装备['工具·铜扳手'], {状态: '完好', 位置: '腰带'});
  assert.equal(Object.hasOwn(customized.事件, '初次登场·灯塔学徒'), false, '扮演定制落盘不写初次登场事件记录');

  // 后续确认初始化幂等，不把被删能力与装备补回
  const {state: afterInit, 已写入} = protocol.confirmInitialization(customized, '灯塔学徒');
  assert.deepEqual(已写入, []);
  assert.equal(Object.hasOwn(afterInit.角色.灯塔学徒.技艺, '修船'), false);
  assert.equal(Object.hasOwn(afterInit.角色.灯塔学徒.装备, '灯具·风暴灯'), false);

  // 3. 不传落盘定制字段时，扮演模式保持不提前初始化（100% 向后兼容）
  const plainRP = protocol.seal({
    开局时间: '潮历074年',
    玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'},
  });
  assert.equal(plainRP.角色.灯塔学徒?.已初始化, undefined);

  const skillOnlyRP = protocol.seal({
    开局时间: '潮历074年',
    玩家: {
      模式: '扮演',
      扮演角色组: '灯塔学徒',
      自定义技能: [{名称: '夜航听铃', 说明: '在浓雾中分辨远处浮标铃声。'}],
    },
  });
  assert.equal(skillOnlyRP.角色.灯塔学徒?.已初始化, undefined);

  // 4. 负例：移除能力与能力覆写冲突、额外装备与移除装备重叠
  assert.throws(() => protocol.seal({
    开局时间: '潮历074年',
    玩家: {
      模式: '扮演',
      扮演角色组: '灯塔学徒',
      能力覆写: {技艺: {灯语: '名匠'}},
      移除能力: ['技艺.灯语'],
    },
  }), {code: '封卷.参数'});

  assert.throws(() => protocol.seal({
    开局时间: '潮历074年',
    玩家: {
      模式: '扮演',
      扮演角色组: '灯塔学徒',
      额外装备: [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰间'}],
      移除装备: ['工具·铜扳手'],
    },
  }), {code: '封卷.参数'});
});

test('YG-CUST-01-A7：路由输出自定义技能与自定义装备、跟随转移、技能增删与审计零误报', async t => {
  const root = await fixture(t);
  const {protocol, router} = await loadRouter(root, {fs, path});

  // 1. 自建模式：自定义装备 + 自定义技能 + 额外技能 + 移除技能
  const sealed = protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      初始能力: {技艺: {灯语: '学徒'}},
      自定义装备: [{名称: '旧银哨', 说明: '遇雾吹响可引岸边老犬回应。', 状态: '完好', 位置: '颈间'}],
      自定义技能: [{名称: '辨潮音', 说明: '听浪判断涨落潮时辰。'}],
      额外技能: ['雾中视·辨影'],
      移除技能: ['灯语·短讯'],
    },
  });
  const {state: inScene} = protocol.writeScene(sealed, {
    当前地点: {地标: '灯塔', 场景: '塔顶平台'},
    在场: {秦守: true},
  });

  // 提及 雾中视·辨影（额外技能，应展开）与 灯语·短讯（玩家被移除，但秦守拥有灯语名匠，先只让玩家独自在场测移除技能）
  const {state: soloScene} = protocol.writeScene(sealed, {
    当前地点: {地标: '灯塔', 场景: '塔顶平台'},
  });
  const soloRouted = route(router, soloScene, ['试着用一下雾中视·辨影和灯语·短讯。']);
  const playerCard = soloRouted.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.deepEqual(playerCard.自定义技能, [{名称: '辨潮音', 说明: '听浪判断涨落潮时辰。'}]);
  assert.deepEqual(playerCard.自定义装备, [{名称: '旧银哨', 说明: '遇雾吹响可引岸边老犬回应。'}]);
  assert.ok(soloRouted.audit.条目.技能.选入.some(item => item.条目ID === '雾中视·辨影'), '额外技能被提及时应展开');
  assert.ok(soloRouted.audit.条目.技能.略过.some(item => item.条目ID === '灯语·短讯' && item.原因 === '不可用'),
    '移除技能被提及时应按不可用略过');
  assert.equal(soloRouted.audit.条目.装备.略过.some(item => item.条目ID === '旧银哨' && item.原因 === '条目不存在'), false,
    '自定义装备不得在装备库审计中产生虚假条目不存在');

  // 2. 自定义装备转移给在场 NPC 秦守后，说明自动跟随秦守输出、玩家不再输出
  const {state: moved} = protocol.confirmDynamicEvent(inScene, {
    事件ID: '赠与旧银哨',
    摘要: '玩家把旧银哨交给秦守。',
    实际参与者: ['玩家', '秦守'],
    变化: [
      {路径: '角色.玩家.装备.旧银哨', 操作: '移除'},
      {路径: '角色.秦守.装备.旧银哨', 操作: '新增', 值: {状态: '完好', 位置: '上衣袋'}},
    ],
  });
  const movedRouted = route(router, moved, ['风停了。']);
  const playerAfter = movedRouted.context.在场角色.find(item => item.角色组ID === '玩家');
  const qinAfter = movedRouted.context.在场角色.find(item => item.角色组ID === '秦守');
  assert.equal(Object.hasOwn(playerAfter, '自定义装备'), false);
  assert.deepEqual(qinAfter.自定义装备, [{名称: '旧银哨', 说明: '遇雾吹响可引岸边老犬回应。'}]);
  assert.equal(movedRouted.audit.条目.装备.略过.some(item => item.条目ID === '旧银哨'), false);

  // 3. 扮演模式同样输出自定义技能与自定义装备，且精简形式保留、最小形式省略
  const rpSealed = protocol.seal({
    开局时间: '潮历070年02月01日',
    玩家: {
      模式: '扮演',
      扮演角色组: '秦守',
      自定义装备: [{名称: '铜油壶', 说明: '长嘴小油壶，专给灯芯添油。', 状态: '完好', 位置: '工作台'}],
      自定义技能: [{名称: '听灯芯', 说明: '凭火苗噼啪声判断油料纯度。'}],
    },
  });
  const {state: rpScene} = protocol.writeScene(rpSealed, {
    当前地点: {地标: '灯塔', 场景: '塔顶平台'},
  });
  const rpFull = route(router, rpScene, ['天色渐暗。']);
  const rpCard = rpFull.context.在场角色.find(item => item.角色组ID === '秦守');
  assert.deepEqual(rpCard.自定义技能, [{名称: '听灯芯', 说明: '凭火苗噼啪声判断油料纯度。'}]);
  assert.deepEqual(rpCard.自定义装备, [{名称: '铜油壶', 说明: '长嘴小油壶，专给灯芯添油。'}]);

  // 精简形式（完整人数: 0, 字符足够）保留 自定义技能 与 自定义装备；最小形式（字符极小）省略
  const {catalog, decl} = await compile(root);
  const templates = {变量更新规则: '规则', 角色通用约束: '约束', 扮演准则: '准则'};
  const compactRouter = createRouter({catalog, decl, protocol, templates, settings: {在场角色: {完整人数: 0, 字符: 5000}}});
  const rpCompact = route(compactRouter, rpScene, ['天色渐暗。']);
  assert.equal(rpCompact.audit.在场角色.选入[0].形式, '精简');
  assert.deepEqual(rpCompact.context.在场角色[0].自定义技能, [{名称: '听灯芯', 说明: '凭火苗噼啪声判断油料纯度。'}]);
  assert.deepEqual(rpCompact.context.在场角色[0].自定义装备, [{名称: '铜油壶', 说明: '长嘴小油壶，专给灯芯添油。'}]);

  const minimalRouter = createRouter({catalog, decl, protocol, templates, settings: {在场角色: {完整人数: 0, 字符: 1}}});
  const rpMinimal = route(minimalRouter, rpScene, ['天色渐暗。']);
  assert.equal(rpMinimal.audit.在场角色.选入[0].形式, '最小');
  assert.equal(Object.hasOwn(rpMinimal.context.在场角色[0], '自定义技能'), false);
  assert.equal(Object.hasOwn(rpMinimal.context.在场角色[0], '自定义装备'), false);
  assert.ok(rpMinimal.context.在场角色[0].本局状态.装备['铜油壶']);
});
