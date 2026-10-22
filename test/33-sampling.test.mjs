import {test, assert, fixture, edit, example, loadProtocol, eventFile, apprenticeGroup, youngGroup, fogGate, path} from './protocol-helpers.mjs';
import {checkWorldbook, samplingYears, checkSampling} from '../checker/index.mjs';
import {runCli} from '../cli/ygg.mjs';
const hasRule = (result, rule) => [...result.errors, ...result.hints].some(item => item.规则 === rule);
const removeAncestor = group => { delete group.档案.find(profile => profile.档案ID === '林澜·守塔期').前置档案; };
const setFogGate = event => { event.门槛 = fogGate; };
const checkMutation = async (t, mutate) => { const root = await fixture(t); await mutate(root); return {root, result: await checkWorldbook(root)}; };
test('抽样-1：雾港年份集合', async () => {
  const {catalog, decl} = await loadProtocol(); assert.deepEqual(samplingYears(catalog, decl), [70, 71, 72, 73, 74]);
});
test('抽样-2：雾港静态与抽样均无错误无提示', async () => {
  const result = await checkWorldbook(example); assert.deepEqual(result.errors, []); assert.deepEqual(result.hints, []);
});
test('抽样-3：无前置链的时期档案报告冲突和组合上下文', async t => {
  const {result} = await checkMutation(t, root => edit(root, apprenticeGroup, removeAncestor));
  assert.ok(hasRule(result, '抽样.档案冲突'));
  const conflicts = result.errors.filter(item => item.规则 === '抽样.档案冲突');
  assert.ok(conflicts.some(item => item.说明.includes('074') || item.说明.includes('74')));
  assert.ok(conflicts.every(item => item.说明.includes('版本') && item.说明.includes('事件状态组合')));
});
test('抽样-4：禁用抽样与CLI的static-only均只运行静态检查', async t => {
  const root = await fixture(t); await edit(root, apprenticeGroup, removeAncestor);
  const result = await checkWorldbook(root, {sampling: false}); assert.deepEqual(result.errors, []); assert.deepEqual(result.hints, []);
  let output = '', error = '';
  const code = await runCli(['check', root, '--json', '--static-only'], {stdout: {write: text => { output += text; }}, stderr: {write: text => { error += text; }}});
  assert.equal(code, 0); assert.equal(error, ''); assert.deepEqual(JSON.parse(output), result);
});
test('抽样-5：静态错误时提示未执行，static-only省略提示', async t => {
  const {root, result} = await checkMutation(t, root => edit(root, eventFile('拜师'), event => { event.备注 = '备注'; }));
  assert.ok(hasRule(result, '事件.未知字段')); assert.ok(hasRule(result, '抽样.未执行'));
  assert.equal(hasRule(await checkWorldbook(root, {sampling: false}), '抽样.未执行'), false);
});
test('抽样-6：全部启用变体072年起封卷配置冲突', async t => {
  const {result} = await checkMutation(t, root => edit(root, eventFile('白棠在码头'), setFogGate));
  const failures = result.errors.filter(item => item.规则 === '抽样.封卷失败');
  assert.equal(failures.length, 6);
  assert.ok(failures.every(item => /年份 7[234]/u.test(item.说明) && item.说明.includes('全部启用') && item.说明.includes('封卷.配置冲突')));
});
test('抽样-7：方案指定门槛不成立的历史分支时报错', async t => {
  const {result} = await checkMutation(t, root => edit(root, '历史/开局方案/码头少年.yaml', plan => { plan.开局时间 = '潮历073年'; plan.历史选择.出师考核 = '通过'; }));
  assert.ok(hasRule(result, '开局.方案封卷失败'));
});
test('抽样-8：补考选项在默认历史不可选，只出两条提示', async t => {
  const {result} = await checkMutation(t, root => edit(root, '历史/开局选项.yaml', options => {
    options.选项.push({事件ID: '补考', 问题: '学徒补考结果如何？', 选项: {通过: '顺利通过', 再次未通过: '再练一年'}});
  }));
  assert.deepEqual(result.errors, []); assert.equal(result.hints.filter(item => item.规则 === '开局.选项不可选').length, 2);
});
test('抽样-9：默认启用周岚使选项、方案与运行抽样均捕获配置冲突', async t => {
  const {result} = await checkMutation(t, async root => {
    await edit(root, eventFile('白棠在码头'), setFogGate); await edit(root, youngGroup, group => { group.默认启用 = true; });
  });
  for (const rule of ['开局.选项封卷失败', '开局.方案封卷失败', '抽样.封卷失败']) assert.ok(hasRule(result, rule), rule);
});
test('抽样-10：15360组合超过上限时跳过版本而不报错误', async t => {
  const {result} = await checkMutation(t, root => edit(root, apprenticeGroup, group => {
    group.档案.find(profile => profile.档案ID === '林澜·守塔期').生效条件 = {all: [{事件确认: {事件ID: '正式守灯'}},
      {none: [{事件确认: {事件ID: '港务署问责'}}, {事件确认: {事件ID: '学徒守灯', 分支ID: '独自守灯'}},
        {事件确认: {事件ID: '白棠在码头', 分支ID: '指挥靠港'}}, {事件确认: {事件ID: '补考', 分支ID: '再次未通过'}},
        {事件确认: {事件ID: '出师考核', 分支ID: '未通过'}}]}]};
  }));
  assert.deepEqual(result.errors, []); assert.ok(result.hints.some(item => item.规则 === '抽样.组合过多' && item.说明.includes('15360')));
});
test('抽样-11：年精度最晚终点未过时方案不能选择', async t => {
  const {result} = await checkMutation(t, async root => {
    await edit(root, eventFile('出师考核'), event => { event.触发时间 = {最早: '潮历072年', 最晚: '潮历072年'}; });
    await edit(root, '历史/开局方案/补考之年.yaml', plan => { plan.开局时间 = '潮历072年04月01日'; });
  }); assert.ok(hasRule(result, '开局.方案选择'));
});
test('抽样-12：仅作候选事件不能声明开局选项', async t => {
  const {result} = await checkMutation(t, root => edit(root, '历史/开局选项.yaml', options => {
    options.选项.push({事件ID: '学修船', 问题: '学徒学会修船了吗？', 选项: {学会: '学会补帆'}});
  })); assert.ok(hasRule(result, '开局.选项引用'));
});
test('抽样-异常传播：只捕获ProtocolError', async () => {
  const {catalog, decl} = await loadProtocol();
  catalog.groups.find(group => group.id === '灯塔学徒').内容.档案.find(profile => profile.档案ID === '林澜·守塔期').生效条件 = {不存在: {}};
  assert.throws(() => checkSampling(catalog, decl), error => !(error.name === 'ProtocolError') && error.message.includes('未登记条件类型'));
});
