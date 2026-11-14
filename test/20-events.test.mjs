import {test, assert, fs, path, example, fixture, edit, write, remove, invalidCase, read, finding, hint} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {loadWorldbook, readDeclarations, validateDeclarations, evaluateCondition, impactOf, checkChange, analyzeEventTree} from '../core/index.mjs';

async function eventData(root) {
  const {raw} = await readDeclarations(root, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(root, {fs, path, decl});
  return {decl, catalog};
}

function hasRule(result, rule, level = null) {
  return [...result.errors, ...result.hints].some(item => item.规则 === rule && (!level || item.级别 === level));
}

function countRule(result, rule, level = null) {
  return [...result.errors, ...result.hints].filter(item => item.规则 === rule && (!level || item.级别 === level)).length;
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

invalidCase('目录-8：事件缺文件', [
  finding('事件.缺文件', '历史/事件/补考/事件.txt'),
  hint('抽样.未执行', '历史'),
  finding('条件.引用', '历史/事件/正式守灯/事件.txt'),
  finding('条件.引用', '角色/灯塔学徒/角色组.yaml'),
], root => remove(root, '历史/事件/补考/事件.txt'));
invalidCase('目录-9：事件未知文件', [
  finding('事件.未知文件', '历史/事件/拜师/备注.txt'),
  hint('抽样.未执行', '历史'),
], root => write(root, '历史/事件/拜师/备注.txt', {备注: '不属于事件'}));
invalidCase('目录-10：历史未知文件', [
  hint('抽样.未执行', '历史'),
  finding('目录.未知文件', '历史/杂项.yaml'),
], root => write(root, '历史/杂项.yaml', {甲: 1}));
invalidCase('事件-1：事件未知字段', [
  finding('事件.未知字段', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.备注 = '多余字段'; }));
invalidCase('事件-2：事件缺必填', [
  finding('事件.缺必填', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { delete value.事件概要; }));
invalidCase('事件-3：事件字段形态', [
  finding('事件.字段', '历史/事件/大雾之夜/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/大雾之夜/事件.txt', value => { value.公开信息 = '不是列表'; }));
invalidCase('事件-4：事件分类', [
  finding('事件.分类', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.主类型 = ['关系']; }));
invalidCase('事件-5：事件时间', [
  finding('事件.触发时间', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.触发时间.最早 = '潮历071年02月01日'; }));
invalidCase('事件-6：事件确认策略', [
  finding('事件.确认策略', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.确认策略 = '必然发生'; }));
invalidCase('事件-7：事件核心参与者', [
  finding('事件.核心参与者', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.核心参与者.push('玩家'); }));
invalidCase('事件-8：事件地点', [
  finding('事件.地点', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.地点 = ['南湾']; }));
invalidCase('事件-9：事件关联引用', [
  finding('事件.关联事件', '历史/事件/港务署问责/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/港务署问责/事件.txt', value => { value.关联事件.push('不存在'); }));
invalidCase('事件-10：结果缺支撑提示', [
  hint('事件.结果缺支撑', '历史/事件/夜间值守/事件.txt'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.事件结果.push('关系变化'); }));
invalidCase('事件-11：结果遗漏提示', [
  hint('事件.结果遗漏', '历史/事件/拜师/事件.txt', {次数: 2}),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件结果 = ['身份变化']; }));
test('事件-12：未声明世界事件不提示', async t => {
  const root = await fixture(t);
  await edit(root, '设定/事件分类.yaml', value => { delete value.世界事件; });
  await edit(root, '历史/事件/大雾之夜/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '拜师'}}; });
  const result = await checkWorldbook(root);
  assert.equal(hasRule(result, '事件.世界依赖个人'), false, JSON.stringify(result, null, 2));
});
invalidCase('事件-13：声明世界事件时依赖个人提示', [
  hint('事件.世界依赖个人', '历史/事件/大雾之夜/事件.txt'),
], root => edit(root, '历史/事件/大雾之夜/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '拜师'}}; }));
invalidCase('分支-1：分支缺结果', [
  finding('分支.格式', '历史/事件/拜师/事件.txt', {次数: 2}),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { delete value.分支[0].分支结果; }));
invalidCase('分支-2：分支ID重复', [
  finding('事件串.引用', '历史/事件串/学徒修习.yaml'),
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  finding('分支.重复ID', '历史/事件/拜师/事件.txt'),
  finding('开局.选项引用', '历史/开局选项.yaml'),
  hint('抽样.未执行', '历史'),
  finding('角色位置.按分支', '历史/事件/拜师/角色/灯塔学徒.txt'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[1].分支ID = value.分支[0].分支ID; }));
invalidCase('分支-3：默认分支不存在', [
  finding('分支.默认分支', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.默认分支 = '出海'; }));
invalidCase('分支-4：自动确认缺兜底', [
  finding('分支.缺兜底', '历史/事件/学徒守灯/事件.txt'),
  hint('抽样.未执行', '历史'),
  finding('角色位置.按分支', '历史/事件/学徒守灯/角色/灯塔学徒.txt'),
], root => edit(root, '历史/事件/学徒守灯/事件.txt', value => { value.分支 = value.分支.filter(branch => branch.分支ID !== '在镇上听闻'); }));

invalidCase('条件-1：条件结构', [
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  hint('抽样.未执行', '历史'),
  finding('条件.格式', '历史/事件/夜间值守/事件.txt'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {甲: 1, 乙: 2}; }));
invalidCase('条件-2：条件未知类型', [
  hint('抽样.未执行', '历史'),
  finding('条件.未知类型', '历史/事件/夜间值守/事件.txt'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {好感度: {角色组ID: '灯塔学徒'}}; }));
invalidCase('条件-3：条件参数', [
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  finding('事件树.前置超出窗口', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
  finding('条件.参数', '历史/事件/夜间值守/事件.txt', {次数: 2}),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛 = {事件确认: {}}; }));
invalidCase('条件-4：条件引用', [
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  hint('抽样.未执行', '历史'),
  finding('条件.引用', '历史/事件/夜间值守/事件.txt'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.门槛.事件确认.分支ID = '出海'; }));
invalidCase('条件-5：条件不可用', [
  hint('抽样.未执行', '历史'),
  finding('条件.不可用', '历史/事件/秦守讲旧事/事件.txt'),
  finding('条件.参数', '历史/事件/秦守讲旧事/事件.txt'),
], root => edit(root, '设定/能力.yaml', value => { delete value.维度.名望.综合实力; }));
invalidCase('条件-6：条件封卷不可求值', [
  hint('抽样.未执行', '历史'),
  finding('条件.封卷不可求值', '历史/事件/学修船/事件.txt'),
], root => edit(root, '历史/事件/学修船/事件.txt', value => { value.确认策略 = '条件确认'; }));
invalidCase('条件-7：条件角色状态字段', [
  hint('抽样.未执行', '历史'),
  hint('条件.取值无来源', '历史/事件/出师考核/事件.txt'),
  finding('条件.引用', '历史/事件/出师考核/事件.txt'),
  finding('条件.角色状态字段', '历史/事件/出师考核/事件.txt'),
], root => edit(root, '历史/事件/出师考核/事件.txt', value => { value.分支[0].门槛.角色状态.字段 = '好感度.秦守'; }));
invalidCase('条件-8：条件取值无来源提示', [
  hint('开局.选项不可选', '历史/开局选项.yaml'),
  hint('条件.取值无来源', '历史/事件/出师考核/事件.txt'),
  hint('条件.取值无来源', '历史/事件/补考/事件.txt'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[0].变化 = value.分支[0].变化.filter(change => !change.路径.includes('关系.秦守')); }));

invalidCase('变化-1：变化格式', [
  finding('变化.格式', '历史/事件/夜间值守/事件.txt', {次数: 2,
    说明: ['必须含路径、操作', '路径与操作须为非空文本']}),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { delete value.分支[0].变化[0].操作; }));
invalidCase('变化-2：变化路径', [
  finding('变化.路径', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].路径 = '世界.季节'; }));
invalidCase('变化-3：变化协议字段', [
  finding('变化.协议字段', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化.push({路径: '角色.灯塔学徒.已初始化', 操作: '设定', 值: true}); }));
invalidCase('变化-4：变化操作', [
  finding('变化.操作', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].操作 = '增加'; }));
invalidCase('变化-5：变化取值', [
  finding('变化.取值', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.分支[0].变化[0].值 = '宗师'; }));
invalidCase('变化-6：变化映射键', [
  finding('变化.映射键', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
  hint('条件.取值无来源', '历史/事件/出师考核/事件.txt'),
  hint('条件.取值无来源', '历史/事件/补考/事件.txt'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.分支[0].变化[3].路径 = '角色.灯塔学徒.关系.港务署'; }));
invalidCase('变化-7：角色未保证启用', [
  finding('变化.角色未保证启用', '历史/事件/学徒守灯/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/学徒守灯/事件.txt', value => { delete value.分支[0].门槛; }));

test('修正-1：取反门槛仍须保证写入角色启用', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/学徒守灯/事件.txt', value => {
    value.分支.find(branch => branch.分支ID === '重燃灯塔').门槛 = {none: [{角色启用: {角色组ID: '秦守'}}]};
  });
  const result = await checkWorldbook(root);
  assert.ok(hasRule(result, '变化.角色未保证启用'), JSON.stringify(result, null, 2));
});

test('修正-2：正向角色版本门槛保证写入角色启用', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/学徒守灯/事件.txt', value => {
    value.分支.find(branch => branch.分支ID === '重燃灯塔').门槛 = {角色版本: {角色组ID: '秦守', 版本ID: '秦守'}};
  });
  const result = await checkWorldbook(root);
  assert.equal(hasRule(result, '变化.角色未保证启用'), false, JSON.stringify(result, null, 2));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});

test('修正-3：取反事件串状态按乐观假设可达', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/秦守讲旧事/事件.txt', value => {
    const [chainState, ...rest] = value.门槛.all;
    value.门槛.all = [{none: [chainState]}, ...rest];
  });
  const result = await checkWorldbook(root);
  assert.equal(hasRule(result, '事件树.不可达'), false, JSON.stringify(result, null, 2));

  // 起点不可达时，取反仍可能成立；正向条件则保留原来的起点判断。
  const {catalog, decl} = await eventData(root);
  catalog.events.find(item => item.id === '拜师').内容.门槛 = {事件确认: {事件ID: '潮汐号首航'}};
  assert.equal(analyzeEventTree(catalog, decl).reachable.has('秦守讲旧事'), true);
  const event = catalog.events.find(item => item.id === '秦守讲旧事');
  event.内容.门槛.all[0] = event.内容.门槛.all[0].none[0];
  assert.equal(analyzeEventTree(catalog, decl).reachable.has('秦守讲旧事'), false);
});

test('修正-4：角色状态属于列表含默认值时不提示无来源', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/补考/事件.txt', value => {
    const branch = value.分支.find(item => item.分支ID === '通过');
    branch.门槛 = {all: [branch.门槛, {角色状态: {角色组ID: '灯塔学徒', 字段: '身体状态.健康', 属于: ['正常', '未初始化']}}]};
  });
  const result = await checkWorldbook(root);
  assert.equal(hasRule(result, '条件.取值无来源'), false, JSON.stringify(result, null, 2));
  assert.deepEqual(result.errors, []);
});

test('修正-5：角色状态属于列表都无来源时只提示一次', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/补考/事件.txt', value => {
    const branch = value.分支.find(item => item.分支ID === '通过');
    branch.门槛 = {all: [branch.门槛, {角色状态: {角色组ID: '灯塔学徒', 字段: '身体状态.健康', 属于: ['正常', '重伤']}}]};
  });
  const result = await checkWorldbook(root);
  assert.equal(countRule(result, '条件.取值无来源', '提示'), 1, JSON.stringify(result, null, 2));
  assert.deepEqual(result.errors, []);
});

invalidCase('事件树-1：前置超出窗口', [
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  finding('事件树.前置超出窗口', '历史/事件/夜间值守/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/夜间值守/事件.txt', value => { value.触发时间 = {最早: '潮历070年01月01日', 最晚: '潮历070年03月91日'}; }));
invalidCase('事件树-2：前置倒流', [
  finding('事件树.前置倒流', '历史/事件/出师考核/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/出师考核/事件.txt', value => { value.触发时间 = {最早: '潮历071年02月01日', 最晚: '潮历071年02月01日'}; }));
invalidCase('事件树-3：前置闭环', [
  finding('事件串.无起点', '历史/事件串/学徒修习.yaml'),
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml', {次数: 2}),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/学修船/事件.txt'),
  hint('事件树.不可达', '历史/事件/拜师/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/秦守讲旧事/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  finding('事件树.前置超出窗口', '历史/事件/拜师/事件.txt'),
  finding('事件树.前置闭环', '历史/事件/夜间值守、拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '夜间值守'}}; }));

test('修正-6：事件门槛时间问题不在分支重复报告', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/学徒守灯/事件.txt', value => {
    value.触发时间 = {最早: '潮历071年04月10日', 最晚: '潮历071年04月10日'};
  });
  const result = await checkWorldbook(root);
  assert.equal(countRule(result, '事件树.前置超出窗口'), 1, JSON.stringify(result, null, 2));
  assert.equal(countRule(result, '事件树.前置倒流'), 0, JSON.stringify(result, null, 2));
});

test('修正补充-1：取反无关条件仍是未知，双重取反恢复角色保证', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/学徒守灯/事件.txt', value => {
    value.分支.find(branch => branch.分支ID === '重燃灯塔').门槛 = {none: [{剧情标记: {标记ID: '灯塔状态', 比较: '等于', 值: '重燃'}}]};
  });
  let result = await checkWorldbook(root);
  assert.ok(hasRule(result, '变化.角色未保证启用'), JSON.stringify(result, null, 2));
  await edit(root, '历史/事件/学徒守灯/事件.txt', value => {
    value.分支.find(branch => branch.分支ID === '重燃灯塔').门槛 = {none: [{none: [{角色启用: {角色组ID: '秦守'}}]}]};
  });
  result = await checkWorldbook(root);
  assert.equal(hasRule(result, '变化.角色未保证启用'), false, JSON.stringify(result, null, 2));
});

test('修正补充-2：属于列表任一取值有事件来源即不提示', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/补考/事件.txt', value => {
    const branch = value.分支.find(item => item.分支ID === '通过');
    branch.门槛 = {all: [branch.门槛, {角色状态: {角色组ID: '灯塔学徒', 字段: '身体状态.健康', 属于: ['正常', '受伤']}}]};
  });
  const result = await checkWorldbook(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});

test('修正补充-3：事件级倒流不在分支重复，分支独有时间问题仍检查', async () => {
  const {catalog, decl} = await eventData(example);
  const event = catalog.events.find(item => item.id === '学徒守灯');
  const source = catalog.events.find(item => item.id === '大雾之夜');
  source.内容.触发时间.最晚 = '潮历071年04月21日';
  let analysis = analyzeEventTree(catalog, decl);
  const timeIssues = result => result.issues.filter(item => item.文件 === event.文件 && ['事件树.前置超出窗口', '事件树.前置倒流'].includes(item.规则));
  assert.deepEqual(timeIssues(analysis).map(item => item.规则), ['事件树.前置倒流']);
  assert.equal(timeIssues(analysis)[0].说明.startsWith('分支门槛'), false);

  // 事件门槛可满足，但分支新增更晚的前置时仍须报错。
  source.内容.触发时间.最晚 = '潮历071年04月20日';
  event.内容.分支[0].门槛 = {事件确认: {事件ID: '潮汐号首航'}};
  analysis = analyzeEventTree(catalog, decl);
  assert.deepEqual(timeIssues(analysis).map(item => item.规则), ['事件树.前置超出窗口']);
  assert.equal(timeIssues(analysis)[0].说明.startsWith('分支门槛'), true);

  // 合取后错误类型不同，不能因为事件门槛已经报过倒流就忽略。
  source.内容.触发时间.最晚 = '潮历071年04月21日';
  analysis = analyzeEventTree(catalog, decl);
  assert.deepEqual(timeIssues(analysis).map(item => item.规则), ['事件树.前置倒流', '事件树.前置超出窗口']);
});

invalidCase('事件串-1：事件串缺概述', [
  finding('事件串.格式', '历史/事件串/学徒修习.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件串/学徒修习.yaml', value => { delete value.概述; }));
invalidCase('事件串-2：事件串引用', [
  finding('事件串.引用', '历史/事件串/学徒修习.yaml'),
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件串/学徒修习.yaml', value => { value.结局[0] = {事件ID: '拜师', 分支ID: '出海'}; }));
invalidCase('事件串-3：事件串重复归属', [
  hint('事件串.孤立成员', '历史/事件串/雾夜余波.yaml'),
  finding('事件串.重复归属', '历史/事件串/雾夜余波.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件串/雾夜余波.yaml', value => { value.事件.push('拜师'); }));
invalidCase('事件串-4：事件串无起点', [
  finding('事件串.无起点', '历史/事件串/学徒修习.yaml'),
  hint('事件串.结局不可达', '历史/事件串/学徒修习.yaml', {次数: 2}),
  hint('事件树.不可达', '历史/事件/出师考核/事件.txt'),
  hint('事件树.不可达', '历史/事件/夜间值守/事件.txt'),
  hint('事件树.不可达', '历史/事件/学修船/事件.txt'),
  hint('事件树.不可达', '历史/事件/拜师/事件.txt'),
  hint('事件树.不可达', '历史/事件/正式守灯/事件.txt'),
  hint('事件树.不可达', '历史/事件/秦守讲旧事/事件.txt'),
  hint('事件树.不可达', '历史/事件/补考/事件.txt'),
  finding('事件树.前置超出窗口', '历史/事件/拜师/事件.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.门槛 = {事件确认: {事件ID: '正式守灯'}}; }));

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
invalidCase('事件串-6：事件串孤立成员提示', [
  hint('事件串.孤立成员', '历史/事件串/学徒修习.yaml'),
], root => edit(root, '历史/事件串/学徒修习.yaml', value => { value.事件.push('秦守讲旧事'); }));

invalidCase('位置-1：角色位置未知字段', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.未知字段', '历史/事件/拜师/角色/秦守.txt'),
], root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.备注 = '多余'; }));
invalidCase('位置-2：角色位置缺必填', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.缺必填', '历史/事件/拜师/角色/秦守.txt'),
], root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { delete value.角色概要; }));
invalidCase('位置-3：角色位置ID不符', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.ID不符', '历史/事件/拜师/角色/秦守.txt'),
], root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.事件ID = '夜间值守'; }));
invalidCase('位置-4：角色位置形态', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.形态', '历史/事件/拜师/角色/灯塔学徒.txt'),
], root => edit(root, '历史/事件/拜师/角色/灯塔学徒.txt', value => { value.主观记忆 = '字符串'; }));
invalidCase('位置-5：角色位置适用分支', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.按分支', '历史/事件/拜师/角色/秦守.txt'),
  finding('角色位置.适用分支', '历史/事件/拜师/角色/秦守.txt'),
], root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { value.适用分支 = ['出海']; }));
invalidCase('位置-6：角色位置按分支', [
  hint('抽样.未执行', '历史'),
  finding('角色位置.按分支', '历史/事件/学徒守灯/角色/秦守.txt'),
], root => edit(root, '历史/事件/学徒守灯/角色/秦守.txt', value => { value.按分支 = {'独自守灯': {主观记忆: ['不应出现']}}; }));
invalidCase('位置-7：角色位置触发语料', [
  finding('出处.引用', '作者资料/出处/雾港.yaml#14'),
  hint('抽样.未执行', '历史'),
  finding('角色位置.触发语料', '历史/事件/拜师/角色/秦守.txt'),
], root => edit(root, '历史/事件/拜师/角色/秦守.txt', value => { delete value.事件触发语料[0].候选台词; }));

invalidCase('开局-1：开局选项格式', [
  finding('开局.选项格式', '历史/开局选项.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/开局选项.yaml', value => { value.自由组合 = '否'; }));
invalidCase('开局-2：开局选项引用', [
  finding('开局.选项引用', '历史/开局选项.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/开局选项.yaml', value => { value.选项[0].选项.出海 = '不存在'; }));
invalidCase('开局-3：开局方案格式', [
  finding('开局.方案格式', '历史/开局方案/码头少年.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/开局方案/码头少年.yaml', value => { value.角色组 = {白棠: {版本ID: '船长'}}; }));
invalidCase('开局-4：开局方案选择', [
  finding('开局.方案选择', '历史/开局方案/码头少年.yaml'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/开局方案/码头少年.yaml', value => { value.历史选择.大雾之夜 = '发生'; }));

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

invalidCase('档案项-8：档案生效条件规则', [
  hint('抽样.未执行', '历史'),
  finding('条件.封卷不可求值', '角色/灯塔学徒/角色组.yaml'),
  finding('档案项.生效条件', '角色/灯塔学徒/角色组.yaml'),
], root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {当前场景: {地标: '灯塔', 场景: '值守室'}}; }));
invalidCase('档案项-9：档案生效条件引用', [
  hint('抽样.未执行', '历史'),
  finding('条件.引用', '角色/灯塔学徒/角色组.yaml'),
], root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {事件确认: {事件ID: '不存在'}}; }));
invalidCase('档案项-10：档案生效条件不可求值', [
  hint('抽样.未执行', '历史'),
  finding('条件.封卷不可求值', '角色/灯塔学徒/角色组.yaml'),
  finding('档案项.生效条件', '角色/灯塔学徒/角色组.yaml'),
], root => edit(root, '角色/灯塔学徒/角色组.yaml', value => { value.档案.find(item => item.档案ID === '林澜·守塔期').生效条件 = {当前场景: {地标: '灯塔', 场景: '值守室'}}; }));
invalidCase('文本-10：事件禁用词', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '历史/事件/拜师/事件.txt'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件概要 += '变量'; }));
invalidCase('文本-11：位置破折号', [
  hint('抽样.未执行', '历史'),
  finding('文本.破折号', '历史/事件/拜师/角色/灯塔学徒.txt'),
], root => edit(root, '历史/事件/拜师/角色/灯塔学徒.txt', value => { value.按分支.拜师.主观记忆.push('记得灯火——熄灭。'); }));
invalidCase('文本-13：事件长度', [
  hint('文本.长度', '历史/事件/拜师/事件.txt'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件概要 = '海'.repeat(801); }));

for (const [name, file, mutate] of [
  ['角色组显示名', '角色/白棠/角色组.yaml', value => { value.显示名 = '变量——'; }],
  ['角色组别名', '角色/白棠/角色组.yaml', value => { value.别名[0] = '变量——'; }],
  ['版本显示名', '角色/白棠/角色组.yaml', value => { value.版本[0].显示名 = '变量——'; }],
  ['版本别名', '角色/白棠/角色组.yaml', value => { value.版本[0].别名 = ['变量——']; }],
  ['版本简介', '角色/白棠/角色组.yaml', value => { value.版本[0].简介 = '变量——'; }],
  ['事件串概述', '历史/事件串/雾夜余波.yaml', value => { value.概述 = '变量——'; }],
  ['开局选项问题', '历史/开局选项.yaml', value => { value.选项[0].问题 = '变量——'; }],
  ['开局选项文字', '历史/开局选项.yaml', value => { value.选项[0].选项.拜师 = '变量——'; }],
  ['开局方案概述', '历史/开局方案/码头少年.yaml', value => { value.概述 = '变量——'; }],
]) test(`文本-YAML：${name}检查禁用词与破折号`, async t => {
  const root = await fixture(t);
  await edit(root, file, mutate);
  const result = await checkWorldbook(root);
  for (const rule of ['文本.禁用词', '文本.破折号'])
    assert.ok(result.errors.some(item => item.规则 === rule && item.文件 === file), `${rule}\n${JSON.stringify(result, null, 2)}`);
  assert.equal(result.errors.some(item => item.规则 === '文本.长度' && item.文件 === file), false, JSON.stringify(result, null, 2));
});

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

// YG-TEST-01：事件.ID不符 的真实输入与完整发现集合。
invalidCase('事件-14：事件内容ID与目录不符', [
  finding('事件.ID不符', '历史/事件/拜师/事件.txt', {说明: ['事件ID', '目录名']}),
  hint('抽样.未执行', '历史'),
], root => edit(root, '历史/事件/拜师/事件.txt', value => { value.事件ID = '另一个事件'; }));
