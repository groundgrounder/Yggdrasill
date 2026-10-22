import {test, assert, loadProtocol, changedProtocol, eventFile, apprenticeGroup, S, record, records72, records74, roles72, roles74,
  errorCode, fogGate, eventStatus, resolveProfile, chainStatus} from './protocol-helpers.mjs';
const {protocol: p} = await loadProtocol();
const profile = (state, id) => resolveProfile(p, state, id);

test('封卷-070：完整骨架与剧情标记开局值', () => {
  assert.deepEqual(S(p, '070'), {世界: {当前时间: '潮历070年', 剧情标记: {灯塔状态: '运转', 雾季: '未至'}},
    开局: {开局时间: '潮历070年', 已封卷: true, 历史选择: {}, 角色组: {
      周岚: {启用: false, 版本ID: '周岚'}, 灯塔学徒: {启用: true, 版本ID: '林澜'},
      白棠: {启用: true, 版本ID: '白棠'}, 秦守: {启用: true, 版本ID: '秦守'}}, 玩家: {模式: '自建', 档案: {}}},
    角色: {}, 事件: {}, 待定项: []});
});
test('封卷-072：完整记录、角色、世界与派生读取', () => {
  const s = S(p, '072');
  assert.deepEqual(s.事件, records72); assert.deepEqual(s.角色, roles72);
  assert.deepEqual(s.世界, {当前时间: '潮历072年', 剧情标记: {灯塔状态: '重燃', 雾季: '已至'}, 天气: '雾'});
  assert.deepEqual(['灯塔学徒', '白棠', '秦守', '周岚'].map(id => profile(s, id)), [
    {结果: '成立', 档案ID: '林澜·学徒期'}, {结果: '成立', 档案ID: '白棠·商会期'},
    {结果: '成立', 档案ID: '秦守·守塔期'}, {结果: '未启用'}]);
  assert.equal(chainStatus(p, s, '学徒修习'), '进行中'); assert.equal(chainStatus(p, s, '雾夜余波'), '已结束');
  assert.deepEqual(eventStatus(p, s, '出师考核'), {状态: '候选', 分支: ['通过', '未通过']});
  for (const id of ['港务署问责']) assert.deepEqual(eventStatus(p, s, id), {状态: '已排除'});
  assert.deepEqual(eventStatus(p, s, '学修船'), {状态: '不适用'});
  assert.deepEqual(eventStatus(p, S(p, '072-02-01'), '学修船'), {状态: '已排除'});
  assert.deepEqual(eventStatus(p, s, '秦守讲旧事'), {状态: '不适用'});
});
test('封卷-074：完整记录与角色、不自动初始化', () => {
  const s = S(p, '074'); assert.deepEqual(s.事件, records74); assert.deepEqual(s.角色, roles74);
  assert.equal(profile(s, '灯塔学徒').档案ID, '林澜·守塔期'); assert.equal(chainStatus(p, s, '学徒修习'), '已结束');
  assert.deepEqual(eventStatus(p, s, '秦守讲旧事'), {状态: '已排除'});
});
test('封卷-1：码头少年方案', () => {
  const s = S(p, null, {方案: '码头少年'});
  assert.deepEqual(s.事件, {...records72, 拜师: record('未拜师', '071-01-10', ['灯塔学徒', '秦守']),
    夜间值守: {状态: 2}, 学徒守灯: record('在镇上听闻', '071-04-20', ['灯塔学徒'])});
  assert.deepEqual(s.角色, {灯塔学徒: {身份: ['码头帮工'], 知识: ['大雾那夜灯塔熄了半宿']}, 白棠: roles72.白棠});
  assert.equal(s.世界.剧情标记.灯塔状态, '熄灭'); assert.deepEqual(s.开局.历史选择, {拜师: '未拜师'});
  assert.equal(s.开局.方案, '码头少年'); assert.equal(chainStatus(p, s, '学徒修习'), '已结束');
  assert.equal(profile(s, '灯塔学徒').档案ID, '林澜·少年期');
});
test('封卷-2：补考之年方案', () => {
  const s = S(p, null, {方案: '补考之年'});
  assert.deepEqual(s.事件, {...records72, 出师考核: record('未通过', '072-02-01', ['灯塔学徒', '秦守']), 潮汐号首航: {状态: 2}});
  assert.deepEqual(s.角色, {...roles72, 灯塔学徒: {...roles72.灯塔学徒, 知识: ['秦守在雾夜守住了灯', '秦守说灯号还差一口气']}});
  assert.deepEqual(eventStatus(p, s, '补考'), {状态: '候选', 分支: ['通过', '再次未通过']});
  assert.equal(profile(s, '灯塔学徒').档案ID, '林澜·学徒期');
});
test('封卷-3：白棠船长版本', () => {
  const s = S(p, '074', {角色组: {白棠: {版本ID: '白棠·船长'}}});
  assert.deepEqual(s.事件, {...records74, 接手商会账目: {状态: 2}, 潮汐号首航: record('启航', '072-04-92', ['白棠'])});
  assert.deepEqual(s.角色, {...roles74, 白棠: {知识: ['雾夜里码头的钟响了一整夜'], 所在: '北湾', 身份: ['潮汐号船长']}});
  assert.equal(profile(s, '白棠').档案ID, '白棠·航海期');
});
test('封卷-4：启用周岚', () => {
  const s = S(p, '072', {角色组: {周岚: {启用: true}}});
  assert.deepEqual(s.事件, {...records72, 港务署问责: record('问责秦守', '071-04-30', ['周岚'])});
  assert.deepEqual(s.角色, {...roles72, 周岚: {知识: ['灯塔在雾夜熄过灯']}, 秦守: {...roles72.秦守, 知识: ['港务署来问过熄灯的事']}});
});
test('封卷-5：关闭秦守', () => {
  const s = S(p, '072', {角色组: {秦守: {启用: false}}});
  assert.deepEqual(s.事件, {...records72, 拜师: {状态: 2}, 夜间值守: {状态: 2}, 学徒守灯: record('在镇上听闻', '071-04-20', ['灯塔学徒'])});
  assert.deepEqual(s.角色, {灯塔学徒: {知识: ['大雾那夜灯塔熄了半宿']}, 白棠: roles72.白棠});
  assert.equal(chainStatus(p, s, '学徒修习'), '未开始'); assert.equal(profile(s, '灯塔学徒').档案ID, '林澜·少年期');
});
test('封卷-6：大雾之夜未发生', () => {
  const s = S(p, '074', {历史选择: {大雾之夜: '未发生'}});
  assert.deepEqual(s.事件, {...records74, 大雾之夜: {状态: 2}, 学徒守灯: {状态: 2}, 白棠在码头: {状态: 2}});
  const expected = structuredClone(roles74);
  for (const field of ['天赋', '好感度', '知识']) delete expected.灯塔学徒[field];
  delete expected.秦守.好感度; delete expected.白棠.知识;
  assert.deepEqual(s.角色, expected);
  assert.deepEqual(s.世界, {当前时间: '潮历074年', 剧情标记: {灯塔状态: '运转', 雾季: '未至'}});
  assert.equal(chainStatus(p, s, '雾夜余波'), '未开始');
});
test('封卷-7：直接参数覆盖方案', () => {
  const s = S(p, '074', {方案: '码头少年', 角色组: {白棠: {版本ID: '白棠·船长'}}});
  assert.equal(s.开局.开局时间, '潮历074年'); assert.equal(s.世界.剧情标记.灯塔状态, '熄灭');
  assert.deepEqual(s.事件, {...records74, 拜师: record('未拜师', '071-01-10', ['灯塔学徒', '秦守']),
    夜间值守: {状态: 2}, 学徒守灯: record('在镇上听闻', '071-04-20', ['灯塔学徒']), 出师考核: {状态: 2}, 正式守灯: {状态: 2}, 接手商会账目: {状态: 2}});
});
test('封卷-8：扮演模式没有当前地点时仍读所在', () => {
  const s = S(p, '074', {玩家: {模式: '扮演', 扮演角色组: '灯塔学徒'}});
  assert.deepEqual(s.开局.玩家, {模式: '扮演', 扮演角色组: '灯塔学徒'});
  assert.deepEqual(s.事件, records74); assert.deepEqual(s.角色, roles74);
});
for (const [id, choices] of [
  ['E1', [{}, {方案: '不存在'}]],
  ['E2', [{开局时间: '潮历072年', 角色组: {渔夫: {启用: true}}}, {开局时间: '潮历072年', 角色组: {白棠: {版本ID: '船长'}}}]],
  ['E3', [{开局时间: '潮历072年', 玩家: {模式: '扮演', 扮演角色组: '周岚'}}]],
  ['E4', [{开局时间: '潮历072年', 历史选择: {出师考核: '通过'}}]],
  ['E5', [{开局时间: '潮历073年', 历史选择: {拜师: '未拜师', 出师考核: '通过'}}]],
  ['E6', [{开局时间: '潮历073年', 历史选择: {学修船: '学会'}}, {开局时间: '潮历073年', 历史选择: {拜师: '出海'}}]],
]) test(`封卷-${id}：非法配置`, () => {
  for (const value of choices) assert.throws(() => p.seal(value), errorCode(['E1', 'E2', 'E3'].includes(id) ? '封卷.参数' : '封卷.历史选择'));
});
test('封卷-E7：较晚事件解锁较早事件时报倒流', async t => {
  const {protocol} = await changedProtocol(t, eventFile('大雾之夜'), event => { event.门槛 = {事件确认: {事件ID: '出师考核', 分支ID: '通过'}}; });
  assert.throws(() => S(protocol, '074'), errorCode('封卷.时间顺序冲突'));
});
test('封卷-E8：排斥代入冲突与关闭周岚的对照', async t => {
  const {protocol} = await changedProtocol(t, eventFile('白棠在码头'), event => { event.门槛 = fogGate; });
  assert.throws(() => S(protocol, '072', {角色组: {周岚: {启用: true}}}), errorCode('封卷.配置冲突'));
  assert.deepEqual(S(protocol, '072').事件, records72);
});

test('封卷-参数边界：显式空值、错误形态与自建档案越界均拒绝', () => {
  for (const choices of [{角色组: null}, {角色组: {白棠: null}}, {角色组: {白棠: {版本ID: null}}},
    {玩家: null}, {玩家: {模式: '自建', 备注: '多余'}}, {玩家: {模式: '自建', 档案: {能力特征: {}}}}, {历史选择: []}])
    assert.throws(() => S(p, '072', choices), errorCode('封卷.参数'));
});
