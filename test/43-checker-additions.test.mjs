import {test, assert, fixture, edit, write, checkWorldbook, loadRouting, change, D, S, errorCode, readSettings, fs, path} from './router-helpers.mjs';

test('查-1：预设事件变化引用玩家时报变化.玩家', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/事件.txt', event => {
    event.分支.find(branch => branch.分支ID === '拜师').变化.push({路径: '角色.秦守.关系.玩家', 操作: '设定', 值: '相识'});
  });
  const result = await checkWorldbook(root, {sampling: false}); assert.ok(result.errors.some(item => item.规则 === '变化.玩家'));
});

test('查-1b：预设事件变化写玩家值时报变化.玩家', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/事件.txt', event => {
    event.分支.find(branch => branch.分支ID === '拜师').变化.push({路径: '角色.玩家.知识', 操作: '新增', 值: '灯塔收了徒弟'});
  });
  const result = await checkWorldbook(root, {sampling: false}); assert.ok(result.errors.some(item => item.规则 === '变化.玩家'));
});

test('查-2：动态事件协议仍允许玩家引用', async () => {
  const {protocol} = await loadRouting(), state = S(protocol, '072');
  const result = D(protocol, state, [{路径: '角色.秦守.关系.玩家', 操作: '设定', 值: '相识'}]);
  assert.equal(result.state.角色.秦守.关系.玩家, '相识');
});

for (const [name, value] of [
  ['经历负数', {运行参数: {经历: {条数: -1}}}], ['未知键', {运行参数: {预算: 1}}],
  ['未知库', {运行参数: {条目字符: {法术: 100}}}], ['根类型错误', {运行参数: 3}],
]) test(`查-3：${name}时报运行参数.格式`, async t => {
  const root = await fixture(t); await write(path.dirname(root), 'yggdrasill.yaml', value);
  const result = await checkWorldbook(root, {sampling: false}); assert.ok(result.errors.some(item => item.规则 === '运行参数.格式'));
});

test('查-4：只改提及窗口，其余取默认，路由不再提及白棠', async t => {
  const root = await fixture(t); await write(path.dirname(root), 'yggdrasill.yaml', {运行参数: {提及窗口: 1}});
  const settings = await readSettings(path.dirname(root), {fs, path});
  assert.equal(settings.提及窗口, 1); assert.equal(settings.经历.条数, 6); assert.equal(settings.候选.字符, 4000);
  const {protocol, router} = await loadRouting(root), result = (await import('../core/router.mjs')).route(router,
    (await import('./router-helpers.mjs')).R0(protocol), ['棠小姐托人来问，雾季的灯号会不会改。', '秦守在值守室里讲起灯语·长夜信号的手法。']);
  assert.equal(result.context.被提及角色, undefined); assert.equal(result.audit.提及.角色组.find(item => item.角色组ID === '白棠'), undefined);
  assert.equal(result.errors, undefined);
});

test('检查器边界：动态变化不触发变化.玩家，缺文件不报运行参数格式', async t => {
  const root = await fixture(t); await fs.rm(path.join(path.dirname(root), 'yggdrasill.yaml'), {force: true});
  const result = await checkWorldbook(root, {sampling: false}); assert.equal(result.errors.some(item => item.规则 === '运行参数.格式'), false);
});
