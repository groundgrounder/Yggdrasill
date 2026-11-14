import {runCli} from '../cli/ygg.mjs';
import {readDeclarations, validateDeclarations, loadWorldbook, buildReferenceIndex, parseObjectKey}
  from '../core/index.mjs';
import {test, assert, fs, path, example, project, fixture, edit, write, read,
  finding, hint, assertIssues} from './helpers.mjs';

async function runJson(args) {
  let stdout = '', stderr = '';
  const status = await runCli(['trace', ...args, '--json'], {
    cwd: project,
    stdout: {write: value => { stdout += value; }},
    stderr: {write: value => { stderr += value; }},
  });
  return {status, stdout, stderr, value: stdout ? JSON.parse(stdout) : null};
}

async function loadIndex(root = example) {
  const {raw, issues: readIssues} = await readDeclarations(root, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(root, {fs, path, decl: compiled.decl});
  const index = buildReferenceIndex(catalog, compiled.decl, {issues: [...readIssues, ...compiled.issues, ...loadIssues]});
  return {catalog, decl: compiled.decl, index};
}

test('溯源-1：六类对象键均通过真实 CLI 查询', async () => {
  const cases = [
    ['事件:拜师', '事件'],
    ['事件串:学徒修习', '事件串'],
    ['角色组:秦守', '角色组'],
    ['档案:灯塔学徒:林澜·学徒期', '档案'],
    ['条目:技能:灯语·短讯', '条目'],
    ['剧情标记:灯塔状态', '剧情标记'],
  ];
  for (const [key, type] of cases) {
    const {status, value, stderr} = await runJson([example, key]);
    assert.equal(status, 0, `${key}\n${stderr}`);
    assert.equal(value.对象.对象键, key);
    assert.equal(value.对象.类型, type);
    assert.equal(typeof value.对象.定义文件, 'string');
    for (const partition of ['引用它', '它引用', '出处', '异常']) assert.ok(Array.isArray(value[partition]), key + partition);
    assert.deepEqual(value.异常, [], key);
  }
});

test('溯源-2：正向前置、下游位置与 any 路径', async () => {
  const event = await runJson([example, '事件:拜师']);
  assert.equal(event.status, 0);
  assert.ok(event.value.引用它.some(item => item.来源对象 === '事件:夜间值守'
    && item.字段 === '门槛' && item.引用种类 === '事件确认' && item.极性 === '正向'));
  assert.ok(event.value.引用它.some(item => item.来源对象 === '事件:学修船'
    && item.字段.includes('门槛') && item.引用种类 === '事件确认'));

  const retry = await runJson([example, '事件:补考']);
  assert.ok(retry.value.引用它.some(item => item.来源对象 === '事件:正式守灯'
    && item.字段 === '门槛.any[2]' && item.极性 === '正向'));
  const exam = await runJson([example, '事件:出师考核']);
  assert.ok(exam.value.引用它.some(item => item.来源对象 === '事件:补考' && item.字段 === '门槛'));
  assert.ok(exam.value.引用它.some(item => item.来源对象 === '事件:正式守灯' && item.字段 === '门槛.any[1]'));
});

test('溯源-3：排斥引用与正向引用分开标注', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/夜间值守/事件.txt', event => {
    event.门槛 = {none: [{事件确认: {事件ID: '学修船'}}]};
  });
  const result = await runJson([root, '事件:学修船']);
  assert.equal(result.status, 0);
  const reference = result.value.引用它.find(item => item.来源对象 === '事件:夜间值守');
  assert.equal(reference.字段, '门槛.none[1]');
  assert.equal(reference.引用种类, '事件确认');
  assert.equal(reference.极性, '排斥');
});

test('溯源-4：真实出处按事件和实际角色归位', async t => {
  const fogEvent = await runJson([example, '事件:拜师']);
  assert.equal(fogEvent.value.出处.length, 2);
  assert.ok(fogEvent.value.出处.some(item => item.记录类型 === '事件' && item.来源文本 === '作者原创'));
  assert.ok(fogEvent.value.出处.some(item => item.记录类型 === '台词' && item.角色组ID === '秦守' && item.台词));

  const keeper = await runJson([example, '角色组:秦守']);
  assert.ok(keeper.value.出处.length > 0);
  assert.ok(keeper.value.出处.every(item => item.记录类型 === '台词' && item.角色组ID === '秦守'));

  const empty = await runJson([example, '条目:技能:灯语·短讯']);
  assert.deepEqual(empty.value.出处, []);
  assert.deepEqual(empty.value.引用它, []);
  assert.deepEqual(empty.value.它引用, []);
});

test('溯源-5：夹具中的多事件出处与台词角色隔离', async t => {
  const root = await fixture(t);
  await edit(path.dirname(root), '作者资料/出处/雾港.yaml', records => {
    records.push(
      {事件ID: '学徒守灯', 角色组ID: '秦守', 台词: '先查灯芯，再压风门。', 来源: '作者补记'},
      {事件ID: '学徒守灯', 角色组ID: '灯塔学徒', 台词: '我先把火引回灯芯。', 来源: '作者补记'},
      {事件ID: '拜师', 角色组ID: '灯塔学徒', 台词: '我能看清对岸的灯。', 来源: '作者补记'},
      {事件ID: '拜师', 角色组ID: '秦守', 台词: '规矩先记在灯室里。', 来源: '作者补记'},
    );
  });
  const source = item => [item.记录序号, item.记录类型, item.事件ID, item.角色组ID, item.台词];

  const teaching = await runJson([root, '事件:拜师']);
  assert.equal(teaching.status, 0, teaching.stderr);
  assert.deepEqual(teaching.value.异常, []);
  assert.deepEqual(teaching.value.出处.map(source), [
    [1, '事件', '拜师', null, null],
    [14, '台词', '拜师', '秦守', '灯不等人，明早天亮前上来。'],
    [17, '台词', '拜师', '灯塔学徒', '我能看清对岸的灯。'],
    [18, '台词', '拜师', '秦守', '规矩先记在灯室里。'],
  ]);

  const second = await runJson([root, '事件:学徒守灯']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.value.异常, []);
  assert.deepEqual(second.value.出处.map(source), [
    [8, '事件', '学徒守灯', null, null],
    [15, '台词', '学徒守灯', '秦守', '先查灯芯，再压风门。'],
    [16, '台词', '学徒守灯', '灯塔学徒', '我先把火引回灯芯。'],
  ]);

  const keeper = await runJson([root, '角色组:秦守']);
  assert.equal(keeper.status, 0, keeper.stderr);
  assert.deepEqual(keeper.value.异常, []);
  assert.deepEqual(keeper.value.出处.map(source), [
    [14, '台词', '拜师', '秦守', '灯不等人，明早天亮前上来。'],
    [15, '台词', '学徒守灯', '秦守', '先查灯芯，再压风门。'],
    [18, '台词', '拜师', '秦守', '规矩先记在灯室里。'],
  ]);
  assert.ok(keeper.value.出处.every(item => item.角色组ID === '秦守'));

  const apprentice = await runJson([root, '角色组:灯塔学徒']);
  assert.equal(apprentice.status, 0, apprentice.stderr);
  assert.deepEqual(apprentice.value.异常, []);
  assert.deepEqual(apprentice.value.出处.map(source), [
    [16, '台词', '学徒守灯', '灯塔学徒', '我先把火引回灯芯。'],
    [17, '台词', '拜师', '灯塔学徒', '我能看清对岸的灯。'],
  ]);
  assert.ok(apprentice.value.出处.every(item => item.角色组ID === '灯塔学徒'));
  assert.ok(!apprentice.value.出处.some(item => item.事件ID === '学徒守灯' && item.角色组ID === '秦守'));
});

test('溯源-6：未知类型、不存在、歧义与非法参数退出非零', async t => {
  let stderr = '';
  assert.equal(await runCli(['trace'], {stderr: {write: value => { stderr += value; }}}), 1);
  assert.match(stderr, /用法/);

  for (const [key, rule] of [
    ['事件:不存在的事件', 'trace.对象不存在'],
    ['未知对象:某物', 'trace.未知类型'],
    ['事件', 'trace.参数'],
  ]) {
    const result = await runJson([example, key]);
    assert.equal(result.status, 1, key);
    assert.equal(result.value.异常[0].规则, rule, key);
    assert.match(result.value.异常[0].说明, /不存在|未知|缺少/, key);
  }

  let extra = '';
  assert.equal(await runCli(['trace', example, '事件:拜师', '多余'], {stderr: {write: value => { extra += value; }}}), 1);
  assert.match(extra, /用法/);
  let flag = '';
  assert.equal(await runCli(['trace', example, '事件:拜师', '--未知'], {stderr: {write: value => { flag += value; }}}), 1);
  assert.match(flag, /用法/);

  const root = await fixture(t);
  const skill = await read(root, '技能/灯语/灯语·短讯.txt');
  await write(root, '技能/雾中视/灯语·短讯.txt', skill);
  const ambiguous = await runJson([root, '条目:技能:灯语·短讯']);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.value.异常[0].规则, 'trace.歧义');
});

test('溯源-7：重复查询与重建索引顺序稳定', async () => {
  const first = await runJson([example, '事件:拜师']);
  const second = await runJson([example, '事件:拜师']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);

  const {catalog, decl, index} = await loadIndex();
  const next = buildReferenceIndex(catalog, decl);
  assert.deepEqual(index.objects, next.objects);
  assert.deepEqual(index.references, next.references);
  assert.deepEqual(index.query('事件:拜师'), next.query('事件:拜师'));
});

test('溯源-8：普通正文只提到名称不构成引用', async t => {
  const root = await fixture(t);
  const before = await runJson([root, '角色组:秦守']);
  await edit(root, '历史/事件/大雾之夜/事件.txt', event => {
    event.事件概要 = `${event.事件概要}秦守在正文中被人提起。`;
  });
  const after = await runJson([root, '角色组:秦守']);
  assert.deepEqual(after.value.引用它, before.value.引用它);
});

test('溯源-9：索引只读且保留 ID 内额外冒号', async () => {
  const {catalog, decl, index} = await loadIndex();
  const catalogBefore = structuredClone(catalog), declBefore = structuredClone(decl);
  const first = index.query('事件:拜师');
  const second = index.query('事件:拜师');
  assert.deepEqual(catalog, catalogBefore);
  assert.deepEqual(decl, declBefore);
  assert.deepEqual(first, second);
  assert.deepEqual(parseObjectKey('事件:章:一'), {ok: true, type: '事件', id: '章:一'});
  assert.deepEqual(parseObjectKey('档案:组:档案:二'), {ok: true, type: '档案', id: '组:档案:二'});

  const synthetic = buildReferenceIndex({
    events: [{id: '事件:甲', 文件: '历史/事件/事件:甲/事件.txt', 内容: {}, 角色位置: []}],
    chains: [{id: '串:甲', 文件: '历史/事件串/串:甲.yaml', 内容: {}}],
    groups: [{id: '组:甲', 文件: '角色/组:甲/角色组.yaml', 内容: {档案: [{档案ID: '档:甲'}]},
      版本清单: ['组:甲'], 档案: [{id: '档:甲', 目录: '角色/组:甲/档案/档:甲', 基本信息: null, 角色印象: null}]}],
    entries: {'库:甲': [{id: '条:甲', 文件: '库:甲/条:甲.txt', 内容: {}, 上级: null}]},
    openingOptions: null, openingPlans: [], sources: null,
  }, {marks: {'标:甲': ['值']}, variables: {角色: {}, 世界: {}}, libraries: {}, ability: {维度: {}}});
  for (const [key, type] of [
    ['事件:事件:甲', '事件'], ['事件串:串:甲', '事件串'], ['角色组:组:甲', '角色组'],
    ['档案:组:甲:档:甲', '档案'], ['条目:库:甲:条:甲', '条目'], ['剧情标记:标:甲', '剧情标记'],
  ]) assert.equal(synthetic.query(key).对象.类型, type, key);
});

test('溯源-10：未知核心参与者报引用.目标不存在并保留当前退出码', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/事件.txt', event => { event.核心参与者 = ['秦守', '不存在组']; });
  const result = await runJson([root, '事件:拜师']);
  assert.equal(result.status, 0, '当前实现只在 trace.* 失败时退出非零');
  assertIssues(result.value.异常, [finding('引用.目标不存在', '历史/事件/拜师/事件.txt',
    {说明: ['核心参与者[2]', '角色组:不存在组']})], '溯源-10');
});

test('溯源-11：缺引用目标ID报引用.结构而非目标不存在', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/事件.txt', event => { event.门槛 = {角色启用: {}}; });
  const result = await runJson([root, '事件:拜师']);
  assert.equal(result.status, 0);
  assertIssues(result.value.异常, [finding('引用.结构', '历史/事件/拜师/事件.txt',
    {说明: ['门槛', '引用目标 ID 缺失或不是文本']})], '溯源-11');
});

test('溯源-12：多键、空none与未知条件类型分别报引用.条件结构', async t => {
  const cases = [
    ['多键', {角色启用: {角色组ID: '秦守'}, 角色已出场: {角色组ID: '秦守'}},
      '条件须为只有一个类型键的映射', true],
    ['空none', {none: []}, 'none 须为非空列表', true],
    ['未知类型', {不存在: {}}, '未知条件类型“不存在”', false],
  ];
  for (const [label, condition, fragment, unreachable] of cases) {
    const root = await fixture(t);
    await edit(root, '历史/事件/接手商会账目/事件.txt', event => { event.门槛 = condition; });
    const result = await runJson([root, '事件:接手商会账目']);
    assert.equal(result.status, 0, label);
    const expected = [finding('引用.条件结构', '历史/事件/接手商会账目/事件.txt', {说明: [fragment]})];
    if (unreachable) expected.push(hint('事件树.不可达', '历史/事件/接手商会账目/事件.txt',
      {说明: ['按乐观假设', '门槛不可能成立']}));
    assertIssues(result.value.异常, expected, `溯源-12 ${label}`);
  }
});

test('溯源-13：事件、角色组与台词记录缺陷报出处.结构', async t => {
  const cases = [
    ['事件记录缺来源', {事件ID: '拜师'}, '事件:拜师', ['第 15 条出处缺少来源文本'], 15],
    ['台词记录缺台词', {事件ID: '拜师', 角色组ID: '秦守', 来源: '作者原创'}, '事件:拜师',
      ['第 15 条台词记录缺少角色组ID或台词'], 15],
    ['台词记录缺角色组ID', {事件ID: '拜师', 台词: '灯不等人，明早天亮前上来。', 来源: '作者原创'}, '事件:拜师',
      ['第 15 条台词记录缺少角色组ID或台词'], 15],
    ['角色组查询缺来源', {事件ID: '拜师', 角色组ID: '秦守', 台词: '灯不等人，明早天亮前上来。'}, '角色组:秦守',
      ['第 15 条出处缺少来源文本'], 15],
    ['角色组查询缺台词', {事件ID: '拜师', 角色组ID: '秦守', 来源: '作者原创'}, '角色组:秦守',
      ['第 15 条台词记录缺少台词'], 15],
  ];
  for (const [label, record, key, fragments, sequence] of cases) {
    const root = await fixture(t);
    await edit(path.dirname(root), '作者资料/出处/雾港.yaml', records => { records.push(record); });
    const result = await runJson([root, key]);
    assert.equal(result.status, 0, label);
    const expected = [finding('出处.结构', '作者资料/出处/雾港.yaml', {说明: fragments})];
    if (label === '台词记录缺角色组ID') expected.push(finding('出处.角色位置不符', '作者资料/出处/雾港.yaml',
      {说明: ['第 15 条台词记录未对应本事件的实际角色位置']}));
    assertIssues(result.value.异常, expected, `溯源-13 ${label}`);
    const kept = result.value.出处.find(item => item.记录序号 === sequence);
    assert.ok(kept, `${label}：记录 ${sequence} 应保留在出处\n${JSON.stringify(result.value.出处)}`);
  }
});

test('溯源-14：出处角色位置不符在事件查询保留、角色组查询跳过', async t => {
  const eventRoot = await fixture(t);
  await edit(path.dirname(eventRoot), '作者资料/出处/雾港.yaml', records => {
    records.push({事件ID: '拜师', 角色组ID: '白棠', 台词: '潮水要退了。', 来源: '作者原创'});
  });
  const event = await runJson([eventRoot, '事件:拜师']);
  assert.equal(event.status, 0);
  assertIssues(event.value.异常, [finding('出处.角色位置不符', '作者资料/出处/雾港.yaml',
    {说明: ['第 15 条', '未对应本事件的实际角色位置']})], '溯源-14 事件');
  assert.ok(event.value.出处.some(item => item.记录序号 === 15 && item.角色组ID === '白棠'),
    '事件查询保留记录，只报位置不符');

  const groupRoot = await fixture(t);
  await edit(path.dirname(groupRoot), '作者资料/出处/雾港.yaml', records => {
    records.push({事件ID: '潮汐号首航', 角色组ID: '秦守', 台词: '灯不等人，明早天亮前上来。', 来源: '作者原创'});
  });
  const group = await runJson([groupRoot, '角色组:秦守']);
  assert.equal(group.status, 0);
  assertIssues(group.value.异常, [finding('出处.角色位置不符', '作者资料/出处/雾港.yaml',
    {说明: ['第 15 条', '潮汐号首航', '实际角色位置']})], '溯源-14 角色组');
  assert.equal(group.value.出处.some(item => item.记录序号 === 15), false, '角色组查询跳过记录');
});
