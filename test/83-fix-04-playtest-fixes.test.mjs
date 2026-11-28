import {test, assert, fs, path, project, fixture, createTempPackRepo} from './helpers.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {loadRouter, route, applyCommands} from '../core/index.mjs';
import {createBookkeeper} from '../adapter/bookkeeper.mjs';
import {createOpeningDraft} from '../adapter/opening.mjs';
import {openingNode} from '../adapter/opening-ui.mjs';
import {packCard} from '../adapter/pack.mjs';
import {HOST_FUNCTIONS} from '../adapter/settings.mjs';

const sanguoRoot = path.join(project, 'examples/三国演义/世界书');
const wugangProject = path.join(project, 'test/fixtures/雾港');
const quiet = {write() {}};

function makeDomMock(t) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, '$');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, '$', saved);
    else delete globalThis.$;
  });
  const makeNode = tag => {
    const self = {tag, children: [], value: '', classes: [], handlers: {}, field: undefined, properties: {}, attrs: {}, shown: true};
    return Object.assign(self, {
      css: () => self,
      attr: (k, v) => {
        if (typeof k === 'object') Object.assign(self.attrs, k);
        else if (v !== undefined) self.attrs[k] = v;
        return self;
      },
      prop: (k, v) => v === undefined ? self.properties[k] : (self.properties[k] = v, self),
      addClass: names => { self.classes.push(...String(names).split(' ').filter(Boolean)); return self; },
      val: v => v === undefined ? self.field : (self.field = v, self),
      on: (type, fn) => { self.handlers[type] = fn; return self; },
      toggle: shown => { self.shown = shown; return self; },
      hide: () => self.toggle(false),
      show: () => self.toggle(true),
      empty: () => { self.children = []; return self; },
      append: (...children) => { self.children.push(...children.flat(Infinity).filter(Boolean)); return self; },
      text: v => v === undefined ? [self.value, ...self.children.map(c => c.text())].filter(Boolean).join('\n') : (self.value = v, self),
      find: () => self,
      remove: () => self,
      length: 0,
    });
  };
  globalThis.$ = tag => makeNode(tag);
  const findAll = (root, pred, out = []) => {
    if (!root) return out;
    if (pred(root)) out.push(root);
    for (const child of root.children ?? []) findAll(child, pred, out);
    return out;
  };
  return {
    find: (root, pred) => findAll(root, pred)[0],
    findAll,
  };
}

function installMinimalTavernHost(t) {
  const names = [
    ...HOST_FUNCTIONS,
    'generateRaw', 'tavern_events', '$', 'toastr', 'SillyTavern',
    'getProxyPresetNames', 'getModelList', 'getCurrentChatId', 'document', '__YGG_PLAYTEST_HOOK__',
  ];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const toasts = {success: [], info: [], warning: [], error: []};
  const node = () => {
    const self = {
      length: 0,
      children: [],
      attr: () => self,
      prop: () => self,
      addClass: () => self,
      removeClass: () => self,
      css: () => self,
      val: () => self,
      text: () => self,
      html: () => self,
      on: () => self,
      off: () => self,
      empty: () => self,
      append: () => self,
      prepend: () => self,
      after: () => self,
      remove: () => self,
      find: () => self,
      toggle: () => self,
      show: () => self,
      hide: () => self,
    };
    return self;
  };
  for (const name of HOST_FUNCTIONS) globalThis[name] = () => {};
  globalThis.getLastMessageId = () => -1;
  globalThis.getChatMessages = () => [];
  globalThis.getVariables = () => ({});
  globalThis.replaceVariables = async () => {};
  globalThis.injectPrompts = () => {};
  globalThis.uninjectPrompts = () => {};
  globalThis.eventOn = () => {};
  globalThis.getButtonEvent = name => `btn:${name}`;
  globalThis.retrieveDisplayedMessage = () => node();
  globalThis.generateRaw = async () => '';
  globalThis.getProxyPresetNames = async () => [];
  globalThis.getModelList = async () => [];
  globalThis.getCurrentChatId = () => 'test-chat';
  globalThis.tavern_events = {
    CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
  };
  globalThis.$ = () => node();
  globalThis.document = {head: {appendChild() {}}, getElementById: () => null, createElement: () => ({id: '', textContent: ''})};
  globalThis.toastr = {
    success: (m, tText) => toasts.success.push([m, tText]),
    info: (m, tText) => toasts.info.push([m, tText]),
    warning: (m, tText) => toasts.warning.push([m, tText]),
    error: (m, tText) => toasts.error.push([m, tText]),
  };
  globalThis.SillyTavern = {getContext: () => ({chatId: 'test-chat', characters: undefined})};
  return {toasts};
}

test('YG-FIX-04-A2：记账自定义装备当前持有、状态/位置格式与移交提示，且内核保留非强制唯一', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});

  const sealed = protocol.seal({
    开局时间: '潮历071年04月01日',
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      自定义装备: [{名称: '旧银哨', 说明: '遇雾吹响可引回应。', 状态: '完好', 位置: '颈间'}],
    },
  });
  const opened = applyCommands(protocol, sealed, [
    {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}},
  ]).state;

  // 1) 开局后提示词的 自定义装备 包含 当前持有（玩家、状态、位置），格式统一为 状态/位置，RULES 含移交同步移除原主提示
  const req1 = keeper.request(opened, {input: '查看随身物品', narration: '阿客摸了摸颈间的旧银哨。'});
  const sys1 = req1.prompts[0].content;
  assert.match(sys1, /自定义装备:[\s\S]*名称: 旧银哨[\s\S]*当前持有:[\s\S]*角色: 玩家[\s\S]*状态: 完好[\s\S]*位置: 颈间/);
  assert.match(sys1, /角色\.<角色组ID>\.装备\.<自定义装备名称>：新增、设定、移除；状态为 [^（\n]+，写作“状态\/位置”/);
  assert.doesNotMatch(sys1, /角色\.<角色组ID>\.装备\.<自定义装备名称>[^\n]*值为 \{状态:/);
  assert.match(sys1, /移交唯一自定义装备或物品给他人时，须在“变化”中同时移除原持有者并向新持有者新增或设定/);

  // 2) 动态事件移除玩家装备并新增到秦守后，下一轮准确反映当前持有变更
  const transfer = keeper.run(opened, {
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: ['秦守'],
    发生的事件: [],
    新情况: [{
      事件ID: '转交旧银哨',
      摘要: '阿客把旧银哨交给秦守保管。',
      实际参与者: ['玩家', '秦守'],
      结束事件串: '',
      变化: [
        {路径: '角色.玩家.装备.旧银哨', 操作: '移除', 值: ''},
        {路径: '角色.秦守.装备.旧银哨', 操作: '新增', 值: '破损/腰带'},
      ],
    }],
  });
  assert.deepEqual(transfer.失败, []);
  const req2 = keeper.request(transfer.state, {input: '继续交谈', narration: '秦守将旧银哨系在腰带上。'});
  const sys2 = req2.prompts[0].content;
  assert.match(sys2, /名称: 旧银哨[\s\S]*当前持有:[\s\S]*角色: 秦守[\s\S]*状态: 破损[\s\S]*位置: 腰带/);
  assert.doesNotMatch(sys2, /名称: 旧银哨[\s\S]*当前持有:[\s\S]*角色: 玩家/);

  // 3) 无人持有时 当前持有 为 []
  const dropped = keeper.run(transfer.state, {
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: ['秦守'],
    发生的事件: [],
    新情况: [{
      事件ID: '旧银哨落海',
      摘要: '旧银哨不慎滑落海中。',
      实际参与者: ['秦守'],
      结束事件串: '',
      变化: [{路径: '角色.秦守.装备.旧银哨', 操作: '移除', 值: ''}],
    }],
  });
  assert.deepEqual(dropped.失败, []);
  const req3 = keeper.request(dropped.state, {input: '望向海面', narration: '海浪吞没了银哨。'});
  assert.match(req3.prompts[0].content, /名称: 旧银哨[\s\S]*当前持有: \[\]/);

  // 4) 内核不强制唯一：未移除原主时向另一角色新增同一自定义装备仍放行，且当前持有排序稳定（玩家优先）
  const shared = applyCommands(protocol, opened, [{
    动态事件: {
      事件ID: '共持银哨',
      摘要: '秦守也配了一枚同名旧银哨。',
      实际参与者: ['玩家', '秦守'],
      变化: [{路径: '角色.秦守.装备.旧银哨', 操作: '新增', 值: {状态: '完好', 位置: '工具箱'}}],
    },
  }]);
  assert.deepEqual(shared.失败, []);
  assert.deepEqual(shared.state.角色.玩家.装备['旧银哨'], {状态: '完好', 位置: '颈间'});
  assert.deepEqual(shared.state.角色.秦守.装备['旧银哨'], {状态: '完好', 位置: '工具箱'});
  const req4 = keeper.request(shared.state, {input: '', narration: '二人各自留着银哨。'});
  const sys4 = req4.prompts[0].content;
  assert.ok(sys4.indexOf('角色: 玩家') < sys4.indexOf('角色: 秦守'));
});

test('YG-FIX-04-A3：记账可写字段补列角色.所在并支持动态事件修改离场角色所在', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});

  const sealed = protocol.seal({开局时间: '潮历071年04月01日'});
  const opened = applyCommands(protocol, sealed, [
    {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: false}}},
  ]).state;

  const sys = keeper.request(opened, {input: '打听秦守去向', narration: '听说秦守已经赶往码头查看船只。'}).prompts[0].content;
  assert.match(sys, /## 可写字段[\s\S]*角色\.<角色组ID>\.所在：设定；<地点ID>（仅用于不在场角色位置变更）/);

  const moved = keeper.run(opened, {
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: [],
    发生的事件: [],
    新情况: [{
      事件ID: '秦守前往商会馆',
      摘要: '秦守不在场，动身前往商会馆商议补给。',
      实际参与者: ['秦守'],
      结束事件串: '',
      变化: [{路径: '角色.秦守.所在', 操作: '设定', 值: '商会馆'}],
    }],
  });
  assert.deepEqual(moved.失败, []);
  assert.equal(moved.state.角色.秦守.所在, '商会馆');

  // 无地点库时不追加 角色.<角色组ID>.所在 行
  const noLocCatalog = structuredClone(catalog);
  noLocCatalog.entries.地点 = [];
  const noLocKeeper = createBookkeeper({protocol, catalog: noLocCatalog, decl});
  const noLocSys = noLocKeeper.request(opened, {input: '', narration: '无事发生。'}).prompts[0].content;
  assert.doesNotMatch(noLocSys, /角色\.<角色组ID>\.所在：设定；<地点ID>/);
});

test('YG-FIX-04-A4：开局前端错型 YAML 防御、未来出生年拦截与路由非负年龄守卫', async t => {
  const {find} = makeDomMock(t);
  const {protocol, router} = await loadRouter(sanguoRoot, {fs, path});
  const {catalog, decl} = router;

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '中平001年04月02日'},
    commands: [{写场景: {当前地点: {地标: '涿县', 场景: '城门榜前'}}}],
  });
  const root = openingNode(draft);
  const getYamlArea = () => find(root, n => n.tag === '<textarea>' && n.attrs.rows === 6);
  const getErrorBox = () => find(root, n => n.classes.includes('ygg-opening-error'));

  // 1) 各种错型 YAML 均不抛 TypeError，顶部展示 封卷.参数 错误，修正后恢复
  const malformedYamls = [
    '稳定体貌:\n  特征: 纯文本',
    '稳定体貌: 纯文本',
    '称号: 123',
    '穿着习惯:\n  k: v',
  ];
  for (const yamlText of malformedYamls) {
    assert.doesNotThrow(() => {
      getYamlArea().handlers.change({target: {value: yamlText}});
    }, `错型 YAML 不应抛异常：${yamlText}`);
    const errBox = getErrorBox();
    assert.ok(errBox, `应展示错误框：${yamlText}`);
    assert.match(errBox.text(), /封卷\.参数/, yamlText);
    assert.equal(draft.prepare().ok, false, yamlText);
  }
  assert.doesNotThrow(() => {
    getYamlArea().handlers.change({target: {value: '姓名: 游侠\n称号:\n  - 义士\n稳定体貌:\n  特征:\n    - 眉目清朗\n穿着习惯:\n  - 青布长衫'}});
  });
  assert.equal(draft.snapshot().错误, null);
  assert.equal(getErrorBox(), undefined);
  assert.equal(draft.prepare().ok, true);

  // 2) protocol.seal 与 draft.prepare() 拒绝未来出生年（跨年 & 同年更晚日），放行同日/同年（0 岁）与纪元前
  assert.throws(
    () => protocol.seal({开局时间: '中平006年', 玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: '中平010年'}}}),
    error => error?.code === '封卷.参数' && /不能晚于开局时间/.test(error.message),
  );
  assert.throws(
    () => protocol.seal({开局时间: '中平001年04月02日', 玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: '中平001年04月03日'}}}),
    error => error?.code === '封卷.参数' && /不能晚于开局时间/.test(error.message),
  );

  draft.setTime('中平001年04月02日');
  assert.equal(draft.setProfileField('出生年', '中平001年04月03日').ok, false);
  assert.equal(draft.snapshot().错误?.code, '封卷.参数');
  assert.equal(draft.prepare().ok, false);

  assert.equal(draft.setProfileField('出生年', '中平005年').ok, false);
  assert.equal(draft.snapshot().错误?.code, '封卷.参数');
  assert.equal(draft.prepare().ok, false);

  // 放行边界：同日、同年（0 岁）、纪元前
  for (const [openTime, birth] of [
    ['中平001年04月02日', '中平001年04月02日'],
    ['中平001年04月02日', '中平001年'],
    ['中平001年', '中平001年'],
    ['中平001年04月02日', '中平前019年'],
  ]) {
    const sealed = protocol.seal({开局时间: openTime, 玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: birth}}});
    assert.equal(sealed.开局.玩家.档案.出生年, birth);
    draft.setTime(openTime);
    assert.equal(draft.setProfileField('出生年', birth).ok, true, `${openTime} / ${birth}`);
    assert.equal(draft.prepare().ok, true, `${openTime} / ${birth}`);
  }

  // 3) route() 在人工构造的“出生年晚于当前时间”状态（模拟旧存档或未出生角色）下绝不输出负年龄
  const baseState = applyCommands(
    protocol,
    protocol.seal({开局时间: '中平001年04月02日', 玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: '中平001年'}}}),
    [{写场景: {当前地点: {地标: '涿县', 场景: '城门榜前'}}}],
  ).state;
  const legacyState = structuredClone(baseState);
  legacyState.开局.玩家.档案.出生年 = '中平005年';
  const routed = route(router, legacyState, []);
  const playerCard = routed.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.ok(playerCard);
  assert.equal(Object.hasOwn(playerCard, '年龄'), false, '未来出生年不得注入负年龄字段');
});

test('YG-FIX-04-A5：记账提示词展示被引用条目库的合法 ID 列表，无此类引用库时不输出该节', async () => {
  // 1) 三国演义：角色变量引用 势力 库，按码点序输出 ## 可用引用ID，位于 ## 地点列表 与 ## 可写字段 之间
  const {protocol, router} = await loadRouter(sanguoRoot, {fs, path});
  const {catalog, decl} = router;
  const keeper = createBookkeeper({protocol, catalog, decl});
  const state = protocol.seal({开局时间: '中平001年04月02日'});
  const sys = keeper.request(state, {input: '', narration: '城外风起。'}).prompts[0].content;

  const locIdx = sys.indexOf('## 地点列表');
  const refIdx = sys.indexOf('## 可用引用ID');
  const writeIdx = sys.indexOf('## 可写字段');
  assert.ok(locIdx >= 0 && refIdx > locIdx && writeIdx > refIdx, '## 可用引用ID 应紧接 ## 地点列表 之后、## 可写字段 之前');

  const expectedFactions = catalog.entries.势力.map(e => e.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.ok(expectedFactions.length > 0);
  assert.ok(sys.includes(`势力：${expectedFactions.join('、')}`), '应按码点序输出全部已声明势力 ID');
  assert.match(sys, /映射键与引用值仅可使用以上已声明 ID；剧情中新出现且未在库中的组织\/条目勿作为映射键，改记入身份或事件摘要。/);

  // 2) 雾港夹具：同样有 势力 引用（声望映射键）
  const wugang = await loadRouter(path.join(wugangProject, '世界书'), {fs, path});
  const wKeeper = createBookkeeper({protocol: wugang.protocol, catalog: wugang.router.catalog, decl: wugang.router.decl});
  const wState = wugang.protocol.seal({开局时间: '潮历071年04月01日'});
  const wSys = wKeeper.request(wState, {input: '', narration: '雾气渐浓。'}).prompts[0].content;
  assert.match(wSys, /## 可用引用ID[\s\S]*势力：/);

  // 3) 无非地点/装备/角色组引用库时，不输出 ## 可用引用ID
  const noRefDecl = structuredClone(wugang.router.decl);
  noRefDecl.variables = {单次增减上限: noRefDecl.variables.单次增减上限, 世界: {}, 角色: {}};
  const noRefKeeper = createBookkeeper({protocol: wugang.protocol, catalog: wugang.router.catalog, decl: noRefDecl});
  const noRefSys = noRefKeeper.request(wState, {input: '', narration: '雾气渐浓。'}).prompts[0].content;
  assert.doesNotMatch(noRefSys, /## 可用引用ID/);
});

test('YG-FIX-04-A6：打包角色卡只读离线试玩钩子与无钩子默认静默行为', async t => {
  const tmpRepo = await createTempPackRepo(t);
  const packed = await packCard({
    projectDir: wugangProject,
    faceFile: path.join(wugangProject, '卡面.yaml'),
    repo: tmpRepo,
    adapterDir: path.join(tmpRepo, 'adapter'),
    stdout: quiet,
    stderr: quiet,
  });
  const card = JSON.parse(await fs.readFile(packed.cardFile, 'utf8'));
  const script = card.data?.extensions?.tavern_helper?.scripts?.[0]?.content;
  assert.ok(typeof script === 'string' && script.length > 0, '打包卡应包含世界树脚本');

  // 1) 注入钩子：精确拿到冻结 API 对象且核心接口全部可用
  const {toasts} = installMinimalTavernHost(t);
  let captured = null;
  globalThis.__YGG_PLAYTEST_HOOK__ = api => { captured = api; };
  const urlWithHook = `data:text/javascript;base64,${Buffer.from(`${script}\n// hook-run\n`, 'utf8').toString('base64')}`;
  await import(urlWithHook);

  assert.ok(captured, '应触发 __YGG_PLAYTEST_HOOK__ 回调');
  assert.equal(Object.isFrozen(captured), true, '钩子暴露的 API 对象须为只读冻结对象');
  const expectedKeys = [
    'bundle', 'manifest', 'loaded', 'decl', 'catalog', 'settings', 'protocol', 'router', 'quietRouter', 'keeper',
    'createOpeningDraft', 'openingNode', 'runKeeperLoop', 'buildKeepRecord', 'repairRecord', 'callKeeper', 'generateOpening',
    'parseJson', 'applyCommands', 'route', 'renderContext', 'stringifyYaml', 'createCalendar', 'evaluateCondition', 'conditionReferences', 'seal',
  ];
  for (const key of expectedKeys) assert.ok(Object.hasOwn(captured, key), `钩子缺少键：${key}`);

  const draft = captured.createOpeningDraft({
    protocol: captured.protocol,
    catalog: captured.catalog,
    decl: captured.decl,
    defaults: captured.bundle.opening,
    commands: captured.bundle.openingCommands,
  });
  const prepared = draft.prepare();
  assert.equal(prepared.ok, true);
  const advanced = captured.applyCommands(captured.protocol, prepared.record.本局, [
    {写场景: {当前地点: {地标: '灯塔', 场景: '塔顶'}}},
  ]);
  assert.deepEqual(advanced.失败, []);
  const routed = captured.route(captured.router, advanced.state, ['查看灯塔动静。']);
  assert.ok(routed.context.世界状态.当前地点.地标 === '灯塔');
  const keeperReq = captured.keeper.request(advanced.state, {input: '看海', narration: '雾气笼罩着塔顶。'});
  assert.equal(keeperReq.prompts.length, 2);
  assert.match(keeperReq.prompts[0].content, /角色\.<角色组ID>\.所在：设定；<地点ID>/);
  assert.equal(toasts.success.length, 1);

  // 2) 不设钩子时正常启动，无报错无副作用
  delete globalThis.__YGG_PLAYTEST_HOOK__;
  const urlNoHook = `data:text/javascript;base64,${Buffer.from(`${script}\n// no-hook-run\n`, 'utf8').toString('base64')}`;
  await import(urlNoHook);
  assert.equal(toasts.success.length, 2);
  assert.equal(toasts.error.length, 0);
});
