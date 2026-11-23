import {runTree} from '../cli/tree.mjs';
import {compileWorldbook, summarizeQuotes, exportEventTreeMarkdown} from '../core/index.mjs';
import {test, assert, fs, path, project, example, fixture, edit} from './helpers.mjs';

async function compile(root = example) {
  const {catalog, decl} = await compileWorldbook(root, {fs, path});
  return {catalog, decl};
}

async function run(args) {
  let stdout = '', stderr = '';
  const status = await runTree(args, {
    cwd: project,
    stdout: {write: value => { stdout += value; }},
    stderr: {write: value => { stderr += value; }},
  });
  return {status, stdout, stderr, value: stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : null};
}

test('台词-1：雾港实数与按角色组、按事件口径精确一致', async () => {
  const {catalog} = await compile();
  const result = summarizeQuotes(catalog);
  assert.deepEqual(result.总计, {事件总数: 13, 有角色位置事件数: 4, 角色位置总数: 7, 有台词角色位置数: 4,
    缺台词角色位置数: 3, 候选台词总数: 4, 原台词数: 1, 作者台词数: 3, 原台词占比: 0.25,
    有事件级出处事件数: 13, 台词记录总数: 1});
  assert.deepEqual(result.按角色组.map(group => [group.角色组ID, group.显示名, group.角色位置数,
    group.有台词角色位置数, group.候选台词总数, group.原台词数, group.作者台词数, group.原台词占比]), [
    ['灯塔学徒', '灯塔学徒', 3, 1, 1, 0, 1, 0],
    ['白棠', '白棠', 1, 1, 1, 0, 1, 0],
    ['秦守', '秦守', 3, 2, 2, 1, 1, 0.5],
  ]);
  assert.deepEqual(result.按事件.find(item => item.事件ID === '拜师'),
    {事件ID: '拜师', 事件标题: '灯塔收徒', 有事件级出处: true, 角色位置数: 2, 有台词角色位置数: 2,
      候选台词总数: 2, 原台词数: 1, 作者台词数: 1});
  assert.equal(result.按事件.length, 13);
  const empty = summarizeQuotes({events: [], groups: [], sources: null});
  assert.deepEqual(empty.总计, {事件总数: 0, 有角色位置事件数: 0, 角色位置总数: 0, 有台词角色位置数: 0,
    缺台词角色位置数: 0, 候选台词总数: 0, 原台词数: 0, 作者台词数: 0, 原台词占比: 0,
    有事件级出处事件数: 0, 台词记录总数: 0});
});

test('台词-2：台词记录精确匹配计原台词，未记录计作者台词', async t => {
  const root = await fixture(t);
  await edit(path.dirname(root), '作者资料/出处/雾港.yaml', records => {
    records.push({事件ID: '白棠在码头', 角色组ID: '白棠', 台词: '先把缆绳收紧，等雾散一层再看。', 来源: '作者补记'});
  });
  await edit(root, '历史/事件/白棠在码头/角色/白棠.txt', position => {
    position.事件触发语料[0].候选台词.push('雾还没散，先别解缆。');
  });
  const {catalog} = await compile(root);
  const result = summarizeQuotes(catalog);
  assert.deepEqual([result.总计.候选台词总数, result.总计.原台词数, result.总计.作者台词数,
    result.总计.原台词占比, result.总计.台词记录总数], [5, 2, 3, 0.4, 2]);
  const group = result.按角色组.find(item => item.角色组ID === '白棠');
  assert.deepEqual([group.候选台词总数, group.原台词数, group.作者台词数, group.有台词角色位置数], [2, 1, 1, 1]);
});

test('事件树-1：导出逐字节一致且各分节齐全', async () => {
  const {catalog, decl} = await compile();
  const first = exportEventTreeMarkdown(catalog, decl, {标题: '雾港'});
  const second = exportEventTreeMarkdown(catalog, decl, {标题: '雾港'});
  assert.equal(first, second);
  for (const fragment of ['# 事件树：雾港', '### 事件串：学徒修习', '### 事件串：雾夜余波',
    '## 独立事件', '## 台词统计', '## 结构异常', '孤立成员：无',
    '时间窗口：潮历071年01月10日 至 潮历071年01月10日', '- 拜师（默认）：变化 5 条',
    '缺台词角色位置（3）', '- 出师考核／灯塔学徒', '| 秦守 | 3 | 2 | 2 | 1 | 1 | 50.00% |']) {
    assert.ok(first.includes(fragment), fragment);
  }
  assert.equal((first.match(/^#### 事件：/gmu) ?? []).length, 8, '事件串成员事件块');
  assert.equal((first.match(/^### 事件：/gmu) ?? []).length, 5, '独立事件块');
});

test('事件树-2：结构异常分节列出不可达事件', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/学修船/事件.txt', event => {
    event.门槛 = {事件确认: {事件ID: '拜师', 分支ID: '不存在的分支'}};
  });
  const {catalog, decl} = await compile(root);
  const markdown = exportEventTreeMarkdown(catalog, decl, {标题: '雾港'});
  assert.ok(markdown.includes('## 结构异常'));
  assert.ok(markdown.includes('事件树.不可达'));
  assert.ok(markdown.includes('| 提示 |'));
});

test('tree-CLI-1：默认正文、--stats-only 与 --json 固定键', async () => {
  const plain = await run(['test/fixtures/雾港/世界书']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.startsWith('# 事件树：雾港\n'), '默认输出完整 Markdown');

  const stats = await run(['test/fixtures/雾港/世界书', '--stats-only']);
  assert.equal(stats.status, 0, stats.stderr);
  assert.match(stats.stdout, /^事件树统计：雾港\n- 事件 13（独立 5），事件串 2；可达 13，不可达 0，结构异常 0\n/u);
  assert.match(stats.stdout, /- 候选台词 4：原台词 1（25\.00%），作者台词 3；台词记录 1 条\n/u);

  const json = await run(['test/fixtures/雾港/世界书', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(Object.keys(json.value), ['世界书', '摘要', '事件串', '独立事件', '台词统计', 'markdown', '输出文件', '异常']);
  assert.deepEqual(json.value.异常, []);
  assert.equal(json.value.markdown, plain.stdout);
  assert.deepEqual(json.value.摘要, {标题: '雾港', 事件: 13, 事件串: 2, 独立事件: 5, 可达事件: 13, 不可达事件: 0,
    结构异常数: 0, 候选台词总数: 4, 原台词数: 1, 作者台词数: 3, 原台词占比: 0.25,
    有事件级出处事件数: 13, 台词记录总数: 1});
  assert.deepEqual(json.value.事件串.map(chain => [chain.事件串ID, chain.起点]),
    [['学徒修习', ['拜师']], ['雾夜余波', ['大雾之夜']]]);
  assert.deepEqual(json.value.独立事件, ['接手商会账目', '港务署问责', '潮汐号首航', '白棠在码头', '秦守讲旧事']);

  const statsJson = await run(['test/fixtures/雾港/世界书', '--stats-only', '--json']);
  assert.equal(statsJson.status, 0);
  assert.equal(statsJson.value.markdown, null);
  assert.equal(statsJson.value.输出文件, null);
});

test('tree-CLI-2：--out 写入世界书外，拒绝世界书内部且零写入', async t => {
  const root = await fixture(t);
  const target = path.join(path.dirname(root), '导出目录', '事件树.md');
  const result = await run([root, '--out', target]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^已写入：.*事件树\.md（事件 13，事件串 2，候选台词 4，原台词 1）\n$/u);
  const content = await fs.readFile(target, 'utf8');
  assert.ok(content.startsWith('# 事件树：'), '文件内容为完整 Markdown');

  const inside = await run([root, '--out', path.join(root, '生成', '事件树.md')]);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /事件树导出\.路径：导出路径不能落在世界书目录内/u);
  await assert.rejects(fs.access(path.join(root, '生成', '事件树.md')), /ENOENT/u, '目标文件未创建');
  await assert.rejects(fs.access(path.join(root, '生成')), /ENOENT/u, '目标目录未创建');

  const equal = await run([root, '--out', root]);
  assert.equal(equal.status, 1);
  assert.match(equal.stderr, /事件树导出\.路径/u);
});

test('tree-CLI-3：参数错误退出非零，且不读取 来源资料/', async () => {
  const missing = await run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /用法：ygg tree/u);

  for (const args of [['--未知'], ['a', 'b'], ['test/fixtures/雾港/世界书', '--out']]) {
    const failure = await run(args);
    assert.equal(failure.status, 1, args.join(' '));
    assert.match(failure.stderr, /事件树导出\.参数/u, args.join(' '));
  }

  const guardFs = new Proxy(fs, {get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (first, ...rest) => {
      if (String(first).includes('来源资料')) throw new Error(`不应读取 来源资料：${first}`);
      return value(first, ...rest);
    };
  }});
  let stdout = '', stderr = '';
  const status = await runTree(['test/fixtures/雾港/世界书', '--json'], {cwd: project,
    stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}, fs: guardFs});
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).异常, []);
});

test('tree-CLI-4：目录不存在与编译错误报读取失败', async t => {
  const absent = await run(['examples/不存在的目录']);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /事件树导出\.读取失败/u);

  const root = await fixture(t);
  await edit(root, '设定/纪年.yaml', value => { value.年位数 = '坏'; });
  const broken = await run([root]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /事件树导出\.读取失败/u);
  const brokenJson = await run([root, '--json']);
  assert.equal(brokenJson.status, 1);
  assert.equal(brokenJson.value.异常[0].规则, '事件树导出.读取失败');
  assert.equal(brokenJson.value.markdown, null);
});

test('事件树-3：--json 结局可达与 Markdown（不可达）结论一致', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/正式守灯/事件.txt', event => {
    event.门槛 = {事件确认: {事件ID: '拜师', 分支ID: '不存在的分支'}};
  });
  const json = await run([root, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const chain = json.value.事件串.find(item => item.事件串ID === '学徒修习');
  assert.ok(chain.结局.some(item => item.事件ID === '正式守灯'), '结局仍如实列出');
  assert.ok(!chain.结局可达.some(item => item.事件ID === '正式守灯'), '不可达结局不在 结局可达 中');
  assert.deepEqual(chain.结局可达, [{事件ID: '拜师', 分支ID: '未拜师'}]);
  const markdown = await run([root]);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /结局：正式守灯（不可达）、拜师（分支 未拜师）/u);
});

test('tree-CLI-5：--out 经符号链接进入世界书内部拒绝且零写入', async t => {
  const root = await fixture(t);
  const linked = path.join(path.dirname(root), '世界书链接');
  await fs.symlink(root, linked);
  const direct = await run([root, '--out', path.join(linked, '事件树.md')]);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /事件树导出\.路径：导出路径不能落在世界书目录内/u);
  const nested = await run([root, '--out', path.join(linked, '生成', '事件树.md')]);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /事件树导出\.路径：导出路径不能落在世界书目录内/u);
  await assert.rejects(fs.access(path.join(root, '事件树.md')), /ENOENT/u, '链接直下未创建文件');
  await assert.rejects(fs.access(path.join(root, '生成')), /ENOENT/u, '多级未建子路径未创建目录');
});
