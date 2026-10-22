import {test, assert, fs, path, example, fixture, edit, write, remove, invalidCase, read} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {loadWorldbook, readDeclarations, validateDeclarations, evaluateCondition, impactOf, checkChange} from '../core/index.mjs';

async function eventData(root) {
  const {raw} = await readDeclarations(root, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(root, {fs, path, decl});
  return {decl, catalog};
}

function hasRule(result, rule, level = null) {
  return [...result.errors, ...result.hints].some(item => item.规则 === rule && (!level || item.级别 === level));
}

test('求值-1 all未知与false', () => {
  assert.equal(evaluateCondition({all: [{甲: 1}, {乙: 1}]}, type => type === '甲' ? true : null), null);
  assert.equal(evaluateCondition({all: [{甲: 1}, {乙: 1}]}, type => type === '甲' ? false : null), false);
});
test('求值-2 any未知与true', () => {
  assert.equal(evaluateCondition({any: [{甲: 1}, {乙: 1}]}, type => type === '甲' ? false : null), null);
  assert.equal(evaluateCondition({any: [{甲: 1}, {乙: 1}]}, type => type === '甲' ? true : null), true);
});
test('求值-3 none未知与全false', () => {
  assert.equal(evaluateCondition({none: [{甲: 1}]}, () => null), null);
  assert.equal(evaluateCondition({none: [{甲: 1}]}, (type, value, negative) => negative ? true : false), true);
});
test('求值-4 none传递取反极性', () => {
  const negative = [];
  const result = evaluateCondition({none: [{any: [{甲: true}, {乙: false}]}]}, (type, value, polarity) => {
    negative.push(polarity);
    return type === '甲' ? false : true;
  });
  assert.deepEqual(negative, [true, true]);
  assert.equal(result, false);
});

test('影响-1至影响-4', async () => {
  const {catalog} = await eventData(example);
  assert.deepEqual(impactOf(catalog, '拜师'), ['出师考核', '夜间值守', '学修船', '正式守灯', '补考']);
  assert.deepEqual(impactOf(catalog, '出师考核'), ['正式守灯', '补考']);
  assert.deepEqual(impactOf(catalog, '大雾之夜').sort(), ['港务署问责', '学徒守灯', '白棠在码头'].sort());
  assert.deepEqual(impactOf(catalog, '潮汐号首航'), []);
});

test('catalog-历史产物', async () => {
  const {catalog} = await eventData(example);
  assert.equal(catalog.events.length, 13);
  assert.equal(catalog.chains.length, 2);
  assert.equal(catalog.openingPlans.length, 2);
  assert.equal(catalog.openingOptions.文件, '历史/开局选项.yaml');
  assert.equal(catalog.sources.记录.length, 14);
  assert.equal(catalog.events.find(event => event.id === '拜师').角色位置.length, 2);
});

invalidCase('目录-8：事件缺文件', '事件.缺文件', root => remove(root, '历史/事件/补考/事件.txt'));
invalidCase('目录-9：事件未知文件', '事件.未知文件', root => write(root, '历史/事件/拜师/备注.txt', {备注: '不属于事件'}));
invalidCase('目录-10：历史未知文件', '目录.未知文件', root => write(root, '历史/杂项.yaml', {甲: 1}));
invalidCase('事件-1：事件未知字段', '事件.未知字段', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.备注 = '多余字段'; }));
invalidCase('事件-2：事件缺必填', '事件.缺必填', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { delete value.事件概要; }));
invalidCase('事件-3：事件字段形态', '事件.字段', root => edit(root, '历史/事件/大雾之夜/事件.txt', value => { value.公开信息 = '不是列表'; }));
invalidCase('事件-4：事件分类', '事件.分类', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.主类型 = ['关系']; }));
invalidCase('事件-5：事件时间', '事件.触发时间', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.触发时间.最早 = '潮历071年02月01日'; }));
invalidCase('事件-6：事件确认策略', '事件.确认策略', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.确认策略 = '必然发生'; }));
invalidCase('事件-7：事件核心参与者', '事件.核心参与者', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.核心参与者.push('玩家'); }));
invalidCase('事件-8：事件地点', '事件.地点', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.地点 = ['南湾']; }));
invalidCase('事件-9：事件关联引用', '事件.关联事件', root => edit(root, '历史/事件/港务署问责/事件.txt', value => { value.关联事件.push('不存在'); }));
invalidCase('事件-10：结果缺支撑提示', '事件.结果缺支撑', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.事件结果.push('关系变化'); }), '提示');
invalidCase('事件-11：结果遗漏提示', '事件.结果遗漏', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件结果 = ['身份变化']; }), '提示');
invalidCase('事件-12：世界依赖个人提示', '事件.世界依赖个人', root => edit(root, '历史/事件/大雾之夜/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '拜师'}}; }), '提示');
invalidCase('分支-1：分支缺结果', '分支.格式', root => edit(root, '历史/事件/拜师/事件.txt', value => { delete value.分支[0].分支结果; }));
invalidCase('分支-2：分支ID重复', '分支.重复ID', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[1].分支ID = value.分支[0].分支ID; }));
invalidCase('分支-3：默认分支不存在', '分支.默认分支', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.默认分支 = '出海'; }));
invalidCase('分支-4：自动确认缺兜底', '分支.缺兜底', root => edit(root, '历史/事件/学徒守灯/事件.txt', value => { value.分支 = value.分支.filter(branch => branch.分支ID !== '在镇上听闻'); }));

invalidCase('条件-1：条件结构', '条件.格式', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {甲: 1, 乙: 2}; }));
invalidCase('条件-2：条件未知类型', '条件.未知类型', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {好感度: {角色组ID: '灯塔学徒'}}; }));
invalidCase('条件-3：条件参数', '条件.参数', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {事件确认: {}}; }));
invalidCase('条件-4：条件引用', '条件.引用', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛.事件确认.分支ID = '出海'; }));
invalidCase('条件-5：条件不可用', '条件.不可用', root => edit(root, '设定/能力.yaml', value => { delete value.维度.名望.综合实力; }));
invalidCase('条件-6：条件封卷不可求值', '条件.封卷不可求值', root => edit(root, '历史/事件/学修船/事件.txt', value => { value.确认策略 = '条件确认'; }));
invalidCase('条件-7：条件角色状态字段', '条件.角色状态字段', root => edit(root, '历史/事件/出师考核/事件.txt', value => { value.分支[0].门槛.角色状态.字段 = '好感度.秦守'; }));
invalidCase('条件-8：条件取值无来源提示', '条件.取值无来源', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[0].变化 = value.分支[0].变化.filter(change => !change.路径.includes('关系.秦守')); }), '提示');

invalidCase('变化-1：变化格式', '变化.格式', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { delete value.分支[0].变化[0].操作; }));
invalidCase('变化-2：变化路径', '变化.路径', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].路径 = '世界.季节'; }));
invalidCase('变化-3：变化协议字段', '变化.协议字段', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化.push({路径: '角色.灯塔学徒.已初始化', 操作: '设定', 值: true}); }));
invalidCase('变化-4：变化操作', '变化.操作', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].操作 = '增加'; }));
invalidCase('变化-5：变化取值', '变化.取值', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].值 = '宗师'; }));
invalidCase('变化-6：变化映射键', '变化.映射键', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[0].变化[3].路径 = '角色.灯塔学徒.关系.港务署'; }));
invalidCase('变化-7：角色未保证启用', '变化.角色未保证启用', root => edit(root, '历史/事件/学徒守灯/事件.txt', value => { delete value.分支[0].门槛; }));

invalidCase('事件树-1：前置超出窗口', '事件树.前置超出窗口', root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.触发时间 = {最早: '潮历070年01月01日', 最晚: '潮历070年03月91日'}; }));
invalidCase('事件树-2：前置倒流', '事件树.前置倒流', root => edit(root, '历史/事件/出师考核/事件.txt', value => { value.触发时间 = {最早: '潮历071年02月01日', 最晚: '潮历071年02月01日'}; }));
invalidCase('事件树-3：前置闭环', '事件树.前置闭环', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '夜间值守'}}; }));

invalidCase('事件串-1：事件串缺概述', '事件串.格式', root => edit(root, '历史/事件串/学徒修习.yaml', value => { delete value.概述; }));
invalidCase('事件串-2：事件串引用', '事件串.引用', root => edit(root, '历史/事件串/学徒修习.yaml', value => { value.结局[0] = {事件ID: '拜师', 分支ID: '出海'}; }));
invalidCase('事件串-3：事件串重复归属', '事件串.重复归属', root => edit(root, '历史/事件串/雾夜余波.yaml', value => { value.事件.push('拜师'); }));
invalidCase('事件串-4：事件串无起点', '事件串.无起点', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '正式守灯'}}; }));

for (const [name, mutate, rule] of [
  ['事件树-4：事件不可达提示', async root => edit(root, '历史/事件/港务署问责/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '潮汐号首航'}}; }), '事件树.不可达'],
  ['事件树-5：分支不可达提示', async root => edit(root, '历史/事件/白棠在码头/事件.txt', value => { value.分支[0].门槛 = {事件确认: {事件ID: '潮汐号首航'}}; }), '事件树.分支不可达'],
  ['事件串-5：事件串结局不可达提示', async root => { await edit(root, '历史/事件串/学徒修习.yaml', value => { value.结局[0] = {事件ID: '出师考核'}; }); await edit(root, '历史/事件/出师考核/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '潮汐号首航'}}; }); }, '事件串.结局不可达'],
]) test(name, async t => {
  const root = await fixture(t);
  await mutate(root);
  const result = await checkWorldbook(root);
  assert.ok(hasRule(result, rule, '提示'), JSON.stringify(result, null, 2));
});
invalidCase('事件串-6：事件串孤立成员提示', '事件串.孤立成员', root => edit(root, '历史/事件串/学徒修习.yaml', value => { value.事件.push('秦守讲旧事'); }), '提示');

invalidCase('位置-1：角色位置未知字段', '角色位置.未知字段', root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.备注 = '多余'; }));
invalidCase('位置-2：角色位置缺必填', '角色位置.缺必填', root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { delete value.角色概要; }));
invalidCase('位置-3：角色位置ID不符', '角色位置.ID不符', root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.事件ID = '夜间值守'; }));
invalidCase('位置-4：角色位置形态', '角色位置.形态', root => edit(root, '历史/事件/拜师/角色/灯塔学徒.txt', value => { value.主观记忆 = '字符串'; }));
invalidCase('位置-5：角色位置适用分支', '角色位置.适用分支', root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.适用分支 = ['出海']; }));
invalidCase('位置-6：角色位置按分支', '角色位置.按分支', root => edit(root, '历史/事件/学徒守灯/角色/秦守.txt', value => { value.按分支 = {'独自守灯': {主观记忆: ['不应出现']}}; }));
invalidCase('位置-7：角色位置触发语料', '角色位置.触发语料', root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { delete value.事件触发语料[0].候选台词; }));

invalidCase('开局-1：开局选项格式', '开局.选项格式', root => edit(root, '历史/开局选项.yaml', value => { value.自由组合 = '否'; }));
invalidCase('开局-2：开局选项引用', '开局.选项引用', root => edit(root, '历史/开局选项.yaml', value => { value.选项[0].选项.出海 = '不存在'; }));
invalidCase('开局-3：开局方案格式', '开局.方案格式', root => edit(root, '历史/开局方案/码头少年.yaml', value => { value.角色组 = {白棠: {版本ID: '船长'}}; }));
invalidCase('开局-4：开局方案选择', '开局.方案选择', root => edit(root, '历史/开局方案/码头少年.yaml', value => { value.历史选择.大雾之夜 = '发生'; }));

test('出处-1：格式', async t => {
  const root = await fixture(t);
  await edit(root, '../作者资料/出处/雾港.yaml', value => { delete value[0].来源; });
  const result = await checkWorldbook(root);
  assert.ok(hasRule(result, '出处.格式'));
});
test('出处-2：引用', async t => {
  const root = await fixture(t);
  await edit(root, '../作者资料/出处/雾港.yaml', value => { value.at(-1).台词 = '灯不等人，明早天亮后上来。'; });
  const result = await checkWorldbook(root);
  assert.ok(hasRule(result, '出处.引用'));
});
test('文本-12：原台词破折号只提示', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.事件触发语料[0].候选台词[0] = '灯不等人——明早天亮前上来。'; });
  await edit(root, '../作者资料/出处/雾港.yaml', value => { value.at(-1).台词 = '灯不等人——明早天亮前上来。'; });
  const result = await checkWorldbook(root);
  assert.ok(hasRule(result, '文本.破折号', '提示'), JSON.stringify(result, null, 2));
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
});

invalidCase('档案项-8：档案生效条件规则', '档案项.生效条件', root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {当前场景: {地标: '灯塔', 场景: '值守室'}}; }));
invalidCase('档案项-9：档案生效条件引用', '条件.引用', root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {事件确认: {事件ID: '不存在'}}; }));
invalidCase('档案项-10：档案生效条件不可求值', '条件.封卷不可求值', root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {当前场景: {地标: '灯塔', 场景: '值守室'}}; }));
invalidCase('文本-10：事件禁用词', '文本.禁用词', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件概要 += '变量'; }));
invalidCase('文本-11：位置破折号', '文本.破折号', root => edit(root, '历史/事件/拜师/角色/灯塔学徒.txt', value => { value.按分支.拜师.主观记忆.push('记得灯火——熄灭。'); }));
invalidCase('文本-13：事件长度', '文本.长度', root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件概要 = '海'.repeat(801); }), '提示');

test('正例-2：删除作者资料', async t => {
  const root = await fixture(t);
  await remove(path.dirname(root), '作者资料');
  const result = await checkWorldbook(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});

test('正例-3：切换默认版本仍零错误', async t => {
  const root = await fixture(t);
  await edit(root, '角色/白棠/角色组.yaml', value => { value.默认版本 = '白棠·船长'; });
  const result = await checkWorldbook(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});
