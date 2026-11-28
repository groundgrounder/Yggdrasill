import {assert, test, fs, path, project} from './helpers.mjs';
import {computeEdgeGeometry, renderLocalGraph} from '../view/public/canvas-views.js';

class StubNode {
  constructor(nodeType, tagName = '') {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.disabled = false;
    this.hidden = false;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this._text = '';
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        this.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.delete(name);
        this.className = [...set].join(' ');
      },
      toggle: (name, force) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        const has = set.has(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) set.add(name);
        else set.delete(name);
        this.className = [...set].join(' ');
        return next;
      },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  append(...items) {
    for (const item of items) {
      if (item === null || item === undefined) continue;
      const node = item instanceof StubNode ? item : new StubText(String(item));
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...items) {
    this.children = [];
    this._text = '';
    this.append(...items);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
    if (key === 'id') this.id = String(value);
  }

  getAttribute(key) {
    if (key === 'class') return this.className || this.attributes.get('class') || null;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  click() {
    this.dispatch('click', {target: this});
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  close() {}
  showModal() {}

  querySelectorAll(selector) {
    const parts = selector.split(',').map(part => part.trim()).filter(Boolean);
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (parts.some(part => matchesSelector(child, part))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class StubText extends StubNode {
  constructor(text) {
    super(3, '#text');
    this._text = text;
  }
}

function matchesSelector(node, selector) {
  if (node.nodeType !== 1) return false;
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const attr = selector.slice(1, -1);
    return node.attributes.has(attr) || (attr.startsWith('data-') && attr.slice(5) in node.dataset);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function installStubDom(t) {
  const prevNode = globalThis.Node;
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;

  const byId = new Map();
  const root = new StubNode(1, 'body');
  const getById = id => {
    if (!byId.has(id)) {
      const node = new StubNode(1, 'div');
      node.id = id;
      byId.set(id, node);
      root.append(node);
    }
    return byId.get(id);
  };

  const doc = {
    createElement: tag => new StubNode(1, tag),
    createElementNS: (_ns, tag) => new StubNode(1, tag),
    createTextNode: text => new StubText(text),
    querySelector: selector => {
      if (selector.startsWith('#')) return getById(selector.slice(1));
      return root.querySelector(selector);
    },
    querySelectorAll: selector => root.querySelectorAll(selector),
  };

  globalThis.Node = StubNode;
  globalThis.document = doc;
  globalThis.window = {addEventListener() {}};

  t.after(() => {
    globalThis.Node = prevNode;
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  });

  return {doc, root, getById};
}

function pointInsideRect(point, rect, margin = 0) {
  return point.x > rect.x - margin && point.x < rect.x + rect.width + margin
    && point.y > rect.y - margin && point.y < rect.y + rect.height + margin;
}

function distanceToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function assertFiniteGeometry(geom, label) {
  for (const value of [
    geom.start.x, geom.start.y,
    geom.end.x, geom.end.y,
    geom.label.x, geom.label.y,
    ...(geom.control ? [geom.control.x, geom.control.y] : []),
  ]) {
    assert.ok(Number.isFinite(value), `${label}: 坐标应为有限数值`);
  }
  if (geom.kind === 'path') {
    assert.ok(typeof geom.d === 'string' && !/NaN|Infinity/u.test(geom.d), `${label}: path d 不应含 NaN/Infinity`);
  }
}

function makeMockApp(overrides = {}) {
  const events = overrides.events ?? [
    {事件ID: 'E1', 事件标题: '起始事件', 触发时间: {start: 10, end: 12, 最早: '001年01月'}, 结构: {状态: '正常'}, 确认策略: '自动确认'},
    {事件ID: 'E2', 事件标题: '下游事件', 触发时间: {start: 20, end: 22, 最早: '001年02月'}, 结构: {状态: '正常'}, 确认策略: '条件确认'},
    {事件ID: 'E3', 事件标题: '三层事件', 触发时间: {start: 30, end: 32, 最早: '001年03月'}, 结构: {状态: '正常'}, 确认策略: '仅作候选'},
  ];
  const relations = overrides.relations ?? [
    {from: 'E1', to: 'E2', 种类: '事件确认', 极性: '要求', 字段: '门槛'},
  ];
  let headerCalls = 0;
  let toolbarCalls = 0;
  const state = {
    data: {事件: events, 关系: relations},
    localFocus: 'E1',
    depth: 1,
    layoutDirty: false,
    selected: {type: 'event', id: 'E1'},
    review: {value: {notes: {}, layout: {}}},
    ...overrides.state,
  };
  return {
    state,
    ensureLocalFocus() { if (!state.localFocus) state.localFocus = events[0]?.事件ID ?? ''; },
    eventByID: id => events.find(item => item.事件ID === id) ?? null,
    selectedEvent: () => state.selected?.type === 'event' ? events.find(item => item.事件ID === state.selected.id) ?? null : null,
    eventTimeLabel: event => event.触发时间?.最早 ?? '未声明时间',
    selectEvent(id) { state.selected = {type: 'event', id}; state.localFocus = id; },
    renderHeader() { headerCalls++; },
    renderToolbar() { toolbarCalls++; },
    get headerCalls() { return headerCalls; },
    get toolbarCalls() { return toolbarCalls; },
  };
}

test('YG-FIX-05-A2-1：style.css 局部关系图 SVG 样式与边图层规则正确', async () => {
  const css = await fs.readFile(path.join(project, 'view/public/style.css'), 'utf8');
  const edgesRule = css.match(/\.graph-edges\s*\{([^}]*)\}/u);
  assert.ok(edgesRule, '应存在 .graph-edges 规则');
  const body = edgesRule[1];
  assert.doesNotMatch(body, /width\s*:\s*100%/u, '.graph-edges 不应含 width: 100%');
  assert.doesNotMatch(body, /height\s*:\s*100%/u, '.graph-edges 不应含 height: 100%');
  assert.doesNotMatch(body, /inset\s*:\s*0/u, '.graph-edges 不应含 inset: 0');
  assert.match(body, /left\s*:\s*0/u, '.graph-edges 应固定 left: 0');
  assert.match(body, /top\s*:\s*0/u, '.graph-edges 应固定 top: 0');

  assert.match(css, /\.graph-edge-layer\s+line\s*,\s*\.graph-edge-layer\s+path\s*\{[^}]*fill\s*:\s*none/u,
    '边图层内 path 应显式设置 fill: none 且不波及 defs 内 marker');
  assert.match(css, /\.graph-edge-layer\s+line\.cond\s*,\s*\.graph-edge-layer\s+path\.cond/u);
  assert.match(css, /\.graph-edge-layer\s+line\.exclude\s*,\s*\.graph-edge-layer\s+path\.exclude/u);
  assert.match(css, /\.graph-edge-layer\s+line\.related\s*,\s*\.graph-edge-layer\s+path\.related/u);
  assert.doesNotMatch(css, /\.graph-edges\s+path\s*\{[^}]*fill\s*:\s*none/u,
    '不得全局对 .graph-edges path 设 fill: none 以免清除 defs 内箭头填充');
});

test('YG-FIX-05-A2-2：renderLocalGraph 先挂载再绘边、1:1 坐标系对齐与拖拽同步扩容', async t => {
  installStubDom(t);
  const app = makeMockApp();
  const canvas = document.createElement('div');
  let edgesAtMount = -1;
  const origAppend = canvas.append.bind(canvas);
  canvas.append = (...items) => {
    for (const item of items) {
      if (item instanceof StubNode && item.className === 'graph-wrap') {
        const edgeLayer = item.querySelector('.graph-edge-layer');
        edgesAtMount = edgeLayer ? edgeLayer.children.length : -1;
        for (const btn of item.querySelectorAll('.graph-node')) {
          btn.offsetWidth = 220;
          btn.offsetHeight = 96;
        }
      }
    }
    return origAppend(...items);
  };

  renderLocalGraph(app, canvas);

  assert.equal(edgesAtMount, 0, 'canvas.append(wrap) 应先于首次 drawEdges() 执行');
  const wrap = canvas.querySelector('.graph-wrap');
  const svg = wrap.querySelector('svg');
  const edgeLayer = svg.querySelector('.graph-edge-layer');
  const markersBefore = svg.querySelectorAll('marker');
  assert.equal(markersBefore.length, 3, '应包含 3 个箭头 marker');
  assert.ok(edgeLayer.children.length >= 2, '首次 drawEdges 应在专用边图层内绘制连线与文字');

  const initW = Number(svg.getAttribute('width'));
  const initH = Number(svg.getAttribute('height'));
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${initW} ${initH}`);
  assert.equal(svg.getAttribute('preserveAspectRatio'), 'xMinYMin meet');
  assert.equal(wrap.style.width, `${initW}px`);
  assert.equal(wrap.style.height, `${initH}px`);
  assert.equal(svg.style.width, `${initW}px`);
  assert.equal(svg.style.height, `${initH}px`);

  const nodes = wrap.querySelectorAll('.graph-node');
  const second = nodes[1];
  assert.equal(app.toolbarCalls, 0);

  second.dispatch('pointerdown', {button: 0, clientX: 0, clientY: 0, pointerId: 1});
  second.dispatch('pointermove', {clientX: 900, clientY: 500, pointerId: 1});
  assert.equal(app.state.layoutDirty, true);
  assert.equal(app.toolbarCalls, 1, '首次拖脏应触发一次 renderToolbar()');

  second.dispatch('pointermove', {clientX: 960, clientY: 540, pointerId: 1});
  assert.equal(app.toolbarCalls, 1, '后续连续拖动不应重复触发 renderToolbar()');
  second.dispatch('pointerup', {pointerId: 1});

  const nextW = Number(svg.getAttribute('width'));
  const nextH = Number(svg.getAttribute('height'));
  assert.ok(nextW > initW, `拖拽超界后 SVG width 应扩大 (${nextW} > ${initW})`);
  assert.ok(nextH > initH, `拖拽超界后 SVG height 应扩大 (${nextH} > ${initH})`);
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${nextW} ${nextH}`);
  assert.equal(wrap.style.width, `${nextW}px`);
  assert.equal(wrap.style.height, `${nextH}px`);
  assert.equal(svg.style.width, `${nextW}px`);
  assert.equal(svg.style.height, `${nextH}px`);
  assert.equal(svg.querySelectorAll('marker').length, 3, '重绘边不得破坏 defs 内的 marker');
  assert.equal(svg.querySelector('defs').querySelectorAll('path').length, 3, 'marker 内的箭头 path 应完整保留');
});

test('YG-FIX-05-A3-1：computeEdgeGeometry 在多方位与自定义高度下精确裁剪至卡片外框外侧', () => {
  const cases = [
    ['水平向右', {x: 30, y: 34, width: 220, height: 78}, {x: 330, y: 34, width: 220, height: 78}],
    ['水平向左（反向）', {x: 330, y: 34, width: 220, height: 78}, {x: 30, y: 34, width: 220, height: 78}],
    ['垂直向下', {x: 30, y: 34, width: 220, height: 78}, {x: 30, y: 220, width: 220, height: 78}],
    ['垂直向上', {x: 30, y: 220, width: 220, height: 78}, {x: 30, y: 34, width: 220, height: 78}],
    ['对角右下', {x: 30, y: 34, width: 220, height: 78}, {x: 360, y: 260, width: 220, height: 78}],
    ['非默认卡片高度与窄宽', {x: 20, y: 20, width: 190, height: 124}, {x: 320, y: 180, width: 190, height: 140}],
  ];

  for (const [label, fromRect, toRect] of cases) {
    const geom = computeEdgeGeometry(fromRect, toRect, {sourcePad: 2, targetPad: 4});
    assertFiniteGeometry(geom, label);
    assert.equal(geom.kind, 'line', label);
    assert.equal(pointInsideRect(geom.start, fromRect), false, `${label}: 起点不得落在源卡片内`);
    assert.equal(pointInsideRect(geom.end, toRect), false, `${label}: 终点不得落在目标卡片内`);
    assert.ok(distanceToRect(geom.end, toRect) >= 2, `${label}: 终点应距目标卡片外框至少 2px`);
    assert.equal(pointInsideRect(geom.label, fromRect), false, `${label}: 线标不应落在源卡片内`);
    assert.equal(pointInsideRect(geom.label, toRect), false, `${label}: 线标不应落在目标卡片内`);
  }
});

test('YG-FIX-05-A3-2：双向边、平行多边弧度分流与重叠/自环安全边界', async t => {
  installStubDom(t);
  const rectA = {x: 30, y: 34, width: 220, height: 78};
  const rectB = {x: 330, y: 34, width: 220, height: 78};

  const forward = computeEdgeGeometry(rectA, rectB, {curveOffset: -28});
  const backward = computeEdgeGeometry(rectB, rectA, {curveOffset: -28});
  assertFiniteGeometry(forward, '双向 A->B');
  assertFiniteGeometry(backward, '双向 B->A');
  assert.equal(forward.kind, 'path');
  assert.equal(backward.kind, 'path');
  assert.notEqual(forward.d, backward.d, '双向路径不应重叠');
  assert.ok(Math.abs(forward.control.y - backward.control.y) >= 40, '双向控制点应明显分离');
  assert.ok(Math.abs(forward.label.y - backward.label.y) >= 16, '双向线标应明显分离');

  const overlapPartial = computeEdgeGeometry(
    {x: 30, y: 34, width: 220, height: 78},
    {x: 80, y: 50, width: 220, height: 78},
  );
  assertFiniteGeometry(overlapPartial, '部分重叠');

  const overlapExact = computeEdgeGeometry(
    {x: 30, y: 34, width: 220, height: 78},
    {x: 30, y: 34, width: 220, height: 78},
    {selfLoop: false},
  );
  assertFiniteGeometry(overlapExact, '完全重合');

  const loop = computeEdgeGeometry(rectA, rectA, {selfLoop: true});
  assertFiniteGeometry(loop, '自环');
  assert.equal(loop.kind, 'path');
  assert.equal(pointInsideRect(loop.start, rectA), false, '自环起点应在卡片外侧');
  assert.equal(pointInsideRect(loop.end, rectA), false, '自环终点应在卡片外侧');

  const app = makeMockApp({
    relations: [
      {from: 'E1', to: 'E2', 种类: '事件确认', 极性: '要求', 字段: '门槛'},
      {from: 'E2', to: 'E1', 种类: '普通关联', 极性: '普通', 字段: '关联事件'},
      {from: 'E1', to: 'E1', 种类: '普通关联', 极性: '普通', 字段: '自引用'},
    ],
  });
  const canvas = document.createElement('div');
  renderLocalGraph(app, canvas);
  const edgeLayer = canvas.querySelector('.graph-edge-layer');
  const paths = edgeLayer.querySelectorAll('path');
  const texts = edgeLayer.querySelectorAll('text');
  assert.equal(paths.length, 3, '双向边与自环应均渲染为 path');
  assert.equal(texts.length, 3, '每条边应对应一个线标');
  assert.notEqual(paths[0].getAttribute('d'), paths[1].getAttribute('d'));
  assert.notEqual(texts[0].getAttribute('y'), texts[1].getAttribute('y'));
});

test('YG-FIX-05-A4：切换层数刷新左侧导航徽标、切换焦点刷新顶部焦点文案', async t => {
  const {getById} = installStubDom(t);
  const payload = {
    token: 'test-token',
    review: {revision: 'r1', value: {notes: {}, layout: {}}},
    服务: {},
    分类: {主类型: [], 标签: [], 事件结果: []},
    元数据: {
      计数: {事件: 3, 事件串: 0, 角色组: 0, 档案: 0, 条目: 0},
      检查: {错误: 0, 提示: 0, 错误列表: []},
      日历: {年天数: 365, 前缀: '', 年位数: 4},
      数据异常: [],
    },
    事件: [
      {事件ID: 'E1', 事件标题: '甲事件', 触发时间: {start: 10, end: 11, 最早: '001年'}, 结构: {状态: '正常'}, 确认策略: '自动确认', 分支: [], 角色位置: []},
      {事件ID: 'E2', 事件标题: '乙事件', 触发时间: {start: 20, end: 21, 最早: '002年'}, 结构: {状态: '正常'}, 确认策略: '自动确认', 分支: [], 角色位置: []},
      {事件ID: 'E3', 事件标题: '丙事件', 触发时间: {start: 30, end: 31, 最早: '003年'}, 结构: {状态: '正常'}, 确认策略: '自动确认', 分支: [], 角色位置: []},
    ],
    事件串: [],
    角色组: [],
    开局: {方案: []},
    关系: [
      {from: 'E1', to: 'E2', 种类: '事件确认', 极性: '要求', 字段: '门槛'},
      {from: 'E2', to: 'E3', 种类: '事件确认', 极性: '要求', 字段: '门槛'},
    ],
  };

  globalThis.fetch = async () => ({ok: true, status: 200, json: async () => payload});

  await import(`../view/public/app.js?t=${Date.now()}`);
  await new Promise(resolve => setImmediate(resolve));

  const views = getById('views');
  const findLocalNavBtn = () => views.querySelectorAll('button').find(btn => btn.textContent.includes('局部关系'));
  const localBtn = findLocalNavBtn();
  assert.ok(localBtn, '左侧导航应包含「局部关系」按钮');
  localBtn.click();

  assert.match(findLocalNavBtn().textContent, /层 1/u, '初始深度应显示 层 1');
  const controls = getById('viewControls');
  assert.match(controls.textContent, /焦点：甲事件/u, '初始焦点应为甲事件');

  const depth2Btn = controls.querySelectorAll('button').find(btn => btn.textContent === '2 层');
  assert.ok(depth2Btn, '工具栏应包含 2 层按钮');
  depth2Btn.click();
  assert.match(findLocalNavBtn().textContent, /层 2/u, '点击 2 层后左侧导航徽标应即时变为 层 2');

  const depth3Btn = controls.querySelectorAll('button').find(btn => btn.textContent === '3 层');
  assert.ok(depth3Btn, '工具栏应包含 3 层按钮');
  depth3Btn.click();
  assert.match(findLocalNavBtn().textContent, /层 3/u, '点击 3 层后左侧导航徽标应即时变为 层 3');

  const canvas = getById('canvas');
  const eventBNode = canvas.querySelectorAll('.graph-node').find(btn => btn.textContent.includes('乙事件'));
  assert.ok(eventBNode, '画布应渲染乙事件节点');
  eventBNode.click();
  assert.match(getById('viewControls').textContent, /焦点：乙事件/u, '点击另一事件节点后顶部焦点文案应即时更新');
});
