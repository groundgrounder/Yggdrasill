import {test, assert, path, project} from './helpers.mjs';
import {loadProtocol, S} from './protocol-helpers.mjs';
import {
  assertProgramMatches, collectProgram, importSpecifiers, programInputs, stripComments,
} from '../adapter/manifest.mjs';
import {fromText, parseBlock, parseCommands, stripCommands} from '../adapter/commands-parser.mjs';
import {DEFAULTS, HOST_FUNCTIONS, SETTINGS_KEY, hostMissing, keeperSettings, permissionFailure} from '../adapter/settings.mjs';
import {
  buildKeepRecord, canIncrementalRepair, createBookkeeper, formatRepairHint,
  isBetterOutcome, preservesWritten, repairRecord, runKeeperLoop,
} from '../adapter/bookkeeper.mjs';
import {applyCommands} from '../core/commands.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {
  RECORD_FORMAT, createHistoryAudit, manifestIssue, ownershipOf, storedManifest, validateRecord,
} from '../adapter/records.mjs';
import {diffWorldbookState} from '../adapter/upgrade.mjs';

const ids = {脚本ID: '11111111-1111-4111-8111-111111111111', 正则ID: '22222222-2222-4222-8222-222222222222'};
const script = (extra = {}) => ({id: ids.脚本ID, enabled: true, ...extra});
const regex = (extra = {}) => ({id: ids.正则ID, disabled: false, placement: [2], ...extra});
const characterCard = ({scripts = [script()], regexes = [regex()], avatar = '雾港.png', extensions = true} = {}) =>
  ({avatar, data: extensions ? {extensions: {tavern_helper: {scripts}, regex_scripts: regexes}} : undefined});

// 宿主全局是模块级读取的；每个用例装好后统一还原，避免污染其它测试。
function fakeHost(t, {context = {characters: [characterCard()], characterId: 0}} = {}) {
  const names = [...HOST_FUNCTIONS, 'generateRaw', 'tavern_events', '$', 'toastr', 'SillyTavern', 'getProxyPresetNames'];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  for (const name of HOST_FUNCTIONS) globalThis[name] = () => {};
  globalThis.generateRaw = async () => '';
  globalThis.tavern_events = {};
  globalThis.$ = () => ({});
  globalThis.toastr = {};
  globalThis.SillyTavern = {getContext: () => context};
  return context;
}

test('适配-09-A2：commands-parser 逐条容错解析，单条写坏不连累同块，全失败置 null', async () => {
  const {protocol} = await loadProtocol();
  const state = S(protocol, '071-04-01');
  const block = '<命令>\n- 写场景: {当前时间: 潮历071年04月10日}\n- 写场景: {当前时间: [潮历071年04月11日\n</命令>';
  assert.equal(stripCommands(`前文${block}后文`), '前文后文');
  assert.deepEqual(parseBlock('写场景: {当前时间: 潮历071年04月10日}'), [{错误: '命令块须为 YAML 列表'}]);
  const items = parseCommands(`${block}\n<命令>\n- 写场景: {当前时间: 潮历071年04月12日}\n</命令>`);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {命令: {写场景: {当前时间: '潮历071年04月10日'}}});
  assert.match(items[1].错误, /不是合法的 YAML/u);
  assert.deepEqual(items[2], {命令: {写场景: {当前时间: '潮历071年04月12日'}}});

  const partial = fromText(protocol, state, block);
  assert.deepEqual(partial.命令, [{写场景: {当前时间: '潮历071年04月10日'}}]);
  assert.equal(partial.命令数, 2);
  assert.equal(partial.失败.length, 1);
  assert.equal(partial.失败[0].阶段, '解析');
  assert.equal(partial.失败[0].序号, 2);
  assert.deepEqual(partial.记账, {方式: '正文', 应答格式: '正文命令', 状态: '部分失败', 尝试次数: 1});

  const rejected = fromText(protocol, state,
    '<命令>\n- 写场景: {当前时间: 潮历071年04月10日}\n- 写场景: {当前时间: 潮历071年03月01日}\n</命令>');
  assert.equal(rejected.命令.length, 1);
  assert.equal(rejected.失败[0].阶段, '协议执行');
  assert.equal(rejected.失败[0].序号, 2);
  assert.match(rejected.失败[0].错误码, /^协议\./u);

  const failed = fromText(protocol, state, '<命令>\n- 写场景: {当前时间: [x\n</命令>');
  assert.equal(failed.命令, null);
  assert.equal(failed.记账.状态, '解析失败');
  assert.equal(failed.失败[0].阶段, '解析');
});

test('适配-09-A2：settings 以显式 {permissionIds, bookkeeping} 自检，脚本与局部正则分支独立', t => {
  const context = fakeHost(t);
  assert.deepEqual(hostMissing({bookkeeping: false}), []);
  assert.deepEqual(hostMissing({bookkeeping: true}), []);
  delete globalThis.generateRaw;
  assert.deepEqual(hostMissing({bookkeeping: false}), []);
  assert.deepEqual(hostMissing({bookkeeping: true}), ['generateRaw']);
  globalThis.generateRaw = async () => '';

  const base = {permissionIds: ids, bookkeeping: true};
  assert.equal(permissionFailure(base), null, '脚本启用且开启记账时不检查局部正则');

  delete globalThis.toastr;
  assert.deepEqual(hostMissing({bookkeeping: true}), ['toastr']);
  const deniedHost = permissionFailure({...base, bookkeeping: false});
  assert.equal(deniedHost.code, '权限.脚本');
  assert.match(deniedHost.说明, /宿主 API 不完整/u);
  globalThis.toastr = {};

  context.characters = undefined;
  assert.equal(permissionFailure(base), null, '群聊或未暴露角色数组时不误报');
  context.characters = [{}];
  assert.equal(permissionFailure(base).code, '权限.脚本');
  context.characters = [characterCard({extensions: false})];
  assert.match(permissionFailure(base).说明, /没有扩展数据/u);
  context.characters = [{avatar: '雾港.png', data: {extensions: {}}}];
  assert.match(permissionFailure(base).说明, /没有酒馆助手脚本/u);
  context.characters = [characterCard({scripts: []})];
  assert.match(permissionFailure(base).说明, /缺少世界树脚本/u);
  context.characters = [characterCard({scripts: [{id: 'other', enabled: true}]})];
  assert.match(permissionFailure(base).说明, /缺少世界树脚本/u);
  context.characters = [characterCard({scripts: [script({enabled: false})]})];
  assert.match(permissionFailure(base).说明, /已停用/u);

  const closed = {permissionIds: ids, bookkeeping: false};
  context.characters = [characterCard({scripts: [script()], regexes: null})];
  assert.equal(permissionFailure(closed).code, '权限.正则');
  assert.match(permissionFailure(closed).说明, /没有局部正则/u);
  context.characters = [characterCard({regexes: [regex({disabled: true})]})];
  assert.match(permissionFailure(closed).说明, /局部正则已停用/u);
  context.characters = [characterCard({regexes: [regex({placement: [0]})]})];
  assert.match(permissionFailure(closed).说明, /placement 不含 2/u);
  context.characters = [characterCard({regexes: [regex()]})];
  context.extensionSettings = {character_allowed_regex: []};
  assert.match(permissionFailure(closed).说明, /character_allowed_regex/u);
  context.extensionSettings = {character_allowed_regex: ['雾港.png']};
  assert.equal(permissionFailure(closed), null);

  // 设置默认值与旧布尔键：显式新键最后覆盖，缺省值不受影响。
  globalThis.getVariables = () => ({[SETTINGS_KEY]: {结构化输出: false}});
  assert.equal(keeperSettings().应答格式, '提示词');
  assert.equal(keeperSettings().方式, DEFAULTS.方式);
  globalThis.getVariables = () => ({[SETTINGS_KEY]: {结构化输出: true, 应答格式: '提示词'}});
  assert.equal(keeperSettings().应答格式, '提示词');
  globalThis.getVariables = () => ({});
  assert.deepEqual(keeperSettings(), DEFAULTS);
});

test('适配-09-A3：manifest 剥离注释后收集 import，程序集合与 esbuild 输入严格对照', async () => {
  const source = [
    '// import "./单行注释.mjs"',
    '/* import "./块注释.mjs" */',
    'const url = "https://example.com//path";',
    "const other = '// not a comment';",
    'import {a} from "./真实.mjs";',
    'export {b} from "./再导出.mjs";',
    'const lazy = import("./懒加载.mjs");',
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./真实.mjs', './再导出.mjs', './懒加载.mjs']);
  assert.match(stripComments(source), /https:\/\/example\.com\/\/path/u);
  assert.doesNotMatch(stripComments(source), /单行注释|块注释/u);

  const program = await collectProgram(project);
  const paths = program.map(item => item.路径);
  for (const name of ['runtime', 'settings', 'commands-parser', 'bookkeeper', 'records', 'opening', 'view', 'ui', 'memfs', 'upgrade'])
    assert.ok(paths.includes(`adapter/${name}.mjs`), name);
  assert.ok(paths.includes('core/utils.mjs'));
  assert.ok(paths.includes('templates/变量更新规则.txt'));
  for (const name of ['build', 'smoke', 'manifest']) assert.ok(!paths.includes(`adapter/${name}.mjs`), name);
  assert.ok(!paths.includes('adapter/bundle.generated.json'));

  const synthetic = [
    {路径: 'adapter/runtime.mjs'}, {路径: 'core/utils.mjs'},
    {路径: 'adapter/node-url-shim.mjs'}, {路径: 'templates/变量更新规则.txt'},
  ];
  const inputs = {
    'adapter/runtime.mjs': {bytes: 1}, 'core/utils.mjs': {bytes: 1},
    'adapter/node-url-shim.mjs': {bytes: 1}, 'adapter/bundle.generated.json': {bytes: 1},
    'templates/变量更新规则.txt': {bytes: 1}, 'node_modules/esbuild/lib/main.js': {bytes: 1},
    [path.join(project, 'adapter/settings.mjs')]: {bytes: 1},
  };
  assert.deepEqual(programInputs(inputs, {repo: project}), ['adapter/runtime.mjs', 'adapter/settings.mjs', 'core/utils.mjs']);
  // cwd 规范化：键从执行目录解析，再折回仓库根。
  assert.deepEqual(programInputs({'../adapter/runtime.mjs': {}}, {repo: project, cwd: path.join(project, 'core')}),
    ['adapter/runtime.mjs']);
  const extra = [...synthetic, {路径: 'adapter/settings.mjs'}];
  assert.doesNotThrow(() => assertProgramMatches(extra, inputs, {repo: project}));
  assert.throws(() => assertProgramMatches(synthetic, inputs, {repo: project}),
    error => error.code === '清单.程序覆盖' && /清单漏掉实际打包文件：adapter\/settings\.mjs/u.test(error.message));
  assert.throws(() => assertProgramMatches([...extra, {路径: 'adapter/未打包.mjs'}], inputs, {repo: project}),
    error => error.code === '清单.程序覆盖' && /清单多出未打包文件：adapter\/未打包\.mjs/u.test(error.message));
});

test('适配-09-A3：bookkeeper 用 calendar.formatDay 写日期，变化值只在数值声明处转数字', async () => {
  const {protocol, catalog, decl} = await loadProtocol();
  const keeper = createBookkeeper({protocol, catalog, decl});
  const calendar = createCalendar(decl.calendar);
  const state = S(protocol, '071-04-01');
  const base = {时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: [], 发生的事件: [], 新情况: []};
  const day = calendar.time('潮历071年04月20日')[0];
  const dated = keeper.toCommands(state, {...base, 时间: {方式: '写日期', 日期: '潮历071年04月20日', 事件ID: ''}});
  assert.deepEqual(dated.commands, [{写场景: {当前时间: calendar.formatDay(day)}}]);

  const changes = (...items) => ({...base, 新情况: [{事件ID: '测试', 摘要: '测试', 变化: items}]});
  const numeric = keeper.toCommands(state, changes(
    {路径: '角色.秦守.好感度.灯塔学徒', 操作: '增加', 值: '5'}));
  assert.deepEqual(numeric.commands[0].动态事件.变化[0].值, 5);

  for (const item of [
    {路径: '角色.灯塔学徒.身份', 操作: '新增', 值: '001'},
    {路径: '世界.剧情标记.灯塔状态', 操作: '设定', 值: '001'},
    {路径: '角色.灯塔学徒.身体状态.健康', 操作: '设定', 值: '001'},
  ]) {
    const converted = keeper.toCommands(state, changes({...item}));
    assert.equal(converted.commands[0].动态事件.变化[0].值, '001', item.路径);
  }
  for (const item of [
    {路径: '世界.剧情标记.灯塔状态', 操作: '设定', 值: '001'},
    {路径: '角色.灯塔学徒.身体状态.健康', 操作: '设定', 值: '001'},
  ]) {
    const run = keeper.run(state, changes({...item}));
    assert.ok(run.失败.some(entry => entry.错误码?.startsWith('协议.') && /变化\.取值/u.test(entry.说明)), item.路径);
  }
  const mark = changes({路径: '世界.剧情标记.灯塔状态', 操作: '设定', 值: '运转'});
  assert.equal(keeper.toCommands(state, mark).commands[0].动态事件.变化[0].值, '运转');
  assert.deepEqual(keeper.run(state, mark).失败, []);

  const valid = keeper.run(state, changes({路径: '角色.灯塔学徒.身份', 操作: '新增', 值: '秦守的徒弟'}));
  assert.deepEqual(valid.失败, []);

  const broken = changes({路径: '角色.灯塔学徒.装备.灯具·风暴灯', 操作: '设定', 值: '完好/随身/多余'});
  const brokenCommand = keeper.toCommands(state, broken).commands[0].动态事件.变化[0];
  assert.equal(brokenCommand.值, '完好/随身/多余', '多段装备值不得丢段');
  const brokenRun = keeper.run(state, broken);
  assert.ok(brokenRun.失败.some(entry => entry.错误码 === '协议.变化' && /变化\.取值/u.test(entry.说明)));
  assert.ok(!brokenRun.commands.some(command => command.动态事件?.变化?.some(item => item.路径.includes('装备'))));

  const equipment = keeper.run(state, changes({路径: '角色.灯塔学徒.装备.灯具·风暴灯', 操作: '设定', 值: '完好/随身'}));
  assert.deepEqual(equipment.失败, []);
  assert.deepEqual(equipment.state.角色.灯塔学徒.装备['灯具·风暴灯'], {状态: '完好', 位置: '随身'});
});

test('适配-10-A1：新情况治本校验、防倒退比较与自动修补内循环（覆盖局部协议失败）', async () => {
  const {protocol, catalog, decl} = await loadProtocol();
  const keeper = createBookkeeper({protocol, catalog, decl});
  const state = S(protocol, '071-04-01');
  const full = (patch = {}) => ({
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: [],
    发生的事件: [],
    新情况: [],
    ...patch,
  });

  // RULES 显式约束新情况非空事件ID/摘要且不与预设事件重名
  const req = keeper.request(state, {input: '', narration: '学徒记录新发现。'});
  assert.match(req.prompts[0].content, /新情况每项的“事件ID”与“摘要”必填且非空/);
  assert.match(req.prompts[0].content, /不得与任何预设事件ID重名/);

  // toCommands 拦截空事件ID、空摘要、与预设事件重名，且不生成注定失败的动态事件命令，保留合法兄弟命令
  const invalidNew = keeper.toCommands(state, full({
    地点: {地标: '码头区', 场景: '栈桥'},
    新情况: [
      {事件ID: '   ', 摘要: '缺少ID', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: 'x'}]},
      {事件ID: '有效新事件', 摘要: '  ', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: 'y'}]},
      {事件ID: '拜师', 摘要: '与预设事件重名', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: 'z'}]},
      {事件ID: '合法动态事件', 摘要: '记下合法发现', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '码头线索'}]},
    ],
  }));
  assert.equal(invalidNew.errors.length, 3);
  assert.match(invalidNew.errors[0], /新情况缺少非空的事件ID/);
  assert.match(invalidNew.errors[1], /新情况缺少非空的摘要（事件ID：有效新事件）/);
  assert.match(invalidNew.errors[2], /新情况的事件ID与预设事件重复：拜师/);
  assert.equal(invalidNew.commands.length, 2, '无效新情况不生成动态事件命令，合法地点与动态事件照常生成');
  assert.deepEqual(invalidNew.commands[1].动态事件.事件ID, '合法动态事件');

  // isBetterOutcome 确定性比较口径
  const partial1 = {失败: [{错误码: '协议.变化'}], 已写入: ['合法事'], commands: [{写场景: {}}, {动态事件: {}}]};
  const clean = {失败: [], 已写入: ['合法事', '修好事'], commands: [{写场景: {}}, {动态事件: {}}, {动态事件: {}}]};
  const worseMoreFail = {失败: [{错误码: 'a'}, {错误码: 'b'}], 已写入: ['合法事'], commands: [{写场景: {}}, {动态事件: {}}]};
  const worseLostWritten = {失败: [{错误码: '协议.变化'}], 已写入: [], commands: [{写场景: {}}, {动态事件: {}}]};
  const worseFewerCmd = {失败: [{错误码: '协议.变化'}], 已写入: ['合法事'], commands: [{写场景: {}}]};
  const betterMoreWritten = {失败: [{错误码: '协议.变化'}], 已写入: ['合法事', '补充事'], commands: [{写场景: {}}, {动态事件: {}}]};
  assert.equal(isBetterOutcome(clean, partial1), true);
  assert.equal(isBetterOutcome(partial1, clean), false);
  assert.equal(isBetterOutcome(worseMoreFail, partial1), false);
  assert.equal(isBetterOutcome(worseLostWritten, partial1), false);
  assert.equal(isBetterOutcome(worseFewerCmd, partial1), false);
  assert.equal(isBetterOutcome(betterMoreWritten, partial1), true);

  // formatRepairHint 脱敏并包含原 JSON、失败命令体与指示
  const hint = formatRepairHint({
    raw: {秘钥: 'sk-secret-123456', 新情况: [{事件ID: '坏事', 摘要: '坏', 变化: [{路径: '角色.秦守.不存在', 操作: '设定', 值: 'Bearer secret-token'}]}]},
    failures: [{阶段: '协议执行', 序号: 1, 命令: '动态事件', 错误码: '协议.变化', 说明: '字段未声明，token=abc'}],
    commands: [{动态事件: {事件ID: '坏事', 摘要: '坏', 变化: [{路径: '角色.秦守.不存在', 操作: '设定', 值: 'x'}]}}],
  });
  assert.doesNotMatch(hint, /sk-secret-123456|secret-token|token=abc/);
  assert.match(hint, /第 1 条命令失败（协议\.变化）/);
  assert.match(hint, /原始命令：/);
  assert.match(hint, /保留上一次已经合理且成功的改动，只修正上述失败项，输出修正后的完整记账 JSON/);

  // 自动修补内循环：第 1 次触发协议.变化（局部协议执行失败），第 2 次携带失败命令体定向修正成功
  const basePrompts = [];
  const repliesAutoFix = [
    JSON.stringify(full({
      地点: {地标: '码头区', 场景: '栈桥'},
      新情况: [
        {事件ID: '好发现', 摘要: '好', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起风'}]},
        {事件ID: '坏路径', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
      ],
    })),
    JSON.stringify(full({
      地点: {地标: '码头区', 场景: '栈桥'},
      新情况: [
        {事件ID: '好发现', 摘要: '好', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起风'}]},
        {事件ID: '坏路径', 摘要: '修正后记入知识', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '秦守在栈桥'}]},
      ],
    })),
  ];
  const fixedLoop = await runKeeperLoop({
    keeper, base: state, input: '', narration: '学徒到栈桥。',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2,
    call: async reqArg => { basePrompts.push(reqArg.prompts[1].content); return repliesAutoFix.shift(); },
  });
  assert.equal(fixedLoop.calls, 2);
  assert.equal(fixedLoop.best.outcome.失败.length, 0);
  assert.match(basePrompts[1], /原始命令：.*"事件ID":"坏路径"/);
  assert.match(basePrompts[1], /协议\.变化/);
  const fixedRecord = buildKeepRecord({base: state, loop: fixedLoop, config: {方式: '同一模型', 应答格式: '提示词'}, debugging: false});
  assert.equal(fixedRecord.记账.状态, '成功');
  assert.equal(fixedRecord.记账.尝试次数, 2);
  assert.equal(fixedRecord.记账.重试, 1);
  assert.ok(!('原始结果' in fixedRecord.记账));

  // 防倒退：第 1 次部分成功（1 成功写入 + 1 失败），第 2 次遇到 502 / 坏 JSON / 更差结果时，保留第 1 次最佳结果
  for (const [label, secondCall] of [
    ['502异常', async () => { throw new Error('HTTP 502 Bad Gateway'); }],
    ['坏JSON', async () => '不是JSON'],
    ['结果倒退丢已写入', async () => JSON.stringify(full({
      新情况: [{事件ID: '仍坏', 摘要: '丢了好发现', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]}],
    }))],
  ]) {
    let idx = 0;
    const partialReply = JSON.stringify(full({
      地点: {地标: '码头区', 场景: '栈桥'},
      新情况: [
        {事件ID: '好发现', 摘要: '好', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起风'}]},
        {事件ID: '坏路径', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
      ],
    }));
    const loop = await runKeeperLoop({
      keeper, base: state, input: '', narration: '防倒退测试。',
      config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2,
      call: async () => (idx++ === 0 ? partialReply : secondCall()),
    });
    const rec = buildKeepRecord({base: state, loop, config: {方式: '同一模型', 应答格式: '提示词'}, debugging: false});
    assert.equal(rec.记账.状态, '部分失败', label);
    assert.equal(rec.记账.尝试次数, 2, label);
    assert.equal(rec.记账.重试, 1, label);
    assert.ok(Array.isArray(rec.命令) && rec.命令.length === 2, `${label} 不得退化为 null 或丢命令`);
    assert.deepEqual(rec.已写入, ['好发现'], `${label} 应保留原有已写入`);
  }
});

test('适配-10-A2/A3：手动修补（留空增量优先、空增量/顺序冲突全量回退防丢失、带说明增改撤回、失败零覆写）', async () => {
  const {protocol, catalog, decl} = await loadProtocol();
  const keeper = createBookkeeper({protocol, catalog, decl});
  const base = S(protocol, '071-04-01');
  const full = (patch = {}) => ({
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: [],
    发生的事件: [],
    新情况: [],
    ...patch,
  });

  // 1. canIncrementalRepair 判定边界
  assert.equal(canIncrementalRepair({命令: [{写场景: {当前地点: {地标: '码头区', 场景: '栈桥'}}}], 失败: [{阶段: '协议执行', 序号: 2, 命令: '动态事件', 错误码: '协议.变化', 说明: '坏'}]}), true);
  assert.equal(canIncrementalRepair({命令: [{写场景: {}}], 失败: [{阶段: '协议执行', 序号: 2, 命令: '确认事件', 错误码: '协议.事件状态', 说明: '坏'}]}), false);
  assert.equal(canIncrementalRepair({命令: [{写场景: {}}], 失败: [{阶段: '协议执行', 序号: 2, 命令: '写场景', 错误码: '协议.场景', 说明: '当前时间不能倒退'}]}), false);
  assert.equal(canIncrementalRepair({命令: [{写场景: {}}], 失败: [{阶段: '转换', 命令: '记账', 错误码: '记账.结果', 说明: '时间早于当前'}]}), false);
  assert.equal(canIncrementalRepair({命令: null, 失败: [{阶段: '记账', 错误码: '记账.JSON', 说明: '坏'}]}), false);

  // 2. 无失败项且留空：不发 API 请求
  let callCount = 0;
  const noop = await repairRecord({
    keeper, protocol, base,
    record: {本局: base, 命令: [], 失败: [], 已写入: [], 记账: {方式: '同一模型', 应答格式: '提示词', 状态: '成功', 尝试次数: 1}},
    narration: '正文', instruction: '   ',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2, debugging: false,
    call: async () => { callCount += 1; return ''; },
  });
  assert.equal(noop.ok, false);
  assert.equal(noop.noRequest, true);
  assert.equal(callCount, 0);

  // 3. 模式 A 留空增量补记（不依赖 原始结果）：原已有成功 写场景+动态事件A，补记 动态事件B 后合并重放一致
  const firstRun = keeper.run(base, full({
    地点: {地标: '码头区', 场景: '栈桥'},
    新情况: [
      {事件ID: '事件A', 摘要: 'A生效', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '线索A'}]},
      {事件ID: '坏B', 摘要: 'B失败', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
    ],
  }));
  const partialRecord = {本局: firstRun.state, 命令: firstRun.commands, 失败: firstRun.失败, 已写入: firstRun.已写入,
    记账: {方式: '同一模型', 应答格式: '提示词', 状态: '部分失败', 尝试次数: 1}};
  assert.equal('原始结果' in partialRecord.记账, false);
  const incPrompts = [];
  const incResult = await repairRecord({
    keeper, protocol, base, record: partialRecord, narration: '正文A与B', instruction: '',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2, debugging: false,
    call: async reqArg => {
      incPrompts.push(reqArg.prompts[1].content);
      return JSON.stringify(full({
        新情况: [{事件ID: '事件B', 摘要: 'B补记成功', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '线索B'}]}],
      }));
    },
  });
  assert.equal(incResult.ok, true);
  assert.equal(incResult.mode, 'incremental');
  assert.match(incPrompts[0], /上述已成功命令已生效，勿重复填写/);
  assert.deepEqual(incResult.record.已写入, ['事件A', '事件B']);
  assert.equal(incResult.record.记账.修补, true);
  assert.equal(incResult.record.本局.世界.当前地点.地标, '码头区');
  const replayInc = applyCommands(protocol, base, incResult.record.命令);
  assert.deepEqual(replayInc.失败, []);
  assert.deepEqual(replayInc.state, incResult.record.本局);

  // 4. 增量返回空命令时自动回退全量重出；若全量丢了原 已写入，则防丢失校验拒绝
  assert.deepEqual(preservesWritten(['事件A', '事件B'], ['事件A']), ['事件B']);
  const fallbackReplies = [
    JSON.stringify(full()), // 增量空命令 -> 触发全量回退
    JSON.stringify(full({地点: {地标: '码头区', 场景: '栈桥'}})), // 全量丢失了 事件A
  ];
  const lostWritten = await repairRecord({
    keeper, protocol, base, record: partialRecord, narration: '正文', instruction: '',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 1, debugging: false,
    call: async () => fallbackReplies.shift(),
  });
  assert.equal(lostWritten.ok, false);
  assert.equal(lostWritten.code, '修补.丢失已写入');

  // 5. 模式 B 带说明修：支持「补记新变化」与「撤回已有场景改动（允许空命令 []）」
  const withPlace = keeper.run(base, full({地点: {地标: '码头区', 场景: '栈桥'}}));
  const placeRecord = {本局: withPlace.state, 命令: withPlace.commands, 失败: [], 已写入: [],
    记账: {方式: '同一模型', 应答格式: '提示词', 状态: '成功', 尝试次数: 1}};
  const withdrawResult = await repairRecord({
    keeper, protocol, base, record: placeRecord, narration: '仍在值守室。', instruction: '没换地点，撤回场景改动',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 2, debugging: false,
    call: async reqArg => {
      assert.match(reqArg.prompts[1].content, /没换地点，撤回场景改动/);
      return JSON.stringify(full());
    },
  });
  assert.equal(withdrawResult.ok, true);
  assert.equal(withdrawResult.mode, 'manual');
  assert.deepEqual(withdrawResult.record.命令, []);
  assert.equal(withdrawResult.record.本局.世界.当前地点?.地标, base.世界.当前地点?.地标);
  assert.equal(withdrawResult.record.记账.修补, true);

  // 6. 修补后仍残留局部失败时硬拒绝（不返成功记录）
  const stillBad = await repairRecord({
    keeper, protocol, base, record: placeRecord, narration: '正文', instruction: '补记一条错误变化',
    config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 1, debugging: false,
    call: async () => JSON.stringify(full({
      新情况: [{事件ID: '还坏', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]}],
    })),
  });
  assert.equal(stillBad.ok, false);
  assert.equal(stillBad.code, '修补.仍有失败');
});

test('适配-11-A1：世界书更新 A/B/C 分级、封闭白名单、前置门禁优先级与升级记录生成', async () => {
  const {protocol: oldProtocol, catalog: baseCatalog, decl: baseDecl} = await loadProtocol();
  const clone = value => structuredClone(value);
  const oldManifest = {
    卡ID: 'fog.test.card', 卡版本: '1.0.0', 程序版本: '0.1.0', 记录格式: RECORD_FORMAT,
    程序指纹: '1'.repeat(64), 世界书哈希: 'a'.repeat(64), 兼容程序: ['2'.repeat(64)],
  };
  const newManifest = {...oldManifest, 世界书哈希: 'b'.repeat(64)};

  const makeMsg = (id, role, text, record = undefined) => ({
    message_id: id, role, message: text, swipe_id: 0,
    ...(record ? {data: {世界树: record}} : {}),
  });
  const makeRecord = ({msg, state, commands, written, manifest}) => ({
    记录格式: RECORD_FORMAT,
    运行清单: storedManifest(manifest),
    归属: ownershipOf(msg),
    本局: state,
    命令: commands,
    失败: [],
    已写入: written,
    记账: {方式: '正文', 应答格式: '正文命令', 状态: '成功', 尝试次数: 1},
  });

  // 1. manifestIssue 严格默认值、allowWorldbookDiff 开关与前置硬门禁优先级
  const oldStored = storedManifest(oldManifest);
  assert.equal(manifestIssue(oldStored, newManifest).ok, false);
  assert.equal(manifestIssue(oldStored, newManifest).code, '运行清单.世界书哈希');
  assert.equal(manifestIssue(oldStored, newManifest, {allowWorldbookDiff: true}).ok, true);
  assert.equal(manifestIssue({...oldStored, 世界书哈希: 'not-hex'}, newManifest, {allowWorldbookDiff: true}).code, '运行清单.世界书哈希');
  assert.equal(manifestIssue({...oldStored, 世界书哈希: 'A'.repeat(64)}, newManifest, {allowWorldbookDiff: true}).code, '运行清单.世界书哈希');
  assert.equal(manifestIssue({...oldStored, 卡ID: 'other.card'}, newManifest, {allowWorldbookDiff: true}).code, '运行清单.卡ID');
  assert.equal(manifestIssue({...oldStored, 程序指纹: '9'.repeat(64)}, newManifest, {allowWorldbookDiff: true}).code, '运行清单.程序指纹');
  assert.equal(manifestIssue({...oldStored, 记录格式: 2}, newManifest, {allowWorldbookDiff: true}).code, '运行清单.记录格式');

  // 2. diffWorldbookState 封闭白名单纯测试（A / B / C 及前 10 条截断）
  const sealed0 = oldProtocol.seal({开局时间: '潮历071年04月01日', 玩家: {模式: '自建', 档案: {姓名: '海生'}}});
  assert.equal(diffWorldbookState(sealed0, clone(sealed0), 0).级别, 'A');

  const bOnlyGroup = clone(sealed0);
  bOnlyGroup.开局.角色组.新增角色甲 = {启用: false, 版本ID: '新增角色甲'};
  const bGroupDiff = diffWorldbookState(sealed0, bOnlyGroup, 0);
  assert.equal(bGroupDiff.级别, 'B');
  assert.deepEqual(bGroupDiff.新增角色组.map(item => item.id), ['新增角色甲']);
  assert.deepEqual(bGroupDiff.新增剧情标记, []);

  const bOnlyMark = clone(sealed0);
  bOnlyMark.世界.剧情标记.潮汐暗流 = '平静';
  const bMarkDiff = diffWorldbookState(sealed0, bOnlyMark, 0);
  assert.equal(bMarkDiff.级别, 'B');
  assert.deepEqual(bMarkDiff.新增角色组, []);
  assert.deepEqual(bMarkDiff.新增剧情标记, [{id: '潮汐暗流', 初值: '平静'}]);

  const delGroup = clone(sealed0);
  delete delGroup.开局.角色组.白棠;
  const delGroupDiff = diffWorldbookState(sealed0, delGroup, 0);
  assert.equal(delGroupDiff.级别, 'C');
  assert.match(delGroupDiff.差异[0], /^#0 缺失原角色组：开局\.角色组\.白棠/);

  const delMark = clone(sealed0);
  delete delMark.世界.剧情标记.灯塔状态;
  const delMarkDiff = diffWorldbookState(sealed0, delMark, 0);
  assert.equal(delMarkDiff.级别, 'C');
  assert.match(delMarkDiff.差异[0], /^#0 缺失原剧情标记：世界\.剧情标记\.灯塔状态/);

  const modMark = clone(sealed0);
  modMark.世界.剧情标记.灯塔状态 = '熄灭';
  const modMarkDiff = diffWorldbookState(sealed0, modMark, 2);
  assert.equal(modMarkDiff.级别, 'C');
  assert.match(modMarkDiff.差异[0], /^#2 字段变化：世界\.剧情标记\.灯塔状态（运转 → 熄灭）/);

  const modRole = clone(sealed0);
  modRole.角色 = {秦守: {好感度: {灯塔学徒: 10}}};
  const baseWithFavor = clone(sealed0);
  baseWithFavor.角色 = {秦守: {好感度: {灯塔学徒: 5}}};
  const modRoleDiff = diffWorldbookState(baseWithFavor, modRole, 2);
  assert.equal(modRoleDiff.级别, 'C');
  assert.equal(modRoleDiff.差异[0], '#2 字段变化：角色.秦守.好感度.灯塔学徒（5 → 10）');

  const manyDiffsSaved = clone(sealed0), manyDiffsNew = clone(sealed0);
  manyDiffsSaved.角色 = {秦守: {}};
  manyDiffsNew.角色 = {秦守: {}};
  for (let i = 0; i < 12; i++) {
    manyDiffsSaved.角色.秦守[`k${String(i).padStart(2, '0')}`] = i;
    manyDiffsNew.角色.秦守[`k${String(i).padStart(2, '0')}`] = i + 100;
  }
  const truncated = diffWorldbookState(manyDiffsSaved, manyDiffsNew, 4);
  assert.equal(truncated.级别, 'C');
  assert.equal(truncated.差异.length, 10);
  assert.equal(truncated.差异总数, 12);

  // 构造一套在旧世界书下合法的两楼聊天（#0 开场 + #2 秦守讲旧事）
  const cmd0 = [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {灯塔学徒: true, 秦守: true}}}];
  const run0 = applyCommands(oldProtocol, sealed0, cmd0);
  assert.deepEqual(run0.失败, []);
  const cmd2 = [{确认事件: {事件ID: '秦守讲旧事', 分支ID: '讲述'}}];
  const run2 = applyCommands(oldProtocol, run0.state, cmd2);
  assert.deepEqual(run2.失败, []);

  const m0 = makeMsg(0, 'assistant', '开场白。');
  m0.data = {世界树: makeRecord({msg: m0, state: run0.state, commands: cmd0, written: run0.已写入, manifest: oldManifest})};
  const m1 = makeMsg(1, 'user', '询问旧事。');
  const m2 = makeMsg(2, 'assistant', '秦守讲了旧事。');
  m2.data = {世界树: makeRecord({msg: m2, state: run2.state, commands: cmd2, written: run2.已写入, manifest: oldManifest})};
  const chat = [m0, m1, m2];

  // 3. A 级：纯文本改动 + 新增未到期未来事件，重放快照 0 差异；混合哈希续写楼层同样通过校验
  const aCatalog = clone(baseCatalog);
  aCatalog.events[0].内容.事件概要 = '顺清措辞后的概要。';
  aCatalog.events.push({
    id: '未来航线',
    内容: {
      事件ID: '未来航线', 事件标题: '未来航线', 事件概要: '未来事件。', 主类型: '世界',
      触发时间: {最早: '潮历075年01月01日', 最晚: '潮历075年04月10日'},
      确认策略: '仅作候选', 核心参与者: [], 默认分支: '起航',
      分支: [{分支ID: '起航', 分支条件: '条件', 分支结果: '结果', 变化: []}],
    },
  });
  const aAudit = createHistoryAudit({protocol: createProtocol({catalog: aCatalog, decl: baseDecl}), manifest: newManifest});
  const aRes = aAudit.audit(chat);
  assert.equal(aRes.ok, true);
  assert.equal(aRes.worldbook.级别, 'A');
  assert.deepEqual(aRes.worldbook.差异楼号, [0, 2]);

  const mixedChat = clone(chat);
  mixedChat[2].data.世界树.运行清单 = storedManifest(newManifest);
  assert.equal(aAudit.audit(mixedChat).ok, true);
  assert.equal(aAudit.checkRecords(mixedChat, {allowWorldbookDiff: true}).ok, true);

  // 4. B 级：仅新增角色组与剧情标记，输出精确新增摘要与合法升级计划，且原 chat 未被改写
  const bCatalog = clone(baseCatalog);
  const bDecl = clone(baseDecl);
  const extraGroup = clone(bCatalog.groups[0]);
  extraGroup.id = '新增角色甲';
  extraGroup.内容.角色组ID = '新增角色甲';
  extraGroup.内容.显示名 = '新增角色甲';
  extraGroup.内容.默认启用 = false;
  extraGroup.内容.默认版本 = '新增角色甲';
  extraGroup.内容.版本 = undefined;
  extraGroup.版本清单 = ['新增角色甲'];
  extraGroup.内容.档案 = extraGroup.内容.档案.slice(0, 1).map(item => ({...item, 适用版本: undefined, 默认: true, 生效条件: undefined, 前置档案: undefined}));
  bCatalog.groups.push(extraGroup);
  bDecl.marks.潮汐暗流 = ['平静', '涌动'];
  const bAudit = createHistoryAudit({protocol: createProtocol({catalog: bCatalog, decl: bDecl}), manifest: newManifest});
  const chatBeforeB = JSON.stringify(chat);
  const bRes = bAudit.audit(chat);
  assert.equal(JSON.stringify(chat), chatBeforeB, 'B 级试重放绝不得修改原聊天变量');
  assert.equal(bRes.ok, false);
  assert.equal(bRes.code, '运行清单.世界书哈希');
  assert.equal(bRes.级别, 'B');
  assert.deepEqual(bRes.upgrade.新增角色组, ['新增角色甲']);
  assert.deepEqual(bRes.upgrade.新增剧情标记, ['潮汐暗流=平静']);
  assert.deepEqual(bRes.upgrade.待升级楼号, [0, 2]);
  assert.equal(bRes.upgrade.升级计划.length, 2);

  const upgradedChat = clone(chat);
  for (const step of bRes.upgrade.升级计划) {
    assert.equal(validateRecord(step.记录, upgradedChat[step.楼号], newManifest).ok, true);
    upgradedChat[step.楼号].data.世界树 = step.记录;
  }
  assert.equal(bAudit.audit(upgradedChat).ok, true);
  assert.equal(upgradedChat[2].data.世界树.本局.世界.剧情标记.潮汐暗流, '平静');
  assert.deepEqual(upgradedChat[2].data.世界树.本局.开局.角色组.新增角色甲, {启用: false, 版本ID: '新增角色甲'});

  // 5. C 级反例全拦截：删组、删标记、早于开局时间的过去事件、命令失败、已写入变化、非法哈希与卡ID/程序指纹高优先级
  const cDeleteGroup = clone(baseCatalog);
  cDeleteGroup.groups = cDeleteGroup.groups.filter(group => group.id !== '白棠');
  const cDelRes = createHistoryAudit({protocol: createProtocol({catalog: cDeleteGroup, decl: baseDecl}), manifest: newManifest}).audit(chat);
  assert.equal(cDelRes.ok, false);
  assert.equal(cDelRes.级别, 'C');
  assert.match(cDelRes.差异[0], /^#0 重放异常（封卷\.参数）：角色组不存在：白棠/);

  const cDeleteMarkDecl = clone(baseDecl);
  delete cDeleteMarkDecl.marks.灯塔状态;
  const cDelMarkRes = createHistoryAudit({protocol: createProtocol({catalog: baseCatalog, decl: cDeleteMarkDecl}), manifest: newManifest}).audit(chat);
  assert.equal(cDelMarkRes.ok, false);
  assert.equal(cDelMarkRes.级别, 'C');
  assert.match(cDelMarkRes.差异[0], /^#0 缺失原剧情标记：世界\.剧情标记\.灯塔状态/);

  const cPastEvent = clone(baseCatalog);
  cPastEvent.events.push({
    id: '新增过去事件',
    内容: {
      事件ID: '新增过去事件', 事件标题: '旧事', 事件概要: '早于开局。', 主类型: '世界',
      触发时间: {最早: '潮历070年01月01日', 最晚: '潮历070年01月10日'},
      确认策略: '自动确认', 核心参与者: [], 默认分支: '发生',
      分支: [{分支ID: '发生', 分支条件: '条件', 分支结果: '结果', 变化: []}],
    },
  });
  const cPastRes = createHistoryAudit({protocol: createProtocol({catalog: cPastEvent, decl: baseDecl}), manifest: newManifest}).audit(chat);
  assert.equal(cPastRes.ok, false);
  assert.equal(cPastRes.级别, 'C');
  assert.ok(cPastRes.差异.some(line => /^#0 字段变化：事件\.新增过去事件/.test(line)));

  const cCmdFail = clone(baseCatalog);
  cCmdFail.events.find(e => e.id === '秦守讲旧事').内容.分支 = cCmdFail.events.find(e => e.id === '秦守讲旧事').内容.分支.filter(b => b.分支ID !== '讲述');
  const cFailRes = createHistoryAudit({protocol: createProtocol({catalog: cCmdFail, decl: baseDecl}), manifest: newManifest}).audit(chat);
  assert.equal(cFailRes.ok, false);
  assert.equal(cFailRes.级别, 'C');
  assert.match(cFailRes.差异[0], /^#2 命令失败（协议\.参数）/);

  const cWrittenChat = clone(chat);
  cWrittenChat[2].data.世界树.已写入 = [];
  const cWrittenRes = aAudit.audit(cWrittenChat);
  assert.equal(cWrittenRes.ok, false);
  assert.equal(cWrittenRes.级别, 'C');
  assert.match(cWrittenRes.差异[0], /^#2 已写入变化：/);

  const badHashChat = clone(chat);
  badHashChat[2].data.世界树.运行清单.世界书哈希 = 'bad-hash';
  const badHashRes = bAudit.audit(badHashChat);
  assert.equal(badHashRes.ok, false);
  assert.equal(badHashRes.code, '运行清单.世界书哈希');
  assert.equal(badHashRes.级别, undefined, '非法哈希格式须在试重放前直接拒绝');

  const badProgramChat = clone(chat);
  badProgramChat[2].data.世界树.运行清单.程序指纹 = '9'.repeat(64);
  const badProgramRes = bAudit.audit(badProgramChat);
  assert.equal(badProgramRes.code, '运行清单.程序指纹', '程序指纹不兼容优先级须高于世界书分级');

  const badCardChat = clone(chat);
  badCardChat[2].data.世界树.运行清单.卡ID = 'other.card';
  const badCardRes = bAudit.audit(badCardChat);
  assert.equal(badCardRes.code, '运行清单.卡ID', '卡ID 不一致优先级须高于世界书分级');
});
