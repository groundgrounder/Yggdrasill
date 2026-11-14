import {test, assert, fixture, edit, loadProtocol, loadRouting, seal, confirmDynamicEvent, writableFields, checkWorldbook,
  route, renderContext, ProtocolError, messages, R0} from './router-helpers.mjs';
import {MACHINE_FIELDS} from '../core/contract.mjs';

const STATE = {开局时间: '潮历071年'};
const chars = value => [...JSON.stringify(value)].length;

async function worldFixture(t) {
  const root = await fixture(t);
  await edit(root, '设定/本局变量.yaml', value => {
    Object.assign(value.世界, {
      题记: {形态: '文本'},
      地标: {引用: '地点'},
      粮仓: {数值: [0, 100]},
      传闻: {集合: {形态: '文本'}},
      季节: {映射: {键: {形态: '文本'}, 值: {取值: '词表.天气'}}},
      环境: {子字段: {温度: {数值: [-50, 50]}, 描述: {形态: '文本'}}},
    });
  });
  return root;
}

async function machineFixture(t) {
  const root = await fixture(t);
  await edit(root, '设定/条目库.yaml', value => {
    for (const name of MACHINE_FIELDS) value.地点.字段[name] = {形态: '文本'};
    value.地点.字段.嵌套 = {子字段: {默认: {形态: '文本'}, 变化: {形态: '文本'}}};
    value.地点.字段.情境 = {形态: '情境列表'};
  });
  await edit(root, '地点/北湾/雾港/灯塔/灯塔.txt', value => {
    for (const name of MACHINE_FIELDS) value[name] = `正文${name}`;
    value.嵌套 = {默认: '内层默认', 变化: '内层变化'};
    value.情境 = [{默认: '情境默认'}, {变化: '情境变化'}];
  });
  await edit(root, '地点/地点.txt', value => {
    for (const name of MACHINE_FIELDS) value[name] = `说明${name}`;
    value.嵌套 = {默认: '说明内层默认', 变化: '说明内层变化'};
    value.情境 = [{默认: '说明情境默认'}, {变化: '说明情境变化'}];
    value.空值 = '';
    value.空列表 = [];
  });
  return root;
}

test('核心-01-1：世界层数值、集合、映射、子字段经动态事件写入', async t => {
  const root = await worldFixture(t), checked = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(checked.errors, []);
  const {protocol, decl} = await loadProtocol(root), fields = writableFields(decl);
  for (const line of [
    '世界.题记：设定；文本',
    '世界.地标：设定；<地点ID>',
    '世界.粮仓：增加、减少；0 至 100 的整数',
    '世界.传闻：新增、移除；文本',
    '世界.季节.<键>：设定、新增、移除；晴 / 雾 / 风暴',
    '世界.环境.温度：增加、减少；-50 至 50 的整数',
    '世界.环境.描述：设定；文本',
  ]) assert.ok(fields.split('\n').includes(line), line);
  let state = seal(protocol, STATE);
  const write = (id, changes) => {
    state = confirmDynamicEvent(protocol, state, {事件ID: id, 摘要: '世界层写入回归', 变化: changes}).state;
  };
  write('世界写入·数值增加', [{路径: '世界.粮仓', 操作: '增加', 值: 20}]);
  assert.equal(state.世界.粮仓, 20);
  write('世界写入·数值减少', [{路径: '世界.粮仓', 操作: '减少', 值: 5}]);
  assert.equal(state.世界.粮仓, 15);
  write('世界写入·集合新增', [{路径: '世界.传闻', 操作: '新增', 值: '雾季将至'}]);
  assert.deepEqual(state.世界.传闻, ['雾季将至']);
  write('世界写入·集合移除', [{路径: '世界.传闻', 操作: '移除', 值: '雾季将至'}]);
  assert.deepEqual(state.世界.传闻, []);
  write('世界写入·映射设定', [{路径: '世界.季节.春', 操作: '设定', 值: '晴'}]);
  write('世界写入·映射新增', [{路径: '世界.季节.夏', 操作: '新增', 值: '雾'}]);
  assert.deepEqual(state.世界.季节, {春: '晴', 夏: '雾'});
  write('世界写入·映射移除', [{路径: '世界.季节.夏', 操作: '移除'}]);
  assert.deepEqual(state.世界.季节, {春: '晴'});
  write('世界写入·子字段增加', [{路径: '世界.环境.温度', 操作: '增加', 值: 10}]);
  write('世界写入·子字段减少', [{路径: '世界.环境.温度', 操作: '减少', 值: 3}]);
  assert.equal(state.世界.环境.温度, 7);
  write('世界写入·子字段设定', [{路径: '世界.环境.描述', 操作: '设定', 值: '潮冷'}]);
  assert.deepEqual(state.世界.环境, {温度: 7, 描述: '潮冷'});
  write('世界写入·文本与引用', [{路径: '世界.题记', 操作: '设定', 值: '潮起潮落'}, {路径: '世界.地标', 操作: '设定', 值: '灯塔'}]);
  assert.equal(state.世界.题记, '潮起潮落');
  assert.equal(state.世界.地标, '灯塔');
  write('世界写入·既有行为', [{路径: '世界.天气', 操作: '设定', 值: '雾'}, {路径: '世界.剧情标记.雾季', 操作: '设定', 值: '已过'},
    {路径: '角色.灯塔学徒.好感度.秦守', 操作: '增加', 值: 5}]);
  assert.equal(state.世界.天气, '雾');
  assert.equal(state.世界.剧情标记.雾季, '已过');
  assert.equal(state.角色.灯塔学徒.好感度.秦守, 5);
});

test('核心-01-2：世界层非法路径、操作、引用与值仍拒绝', async t => {
  const {protocol} = await loadProtocol(await worldFixture(t)), state = seal(protocol, STATE);
  const cases = [
    [{路径: '世界.不存在', 操作: '设定', 值: '甲'}, '变化.路径'],
    [{路径: '世界.粮仓', 操作: '设定', 值: 1}, '变化.操作'],
    [{路径: '世界.粮仓', 操作: '增加'}, '变化.格式'],
    [{路径: '世界.粮仓', 操作: '增加', 值: 0}, '变化.取值'],
    [{路径: '世界.粮仓', 操作: '增加', 值: 101}, '变化.取值'],
    [{路径: '世界.粮仓', 操作: '增加', 值: 1.5}, '变化.取值'],
    [{路径: '世界.传闻', 操作: '新增'}, '变化.格式'],
    [{路径: '世界.传闻', 操作: '设定', 值: '甲'}, '变化.操作'],
    [{路径: '世界.季节', 操作: '设定', 值: {春: '晴'}}, '变化.路径'],
    [{路径: '世界.季节.春', 操作: '增加', 值: 1}, '变化.操作'],
    [{路径: '世界.季节.春', 操作: '设定', 值: '雨'}, '变化.取值'],
    [{路径: '世界.季节.春', 操作: '移除', 值: '晴'}, '变化.取值'],
    [{路径: '世界.季节.春.', 操作: '设定', 值: '晴'}, '变化.路径'],
    [{路径: '世界.环境', 操作: '设定', 值: {温度: 1}}, '变化.路径'],
    [{路径: '世界.环境.湿度', 操作: '设定', 值: '甲'}, '变化.路径'],
    [{路径: '世界.环境.温度', 操作: '设定', 值: 1}, '变化.操作'],
    [{路径: '世界.环境.温度', 操作: '增加', 值: 101}, '变化.取值'],
    [{路径: '世界.地标', 操作: '设定', 值: '不存在'}, '变化.取值'],
    [{路径: '世界.题记', 操作: '设定', 值: ''}, '变化.取值'],
  ];
  for (const [change, rule] of cases) {
    assert.throws(() => confirmDynamicEvent(protocol, state, {事件ID: '世界负例', 摘要: '负例', 变化: [change]}),
      error => error instanceof ProtocolError && error.code === '协议.变化' && error.message.includes(rule), JSON.stringify(change));
  }
});

test('核心-01-3：同一世界写入重复提交确定且幂等', async t => {
  const {protocol} = await loadProtocol(await worldFixture(t));
  const changes = [{路径: '世界.粮仓', 操作: '增加', 值: 9}, {路径: '世界.季节.秋', 操作: '设定', 值: '风暴'}];
  const run = () => {
    const state = seal(protocol, STATE);
    const first = confirmDynamicEvent(protocol, state, {事件ID: '世界确定', 摘要: '确定', 变化: changes}).state;
    const again = confirmDynamicEvent(protocol, first, {事件ID: '世界确定', 摘要: '确定', 变化: changes});
    assert.deepEqual(again.state, first);
    return first;
  };
  assert.deepEqual(run(), run());
});

test('核心-01-4：条目与同名说明的机器字段同名键完整进入路由上下文', async t => {
  const root = await machineFixture(t), checked = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(checked.errors, []); assert.deepEqual(checked.hints, []);
  const {protocol, router} = await loadRouting(root), state = seal(protocol, STATE);
  state.世界.当前地点 = {地标: '灯塔', 场景: '观测室'};
  const result = route(router, state, []);
  const items = result.context.条目.地点;
  const entry = items.find(item => item.地点ID === '灯塔'), description = items.find(item => item.说明 === '地点');
  assert.ok(entry && description);
  for (const name of MACHINE_FIELDS) {
    assert.equal(entry[name], `正文${name}`);
    assert.equal(description.内容[name], `说明${name}`);
  }
  assert.deepEqual(entry.嵌套, {默认: '内层默认', 变化: '内层变化'});
  assert.deepEqual(description.内容.嵌套, {默认: '说明内层默认', 变化: '说明内层变化'});
  assert.deepEqual(entry.情境, [{默认: '情境默认'}, {变化: '情境变化'}]);
  assert.deepEqual(description.内容.情境, [{默认: '说明情境默认'}, {变化: '说明情境变化'}]);
  assert.equal(description.内容.空值, '');
  assert.deepEqual(description.内容.空列表, []);
  const rendered = renderContext(result.context);
  for (const text of ['正文默认', '正文变化', '说明门槛', '说明关联事件', '内层默认', '说明情境变化']) assert.ok(rendered.includes(text), text);
  const audit = result.audit.条目.地点, selected = audit.选入.find(item => item.条目ID === '灯塔');
  assert.equal(selected.字符, chars(entry) + chars(description));
  assert.equal(items.filter(item => item.说明 === '地点').length, 1);
});

test('核心-01-5：雾港既有路由预算、选入与去重不变', async () => {
  const {protocol, router} = await loadRouting(), result = route(router, R0(protocol), messages);
  assert.deepEqual(result.context.条目.地点.map(item => item.地点ID ?? item.说明), ['地点', '灯塔', '雾港', '北湾']);
  assert.deepEqual(result.audit.条目.地点.选入.map(item => item.条目ID), ['灯塔', '雾港', '北湾']);
  assert.equal(result.audit.条目.技能.字符, 374);
  assert.equal(result.audit.条目.装备.字符, 142);
  assert.equal(result.audit.条目.地点.字符, 221);
});
