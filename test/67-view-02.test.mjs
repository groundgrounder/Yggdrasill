import {assert, test, fs, path, project, fixture, edit} from './helpers.mjs';
import {runCli} from '../cli/ygg.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {previewContext} from '../core/context-preview.mjs';
import {formatYamlText} from '../core/format.mjs';
import {exportEventTreeMarkdown, summarizeQuotes} from '../core/tree-export.mjs';
import {parseYaml, stringifyYaml} from '../core/yaml.mjs';
import {loadViewData, digest} from '../view/data.mjs';
import {createViewStore, fingerprintProject, MAX_CANDIDATE} from '../view/store.mjs';
import {startViewServer} from '../view/server.mjs';

const eventFile = '历史/事件/拜师/事件.txt';
const positionFile = '历史/事件/拜师/角色/秦守.txt';

const newEventRaw = id => `事件ID: ${id}
事件概要: 测试创建的事件。
主类型: 关系
标签: [修习]
事件结果: [身份变化]
触发时间: {最早: 潮历075年01月01日, 最晚: 潮历075年01月01日}
确认策略: 自动确认
核心参与者: []
默认分支: 默认
分支:
  - 分支ID: 默认
    分支条件: 条件文本。
    分支结果: 结果文本。
`;

const newPositionRaw = group => `事件ID: 拜师
角色组ID: ${group}
角色概要: ${group}在码头看学徒登塔。
角色定位: [旁观者]
`;

async function setup(t, options = {}) {
  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '审阅');
  const store = createViewStore({worldbook: root, storage, ...options});
  return {root, storage, store};
}

async function serve(t, options = {}) {
  const root = await fixture(t);
  const storage = path.join(path.dirname(root), '审阅');
  const app = await startViewServer({worldbook: root, storage, port: 0, repoRoot: project, ...options});
  t.after(() => app.close());
  return {root, storage, app};
}

const post = (app, route, body, headers = {}) => fetch(`${app.url}${route}`, {method: 'POST',
  headers: {'Content-Type': 'application/json', 'X-Review-Token': app.token, ...headers}, body: JSON.stringify(body)});

test('视图-02-数据-1：台词统计与声明来自现行内核且两次读取一致', async t => {
  const root = await fixture(t);
  const data = await loadViewData(root);
  const {catalog, decl} = await compileWorldbook(root, {fs, path});
  assert.deepEqual(data.台词统计, summarizeQuotes(catalog));
  assert.deepEqual(data.台词统计.总计, {事件总数: 13, 有角色位置事件数: 4, 角色位置总数: 7,
    有台词角色位置数: 4, 缺台词角色位置数: 3, 候选台词总数: 4, 原台词数: 1, 作者台词数: 3,
    原台词占比: 0.25, 有事件级出处事件数: 13, 台词记录总数: 1});
  const declaration = data.声明;
  assert.deepEqual(declaration.剧情标记, {灯塔状态: ['运转', '熄灭', '重燃'], 雾季: ['未至', '已至', '已过']});
  assert.deepEqual(declaration.综合实力等级, ['学徒', '熟手', '匠人', '名匠']);
  assert.deepEqual(declaration.确认策略, ['自动确认', '条件确认', '仅作候选']);
  assert.ok(declaration.角色状态字段.includes('所在') && declaration.角色状态字段.includes('身体状态.健康'));
  assert.ok(declaration.角色可写字段.includes('角色.{角色组ID}.装备.{装备ID}'));
  assert.ok(declaration.角色可写字段.includes('角色.{角色组ID}.技艺.灯语'));
  assert.ok(declaration.世界可写字段.includes('世界.剧情标记.灯塔状态'));
  assert.ok(declaration.世界可写字段.includes('世界.天气'));
  const apprentice = data.事件.find(event => event.事件ID === '拜师');
  for (const position of apprentice.角色位置)
    assert.equal(position.revision, digest(position.原文 ?? ''));
  const second = await loadViewData(root);
  assert.deepEqual(data, second);
  assert.deepEqual(data.元数据.计数, {事件: 13, 事件串: 2, 角色组: 4, 档案: 11, 条目: 18, 文件: 87});
  void decl;
});

test('视图-02-服务-1：POST /api/context 与直接 previewContext 一致，只读且有键守卫', async t => {
  const {root, app} = await serve(t);
  const before = await fingerprintProject(root);
  const body = {地点: '灯塔', 场景: '值守室', 在场: ['灯塔学徒', '秦守'], 消息: ['灯号会不会改。'], raw: true};
  const response = await post(app, '/api/context', body);
  assert.equal(response.status, 200);
  const viaApi = await response.json();
  const direct = await previewContext(root, {fs, path, 地点: '灯塔', 场景: '值守室',
    在场: ['灯塔学徒', '秦守'], 消息: ['灯号会不会改。'], raw: true});
  assert.deepEqual(viaApi, direct);
  assert.ok(viaApi.汇总.总字符 > 0);
  assert.ok(viaApi.预算.经历.条数上限 > 0);
  assert.ok(viaApi.正文.length > 0);
  assert.equal(await fingerprintProject(root), before);

  const 本局 = await post(app, '/api/context', {本局: '/tmp/x.json'});
  assert.equal(本局.status, 400);
  assert.match((await 本局.json()).error, /未知字段/);
  const unknown = await post(app, '/api/context', {未知: 1});
  assert.equal(unknown.status, 400);
  const badLocation = await post(app, '/api/context', {地点: '不存在地标'});
  assert.equal(badLocation.status, 400);
  const failure = await badLocation.json();
  assert.equal(failure.code, '上下文.地点');
  assert.match(failure.error, /地标不存在/);
  assert.equal((await post(app, '/api/context', {}, {'X-Review-Token': 'wrong'})).status, 403);
  assert.equal((await fetch(`${app.url}/api/context`, {method: 'POST',
    headers: {'Content-Type': 'text/plain', 'X-Review-Token': app.token}, body: '{}'})).status, 403);
});

test('视图-02-服务-2：GET /api/tree.md 逐字节一致、附件头与只读边界', async t => {
  const {root, app} = await serve(t);
  await fs.mkdir(path.join(path.dirname(root), '来源资料'), {recursive: true});
  await fs.writeFile(path.join(path.dirname(root), '来源资料', '毒药.yaml'), '若被读取即失败');
  const before = await fingerprintProject(root);
  const {catalog, decl} = await compileWorldbook(root, {fs, path});
  const expected = exportEventTreeMarkdown(catalog, decl, {标题: path.basename(root)});
  const response = await fetch(`${app.url}/api/tree.md`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await response.text(), expected);
  assert.equal(response.headers.get('content-disposition'), null);
  const download = await fetch(`${app.url}/api/tree.md?download=1`);
  assert.match(download.headers.get('content-disposition') ?? '',
    /^attachment; filename="event-tree\.md"; filename\*=UTF-8''event-tree\.md$/u);
  assert.equal(await download.text(), expected);
  assert.equal(await fingerprintProject(root), before);
});

test('视图-02-服务-3：/api/yaml/parse 与 format 单一事实来源且拒绝危险输入', async t => {
  const {app} = await serve(t);
  const raw = await fs.readFile(path.join(project, 'examples/雾港/世界书/历史/事件/拜师/事件.txt'), 'utf8');
  const parsed = await (await post(app, '/api/yaml/parse', {kind: 'event', raw})).json();
  assert.equal(parsed.value.事件ID, '拜师');
  assert.deepEqual(parsed.value, parseYaml(raw));

  const positionRaw = await fs.readFile(path.join(project, 'examples/雾港/世界书/历史/事件/拜师/角色/秦守.txt'), 'utf8');
  const positionParsed = await (await post(app, '/api/yaml/parse', {kind: 'position', raw: positionRaw})).json();
  assert.equal(positionParsed.value.角色组ID, '秦守');

  const value = parsed.value;
  value.事件概要 = '结构化表单改写的事件概要。';
  const formatted = await (await post(app, '/api/yaml/format', {kind: 'event', value})).json();
  assert.ok(formatted.raw.includes('事件ID: 拜师'));
  const reformatted = formatYamlText(formatted.raw, {kind: {种类: '事件'}});
  assert.equal(reformatted.changed, false, '服务端格式化产物应已规范');
  assert.deepEqual(parseYaml(formatted.raw), value);

  const typed = {事件ID: '类型保持', 数值: 10, 装备: {装备ID: '灯', 状态: '完好'}, 列表: ['a', 'b']};
  const typedRaw = (await (await post(app, '/api/yaml/format', {kind: 'event', value: typed})).json()).raw;
  const typedBack = (await (await post(app, '/api/yaml/parse', {kind: 'event', raw: typedRaw})).json()).value;
  assert.equal(typedBack.数值, 10);
  assert.deepEqual(typedBack.装备, {装备ID: '灯', 状态: '完好'});
  assert.deepEqual(typedBack.列表, ['a', 'b']);

  for (const [label, body] of [
    ['非法 YAML', {kind: 'event', raw: '事件ID: [x'}],
    ['非映射根', {kind: 'event', raw: '- 1\n- 2\n'}],
    ['危险键', {kind: 'event', raw: 'a: 1\n__proto__:\n  b: 2\n'}],
    ['超长原文', {kind: 'event', raw: `a: ${'x'.repeat(MAX_CANDIDATE)}`}],
    ['未知 kind', {kind: 'group', raw: 'a: 1\n'}],
    ['format 非对象', {kind: 'event', value: []}],
    ['format 未知 kind', {kind: '角色组', value: {}}],
  ]) {
    const route = 'raw' in body ? '/api/yaml/parse' : '/api/yaml/format';
    const response = await post(app, route, body);
    assert.equal(response.status, 400, label);
  }
});

test('视图-02-存储-1：新建事件预览走完整静态检查并签发令牌', async t => {
  const {root, storage, store} = await setup(t);
  const before = await fingerprintProject(root);
  const raw = newEventRaw('新事件');
  const result = await store.previewCreateEvent({eventID: '新事件', raw});
  assert.equal(result.validation.通过, true, JSON.stringify(result.validation.错误列表));
  assert.equal(result.validation.模式, '静态检查');
  assert.equal(result.unchanged, false);
  assert.ok(result.token);
  assert.equal(result.revision, digest(raw));
  assert.equal(result.文件, '历史/事件/新事件/事件.txt');
  assert.ok(result.diff.some(row => row.type === '+') && !result.diff.some(row => row.type === '-'));
  assert.equal(result.输入.临时副本, '世界书 + 作者资料/出处 + yggdrasill.yaml');
  assert.equal(await fingerprintProject(root), before, '预览不写世界书');
  await assert.rejects(fs.access(storage), {code: 'ENOENT'});

  const again = await store.previewCreateEvent({eventID: '新事件', raw});
  assert.ok(again.token, '未保存前可重复预览');
  await store.save({token: result.token, raw});
  await assert.rejects(store.save({token: again.token, raw}), /目标文件已出现|发生变化/);
  await assert.rejects(store.previewCreateEvent({eventID: '拜师', raw}), /事件已存在/);

  for (const badID of ['玩家', '__proto__', '../x', 'a/b', 'a\\b', '.', '..', '.隐藏', '']) {
    await assert.rejects(store.previewCreateEvent({eventID: badID, raw: newEventRaw(badID || 'x')}),
      error => error.status === 400, JSON.stringify(badID));
  }
  await assert.rejects(store.previewCreateEvent({eventID: '过大', raw: `a: ${'x'.repeat(MAX_CANDIDATE)}`}), /256KB/u);
  const mismatch = await store.previewCreateEvent({eventID: '改名', raw: newEventRaw('另一个')});
  assert.equal(mismatch.validation.通过, false);
  assert.equal(mismatch.token, null);
  assert.ok(mismatch.validation.错误列表.some(item => item.说明.includes('事件ID须等于目录名')));
  const notMap = await store.previewCreateEvent({eventID: '列表', raw: '- 1\n'});
  assert.equal(notMap.validation.通过, false);
  assert.equal(notMap.token, null);
});

test('视图-02-存储-2：新建事件保存、只增不删备份、0o644 与回滚清理', async t => {
  const {root, storage, store} = await setup(t);
  const raw = newEventRaw('新事件');
  const preview = await store.previewCreateEvent({eventID: '新事件', raw});
  const saved = await store.save({token: preview.token, raw});
  assert.equal(saved.saved, true);
  assert.equal(await fs.readFile(path.join(root, '历史/事件/新事件/事件.txt'), 'utf8'), raw);
  assert.equal((await fs.stat(path.join(root, '历史/事件/新事件/事件.txt'))).mode & 0o777, 0o644);
  assert.equal(saved.检查.模式, '完整检查');
  assert.equal(saved.检查.通过, true, JSON.stringify(saved.检查.错误列表));
  const metadata = JSON.parse(await fs.readFile(path.join(storage, saved.backup, '修改说明.json'), 'utf8'));
  assert.equal(metadata.操作, '新建事件');
  assert.equal(metadata.事件ID, '新事件');
  assert.equal(metadata.源文件, '历史/事件/新事件/事件.txt');
  assert.equal(metadata.修改前哈希, null);
  assert.equal(metadata.修改后哈希, digest(raw));
  await assert.rejects(fs.access(path.join(storage, saved.backup, '事件.txt')), {code: 'ENOENT'});
  assert.equal((await fs.readdir(path.join(storage, '修改备份'))).length, 1);
  await assert.rejects(store.save({token: preview.token, raw}), /过期|不存在/);

  const rolled = await store.restore(saved.backup);
  assert.equal(rolled.操作, '新建事件');
  assert.equal(rolled.哈希, null);
  assert.equal(rolled.检查.通过, true);
  await assert.rejects(fs.access(path.join(root, '历史/事件/新事件/事件.txt')), {code: 'ENOENT'});
  await assert.rejects(fs.access(path.join(root, '历史/事件/新事件')), {code: 'ENOENT'});
  await assert.rejects(store.restore(saved.backup), /无法读取待回滚文件/);
  assert.equal((await fs.readdir(path.join(storage, '修改备份'))).length, 1, '备份只增不删');

  const keep = await store.previewCreateEvent({eventID: '留位置', raw: newEventRaw('留位置')});
  const keepSaved = await store.save({token: keep.token, raw: newEventRaw('留位置')});
  const positionPreview = await store.previewPosition({eventID: '留位置', groupID: '周岚',
    raw: newPositionRaw('周岚').replaceAll('事件ID: 拜师', '事件ID: 留位置'), revision: ''});
  assert.equal(positionPreview.validation.通过, true, JSON.stringify(positionPreview.validation.错误列表));
  await store.save({token: positionPreview.token,
    raw: newPositionRaw('周岚').replaceAll('事件ID: 拜师', '事件ID: 留位置')});
  const eventRolled = await store.restore(keepSaved.backup);
  assert.equal(eventRolled.操作, '新建事件');
  assert.ok(await fs.access(path.join(root, '历史/事件/留位置/角色/周岚.txt')).then(() => true, () => false),
    '目录内仍有其他文件时不删除');
  void storage;
});

test('视图-02-存储-3：角色位置编辑/新建的预览、令牌与 409 边界', async t => {
  const {root, store} = await setup(t);
  const data = await loadViewData(root);
  const position = data.事件.find(event => event.事件ID === '拜师').角色位置.find(item => item.角色组ID === '秦守');
  const changed = position.原文.replace('秦守在灯塔门口判断学徒是否愿意守规矩学灯语。',
    '秦守在灯塔门口打量来客是否愿意守规矩学灯语。');

  const edit = await store.previewPosition({eventID: '拜师', groupID: '秦守', raw: changed, revision: position.revision});
  assert.equal(edit.validation.通过, true, JSON.stringify(edit.validation.错误列表));
  assert.equal(edit.unchanged, false);
  assert.ok(edit.token);
  assert.equal(edit.当前revision, digest(position.原文));

  const unchanged = await store.previewPosition({eventID: '拜师', groupID: '秦守', raw: position.原文, revision: position.revision});
  assert.equal(unchanged.validation.通过, true);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.token, null);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '秦守', raw: changed, revision: '坏值'}), /外部修改/);
  const created = await store.previewPosition({eventID: '拜师', groupID: '周岚', raw: newPositionRaw('周岚'), revision: ''});
  assert.equal(created.validation.通过, true, JSON.stringify(created.validation.错误列表));
  assert.ok(created.token);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '周岚', raw: newPositionRaw('周岚'), revision: 'x'}), /revision 须为空/);
  await assert.rejects(store.previewPosition({eventID: '不存在', groupID: '周岚', raw: newPositionRaw('周岚'), revision: ''}), /未知事件/);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '不存在', raw: newPositionRaw('不存在'), revision: ''}), /角色组不存在/);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '玩家', raw: newPositionRaw('玩家'), revision: ''}), /保留字/);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '../x', raw: 'x', revision: ''}), /路径分隔符/);
  await assert.rejects(store.previewPosition({eventID: '拜师', groupID: '周岚', raw: 'x'.repeat(MAX_CANDIDATE + 1), revision: ''}), /256KB/u);

  const wrongGroup = await store.previewPosition({eventID: '拜师', groupID: '秦守',
    raw: newPositionRaw('周岚'), revision: position.revision});
  assert.equal(wrongGroup.validation.通过, false);
  assert.equal(wrongGroup.token, null);
  assert.ok(wrongGroup.validation.错误列表.some(item => item.说明.includes('角色组ID须等于文件名')));
  const wrongEvent = await store.previewPosition({eventID: '拜师', groupID: '周岚',
    raw: newPositionRaw('周岚').replaceAll('事件ID: 拜师', '事件ID: 补考'), revision: ''});
  assert.equal(wrongEvent.validation.通过, false);
  assert.equal(wrongEvent.token, null);
});

test('视图-02-存储-4：角色位置保存备份 角色位置.txt、权限保留与三类恢复', async t => {
  const {root, storage, store} = await setup(t);
  const data = await loadViewData(root);
  const position = data.事件.find(event => event.事件ID === '拜师').角色位置.find(item => item.角色组ID === '秦守');
  const file = path.join(root, positionFile);
  const changed = position.原文.replace('秦守在灯塔门口判断学徒是否愿意守规矩学灯语。',
    '秦守在灯塔门口打量来客是否愿意守规矩学灯语。');
  await fs.chmod(file, 0o640);
  const edit = await store.previewPosition({eventID: '拜师', groupID: '秦守', raw: changed, revision: position.revision});
  const saved = await store.save({token: edit.token, raw: changed});
  assert.equal(saved.saved, true);
  assert.equal(saved.角色组ID, '秦守');
  assert.equal(saved.检查.通过, true, JSON.stringify(saved.检查.错误列表));
  assert.equal(await fs.readFile(file, 'utf8'), changed);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640, '保留原文件权限');
  const metadata = JSON.parse(await fs.readFile(path.join(storage, saved.backup, '修改说明.json'), 'utf8'));
  assert.equal(metadata.操作, '编辑角色位置');
  assert.equal(metadata.角色组ID, '秦守');
  assert.equal(metadata.备份文件, '角色位置.txt');
  assert.equal(metadata.修改前哈希, digest(position.原文));
  assert.equal(await fs.readFile(path.join(storage, saved.backup, '角色位置.txt'), 'utf8'), position.原文);

  await fs.appendFile(file, '\n');
  await assert.rejects(store.restore(saved.backup), /又被修改/);
  await fs.writeFile(file, changed);
  const restored = await store.restore(saved.backup);
  assert.equal(restored.哈希, digest(position.原文));
  assert.equal(await fs.readFile(file, 'utf8'), position.原文);
  assert.equal(restored.检查.通过, true);

  const create = await store.previewPosition({eventID: '拜师', groupID: '周岚', raw: newPositionRaw('周岚'), revision: ''});
  const created = await store.save({token: create.token, raw: newPositionRaw('周岚')});
  assert.equal((await fs.stat(path.join(root, '历史/事件/拜师/角色/周岚.txt'))).mode & 0o777, 0o644);
  const createMeta = JSON.parse(await fs.readFile(path.join(storage, created.backup, '修改说明.json'), 'utf8'));
  assert.equal(createMeta.操作, '新建角色位置');
  assert.equal(createMeta.修改前哈希, null);
  const rolled = await store.restore(created.backup);
  assert.equal(rolled.操作, '新建角色位置');
  await assert.rejects(fs.access(path.join(root, '历史/事件/拜师/角色/周岚.txt')), {code: 'ENOENT'});
  assert.equal((await fs.readdir(path.join(root, '历史/事件/拜师/角色'))).length, 2, '既有角色位置保留');
});

test('视图-02-存储-5：既有事件编辑备份结构保持原样（回归保护）', async t => {
  const {root, storage, store} = await setup(t);
  const data = await loadViewData(root);
  const event = data.事件.find(item => item.事件ID === '拜师');
  const changed = event.原文.replace('让他到灯塔学习灯语。', '让他到灯塔学习灯语与潮汐。');
  const preview = await store.preview({eventID: '拜师', raw: changed, revision: event.revision});
  const saved = await store.save({token: preview.token, raw: changed});
  const metadata = JSON.parse(await fs.readFile(path.join(storage, saved.backup, '修改说明.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata), ['事件ID', '源文件', '保存时间', '修改前哈希', '修改后哈希']);
  assert.equal(await fs.readFile(path.join(storage, saved.backup, '事件.txt'), 'utf8'), event.原文);
  const restored = await store.restore(saved.backup);
  assert.equal(await fs.readFile(path.join(root, eventFile), 'utf8'), event.原文);
  assert.equal(restored.事件ID, '拜师');
});

test('视图-02-服务-4：HTTP 新建事件、编辑角色位置与统一 /api/save', async t => {
  const {root, app} = await serve(t);
  const create = await (await post(app, '/api/event/create/preview', {eventID: '新建甲', raw: newEventRaw('新建甲')})).json();
  assert.equal(create.validation.通过, true, JSON.stringify(create.validation.错误列表));
  assert.ok(create.token);
  const saved = await (await post(app, '/api/save', {token: create.token, raw: newEventRaw('新建甲')})).json();
  assert.equal(saved.saved, true);
  assert.ok(await fs.access(path.join(root, '历史/事件/新建甲/事件.txt')).then(() => true, () => false));

  const data = await (await fetch(`${app.url}/api/data`)).json();
  const position = data.事件.find(event => event.事件ID === '拜师').角色位置.find(item => item.角色组ID === '秦守');
  const changed = position.原文.replace('秦守在灯塔门口判断学徒是否愿意守规矩学灯语。',
    '秦守在灯塔门口打量来客是否愿意守规矩学灯语。');
  const positionPreview = await (await post(app, '/api/position/preview',
    {eventID: '拜师', groupID: '秦守', raw: changed, revision: position.revision})).json();
  assert.ok(positionPreview.token);
  const positionSaved = await (await post(app, '/api/save', {token: positionPreview.token, raw: changed})).json();
  assert.equal(positionSaved.角色组ID, '秦守');
  assert.equal(await fs.readFile(path.join(root, positionFile), 'utf8'), changed);

  const newViaHttp = await (await post(app, '/api/position/preview',
    {eventID: '拜师', groupID: '周岚', raw: newPositionRaw('周岚'), revision: ''})).json();
  assert.ok(newViaHttp.token);
  const newSaved = await (await post(app, '/api/save', {token: newViaHttp.token, raw: newPositionRaw('周岚')})).json();
  assert.equal(newSaved.saved, true);

  assert.equal((await post(app, '/api/event/create/preview', {eventID: '新建甲', raw: newEventRaw('新建甲')})).status, 409);
  assert.equal((await post(app, '/api/event/create/preview', {}, {'X-Review-Token': 'wrong'})).status, 403);
  assert.equal((await fetch(`${app.url}/api/unknown-new`)).status, 404);
});

test('视图-02-表单-1：表单产物经格式化管线保存后通过 ygg format --check', async t => {
  const {root, store} = await setup(t);
  const data = await loadViewData(root);
  const event = data.事件.find(item => item.事件ID === '拜师');
  const value = parseYaml(event.原文);
  value.事件概要 = '结构化表单改写后的事件概要。';
  value.分支[0].变化.push({路径: '角色.灯塔学徒.身份', 操作: '新增', 值: '编外的学徒'});
  const raw = formatYamlText(stringifyYaml(value), {kind: {种类: '事件'}}).text;
  const preview = await store.preview({eventID: '拜师', raw, revision: event.revision});
  assert.equal(preview.validation.通过, true, JSON.stringify(preview.validation.错误列表));
  const saved = await store.save({token: preview.token, raw});
  assert.equal(saved.saved, true);
  let stdout = '', stderr = '';
  const code = await runCli(['format', root, '--check', '--json'], {
    stdout: {write: text => { stdout += text; }}, stderr: {write: text => { stderr += text; }}});
  void code;
  const byFile1 = new Map(JSON.parse(stdout).文件.map(item => [item.文件, item.状态]));
  assert.equal(byFile1.get('历史/事件/拜师/事件.txt'), '无差异', '保存产物通过 ygg format --check');
  assert.equal(JSON.parse(stdout).项目.异常, 0);

  const positionValue = parseYaml(await fs.readFile(path.join(root, positionFile), 'utf8'));
  positionValue.角色概要 = '结构化表单改写后的角色概要。';
  const positionRaw = formatYamlText(stringifyYaml(positionValue), {kind: {种类: '角色位置'}}).text;
  const revision = digest(await fs.readFile(path.join(root, positionFile), 'utf8'));
  const positionPreview = await store.previewPosition({eventID: '拜师', groupID: '秦守', raw: positionRaw, revision});
  assert.equal(positionPreview.validation.通过, true, JSON.stringify(positionPreview.validation.错误列表));
  await store.save({token: positionPreview.token, raw: positionRaw});
  let positionStdout = '';
  const positionCode = await runCli(['format', root, '--check', '--json'], {
    stdout: {write: text => { positionStdout += text; }}, stderr: {write: () => {}}});
  void positionCode;
  const byFile2 = new Map(JSON.parse(positionStdout).文件.map(item => [item.文件, item.状态]));
  assert.equal(byFile2.get('历史/事件/拜师/角色/秦守.txt'), '无差异', '角色位置保存产物通过 ygg format --check');
});

test('视图-02-安全-1：畸形候选、路径越界与静态资源负例不签发令牌', async t => {
  const {store} = await setup(t);
  const data = await loadViewData(path.join(project, 'examples/雾港/世界书'));
  const event = data.事件.find(item => item.事件ID === '拜师');
  const wrapped = `<事件>\n${event.原文}\n</事件>\n`;
  const wrappedResult = await store.previewCreateEvent({eventID: '包裹', raw: wrapped});
  assert.equal(wrappedResult.validation.通过, false);
  assert.equal(wrappedResult.token, null);
  const polluted = `${newEventRaw('污染')}    变化:\n      - {路径: 角色.灯塔学徒.__proto__.所在, 操作: 设定, 值: 灯塔}\n`;
  const pollutedResult = await store.previewCreateEvent({eventID: '污染', raw: polluted});
  assert.equal(pollutedResult.validation.通过, false);
  assert.equal(pollutedResult.token, null);

  const {app} = await serve(t);
  for (const target of ['/%2e%2e/view/store.mjs', '/public/event-editor.js', '/nope.js']) {
    assert.equal((await fetch(app.url + target)).status, 404, target);
  }
  for (const asset of ['/context-view.js', '/stats-view.js', '/condition-editor.js', '/event-editor.js', '/position-editor.js']) {
    const response = await fetch(app.url + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/u, asset);
  }
});

test('视图-02-检查-1：新建事件与角色位置后的世界书通过现行检查器', async t => {
  const {root, store} = await setup(t);
  const create = await store.previewCreateEvent({eventID: '检查事件', raw: newEventRaw('检查事件')});
  await store.save({token: create.token, raw: newEventRaw('检查事件')});
  const position = await store.previewPosition({eventID: '检查事件', groupID: '灯塔学徒',
    raw: `事件ID: 检查事件\n角色组ID: 灯塔学徒\n角色概要: 学徒围观自己的事件。\n角色定位: [当事人]\n`, revision: ''});
  assert.equal(position.validation.通过, true, JSON.stringify(position.validation.错误列表));
  await store.save({token: position.token,
    raw: `事件ID: 检查事件\n角色组ID: 灯塔学徒\n角色概要: 学徒围观自己的事件。\n角色定位: [当事人]\n`});
  const check = await checkWorldbook(root, {sampling: true});
  assert.deepEqual(check.errors, [], JSON.stringify(check.errors));
  const data = await loadViewData(root);
  assert.equal(data.元数据.计数.事件, 14);
  assert.equal(data.台词统计.总计.事件总数, 14);
});

test('视图-02-上下文-1：自动初始化与消息拆分与 ygg context 同源', async t => {
  const {root, app} = await serve(t);
  const result = await (await post(app, '/api/context',
    {开局: '潮历071年01月01日', 地点: '灯塔', 在场: ['灯塔学徒'], 消息: ['第一句。', '第二句。']})).json();
  assert.deepEqual(result.输入.在场, ['灯塔学徒']);
  assert.deepEqual(result.输入.模拟初始化, ['灯塔学徒']);
  assert.deepEqual(result.输入.消息, ['第一句。', '第二句。']);
  assert.ok(result.汇总.分块字符.在场角色 > 0);
  const direct = await previewContext(root, {fs, path, 开局: '潮历071年01月01日', 地点: '灯塔',
    在场: ['灯塔学徒'], 消息: ['第一句。', '第二句。']});
  assert.equal(result.汇总.总字符, direct.汇总.总字符);
  const strict = await post(app, '/api/context', {开局: '潮历071年01月01日', 地点: '灯塔', 在场: ['灯塔学徒'], 自动初始化: false});
  assert.equal(strict.status, 400);
  assert.equal((await strict.json()).code, '上下文.场景');
});

test('视图-02-回归-1：YAML 错误草稿不丢失，切换表单失败时保持 YAML', async t => {
  const {app} = await serve(t);
  const data = await (await fetch(`${app.url}/api/data`)).json();
  const event = data.事件.find(item => item.事件ID === '拜师');
  const broken = `${event.原文}\n坏缩进: [\n`;
  const failure = await post(app, '/api/yaml/parse', {kind: 'event', raw: broken});
  assert.equal(failure.status, 400);
  assert.match((await failure.json()).error, /YAML 解析失败/);
  const stillParses = await post(app, '/api/yaml/parse', {kind: 'event', raw: event.原文});
  assert.equal(stillParses.status, 200);
  const restored = await post(app, '/api/yaml/parse', {kind: 'event', raw: event.原文});
  assert.equal((await restored.json()).value.事件ID, '拜师', '原草稿仍可解析，未丢失');
});

test('视图-02-回归-2：既有事件编辑仍拒绝改名与危险路径', async t => {
  const {store} = await setup(t);
  const data = await loadViewData(path.join(project, 'examples/雾港/世界书'));
  const event = data.事件.find(item => item.事件ID === '拜师');
  const renamed = event.原文.replace('事件ID: 拜师', '事件ID: 另一个事件');
  const result = await store.preview({eventID: '拜师', raw: renamed, revision: event.revision});
  assert.equal(result.validation.通过, false);
  assert.equal(result.token, null);
  const polluted = event.原文.replace('角色.灯塔学徒.所在', '角色.灯塔学徒.__proto__.所在');
  const pollutedResult = await store.preview({eventID: '拜师', raw: polluted, revision: event.revision});
  assert.equal(pollutedResult.validation.通过, false);
  assert.equal(pollutedResult.token, null);
});
