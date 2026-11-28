// 声明式多套前端主题引擎、安全校验与无损正文美化。浏览器与 Node 同构、零第三方依赖。

export const MAX_THEME_CSS_BYTES = 64 * 1024;
export const BUILTIN_THEME_IDS = Object.freeze(['modern', 'classic', 'fantasy', 'cyber']);
export const FLOOR_VARIANTS = Object.freeze(['bar', 'card', 'minimal']);

const RESERVED_THEME_IDS = new Set([
  'auto', 'default', 'none', 'builtin', 'card',
  '__proto__', 'constructor', 'prototype',
]);
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_KEY_PATTERN = /^--ygg-[a-zA-Z0-9_-]+$/;
const ALLOWED_LAYOUT_KEYS = new Set(['每楼形态', '正文美化', '对白高亮', '首行缩进']);

export const DEFAULT_APPEARANCE = Object.freeze({
  主题: 'auto',
  每楼形态: 'auto',
  正文美化: null,
  对白高亮: null,
  首行缩进: null,
  正文字号: 1,
  正文行距: 1.75,
  自定义CSS: '',
});

const SYSTEM_LAYOUT_DEFAULTS = Object.freeze({
  每楼形态: 'bar',
  正文美化: true,
  对白高亮: true,
  首行缩进: false,
});

export const BUILTIN_THEMES = Object.freeze([
  Object.freeze({
    id: 'modern',
    name: '现代工具',
    description: '通透表面、柔和强调色、细腻圆角卡片与清爽现代小说排版。',
    source: 'builtin',
    base: 'modern',
    tokens: Object.freeze({
      '--ygg-radius': '10px',
      '--ygg-radius-sub': '7px',
      '--ygg-radius-pill': '999px',
      '--ygg-dialogue-color': 'color-mix(in srgb, var(--ygg-accent) 62%, var(--ygg-text))',
      '--ygg-dialogue-bg': 'color-mix(in srgb, var(--ygg-accent) 9%, transparent)',
      '--ygg-bq-border-left': '3px solid var(--ygg-accent)',
      '--ygg-bq-bg': 'color-mix(in srgb, var(--ygg-accent) 6%, transparent)',
      '--ygg-bq-radius': '0 6px 6px 0',
      '--ygg-hr-height': '1px',
      '--ygg-hr-bg': 'linear-gradient(90deg, transparent, var(--ygg-border-strong), transparent)',
    }),
    layout: Object.freeze({
      每楼形态: 'bar',
      正文美化: true,
      对白高亮: true,
      首行缩进: false,
    }),
    css: '',
  }),
  Object.freeze({
    id: 'classic',
    name: '典雅书卷',
    description: '宣纸墨砚层次、朱砂黛青细线、系统衬线字体与古籍眉批感书卷排版。',
    source: 'builtin',
    base: 'classic',
    tokens: Object.freeze({
      '--ygg-accent': '#b8432e',
      '--ygg-ok': '#3f7d68',
      '--ygg-warn': '#b87d2e',
      '--ygg-bad': '#a83838',
      '--ygg-info': '#3d6b8e',
      '--ygg-radius': '4px',
      '--ygg-radius-sub': '3px',
      '--ygg-radius-pill': '4px',
      '--ygg-bg-surface': 'color-mix(in srgb, var(--ygg-base) 82%, #c9a86c 6%)',
      '--ygg-bg-elevated': 'color-mix(in srgb, var(--ygg-base) 74%, #c9a86c 10%)',
      '--ygg-border': 'color-mix(in srgb, #b89862 42%, var(--ygg-text) 16%)',
      '--ygg-border-strong': 'color-mix(in srgb, #b8432e 45%, #b89862 38%)',
      '--ygg-font-ui': '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", Georgia, serif',
      '--ygg-font-prose': '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", Georgia, serif',
      '--ygg-dialogue-color': 'color-mix(in srgb, #e27d60 58%, var(--ygg-text))',
      '--ygg-dialogue-bg': 'color-mix(in srgb, #d46b4e 12%, transparent)',
      '--ygg-bq-border-left': '2px solid #b8432e',
      '--ygg-bq-bg': 'color-mix(in srgb, #c9a86c 8%, transparent)',
      '--ygg-bq-radius': '0',
      '--ygg-bq-font-style': 'normal',
      '--ygg-hr-height': '1px',
      '--ygg-hr-bg': 'linear-gradient(90deg, transparent, #b89862 25%, #b8432e 50%, #b89862 75%, transparent)',
    }),
    layout: Object.freeze({
      每楼形态: 'card',
      正文美化: true,
      对白高亮: true,
      首行缩进: true,
    }),
    css: `
[data-ygg-theme="classic"].ygg-panel,
[data-ygg-theme="classic"] .ygg-panel,
[data-ygg-theme="classic"].ygg-floor,
[data-ygg-theme="classic"] .ygg-floor {
  font-family: var(--ygg-font-ui);
  letter-spacing: 0.02em;
}
[data-ygg-theme="classic"] .ygg-panel-head {
  border-bottom: 2px double var(--ygg-border-strong);
}
[data-ygg-theme="classic"] .ygg-hero,
[data-ygg-theme="classic"] .ygg-sec {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #c9a86c 14%, transparent);
}
[data-ygg-theme="classic"] .ygg-floor {
  border-left-width: 3px;
  border-left-style: double;
  border-left-color: var(--ygg-accent);
}
[data-ygg-theme="classic"] .ygg-floor .ygg-label {
  border-radius: 2px;
  letter-spacing: 0.08em;
}
.ygg-prose-host[data-ygg-theme="classic"] {
  font-family: var(--ygg-font-prose);
  letter-spacing: 0.025em;
}
`,
  }),
  Object.freeze({
    id: 'fantasy',
    name: '奇幻手札',
    description: '羊皮暖金与翡翠双点缀、冒险手札边框、RPG 属性徽章质感与高辨识度对白着色。',
    source: 'builtin',
    base: 'fantasy',
    tokens: Object.freeze({
      '--ygg-accent': '#c99a3c',
      '--ygg-ok': '#2e9e6f',
      '--ygg-warn': '#d98a2b',
      '--ygg-bad': '#c84b4b',
      '--ygg-info': '#4b86c9',
      '--ygg-radius': '8px',
      '--ygg-radius-sub': '6px',
      '--ygg-radius-pill': '999px',
      '--ygg-bg-surface': 'color-mix(in srgb, var(--ygg-base) 82%, #c99a3c 6%)',
      '--ygg-bg-elevated': 'color-mix(in srgb, var(--ygg-base) 74%, #2e9e6f 6%)',
      '--ygg-border': 'color-mix(in srgb, #c99a3c 40%, var(--ygg-text) 16%)',
      '--ygg-border-strong': 'color-mix(in srgb, #c99a3c 68%, var(--ygg-text) 14%)',
      '--ygg-font-ui': 'Georgia, "Noto Serif SC", "PingFang SC", "Microsoft YaHei", serif',
      '--ygg-font-prose': 'Georgia, "Noto Serif SC", "PingFang SC", serif',
      '--ygg-dialogue-color': 'color-mix(in srgb, #c9922c 56%, var(--ygg-text))',
      '--ygg-dialogue-bg': 'color-mix(in srgb, #c99a3c 12%, transparent)',
      '--ygg-bq-border-left': '3px solid #c99a3c',
      '--ygg-bq-bg': 'color-mix(in srgb, #c99a3c 9%, transparent)',
      '--ygg-bq-radius': '0 8px 8px 0',
      '--ygg-hr-height': '2px',
      '--ygg-hr-bg': 'linear-gradient(90deg, transparent, #2e9e6f 22%, #c99a3c 50%, #2e9e6f 78%, transparent)',
    }),
    layout: Object.freeze({
      每楼形态: 'card',
      正文美化: true,
      对白高亮: true,
      首行缩进: false,
    }),
    css: `
[data-ygg-theme="fantasy"].ygg-panel,
[data-ygg-theme="fantasy"] .ygg-panel {
  font-family: var(--ygg-font-ui);
}
[data-ygg-theme="fantasy"] .ygg-panel-head {
  border-bottom: 1px solid var(--ygg-border-strong);
  box-shadow: 0 1px 0 color-mix(in srgb, #2e9e6f 24%, transparent);
}
[data-ygg-theme="fantasy"] .ygg-stat-card {
  border-color: color-mix(in srgb, #c99a3c 44%, transparent);
  border-top: 2px solid var(--ygg-accent);
}
[data-ygg-theme="fantasy"] .ygg-chip {
  border-color: color-mix(in srgb, #2e9e6f 42%, transparent);
  background: color-mix(in srgb, #2e9e6f 10%, transparent);
}
[data-ygg-theme="fantasy"] .ygg-floor {
  border-color: color-mix(in srgb, #c99a3c 40%, transparent);
  border-left: 3px solid var(--ygg-ok);
  box-shadow: 0 2px 8px color-mix(in srgb, #000 10%, transparent);
}
[data-ygg-theme="fantasy"] .ygg-floor .ygg-scene-pill {
  border-color: color-mix(in srgb, #c99a3c 42%, transparent);
  background: color-mix(in srgb, #c99a3c 11%, transparent);
}
.ygg-prose-host[data-ygg-theme="fantasy"] {
  font-family: var(--ygg-font-prose);
}
`,
  }),
  Object.freeze({
    id: 'cyber',
    name: '赛博终端',
    description: '锐利微切角、等宽字体点缀、微网格终端头饰与青蓝电光绿高对比 HUD 状态条。',
    source: 'builtin',
    base: 'cyber',
    tokens: Object.freeze({
      '--ygg-accent': '#22d3ee',
      '--ygg-ok': '#22c55e',
      '--ygg-warn': '#f59e0b',
      '--ygg-bad': '#f43f5e',
      '--ygg-info': '#38bdf8',
      '--ygg-radius': '2px',
      '--ygg-radius-sub': '2px',
      '--ygg-radius-pill': '2px',
      '--ygg-bg-surface': 'color-mix(in srgb, var(--ygg-base) 86%, #06b6d4 5%)',
      '--ygg-bg-elevated': 'color-mix(in srgb, var(--ygg-base) 78%, #22d3ee 8%)',
      '--ygg-border': 'color-mix(in srgb, #22d3ee 36%, var(--ygg-text) 14%)',
      '--ygg-border-strong': 'color-mix(in srgb, #22d3ee 66%, transparent)',
      '--ygg-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      '--ygg-dialogue-color': 'color-mix(in srgb, #0ea5e9 62%, var(--ygg-text))',
      '--ygg-dialogue-bg': 'color-mix(in srgb, #22d3ee 11%, transparent)',
      '--ygg-bq-border-left': '2px solid #22d3ee',
      '--ygg-bq-bg': 'color-mix(in srgb, #22d3ee 8%, transparent)',
      '--ygg-bq-font': 'var(--ygg-font-mono)',
      '--ygg-bq-font-size': '0.94em',
      '--ygg-hr-height': '1px',
      '--ygg-hr-bg': 'repeating-linear-gradient(90deg, #22d3ee 0 8px, transparent 8px 14px)',
    }),
    layout: Object.freeze({
      每楼形态: 'card',
      正文美化: true,
      对白高亮: true,
      首行缩进: false,
    }),
    css: `
[data-ygg-theme="cyber"] .ygg-panel-head {
  border-bottom: 1px solid var(--ygg-border-strong);
  background-image: repeating-linear-gradient(90deg, color-mix(in srgb, #22d3ee 7%, transparent) 0 1px, transparent 1px 16px);
  padding: 6px 8px 10px;
}
[data-ygg-theme="cyber"] .ygg-hero {
  background-image: linear-gradient(color-mix(in srgb, #22d3ee 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, #22d3ee 5%, transparent) 1px, transparent 1px);
  background-size: 20px 20px;
}
[data-ygg-theme="cyber"] .ygg-stat-label,
[data-ygg-theme="cyber"] .ygg-key,
[data-ygg-theme="cyber"] .ygg-label,
[data-ygg-theme="cyber"] .ygg-head-pill,
[data-ygg-theme="cyber"] .ygg-scene-pill {
  font-family: var(--ygg-font-mono);
  letter-spacing: 0.03em;
}
[data-ygg-theme="cyber"] .ygg-floor {
  border-left: 3px solid var(--ygg-accent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #22d3ee 22%, transparent);
}
[data-ygg-theme="cyber"] .ygg-floor .ygg-scene-pill {
  border-color: color-mix(in srgb, #22d3ee 44%, transparent);
  background: color-mix(in srgb, #22d3ee 10%, transparent);
}
`,
  }),
]);

const BUILTIN_MAP = new Map(BUILTIN_THEMES.map(theme => [theme.id, theme]));

const utf8ByteLength = text => new TextEncoder().encode(String(text)).length;

const DANGEROUS_PATTERNS = [
  {pattern: /https?:\/\//i, reason: '禁止包含外链 URL（http:// 或 https://）'},
  {pattern: /@import\b/i, reason: '禁止使用 @import 规则'},
  {pattern: /<\/style/i, reason: '禁止包含 </style 标签片段'},
  {pattern: /javascript\s*:/i, reason: '禁止包含 javascript: 协议'},
  {pattern: /expression\s*\(/i, reason: '禁止使用 expression()'},
  {pattern: /behavior\s*:/i, reason: '禁止使用 behavior: 属性'},
  {pattern: /-moz-binding\b/i, reason: '禁止使用 -moz-binding 属性'},
];

const BARE_GLOBAL_SELECTOR = /^(?:html|body|\*|:root|#chat|#sheld|#top-bar|\.mes)(?=$|[\s>+~.:[#])/i;
const YGG_SCOPE_PREFIX = /^(?:\.ygg-|\[data-ygg-theme)/;

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// 递归提取样式规则中的顶层选择器，拦截直接裸写 html / body / * / #chat 等破坏酒馆界面的选择器。
function findBareGlobalSelectors(css) {
  const clean = stripCssComments(css);
  const bad = [];

  function scan(source, start = 0, end = source.length) {
    let i = start;
    let preludeStart = start;
    while (i < end) {
      const ch = source[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < end) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === q) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      if (ch === ';') {
        preludeStart = i + 1;
        i += 1;
        continue;
      }
      if (ch === '{') {
        const prelude = source.slice(preludeStart, i).trim();
        let depth = 1;
        let j = i + 1;
        while (j < end && depth > 0) {
          const inner = source[j];
          if (inner === '"' || inner === "'") {
            const q = inner;
            j += 1;
            while (j < end) {
              if (source[j] === '\\') { j += 2; continue; }
              if (source[j] === q) { j += 1; break; }
              j += 1;
            }
            continue;
          }
          if (inner === '{') depth += 1;
          else if (inner === '}') depth -= 1;
          j += 1;
        }
        const blockStart = i + 1;
        const blockEnd = Math.max(blockStart, j - 1);
        if (prelude.startsWith('@')) {
          if (/^@(?:media|supports|container|layer)\b/i.test(prelude)) {
            scan(source, blockStart, blockEnd);
          }
        } else if (prelude) {
          const selectors = prelude.split(',').map(s => s.trim()).filter(Boolean);
          for (const sel of selectors) {
            if (!YGG_SCOPE_PREFIX.test(sel) && BARE_GLOBAL_SELECTOR.test(sel)) {
              bad.push(sel);
            }
          }
        }
        i = j;
        preludeStart = j;
        continue;
      }
      i += 1;
    }
  }

  scan(clean);
  return bad;
}

export function validateThemeCss(css, {strict = true} = {}) {
  const errors = [];
  if (typeof css !== 'string') {
    return {ok: false, errors: ['主题样式须为字符串']};
  }
  if (utf8ByteLength(css) > MAX_THEME_CSS_BYTES) {
    errors.push(`主题 CSS 超过大小上限（最大 ${MAX_THEME_CSS_BYTES} 字节）`);
  }
  for (const {pattern, reason} of DANGEROUS_PATTERNS) {
    if (pattern.test(css)) errors.push(reason);
  }
  if (strict && css.trim()) {
    const globals = findBareGlobalSelectors(css);
    if (globals.length) {
      errors.push(`禁止顶层裸全局选择器（请限定在 .ygg-panel / .ygg-floor / .ygg-prose-host 或 [data-ygg-theme] 内）：${globals.slice(0, 3).join('、')}`);
    }
  }
  return {ok: errors.length === 0, errors};
}

export function sanitizeCustomCss(css) {
  if (typeof css !== 'string' || !css) return '';
  let out = css;
  out = out.replace(/<\/style[^>]*>/gi, '');
  out = out.replace(/<\/style/gi, '');
  out = out.replace(/@import\b[^;}\n]*;?/gi, '');
  out = out.replace(/url\(\s*['"]?\s*(?:https?:|javascript:)[^)]*\)/gi, 'none');
  out = out.replace(/https?:\/\/[^\s'"();}]*/gi, '');
  out = out.replace(/javascript\s*:[^\s'"();}]*/gi, '');
  out = out.replace(/expression\s*\([^)]*\)/gi, '');
  out = out.replace(/behavior\s*:[^;}\n]*;?/gi, '');
  out = out.replace(/-moz-binding\s*:[^;}\n]*;?/gi, '');
  if (utf8ByteLength(out) > MAX_THEME_CSS_BYTES) {
    // 按字符安全截断至 64KB 以内，避免切坏 UTF-16 代理对。
    const chars = [...out];
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (utf8ByteLength(chars.slice(0, mid).join('')) <= MAX_THEME_CSS_BYTES) lo = mid;
      else hi = mid - 1;
    }
    out = chars.slice(0, lo).join('');
  }
  return out;
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function pickField(raw, keys) {
  for (const key of keys) {
    if (Object.hasOwn(raw, key) && raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

export function validateThemeEntry(raw, {existingIds = new Set()} = {}) {
  if (!isPlainObject(raw)) throw new Error('主题配置须为对象映射');

  const id = pickField(raw, ['id', 'ID']);
  if (typeof id !== 'string' || !id.trim()) throw new Error('主题缺少非空 id');
  const trimmedId = id.trim();
  if (!THEME_ID_PATTERN.test(trimmedId)) {
    throw new Error(`主题 id 不合法（仅允许小写字母、数字、-、_ 且须以字母或数字开头）：${trimmedId}`);
  }
  if (RESERVED_THEME_IDS.has(trimmedId)) {
    throw new Error(`主题 id 不得使用保留字：${trimmedId}`);
  }
  if (BUILTIN_MAP.has(trimmedId)) {
    throw new Error(`卡专属主题 id 不得与内置主题重名：${trimmedId}`);
  }
  if (existingIds instanceof Set && existingIds.has(trimmedId)) {
    throw new Error(`主题 id 重复：${trimmedId}`);
  }

  const name = pickField(raw, ['name', '名称']);
  if (typeof name !== 'string' || !name.trim()) throw new Error(`主题“${trimmedId}”缺少非空名称`);

  const descriptionRaw = pickField(raw, ['description', '说明', '简介']);
  if (descriptionRaw !== undefined && typeof descriptionRaw !== 'string') {
    throw new Error(`主题“${trimmedId}”的说明须为文本`);
  }
  const description = (descriptionRaw ?? '').trim();

  const defaultRaw = pickField(raw, ['default', '默认']);
  if (defaultRaw !== undefined && typeof defaultRaw !== 'boolean') {
    throw new Error(`主题“${trimmedId}”的 default/默认 须为布尔值`);
  }
  const isDefault = defaultRaw === true;

  const baseRaw = pickField(raw, ['base', '基座', '继承']);
  const base = baseRaw === undefined ? 'modern' : String(baseRaw).trim();
  if (!BUILTIN_MAP.has(base)) {
    throw new Error(`主题“${trimmedId}”的基座主题不存在（允许 ${BUILTIN_THEME_IDS.join(' / ')}）：${base}`);
  }

  const tokensRaw = pickField(raw, ['tokens', '令牌']);
  const tokens = {};
  if (tokensRaw !== undefined) {
    if (!isPlainObject(tokensRaw)) throw new Error(`主题“${trimmedId}”的令牌须为键值映射`);
    for (const [key, value] of Object.entries(tokensRaw)) {
      if (!TOKEN_KEY_PATTERN.test(key)) {
        throw new Error(`主题“${trimmedId}”含非法令牌键（仅允许 --ygg-*）：${key}`);
      }
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`主题“${trimmedId}”的令牌“${key}”值须为非空文本`);
      }
      if (/[{}]/.test(value)) {
        throw new Error(`主题“${trimmedId}”的令牌“${key}”不得包含花括号`);
      }
      const check = validateThemeCss(value, {strict: false});
      if (!check.ok) {
        throw new Error(`主题“${trimmedId}”的令牌“${key}”不安全：${check.errors.join('；')}`);
      }
      tokens[key] = value.trim();
    }
  }

  const layoutRaw = pickField(raw, ['layout', '布局']);
  const layout = {};
  if (layoutRaw !== undefined) {
    if (!isPlainObject(layoutRaw)) throw new Error(`主题“${trimmedId}”的布局须为映射`);
    for (const [key, value] of Object.entries(layoutRaw)) {
      if (!ALLOWED_LAYOUT_KEYS.has(key)) {
        throw new Error(`主题“${trimmedId}”的布局含未授权字段：${key}`);
      }
      if (key === '每楼形态') {
        if (!FLOOR_VARIANTS.includes(value)) {
          throw new Error(`主题“${trimmedId}”的 每楼形态 不合法（允许 ${FLOOR_VARIANTS.join(' / ')}）：${String(value)}`);
        }
        layout[key] = value;
      } else {
        if (typeof value !== 'boolean') {
          throw new Error(`主题“${trimmedId}”的布局项“${key}”须为布尔值`);
        }
        layout[key] = value;
      }
    }
  }

  const cssRaw = pickField(raw, ['css', '样式']);
  let css = '';
  if (cssRaw !== undefined) {
    if (typeof cssRaw !== 'string') throw new Error(`主题“${trimmedId}”的样式须为文本`);
    const cssCheck = validateThemeCss(cssRaw, {strict: true});
    if (!cssCheck.ok) {
      throw new Error(`主题“${trimmedId}”的 CSS 校验失败：${cssCheck.errors.join('；')}`);
    }
    css = cssRaw;
  }

  return {
    id: trimmedId,
    name: name.trim(),
    description,
    source: 'card',
    default: isDefault,
    base,
    tokens,
    layout,
    css,
  };
}

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
};

export function resolveAppearance(config = {}, cardThemes = []) {
  const cfg = {...DEFAULT_APPEARANCE, ...(isPlainObject(config) ? config : {})};
  const cards = Array.isArray(cardThemes)
    ? cardThemes.filter(item => isPlainObject(item) && typeof item.id === 'string' && item.id)
    : [];
  const availableThemes = [...cards, ...BUILTIN_THEMES];
  const byId = new Map(availableThemes.map(item => [item.id, item]));
  const cardDefault = cards.find(item => item.default === true) ?? cards[0] ?? null;
  const fallbackTheme = cardDefault ?? BUILTIN_MAP.get('modern');

  let theme;
  if (!cfg.主题 || cfg.主题 === 'auto') {
    theme = fallbackTheme;
  } else {
    theme = byId.get(cfg.主题) ?? fallbackTheme;
  }

  const baseTheme = BUILTIN_MAP.get(theme.base ?? theme.id) ?? BUILTIN_MAP.get('modern');
  const themeLayout = {...SYSTEM_LAYOUT_DEFAULTS, ...(baseTheme.layout ?? {}), ...(theme.layout ?? {})};

  const 每楼形态 = FLOOR_VARIANTS.includes(cfg.每楼形态) ? cfg.每楼形态 : themeLayout.每楼形态;
  const 正文美化 = typeof cfg.正文美化 === 'boolean' ? cfg.正文美化 : themeLayout.正文美化;
  const 对白高亮 = typeof cfg.对白高亮 === 'boolean' ? cfg.对白高亮 : themeLayout.对白高亮;
  const 首行缩进 = typeof cfg.首行缩进 === 'boolean' ? cfg.首行缩进 : themeLayout.首行缩进;
  const 正文字号 = clampNumber(cfg.正文字号, 0.9, 1.2, DEFAULT_APPEARANCE.正文字号);
  const 正文行距 = clampNumber(cfg.正文行距, 1.5, 2.2, DEFAULT_APPEARANCE.正文行距);
  const 自定义CSS = sanitizeCustomCss(cfg.自定义CSS ?? '');

  return {
    theme,
    baseTheme,
    themeId: theme.id,
    baseId: baseTheme.id,
    每楼形态,
    正文美化,
    对白高亮,
    首行缩进,
    正文字号,
    正文行距,
    自定义CSS,
    availableThemes,
  };
}

function formatTokenBlock(tokens) {
  return Object.entries(tokens ?? {})
    .filter(([key, value]) => TOKEN_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim())
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
}

const SHARED_PROSE_AND_FLOOR_CSS = `
/* 3 种每楼状态栏形态：bar / card / minimal */
.ygg-floor.ygg-floor-card > summary {
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 8px 11px;
}
.ygg-floor.ygg-floor-card > summary::before { display: none; }
.ygg-floor .ygg-floor-card-top {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0;
}
.ygg-floor .ygg-floor-caret {
  display: inline-block; color: var(--ygg-muted); font-size: 0.88em;
  transition: transform var(--ygg-ease), color var(--ygg-ease);
}
.ygg-floor[open] .ygg-floor-caret { transform: rotate(90deg); color: var(--ygg-accent); }
.ygg-floor .ygg-floor-scene {
  display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; flex: 1 1 auto;
}
.ygg-floor .ygg-scene-pill {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  font-size: 0.84em; color: var(--ygg-text); padding: 1px 8px;
  border-radius: var(--ygg-radius-pill); border: 1px solid var(--ygg-border);
  background: var(--ygg-bg-subtle); line-height: 1.35;
}
.ygg-floor .ygg-scene-pill .ygg-ico { width: 12px; height: 12px; flex-basis: 12px; color: var(--ygg-accent); }
.ygg-floor.ygg-floor-card .ygg-brief {
  padding-left: 14px; font-size: 0.92em; white-space: normal;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ygg-floor.ygg-floor-card[open] .ygg-brief { display: none; }

.ygg-floor.ygg-floor-minimal {
  margin-top: 6px; font-size: 0.8em;
  border-left-width: 2px; background: var(--ygg-bg-subtle);
}
.ygg-floor.ygg-floor-minimal > summary { padding: 3px 8px; gap: 5px; }
.ygg-floor.ygg-floor-minimal .ygg-label { font-size: 0.82em; padding: 0 6px; }
.ygg-floor.ygg-floor-minimal .ygg-brief { opacity: 0.78; }

/* 无损正文美化排版层（仅作用于挂载 .ygg-prose-host 的助手楼层，不改写原始消息；
   采用四层虚拟 ID 权重 (4,1,0) 压过第三方宿主主题对 #chat .mes .mes_text 的双 ID 覆盖，
   关闭正文美化移除 .ygg-prose-host 后即 100% 让权给宿主） */
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) {
  font-size: calc(var(--mainFontSize, 15px) * var(--ygg-prose-scale, 1)) !important;
  line-height: var(--ygg-prose-leading, 1.75) !important;
  overflow-wrap: break-word;
  word-break: break-word;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) :is(p, blockquote, li, .ygg-dialogue) {
  font-family: var(--ygg-font-prose, inherit);
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) p {
  margin: 0.68em 0;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) p:first-child { margin-top: 0; }
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) p:last-child { margin-bottom: 0; }
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____)[data-ygg-indent="true"] p {
  text-indent: 2em;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____)[data-ygg-indent="true"] blockquote p {
  text-indent: 0;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) :is(em, i) {
  color: var(--ygg-em-color, color-mix(in srgb, var(--ygg-muted, currentColor) 82%, currentColor)) !important;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) blockquote {
  margin: var(--ygg-bq-margin, 0.8em 0) !important;
  padding: var(--ygg-bq-padding, 0.55em 0.95em) !important;
  border: 0 !important;
  border-top: var(--ygg-bq-border-top, 0) !important;
  border-bottom: var(--ygg-bq-border-bottom, 0) !important;
  border-left: var(--ygg-bq-border-left, 3px solid var(--ygg-accent, #4f9d7a)) !important;
  border-radius: var(--ygg-bq-radius, 0) !important;
  background: var(--ygg-bq-bg, color-mix(in srgb, var(--ygg-accent, #4f9d7a) 7%, transparent)) !important;
  font-family: var(--ygg-bq-font, var(--ygg-font-prose, inherit));
  font-size: var(--ygg-bq-font-size, inherit);
  font-style: var(--ygg-bq-font-style, inherit);
  color: var(--ygg-bq-color, inherit) !important;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) blockquote p {
  font-family: inherit;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____) hr {
  border: 0 !important;
  height: var(--ygg-hr-height, 1px) !important;
  margin: var(--ygg-hr-margin, 1.1em auto) !important;
  width: var(--ygg-hr-width, 82%) !important;
  background: var(--ygg-hr-bg, linear-gradient(90deg, transparent, var(--ygg-border-strong), transparent)) !important;
  opacity: var(--ygg-hr-opacity, 0.85) !important;
}
.ygg-prose-host:not(#_):not(#__):not(#___):not(#____)[data-ygg-dialogue="true"] .ygg-dialogue {
  color: var(--ygg-dialogue-color, var(--ygg-accent, inherit));
  background: var(--ygg-dialogue-bg, transparent);
  border-radius: 3px;
  padding: 0 2px;
}

/* 设置页外观微调控件 */
.ygg-form .ygg-theme-desc {
  margin: 5px 0 0; padding: 6px 9px; font-size: 0.84em; color: var(--ygg-muted);
  border-radius: var(--ygg-radius-sub); background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border);
}
.ygg-form .ygg-appearance-grid {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px;
}
.ygg-form .ygg-range-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px;
}
@container (max-width: 580px) {
  .ygg-form .ygg-appearance-grid,
  .ygg-form .ygg-range-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .ygg-form .ygg-appearance-grid,
  .ygg-form .ygg-range-grid { grid-template-columns: 1fr; }
}
`;

export function buildThemeCss(resolved) {
  const active = resolved && resolved.theme ? resolved : resolveAppearance(DEFAULT_APPEARANCE, []);
  const id = active.themeId;
  const baseId = active.baseId;
  const mergedTokens = {
    ...(active.baseTheme?.tokens ?? {}),
    ...(active.theme?.source === 'card' ? (active.theme.tokens ?? {}) : {}),
    '--ygg-prose-scale': String(active.正文字号),
    '--ygg-prose-leading': String(active.正文行距),
  };

  const scopeSelectors = [
    `[data-ygg-theme="${id}"].ygg-panel`,
    `[data-ygg-theme="${id}"] .ygg-panel`,
    `[data-ygg-theme="${id}"].ygg-floor`,
    `[data-ygg-theme="${id}"] .ygg-floor`,
    `[data-ygg-theme="${id}"].ygg-prose-host`,
    `[data-ygg-theme="${id}"] .ygg-prose-host`,
    `.ygg-panel`,
    `.ygg-floor`,
    `.ygg-prose-host`,
  ].join(',\n');

  const parts = [
    SHARED_PROSE_AND_FLOOR_CSS,
    `/* 主题令牌：${id}（基座 ${baseId}） */\n${scopeSelectors} {\n${formatTokenBlock(mergedTokens)}\n}`,
  ];

  if (active.baseTheme?.css) {
    const baseCss = active.theme?.source === 'card'
      ? active.baseTheme.css.replaceAll(`[data-ygg-theme="${baseId}"]`, `[data-ygg-theme="${id}"]`)
      : active.baseTheme.css;
    parts.push(baseCss);
  }
  if (active.theme?.source === 'card' && active.theme.css) {
    parts.push(`/* 卡专属主题样式：${id} */\n${active.theme.css}`);
  }
  return parts.join('\n');
}

// ---------- 无损正文对白高亮与还原（纯 DOM，不改写原始消息文本） ----------
const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT']);
const DIALOGUE_PATTERN = /“[^“”\r\n]+”|「[^「」\r\n]+」|『[^『』\r\n]+』/g;

function shouldSkipTextNode(textNode, rootEl) {
  let cur = textNode?.parentNode ?? null;
  while (cur && cur !== rootEl) {
    if (cur.nodeType === 1) {
      const tag = typeof cur.tagName === 'string' ? cur.tagName.toUpperCase() : '';
      if (SKIP_TAGS.has(tag)) return true;
      if (cur.classList?.contains?.('ygg-dialogue')) return true;
      if (cur.getAttribute?.('data-ygg-enhanced') === '1') return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

export function clearProseEnhancements(rootEl) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return {unwrapped: 0};
  const spans = [...rootEl.querySelectorAll('.ygg-dialogue[data-ygg-enhanced="1"]')];
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  if (spans.length && typeof rootEl.normalize === 'function') rootEl.normalize();
  return {unwrapped: spans.length};
}

export function enhanceProseNode(rootEl, {dialogue = true} = {}) {
  if (!rootEl) return {wrapped: 0};
  if (!dialogue) {
    clearProseEnhancements(rootEl);
    return {wrapped: 0};
  }
  const doc = rootEl.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createTreeWalker !== 'function') return {wrapped: 0};

  const SHOW_TEXT = typeof globalThis.NodeFilter?.SHOW_TEXT === 'number' ? globalThis.NodeFilter.SHOW_TEXT : 4;
  const walker = doc.createTreeWalker(rootEl, SHOW_TEXT);
  const targets = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    if (text && !shouldSkipTextNode(node, rootEl)) {
      DIALOGUE_PATTERN.lastIndex = 0;
      if (DIALOGUE_PATTERN.test(text)) targets.push(node);
    }
    node = walker.nextNode();
  }

  let wrapped = 0;
  for (const textNode of targets) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const text = textNode.nodeValue ?? '';
    DIALOGUE_PATTERN.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = DIALOGUE_PATTERN.exec(text)) !== null) {
      if (match.index > last) frag.appendChild(doc.createTextNode(text.slice(last, match.index)));
      const span = doc.createElement('span');
      span.className = 'ygg-dialogue';
      span.setAttribute('data-ygg-enhanced', '1');
      span.textContent = match[0];
      frag.appendChild(span);
      wrapped += 1;
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    parent.replaceChild(frag, textNode);
  }
  return {wrapped};
}
