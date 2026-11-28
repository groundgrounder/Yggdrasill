import {test, assert, fs, path, project} from './helpers.mjs';
import {
  BUILTIN_THEMES, resolveAppearance, buildThemeCss, validateThemeEntry,
} from '../adapter/themes.mjs';
import {installStyle, applyProseAppearance} from '../adapter/ui.mjs';
import {parseThemeYaml} from '../skills/ygg-theme/scripts/theme-tool.mjs';

const FORBIDDEN_METHODS = new Set([
  'html', 'removeClass', 'toggleClass', 'prepend', 'find',
  'closest', 'parent', 'siblings', 'children', 'data',
]);

function makeStrictDomMock(t) {
  const savedDollar = Object.getOwnPropertyDescriptor(globalThis, '$');
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const headChildren = [];
  const headNode = {
    append: (...items) => { headChildren.push(...items.flat(Infinity).filter(Boolean)); return headNode; },
  };
  t.after(() => {
    if (savedDollar) Object.defineProperty(globalThis, '$', savedDollar);
    else delete globalThis.$;
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
    else delete globalThis.document;
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
  delete globalThis.document;
  return {
    getStyleCss: () => headChildren.find(n => n.attrs.id === 'ygg-style')?.text() ?? '',
  };
}

// 计算单条 CSS 复杂选择器的 (ID, class/attr/pseudo-class, type) 特异性元组，支持 :not(...) / :is(...)
function specificityOf(selector) {
  let ids = 0;
  let classes = 0;
  let types = 0;
  let s = selector.trim();

  // 递归展开 :not(...) 与 :is(...) 取内部最大特异性
  const funcRe = /:(?:not|is)\(([^()]+)\)/g;
  while (funcRe.test(s)) {
    s = s.replace(funcRe, (_, inner) => {
      const alts = inner.split(',').map(part => specificityOf(part));
      alts.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]));
      const best = alts[0] ?? [0, 0, 0];
      ids += best[0];
      classes += best[1];
      types += best[2];
      return '';
    });
  }

  s = s.replace(/\[[^\]]+\]/g, () => { classes += 1; return ''; });
  s = s.replace(/#[a-zA-Z0-9_-]+/g, () => { ids += 1; return ''; });
  s = s.replace(/\.[a-zA-Z0-9_-]+/g, () => { classes += 1; return ''; });
  s = s.replace(/::[a-zA-Z0-9_-]+/g, () => { types += 1; return ''; });
  s = s.replace(/:[a-zA-Z0-9_-]+/g, () => { classes += 1; return ''; });
  for (const token of s.split(/[\s>+~]+/).filter(Boolean)) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) types += 1;
  }
  return [ids, classes, types];
}

function compareSpecificity(a, b) {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function createMiniProseDom() {
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
        if (selector.includes('.mes_text')) return el.classList.contains('mes_text');
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

test('YG-FIX-07-1：透明 --SmartThemeBorderColor 场景下 --ygg-border / --ygg-border-strong 以 --ygg-text 保底不隐身', t => {
  const {getStyleCss} = makeStrictDomMock(t);
  installStyle({主题: 'modern'});
  const css = getStyleCss();

  const borderMatch = css.match(/--ygg-border:\s*color-mix\(in srgb,\s*var\(--SmartThemeBorderColor,\s*transparent\)\s*(\d+)%,\s*color-mix\(in srgb,\s*var\(--ygg-text\)\s*(\d+)%,\s*transparent\)\);/);
  assert.ok(borderMatch, '--ygg-border 须以 var(--ygg-text) 低透明度作保底混色');
  const strongMatch = css.match(/--ygg-border-strong:\s*color-mix\(in srgb,\s*var\(--SmartThemeBorderColor,\s*transparent\)\s*(\d+)%,\s*color-mix\(in srgb,\s*var\(--ygg-text\)\s*(\d+)%,\s*transparent\)\);/);
  assert.ok(strongMatch, '--ygg-border-strong 须以 var(--ygg-text) 保底混色');

  // 数值校验：border_color alpha 为 0、0.14、1 时，--ygg-border 最终 alpha 均落在 [0.12, 0.50]
  const p1 = Number(borderMatch[1]) / 100;
  const fallbackAlpha = Number(borderMatch[2]) / 100;
  for (const [label, borderAlpha, textAlpha] of [
    ['transparent-dark', 0, 1],
    ['transparent-light', 0, 1],
    ['low-alpha-host', 0.14, 0.95],
    ['opaque-host', 1, 1],
  ]) {
    const computedAlpha = p1 * borderAlpha + (1 - p1) * (fallbackAlpha * textAlpha);
    assert.ok(
      computedAlpha >= 0.12 && computedAlpha <= 0.5,
      `${label} 下 --ygg-border alpha=${computedAlpha.toFixed(4)} 应在 [0.12, 0.50] 区间`,
    );
  }
});

test('YG-FIX-07-2/3：宽弹窗精准保护不误伤普通弹窗、.ygg-panel 容器响应降列与 h3 左对齐保护', t => {
  const {getStyleCss} = makeStrictDomMock(t);
  installStyle({主题: 'modern'});
  const css = getStyleCss();

  // 1) 精准限定仅作用于含 .ygg-panel 的宽/大弹窗，不裸写 dialog.popup
  assert.match(
    css,
    /dialog\.popup:is\(\.wide_dialogue_popup,\s*\.large_dialogue_popup\):has\(\.ygg-panel\)\s*\{[^}]*width:\s*min\(880px,\s*calc\(100dvw\s*-\s*32px\)\)\s*!important;/,
    '须精准保护含 .ygg-panel 的宽/大弹窗宽度',
  );
  assert.doesNotMatch(css, /(?:^|[\n}])\s*dialog\.popup\s*\{/, '严禁对不含 .ygg-panel 的普通 dialog.popup 注入全局宽度规则');

  // 2) .ygg-panel 启用 container-type: inline-size 且 @container (max-width: 580px) 覆盖全部多列网格
  assert.match(css, /\.ygg-panel\s*\{[^}]*container-type:\s*inline-size;/, '.ygg-panel 须启用 container-type: inline-size');
  const containerBlocks = [...css.matchAll(/@container\s*\(\s*max-width:\s*580px\s*\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]);
  assert.ok(containerBlocks.length >= 1, '须包含 @container (max-width: 580px) 响应式规则');
  const combinedContainer = containerBlocks.join('\n');
  for (const selector of [
    '.ygg-form .ygg-grid',
    '.ygg-appearance-grid',
    '.ygg-range-grid',
    '.ygg-opening .ygg-opening-time-grid',
    '.ygg-opening .ygg-group-row',
    '.ygg-opening .ygg-preview-grid',
    '.ygg-hero-grid',
  ]) {
    assert.ok(combinedContainer.includes(selector), `@container (max-width: 580px) 须包含 ${selector}`);
  }

  // 3) 面板标题 h3 左对齐保护
  const h3Rule = css.match(/\.ygg-panel\s+h3,\s*\.ygg-panel\s+\.ygg-panel-head\s+h3\s*\{([^}]*)\}/);
  assert.ok(h3Rule, '须显式保护 .ygg-panel h3 与 .ygg-panel .ygg-panel-head h3');
  assert.match(h3Rule[1], /text-align:\s*left\s*!important;/);
  assert.match(h3Rule[1], /margin:\s*0\s*!important;/);
});

test('YG-FIX-07-4：正文美化高权重抗合成宿主覆盖、4 套内置与三国主题令牌映射完整、不覆写 code/pre', async t => {
  const {getStyleCss} = makeStrictDomMock(t);
  const sanguoDir = path.join(project, 'examples', '三国演义', '外观');
  const sanguoRaw = parseThemeYaml(await fs.readFile(path.join(sanguoDir, '主题.yaml'), 'utf8'));
  const sanguoCss = await fs.readFile(path.join(sanguoDir, '样式.css'), 'utf8');
  const sanguoTheme = validateThemeEntry({...sanguoRaw, css: sanguoCss});

  // 合成高权重宿主冲突选择器（模拟双 ID 宿主对 #chat .mes .mes_text 的 !important 覆盖）
  const hostTextSpec = specificityOf('html body.host-theme:not(#_):not(#__) #chat .mes .mes_text');
  const hostBqSpec = specificityOf('html body.host-theme:not(#_):not(#__) #chat .mes .mes_text blockquote');
  const hostHrSpec = specificityOf('html body.host-theme:not(#_):not(#__) #chat .mes .mes_text hr');
  const hostEmSpec = specificityOf('html body.host-theme:not(#_):not(#__) #chat .mes .mes_text :is(i, em)');
  const hostSansSpec = specificityOf('.mes_text p');

  installStyle({主题: 'sanguo-scroll', 正文字号: 1.15, 正文行距: 2.0}, [sanguoTheme]);
  const css = getStyleCss();

  // 提取实际生成的世界树高权重正文选择器并对比特异性
  const proseHostRule = css.match(/(\.ygg-prose-host(?::not\(#_+\))+)\s*\{([^}]*)\}/);
  assert.ok(proseHostRule, '须使用多层虚拟 ID 权重包裹 .ygg-prose-host');
  assert.ok(
    compareSpecificity(specificityOf(proseHostRule[1]), hostTextSpec) > 0,
    `${proseHostRule[1]} 权重须严格高于合成宿主 ${JSON.stringify(hostTextSpec)}`,
  );
  assert.match(proseHostRule[2], /font-size:\s*calc\(var\(--mainFontSize,\s*15px\)\s*\*\s*var\(--ygg-prose-scale,\s*1\)\)\s*!important;/);
  assert.match(proseHostRule[2], /line-height:\s*var\(--ygg-prose-leading,\s*1\.75\)\s*!important;/);

  const fontInheritRule = css.match(/(\.ygg-prose-host(?::not\(#_+\))+\s*:is\(p,\s*blockquote,\s*li,\s*\.ygg-dialogue\))\s*\{([^}]*)\}/);
  assert.ok(fontInheritRule, '须包含 :is(p, blockquote, li, .ygg-dialogue) 字体继承规则');
  assert.ok(compareSpecificity(specificityOf(fontInheritRule[1]), hostSansSpec) > 0);
  assert.match(fontInheritRule[2], /font-family:\s*var\(--ygg-font-prose,\s*inherit\);/);
  assert.doesNotMatch(fontInheritRule[1], /\bcode\b|\bpre\b|\.ygg-ico/, '字体继承不得覆盖 code / pre / .ygg-ico');

  const bqRule = css.match(/(\.ygg-prose-host(?::not\(#_+\))+\s+blockquote)\s*\{([^}]*)\}/);
  assert.ok(bqRule, '须包含高权重令牌化 blockquote 规则');
  assert.ok(compareSpecificity(specificityOf(bqRule[1]), hostBqSpec) > 0);
  for (const prop of [
    '--ygg-bq-border-left', '--ygg-bq-border-top', '--ygg-bq-border-bottom',
    '--ygg-bq-bg', '--ygg-bq-padding', '--ygg-bq-radius',
    '--ygg-bq-font', '--ygg-bq-font-style', '--ygg-bq-color',
  ]) {
    assert.ok(bqRule[2].includes(prop), `blockquote 规则须支持令牌 ${prop}`);
  }
  assert.match(bqRule[2], /border-left:[^;]*!important;/);
  assert.match(bqRule[2], /background:[^;]*!important;/);

  const hrRule = css.match(/(\.ygg-prose-host(?::not\(#_+\))+\s+hr)\s*\{([^}]*)\}/);
  assert.ok(hrRule, '须包含高权重令牌化 hr 规则');
  assert.ok(compareSpecificity(specificityOf(hrRule[1]), hostHrSpec) > 0);
  for (const prop of ['--ygg-hr-height', '--ygg-hr-bg', '--ygg-hr-opacity', '--ygg-hr-width', '--ygg-hr-margin']) {
    assert.ok(hrRule[2].includes(prop), `hr 规则须支持令牌 ${prop}`);
  }
  assert.match(hrRule[2], /background:[^;]*!important;/);
  assert.match(hrRule[2], /opacity:[^;]*!important;/);

  const emRule = css.match(/(\.ygg-prose-host(?::not\(#_+\))+\s*:is\(em,\s*i\))\s*\{([^}]*)\}/);
  assert.ok(emRule, '须包含高权重 :is(em, i) 着色规则');
  assert.ok(compareSpecificity(specificityOf(emRule[1]), hostEmSpec) > 0);
  assert.match(emRule[2], /color:[^;]*!important;/);

  // 4 套内置主题与三国示范主题均映射 --ygg-bq-* 与 --ygg-hr-* 令牌，且零外链
  for (const theme of [...BUILTIN_THEMES, sanguoTheme]) {
    const themeCss = buildThemeCss(resolveAppearance({主题: theme.id}, theme.source === 'card' ? [theme] : []));
    for (const tok of ['--ygg-bq-border-left', '--ygg-bq-bg', '--ygg-hr-height', '--ygg-hr-bg']) {
      assert.ok(
        Boolean(theme.tokens[tok]) || themeCss.includes(`${tok}:`),
        `${theme.id} 缺少 ${tok} 令牌映射`,
      );
    }
    assert.doesNotMatch(themeCss, /https?:\/\//i, `${theme.id} 严禁包含外链`);
    assert.doesNotMatch(themeCss, /@import\b/i, `${theme.id} 严禁包含 @import`);
  }
});

test('YG-FIX-07-5：关闭正文美化时移除 .ygg-prose-host 并无损拆包对白，100% 让权给宿主且零裸 .mes_text 规则', () => {
  const doc = createMiniProseDom();
  const root = doc.createElement('div');
  const mesText = doc.createElement('div');
  mesText.className = 'mes_text';
  const p = doc.createElement('p');
  p.appendChild(doc.createTextNode('夜色沉沉，他低声道：“且慢动身。”'));
  const code = doc.createElement('code');
  code.textContent = '“保留代码引号”';
  p.appendChild(code);
  mesText.appendChild(p);
  root.appendChild(mesText);
  const originalText = mesText.textContent;

  // 1) 开启正文美化：挂载 .ygg-prose-host 与 data-ygg-*，包裹对白且跳过 code
  const onResolved = resolveAppearance({主题: 'classic', 正文美化: true, 对白高亮: true, 首行缩进: true}, []);
  const onRes = applyProseAppearance(onResolved, root);
  assert.equal(onRes.touched, 1);
  assert.equal(mesText.classList.contains('ygg-prose-host'), true);
  assert.equal(mesText.getAttribute('data-ygg-theme'), 'classic');
  assert.equal(mesText.getAttribute('data-ygg-indent'), 'true');
  assert.equal(mesText.getAttribute('data-ygg-dialogue'), 'true');
  assert.equal(mesText.querySelectorAll('.ygg-dialogue[data-ygg-enhanced="1"]').length, 1);
  assert.equal(mesText.textContent, originalText);

  // 2) 关闭正文美化：完整卸除 .ygg-prose-host、全部 data-ygg-* 与对白 span，原文逐字不变
  const offResolved = resolveAppearance({主题: 'classic', 正文美化: false}, []);
  const offRes = applyProseAppearance(offResolved, root);
  assert.equal(offRes.touched, 1);
  assert.equal(mesText.classList.contains('ygg-prose-host'), false, '关闭正文美化后须移除 .ygg-prose-host');
  assert.equal(mesText.getAttribute('data-ygg-theme'), null);
  assert.equal(mesText.getAttribute('data-ygg-indent'), null);
  assert.equal(mesText.getAttribute('data-ygg-dialogue'), null);
  assert.equal(mesText.querySelectorAll('.ygg-dialogue[data-ygg-enhanced="1"]').length, 0);
  assert.equal(mesText.textContent, originalText, '关闭正文美化后原文须逐字不变');

  // 3) 生成的主题 CSS 规则中严禁包含裸 .mes_text 选择器，确保移除 .ygg-prose-host 后 100% 让权宿主
  for (const theme of BUILTIN_THEMES) {
    const themeCss = buildThemeCss(resolveAppearance({主题: theme.id}, []));
    const noComments = themeCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(noComments, /\.mes_text\b/, `${theme.id} 不得直接对宿主 .mes_text 写样式规则`);
  }
});
