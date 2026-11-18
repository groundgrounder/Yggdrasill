import {test, assert, path, project} from './helpers.mjs';
import {loadProtocol, S} from './protocol-helpers.mjs';
import {
  assertProgramMatches, collectProgram, importSpecifiers, programInputs, stripComments,
} from '../adapter/manifest.mjs';
import {fromText, parseBlock, parseCommands, stripCommands} from '../adapter/commands-parser.mjs';
import {DEFAULTS, HOST_FUNCTIONS, SETTINGS_KEY, hostMissing, keeperSettings, permissionFailure} from '../adapter/settings.mjs';
import {createBookkeeper} from '../adapter/bookkeeper.mjs';
import {createCalendar} from '../core/calendar.mjs';

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
  for (const name of ['runtime', 'settings', 'commands-parser', 'bookkeeper', 'records', 'opening', 'view', 'ui', 'memfs'])
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
