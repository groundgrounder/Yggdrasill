import {assert, test, fs, path, fixture, edit} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {digest, loadViewData} from '../view/data.mjs';

const eventFile = '历史/事件/拜师/事件.txt';
const groupFile = '角色/灯塔学徒/角色组.yaml';

test('视图-数据-1：计数、时间与检查结果与现行检查器一致', async t => {
  const root = await fixture(t);
  const data = await loadViewData(root);
  const check = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(data.元数据.检查.错误列表, check.errors);
  assert.deepEqual(data.元数据.检查.提示列表, check.hints);
  assert.deepEqual(data.元数据.计数, {事件: 13, 事件串: 2, 角色组: 4, 档案: 11, 条目: 18, 文件: 87});
  assert.equal(data.元数据.日历.年天数, 365);
  assert.equal(data.元数据.日历.前缀, '潮历');
  const apprenticeship = data.事件.find(event => event.事件ID === '拜师');
  assert.equal(apprenticeship.触发时间.最早, '潮历071年01月10日');
  assert.equal(apprenticeship.触发时间.startYear, 71);
  assert(Number.isFinite(apprenticeship.触发时间.start));
  assert(Number.isFinite(apprenticeship.触发时间.end));
  assert.equal(apprenticeship.revision, digest(apprenticeship.原文));
  assert.equal(apprenticeship.结构.状态, '可达');
  assert.equal(apprenticeship.角色位置.length, 2);
  assert.deepEqual(apprenticeship.相关角色组, ['灯塔学徒', '秦守']);
  assert(data.关系.length > 0);
  for (const relation of data.关系) assert(relation.来源 === `事件:${relation.from}` && relation.目标 === `事件:${relation.to}`);
});

test('视图-数据-2：事件串与独立事件分组不丢事件，排序稳定', async t => {
  const root = await fixture(t);
  const data = await loadViewData(root);
  const assigned = new Set(data.事件串.flatMap(chain => chain.事件));
  const standalone = data.事件.filter(event => !assigned.has(event.事件ID)).map(event => event.事件ID);
  assert.equal(data.事件.filter(event => assigned.has(event.事件ID)).length + standalone.length, data.事件.length);
  const chain = data.事件串.find(item => item.事件串ID === '学徒修习');
  assert.deepEqual(chain.结构.起点, ['拜师']);
  assert(chain.结构.结局可达.includes('正式守灯'));
  const sorted = data.事件.slice().sort((left, right) => (left.触发时间.start ?? Infinity) - (right.触发时间.start ?? Infinity));
  assert.deepEqual(data.事件.map(event => event.事件ID), sorted.map(event => event.事件ID));
});

test('视图-数据-3：条件、排斥与普通关联都来自现行引用索引', async t => {
  const root = await fixture(t);
  await edit(root, eventFile, value => {
    value.关联事件 = ['夜间值守'];
    value.门槛 = {none: [{事件确认: {事件ID: '夜间值守'}}]};
  });
  const data = await loadViewData(root);
  const relations = data.关系.filter(relation => relation.from === '拜师' && relation.to === '夜间值守');
  assert(relations.some(relation => relation.种类 === '关联事件'));
  assert(relations.some(relation => relation.种类 === '事件确认' && relation.极性 === '排斥'));
  assert(relations.every(relation => relation.字段.length > 0 && relation.文件));
});

test('视图-数据-4：角色汇总分区显示初始值、事件变化与暂存未接回', async t => {
  const root = await fixture(t);
  const pendingFile = path.join(path.dirname(root), '作者资料', '暂存', '暂存清单.yaml');
  await fs.mkdir(path.dirname(pendingFile), {recursive: true});
  await fs.writeFile(pendingFile, `- 类型: 档案
  ID: 林澜·守塔期的初始装备
  接回位置: 角色/灯塔学徒/角色组.yaml
  接回结构: 初始装备：灯具·风暴灯
  接回条件: 待作者核定
`);
  const data = await loadViewData(root);
  const group = data.角色组.find(item => item.角色组ID === '灯塔学徒');
  assert.equal(group.初始化方式, null);
  const profile = group.档案.find(item => item.档案ID === '林澜·学徒期');
  assert.deepEqual(profile.初始能力, {技艺: {灯语: '学徒'}});
  assert.equal(profile.文档.基本信息.文件, '角色/灯塔学徒/档案/林澜·学徒期/基本信息.txt');
  assert(profile.文档.基本信息.原文.includes('姓名'));
  const change = group.事件变化.find(item => item.事件ID === '拜师' && item.路径 === '角色.灯塔学徒.技艺.灯语');
  assert.equal(change.操作, '提升');
  assert.equal(change.值, '学徒');
  assert.equal(change.分支ID, '拜师');
  assert.equal(group.暂存.length, 1);
  assert.equal(group.暂存[0].ID, '林澜·守塔期的初始装备');
  assert.equal(data.元数据.暂存.数量, 1);
});

test('视图-数据-5：如果视图所需的方案、选项、分支与角色组齐备', async t => {
  const root = await fixture(t);
  const data = await loadViewData(root);
  assert.deepEqual(data.开局.方案.map(plan => plan.方案ID), ['码头少年', '补考之年']);
  assert(data.开局.选项.内容.选项.length === 2);
  assert(data.事件.filter(event => event.分支.length).length > 0);
  assert(data.角色组.every(group => group.版本.length > 0 && group.档案.length > 0));
  assert.deepEqual(data.分类.主类型, ['世界', '关系', '个人']);
  assert(data.分类.事件结果.includes('身份变化'));
});

test('视图-数据-6：畸形事件不使数据面崩溃，检查错误如实返回', async t => {
  const root = await fixture(t);
  await edit(root, eventFile, value => { value.分支 = '坏'; });
  const data = await loadViewData(root);
  assert.equal(data.元数据.计数.事件, 13);
  assert(data.元数据.检查.错误 > 0 || data.元数据.检查.提示 > 0);
  assert(Array.isArray(data.元数据.数据异常));
  const event = data.事件.find(item => item.事件ID === '拜师');
  assert.equal(event.分支.length, 0);
});

test('视图-数据-7：同一目录两次读取的排序与内容一致', async t => {
  const root = await fixture(t);
  const first = await loadViewData(root);
  const second = await loadViewData(root);
  assert.deepEqual(first, second);
});

test('视图-数据-8：分类与对象键来自现行声明和引用索引', async t => {
  const root = await fixture(t);
  const data = await loadViewData(root);
  for (const event of data.事件) {
    assert(data.分类.主类型.includes(event.主类型));
    for (const tag of event.标签) assert(data.分类.标签.includes(tag));
    for (const result of event.事件结果) assert(data.分类.事件结果.includes(result));
  }
  const group = data.角色组.find(item => item.角色组ID === '灯塔学徒');
  assert.equal(group.文件, groupFile);
  assert(group.档案.every(profile => profile.适用版本.length > 0));
});
