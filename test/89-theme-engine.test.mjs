import os from 'node:os';
import {test, assert, fs, path, project} from './helpers.mjs';
import {
  BUILTIN_THEMES, BUILTIN_THEME_IDS, DEFAULT_APPEARANCE, MAX_THEME_CSS_BYTES,
  validateThemeCss, validateThemeEntry, sanitizeCustomCss, resolveAppearance,
  buildThemeCss, enhanceProseNode, clearProseEnhancements,
} from '../adapter/themes.mjs';
import {installStyle, floorNode, settingsNode} from '../adapter/ui.mjs';
import {
  SETTINGS_KEY, APPEARANCE_KEY, appearanceSettings, saveAppearance,
} from '../adapter/settings.mjs';
import {packCard, PackError} from '../adapter/pack.mjs';

const FORBIDDEN_METHODS = new Set([
  'html', 'removeClass', 'toggleClass', 'prepend', 'find',
  'closest', 'parent', 'siblings', 'children', 'data',
]);

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
  return {headChildren, find: (root, pred) => findAll(root, pred)[0], findAll};
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
  return () => structuredClone(store);
}

// 轻量纯 Node DOM 子集（仅用于测试 enhanceProseNode / clearProseEnhancements 的 TreeWalker 与 unwrap 行为）
function createMiniDom() {
  class MiniNode {
    constructor(nodeType, ownerDocument) {
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    appendChild(child) {
      if (child.nodeType === 11) {
        while (child.firstChild) this.appendChild(child.firstChild);
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (child.nodeType === 11) {
        while (child.firstChild) this.insertBefore(child.firstChild, ref);
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      const idx = ref ? this.childNodes.indexOf(ref) : -1;
      child.parentNode = this;
      if (idx === -1) this.childNodes.push(child);
      else this.childNodes.splice(idx, 0, child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    replaceChild(next, old) {
      this.insertBefore(next, old);
      return this.removeChild(old);
    }
    normalize() {
      for (let i = 0; i < this.childNodes.length; i++) {
        const cur = this.childNodes[i];
        if (cur.nodeType === 3) {
          while (i + 1 < this.childNodes.length && this.childNodes[i + 1].nodeType === 3) {
            cur.nodeValue += this.childNodes[i + 1].nodeValue;
            this.removeChild(this.childNodes[i + 1]);
          }
        } else if (cur.nodeType === 1) {
          cur.normalize();
        }
      }
    }
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map(c => c.textContent).join('');
    }
    set textContent(v) {
      if (this.nodeType === 3) { this.nodeValue = String(v); return; }
      this.childNodes = [];
      if (v) this.appendChild(this.ownerDocument.createTextNode(String(v)));
    }
  }
  class MiniText extends MiniNode {
    constructor(value, doc) { super(3, doc); this.nodeValue = String(value); }
  }
  class MiniFragment extends MiniNode {
    constructor(doc) { super(11, doc); }
  }
  class MiniElement extends MiniNode {
    constructor(tag, doc) {
      super(1, doc);
      this.tagName = tag.toUpperCase();
      this.attrs = {};
      this._classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(n => this._classes.add(n)),
        remove: (...names) => names.forEach(n => this._classes.delete(n)),
        contains: name => this._classes.has(name),
      };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    querySelectorAll(selector) {
      const out = [];
      const match = el => {
        if (selector === '.ygg-dialogue[data-ygg-enhanced="1"]') {
          return el.classList.contains('ygg-dialogue') && el.getAttribute('data-ygg-enhanced') === '1';
        }
        if (selector === '.ygg-dialogue') return el.classList.contains('ygg-dialogue');
        return false;
      };
      const walk = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (match(child)) out.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return out;
    }
  }
  const doc = {
    createElement: tag => new MiniElement(tag, doc),
    createTextNode: text => new MiniText(text, doc),
    createDocumentFragment: () => new MiniFragment(doc),
    createTreeWalker(root, whatToShow) {
      const nodes = [];
      const walk = n => {
        for (const child of n.childNodes) {
          if (whatToShow === 4 && child.nodeType === 3) nodes.push(child);
          if (child.childNodes?.length) walk(child);
        }
      };
      walk(root);
      let idx = -1;
      return {nextNode: () => (++idx < nodes.length ? nodes[idx] : null)};
    },
  };
  return doc;
}

test('YG-THEME-01-A2：4 套内置主题完整零外链，resolveAppearance 优先级与回退准确', () => {
  assert.deepEqual(BUILTIN_THEMES.map(t => t.id), ['modern', 'classic', 'fantasy', 'cyber']);
  assert.deepEqual([...BUILTIN_THEME_IDS], ['modern', 'classic', 'fantasy', 'cyber']);

  for (const theme of BUILTIN_THEMES) {
    assert.equal(theme.source, 'builtin');
    assert.ok(theme.name && theme.description);
    const resolved = resolveAppearance({主题: theme.id}, []);
    assert.equal(resolved.themeId, theme.id);
    const css = buildThemeCss(resolved);
    assert.ok(css.includes(`[data-ygg-theme="${theme.id}"]`));
    assert.doesNotMatch(css, /https?:\/\//i, `${theme.id} 不得含外链`);
    assert.doesNotMatch(css, /@import\b/i, `${theme.id} 不得含 @import`);
  }

  // auto：无卡主题时回退 modern；有卡主题时优先 default === true，否则取第一个
  assert.equal(resolveAppearance({主题: 'auto'}, []).themeId, 'modern');
  const cardThemes = [
    {id: 'ink-a', name: '水墨甲', description: '甲', source: 'card', default: false, base: 'classic', tokens: {}, layout: {每楼形态: 'minimal'}, css: ''},
    {id: 'ink-b', name: '水墨乙', description: '乙', source: 'card', default: true, base: 'fantasy', tokens: {'--ygg-accent': '#a12345'}, layout: {每楼形态: 'card', 首行缩进: true}, css: ''},
  ];
  assert.equal(resolveAppearance({主题: 'auto'}, cardThemes).themeId, 'ink-b');
  assert.equal(resolveAppearance({主题: 'auto'}, [cardThemes[0]]).themeId, 'ink-a');
  assert.equal(resolveAppearance({主题: 'ink-a'}, cardThemes).themeId, 'ink-a');
  // 失效主题 ID 安全静默回退到默认主题
  assert.equal(resolveAppearance({主题: 'removed-card-theme'}, cardThemes).themeId, 'ink-b');
  assert.equal(resolveAppearance({主题: 'removed-card-theme'}, []).themeId, 'modern');

  // 布局优先级：玩家显式配置 > 主题推荐 layout > 基座/系统默认
  const fromTheme = resolveAppearance({主题: 'ink-b', 每楼形态: 'auto', 首行缩进: null}, cardThemes);
  assert.equal(fromTheme.每楼形态, 'card');
  assert.equal(fromTheme.首行缩进, true);
  const overridden = resolveAppearance({主题: 'ink-b', 每楼形态: 'minimal', 首行缩进: false, 正文字号: 1.5, 正文行距: 0.8}, cardThemes);
  assert.equal(overridden.每楼形态, 'minimal');
  assert.equal(overridden.首行缩进, false);
  assert.equal(overridden.正文字号, 1.2);
  assert.equal(overridden.正文行距, 1.5);
});

test('YG-THEME-01-A2：validateThemeCss / validateThemeEntry 拦截全部安全红线，sanitizeCustomCss 安全消毒', () => {
  const badCssSamples = [
    '.ygg-panel { background: url(https://evil.example/a.png); }',
    '.ygg-panel { background: url(http://evil.example/a.png); }',
    '@import url("foo.css"); .ygg-panel { color: red; }',
    '.ygg-panel { content: "</style><script>alert(1)</script>"; }',
    '.ygg-panel { background: url(javascript:alert(1)); }',
    '.ygg-panel { width: expression(alert(1)); }',
    '.ygg-panel { behavior: url(xss.htc); }',
    '.ygg-panel { -moz-binding: url(xss.xml); }',
    'body { background: red; }',
    'html { font-size: 20px; }',
    '* { margin: 0; }',
    '#chat { display: none; }',
    '@media (max-width: 640px) { body { color: red; } }',
    '.ygg-panel { color: red; }\n' + 'a'.repeat(MAX_THEME_CSS_BYTES + 64),
  ];
  for (const sample of badCssSamples) {
    const res = validateThemeCss(sample, {strict: true});
    assert.equal(res.ok, false, `应拦截危险 CSS：${sample.slice(0, 60)}`);
  }

  // 合法作用域 CSS 应通过
  assert.equal(validateThemeCss('.ygg-panel * { color: inherit; } [data-ygg-theme="demo"] .ygg-floor { border-width: 2px; }', {strict: true}).ok, true);

  // validateThemeEntry 拦截保留字、内置重名、重复 ID、非法令牌键
  assert.throws(() => validateThemeEntry({id: 'modern', name: '冒充内置'}), /内置主题重名/);
  assert.throws(() => validateThemeEntry({id: 'auto', name: '保留字'}), /保留字/);
  assert.throws(() => validateThemeEntry({id: 'dup', name: '重复'}, {existingIds: new Set(['dup'])}), /重复/);
  assert.throws(() => validateThemeEntry({id: 'bad-token', name: '坏令牌', tokens: {'--SmartThemeBodyColor': '#000'}}), /非法令牌键/);
  assert.throws(() => validateThemeEntry({id: 'bad-css', name: '坏样式', css: 'body { color: red; }'}), /CSS 校验失败/);

  // 合法卡主题通过并规范化
  const ok = validateThemeEntry({
    ID: 'scroll-gold', 名称: '金卷', 说明: '测试卡主题', 默认: true, 基座: 'classic',
    令牌: {'--ygg-accent': '#b8432e'}, 布局: {每楼形态: 'card', 首行缩进: true},
    样式: '.ygg-panel { border-color: #b8432e; }',
  });
  assert.equal(ok.id, 'scroll-gold');
  assert.equal(ok.source, 'card');
  assert.equal(ok.default, true);
  assert.equal(ok.base, 'classic');

  // sanitizeCustomCss 安全剥离危险片段且不抛错
  const dirty = '@import "a.css"; .ygg-panel { background: url(https://x.test/1.png); color: red; } </style><script>x</script> .ygg-floor { width: expression(1); behavior: x; -moz-binding: y; }';
  const cleaned = sanitizeCustomCss(dirty);
  assert.doesNotMatch(cleaned, /@import|https?:\/\/|<\/style|expression\(|behavior:|-moz-binding/i);
  assert.match(cleaned, /color:\s*red/);
});

test('YG-THEME-01-A3：无损对白高亮跳过 code/pre/a 且幂等，clearProseEnhancements 逐字还原', () => {
  const doc = createMiniDom();
  const root = doc.createElement('div');
  const p1 = doc.createElement('p');
  p1.appendChild(doc.createTextNode('他抬头笑道：“今日风清气朗。”随后低声说「不可轻举妄动」与『慎之』。'));
  const p2 = doc.createElement('p');
  const code = doc.createElement('code');
  code.textContent = '“代码内引号不包裹”';
  const pre = doc.createElement('pre');
  pre.textContent = '「预格式化不包裹」';
  const link = doc.createElement('a');
  link.textContent = '『链接不包裹』';
  p2.appendChild(code);
  p2.appendChild(pre);
  p2.appendChild(link);
  root.appendChild(p1);
  root.appendChild(p2);

  const originalText = root.textContent;
  const first = enhanceProseNode(root, {dialogue: true});
  assert.equal(first.wrapped, 3, '应精准包裹 3 处正文对白引号');
  assert.equal(root.textContent, originalText, '包裹后 textContent 必须逐字不变');
  assert.equal(root.querySelectorAll('.ygg-dialogue[data-ygg-enhanced="1"]').length, 3);
  assert.equal(code.querySelectorAll('.ygg-dialogue').length, 0, 'code 内不得包裹');
  assert.equal(pre.querySelectorAll('.ygg-dialogue').length, 0, 'pre 内不得包裹');
  assert.equal(link.querySelectorAll('.ygg-dialogue').length, 0, 'a 内不得包裹');

  // 幂等：重复执行不二次包裹
  const second = enhanceProseNode(root, {dialogue: true});
  assert.equal(second.wrapped, 0, '幂等防重复包裹');
  assert.equal(root.querySelectorAll('.ygg-dialogue[data-ygg-enhanced="1"]').length, 3);

  // 无损还原
  const cleared = clearProseEnhancements(root);
  assert.equal(cleared.unwrapped, 3);
  assert.equal(root.querySelectorAll('.ygg-dialogue').length, 0);
  assert.equal(root.textContent, originalText, '还原后 textContent 必须逐字一致');
});

test('YG-THEME-01-A3：floorNode 3 种形态与 settingsNode 外观热刷新/独立持久化于严格 13 方法 $ 桩零抛错', async t => {
  const {headChildren, find, findAll} = makeStrictDomMock(t);
  const readStore = mockGlobalVars(t, {[SETTINGS_KEY]: {方式: '同一模型', 每楼记录: true, 调试: false}});

  // installStyle 注入主样式与自定义样式，且 .ygg-prose-host 具备基础 --ygg-* 令牌定义
  installStyle({主题: 'classic', 自定义CSS: '.ygg-panel { --ygg-accent: #123456; }'});
  const styleNode = headChildren.find(n => n.attrs.id === 'ygg-style');
  assert.ok(styleNode);
  assert.ok(headChildren.some(n => n.attrs.id === 'ygg-custom-style'));
  const baseTokenBlock = styleNode.text().match(/\.ygg-panel,\s*\.ygg-floor,\s*\.ygg-prose-host\s*\{([^}]*)\}/);
  assert.ok(baseTokenBlock, '#ygg-style 应包含 .ygg-panel, .ygg-floor, .ygg-prose-host 共享基础令牌块');
  for (const token of ['--ygg-text', '--ygg-muted', '--ygg-accent', '--ygg-border-strong']) {
    assert.ok(baseTokenBlock[1].includes(`${token}:`), `.ygg-prose-host 共享块应定义 ${token}`);
  }
  assert.doesNotMatch(baseTokenBlock[1], /\bcolor\s*:|\bbox-sizing\s*:|\bline-height\s*:/, '共享令牌块不得覆写宿主正文字色/盒模型/行距');

  // installStyle 在存在浏览器 document 时同步已挂载 .ygg-panel / .ygg-floor 的 data-ygg-theme
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const docElAttrs = {};
  const mountedPanelAttrs = {'data-ygg-theme': 'modern'};
  const mountedFloorAttrs = {'data-ygg-theme': 'modern'};
  globalThis.document = {
    documentElement: {setAttribute: (k, v) => { docElAttrs[k] = v; }},
    querySelectorAll: sel => sel.includes('.ygg-panel[data-ygg-theme]')
      ? [
          {setAttribute: (k, v) => { mountedPanelAttrs[k] = v; }},
          {setAttribute: (k, v) => { mountedFloorAttrs[k] = v; }},
        ]
      : [],
  };
  try {
    installStyle({主题: 'cyber'});
    assert.equal(docElAttrs['data-ygg-theme'], 'cyber');
    assert.equal(mountedPanelAttrs['data-ygg-theme'], 'cyber');
    assert.equal(mountedFloorAttrs['data-ygg-theme'], 'cyber');
    installStyle({主题: 'modern'});
    assert.equal(docElAttrs['data-ygg-theme'], 'modern');
    assert.equal(mountedPanelAttrs['data-ygg-theme'], 'modern');
    assert.equal(mountedFloorAttrs['data-ygg-theme'], 'modern');
  } finally {
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
    else delete globalThis.document;
  }

  // floorNode 3 种形态
  const sampleLine = {摘要: '地点 涿县·桃园；在场 +张飞', 详情: [['地点', ['涿县·桃园']]], 失败: false};
  const scene = {时间: '中平001年04月02日', 地点: '涿县·桃园', 在场: ['刘备', '关羽', '张飞']};

  const barNode = floorNode(sampleLine, {variant: 'bar', scene, rekeep: () => {}, repair: () => {}});
  assert.ok(barNode.classes.includes('ygg-floor-bar'));
  assert.match(barNode.text(), /^记账\n地点 涿县·桃园/);

  const cardNode = floorNode(sampleLine, {variant: 'card', scene, rekeep: () => {}, repair: () => {}});
  assert.ok(cardNode.classes.includes('ygg-floor-card'));
  assert.equal(findAll(cardNode, n => n.classes.includes('ygg-scene-pill')).length, 3);
  assert.match(cardNode.text(), /中平001年04月02日/);
  assert.match(cardNode.text(), /涿县·桃园/);
  assert.match(cardNode.text(), /刘备、关羽、张飞/);

  // card 模式未传 scene 时优雅退化
  const cardDegraded = floorNode(sampleLine, {variant: 'card'});
  assert.equal(findAll(cardDegraded, n => n.classes.includes('ygg-scene-pill')).length, 0);
  assert.match(cardDegraded.text(), /地点 涿县·桃园/);

  const minNode = floorNode(sampleLine, {variant: 'minimal', scene});
  assert.ok(minNode.classes.includes('ygg-floor-minimal'));
  assert.match(minNode.text(), /地点 涿县·桃园/);

  // settingsNode 向后兼容：不传 appearance 时 0 抛错
  const legacySettings = settingsNode({
    current: {方式: '同一模型', 代理预设: '', 地址: '', 密钥: '', 模型: '', 来源: 'openai', 温度: 0.2, 最大长度: 0, 尝试次数: 2, 应答格式: '提示词', 每楼记录: true, 调试: false},
    save: () => Promise.resolve(),
    pull: async () => [],
    test: async () => ({文本: 'ok'}),
  });
  assert.equal(find(legacySettings, n => n.attrs['data-ygg-setting'] === 'theme'), undefined);

  // settingsNode 传入 appearance：切换主题/每楼形态/自定义 CSS 即时热刷新并写入 世界树·外观，绝不污染 世界树·记账
  const hotChanges = [];
  const fullSettings = settingsNode({
    current: {方式: '同一模型', 代理预设: '', 地址: '', 密钥: '', 模型: '', 来源: 'openai', 温度: 0.2, 最大长度: 0, 尝试次数: 2, 应答格式: '提示词', 每楼记录: true, 调试: false},
    save: () => Promise.resolve(),
    pull: async () => [],
    test: async () => ({文本: 'ok'}),
    appearance: appearanceSettings(),
    saveAppearance,
    cardThemes: [],
    onAppearanceChange: next => hotChanges.push(next),
  });
  const themeSel = find(fullSettings, n => n.attrs['data-ygg-setting'] === 'theme');
  const variantSel = find(fullSettings, n => n.attrs['data-ygg-setting'] === 'floorVariant');
  const cssArea = find(fullSettings, n => n.attrs['data-ygg-setting'] === 'customCss');
  const resetBtn = find(fullSettings, n => n.tag === '<button>' && n.text() === '恢复默认外观');
  assert.ok(themeSel && variantSel && cssArea && resetBtn);
  assert.equal(fullSettings.attrs['data-ygg-theme'], 'modern');

  themeSel.handlers.change({target: {value: 'cyber'}});
  assert.equal(fullSettings.attrs['data-ygg-theme'], 'cyber', '切换主题时设置表单根节点 data-ygg-theme 应立即同步');
  variantSel.handlers.change({target: {value: 'card'}});
  cssArea.handlers.change({target: {value: '.ygg-panel { --ygg-accent: #00ffcc; }'}});
  await saveAppearance({}); // 等待串行队列落盘

  assert.equal(hotChanges.length, 3);
  assert.equal(hotChanges.at(-1).主题, 'cyber');
  assert.equal(hotChanges.at(-1).每楼形态, 'card');
  const persisted = readStore();
  assert.equal(persisted[APPEARANCE_KEY].主题, 'cyber');
  assert.equal(persisted[APPEARANCE_KEY].每楼形态, 'card');
  assert.equal(persisted[APPEARANCE_KEY].自定义CSS, '.ygg-panel { --ygg-accent: #00ffcc; }');
  assert.deepEqual(persisted[SETTINGS_KEY], {方式: '同一模型', 每楼记录: true, 调试: false}, '绝不能污染 世界树·记账');

  // 点击恢复默认外观：表单根节点同步回到 modern
  resetBtn.handlers.click({preventDefault: () => {}});
  assert.equal(fullSettings.attrs['data-ygg-theme'], 'modern', '恢复默认外观后设置表单根节点应同步回退为 modern');
});

test('YG-THEME-01-A4：ygg pack 打包 <项目目录>/外观/ 正反例与世界书哈希零变化', async t => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-theme-pack-'));
  t.after(() => fs.rm(tmpRoot, {recursive: true, force: true}));

  const projDir = path.join(tmpRoot, 'proj');
  const adapterDir = path.join(tmpRoot, 'adapter');
  await fs.cp(path.join(project, 'test/fixtures/雾港'), projDir, {recursive: true});
  await fs.mkdir(adapterDir, {recursive: true});
  const faceFile = path.join(projDir, '卡面.yaml');
  const silent = {write() {}};

  // 1) 无 外观/ 目录：bundle.themes 为 []，记录基准世界书哈希
  const baseRes = await packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent});
  const baseBundle = JSON.parse(await fs.readFile(baseRes.bundleFile, 'utf8'));
  assert.deepEqual(baseBundle.themes, []);
  const baseHash = baseRes.manifest.世界书哈希;

  // 2) 单主题 外观/主题.yaml + 样式.css：打包成功，世界书哈希逐字节一致
  const themesDir = path.join(projDir, '外观');
  await fs.mkdir(themesDir, {recursive: true});
  await fs.writeFile(path.join(themesDir, '主题.yaml'), [
    'id: harbor-mist',
    'name: 雾港手记',
    'description: 潮湿雾气与暖灯色调',
    'default: true',
    'base: classic',
    'tokens:',
    '  --ygg-accent: "#5e8f8b"',
    'layout:',
    '  每楼形态: card',
    '  首行缩进: true',
  ].join('\n'));
  await fs.writeFile(path.join(themesDir, '样式.css'), '.ygg-panel { border-color: #5e8f8b; }\n');

  const singleRes = await packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent});
  const singleBundle = JSON.parse(await fs.readFile(singleRes.bundleFile, 'utf8'));
  assert.equal(singleRes.manifest.世界书哈希, baseHash, '新增 外观/ 不得改变世界书哈希');
  assert.equal(singleBundle.themes.length, 1);
  assert.equal(singleBundle.themes[0].id, 'harbor-mist');
  assert.equal(singleBundle.themes[0].default, true);
  assert.match(singleBundle.themes[0].css, /#5e8f8b/);
  assert.ok(!Object.keys(singleBundle.files).some(k => k.includes('外观')), '外观文件不得进入 bundle.files');

  // 3) 多主题子目录：按码点序收集，世界书哈希仍逐字节一致
  const subDir = path.join(themesDir, 'night-watch');
  await fs.mkdir(subDir, {recursive: true});
  await fs.writeFile(path.join(subDir, '主题.yaml'), [
    'id: night-watch',
    'name: 守夜终端',
    'base: cyber',
    'tokens:',
    '  --ygg-accent: "#22d3ee"',
  ].join('\n'));
  const multiRes = await packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent});
  const multiBundle = JSON.parse(await fs.readFile(multiRes.bundleFile, 'utf8'));
  assert.equal(multiRes.manifest.世界书哈希, baseHash);
  assert.deepEqual(multiBundle.themes.map(item => item.id), ['harbor-mist', 'night-watch']);

  // 4) 负例：含 @import / 外链 / 非法令牌 / 符号链接均以 PackError 拦截
  await fs.writeFile(path.join(subDir, '样式.css'), '@import "https://evil.test/x.css";\n');
  await assert.rejects(() => packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent}), PackError);

  await fs.writeFile(path.join(subDir, '样式.css'), '.ygg-panel { background: url(https://evil.test/bg.png); }\n');
  await assert.rejects(() => packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent}), PackError);

  await fs.rm(path.join(subDir, '样式.css'));
  await fs.writeFile(path.join(subDir, '主题.yaml'), 'id: night-watch\nname: 坏令牌\ntokens:\n  --bad-key: "#fff"\n');
  await assert.rejects(() => packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent}), PackError);

  // 符号链接拦截
  await fs.rm(subDir, {recursive: true, force: true});
  await fs.symlink(path.join(projDir, '卡面.yaml'), path.join(themesDir, 'bad-link.css'));
  await assert.rejects(() => packCard({projectDir: projDir, faceFile, prepareOnly: true, repo: project, adapterDir, stdout: silent, stderr: silent}), PackError);
});
