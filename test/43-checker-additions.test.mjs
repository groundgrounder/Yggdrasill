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

const branchFile = '历史/事件/拜师/事件.txt';
const branchOf = event => event.分支.find(item => item.分支ID === '拜师');

test('ROUTE-F04-查1：分支专属文本合法用法 0 错误，文本规则与长度预算自动覆盖', async t => {
  const root = await fixture(t);
  await edit(root, branchFile, event => Object.assign(branchOf(event), {
    事件概要: '学徒正式拜秦守为师。', 影响范围: '灯塔与码头之间的师徒关系。',
    公开信息: ['学徒在灯塔正式拜师。'], 隐秘信息: ['秦守收徒前曾连夜查看学徒的旧伤。'],
  }));
  const valid = await checkWorldbook(root, {sampling: false});
  assert.equal(valid.errors.length, 0, valid.errors.map(item => item.说明).join('；'));
  assert.equal(valid.errors.some(item => item.规则 === '分支.格式'), false);

  const textRoot = await fixture(t);
  await edit(textRoot, branchFile, event => Object.assign(branchOf(event), {
    事件概要: '分支正文出现索引一词。', 影响范围: '分支正文用了破折号——这里。',
  }));
  const text = await checkWorldbook(textRoot, {sampling: false});
  assert.ok(text.errors.some(item => item.规则 === '文本.禁用词' && item.文件 === branchFile && /索引/.test(item.说明)));
  assert.ok(text.errors.some(item => item.规则 === '文本.破折号' && item.文件 === branchFile));

  const longRoot = await fixture(t);
  await edit(longRoot, branchFile, event => { branchOf(event).事件概要 = '长'.repeat(900); });
  const long = await checkWorldbook(longRoot, {sampling: false});
  assert.equal(long.errors.length, 0);
  assert.ok(long.hints.some(item => item.规则 === '文本.长度' && item.文件 === branchFile));
});

for (const [label, value] of [
  ['事件概要须为非空文本', {事件概要: ''}],
  ['影响范围须为非空文本', {影响范围: ['不是文本']}],
  ['公开信息须为文本列表', {公开信息: '不是列表'}],
  ['公开信息须无重复', {公开信息: ['重复项。', '重复项。']}],
  ['隐秘信息须为单行', {隐秘信息: ['第一行\n第二行']}],
]) test(`ROUTE-F04-查2：分支${label}时报分支.格式`, async t => {
  const root = await fixture(t);
  await edit(root, branchFile, event => Object.assign(branchOf(event), value));
  const result = await checkWorldbook(root, {sampling: false});
  assert.ok(result.errors.some(item => item.规则 === '分支.格式' && item.文件 === branchFile));
});

test('ROUTE-F09a-查：在场角色预算默认温和，支持单项覆盖', async t => {
  const root = await fixture(t);
  assert.deepEqual((await readSettings(path.dirname(root), {fs, path})).在场角色, {完整人数: 6, 字符: 12000});
  await write(path.dirname(root), 'yggdrasill.yaml', {运行参数: {在场角色: {完整人数: 2}}});
  const merged = await readSettings(path.dirname(root), {fs, path});
  assert.deepEqual(merged.在场角色, {完整人数: 2, 字符: 12000});
  assert.equal(merged.经历.条数, 6);
});

for (const [label, value] of [
  ['未知键', {运行参数: {在场角色: {人数: 3}}}],
  ['完整人数负数', {运行参数: {在场角色: {完整人数: -1}}}],
  ['字符小数', {运行参数: {在场角色: {字符: 1.5}}}],
  ['非映射', {运行参数: {在场角色: '宽松'}}],
]) test(`ROUTE-F09a-查：在场角色${label}时报运行参数.格式`, async t => {
  const root = await fixture(t); await write(path.dirname(root), 'yggdrasill.yaml', value);
  const result = await checkWorldbook(root, {sampling: false});
  assert.ok(result.errors.some(item => item.规则 === '运行参数.格式'));
});
