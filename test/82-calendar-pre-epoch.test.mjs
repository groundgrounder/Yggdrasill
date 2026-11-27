import {test, assert, fs, path, project, fixture} from './helpers.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {checkField} from '../core/fields.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {loadRouter, route, applyCommands} from '../core/index.mjs';
import {samplingYears} from '../checker/rules/sampling.mjs';
import {createOpeningDraft} from '../adapter/opening.mjs';
import {openingNode} from '../adapter/opening-ui.mjs';

const sanguoRoot = path.join(project, 'examples/三国演义/世界书');

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

function requiredLabelsOf(root, findAll) {
  return findAll(root, n => n.tag === '<label>' && n.children.some(c => c.classes.includes('ygg-req')))
    .map(n => n.value);
}

test('YG-FIX-03-A2：纪年内核支持纪元前年份、连续整数轴与严格边界', () => {
  const decl = {前缀: '中平', 年位数: 3, 月数: 12, 每月天数: 30};
  const cal = createCalendar(decl);
  assert.equal(cal.yearDays, 360);

  // 连续区间无空洞无重叠
  assert.deepEqual(cal.time('中平前001年'), [-360, 0]);
  assert.deepEqual(cal.time('中平前001年01月01日'), [-360, -359]);
  assert.deepEqual(cal.time('中平前001年12月30日'), [-1, 0]);
  assert.deepEqual(cal.time('中平000年01月01日'), [0, 1]);
  assert.deepEqual(cal.time('中平000年'), [0, 360]);
  assert.deepEqual(cal.time('中平前019年'), [-19 * 360, -18 * 360]);
  assert.deepEqual(cal.time('中平前999年'), [-999 * 360, -998 * 360]);
  assert.deepEqual(cal.time('中平前999年01月01日'), [-999 * 360, -999 * 360 + 1]);

  // year 精确求值
  assert.equal(cal.year('中平前001年12月30日'), -1);
  assert.equal(cal.year('中平前001年01月01日'), -1);
  assert.equal(cal.year('中平前019年'), -19);
  assert.equal(cal.year('中平前999年'), -999);
  assert.equal(cal.year('中平000年'), 0);
  assert.equal(cal.year('中平001年04月02日'), 1);

  // format / year 互逆覆盖 [-999, 999]
  assert.equal(cal.format(-19), '中平前019年');
  assert.equal(cal.format(-1), '中平前001年');
  assert.equal(cal.format(0), '中平000年');
  assert.equal(cal.format(-999), '中平前999年');
  assert.equal(cal.format(999), '中平999年');
  for (let y = -999; y <= 999; y++) assert.equal(cal.year(cal.format(y)), y, String(y));

  // formatDay 精确互逆（跨越 0 点与负年）
  assert.equal(cal.formatDay(-1), '中平前001年12月30日');
  assert.equal(cal.formatDay(-360), '中平前001年01月01日');
  assert.equal(cal.formatDay(-361), '中平前002年12月30日');
  assert.equal(cal.formatDay(0), '中平000年01月01日');
  assert.equal(cal.formatDay(-999 * 360), '中平前999年01月01日');
  for (let d = -360 * 3; d < 360 * 2; d++) {
    const text = cal.formatDay(d);
    assert.ok(text, String(d));
    assert.equal(cal.time(text)?.[0], d, String(d));
  }

  // 非法输入全部拒绝
  for (const bad of [
    '中平前000年', '中平前000年01月01日', '中平前1000年', '中平前1000年01月01日',
    '中平前19年', '中平前019年13月01日', '中平前019年01月31日', '中平-019年',
  ]) assert.equal(cal.time(bad), null, bad);
  for (const bad of [-1000, 1000, 1.5, -0.5, NaN, Infinity, -Infinity]) assert.equal(cal.format(bad), null, String(bad));
  for (const bad of [-999 * 360 - 1, 1000 * 360, 1.5, NaN, Infinity, -Infinity]) assert.equal(cal.formatDay(bad), null, String(bad));

  // checkField 校验 {取值: '纪年'}
  assert.deepEqual(checkField('中平前019年', {取值: '纪年'}, {decl: {calendar: decl}, label: '出生年', scope: '档案'}), []);
  assert.deepEqual(checkField('中平前001年12月30日', {取值: '纪年'}, {decl: {calendar: decl}, label: '出生年', scope: '档案'}), []);
  assert.ok(checkField('中平前000年', {取值: '纪年'}, {decl: {calendar: decl}, label: '出生年', scope: '档案'}).length > 0);
  assert.ok(checkField('中平前1000年', {取值: '纪年'}, {decl: {calendar: decl}, label: '出生年', scope: '档案'}).length > 0);
});

test('YG-FIX-03-A2：协议封卷、路由年龄计算与负年份抽样下界', async () => {
  const {protocol, router} = await loadRouter(sanguoRoot, {fs, path});
  const state = protocol.seal({
    开局时间: '中平001年04月02日',
    玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: '中平前019年'}},
  });
  assert.equal(state.开局.玩家.档案.出生年, '中平前019年');

  // 非法纪元前出生年（前000年）仍由封卷拒绝
  assert.throws(() => protocol.seal({
    开局时间: '中平001年04月02日',
    玩家: {模式: '自建', 档案: {姓名: '游侠', 出生年: '中平前000年'}},
  }));

  // 路由自然算出 1 - (-19) = 20 岁
  const {state: sceneState} = applyCommands(protocol, state, [{写场景: {当前地点: {地标: '涿县', 场景: '城门榜前'}}}]);
  const routed = route(router, sceneState, []);
  const playerCard = routed.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.ok(playerCard);
  assert.equal(playerCard.年龄, 20);

  // samplingYears：含负年份事件时向更早取 min - 1，不误夹到 0；全非负时保持 Math.max(0, min - 1)
  const decl = {calendar: {前缀: '中平', 年位数: 3, 月数: 12, 每月天数: 30}};
  assert.deepEqual(samplingYears({events: [{内容: {触发时间: {最早: '中平000年', 最晚: '中平001年'}}}]}, decl), [0, 1, 2]);
  assert.deepEqual(samplingYears({events: [{内容: {触发时间: {最早: '中平前005年', 最晚: '中平001年'}}}]}, decl), [-6, -5, -4, 1, 2]);
  assert.deepEqual(samplingYears({events: [{内容: {触发时间: {最早: '中平前999年', 最晚: '中平前999年'}}}]}, decl), [-999, -998]);
});

test('YG-FIX-03-A3：三国演义开局前端年龄 ↔ 出生年双向换算与非法提示', async t => {
  const {find} = makeDomMock(t);
  const {catalog, decl} = await compileWorldbook(sanguoRoot, {fs, path});
  const protocol = createProtocol({catalog, decl});
  const draft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '中平001年04月02日'},
    commands: [{写场景: {当前地点: {地标: '涿县', 场景: '城门榜前'}}}],
  });
  const root = openingNode(draft);
  const getAgeInput = () => find(root, n => n.tag === '<input>' && n.attrs.placeholder === '按年龄换算');
  const getTimeInput = () => find(root, n => n.tag === '<input>' && n.field === draft.snapshot().时间);
  const getBirthField = () => find(root, n => n.classes.includes('ygg-field') && n.children[0]?.value === '出生年');

  // 1) 输入 20 → 中平前019年，封卷预演 0 错误，回显 20 岁
  getAgeInput().handlers.change({target: {value: '20'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前019年');
  assert.equal(draft.snapshot().错误, null);
  assert.equal(getAgeInput().field, '20');
  assert.match(getBirthField().text(), /当前约 20 岁/);

  // 2) 边界值：1 → 中平000年、2 → 中平前001年、0 → 中平001年
  getAgeInput().handlers.change({target: {value: '1'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平000年');
  assert.equal(draft.snapshot().错误, null);

  getAgeInput().handlers.change({target: {value: '2'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前001年');
  assert.equal(draft.snapshot().错误, null);

  getAgeInput().handlers.change({target: {value: '0'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平001年');
  assert.equal(draft.snapshot().错误, null);

  // 3) 设为 20 岁后切换开局时间至 中平006年，自动重算为 25 岁
  getAgeInput().handlers.change({target: {value: '20'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前019年');
  getTimeInput().handlers.change({target: {value: '中平006年'}});
  assert.equal(getAgeInput().field, '25');
  assert.match(getBirthField().text(), /当前约 25 岁/);

  // 4) 出生年晚于开局时间时年龄框留空并给出友好提示
  draft.setProfileField('出生年', '中平010年');
  getTimeInput().handlers.change({target: {value: '中平006年'}});
  assert.equal(getAgeInput().field, '');
  assert.match(getBirthField().text(), /晚于当前开局时间/);

  // 5) 恢复为中平001年 + 中平前019年，输入非法值（-1 / 1.5 / 1001）不静默无响应，展示中文提示且保留原出生年
  getTimeInput().handlers.change({target: {value: '中平001年04月02日'}});
  getAgeInput().handlers.change({target: {value: '20'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前019年');

  for (const bad of ['-1', '1.5']) {
    getAgeInput().handlers.change({target: {value: bad}});
    assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前019年', bad);
    assert.match(getBirthField().text(), /非负整数/, bad);
  }
  getAgeInput().handlers.change({target: {value: '1001'}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, '中平前019年');
  assert.match(getBirthField().text(), /超出 3 位纪年上限/);

  // 6) 清空年龄框清空出生年并清除局部提示
  getAgeInput().handlers.change({target: {value: ''}});
  assert.equal(draft.snapshot().自建表单.档案.出生年, undefined);
  assert.doesNotMatch(getBirthField().text(), /超出 3 位纪年上限/);
});

test('YG-FIX-03-A4：开局前端必填项 * 标记、自建区选填轻提示与子项缺填行内提示', async t => {
  const {find, findAll} = makeDomMock(t);
  const wbDir = await fixture(t);
  const {catalog, decl} = await compileWorldbook(wbDir, {fs, path});
  const protocol = createProtocol({catalog, decl});

  // 1) 单世界线卡（有地点库）：自建模式 + 预设开场白 → 仅 开局时间、开局地点 带 *
  const singleDraft = createOpeningDraft({
    protocol, catalog, decl,
    defaults: {开局时间: '潮历071年04月01日'},
    commands: [{写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}}}],
  });
  const singleRoot = openingNode(singleDraft);
  assert.match(singleRoot.text(), /带 \* 为必填项，其余均为选填/);
  assert.match(singleRoot.text(), /以下角色信息、能力、技能与装备均为选填，可按需填写或全部留空直接开局。/);
  assert.deepEqual(requiredLabelsOf(singleRoot, findAll), ['开局时间', '开局地点']);

  // 自建档案全部留空时预演与提交均成功
  assert.equal(singleDraft.snapshot().错误, null);
  assert.equal(singleDraft.prepare().ok, true);

  // 点击添加自定义技能 / 自定义装备缺子项时给出行内提示而非静默无响应，且不阻断提交
  find(singleRoot, n => n.tag === '<button>' && n.text() === '添加自定义技能').handlers.click();
  assert.match(singleRoot.text(), /请填写自定义技能的技能名称和说明后再添加/);
  find(singleRoot, n => n.tag === '<button>' && n.text() === '添加自定义装备').handlers.click();
  assert.match(singleRoot.text(), /请填写自定义装备的装备名称、说明后再添加/);
  assert.equal(singleDraft.prepare().ok, true);

  // 切换到扮演模式 → 增加 扮演角色组 带 *
  find(singleRoot, n => n.tag === '<select>' && n.children.some(o => o.field === '扮演'))
    .handlers.change({target: {value: '扮演'}});
  assert.deepEqual(requiredLabelsOf(singleRoot, findAll), ['开局时间', '开局地点', '扮演角色组']);

  // 切换开场白模式为 提示扩写 / 手写 / 自动生成 → 精确增减 开场提示 / 手写开场白正文
  const setGreeting = mode => find(singleRoot, n => n.tag === '<select>' && n.children.some(o => o.field === '提示扩写'))
    .handlers.change({target: {value: mode}});
  setGreeting('提示扩写');
  assert.deepEqual(requiredLabelsOf(singleRoot, findAll), ['开局时间', '开局地点', '扮演角色组', '开场提示']);
  setGreeting('手写');
  assert.deepEqual(requiredLabelsOf(singleRoot, findAll), ['开局时间', '开局地点', '扮演角色组', '手写开场白正文']);
  setGreeting('自动生成');
  assert.deepEqual(requiredLabelsOf(singleRoot, findAll), ['开局时间', '开局地点', '扮演角色组']);

  // 2) 多世界线卡（模拟含世界线）→ 增加 选择世界线 带 *
  const multiCatalog = structuredClone(catalog);
  multiCatalog.worldlines = [
    {id: '正史', 内容: {概述: '主线世界线', 默认: true}},
    {id: '异闻', 内容: {概述: '分支世界线', 默认: false}},
  ];
  const multiProtocol = createProtocol({catalog: multiCatalog, decl});
  const multiDraft = createOpeningDraft({
    protocol: multiProtocol, catalog: multiCatalog, decl,
    defaults: {世界线: '正史', 开局时间: '潮历071年04月01日'},
  });
  const multiRoot = openingNode(multiDraft);
  assert.deepEqual(requiredLabelsOf(multiRoot, findAll), ['选择世界线', '开局时间', '开局地点']);
});
