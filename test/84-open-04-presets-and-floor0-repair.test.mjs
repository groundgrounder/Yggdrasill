import {test, assert, fs, path, fixture} from './helpers.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {createOpeningDraft, createOpeningFlow, isDynamicOpening} from '../adapter/opening.mjs';
import {openingNode} from '../adapter/opening-ui.mjs';
import {SETTINGS_KEY, OPENING_PRESETS_KEY, saveSettings, createOpeningStorage} from '../adapter/settings.mjs';
import {createStatusView} from '../adapter/ui.mjs';
import {registerAdapterEvents} from '../adapter/events.mjs';

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
      remove: () => self,
      empty: () => { self.children = []; return self; },
      append: (...children) => { self.children.push(...children.flat(Infinity).filter(Boolean)); return self; },
      text: v => v === undefined ? [self.value, ...self.children.map(c => c.text())].filter(Boolean).join('\n') : (self.value = v, self),
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

function mockGlobalVars(t, initial = {}, {delayMs = 0} = {}) {
  let store = structuredClone(initial);
  let writeCount = 0;
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
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (type === 'global') {
      store = structuredClone(next);
      writeCount += 1;
    }
  };
  return {
    getStore: () => store,
    getWriteCount: () => writeCount,
  };
}

test('YG-OPEN-04-A2：开局设定完整往返序列化、版本容错导入、非法输入保护与一键恢复默认', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  catalog.openingOptions.内容.自由组合 = true;
  const protocol = createProtocol({catalog, decl});

  // 1) 自建模式完整往返
  const draft1 = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  assert.equal(draft1.isDirty(), false);
  assert.equal(draft1.setPlan('补考之年').ok, true);
  assert.equal(draft1.setTime('潮历074年').ok, true);
  assert.equal(draft1.setLocation('码头区').ok, true);
  assert.equal(draft1.setGroup('白棠', {启用: false, 版本ID: '白棠·船长'}).ok, true);
  assert.equal(draft1.setHistory('出师考核', '未发生').ok, true);
  assert.equal(draft1.setProfileField('姓名', '林海').ok, true);
  assert.equal(draft1.setProfileField('出生年', '潮历055年').ok, true);
  assert.equal(draft1.setProfileField('称号', '守灯人、海风客').ok, true);
  assert.equal(draft1.setProfileField('稳定体貌.发色发型', '黑发短发').ok, true);
  assert.equal(draft1.setInitialAbility('名望', '名匠').ok, true);
  assert.equal(draft1.setInitialAbility('技艺', {灯语: '匠人'}).ok, true);
  assert.equal(draft1.setInitialEquipment([{装备ID: '灯具·风暴灯', 状态: '完好', 位置: '腰间'}]).ok, true);
  assert.equal(draft1.setCustomEquipment([{名称: '旧银哨', 说明: '遇雾可鸣哨定位。', 状态: '完好', 位置: '随身'}]).ok, true);
  assert.equal(draft1.setCustomSkills([{名称: '听潮辨雾', 说明: '凭海声辨别暗礁。', 限制: '暴雨时减弱'}]).ok, true);
  assert.equal(draft1.addSkill('修船·补帆').ok, true);
  assert.equal(draft1.removeSkill('灯语·短讯').ok, true);
  draft1.setGreetingMode('提示扩写');
  assert.equal(draft1.setGreetingHint('海雾漫过栈桥，远方钟声响起。').ok, true);
  assert.equal(draft1.setCustomGreeting('手写备用正文。').ok, true);
  assert.equal(draft1.isDirty(), true);

  const exported1 = draft1.exportPreset();
  assert.equal(exported1.格式, 1);
  // 必须可纯 JSON 序列化往返
  const jsonRoundTrip = JSON.parse(JSON.stringify(exported1));

  const draft2 = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  const imp1 = draft2.importPreset(jsonRoundTrip);
  assert.equal(imp1.ok, true);
  assert.deepEqual(imp1.ignored, []);
  assert.deepEqual(draft2.exportPreset(), exported1);
  assert.equal(draft2.snapshot().自建表单.档案.姓名, '林海');
  assert.equal(draft2.snapshot().开场白模式, '提示扩写');
  assert.equal(draft2.snapshot().开场提示, '海雾漫过栈桥，远方钟声响起。');

  // 2) 扮演模式全部增量覆写往返
  const rpDraft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  assert.equal(rpDraft.setTime('潮历074年').ok, true);
  assert.equal(rpDraft.setPlayerMode('扮演').ok, true);
  assert.equal(rpDraft.setPlayerGroup('灯塔学徒').ok, true);
  assert.equal(rpDraft.setRoleplayAbility('名望', '名匠').ok, true);
  assert.equal(rpDraft.setRoleplayAbility('技艺', {灯语: '名匠'}).ok, true);
  assert.equal(rpDraft.setRoleplayEquipment('灯具·风暴灯', null).ok, true);
  assert.equal(rpDraft.setRoleplayEquipment('工具·铜扳手', {状态: '完好', 位置: '腰带'}).ok, true);
  assert.equal(rpDraft.removeSkill('灯语·短讯').ok, true);
  assert.equal(rpDraft.addSkill('修船·补帆').ok, true);
  rpDraft.setGreetingMode('手写');
  assert.equal(rpDraft.setCustomGreeting('扮演手写开场白。').ok, true);

  const rpExport = JSON.parse(JSON.stringify(rpDraft.exportPreset()));
  const rpDraft2 = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  const impRp = rpDraft2.importPreset(rpExport);
  assert.equal(impRp.ok, true);
  assert.deepEqual(impRp.ignored, []);
  assert.deepEqual(rpDraft2.exportPreset(), rpExport);
  assert.equal(rpDraft2.prepare().ok, true);

  // 3) 含失效世界线/方案/地点/角色组/版本/历史/技能/装备/能力与结构缺项自定义条目的旧预设容错导入
  const stalePreset = {
    格式: 1,
    世界线: '已删除世界线',
    方案: '不存在方案',
    时间: '潮历074年',
    时间已改: true,
    地点: '不存在地点',
    地点已改: true,
    角色组: {
      不存在角色: {启用: true},
      白棠: {启用: false, 版本ID: '不存在版本'},
    },
    历史选择: {
      不存在事件: '分支A',
      出师考核: '不存在分支',
    },
    玩家模式: '自建',
    扮演角色组: '不存在扮演角色',
    自建档案: {姓名: '幸存者'},
    初始能力: {不存在维度: '顶级', 名望: '不存在等级', 技艺: {不存在技艺: '匠人', 灯语: '匠人'}},
    初始装备: [{装备ID: '不存在装备', 状态: '完好', 位置: '随身'}, {装备ID: '灯具·风暴灯', 状态: '完好', 位置: '手提'}],
    自定义装备: [{名称: '缺说明装备', 状态: '完好', 位置: '随身'}, {名称: '合法护符', 说明: '海边拾得。', 状态: '完好', 位置: '颈间'}],
    自定义技能: [{名称: '缺说明技能'}, {名称: '辨星', 说明: '夜间凭星象定位。'}],
    额外技能: ['不存在技能', '修船·补帆'],
    移除技能: ['不存在移除技能', '灯语·短讯'],
    开场白模式: '自动生成',
    开场白模式已改: true,
    开场提示: '',
    手写开场白: '',
  };
  const tolDraft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  const impStale = tolDraft.importPreset(stalePreset);
  assert.equal(impStale.ok, true);
  assert.ok(impStale.ignored.length >= 10, `应记录全部失效项，实际 ${impStale.ignored.length}`);
  assert.equal(tolDraft.snapshot().自建表单.档案.姓名, '幸存者', '合法档案应完整恢复');
  assert.deepEqual(tolDraft.snapshot().自建表单.初始能力, {技艺: {灯语: '匠人'}});
  assert.deepEqual(tolDraft.snapshot().自建表单.初始装备, [{装备ID: '灯具·风暴灯', 状态: '完好', 位置: '手提'}]);
  assert.deepEqual(tolDraft.snapshot().自建表单.自定义装备, [{名称: '合法护符', 说明: '海边拾得。', 状态: '完好', 位置: '颈间'}]);
  assert.deepEqual(tolDraft.snapshot().自建表单.自定义技能, [{名称: '辨星', 说明: '夜间凭星象定位。'}]);
  assert.deepEqual(tolDraft.snapshot().自建表单.额外技能, ['修船·补帆']);
  assert.deepEqual(tolDraft.snapshot().自建表单.移除技能, ['灯语·短讯']);

  // 4) 非法预设输入不破坏当前草稿
  const beforeInvalid = tolDraft.exportPreset();
  for (const bad of [null, undefined, 'bad', [1, 2], {格式: 2}, {}]) {
    const res = tolDraft.importPreset(bad);
    assert.equal(res.ok, false);
    assert.deepEqual(res.ignored, []);
    assert.ok(res.error);
    assert.deepEqual(tolDraft.exportPreset(), beforeInvalid, '非法输入不得破坏当前草稿');
  }

  // 5) resetDefaults() 一键恢复初始默认
  tolDraft.resetDefaults();
  assert.equal(tolDraft.isDirty(), false);
  assert.equal(tolDraft.snapshot().自建表单.档案.姓名, undefined);
  assert.equal(tolDraft.snapshot().时间, '潮历071年04月01日');
});

test('YG-OPEN-04-A3：createOpeningStorage 按卡ID隔离、排序覆盖删除、并发队列安全与降级保护', async t => {
  const {getStore, getWriteCount} = mockGlobalVars(t, {[SETTINGS_KEY]: {方式: '同一模型', 调试: false}}, {delayMs: 10});

  const storeA = createOpeningStorage('card-A');
  const storeB = createOpeningStorage('card-B');

  // 空名与原型污染键拒绝
  assert.equal((await storeA.savePreset('', {格式: 1})).ok, false);
  assert.equal((await storeA.savePreset('   ', {格式: 1})).ok, false);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await storeA.savePreset(key, {格式: 1})).ok, false);
    assert.equal((await storeA.deletePreset(key)).ok, false);
  }

  // 并发写入 saveSettings 与 savePreset / saveDraft 绝不互相覆盖
  const [r1, r2, r3] = await Promise.all([
    saveSettings({调试: true, 尝试次数: 3}),
    storeA.savePreset('预设甲', {格式: 1, 时间: '潮历071年'}),
    storeB.saveDraft({格式: 1, 时间: '潮历072年'}),
  ]);
  assert.equal(r1, undefined);
  assert.equal(r2.ok, true);
  assert.equal(r2.覆盖, false);
  assert.equal(r3.ok, true);
  assert.equal(getStore()[SETTINGS_KEY].调试, true, '世界树·记账不得被并发预设写入覆盖');
  assert.equal(getStore()[SETTINGS_KEY].尝试次数, 3);
  assert.ok(getStore()[OPENING_PRESETS_KEY]['card-A'].预设['预设甲']);
  assert.equal(getStore()[OPENING_PRESETS_KEY]['card-B'].草稿.数据.时间, '潮历072年');

  // 严格按卡ID隔离
  assert.equal(storeA.listPresets().length, 1);
  assert.equal(storeB.listPresets().length, 0);
  assert.equal(storeA.loadDraft(), null);
  assert.equal(storeB.loadDraft().时间, '潮历072年');

  // 同名覆盖与降序排序
  await new Promise(resolve => setTimeout(resolve, 5));
  const saved2 = await storeA.savePreset('预设乙', {格式: 1, 时间: '潮历073年'});
  assert.equal(saved2.ok, true);
  assert.deepEqual(storeA.listPresets().map(item => item.名称), ['预设乙', '预设甲']);

  await new Promise(resolve => setTimeout(resolve, 5));
  const overwrite = await storeA.savePreset('预设甲', {格式: 1, 时间: '潮历075年'});
  assert.equal(overwrite.ok, true);
  assert.equal(overwrite.覆盖, true);
  assert.deepEqual(storeA.listPresets().map(item => item.名称), ['预设甲', '预设乙']);
  assert.equal(storeA.listPresets()[0].数据.时间, '潮历075年');

  // 删除预设与清空草稿（重复清空 null 不多余写全局变量）
  assert.equal((await storeA.deletePreset('预设甲')).ok, true);
  assert.deepEqual(storeA.listPresets().map(item => item.名称), ['预设乙']);
  assert.equal((await storeB.saveDraft(null)).ok, true);
  assert.equal(storeB.loadDraft(), null);
  const writesAfterClear = getWriteCount();
  const clearAgain = await storeB.saveDraft(null);
  assert.equal(clearAgain.ok, true);
  assert.equal(getWriteCount(), writesAfterClear, '草稿已为空时清空不得触发多余全局变量写入');

  // 宿主缺失全局变量 API 时安全降级不抛异常
  delete globalThis.getVariables;
  delete globalThis.replaceVariables;
  assert.deepEqual(storeA.listPresets(), []);
  assert.equal(storeA.loadDraft(), null);
  assert.equal((await storeA.savePreset('测试', {格式: 1})).ok, false);
  assert.equal((await storeA.saveDraft({格式: 1})).ok, false);
});

test('YG-OPEN-04-A4：UI 工具条保存/载入/删除/恢复默认与开局流程取消暂存/提交清草稿', async t => {
  const {find} = makeDomMock(t);
  mockGlobalVars(t, {});
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const storage = createOpeningStorage('card-ui-test');

  // 1) openingNode 工具条交互
  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  const root = openingNode(draft, {storage});
  draft.setProfileField('姓名', '陈墨');
  // 留空名称保存 -> 自动采用自建姓名「陈墨」
  let bar = find(root, item => item.classes.includes('ygg-preset-bar'));
  await find(bar, item => item.tag === '<button>' && item.value === '保存当前设定').handlers.click();
  assert.match(root.text(), /已保存设定「陈墨」/);
  assert.deepEqual(storage.listPresets().map(p => p.名称), ['陈墨']);

  // 修改后点击「恢复默认」并一并清空草稿
  await storage.saveDraft(draft.exportPreset());
  bar = find(root, item => item.classes.includes('ygg-preset-bar'));
  await find(bar, item => item.tag === '<button>' && item.value === '恢复默认').handlers.click();
  assert.match(root.text(), /已恢复初始默认设定/);
  assert.equal(draft.snapshot().自建表单.档案.姓名, undefined);
  assert.equal(storage.loadDraft(), null);

  // 点击「载入」恢复「陈墨」
  bar = find(root, item => item.classes.includes('ygg-preset-bar'));
  find(bar, item => item.tag === '<button>' && item.value === '载入').handlers.click();
  assert.match(root.text(), /已载入设定「陈墨」/);
  assert.equal(draft.snapshot().自建表单.档案.姓名, '陈墨');

  // 点击「删除」删除「陈墨」
  bar = find(root, item => item.classes.includes('ygg-preset-bar'));
  await find(bar, item => item.tag === '<button>' && item.value === '删除').handlers.click();
  assert.match(root.text(), /已删除设定「陈墨」/);
  assert.equal(storage.listPresets().length, 0);

  // 2) createOpeningFlow 取消自动暂存与提交清理草稿
  const savedST = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
  const savedToastr = Object.getOwnPropertyDescriptor(globalThis, 'toastr');
  const savedUninject = Object.getOwnPropertyDescriptor(globalThis, 'uninjectPrompts');
  t.after(() => {
    if (savedST) Object.defineProperty(globalThis, 'SillyTavern', savedST); else delete globalThis.SillyTavern;
    if (savedToastr) Object.defineProperty(globalThis, 'toastr', savedToastr); else delete globalThis.toastr;
    if (savedUninject) Object.defineProperty(globalThis, 'uninjectPrompts', savedUninject); else delete globalThis.uninjectPrompts;
  });

  let nextPopupAction = null;
  const openedNodes = [];
  globalThis.SillyTavern = {POPUP_TYPE: {TEXT: 1}, POPUP_RESULT: {AFFIRMATIVE: 1}};
  globalThis.toastr = {info: () => {}, success: () => {}, warning: () => {}, error: () => {}};
  globalThis.uninjectPrompts = () => {};

  const chat = [{message_id: 0, role: 'assistant', message: '封面正文。', swipe_id: 0, data: {}}];
  let storeWrites = 0;
  const session = {openingPending: true, openingOpen: false, integrity: null, upgrade: null, openingClosingForChat: false};
  const flow = createOpeningFlow({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
    openingSpec: {openingGreeting: '预设开场白。', commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}]},
    openingStorage: storage,
    messages: () => chat,
    chatId: () => 'chat-open-04',
    ownershipOf: msg => ({楼号: msg.message_id ?? 0, 角色: msg.role ?? 'assistant', swipe: 0, 正文指纹: msg.message}),
    recordOf: msg => msg.data?.世界树,
    validateRecord: () => ({ok: true}),
    manifest: {卡ID: 'card-ui-test'},
    store: async (id, rec) => { chat[id].data.世界树 = rec; storeWrites += 1; return true; },
    taskFor: () => ({任务ID: '1'}),
    enqueue: fn => fn(),
    refresh: () => true,
    audit: () => ({ok: true}),
    session,
    status: {pendingOpening: () => {}, renderFloors: () => {}, blocked: () => {}},
    nodeOf: (d, opts) => {
      const node = openingNode(d, opts);
      openedNodes.push({draft: d, node});
      return node;
    },
    popup: async (node, opts) => {
      const result = await nextPopupAction(openedNodes.at(-1));
      await opts.onClosing({result});
      opts.onClose?.();
    },
  });

  // 未修改直接点取消：不写草稿、不写聊天变量
  nextPopupAction = async () => null;
  await flow.open();
  assert.equal(storage.loadDraft(), null, '未修改直接取消不得写入草稿');
  assert.equal(storeWrites, 0);

  // 修改并保存命名预设后点取消：写入草稿、零聊天变量写入
  nextPopupAction = async ({draft: d}) => {
    d.setProfileField('姓名', '暂存主角');
    await storage.savePreset('命名保留档', d.exportPreset());
    return null;
  };
  await flow.open();
  assert.equal(storage.loadDraft()?.自建档案?.姓名, '暂存主角');
  assert.equal(storeWrites, 0, '取消开局零聊天变量写入');

  // 重开自动恢复草稿 -> 提交成功后清空未提交草稿、保留命名预设
  nextPopupAction = async ({draft: d, node}) => {
    assert.match(node.text(), /已自动恢复上次未提交的开局草稿/);
    assert.equal(d.snapshot().自建表单.档案.姓名, '暂存主角');
    return 1;
  };
  await flow.open();
  assert.equal(storeWrites, 1);
  assert.equal(storage.loadDraft(), null, '提交成功后必须清除未提交草稿');
  assert.deepEqual(storage.listPresets().map(p => p.名称), ['命名保留档'], '命名预设必须继续保留');
});

test('YG-OPEN-04-A5：动态第 0 楼渲染重记与修补按钮及顶部重记生效，静态开场命令第 0 楼不开放', async t => {
  const {find} = makeDomMock(t);
  const floors = new Map();
  const savedRetrieve = Object.getOwnPropertyDescriptor(globalThis, 'retrieveDisplayedMessage');
  const savedEventOn = Object.getOwnPropertyDescriptor(globalThis, 'eventOn');
  const savedBtnEvent = Object.getOwnPropertyDescriptor(globalThis, 'getButtonEvent');
  const savedTavernEvents = Object.getOwnPropertyDescriptor(globalThis, 'tavern_events');
  const savedToastr = Object.getOwnPropertyDescriptor(globalThis, 'toastr');
  t.after(() => {
    if (savedRetrieve) Object.defineProperty(globalThis, 'retrieveDisplayedMessage', savedRetrieve); else delete globalThis.retrieveDisplayedMessage;
    if (savedEventOn) Object.defineProperty(globalThis, 'eventOn', savedEventOn); else delete globalThis.eventOn;
    if (savedBtnEvent) Object.defineProperty(globalThis, 'getButtonEvent', savedBtnEvent); else delete globalThis.getButtonEvent;
    if (savedTavernEvents) Object.defineProperty(globalThis, 'tavern_events', savedTavernEvents); else delete globalThis.tavern_events;
    if (savedToastr) Object.defineProperty(globalThis, 'toastr', savedToastr); else delete globalThis.toastr;
  });

  globalThis.retrieveDisplayedMessage = id => ({length: 1, after: node => floors.set(id, node)});
  const warnings = [];
  globalThis.toastr = {warning: msg => warnings.push(msg), info: () => {}, success: () => {}, error: () => {}};

  const makeMsg = mode => ({
    message_id: 0, role: 'assistant', message: '开场白。', swipe_id: 0,
    data: {世界树: {本局: {世界: {当前时间: '潮历071年04月01日'}, 开局: {}}, 记账: {方式: mode, 应答格式: '提示词', 状态: '成功', 尝试次数: 1}}},
  });

  for (const [mode, expected] of [['开场生成', true], ['开场手写', true], ['开场命令', false]]) {
    floors.clear();
    let list = [makeMsg(mode)];
    const view = createStatusView({
      session: {permission: null, openingPending: false, upgrade: null, integrity: null, keepingFloor: null},
      injectId: 'ctx',
      messages: () => list,
      chatId: () => 'c1',
      recordOf: msg => msg.data?.世界树,
      checkRecord: () => true,
      floorOf: () => ({摘要: '开场摘要', 详情: [], 失败: false, 调试: ''}),
      keeperSettings: () => ({每楼记录: true, 调试: false, 方式: '同一模型'}),
      openOpening: () => {},
      rekeepFor: id => () => id,
      repairFor: id => () => id,
      runUpgrade: () => {},
    });
    view.renderFloors();
    const floor0 = floors.get(0);
    assert.ok(floor0, `${mode} 应渲染第 0 楼卡片`);
    assert.equal(Boolean(find(floor0, n => n.tag === '<button>' && n.value === '重新记账')), expected, `${mode} 重新记账按钮边界`);
    assert.equal(Boolean(find(floor0, n => n.tag === '<button>' && n.value === '修补')), expected, `${mode} 修补按钮边界`);
  }

  // 顶部「世界树：重新记账」按钮边界
  const listeners = new Map();
  globalThis.eventOn = (type, fn) => listeners.set(type, fn);
  globalThis.getButtonEvent = name => `btn:${name}`;
  globalThis.tavern_events = {
    GENERATION_AFTER_COMMANDS: 'g', MESSAGE_SENT: 'ms', MESSAGE_RECEIVED: 'mr',
    MESSAGE_EDITED: 'me', MESSAGE_SWIPED: 'msw', MESSAGE_DELETED: 'md', CHAT_CHANGED: 'cc',
  };

  let currentList = [];
  const rekept = [];
  registerAdapterEvents({
    INJECT_ID: 'ctx', manifest: {}, bundle: {}, protocol: {}, view: {}, history: {},
    session: {openingPending: false, integrity: null, upgrade: null},
    messages: () => currentList,
    invalidateTasks: () => {},
    enqueue: fn => fn(),
    checkPermission: () => true,
    isGeneratingOrEmptyTail: () => null,
    stopHostGeneration: () => {},
    isKeeping: () => false,
    bookkeeping: () => true,
    debugging: () => false,
    refresh: () => true,
    refreshOpening0: () => true,
    isDynamicOpening,
    replayFrom: async () => true,
    rekeepFloor: async (_list, id) => { rekept.push(id); },
    openRepair: async () => {},
    init: async () => {},
    checkCompatRecord: () => ({ok: true}),
    openingFlow: {open: () => {}},
    status: {renderFloors: () => {}},
    recordOf: msg => msg.data?.世界树,
    emptyTailAssistant: () => null,
    callKeeper: async () => '',
    parseJson: () => ({}),
    showSettings: async () => {},
    stringifyYaml: () => '',
    seal: () => ({}),
    ownershipOf: () => ({}),
  });

  const topRekeep = listeners.get('btn:世界树：重新记账');
  currentList = [makeMsg('开场命令')];
  await topRekeep();
  assert.deepEqual(rekept, [], '静态开场命令第 0 楼不得被顶部重记按钮触发');
  assert.ok(warnings.some(msg => msg.includes('没有可以记账的楼')));

  currentList = [makeMsg('开场生成')];
  await topRekeep();
  assert.deepEqual(rekept, [0], '动态开场生成第 0 楼应被顶部重记按钮触发');

  currentList = [makeMsg('开场手写')];
  await topRekeep();
  assert.deepEqual(rekept, [0, 0], '动态开场手写第 0 楼应被顶部重记按钮触发');
});
