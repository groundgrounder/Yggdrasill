import {test, assert, fs, path, fixture, edit, write} from './helpers.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {applyCommands} from '../core/commands.mjs';
import {createBookkeeper, buildKeepRecord, runKeeperLoop} from '../adapter/bookkeeper.mjs';
import {createOpeningDraft, createOpeningFlow} from '../adapter/opening.mjs';
import {openingNode} from '../adapter/ui.mjs';
import {
  RECORD_FORMAT, createHistoryAudit, ownershipOf, storedManifest, validateRecord,
} from '../adapter/records.mjs';
import {createView} from '../adapter/view.mjs';
import {packCard} from '../adapter/pack.mjs';

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
    });
  };
  globalThis.$ = tag => makeNode(tag);
  return {
    find: (root, pred) => pred(root) ? root : root.children.map(c => {
      const stack = [c];
      while (stack.length) {
        const cur = stack.shift();
        if (pred(cur)) return cur;
        if (cur.children) stack.push(...cur.children);
      }
      return null;
    }).find(Boolean),
  };
}

// 在雾港临时副本上构建双世界线（正史默认 + 异闻）与多方案/地点/分支门槛夹具。
async function multiWorldlineProject(t) {
  const root = await fixture(t);
  await write(root, '历史/世界线/正史.yaml', {
    概述: '北湾风浪如常，灯塔照旧巡守。',
    默认: true,
    角色组: {周岚: {启用: true}},
  });
  await write(root, '历史/世界线/异闻.yaml', {
    概述: '大雾之后北湾暗潮涌动，灯塔另起新规。',
    默认: false,
    角色组: {周岚: {启用: true}, 白棠: {启用: false}},
  });
  await edit(root, '历史/开局方案/码头少年.yaml', plan => {
    plan.世界线 = '正史';
    plan.开局地点 = '码头区';
  });
  await edit(root, '历史/开局方案/补考之年.yaml', plan => {
    plan.世界线 = '正史';
  });
  await write(root, '历史/开局方案/异闻雾夜.yaml', {
    世界线: '异闻',
    概述: '异闻世界线下从灯塔启程。',
    开局时间: '潮历073年',
    开局地点: '灯塔',
    角色组: {白棠: {启用: true}},
  });
  // 新增异闻专属事件（含分支门槛测试与秦守位移测试）。
  await write(root, '历史/事件/异闻暗灯/事件.txt', {
    事件ID: '异闻暗灯',
    事件标题: '暗灯初燃',
    事件概要: '异闻世界线中北湾暗灯在雾夜之后亮起。',
    主类型: '个人',
    标签: ['航行'],
    事件结果: ['知识变化'],
    触发时间: {最早: '潮历071年03月01日', 最晚: '潮历071年03月01日'},
    地点: ['码头区'],
    确认策略: '自动确认',
    核心参与者: ['秦守'],
    门槛: {世界线: {世界线ID: '异闻'}},
    默认分支: '暗灯初燃',
    分支: [
      {
        分支ID: '暗灯初燃',
        分支条件: '异闻世界线下的灯塔燃起暗灯。',
        分支结果: '秦守改驻码头区。',
        变化: [
          {路径: '角色.秦守.知识', 操作: '新增', 值: '暗灯已在雾夜之后重燃'},
          {路径: '角色.秦守.所在', 操作: '设定', 值: '码头区'},
        ],
      },
      {
        分支ID: '联手护灯',
        门槛: {角色启用: {角色组ID: '白棠'}},
        分支条件: '白棠启用时联手护灯。',
        分支结果: '二人联手护灯。',
        变化: [
          {路径: '角色.秦守.知识', 操作: '新增', 值: '白棠协助守灯'},
        ],
      },
    ],
  });
  await edit(root, '历史/开局选项.yaml', opt => {
    opt.自由组合 = true;
    // 省略 问题 以测试事件标题回退。
    opt.选项.push({
      事件ID: '异闻暗灯',
      选项: {暗灯初燃: '暗灯初燃', 联手护灯: '联手护灯'},
    });
  });
  return root;
}

test('YG-OPEN-02-A2：多世界线打包、重放审计、A/B/C 兼容试重放与面板世界线展示', async t => {
  const wbDir = await multiWorldlineProject(t);
  const projectDir = path.dirname(wbDir);
  const faceFile = path.join(projectDir, '卡面.yaml');
  await fs.writeFile(faceFile, [
    '卡ID: test.multi.worldline',
    '卡版本: 0.1.0',
    '名称: 双线测试卡',
    '描述: 多世界线适配验证卡。',
    '开场白: 北湾海风拂过灯塔。',
    '开局:',
    '  世界线: 正史',
    '  开局时间: 潮历071年04月01日',
    '  方案: 码头少年',
    '开场命令:',
    '  - 写场景: {当前地点: {地标: 灯塔, 场景: 值守室}}',
    '按方案:',
    '  异闻雾夜:',
    '    开场白: 异闻雾夜下的灯塔。',
    '    开场命令:',
    '      - 写场景: {当前地点: {地标: 灯塔, 场景: 暗灯台}}',
  ].join('\n'));

  // 1) packCard prepareOnly 在 face.开局.世界线=正史 而方案 异闻雾夜 属于 异闻 时应正常通过不冲突
  const out = {write() {}};
  const packed = await packCard({
    projectDir,
    faceFile,
    prepareOnly: true,
    adapterDir: projectDir,
    stdout: out,
    stderr: out,
  });
  assert.equal(packed.prepareOnly, true);

  // 2) records.mjs 常规审计与前缀缓存 + upgrade.mjs A/B 试重放均正确透传 opening.世界线
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const manifest = {
    卡ID: 'test.multi.worldline', 卡版本: '0.1.0', 程序版本: '0.1.0', 记录格式: RECORD_FORMAT,
    程序指纹: '1'.repeat(64), 世界书哈希: 'a'.repeat(64), 兼容程序: [],
  };
  const sealedAlt = protocol.seal({世界线: '异闻', 开局时间: '潮历073年'});
  assert.equal(sealedAlt.开局.世界线, '异闻');
  assert.equal(sealedAlt.事件.异闻暗灯?.状态, 1);

  const cmd0 = [{写场景: {当前地点: {地标: '灯塔', 场景: '暗灯台'}}}];
  const run0 = applyCommands(protocol, sealedAlt, cmd0);
  assert.deepEqual(run0.失败, []);
  const m0 = {message_id: 0, role: 'assistant', message: '异闻开场。', swipe_id: 0};
  m0.data = {
    世界树: {
      记录格式: RECORD_FORMAT,
      运行清单: storedManifest(manifest),
      归属: ownershipOf(m0),
      本局: run0.state,
      命令: cmd0,
      失败: [],
      已写入: run0.已写入,
      记账: {方式: '开场生成', 应答格式: '提示词', 状态: '成功', 尝试次数: 1},
    },
  };

  const history = createHistoryAudit({protocol, manifest});
  const audited = history.audit([m0]);
  assert.equal(audited.ok, true, '多世界线异闻第 0 楼常规审计应通过');
  assert.equal(history.audit([m0]).ok, true, '前缀缓存二次审计应通过');
  assert.equal(history.cacheStats().hits, 1);

  // 世界书哈希变化时走 assessWorldbookCompat（upgrade.mjs），应判 A 级无缝兼容
  const upgradedManifest = {...manifest, 世界书哈希: 'b'.repeat(64)};
  const compatHistory = createHistoryAudit({protocol, manifest: upgradedManifest});
  const compatRes = compatHistory.audit([m0]);
  assert.equal(compatRes.ok, true, '多世界线异闻走 upgrade.mjs 试重放应透传世界线并判 A 级');
  assert.equal(compatRes.worldbook?.级别, 'A');

  // 3) view.mjs 玩家面板与调试面板：多世界线显示「世界线」，单世界线不显示
  const keeper = createBookkeeper({protocol, catalog, decl});
  const multiView = createView({protocol, catalog, decl, keeper});
  const playerSections = multiView.player(run0.state);
  assert.deepEqual(playerSections[0].项[0], ['世界线', '异闻']);
  const debugSections = multiView.debug(run0.state, []);
  assert.deepEqual(debugSections[0].项[0], ['世界线', '异闻']);

  const singleWb = await fixture(t);
  const singleCompiled = await compileWorldbook(singleWb, {fs, path});
  const singleProtocol = createProtocol({catalog: singleCompiled.catalog, decl: singleCompiled.decl});
  const singleView = createView({
    protocol: singleProtocol, catalog: singleCompiled.catalog, decl: singleCompiled.decl,
    keeper: createBookkeeper({protocol: singleProtocol, catalog: singleCompiled.catalog, decl: singleCompiled.decl}),
  });
  const singleState = singleProtocol.seal({开局时间: '潮历071年04月01日'});
  assert.ok(!singleView.player(singleState)[0].项.some(([k]) => k === '世界线'), '单世界线卡不显示世界线行');
});

test('YG-OPEN-02-A3：历史选择真过滤、时间升序、门槛筛选、失效覆盖清理与省略问题回退', async t => {
  const wbDir = await multiWorldlineProject(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {世界线: '异闻', 开局时间: '潮历074年'},
  });

  // 异闻 074 年：拜师(070)、异闻暗灯(072-02-01)、出师考核(072-09-01) 按最晚时间升序排列
  let snap = draft.snapshot();
  const ids = snap.历史.map(item => item.事件ID);
  assert.ok(ids.includes('拜师') && ids.includes('异闻暗灯') && ids.includes('出师考核'));
  assert.ok(ids.indexOf('拜师') < ids.indexOf('异闻暗灯'));
  assert.ok(ids.indexOf('异闻暗灯') < ids.indexOf('出师考核'));

  // 省略 问题 回退事件标题「暗灯初燃」
  const lamp = snap.历史.find(item => item.事件ID === '异闻暗灯');
  assert.equal(lamp.问题, '暗灯初燃');
  // 异闻默认 白棠 停用，因此分支门槛要求 白棠启用 的「联手护灯」被隐藏
  assert.ok(lamp.分支.some(b => b.id === '暗灯初燃'));
  assert.ok(!lamp.分支.some(b => b.id === '联手护灯'), '分支门槛不成立时应隐藏该分支');
  // 启用白棠后，「联手护灯」出现
  assert.equal(draft.setGroup('白棠', {启用: true}).ok, true);
  assert.ok(draft.snapshot().历史.find(item => item.事件ID === '异闻暗灯').分支.some(b => b.id === '联手护灯'));

  // 设一条较晚的历史覆盖，然后调早开局时间到 潮历071年：未来事件隐藏且失效覆盖自动清理，封卷不报错
  assert.equal(draft.setHistory('异闻暗灯', '暗灯初燃').ok, true);
  assert.equal(draft.setHistory('出师考核', '未发生').ok, true);
  const early = draft.setTime('潮历071年');
  assert.equal(early.ok, true, '调早时间后失效历史覆盖自动清理，封卷不应报错');
  snap = draft.snapshot();
  assert.ok(!snap.历史.some(item => item.事件ID === '异闻暗灯'), '晚于开局时间的事件应隐藏');
  assert.ok(!snap.历史.some(item => item.事件ID === '出师考核'), '晚于开局时间的事件应隐藏');
  assert.equal(snap.预览.开局.历史选择.异闻暗灯, undefined);
  assert.equal(snap.预览.开局.历史选择.出师考核, undefined);

  // 切回 074 年再选 异闻暗灯，切世界线到 正史：异闻专属事件隐藏且失效覆盖自动清理
  assert.equal(draft.setTime('潮历074年').ok, true);
  assert.equal(draft.setHistory('异闻暗灯', '暗灯初燃').ok, true);
  const switched = draft.setWorldline('正史');
  assert.equal(switched.ok, true, '切世界线后不成立的世界线专属历史覆盖应自动清理');
  assert.ok(!draft.snapshot().历史.some(item => item.事件ID === '异闻暗灯'), '正史下异闻专属事件门槛不成立应隐藏');
});

test('YG-OPEN-02-A4：世界线 → 预设开局 → 时间与地点联动（含扮演所在推算与改选）', async t => {
  const wbDir = await multiWorldlineProject(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {方案: '码头少年'},
    openingSpec: {openingGreeting: '主开场白。', commands: [], planOpenings: {码头少年: {开场白: '码头开场白。'}}},
  });
  let snap = draft.snapshot();
  assert.equal(snap.世界线, '正史');
  assert.equal(snap.方案, '码头少年');
  assert.deepEqual(snap.计划.map(p => p.id).sort(), ['码头少年', '补考之年'].sort());
  assert.equal(snap.地点, '码头区', '方案声明开局地点时默认取方案开局地点');

  // 非法世界线与非法地点报错
  assert.equal(draft.setWorldline('不存在').error.code, '开局.世界线');
  assert.equal(draft.setLocation('不存在地点').error.code, '开局.地点');

  // 切世界线到 异闻：原正史方案自动切为 null，计划只列 异闻雾夜，模式切为自动生成
  assert.equal(draft.setWorldline('异闻').ok, true);
  snap = draft.snapshot();
  assert.equal(snap.方案, null);
  assert.deepEqual(snap.计划.map(p => p.id), ['异闻雾夜']);
  assert.equal(snap.开场白模式, '自动生成');

  // 手动改时间再切到方案 异闻雾夜：清除旧手改时间，方案的 潮历073年 与 开局地点=灯塔 生效
  assert.equal(draft.setTime('潮历071年').ok, true);
  assert.equal(draft.setPlan('异闻雾夜').ok, true);
  snap = draft.snapshot();
  assert.equal(snap.时间, '潮历073年');
  assert.equal(snap.地点, '灯塔');

  // 切回无预设（无 defaults.开局时间 时保留 潮历073年 不报错）
  assert.equal(draft.setPlan('').ok, true);
  assert.equal(draft.snapshot().时间, '潮历073年');

  // 扮演秦守：异闻 073 年 异闻暗灯 已将秦守 所在 改为 码头区，默认地点应推算为 码头区，并支持手动 setLocation 改选
  assert.equal(draft.setPlayerMode('扮演').ok, true);
  assert.equal(draft.setPlayerGroup('秦守').ok, true);
  assert.equal(draft.snapshot().默认地点, '码头区', '扮演模式应从封卷后状态读取经历史事件改写的所在');
  assert.equal(draft.snapshot().地点, '码头区');
  assert.equal(draft.setLocation('灯塔').ok, true);
  assert.equal(draft.snapshot().地点, '灯塔', '扮演模式允许手动改选合法地点');
});

test('YG-OPEN-02-A5：自建玩家结构化表单联动内核与开局前端顺序校验', async t => {
  const {find} = makeDomMock(t);
  const wbDir = await multiWorldlineProject(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {世界线: '正史', 开局时间: '潮历072年'},
  });

  // 结构化编辑自建档案、初始能力、初始装备
  assert.equal(draft.setProfileField('姓名', '海风').ok, true);
  assert.equal(draft.setProfileField('出生年', '潮历052年').ok, true);
  assert.equal(draft.setProfileField('稳定体貌.发色发型', '黑发短发').ok, true);
  assert.equal(draft.setProfileField('稳定体貌.特征', ['左眉细疤']).ok, true);
  assert.equal(draft.setInitialAbility('技艺', {灯语: '熟手'}).ok, true);
  assert.equal(draft.setInitialAbility('名望', '熟手').ok, true);
  assert.equal(draft.setInitialAbility('天赋', ['雾中视·辨影']).ok, true);
  assert.equal(draft.setInitialEquipment([{装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰间'}]).ok, true);

  let snap = draft.snapshot();
  assert.match(snap.档案文本, /姓名: 海风/);
  assert.equal(snap.预览.角色.玩家.名望, '熟手');
  assert.deepEqual(snap.预览.角色.玩家.技艺, {灯语: '熟手'});
  assert.deepEqual(snap.预览.角色.玩家.装备, {'工具·铜扳手': {状态: '完好', 位置: '腰间'}});
  assert.ok(snap.自建表单.可用技能.includes('灯语·短讯'));
  assert.ok(snap.自建表单.可用技能.includes('雾中视·辨影'));

  // 清空字段/能力/装备自动删键不触发协议空值报错
  assert.equal(draft.setProfileField('稳定体貌.发色发型', '').ok, true);
  assert.equal(draft.setProfileField('稳定体貌.特征', []).ok, true);
  assert.equal(draft.snapshot().自建表单.档案.稳定体貌, undefined);
  assert.equal(draft.setInitialAbility('技艺', {}).ok, true);
  assert.equal(draft.setInitialAbility('名望', '').ok, true);
  assert.equal(draft.setInitialAbility('天赋', []).ok, true);
  assert.equal(draft.setInitialEquipment([]).ok, true);
  assert.equal(draft.snapshot().玩家.初始能力, undefined);
  assert.equal(draft.snapshot().玩家.初始装备, undefined);

  // UI 顺序校验（多世界线卡）：世界线 → 预设开局 → 开局时间与地点 → 玩家 → 开场白 → 高级选项（默认折叠）
  const multiNode = openingNode(draft);
  const topDetails = multiNode.children.filter(c => c.tag === '<details>');
  const titles = topDetails.map(d => d.children[0]?.text() ?? '');
  assert.deepEqual(titles, [
    '世界线',
    '预设开局',
    '开局时间与地点',
    '玩家',
    '开场白',
    '高级选项（角色组与历史选择）',
  ]);
  const advanced = topDetails.at(-1);
  assert.equal(advanced.properties.open, false, '高级选项必须默认折叠');
  assert.ok(find(multiNode, n => n.tag === '<summary>' && n.text() === '高级：YAML 源码'), '自建玩家保留折叠 YAML 源码区');

  // 单世界线卡不显示「世界线」段落
  const singleWb = await fixture(t);
  const singleCompiled = await compileWorldbook(singleWb, {fs, path});
  const singleDraft = createOpeningDraft({
    protocol: createProtocol({catalog: singleCompiled.catalog, decl: singleCompiled.decl}),
    catalog: singleCompiled.catalog, decl: singleCompiled.decl,
    defaults: {开局时间: '潮历071年04月01日'},
  });
  const singleTitles = openingNode(singleDraft).children
    .filter(c => c.tag === '<details>')
    .map(d => d.children[0]?.text() ?? '');
  assert.deepEqual(singleTitles, [
    '预设开局',
    '开局时间与地点',
    '玩家',
    '开场白',
    '高级选项（角色组与历史选择）',
  ]);
});

test('YG-OPEN-02-A6：四模式开场白提交、失败回滚保封面、严格 audit 验真', async t => {
  const wbDir = await multiWorldlineProject(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});
  const manifest = {
    卡ID: 'test.dynamic.opening', 卡版本: '0.1.0', 程序版本: '0.1.0', 记录格式: RECORD_FORMAT,
    程序指纹: '1'.repeat(64), 世界书哈希: 'a'.repeat(64), 兼容程序: [],
  };
  const history = createHistoryAudit({protocol, manifest});

  const savedGlobals = ['getVariables', 'replaceVariables', 'toastr', 'SillyTavern'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  t.after(() => {
    for (const [k, d] of savedGlobals) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  });

  async function runDynamicMode({mode, hint = '', custom = '', genText = '雾色低垂，灯塔亮起。', genThrow = false, keepFail = false}) {
    const cover = '【封面】点击世界树：开局开始。';
    const chat = [{message_id: 0, role: 'assistant', message: cover, swipe_id: 0, data: {}}];
    let vars = {}, refreshed = false, lastGenArgs = null, writeCount = 0;
    globalThis.getVariables = () => structuredClone(vars);
    globalThis.replaceVariables = async next => { vars = structuredClone(next); chat[0].data = structuredClone(next); writeCount += 1; };
    globalThis.toastr = {success() {}, warning() {}, error() {}, info() {}};
    globalThis.SillyTavern = {POPUP_RESULT: {AFFIRMATIVE: 1}};

    const session = {openingPending: true, openingOpen: false, integrity: null, openingSelfEdit: null};
    const status = {pendingOpening() {}, blocked() {}, renderFloors() {}};
    let capturedDraft = null, closeResult = null;
    const flow = createOpeningFlow({
      protocol, catalog, decl,
      defaults: {世界线: '异闻', 开局时间: '潮历073年'},
      commands: [],
      openingSpec: {openingGreeting: '', commands: [], planOpenings: {}},
      updateOpeningMessage: async text => { chat[0].message = text; return true; },
      generateOpening: async args => {
        lastGenArgs = args;
        if (genThrow) throw new Error('模拟生成超时');
        return genText;
      },
      bookkeeping: () => true,
      bookkeepOpening: async (baseState, greeting) => {
        if (keepFail) return {本局: baseState, 命令: null, 失败: [{阶段: '记账', 错误码: '记账.调用', 说明: '模拟记账失败'}], 已写入: [], 记账: {方式: '同一模型', 应答格式: '提示词', 状态: '调用失败', 尝试次数: 1}};
        const loop = await runKeeperLoop({
          keeper, base: baseState, input: '', narration: greeting,
          config: {方式: '同一模型', 应答格式: '提示词'}, attempts: 1,
          call: async () => JSON.stringify({
            时间: {方式: '不变', 日期: '', 事件ID: ''},
            地点: {地标: '', 场景: ''},
            在场: ['秦守'],
            发生的事件: [],
            新情况: [],
          }),
        });
        return buildKeepRecord({base: baseState, loop, config: {方式: '同一模型', 应答格式: '提示词'}, debugging: false});
      },
      messages: () => structuredClone(chat),
      chatId: () => 'chat-open-02',
      ownershipOf,
      recordOf: m => m?.data?.世界树,
      validateRecord: (rec, msg, man) => validateRecord(rec, msg, man),
      manifest,
      store: async (id, rec) => {
        const stored = {
          记录格式: RECORD_FORMAT, 运行清单: storedManifest(manifest), 归属: ownershipOf(chat[id]),
          本局: rec.本局, 命令: rec.命令, 失败: rec.失败 ?? [], 已写入: rec.已写入 ?? [], 记账: rec.记账,
        };
        await globalThis.replaceVariables({世界树: stored});
        return true;
      },
      taskFor: () => ({任务ID: '1'}),
      enqueue: fn => fn(),
      refresh: () => { refreshed = true; },
      audit: list => history.audit(list),
      session,
      status,
      nodeOf: draft => {
        capturedDraft = draft;
        draft.setLocation('灯塔');
        draft.setGreetingMode(mode);
        if (hint) draft.setGreetingHint(hint);
        if (custom) draft.setCustomGreeting(custom);
        return {};
      },
      popup: async (_node, options) => {
        closeResult = await options.onClosing({result: 1});
      },
    });
    await flow.open();
    return {chat, cover, closeResult, refreshed, lastGenArgs, writeCount, draft: capturedDraft};
  }

  // 1) 自动生成成功并通过 history.audit 严格重放
  const auto = await runDynamicMode({mode: '自动生成'});
  assert.equal(auto.closeResult, true);
  assert.equal(auto.refreshed, true);
  assert.equal(auto.chat[0].message, '雾色低垂，灯塔亮起。');
  assert.equal(auto.chat[0].data.世界树.记账.方式, '开场生成');
  assert.equal(auto.chat[0].data.世界树.本局.世界.当前地点.地标, '灯塔');
  assert.equal(auto.chat[0].data.世界树.本局.角色.秦守.在场, true);
  assert.equal(history.audit(auto.chat).ok, true, '自动生成第 0 楼必须通过 history.audit 严格重放');

  // 2) 提示扩写携带玩家提示并通过 history.audit
  const hinted = await runDynamicMode({mode: '提示扩写', hint: '暴雨中独自擦拭油灯', genText: '暴雨敲打窗棂，油灯微晃。'});
  assert.equal(hinted.closeResult, true);
  assert.equal(hinted.lastGenArgs.hint, '暴雨中独自擦拭油灯');
  assert.equal(hinted.chat[0].data.世界树.记账.方式, '开场生成');
  assert.equal(history.audit(hinted.chat).ok, true);

  // 3) 玩家手写不调 generateOpening，记账方式为 开场手写 并通过 history.audit
  const manual = await runDynamicMode({mode: '手写', custom: '我推开灯塔铁门，海风迎面扑来。'});
  assert.equal(manual.closeResult, true);
  assert.equal(manual.lastGenArgs, null);
  assert.equal(manual.chat[0].message, '我推开灯塔铁门，海风迎面扑来。');
  assert.equal(manual.chat[0].data.世界树.记账.方式, '开场手写');
  assert.equal(history.audit(manual.chat).ok, true);

  // 4) 失败场景：生成报错 / 空正文 / 记账失败均不覆写封面、零变量写入、草稿保留
  for (const [label, opts] of [
    ['生成报错', {mode: '自动生成', genThrow: true}],
    ['空正文', {mode: '自动生成', genText: '   '}],
    ['记账失败', {mode: '手写', custom: '手写正文。', keepFail: true}],
  ]) {
    const failed = await runDynamicMode(opts);
    assert.equal(failed.closeResult, false, label);
    assert.equal(failed.chat[0].message, failed.cover, `${label}不得覆写第 0 楼封面`);
    assert.equal(failed.writeCount, 0, `${label}不得写入任何楼层变量`);
    assert.ok(failed.draft.snapshot().错误, `${label}应在草稿保留错误供重试`);
  }
});

// 年粒度同年先决、跨粒度隔离、同年互斥与切世界线夹具：在雾港临时副本上追加合成事件、选项与双世界线。
async function yearGranularityProject(t) {
  const root = await fixture(t);
  await write(root, '历史/世界线/正史.yaml', {概述: '北湾风浪如常，灯塔照旧巡守。', 默认: true});
  await write(root, '历史/世界线/异闻.yaml', {
    概述: '大雾之后北湾暗潮涌动，灯塔另起新规。', 默认: false, 角色组: {白棠: {启用: false}},
  });
  await edit(root, '设定/剧情标记.yaml', marks => { marks.雾灯 = ['常亮', '熄灭']; });
  const addEvent = (id, fields) => write(root, `历史/事件/${id}/事件.txt`, {
    事件ID: id,
    事件标题: id,
    事件概要: `${id}的合成回归事件。`,
    主类型: '个人',
    标签: ['修习'],
    事件结果: ['剧情条件变化'],
    触发时间: {最早: '潮历071年', 最晚: '潮历071年'},
    确认策略: '条件确认',
    核心参与者: [],
    ...fields,
  });
  await addEvent('年链A', {
    默认分支: '前行',
    分支: [
      {分支ID: '前行', 分支条件: '选择继续前行。', 分支结果: '链路开启。'},
      {分支ID: '止步', 分支条件: '选择止步。', 分支结果: '链路未开。'},
    ],
  });
  await addEvent('年链B', {
    门槛: {事件确认: {事件ID: '年链A', 分支ID: '前行'}},
    默认分支: '远行',
    分支: [
      {分支ID: '远行', 分支条件: '沿链路远行。', 分支结果: '继续向下游。'},
      {分支ID: '留守', 分支条件: '中途留守。', 分支结果: '不再向下游。'},
    ],
  });
  await addEvent('年链C', {
    门槛: {事件确认: {事件ID: '年链B', 分支ID: '远行'}},
    默认分支: '终局',
    分支: [{分支ID: '终局', 分支条件: '抵达终局。', 分支结果: '链路收束。'}],
  });
  await addEvent('跨粒先', {
    门槛: {剧情标记: {标记ID: '雾灯', 比较: '等于', 值: '常亮'}},
    默认分支: '长明',
    分支: [
      {分支ID: '长明', 分支条件: '雾灯仍常亮。', 分支结果: '先决成立。'},
      {分支ID: '暂灭', 分支条件: '雾灯短暂熄灭。', 分支结果: '先决不成立。'},
    ],
  });
  await addEvent('跨粒后', {
    触发时间: {最早: '潮历071年02月01日', 最晚: '潮历071年02月01日'},
    门槛: {事件确认: {事件ID: '跨粒先', 分支ID: '长明'}},
    默认分支: '记下',
    分支: [{分支ID: '记下', 分支条件: '年粒度先决成立。', 分支结果: '日粒度下游写入。'}],
  });
  await addEvent('跨粒影', {
    触发时间: {最早: '潮历071年03月01日', 最晚: '潮历071年03月01日'},
    默认分支: '遮灯',
    分支: [{分支ID: '遮灯', 分支条件: '同年较晚的日粒度事件。', 分支结果: '改写剧情标记。',
      变化: [{路径: '世界.剧情标记.雾灯', 操作: '设定', 值: '熄灭'}]}],
  });
  await addEvent('互斥M1', {
    门槛: {none: [{事件确认: {事件ID: '互斥M2'}}]},
    默认分支: '成',
    分支: [
      {分支ID: '成', 分支条件: '互斥M2未发生。', 分支结果: '互斥M1成立。'},
      {分支ID: '不成', 分支条件: '主动放弃。', 分支结果: '互斥M1未发生。'},
    ],
  });
  await addEvent('互斥M2', {
    门槛: {none: [{事件确认: {事件ID: '互斥M1'}}]},
    默认分支: '成',
    分支: [
      {分支ID: '成', 分支条件: '互斥M1未发生。', 分支结果: '互斥M2成立。'},
      {分支ID: '不成', 分支条件: '主动放弃。', 分支结果: '互斥M2未发生。'},
    ],
  });
  await addEvent('线年先', {
    默认分支: '立',
    分支: [
      {分支ID: '立', 分支条件: '同年先决成立。', 分支结果: '下游可成立。'},
      {分支ID: '止', 分支条件: '同年先决不成立。', 分支结果: '下游不成立。'},
    ],
  });
  await addEvent('线年后', {
    门槛: {事件确认: {事件ID: '线年先', 分支ID: '立'}},
    默认分支: '成',
    分支: [{分支ID: '成', 分支条件: '同年先决已立。', 分支结果: '下游成立。'}],
  });
  await addEvent('线异门', {
    门槛: {世界线: {世界线ID: '异闻'}},
    默认分支: '显',
    分支: [{分支ID: '显', 分支条件: '异闻世界线。', 分支结果: '仅异闻可见。'}],
  });
  await addEvent('线棠枝', {
    默认分支: '单人',
    分支: [
      {分支ID: '双人', 门槛: {角色启用: {角色组ID: '白棠'}}, 分支条件: '白棠启用。', 分支结果: '双人同行。'},
      {分支ID: '单人', 分支条件: '白棠未启用。', 分支结果: '独自前行。'},
    ],
  });
  await addEvent('线棠核', {
    核心参与者: ['白棠'],
    默认分支: '独行',
    分支: [{分支ID: '独行', 分支条件: '白棠在核心参与者中。', 分支结果: '事件成立。'}],
  });
  // v2 返工夹具：上游默认分支不是下游前置分支，用于验证清空上游退回默认分支时的下游清理。
  await addEvent('回退A', {
    默认分支: '守旧',
    分支: [
      {分支ID: '守旧', 分支条件: '维持旧例。', 分支结果: '下游前置不成立。'},
      {分支ID: '启程', 分支条件: '选择启程。', 分支结果: '下游前置成立。'},
    ],
  });
  await addEvent('回退B', {
    门槛: {事件确认: {事件ID: '回退A', 分支ID: '启程'}},
    默认分支: '同行',
    分支: [{分支ID: '同行', 分支条件: '上游已启程。', 分支结果: '结伴同行。'}],
  });
  // v2 返工夹具：下游事件 ID 的 codepoint 小于上游（果 < 源）；上游选中分支仅异闻有效，
  // 另有同年 灯灭 保留覆盖在切回正史后改写剧情标记，只有逐轮复扫才能清净下游残留。
  await addEvent('灯灭', {
    默认分支: '常亮',
    分支: [
      {分支ID: '常亮', 分支条件: '灯仍常亮。', 分支结果: '雾灯不变。'},
      {分支ID: '熄灭', 分支条件: '选择熄灯。', 分支结果: '雾灯熄灭。',
        变化: [{路径: '世界.剧情标记.雾灯', 操作: '设定', 值: '熄灭'}]},
    ],
  });
  await addEvent('线异源', {
    默认分支: '涌',
    分支: [
      {分支ID: '涌', 分支条件: '暗潮涌动。', 分支结果: '下游成立。'},
      {分支ID: '静', 门槛: {世界线: {世界线ID: '异闻'}}, 分支条件: '异闻世界线点灯。', 分支结果: '雾灯常亮。',
        变化: [{路径: '世界.剧情标记.雾灯', 操作: '设定', 值: '常亮'}]},
    ],
  });
  await addEvent('线异果', {
    门槛: {all: [
      {事件确认: {事件ID: '线异源'}},
      {剧情标记: {标记ID: '雾灯', 比较: '等于', 值: '常亮'}},
    ]},
    默认分支: '成',
    分支: [{分支ID: '成', 分支条件: '上游确认且雾灯常亮。', 分支结果: '果随源成。'}],
  });
  await edit(root, '历史/开局选项.yaml', option => {
    option.自由组合 = true;
    const entries = {
      年链A: {前行: '前行', 止步: '止步'},
      年链B: {远行: '远行', 留守: '留守'},
      年链C: {终局: '终局'},
      跨粒先: {长明: '长明', 暂灭: '暂灭'},
      跨粒后: {记下: '记下'},
      互斥M1: {成: '成', 不成: '不成'},
      互斥M2: {成: '成', 不成: '不成'},
      线年先: {立: '立', 止: '止'},
      线年后: {成: '成'},
      线异门: {显: '显'},
      线棠枝: {双人: '双人', 单人: '单人'},
      线棠核: {独行: '独行'},
      回退A: {守旧: '守旧', 启程: '启程'},
      回退B: {同行: '同行'},
      灯灭: {常亮: '常亮', 熄灭: '熄灭'},
      线异源: {涌: '涌', 静: '静'},
      线异果: {成: '成'},
    };
    for (const [事件ID, 选项] of Object.entries(entries)) option.选项.push({事件ID, 选项});
  });
  return root;
}

async function yearGranularityDraft(t, defaults = {}) {
  const wbDir = await yearGranularityProject(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const draft = createOpeningDraft({protocol, catalog, decl, defaults: {世界线: '正史', 开局时间: '潮历072年', ...defaults}});
  return {draft, protocol, catalog, decl};
}

test('YG-OPEN-03-A3-1：年粒度同年先决链 A→B→C 三点均进入历史选项', async t => {
  const {draft} = await yearGranularityDraft(t);
  const ids = draft.snapshot().历史.map(item => item.事件ID);
  assert.deepEqual(ids.filter(id => id.startsWith('年链')), ['年链A', '年链B', '年链C'],
    '同年先决链三点应按起点升序与 codepoint 顺序全部可见');
  assert.equal(draft.prepare().ok, true);
});

test('YG-OPEN-03-A3-2：同年上下游联动隐藏与失效下游覆盖自动清理', async t => {
  const {draft} = await yearGranularityDraft(t);
  const ids = () => draft.snapshot().历史.map(item => item.事件ID);
  assert.ok(ids().includes('年链B') && ids().includes('年链C'));

  assert.equal(draft.setHistory('年链A', '止步').ok, true);
  assert.ok(!ids().includes('年链B'), '上游改选非前置分支后下游应立即隐藏');
  assert.ok(!ids().includes('年链C'), '传递下游也应隐藏');
  assert.equal(draft.setHistory('年链A', '').ok, true);
  assert.ok(ids().includes('年链B') && ids().includes('年链C'), '撤销上游覆盖后下游恢复');
  assert.equal(draft.setHistory('年链A', '未发生').ok, true);
  assert.ok(!ids().includes('年链B') && !ids().includes('年链C'), '上游置为未发生后下游隐藏');
  assert.equal(draft.setHistory('年链A', '前行').ok, true);
  assert.equal(draft.setHistory('年链B', '远行').ok, true);
  assert.equal(draft.setHistory('年链C', '终局').ok, true);

  assert.equal(draft.setHistory('年链A', '止步').ok, true);
  const snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.年链B, undefined, '上游改选后失效的下游覆盖应自动清理');
  assert.equal(snapshot.预览.开局.历史选择.年链C, undefined, '传递下游的残留覆盖也应清理');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true, '清理后封卷应成功');
});

test('YG-OPEN-03-A3-3：跨粒度同年先决可见且同年较晚日粒度事件不反向泄漏', async t => {
  const {draft} = await yearGranularityDraft(t);
  let snapshot = draft.snapshot();
  let ids = snapshot.历史.map(item => item.事件ID);
  assert.ok(ids.includes('跨粒先'), '年粒度先决事件应可见（同年较晚的日粒度标记不得泄漏）');
  assert.ok(ids.includes('跨粒后'), '同年日粒度下游应读到年粒度先决事件');
  const prior = snapshot.历史.find(item => item.事件ID === '跨粒先');
  assert.ok(prior.分支.some(branch => branch.id === '长明'));

  // 显式选中年粒度先决后，日粒度下游保持可见并可封卷。
  assert.equal(draft.setHistory('跨粒先', '长明').ok, true);
  ids = draft.snapshot().历史.map(item => item.事件ID);
  assert.ok(ids.includes('跨粒后'));
  assert.equal(draft.prepare().ok, true);
});

test('YG-OPEN-03-A3-4：同年互斥事件默认同现、显式选择后互斥方隐藏', async t => {
  const {draft} = await yearGranularityDraft(t);
  let ids = draft.snapshot().历史.map(item => item.事件ID);
  assert.ok(ids.includes('互斥M1') && ids.includes('互斥M2'), '未选择时互斥双方都应展示');

  assert.equal(draft.setHistory('互斥M1', '成').ok, true);
  const snapshot = draft.snapshot();
  ids = snapshot.历史.map(item => item.事件ID);
  assert.ok(ids.includes('互斥M1'));
  assert.ok(!ids.includes('互斥M2'), '显式选中互斥M1后互斥M2应隐藏');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true);
});

test('YG-OPEN-03-A3-5：切世界线保留同年先决覆盖并清理门槛与角色组失效覆盖', async t => {
  const {draft} = await yearGranularityDraft(t);
  assert.equal(draft.setHistory('线年先', '立').ok, true);
  assert.equal(draft.setHistory('线年后', '成').ok, true);
  assert.equal(draft.setHistory('线棠枝', '双人').ok, true);
  assert.equal(draft.setHistory('线棠核', '独行').ok, true);

  const switched = draft.setWorldline('异闻');
  assert.equal(switched.ok, true);
  let snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.线年先, '立', '新世界线下同年先决合法覆盖不得误删');
  assert.equal(snapshot.预览.开局.历史选择.线年后, '成', '新世界线下同年下游合法覆盖不得误删');
  assert.equal(snapshot.预览.开局.历史选择.线棠枝, undefined, '新世界线关闭白棠后分支门槛失效的覆盖应清理');
  assert.equal(snapshot.预览.开局.历史选择.线棠核, undefined, '新世界线关闭白棠后核心参与者失效的覆盖应清理');
  let ids = snapshot.历史.map(item => item.事件ID);
  assert.ok(!ids.includes('线棠核'), '核心参与者停用的事件应隐藏');
  const branch = snapshot.历史.find(item => item.事件ID === '线棠枝');
  assert.ok(branch && !branch.分支.some(item => item.id === '双人'), '分支门槛失效的选项应隐藏');
  assert.equal(snapshot.错误, null);

  assert.equal(draft.setHistory('线异门', '显').ok, true);
  assert.equal(draft.snapshot().历史.some(item => item.事件ID === '线异门'), true);

  const back = draft.setWorldline('正史');
  assert.equal(back.ok, true);
  snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.线年先, '立');
  assert.equal(snapshot.预览.开局.历史选择.线年后, '成');
  assert.equal(snapshot.预览.开局.历史选择.线异门, undefined, '新世界线门槛失效的覆盖应清理');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true);
});

test('YG-OPEN-03-R2-1：同年 3 节点链先选下游再改选上游，逆序残留覆盖自动清净', async t => {
  const {draft} = await yearGranularityDraft(t);
  // 逆 codepoint 选择顺序：先 C 再 B，最后改选上游 A，使覆盖键序为 C→B→A。
  assert.equal(draft.setHistory('年链C', '终局').ok, true);
  assert.equal(draft.setHistory('年链B', '远行').ok, true);
  const changed = draft.setHistory('年链A', '止步');
  assert.equal(changed.ok, true, `改选上游 A 后应清净 B/C 并封卷成功：${JSON.stringify(changed.error ?? null)}`);

  const snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.年链A, '止步');
  assert.equal(snapshot.预览.开局.历史选择.年链B, undefined, '失效的同年下游 B 覆盖应清理');
  assert.equal(snapshot.预览.开局.历史选择.年链C, undefined, '失效的传递下游 C 覆盖应清理');
  const ids = snapshot.历史.map(item => item.事件ID);
  assert.ok(!ids.includes('年链B') && !ids.includes('年链C'), '上游改选后下游控件应隐藏');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true, '清净逆序残留后封卷应成功');
});

test('YG-OPEN-03-R2-2：清空上游退回默认分支时自动清理不再成立的下游覆盖', async t => {
  const {draft} = await yearGranularityDraft(t);
  // 回退A 默认分支为「守旧」，只有显式改选「启程」才能让 回退B 成立。
  assert.equal(draft.setHistory('回退A', '启程').ok, true);
  assert.equal(draft.setHistory('回退B', '同行').ok, true);

  const cleared = draft.setHistory('回退A', '');
  assert.equal(cleared.ok, true, `清空上游退回默认分支后应清净下游并封卷成功：${JSON.stringify(cleared.error ?? null)}`);

  const snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.回退A, undefined);
  assert.equal(snapshot.预览.开局.历史选择.回退B, undefined, '退回默认分支后失效的下游覆盖应清理');
  assert.ok(!snapshot.历史.some(item => item.事件ID === '回退B'), '下游控件应隐藏');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true);
});

test('YG-OPEN-03-R2-3：切世界线时同年下游 codepoint 小于失效上游的级联清理', async t => {
  const {draft} = await yearGranularityDraft(t);
  assert.equal(draft.setWorldline('异闻').ok, true);
  let ids = draft.snapshot().历史.map(item => item.事件ID);
  assert.ok(ids.includes('线异源') && ids.includes('线异果'), '异闻世界线下上游与下游均应可见');
  // 上游 线异源 选中仅在异闻成立的「静」分支；灯灭 选中「熄灭」改写剧情标记；下游 线异果 依赖上游确认与雾灯常亮。
  assert.equal(draft.setHistory('线异源', '静').ok, true);
  assert.equal(draft.setHistory('灯灭', '熄灭').ok, true);
  assert.equal(draft.setHistory('线异果', '成').ok, true);
  assert.equal(draft.prepare().ok, true, '切世界线前异闻世界线应可封卷');

  const back = draft.setWorldline('正史');
  assert.equal(back.ok, true, `切回正史后应逐轮清净同年逆序覆盖：${JSON.stringify(back.error ?? null)}`);
  const snapshot = draft.snapshot();
  assert.equal(snapshot.预览.开局.历史选择.线异源, undefined, '新世界线分支门槛失效的上游覆盖应清理');
  assert.equal(snapshot.预览.开局.历史选择.线异果, undefined, '依赖失效上游的下游覆盖应级联清理');
  assert.equal(snapshot.预览.开局.历史选择.灯灭, '熄灭', '新世界线下仍合法的同年覆盖不得误删');
  ids = snapshot.历史.map(item => item.事件ID);
  assert.ok(!ids.includes('线异果'), '上游失效后下游控件应隐藏');
  assert.equal(snapshot.预览.世界.剧情标记.雾灯, '熄灭');
  assert.equal(snapshot.错误, null);
  assert.equal(draft.prepare().ok, true);
});
