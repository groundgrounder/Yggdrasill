import {test, assert, fs, path, project, fixture} from './helpers.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {applyCommands} from '../core/commands.mjs';
import {createBookkeeper} from '../adapter/bookkeeper.mjs';
import {createView} from '../adapter/view.mjs';
import {createOpeningDraft} from '../adapter/opening.mjs';
import {createOpeningStorage} from '../adapter/settings.mjs';
import {
  installStyle, sectionNode, panelNode, textNode, openingNode,
  openingStatusNode, floorNode, repairNode, readOnlyNode,
  permissionNode, upgradeNode, settingsNode,
} from '../adapter/ui.mjs';

const sanguoRoot = path.join(project, 'examples/三国演义/世界书');

const FORBIDDEN_METHODS = new Set([
  'html', 'removeClass', 'toggleClass', 'prepend', 'find',
  'closest', 'parent', 'siblings', 'children', 'data',
]);

// 与 adapter/smoke.mjs 同构的严格极简 $ 桩：仅允许 13 个白名单方法，调用任何禁区方法立即抛错。
function makeStrictDomMock(t) {
  const savedDollar = Object.getOwnPropertyDescriptor(globalThis, '$');
  const savedToastr = Object.getOwnPropertyDescriptor(globalThis, 'toastr');
  const headChildren = [];
  const headNode = {
    append: (...items) => { headChildren.push(...items.flat(Infinity).filter(Boolean)); return headNode; },
  };
  t.after(() => {
    if (savedDollar) Object.defineProperty(globalThis, '$', savedDollar);
    else delete globalThis.$;
    if (savedToastr) Object.defineProperty(globalThis, 'toastr', savedToastr);
    else delete globalThis.toastr;
  });

  const makeNode = tag => {
    const raw = {
      tag, children: [], value: '', classes: [], handlers: {},
      field: undefined, properties: {}, attrs: {}, shown: true,
    };
    const methods = {
      css: () => proxy,
      attr: (k, v) => {
        if (typeof k === 'object') Object.assign(raw.attrs, k);
        else if (v !== undefined) raw.attrs[k] = v;
        else return raw.attrs[k];
        return proxy;
      },
      remove: () => proxy,
      prop: (k, v) => v === undefined ? raw.properties[k] : (raw.properties[k] = v, proxy),
      addClass: names => { raw.classes.push(...String(names).split(' ').filter(Boolean)); return proxy; },
      val: v => v === undefined ? raw.field : (raw.field = v, proxy),
      on: (type, fn) => { raw.handlers[type] = fn; return proxy; },
      toggle: shown => { raw.shown = Boolean(shown); return proxy; },
      hide: () => methods.toggle(false),
      show: () => methods.toggle(true),
      empty: () => { raw.children = []; return proxy; },
      append: (...children) => { raw.children.push(...children.flat(Infinity).filter(Boolean)); return proxy; },
      text: v => v === undefined
        ? [raw.value, ...raw.children.map(c => c.text())].filter(Boolean).join('\n')
        : (raw.value = v, proxy),
    };
    const proxy = new Proxy(raw, {
      get(target, prop) {
        if (prop in methods) return methods[prop];
        if (FORBIDDEN_METHODS.has(prop)) {
          if (prop === 'children') return target.children;
          throw new Error(`禁止调用非白名单 jQuery 方法: .${String(prop)}()`);
        }
        return target[prop];
      },
    });
    return proxy;
  };

  globalThis.$ = selector => {
    if (selector === 'head') return headNode;
    if (typeof selector === 'string' && selector.startsWith('#')) {
      return {
        remove: () => {
          const id = selector.slice(1);
          for (let i = headChildren.length - 1; i >= 0; i--) {
            if (headChildren[i]?.attrs?.id === id) headChildren.splice(i, 1);
          }
        },
      };
    }
    return makeNode(selector);
  };
  globalThis.toastr = {success: () => {}, error: () => {}, warning: () => {}, info: () => {}};

  const findAll = (root, pred, out = []) => {
    if (!root) return out;
    if (pred(root)) out.push(root);
    for (const child of root.children ?? []) findAll(child, pred, out);
    return out;
  };
  return {
    headChildren,
    find: (root, pred) => findAll(root, pred)[0],
    findAll,
  };
}

function mockGlobalVars(t, initial = {}) {
  let store = structuredClone(initial);
  const savedGet = Object.getOwnPropertyDescriptor(globalThis, 'getVariables');
  const savedReplace = Object.getOwnPropertyDescriptor(globalThis, 'replaceVariables');
  t.after(() => {
    if (savedGet) Object.defineProperty(globalThis, 'getVariables', savedGet);
    else delete globalThis.getVariables;
    if (savedReplace) Object.defineProperty(globalThis, 'replaceVariables', savedReplace);
    else delete globalThis.replaceVariables;
  });
  globalThis.getVariables = ({type}) => type === 'global' ? structuredClone(store) : {};
  globalThis.replaceVariables = async (next, {type}) => {
    if (type === 'global') store = structuredClone(next);
  };
}

test('YG-UI-01-A2：installStyle 注入设计令牌、响应式与减动效规则且零外链', t => {
  const {headChildren} = makeStrictDomMock(t);
  installStyle();
  const styleNode = headChildren.find(n => n.attrs.id === 'ygg-style');
  assert.ok(styleNode, '应向 head 注入 #ygg-style');
  const css = styleNode.text();

  for (const token of [
    '--ygg-bg-surface', '--ygg-bg-elevated', '--ygg-bg-subtle',
    '--ygg-border', '--ygg-border-strong', '--ygg-accent', '--ygg-muted',
    '--ygg-ok', '--ygg-warn', '--ygg-bad', '--ygg-info',
  ]) {
    assert.ok(css.includes(token), `CSS 缺少设计令牌 ${token}`);
  }
  assert.match(css, /@media\s*\(\s*max-width:\s*640px\s*\)/, 'CSS 须含移动端 640px 响应式规则');
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/, 'CSS 须尊重 prefers-reduced-motion');
  assert.match(css, /mask-image:\s*url\("data:image\/svg\+xml;base64,/, 'CSS 须使用纯 CSS data URI 微图标');
  assert.doesNotMatch(css, /https?:\/\//i, 'CSS 严禁包含任何 http:// 或 https:// 外链');
});

test('YG-UI-01-A2/A3：极简 DOM 桩全组件零抛错，本局面板概览/标签/时间轴/表格包装完整', async t => {
  const {find, findAll} = makeStrictDomMock(t);
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});
  const view = createView({protocol, catalog, decl, keeper});

  const base = protocol.seal({
    开局时间: '潮历071年04月01日',
    玩家: {模式: '自建', 档案: {姓名: '林客', 出生年: '潮历052年'}},
  });
  const {state} = applyCommands(protocol, base, [
    {确认初始化: {角色组ID: '秦守'}},
    {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}},
    {动态事件: {事件ID: '初登灯塔', 摘要: '雨夜登上灯塔与秦守初遇。', 实际参与者: ['玩家', '秦守'], 变化: []}},
  ]);

  // 1) 玩家模式 panelNode：此刻 .ygg-hero、经历 .ygg-timeline、多分组 .ygg-tabs
  const playerSections = view.player(state);
  const playerPanel = panelNode('本局', playerSections);
  const fullPlayerText = playerPanel.text();
  assert.ok(find(playerPanel, n => n.classes.includes('ygg-panel-head')), '应渲染精致顶栏');
  assert.ok(find(playerPanel, n => n.classes.includes('ygg-hero')), '「此刻」应渲染为 .ygg-hero 概览卡');
  assert.ok(findAll(playerPanel, n => n.classes.includes('ygg-stat-card')).length >= 3, '「此刻」应渲染指标网格卡');
  assert.ok(find(playerPanel, n => n.classes.includes('ygg-timeline')), '「经历」应渲染为 .ygg-timeline 编年轴');
  assert.ok(findAll(playerPanel, n => n.classes.includes('ygg-timeline-item')).length >= 1, '时间轴应含条目');

  const tabs = findAll(playerPanel, n => n.classes.includes('ygg-tab-btn'));
  assert.deepEqual(tabs.map(b => b.attrs['data-tab']), ['all', 'roles', 'history']);
  assert.equal(tabs[0].attrs['aria-selected'], 'true');

  // 切换至「角色」标签：aria-selected 与 pane 显隐联动，且 panel.text() 仍保留全部文本
  const rolesPane = find(playerPanel, n => n.classes.includes('ygg-tab-pane') && n.attrs['data-tab'] === 'roles');
  const historyPane = find(playerPanel, n => n.classes.includes('ygg-tab-pane') && n.attrs['data-tab'] === 'history');
  tabs[1].handlers.click();
  assert.equal(tabs[1].attrs['aria-selected'], 'true');
  assert.equal(tabs[0].attrs['aria-selected'], 'false');
  assert.equal(rolesPane.shown, true);
  assert.equal(rolesPane.attrs['data-hidden'], 'false');
  assert.equal(historyPane.shown, false);
  assert.equal(historyPane.attrs['data-hidden'], 'true');
  assert.equal(playerPanel.text(), fullPlayerText, '切换标签不得销毁隐藏区 DOM');

  // 切换至「经历」标签
  tabs[2].handlers.click();
  assert.equal(rolesPane.shown, false);
  assert.equal(historyPane.shown, true);
  // 切回「全部」
  tabs[0].handlers.click();
  assert.equal(rolesPane.shown, true);
  assert.equal(historyPane.shown, true);

  // 2) 调试模式 panelNode：包含「调试」标签，且表格外包 .ygg-table-wrap
  const debugSections = view.debug(state, [{
    楼号: 0, 角色: 'assistant',
    记录: {记录格式: 1, 命令数: 2, 命令: [], 失败: [], 记账: {方式: '开场命令', 应答格式: '无', 状态: '成功', 尝试次数: 0}},
  }]);
  const debugPanel = panelNode('本局（调试）', debugSections);
  const debugTabs = findAll(debugPanel, n => n.classes.includes('ygg-tab-btn'));
  assert.deepEqual(debugTabs.map(b => b.attrs['data-tab']), ['all', 'roles', 'history', 'debug']);
  const debugPane = find(debugPanel, n => n.classes.includes('ygg-tab-pane') && n.attrs['data-tab'] === 'debug');
  debugTabs[3].handlers.click();
  assert.equal(debugPane.shown, true);
  assert.ok(find(debugPanel, n => n.classes.includes('ygg-table-wrap')), '表格必须外包 .ygg-table-wrap');

  // 3) 非标准/单组/告警弹窗不渲染多余标签栏
  const blockedPanel = panelNode('存档不可用（只读）', [
    {标题: '世界树', 展开: true, 行: ['校验失败']},
    {标题: '冲突差异明细（共 1 处）', 展开: true, 行: ['差异 1']},
  ]);
  assert.equal(find(blockedPanel, n => n.classes.includes('ygg-tabs')), undefined, '告警弹窗不应渲染多余标签栏');

  // 4) 其余全部组件在极简 DOM 桩上零抛错
  assert.ok(textNode('本轮上下文', '正文内容').text().includes('正文内容'));
  assert.ok(floorNode({摘要: '地点 灯塔·值守室', 详情: [['地点', ['灯塔·值守室']]], 失败: false}, {rekeep: () => {}, repair: () => {}}).text().includes('重新记账'));
  assert.ok(floorNode({摘要: '1 项没记上', 详情: [['没记上', ['1 项没记上']]], 失败: true}, {rekeep: () => {}}).classes.includes('ygg-warn'));
  assert.ok(floorNode(null, {pending: true}).classes.includes('ygg-pending'));
  assert.ok(openingStatusNode({open: () => {}, reason: '请先打开开局'}).text().includes('打开开局'));
  assert.ok(readOnlyNode('存档只读', '原因：校验.失败').classes.includes('ygg-blocked'));
  assert.ok(permissionNode('权限不足').classes.includes('ygg-blocked'));
  assert.ok(upgradeNode({新增角色组: ['新角色'], 新增剧情标记: [], 待升级楼号: [0, 2]}, {onUpgrade: () => {}, onInspect: () => {}}).classes.includes('ygg-upgrade'));

  // 5) settingsNode 交互（含测试连接成功/失败语义色）
  let testFail = false;
  const settingsRoot = settingsNode({
    current: {方式: '同一模型', 代理预设: '', 地址: '', 密钥: '', 模型: '', 来源: 'openai', 温度: 0.2, 最大长度: 0, 尝试次数: 2, 应答格式: '提示词', 每楼记录: true, 调试: false},
    save: () => Promise.resolve(),
    presets: ['默认代理'],
    activeModel: 'demo-model',
    pull: async () => ['m1', 'm2'],
    test: async () => { if (testFail) throw new Error('连接超时'); return {文本: 'OK'}; },
  });
  assert.ok(find(settingsRoot, n => n.classes.includes('ygg-panel-head')));
  const testBtn = find(settingsRoot, n => n.tag === '<button>' && n.text() === '测试记账连接');
  const statusSpan = find(settingsRoot, n => n.classes.includes('ygg-status'));
  await testBtn.handlers.click();
  assert.equal(statusSpan.attrs['data-tone'], 'ok');
  testFail = true;
  await testBtn.handlers.click();
  assert.equal(statusSpan.attrs['data-tone'], 'bad');

  // 6) repairNode 交互
  const rep = repairNode({
    id: 2,
    line: {摘要: '无变化', 详情: []},
    record: {失败: [{阶段: '记账', 错误码: '记账.JSON', 说明: '找不到 JSON'}]},
    debug: false,
  });
  assert.ok(find(rep.node, n => n.classes.includes('ygg-panel-head')));
  rep.setError('测试错误');
  assert.match(rep.node.text(), /测试错误/);
});

test('YG-UI-01-A3：openingNode 步骤徽标、折叠头摘要、双列时间地点、子卡片与结构化预览', async t => {
  const {find, findAll} = makeStrictDomMock(t);
  mockGlobalVars(t, {});
  const {catalog, decl} = await compileWorldbook(sanguoRoot, {fs, path});
  const multiCatalog = structuredClone(catalog);
  multiCatalog.worldlines = [
    {id: '正史', 内容: {概述: '主线世界线', 默认: true}},
    {id: '群雄', 内容: {概述: '分支世界线', 默认: false}},
  ];
  const protocol = createProtocol({catalog: multiCatalog, decl});
  const storage = createOpeningStorage('card-ui-polish-test');
  const draft = createOpeningDraft({
    protocol, catalog: multiCatalog, decl,
    defaults: {世界线: '正史', 开局时间: '中平001年04月02日'},
    commands: [{写场景: {当前地点: {地标: '涿县', 场景: '城门榜前'}}}],
  });

  const root = openingNode(draft, {storage});
  assert.ok(find(root, n => n.classes.includes('ygg-panel-head')), '开局弹窗应含精致顶栏');

  // 多世界线应有 1–6 步骤编号与折叠头摘要
  const steps = findAll(root, n => n.classes.includes('ygg-step-num')).map(n => n.attrs['data-step']);
  assert.deepEqual(steps, ['1', '2', '3', '4', '5', '6']);
  const summaries = findAll(root, n => n.classes.includes('ygg-sec-summary')).map(n => n.attrs['data-summary']);
  assert.equal(summaries.length, 6);
  assert.equal(summaries[0], '正史');
  assert.match(summaries[2], /中平001年04月02日/);
  assert.match(summaries[5], /已启用 \d+\/\d+ 角色组/);

  // 双列时间地点网格、子卡片、结构化预览网格
  assert.ok(find(root, n => n.classes.includes('ygg-opening-time-grid')), '存在地点列表时应渲染双列时间/地点网格');
  assert.ok(findAll(root, n => n.classes.includes('ygg-subcard')).length >= 4, '自建表单逻辑分组应包裹为 .ygg-subcard');
  assert.ok(find(root, n => n.classes.includes('ygg-preview-grid')), '有效预览应渲染 .ygg-preview-grid');

  // 预设保存、载入与恢复默认正常
  draft.setProfileField('姓名', '子龙');
  const bar = find(root, n => n.classes.includes('ygg-preset-bar'));
  await find(bar, n => n.tag === '<button>' && n.text() === '保存当前设定').handlers.click();
  assert.match(root.text(), /已保存设定「子龙」/);

  // 切换到扮演模式后仍含子卡片且步骤摘要实时更新
  const modeSelect = find(root, n => n.tag === '<select>' && n.children.some(o => o.field === '扮演'));
  modeSelect.handlers.change({target: {value: '扮演'}});
  const rpSummaries = findAll(root, n => n.classes.includes('ygg-sec-summary')).map(n => n.attrs['data-summary']);
  assert.match(rpSummaries[3], /^扮演 · /);
  assert.ok(findAll(root, n => n.classes.includes('ygg-subcard')).length >= 2, '扮演模式编辑区应包裹为 .ygg-subcard');
});

test('YG-UI-01-v2-A2/A3：待开局引导卡主强调按钮回调与 runtime init 不自动弹出开局弹窗', async t => {
  const {find} = makeStrictDomMock(t);
  let opened = 0;
  const guide = openingStatusNode({
    open: () => { opened += 1; },
    reason: '请先打开开局并确认。',
  });
  assert.ok(guide.classes.includes('ygg-floor'), '待开局卡片须保留 .ygg-floor');
  assert.ok(guide.classes.includes('ygg-pending'), '待开局卡片须保留 .ygg-pending');
  assert.ok(guide.classes.includes('ygg-opening-guide'), '待开局卡片应带 .ygg-opening-guide 引导样式');
  assert.match(guide.text(), /尚未开局/);
  const ctaBtn = find(guide, n => n.tag === '<button>' && n.text() === '打开开局');
  assert.ok(ctaBtn, '待开局引导卡应包含「打开开局」按钮');
  assert.ok(ctaBtn.classes.includes('menu_button'), '按钮须保留 .menu_button');
  assert.ok(ctaBtn.classes.includes('ygg-btn-primary'), '按钮应带主强调色类 .ygg-btn-primary');
  ctaBtn.handlers.click({preventDefault() {}});
  assert.equal(opened, 1, '点击「打开开局」按钮应触发 open() 回调');

  // 核验 adapter/runtime.mjs init() 在待开局态不自动调用 openingFlow.open()，但保留 openingPending = true 与 renderFloors()
  const runtimeSrc = await fs.readFile(path.join(project, 'adapter/runtime.mjs'), 'utf8');
  const initMatch = runtimeSrc.match(/async function init\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(initMatch, '应能在 adapter/runtime.mjs 中定位 init()');
  const initBody = initMatch[0];
  assert.match(initBody, /session\.openingPending\s*=\s*true;/, 'init() 应保持 session.openingPending = true');
  assert.match(initBody, /uninjectPrompts\(\[INJECT_ID\]\);/, 'init() 应清理注入');
  assert.match(initBody, /status\.renderFloors\(\);/, 'init() 应渲染第 0 楼待开局引导卡片');
  assert.doesNotMatch(initBody, /openingFlow\.open\s*\(/, 'init() 不得在新聊天待开局态自动调用 openingFlow.open()');
});
