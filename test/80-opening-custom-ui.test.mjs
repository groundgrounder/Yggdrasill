import {test, assert, fs, path, fixture} from './helpers.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {loadRouter, route} from '../core/index.mjs';
import {createOpeningDraft} from '../adapter/opening.mjs';
import {openingNode} from '../adapter/opening-ui.mjs';
import {createBookkeeper} from '../adapter/bookkeeper.mjs';
import {createView} from '../adapter/view.mjs';

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

test('YG-CUST-02-A2：扮演现状自动计算、增量增删改、归零抵消与切换隔离', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  catalog.openingOptions.内容.自由组合 = true;
  const protocol = createProtocol({catalog, decl});

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });

  // 1) 扮演灯塔学徒，调整开局时间与历史选择后，基线自动反映对应时期现状
  assert.equal(draft.setPlayerMode('扮演').ok, true);
  assert.equal(draft.setPlayerGroup('灯塔学徒').ok, true);
  let snap = draft.snapshot();
  assert.equal(snap.扮演表单.基线.结果, '成立');
  assert.equal(snap.扮演表单.基线.档案ID, '林澜·学徒期');
  assert.equal(snap.扮演表单.已自定义项数, 0);
  assert.deepEqual(snap.玩家, {模式: '扮演', 扮演角色组: '灯塔学徒'});

  assert.equal(draft.setTime('潮历074年').ok, true);
  snap = draft.snapshot();
  assert.equal(snap.扮演表单.基线.档案ID, '林澜·守塔期');
  assert.equal(snap.扮演表单.基线.能力.技艺.灯语, '匠人');
  assert.equal(snap.扮演表单.基线.能力.技艺.修船, '熟手');
  assert.deepEqual(snap.扮演表单.基线.能力.习惯, ['每刻钟查一次灯芯']);
  assert.ok(snap.扮演表单.基线.可用技能.includes('灯语·短讯'));
  assert.deepEqual(snap.扮演表单.基线.装备['灯具·风暴灯'], {状态: '完好', 位置: '随身'});
  assert.equal(typeof snap.扮演表单.基线.所在, 'string');

  // 历史选择改写（出师考核=未发生）时，基线同步切换
  assert.equal(draft.setHistory('出师考核', '未发生').ok, true);
  assert.equal(draft.snapshot().扮演表单.基线.档案ID, '林澜·学徒期');
  assert.equal(draft.setHistory('出师考核', '').ok, true);
  assert.equal(draft.snapshot().扮演表单.基线.档案ID, '林澜·守塔期');

  // 2) 增量增删改能力、技能、装备与自定义项并 prepare 封卷落地
  assert.equal(draft.setRoleplayAbility('名望', '名匠').ok, true);
  assert.equal(draft.setRoleplayAbility('技艺', {灯语: '名匠'}).ok, true); // 修船被移除，灯语提升
  assert.equal(draft.setRoleplayAbility('习惯', []).ok, true);
  assert.equal(draft.removeSkill('灯语·短讯').ok, true);
  assert.equal(draft.addSkill('修船·补帆').ok, true); // 修船被移除后，作为额外技能加回
  assert.equal(draft.setRoleplayEquipment('灯具·风暴灯', null).ok, true);
  assert.equal(draft.setRoleplayEquipment('工具·铜扳手', {状态: '完好', 位置: '腰带'}).ok, true);
  assert.equal(draft.setCustomEquipment([{名称: '祖传怀表', 说明: '黄铜旧怀表。', 状态: '完好', 位置: '内袋'}]).ok, true);
  assert.equal(draft.setCustomSkills([{名称: '听潮辨雾', 说明: '借浪声辨方位。', 限制: '风大时失效'}]).ok, true);

  snap = draft.snapshot();
  assert.equal(snap.扮演表单.已自定义项数, 10);
  const prepared = draft.prepare();
  assert.equal(prepared.ok, true);
  const state = prepared.record.本局;
  assert.equal(state.角色.灯塔学徒.已初始化, true);
  assert.equal(state.角色.灯塔学徒.名望, '名匠');
  assert.equal(state.角色.灯塔学徒.技艺.灯语, '名匠');
  assert.equal(Object.hasOwn(state.角色.灯塔学徒.技艺, '修船'), false);
  assert.deepEqual(state.角色.灯塔学徒.习惯, []);
  assert.equal(Object.hasOwn(state.角色.灯塔学徒.装备, '灯具·风暴灯'), false);
  assert.deepEqual(state.角色.灯塔学徒.装备['工具·铜扳手'], {状态: '完好', 位置: '腰带'});
  assert.deepEqual(state.角色.灯塔学徒.装备['祖传怀表'], {状态: '完好', 位置: '内袋'});
  const skills = protocol.availableSkills(state, '灯塔学徒');
  assert.equal(skills.includes('灯语·短讯'), false);
  assert.equal(skills.includes('修船·补帆'), true);

  // 3) 逐项切回基线原值后 已自定义项数 归零
  assert.equal(draft.setRoleplayAbility('名望', '熟手').ok, true);
  assert.equal(draft.setRoleplayAbility('技艺', {灯语: '匠人', 修船: '熟手'}).ok, true);
  assert.equal(draft.setRoleplayAbility('习惯', ['每刻钟查一次灯芯']).ok, true);
  assert.equal(draft.addSkill('灯语·短讯').ok, true);
  assert.equal(draft.removeSkill('修船·补帆').ok, true);
  assert.equal(draft.setRoleplayEquipment('灯具·风暴灯', {状态: '完好', 位置: '随身'}).ok, true);
  assert.equal(draft.setRoleplayEquipment('工具·铜扳手', null).ok, true);
  assert.equal(draft.setCustomEquipment([]).ok, true);
  assert.equal(draft.setCustomSkills([]).ok, true);
  assert.equal(draft.snapshot().扮演表单.已自定义项数, 0);
  assert.deepEqual(draft.snapshot().玩家, {模式: '扮演', 扮演角色组: '灯塔学徒'});

  // 4) 一键恢复当前时期默认
  assert.equal(draft.setRoleplayAbility('名望', '名匠').ok, true);
  assert.equal(draft.setCustomEquipment([{名称: '铜铃', 说明: '小铜铃。', 状态: '完好', 位置: '随身'}]).ok, true);
  assert.equal(draft.setCustomSkills([{名称: '辨风', 说明: '听风辨向。'}]).ok, true);
  assert.ok(draft.snapshot().扮演表单.已自定义项数 > 0);
  assert.equal(draft.resetRoleplayCustomization().ok, true);
  assert.equal(draft.snapshot().扮演表单.已自定义项数, 0);
  assert.deepEqual(draft.snapshot().玩家, {模式: '扮演', 扮演角色组: '灯塔学徒'});

  // 5) 同一角色调时间保留增量定制且未改字段随新时期刷新；切换角色自动清空增量定制不串角色
  assert.equal(draft.setRoleplayAbility('名望', '名匠').ok, true);
  assert.equal(draft.removeSkill('灯语·短讯').ok, true);
  assert.equal(draft.setTime('潮历071年04月01日').ok, true);
  snap = draft.snapshot();
  assert.equal(snap.扮演表单.基线.档案ID, '林澜·学徒期');
  assert.equal(snap.扮演表单.有效能力.名望, '名匠', '同一角色调时间应保留已有能力覆写');
  assert.equal(snap.扮演表单.有效可用技能.includes('灯语·短讯'), false, '同一角色调时间应保留移除技能');
  assert.equal(snap.扮演表单.有效能力.技艺.灯语, snap.扮演表单.基线.能力.技艺.灯语, '未改动维度应自动跟随新时期基线刷新');
  assert.equal(snap.扮演表单.有效能力.技艺.灯语, '熟手');

  assert.equal(draft.setPlayerGroup('秦守').ok, true);
  snap = draft.snapshot();
  assert.equal(snap.扮演表单.扮演角色组, '秦守');
  assert.equal(snap.扮演表单.已自定义项数, 0, '切换扮演角色后上一角色的扮演定制必须自动清空');
  assert.deepEqual(snap.玩家, {模式: '扮演', 扮演角色组: '秦守'});
});

test('YG-CUST-02-A3：自建模式自定义装备/技能与技能增删、路由联动与非法预演保护', async t => {
  const wbDir = await fixture(t);
  const {protocol, router} = await loadRouter(wbDir, {fs, path});
  const {catalog, decl} = router;

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });

  assert.equal(draft.setProfileField('姓名', '阿客').ok, true);
  assert.equal(draft.setInitialAbility('技艺', {灯语: '学徒'}).ok, true);
  assert.equal(draft.setInitialEquipment([{装备ID: '灯具·风暴灯', 状态: '完好', 位置: '提手'}]).ok, true);
  assert.equal(draft.setCustomEquipment([{名称: '旧银哨', 说明: '遇雾吹响可引岸边老犬回应。', 状态: '完好', 位置: '颈间'}]).ok, true);
  assert.equal(draft.setCustomSkills([{名称: '辨潮音', 说明: '听浪判断涨落潮时辰。'}]).ok, true);
  assert.equal(draft.addSkill('雾中视·辨影').ok, true);
  assert.equal(draft.removeSkill('灯语·短讯').ok, true);

  const validPrep = draft.prepare();
  assert.equal(validPrep.ok, true);
  const state = validPrep.record.本局;
  assert.deepEqual(protocol.availableSkills(state, '玩家'), ['雾中视·辨影']);
  assert.deepEqual(state.角色.玩家.装备['旧银哨'], {状态: '完好', 位置: '颈间'});

  const routed = route(router, state, ['试着用一下雾中视·辨影和灯语·短讯。']);
  const playerCard = routed.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.deepEqual(playerCard.自定义技能, [{名称: '辨潮音', 说明: '听浪判断涨落潮时辰。'}]);
  assert.deepEqual(playerCard.自定义装备, [{名称: '旧银哨', 说明: '遇雾吹响可引岸边老犬回应。'}]);
  assert.equal(routed.audit.条目.装备.略过.some(item => item.条目ID === '旧银哨'), false);

  // 非法自定义装备（与世界书装备重名）在预演时立即暴露清晰错误，且保留上一次有效预览
  const bad = draft.setCustomEquipment([{名称: '工具·铜扳手', 说明: '重名测试。', 状态: '完好', 位置: '腰间'}]);
  assert.equal(bad.ok, false);
  assert.match(bad.error.说明, /重名/);
  const badSnap = draft.snapshot();
  assert.ok(badSnap.错误);
  assert.ok(badSnap.上次预览, '预演失败时应保留上一次有效预览');
  assert.equal(badSnap.上次预览.开局.玩家.档案.姓名, '阿客');
});

test('YG-CUST-02-A4：唯一装备原主自动反查与自建/扮演开局强制归属', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const wrench = catalog.entries.装备.find(item => item.id === '工具·铜扳手');
  wrench.内容.唯一 = true;
  const protocol = createProtocol({catalog, decl});

  // 1) 自建模式：反查出 秦守 为原主；选中并 prepare 后归玩家，秦守不再持有且后续初始化跳过
  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [
      {确认初始化: {角色组ID: '秦守'}},
      {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}},
    ],
  });
  const snap = draft.snapshot();
  const wrenchMeta = snap.自建表单.装备库.find(item => item.id === '工具·铜扳手');
  assert.equal(wrenchMeta.唯一, true);
  assert.deepEqual(wrenchMeta.原主, [{id: '秦守', 显示名: '秦守'}]);

  assert.equal(draft.setInitialEquipment([{装备ID: '工具·铜扳手', 状态: '完好', 位置: '玩家腰间'}]).ok, true);
  const prep = draft.prepare();
  assert.equal(prep.ok, true);
  assert.deepEqual(prep.record.本局.角色.玩家.装备['工具·铜扳手'], {状态: '完好', 位置: '玩家腰间'});
  assert.equal(Object.hasOwn(prep.record.本局.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false, '原主秦守初始化应跳过已被玩家持有的唯一装备');

  // 2) 扮演其他角色（灯塔学徒）选中该唯一装备，同样强制归属
  assert.equal(draft.setPlayerMode('扮演').ok, true);
  assert.equal(draft.setPlayerGroup('灯塔学徒').ok, true);
  assert.equal(draft.setRoleplayEquipment('工具·铜扳手', {状态: '完好', 位置: '学徒工具袋'}).ok, true);
  const rpPrep = draft.prepare();
  assert.equal(rpPrep.ok, true);
  assert.deepEqual(rpPrep.record.本局.角色.灯塔学徒.装备['工具·铜扳手'], {状态: '完好', 位置: '学徒工具袋'});
  assert.equal(Object.hasOwn(rpPrep.record.本局.角色.秦守?.装备 ?? {}, '工具·铜扳手'), false);
});

test('YG-CUST-02-A5：DOM 界面渲染与交互验证（扮演现状栏、唯一装备提示、双模式自定义表单与既有顺序）', async t => {
  const {find, findAll} = makeDomMock(t);
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  catalog.entries.装备.find(item => item.id === '工具·铜扳手').内容.唯一 = true;
  const protocol = createProtocol({catalog, decl});

  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历074年'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });

  // 1) 自建模式：检查 5 段主顺序（单世界线卡）与折叠高级选项不变，以及自定义技能/装备与世界书技能控件
  const root = openingNode(draft);
  const topDetails = root.children.filter(c => c.tag === '<details>');
  assert.deepEqual(topDetails.map(d => d.children[0]?.text()), [
    '预设开局', '开局时间与地点', '玩家', '开场白', '高级选项（角色组与历史选择）',
  ]);
  assert.equal(topDetails.at(-1).properties.open, false, '高级选项必须默认折叠');
  assert.ok(root.text().includes('可用世界书技能'));
  assert.ok(root.text().includes('自定义技能'));
  assert.ok(root.text().includes('自定义装备'));

  // 通过 DOM 添加世界书技能、自定义技能与自定义装备
  const addSkillBtn = find(root, n => n.tag === '<button>' && n.text() === '添加技能');
  assert.ok(addSkillBtn);
  addSkillBtn.handlers.click();
  assert.equal(draft.snapshot().自建表单.额外技能.length, 1);

  const csName = find(root, n => n.tag === '<input>' && n.attrs.placeholder === '自定义技能名称');
  const csDesc = find(root, n => n.tag === '<input>' && n.attrs.placeholder === '说明（必填）');
  const csAdd = find(root, n => n.tag === '<button>' && n.text() === '添加自定义技能');
  csName.handlers.change({target: {value: '听雾'}});
  csDesc.handlers.change({target: {value: '听辨海雾远近。'}});
  csAdd.handlers.click();
  assert.equal(draft.snapshot().自建表单.自定义技能.length, 1);

  const ceName = find(root, n => n.tag === '<input>' && n.attrs.placeholder === '自定义装备名称');
  const ceDescs = findAll(root, n => n.tag === '<input>' && n.attrs.placeholder === '说明（必填）');
  const ceAdd = find(root, n => n.tag === '<button>' && n.text() === '添加自定义装备');
  ceName.handlers.change({target: {value: '铁罗盘'}});
  ceDescs.at(-1).handlers.change({target: {value: '旧式航海罗盘。'}});
  ceAdd.handlers.click();
  assert.equal(draft.snapshot().自建表单.自定义装备.length, 1);

  // 2) 切到扮演模式：验证现状栏、唯一装备下拉原主标签与提示文案、恢复默认按钮
  const modeSelect = find(root, n => n.tag === '<select>' && n.children.some(o => o.field === '扮演'));
  modeSelect.handlers.change({target: {value: '扮演'}});
  assert.match(root.text(), /当前时期档案：林澜·守塔期/);
  assert.match(root.text(), /默认所在：/);

  // 装备下拉含原主标签，选中唯一装备 工具·铜扳手 后出现唯一归属提示
  const equipSelect = find(root, n => n.tag === '<select>' && n.children.some(o => o.field === '工具·铜扳手'));
  assert.ok(equipSelect);
  const wrenchOpt = equipSelect.children.find(o => o.field === '工具·铜扳手');
  assert.match(wrenchOpt.text(), /铜扳手（唯一 · 原主：秦守）/);
  equipSelect.handlers.change({target: {value: '工具·铜扳手'}});
  assert.match(root.text(), /唯一装备：开局后将由你持有，原主不再持有/);

  // 触发一次扮演定制后出现「恢复当前时期默认」按钮，点击后恢复默认
  draft.setRoleplayAbility('名望', '熟手');
  const resetEquipSelect = find(root, n => n.tag === '<select>' && n.children.some(o => o.field === '工具·铜扳手'));
  resetEquipSelect.handlers.change({target: {value: '工具·铜扳手'}}); // 触发重绘
  assert.match(root.text(), /已自定义 \d+ 项/);
  assert.match(root.text(), /扮演 灯塔学徒（已自定义 \d+ 项）/);
  const resetBtn = find(root, n => n.tag === '<button>' && n.text() === '恢复当前时期默认');
  assert.ok(resetBtn);
  resetBtn.handlers.click();
  assert.equal(draft.snapshot().扮演表单.已自定义项数, 0);
  assert.equal(find(root, n => n.tag === '<button>' && n.text() === '恢复当前时期默认'), undefined);
});

test('YG-CUST-02-A6：记账器自定义装备透出、动态记账追踪与玩家面板展示', async t => {
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const keeper = createBookkeeper({protocol, catalog, decl});
  const view = createView({protocol, catalog, decl, keeper});

  // 1) 无自定义装备/技能时，提示词不含自定义装备行，面板不含自定义技能项
  const plainState = protocol.seal({
    开局时间: '潮历071年04月01日',
    玩家: {模式: '自建', 档案: {姓名: '阿客'}},
  });
  const plainReq = keeper.request(plainState, {input: '环顾四周。', narration: '值守室很安静。'});
  assert.doesNotMatch(plainReq.prompts[0].content, /自定义装备:/);
  assert.doesNotMatch(plainReq.prompts[0].content, /<自定义装备名称>/);
  const plainPanel = view.player(plainState);
  assert.equal(plainPanel[1].项.some(([k]) => k === '自定义技能'), false);

  // 2) 有自定义装备与自定义技能时：request 透出自定义装备清单与可写字段行；run 支持改态与移交 NPC
  const customState = protocol.seal({
    开局时间: '潮历071年04月01日',
    玩家: {
      模式: '自建',
      档案: {姓名: '阿客'},
      自定义装备: [{名称: '祖传怀表', 说明: '黄铜旧怀表，表盖刻有航标。', 状态: '完好', 位置: '随身'}],
      自定义技能: [
        {名称: '听潮辨雾', 说明: '借浪声判断近岸暗礁。', 限制: '风大时失效'},
        {名称: '夜航记星', 说明: '无云夜里可凭星位辨向。'},
      ],
    },
  });
  const customReq = keeper.request(customState, {input: '收起怀表。', narration: '怀表不慎摔裂，收入木盒。'});
  assert.match(customReq.prompts[0].content, /自定义装备:/);
  assert.match(customReq.prompts[0].content, /祖传怀表/);
  assert.match(customReq.prompts[0].content, /黄铜旧怀表，表盖刻有航标/);
  assert.match(customReq.prompts[0].content, /角色\.<角色组ID>\.装备\.<自定义装备名称>：新增、设定、移除；状态为 .+，写作“状态\/位置”（仅限本局已声明自定义装备：祖传怀表）/);

  // 改态：完好/随身 → 破损/木盒
  const damaged = keeper.run(customState, {
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: [],
    发生的事件: [],
    新情况: [{
      事件ID: '怀表摔裂',
      摘要: '祖传怀表摔裂后收进木盒。',
      实际参与者: ['玩家'],
      结束事件串: '',
      变化: [{路径: '角色.玩家.装备.祖传怀表', 操作: '设定', 值: '破损/木盒'}],
    }],
  });
  assert.deepEqual(damaged.失败, []);
  assert.deepEqual(damaged.state.角色.玩家.装备['祖传怀表'], {状态: '破损', 位置: '木盒'});

  // 移除玩家并移交给 NPC 秦守
  const transferred = keeper.run(damaged.state, {
    时间: {方式: '不变', 日期: '', 事件ID: ''},
    地点: {地标: '', 场景: ''},
    在场: ['秦守'],
    发生的事件: [],
    新情况: [{
      事件ID: '托付怀表',
      摘要: '玩家将受损怀表交给秦守保管。',
      实际参与者: ['玩家', '秦守'],
      结束事件串: '',
      变化: [
        {路径: '角色.玩家.装备.祖传怀表', 操作: '移除', 值: ''},
        {路径: '角色.秦守.装备.祖传怀表', 操作: '新增', 值: '破损/灯塔抽屉'},
      ],
    }],
  });
  assert.deepEqual(transferred.失败, []);
  assert.equal(Object.hasOwn(transferred.state.角色.玩家.装备, '祖传怀表'), false);
  assert.deepEqual(transferred.state.角色.秦守.装备['祖传怀表'], {状态: '破损', 位置: '灯塔抽屉'});

  // 3) 玩家面板正确展示 自定义技能 与 自定义装备
  const panel = view.player(customState);
  const selfCard = panel[1];
  const csRow = selfCard.项.find(([k]) => k === '自定义技能');
  assert.deepEqual(csRow, ['自定义技能', [
    '听潮辨雾（借浪声判断近岸暗礁。；限制：风大时失效）',
    '夜航记星（无云夜里可凭星位辨向。）',
  ]]);
  const equipRow = selfCard.项.find(([k]) => k === '装备');
  assert.ok(equipRow[1].includes('祖传怀表（完好，随身）'));
});
