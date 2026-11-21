import {assert, test, fs, path, project, fixture} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {loadViewData} from '../view/data.mjs';
import {assertStorage, createViewStore, digest, fingerprintProject, PREVIEW_TTL} from '../view/store.mjs';

async function setup(t, options = {}) {
  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '审阅');
  const store = createViewStore({worldbook: root, storage, ...options});
  const data = await loadViewData(root);
  const event = data.事件.find(item => item.事件ID === '拜师');
  const changed = event.原文.replace('让他到灯塔学习灯语。', '让他到灯塔学习灯语与潮汐。');
  assert.notEqual(changed, event.原文);
  return {root, storage, store, data, event, changed, file: path.join(root, '历史/事件/拜师/事件.txt')};
}

const preview = (store, event, raw) => store.preview({eventID: event.事件ID, raw, revision: event.revision});

test('视图-存储-1：存储边界拒绝世界书、出处与实现仓库', async t => {
  const root = await fixture(t);
  const parent = path.dirname(root);
  await assert.rejects(assertStorage({worldbook: root, storage: path.join(root, '存储'), repoRoot: project}), /世界书/);
  await assert.rejects(assertStorage({worldbook: root, storage: path.join(parent, '作者资料', '出处', '审阅'), repoRoot: project}), /出处/);
  await assert.rejects(assertStorage({worldbook: root, storage: path.join(project, '.view-storage-probe'), repoRoot: project}), /实现仓库/);
  const ok = await assertStorage({worldbook: root, storage: path.join(parent, '存储'), repoRoot: project});
  assert.equal(ok.worldbook, await fs.realpath(root));
  assert.equal(ok.projectRoot, await fs.realpath(parent));
});

test('视图-存储-2：读取数据与状态不写源文件、不创建存储', async t => {
  const {root, storage, store} = await setup(t);
  const before = await fingerprintProject(root);
  await loadViewData(root);
  await store.readState();
  assert.equal(await fingerprintProject(root), before);
  await assert.rejects(fs.access(storage), {code: 'ENOENT'});
});

test('视图-存储-3：预览通过静态检查并给出输入、差异与影响反查', async t => {
  const {store, event, changed} = await setup(t);
  const result = await preview(store, event, changed);
  assert.equal(result.validation.通过, true, JSON.stringify(result.validation.错误列表));
  assert.equal(result.validation.模式, '静态检查');
  assert(result.token);
  assert.equal(result.unchanged, false);
  assert.equal(result.revision, digest(changed));
  assert(result.diff.some(row => row.type === '+'));
  assert.equal(result.输入.世界书, '世界书');
  assert.equal(result.输入.作者资料.出处.存在, true);
  assert(result.输入.作者资料.出处.文件 > 0);
  assert.equal(result.输入.运行参数.来源, '默认');
  assert.equal(result.输入.检查模式, '静态检查');
  assert(result.impact.下游.length >= 0);
  assert(result.impact.角色位置.includes('灯塔学徒'));
  assert(Array.isArray(result.impact.引用它));
});

test('视图-存储-4：预览保留作者资料/出处，同一出处错误不会消失', async t => {
  const {root, store, event, changed} = await setup(t);
  const sourceFile = path.join(path.dirname(root), '作者资料', '出处', '雾港.yaml');
  await fs.appendFile(sourceFile, '- {事件ID: 不存在的事件, 来源: 测试}\n');
  const result = await preview(store, event, changed);
  assert.equal(result.validation.通过, false);
  assert.equal(result.token, null);
  assert(result.validation.错误列表.some(item => item.规则 === '出处.引用'),
    JSON.stringify(result.validation.错误列表));

  // 反证：只复制世界书根目录时，出处规则静默消失。
  const only = path.join(path.dirname(root), '只有世界书');
  await fs.cp(root, path.join(only, '世界书'), {recursive: true});
  const check = await checkWorldbook(path.join(only, '世界书'), {sampling: false});
  assert.equal(check.errors.some(item => item.规则 === '出处.引用'), false);
});

test('视图-存储-5：包裹标签、危险路径与改名都不能签发令牌', async t => {
  const {store, event, changed} = await setup(t);
  const wrapped = `<事件>\n${changed}\n</事件>\n`;
  const wrappedResult = await preview(store, event, wrapped);
  assert.equal(wrappedResult.validation.通过, false);
  assert.equal(wrappedResult.token, null);
  assert(wrappedResult.validation.错误列表.some(item => item.规则 === '目录.包裹标签'));

  const polluted = changed.replace('角色.灯塔学徒.所在', '角色.灯塔学徒.__proto__.所在');
  assert.notEqual(polluted, changed);
  const pollutedResult = await preview(store, event, polluted);
  assert.equal(pollutedResult.validation.通过, false);
  assert.equal(pollutedResult.token, null);
  assert(pollutedResult.validation.错误列表.some(item => item.规则 === '视图.候选'
    && item.说明.includes('危险')));

  const renamed = changed.replace('事件ID: 拜师', '事件ID: 另一个事件');
  const renamedResult = await preview(store, event, renamed);
  assert.equal(renamedResult.validation.通过, false);
  assert.equal(renamedResult.token, null);
});

test('视图-存储-6：保存写回、备份说明、全量检查与恢复演练', async t => {
  const {root, storage, store, event, changed, file} = await setup(t);
  const result = await preview(store, event, changed);
  assert(result.token);
  const saved = await store.save({token: result.token, raw: changed});
  assert.equal(saved.saved, true);
  assert.equal(await fs.readFile(file, 'utf8'), changed);
  assert.equal(saved.静态预览.模式, '静态检查');
  assert.equal(saved.检查.模式, '全量检查');
  assert.equal(saved.检查.通过, true, JSON.stringify(saved.检查.错误列表));
  const backup = path.join(storage, saved.backup);
  assert.equal(await fs.readFile(path.join(backup, '事件.txt'), 'utf8'), event.原文);
  const metadata = JSON.parse(await fs.readFile(path.join(backup, '修改说明.json'), 'utf8'));
  assert.equal(metadata.事件ID, event.事件ID);
  assert.equal(metadata.源文件, '历史/事件/拜师/事件.txt');
  assert.equal(metadata.修改前哈希, digest(event.原文));
  assert.equal(metadata.修改后哈希, digest(changed));
  assert.equal((await fs.readdir(path.join(storage, '修改备份'))).length, 1);
  await assert.rejects(store.save({token: result.token, raw: changed}), /过期|不存在/);

  const restored = await store.restore(saved.backup);
  assert.equal(restored.哈希, digest(event.原文));
  assert.equal(restored.检查.通过, true);
  assert.equal(await fs.readFile(file, 'utf8'), event.原文);
  assert.equal((await fs.readdir(path.join(storage, '修改备份'))).length, 1);
});

test('视图-存储-7：并发保存只允许第一个预览成功', async t => {
  const {store, event, changed, file} = await setup(t);
  const second = changed.replace('学习灯语与潮汐。', '学习灯语与潮汐，并记下潮位。');
  const first = await preview(store, event, changed);
  const other = await preview(store, event, second);
  assert(first.token && other.token);
  const results = await Promise.allSettled([
    store.save({token: first.token, raw: changed}),
    store.save({token: other.token, raw: second}),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = results.find(item => item.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(await fs.readFile(file, 'utf8'), results[0].status === 'fulfilled' ? changed : second);
});

test('视图-存储-8：原文与依赖变化拒绝旧预览，过期令牌返回 409', async t => {
  {
    const {store, event, changed, file} = await setup(t);
    const result = await preview(store, event, changed);
    await fs.appendFile(file, '\n');
    await assert.rejects(store.save({token: result.token, raw: changed}), /发生变化|外部修改/);
    assert.equal(await fs.readFile(file, 'utf8'), `${event.原文}\n`);
  }
  {
    const {root, store, event, changed} = await setup(t);
    const result = await preview(store, event, changed);
    await fs.appendFile(path.join(root, '角色/灯塔学徒/角色组.yaml'), '\n');
    await assert.rejects(store.save({token: result.token, raw: changed}), /发生变化/);
  }
  {
    const {root, store, event, changed} = await setup(t);
    const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
    await fs.writeFile(settingsFile, '运行参数:\n  经历:\n    条数: 2\n');
    const result = await preview(store, event, changed);
    await fs.appendFile(settingsFile, '\n');
    await assert.rejects(store.save({token: result.token, raw: changed}), /发生变化/);
  }
  {
    let clock = 1_700_000_000_000;
    const {store, event, changed} = await setup(t, {now: () => clock});
    const result = await preview(store, event, changed);
    clock += PREVIEW_TTL + 1;
    await assert.rejects(store.save({token: result.token, raw: changed}), /过期/);
  }
});

test('视图-存储-9：批注与布局独立保存，冲突、结构与原型键被拒绝', async t => {
  const {store, storage} = await setup(t);
  const current = await store.readState();
  assert.equal(current.revision, digest(''));
  assert.equal(current.damaged, false);
  const value = {notes: {'事件:拜师': {text: '检查人物动机', status: '需调整'}},
    layout: {'事件:拜师': {x: 150, y: 80}}};
  const saved = await store.saveState({revision: current.revision, value});
  assert.deepEqual((await store.readState()).value, value);
  await assert.rejects(store.saveState({revision: current.revision, value}), /其他窗口/);
  await assert.rejects(store.saveState({revision: saved.revision, value: {...value, events: []}}), /未知字段/);
  const polluted = JSON.parse('{"notes":{"__proto__":{"text":"x","status":"待审"}},"layout":{}}');
  await assert.rejects(store.saveState({revision: saved.revision, value: polluted}), /键不合法/);
  const oversized = {notes: {}, layout: {}};
  for (let index = 0; index < 200; index++) oversized.notes[`k${index}`] = {text: '字'.repeat(12_000), status: '待审'};
  await assert.rejects(store.saveState({revision: saved.revision, value: oversized}), /2MB/);

  const stateFile = path.join(storage, '审阅状态.json');
  await fs.mkdir(storage, {recursive: true});
  await fs.writeFile(stateFile, '{');
  const damaged = await store.readState();
  assert.equal(damaged.damaged, true);
  assert.equal(damaged.value.notes && Object.keys(damaged.value.notes).length, 0);
  const rebuilt = await store.saveState({revision: damaged.revision, value: {notes: {}, layout: {}}});
  assert.equal(rebuilt.revision, digest('{\n  "notes": {},\n  "layout": {}\n}\n'));
  assert.equal((await store.readState()).damaged, false);
});

test('视图-存储-10：保存保留文件权限，全量检查失败不被隐藏', async t => {
  {
    const {store, event, changed, file} = await setup(t);
    await fs.chmod(file, 0o640);
    const result = await preview(store, event, changed);
    await store.save({token: result.token, raw: changed});
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  }
  {
    const root = await fixture(t);
    const storage = path.join(path.dirname(root), '审阅');
    const store = createViewStore({worldbook: root, storage,
      check: (target, options) => options?.sampling === false
        ? checkWorldbook(target, options) : Promise.reject(new Error('模拟全量检查失败'))});
    const data = await loadViewData(root);
    const event = data.事件.find(item => item.事件ID === '拜师');
    const changed = event.原文.replace('让他到灯塔学习灯语。', '让他到灯塔学习灯语与潮汐。');
    const result = await preview(store, event, changed);
    const saved = await store.save({token: result.token, raw: changed});
    assert.equal(saved.saved, true);
    assert.equal(saved.检查.模式, '全量检查');
    assert.equal(saved.检查.通过, false);
    assert(saved.检查.错误列表.some(item => item.规则 === '视图.全量检查失败'));
  }
});

test('视图-存储-11：内容未改变时静态检查通过但不签发令牌', async t => {
  const {store, event} = await setup(t);
  const result = await preview(store, event, event.原文);
  assert.equal(result.validation.通过, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.token, null);
  assert.equal(result.diff.every(row => row.type === ' '), true);
});


test('视图-存储-12：预览保留项目运行参数', async t => {
  const {root, store, event, changed} = await setup(t);
  const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
  await fs.writeFile(settingsFile, '运行参数:\n  经历:\n    条数: 2\n');
  const data = await loadViewData(root);
  assert.equal(data.元数据.运行参数.来源, 'yggdrasill.yaml');
  assert.equal(data.元数据.运行参数.值.经历.条数, 2);
  const result = await preview(store, event, changed);
  assert.equal(result.validation.通过, true, JSON.stringify(result.validation.错误列表));
  assert.equal(result.输入.运行参数.来源, 'yggdrasill.yaml');
  assert.equal(result.输入.运行参数.值.经历.条数, 2);
});
