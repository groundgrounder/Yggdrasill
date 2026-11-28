#!/usr/bin/env node
// 世界树·前端 零依赖主题校验与离线预览工具。
// 仅依赖 Node.js 内置模块（node:*），可脱离仓库独立复制到任意目录运行。
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

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

const USAGE = `用法：node theme-tool.mjs <validate|preview> <项目目录或外观目录> [选项]

子命令：
  validate <目录> [--json]
      校验目标目录中的主题配置与 CSS 安全红线（--json 输出脱敏结构化结果）
  preview <目录> [--theme <id>] [--mode dark|light] [--out <输出HTML路径>]
      先校验目标主题，再生成完全自包含、零外链的单文件离线 HTML 预览页

选项：
  --json                 以脱敏 JSON 输出校验结果（不含宿主机绝对路径）
  --theme <id>           预览页默认选中的主题 ID（缺省优先卡默认主题）
  --mode <dark|light>    预览页初始宿主明暗模式（默认 dark）
  --out <路径>           预览 HTML 输出路径（缺省写入系统临时目录）
  -h, --help             显示本帮助信息

示例：
  node theme-tool.mjs validate ./examples/三国演义
  node theme-tool.mjs validate ./examples/三国演义 --json
  node theme-tool.mjs preview ./examples/三国演义 --mode light --out /tmp/sanguo-preview.html
`;

const ICONS = {
  tree: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDIydi05Ii8+PHBhdGggZD0iTTEyIDEzIDcgOCIvPjxwYXRoIGQ9Ik0xMiAxM2w1LTUiLz48cGF0aCBkPSJNMTIgMTNWNCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMy41IiByPSIxLjUiIGZpbGw9IiMwMDAiLz48Y2lyY2xlIGN4PSI2LjUiIGN5PSI3LjUiIHI9IjEuNSIgZmlsbD0iIzAwMCIvPjxjaXJjbGUgY3g9IjE3LjUiIGN5PSI3LjUiIHI9IjEuNSIgZmlsbD0iIzAwMCIvPjxwYXRoIGQ9Ik04IDIyaDgiLz48L3N2Zz4=',
  compass: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOSIvPjxwb2x5Z29uIHBvaW50cz0iMTYgOCAxNCAxNCA4IDE2IDEwIDEwIDE2IDgiIGZpbGw9IiMwMDAiIHN0cm9rZT0ibm9uZSIvPjwvc3ZnPg==',
  clock: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOSIvPjxwYXRoIGQ9Ik0xMiA3djVsMyAyIi8+PC9zdmc+',
  pin: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDIxcy02LTUuNC02LTEwYTYgNiAwIDEgMSAxMiAwYzAgNC42LTYgMTAtNiAxMHoiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjExIiByPSIyIi8+PC9zdmc+',
  users: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iOSIgY3k9IjgiIHI9IjMiLz48cGF0aCBkPSJNMyAyMGE2IDYgMCAwIDEgMTIgMCIvPjxjaXJjbGUgY3g9IjE3IiBjeT0iOSIgcj0iMi41Ii8+PHBhdGggZD0iTTE2IDE0LjVhNSA1IDAgMCAxIDUgNS41Ii8+PC9zdmc+',
  book: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTQgNS41QTIuNSAyLjUgMCAwIDEgNi41IDNIMjB2MThINi41QTIuNSAyLjUgMCAwIDEgNCAxOC41eiIvPjxwYXRoIGQ9Ik00IDE4LjVBMi41IDIuNSAwIDAgMSA2LjUgMTZIMjAiLz48L3N2Zz4=',
};

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
    }),
    layout: Object.freeze({每楼形态: 'bar', 正文美化: true, 对白高亮: true, 首行缩进: false}),
    css: `
.ygg-prose-host[data-ygg-theme="modern"] blockquote {
  border-left: 3px solid var(--ygg-accent);
  background: color-mix(in srgb, var(--ygg-accent) 6%, transparent);
  border-radius: 0 6px 6px 0;
}
.ygg-prose-host[data-ygg-theme="modern"] hr {
  border: none;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--ygg-border-strong), transparent);
}
`,
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
    }),
    layout: Object.freeze({每楼形态: 'card', 正文美化: true, 对白高亮: true, 首行缩进: true}),
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
.ygg-prose-host[data-ygg-theme="classic"] blockquote {
  border-left: 2px solid #b8432e;
  background: color-mix(in srgb, #c9a86c 8%, transparent);
  font-style: normal;
}
.ygg-prose-host[data-ygg-theme="classic"] hr {
  border: none;
  height: 1px;
  background: linear-gradient(90deg, transparent, #b89862 25%, #b8432e 50%, #b89862 75%, transparent);
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
    }),
    layout: Object.freeze({每楼形态: 'card', 正文美化: true, 对白高亮: true, 首行缩进: false}),
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
.ygg-prose-host[data-ygg-theme="fantasy"] blockquote {
  border-left: 3px solid #c99a3c;
  background: color-mix(in srgb, #c99a3c 9%, transparent);
  border-radius: 0 8px 8px 0;
}
.ygg-prose-host[data-ygg-theme="fantasy"] hr {
  border: none;
  height: 2px;
  background: linear-gradient(90deg, transparent, #2e9e6f 22%, #c99a3c 50%, #2e9e6f 78%, transparent);
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
    }),
    layout: Object.freeze({每楼形态: 'card', 正文美化: true, 对白高亮: true, 首行缩进: false}),
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
.ygg-prose-host[data-ygg-theme="cyber"] blockquote {
  border-left: 2px solid #22d3ee;
  background: color-mix(in srgb, #22d3ee 8%, transparent);
  font-family: var(--ygg-font-mono);
  font-size: 0.94em;
}
.ygg-prose-host[data-ygg-theme="cyber"] hr {
  border: none;
  height: 1px;
  background: repeating-linear-gradient(90deg, #22d3ee 0 8px, transparent 8px 14px);
}
`,
  }),
]);

const BUILTIN_MAP = new Map(BUILTIN_THEMES.map(theme => [theme.id, theme]));
const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const utf8ByteLength = text => new TextEncoder().encode(String(text)).length;
const codepointCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------- 轻量零依赖 YAML 解析器（覆盖主题.yaml 全部语法） ----------

function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inDouble) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && raw[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseDoubleQuoted(str) {
  if (!str.endsWith('"') || str.length < 2) throw new Error(`双引号字符串未闭合：${str}`);
  let out = '';
  for (let i = 1; i < str.length - 1; i += 1) {
    const ch = str[i];
    if (ch === '\\') {
      i += 1;
      if (i >= str.length - 1) throw new Error(`非法转义结尾：${str}`);
      const esc = str[i];
      if (esc === 'n') out += '\n';
      else if (esc === 'r') out += '\r';
      else if (esc === 't') out += '\t';
      else if (esc === '"') out += '"';
      else if (esc === '\\') out += '\\';
      else if (esc === '/') out += '/';
      else out += esc;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSingleQuoted(str) {
  if (!str.endsWith("'") || str.length < 2) throw new Error(`单引号字符串未闭合：${str}`);
  return str.slice(1, -1).replace(/''/g, "'");
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (inSingle || inDouble || depth !== 0) throw new Error(`行内结构未闭合：${text}`);
  parts.push(text.slice(start));
  return parts;
}

function findKeyValueSeparator(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && line[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === ':' && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      return i;
    }
  }
  return -1;
}

function parseKey(rawKey) {
  const key = rawKey.trim();
  if (!key) throw new Error('YAML 映射缺少键名');
  if (key.startsWith('"')) return parseDoubleQuoted(key);
  if (key.startsWith("'")) return parseSingleQuoted(key);
  return key;
}

function parseScalar(rawValue) {
  const value = stripInlineComment(rawValue).trim();
  if (!value) return '';
  if (value.startsWith('"')) return parseDoubleQuoted(value);
  if (value.startsWith("'")) return parseSingleQuoted(value);
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new Error(`行内映射未闭合：${value}`);
    const inner = value.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const part of splitTopLevel(inner, ',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const sep = findKeyValueSeparator(trimmed);
      if (sep === -1) throw new Error(`行内映射缺少冒号分隔符：${trimmed}`);
      const k = parseKey(trimmed.slice(0, sep));
      const v = parseScalar(trimmed.slice(sep + 1));
      obj[k] = v;
    }
    return obj;
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`行内列表未闭合：${value}`);
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map(item => parseScalar(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return Number(value);
  return value;
}

export function parseThemeYaml(text) {
  if (typeof text !== 'string') throw new Error('YAML 输入须为字符串');
  const cleanText = text.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/);

  function nextNonEmpty(start) {
    for (let i = start; i < lines.length; i += 1) {
      const raw = lines[i];
      if (/^\s*$/.test(raw)) continue;
      if (/^\s*#/.test(raw)) continue;
      if (/^\t/.test(raw) || /^ *\t/.test(raw)) {
        throw new Error(`第 ${i + 1} 行不允许使用制表符缩进`);
      }
      return i;
    }
    return lines.length;
  }

  function indentOf(line) {
    let n = 0;
    while (n < line.length && line[n] === ' ') n += 1;
    return n;
  }

  function parseBlockScalar(header, parentIndent, startIdx) {
    const match = /^([|>])([+-])?([1-9])?(?:\s+#.*)?$/.exec(header.trim());
    if (!match) throw new Error(`非法的块标量头：${header}`);
    const style = match[1];
    const chomp = match[2] ?? 'clip';
    const explicitIndent = match[3] ? Number(match[3]) : null;

    let blockIndent = explicitIndent !== null ? parentIndent + explicitIndent : null;
    const rawBlockLines = [];
    let i = startIdx;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        rawBlockLines.push({blank: true, text: ''});
        i += 1;
        continue;
      }
      if (/^\t/.test(line) || /^ *\t/.test(line)) {
        throw new Error(`第 ${i + 1} 行不允许使用制表符缩进`);
      }
      const ind = indentOf(line);
      if (blockIndent === null) {
        if (ind <= parentIndent) break;
        blockIndent = ind;
      } else if (ind < blockIndent) {
        break;
      }
      rawBlockLines.push({blank: false, text: line.slice(blockIndent)});
      i += 1;
    }

    let trailingBlanks = 0;
    while (rawBlockLines.length && rawBlockLines[rawBlockLines.length - 1].blank) {
      rawBlockLines.pop();
      trailingBlanks += 1;
    }

    let content = '';
    if (style === '|') {
      content = rawBlockLines.map(item => (item.blank ? '' : item.text)).join('\n');
    } else {
      const out = [];
      for (let idx = 0; idx < rawBlockLines.length; idx += 1) {
        const cur = rawBlockLines[idx];
        if (cur.blank) {
          out.push('\n');
        } else {
          if (out.length && out[out.length - 1] !== '\n') out.push(' ');
          out.push(cur.text);
        }
      }
      content = out.join('');
    }

    if (chomp === '+') {
      content += '\n'.repeat(1 + trailingBlanks);
    } else if (chomp === 'clip' && rawBlockLines.length > 0) {
      content += '\n';
    }
    return {value: content, nextIdx: i};
  }

  function parseMapping(startIdx, expectedIndent) {
    const obj = {};
    let i = startIdx;
    while (true) {
      i = nextNonEmpty(i);
      if (i >= lines.length) break;
      const line = lines[i];
      const ind = indentOf(line);
      if (ind < expectedIndent) break;
      if (ind > expectedIndent) {
        throw new Error(`第 ${i + 1} 行缩进异常（期望 ${expectedIndent} 个空格，实际 ${ind} 个）`);
      }
      const content = line.slice(ind);
      if (content.startsWith('- ') || content === '-') {
        throw new Error(`第 ${i + 1} 行出现未预期的列表项，主题配置须为键值映射`);
      }
      const sep = findKeyValueSeparator(content);
      if (sep === -1) {
        throw new Error(`第 ${i + 1} 行缺少冒号分隔符：${content}`);
      }
      const key = parseKey(content.slice(0, sep));
      const restRaw = content.slice(sep + 1).trim();
      const restNoComment = stripInlineComment(restRaw).trim();

      if (/^[|>](?:[+-])?(?:[1-9])?$/.test(restNoComment)) {
        const block = parseBlockScalar(restNoComment, ind, i + 1);
        obj[key] = block.value;
        i = block.nextIdx;
      } else if (!restNoComment) {
        const peek = nextNonEmpty(i + 1);
        if (peek < lines.length && indentOf(lines[peek]) > ind) {
          const nested = parseMapping(peek, indentOf(lines[peek]));
          obj[key] = nested.value;
          i = nested.nextIdx;
        } else {
          obj[key] = '';
          i += 1;
        }
      } else {
        obj[key] = parseScalar(restRaw);
        i += 1;
      }
    }
    return {value: obj, nextIdx: i};
  }

  const first = nextNonEmpty(0);
  if (first >= lines.length) throw new Error('主题 YAML 为空');
  const firstIndent = indentOf(lines[first]);
  if (firstIndent !== 0) throw new Error(`第 ${first + 1} 行顶层键不得有前导缩进`);
  const parsed = parseMapping(first, 0);
  const trailing = nextNonEmpty(parsed.nextIdx);
  if (trailing < lines.length) {
    throw new Error(`第 ${trailing + 1} 行存在无法解析的尾随内容`);
  }
  return parsed.value;
}

// ---------- CSS 与主题配置安全校验（与 adapter/themes.mjs + adapter/pack.mjs 同口径） ----------

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

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

// ---------- 目录收集与脱敏校验 ----------

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function toRelLabel(root, target) {
  const rel = path.relative(root, target).split(path.sep).join('/');
  return rel ? `外观/${rel}` : '外观';
}

async function ensureContained(realRoot, target, label) {
  const real = await fs.realpath(target);
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label}越出允许目录`);
  }
  return real;
}

async function readUtf8Checked(file, label) {
  let buf;
  try { buf = await fs.readFile(file); }
  catch (error) { throw new Error(`无法读取${label}：${error.code || error.message}`); }
  try { return utf8Decoder.decode(buf); }
  catch { throw new Error(`${label}不是合法 UTF-8 文本`); }
}

async function loadThemeDir(dir, realThemeRoot, existingIds) {
  const relDir = toRelLabel(realThemeRoot, dir);
  const entries = await fs.readdir(dir, {withFileTypes: true});
  entries.sort((a, b) => codepointCompare(a.name, b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      throw new Error(`外观目录不跟随符号链接：${toRelLabel(realThemeRoot, full)}`);
    }
  }

  const yamlPath = path.join(dir, '主题.yaml');
  const yamlStat = await lstatOrNull(yamlPath);
  if (!yamlStat) return null;
  const relYaml = toRelLabel(realThemeRoot, yamlPath);
  if (yamlStat.isSymbolicLink() || !yamlStat.isFile()) {
    throw new Error(`主题配置须为普通文件且不得是符号链接：${relYaml}`);
  }
  await ensureContained(realThemeRoot, yamlPath, `主题配置（${relYaml}）`);

  let raw;
  try { raw = parseThemeYaml(await readUtf8Checked(yamlPath, `主题配置（${relYaml}）`)); }
  catch (error) {
    throw new Error(`解析主题配置失败（${relYaml}）：${error.message}`);
  }
  if (!isPlainObject(raw)) throw new Error(`主题配置须为 YAML 映射：${relYaml}`);

  const cssFileName = typeof raw.样式文件 === 'string' && raw.样式文件.trim()
    ? raw.样式文件.trim()
    : (typeof raw.cssFile === 'string' && raw.cssFile.trim() ? raw.cssFile.trim() : null);

  let fileCss = '';
  let usedCssRel = null;
  if (cssFileName) {
    if (cssFileName.includes('/') || cssFileName.includes('\\') || cssFileName === '.' || cssFileName === '..') {
      throw new Error(`主题样式文件须位于同目录内：${cssFileName}`);
    }
    const cssPath = path.join(dir, cssFileName);
    const cssRel = toRelLabel(realThemeRoot, cssPath);
    const cssStat = await lstatOrNull(cssPath);
    if (!cssStat || cssStat.isSymbolicLink() || !cssStat.isFile()) {
      throw new Error(`主题指定的样式文件缺失、非普通文件或是符号链接：${cssRel}`);
    }
    await ensureContained(realThemeRoot, cssPath, `主题样式文件（${cssRel}）`);
    fileCss = await readUtf8Checked(cssPath, `主题样式文件（${cssRel}）`);
    usedCssRel = cssRel;
  } else {
    for (const candidate of ['样式.css', 'theme.css']) {
      const cssPath = path.join(dir, candidate);
      const cssStat = await lstatOrNull(cssPath);
      if (!cssStat) continue;
      const cssRel = toRelLabel(realThemeRoot, cssPath);
      if (cssStat.isSymbolicLink() || !cssStat.isFile()) {
        throw new Error(`主题样式文件须为普通文件且不得是符号链接：${cssRel}`);
      }
      await ensureContained(realThemeRoot, cssPath, `主题样式文件（${cssRel}）`);
      fileCss = await readUtf8Checked(cssPath, `主题样式文件（${cssRel}）`);
      usedCssRel = cssRel;
      break;
    }
  }

  const inlineCss = typeof raw.css === 'string' ? raw.css : (typeof raw.样式 === 'string' ? raw.样式 : '');
  const mergedCss = [fileCss, inlineCss].filter(Boolean).join('\n');
  const payload = {...raw};
  if (mergedCss) {
    payload.css = mergedCss;
    delete payload.样式;
  }

  let validated;
  try { validated = validateThemeEntry(payload, {existingIds}); }
  catch (error) { throw new Error(`外观主题校验失败（${relYaml}）：${error.message}`); }
  existingIds.add(validated.id);
  return {
    theme: validated,
    meta: {
      id: validated.id,
      name: validated.name,
      base: validated.base,
      default: validated.default,
      dir: relDir,
      yamlFile: relYaml,
      cssFile: usedCssRel,
      tokenCount: Object.keys(validated.tokens).length,
      cssBytes: utf8ByteLength(validated.css),
    },
  };
}

export async function validateThemesDir(targetDir) {
  const errors = [];
  const themes = [];
  const summary = [];

  const targetStat = await lstatOrNull(targetDir);
  if (!targetStat) {
    return {ok: false, themes, summary, errors: ['目标目录不存在']};
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return {ok: false, themes, summary, errors: ['目标路径须为普通目录且不得是符号链接']};
  }

  const realTarget = await fs.realpath(targetDir);
  let realThemesRoot = realTarget;
  const subAppearance = path.join(realTarget, '外观');
  const subStat = await lstatOrNull(subAppearance);
  if (subStat) {
    if (subStat.isSymbolicLink() || !subStat.isDirectory()) {
      return {ok: false, themes, summary, errors: ['外观目录须为普通目录且不得是符号链接：外观']};
    }
    try {
      realThemesRoot = await ensureContained(realTarget, subAppearance, '外观目录');
    } catch (error) {
      return {ok: false, themes, summary, errors: [error.message]};
    }
  }

  const existingIds = new Set();
  try {
    const rootItem = await loadThemeDir(realThemesRoot, realThemesRoot, existingIds);
    if (rootItem) {
      themes.push(rootItem.theme);
      summary.push(rootItem.meta);
    }
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const children = await fs.readdir(realThemesRoot, {withFileTypes: true});
    children.sort((a, b) => codepointCompare(a.name, b.name));
    for (const child of children) {
      const full = path.join(realThemesRoot, child.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        errors.push(`外观目录不跟随符号链接：${toRelLabel(realThemesRoot, full)}`);
        continue;
      }
      if (!stat.isDirectory()) continue;
      try {
        await ensureContained(realThemesRoot, full, `外观主题子目录（${toRelLabel(realThemesRoot, full)}）`);
        const subItem = await loadThemeDir(full, realThemesRoot, existingIds);
        if (subItem) {
          themes.push(subItem.theme);
          summary.push(subItem.meta);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  } catch (error) {
    errors.push(`读取外观目录失败：${error.message}`);
  }

  if (errors.length === 0 && themes.length === 0) {
    errors.push('未在目标目录中找到任何主题配置（主题.yaml）');
  }

  return {ok: errors.length === 0, themes, summary, errors};
}

// ---------- 离线预览 HTML 渲染（与 adapter/ui.mjs + adapter/themes.mjs 同口径，零外链） ----------

const SHARED_PROSE_AND_FLOOR_CSS = `
.ygg-floor.ygg-floor-card > summary {
  flex-direction: column; align-items: stretch; gap: 5px; padding: 8px 11px;
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

.ygg-prose-host {
  font-size: calc(var(--mainFontSize, 15px) * var(--ygg-prose-scale, 1));
  line-height: var(--ygg-prose-leading, 1.75);
  overflow-wrap: break-word;
  word-break: break-word;
}
.ygg-prose-host p { margin: 0.68em 0; }
.ygg-prose-host p:first-child { margin-top: 0; }
.ygg-prose-host p:last-child { margin-bottom: 0; }
.ygg-prose-host[data-ygg-indent="true"] p { text-indent: 2em; }
.ygg-prose-host[data-ygg-indent="true"] blockquote p { text-indent: 0; }
.ygg-prose-host em, .ygg-prose-host i {
  color: color-mix(in srgb, var(--ygg-muted, currentColor) 82%, currentColor);
}
.ygg-prose-host blockquote {
  margin: 0.8em 0;
  padding: 0.55em 0.95em;
  border-left: 3px solid var(--ygg-accent, #4f9d7a);
  background: color-mix(in srgb, var(--ygg-accent, #4f9d7a) 7%, transparent);
}
.ygg-prose-host hr { margin: 1.1em auto; width: 82%; opacity: 0.85; }
.ygg-prose-host[data-ygg-dialogue="true"] .ygg-dialogue {
  color: var(--ygg-dialogue-color, var(--ygg-accent, inherit));
  background: var(--ygg-dialogue-bg, transparent);
  border-radius: 3px;
  padding: 0 2px;
}
`;

const BASE_UI_CSS = `
.ygg-panel, .ygg-floor, .ygg-prose-host {
  --ygg-text: var(--SmartThemeBodyColor, #e5e7eb);
  --ygg-muted: var(--SmartThemeEmColor, color-mix(in srgb, var(--ygg-text) 64%, transparent));
  --ygg-accent: var(--SmartThemeQuoteColor, #4f9d7a);
  --ygg-base: var(--SmartThemeBlurTintColor, rgba(22, 24, 29, 0.88));
  --ygg-bg-surface: color-mix(in srgb, var(--ygg-base) 84%, var(--ygg-text) 4%);
  --ygg-bg-elevated: color-mix(in srgb, var(--ygg-base) 76%, var(--ygg-text) 8%);
  --ygg-bg-subtle: color-mix(in srgb, var(--ygg-text) 5%, transparent);
  --ygg-border: color-mix(in srgb, var(--SmartThemeBorderColor, var(--ygg-text)) 32%, transparent);
  --ygg-border-strong: color-mix(in srgb, var(--SmartThemeBorderColor, var(--ygg-text)) 56%, transparent);
  --ygg-ok: #3fa36c;
  --ygg-warn: #d4943a;
  --ygg-bad: #cf5c5c;
  --ygg-info: #4b8fd4;
  --ygg-radius: 10px;
  --ygg-radius-sub: 7px;
  --ygg-radius-pill: 999px;
  --ygg-ease: 0.16s ease;
}
.ygg-panel, .ygg-floor { box-sizing: border-box; color: var(--ygg-text); line-height: 1.5; }
.ygg-panel *, .ygg-floor * { box-sizing: border-box; }
.ygg-ico {
  display: inline-block; width: 14px; height: 14px; flex: 0 0 14px;
  background-color: currentColor; vertical-align: -2px;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}
.ygg-ico-tree { -webkit-mask-image: url("${ICONS.tree}"); mask-image: url("${ICONS.tree}"); }
.ygg-ico-compass { -webkit-mask-image: url("${ICONS.compass}"); mask-image: url("${ICONS.compass}"); }
.ygg-ico-clock { -webkit-mask-image: url("${ICONS.clock}"); mask-image: url("${ICONS.clock}"); }
.ygg-ico-pin { -webkit-mask-image: url("${ICONS.pin}"); mask-image: url("${ICONS.pin}"); }
.ygg-ico-users { -webkit-mask-image: url("${ICONS.users}"); mask-image: url("${ICONS.users}"); }
.ygg-ico-book { -webkit-mask-image: url("${ICONS.book}"); mask-image: url("${ICONS.book}"); }

.ygg-panel { text-align: left; font-size: calc(var(--mainFontSize, 14px) * 0.94); max-width: 100%; overflow-wrap: break-word; }
.ygg-panel h3 { margin: 0; font-size: 1.12em; font-weight: 650; line-height: 1.3; }
.ygg-panel-head {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  padding: 0 0 10px; margin: 0 0 12px; border-bottom: 1px solid var(--ygg-border);
}
.ygg-panel-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ygg-panel-brand .ygg-ico { color: var(--ygg-accent); }
.ygg-head-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ygg-head-pill {
  font-size: 0.8em; font-weight: 500; padding: 2px 9px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); color: var(--ygg-muted); white-space: nowrap;
}
.ygg-hero {
  background: var(--ygg-bg-surface); border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius);
  padding: 12px 14px; margin: 0 0 12px;
}
.ygg-hero-head {
  display: flex; align-items: center; gap: 6px; font-size: 0.84em; font-weight: 650;
  color: var(--ygg-muted); margin-bottom: 10px; letter-spacing: 0.03em;
}
.ygg-hero-head .ygg-ico { color: var(--ygg-accent); }
.ygg-hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.ygg-stat-card {
  background: var(--ygg-bg-elevated); border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius-sub);
  padding: 8px 10px; min-width: 0;
}
.ygg-stat-label { display: flex; align-items: center; gap: 5px; font-size: 0.78em; color: var(--ygg-muted); margin-bottom: 4px; }
.ygg-stat-val { font-size: 0.96em; font-weight: 600; color: var(--ygg-text); word-break: break-word; }
.ygg-sec {
  border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius); margin: 8px 0;
  background: var(--ygg-bg-surface);
}
.ygg-sec > summary {
  cursor: pointer; padding: 9px 12px; font-weight: 600; display: flex; flex-wrap: wrap;
  gap: 6px; align-items: center; list-style: none; user-select: none;
}
.ygg-sec > summary::-webkit-details-marker { display: none; }
.ygg-sec > summary::before, .ygg-floor > summary::before {
  content: '▸'; display: inline-block; color: var(--ygg-muted); font-size: 0.9em;
}
.ygg-sec[open] > summary::before, .ygg-floor[open] > summary::before { transform: rotate(90deg); color: var(--ygg-accent); }
.ygg-sec > .ygg-body { padding: 4px 12px 12px; border-top: 1px solid color-mix(in srgb, var(--ygg-border) 60%, transparent); }
.ygg-tag {
  font-weight: 500; font-size: 0.78em; padding: 1px 8px; border-radius: var(--ygg-radius-pill);
  border: 1px solid var(--ygg-border); background: var(--ygg-bg-subtle); color: var(--ygg-muted);
}
.ygg-chip {
  display: inline-flex; align-items: center; gap: 3px; margin: 0 5px 4px 0; padding: 2px 8px;
  border-radius: var(--ygg-radius-pill); border: 1px solid var(--ygg-border);
  background: var(--ygg-bg-subtle); font-size: 0.9em; line-height: 1.35;
}
.ygg-timeline { position: relative; margin: 6px 0; padding-left: 16px; display: flex; flex-direction: column; gap: 8px; }
.ygg-timeline::before {
  content: ''; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 1.5px; background: var(--ygg-border-strong);
}
.ygg-timeline-item { position: relative; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 10px; align-items: baseline; padding: 3px 6px; }
.ygg-timeline-dot {
  position: absolute; left: -14px; top: 9px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--ygg-accent); box-shadow: 0 0 0 2px var(--ygg-bg-surface);
}
.ygg-timeline-time {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82em; padding: 1px 7px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); color: var(--ygg-muted); white-space: nowrap;
}
.ygg-items { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 6px 12px; margin: 6px 0; align-items: baseline; }
.ygg-key { color: var(--ygg-muted); white-space: nowrap; font-size: 0.9em; }

.ygg-floor {
  margin: 10px 0 0; font-size: 0.86em; color: var(--ygg-muted);
  border: 1px solid var(--ygg-border); border-left: 3px solid var(--ygg-ok);
  border-radius: var(--ygg-radius-sub); background: var(--ygg-bg-surface);
}
.ygg-floor > summary {
  cursor: pointer; list-style: none; padding: 6px 10px;
  display: flex; align-items: center; gap: 7px; min-width: 0;
}
.ygg-floor > summary::-webkit-details-marker { display: none; }
.ygg-floor .ygg-label {
  display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto;
  color: color-mix(in srgb, var(--ygg-ok) 75%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-ok) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ygg-ok) 32%, transparent);
  font-size: 0.86em; font-weight: 600; padding: 1px 8px; border-radius: var(--ygg-radius-pill);
}
.ygg-floor .ygg-brief { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.ygg-floor > .ygg-body { padding: 6px 12px 10px; border-top: 1px solid color-mix(in srgb, var(--ygg-border) 60%, transparent); }
`;

function formatTokenBlock(tokens) {
  return Object.entries(tokens ?? {})
    .filter(([key, value]) => TOKEN_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim())
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
}

export function buildPreviewThemeCss(theme) {
  const baseTheme = BUILTIN_MAP.get(theme.base ?? theme.id) ?? BUILTIN_MAP.get('modern');
  const id = theme.id;
  const baseId = baseTheme.id;
  const mergedTokens = {
    ...(baseTheme.tokens ?? {}),
    ...(theme.source === 'card' ? (theme.tokens ?? {}) : {}),
    '--ygg-prose-scale': '1',
    '--ygg-prose-leading': '1.75',
  };
  const scopeSelectors = [
    `[data-ygg-theme="${id}"].ygg-panel`,
    `[data-ygg-theme="${id}"] .ygg-panel`,
    `[data-ygg-theme="${id}"].ygg-floor`,
    `[data-ygg-theme="${id}"] .ygg-floor`,
    `[data-ygg-theme="${id}"].ygg-prose-host`,
    `[data-ygg-theme="${id}"] .ygg-prose-host`,
    '.ygg-panel',
    '.ygg-floor',
    '.ygg-prose-host',
  ].join(',\n');

  const parts = [
    SHARED_PROSE_AND_FLOOR_CSS,
    `/* 主题令牌：${id}（基座 ${baseId}） */\n${scopeSelectors} {\n${formatTokenBlock(mergedTokens)}\n}`,
  ];
  if (baseTheme.css) {
    const baseCss = theme.source === 'card'
      ? baseTheme.css.replaceAll(`[data-ygg-theme="${baseId}"]`, `[data-ygg-theme="${id}"]`)
      : baseTheme.css;
    parts.push(baseCss);
  }
  if (theme.source === 'card' && theme.css) {
    parts.push(`/* 卡专属主题样式：${id} */\n${theme.css}`);
  }
  return parts.join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderPreviewHtml(cardThemes = [], {themeId = null, mode = 'dark', title = '世界树主题离线预览'} = {}) {
  const allThemes = [...cardThemes, ...BUILTIN_THEMES];
  const byId = new Map(allThemes.map(item => [item.id, item]));
  const cardDefault = cardThemes.find(item => item.default === true) ?? cardThemes[0] ?? null;
  const activeTheme = (themeId && byId.get(themeId)) || cardDefault || BUILTIN_MAP.get('modern');
  const baseTheme = BUILTIN_MAP.get(activeTheme.base ?? activeTheme.id) ?? BUILTIN_MAP.get('modern');
  const activeLayout = {
    每楼形态: 'bar',
    正文美化: true,
    对白高亮: true,
    首行缩进: false,
    ...(baseTheme.layout ?? {}),
    ...(activeTheme.layout ?? {}),
  };
  const initialMode = mode === 'light' ? 'light' : 'dark';
  const initialCss = buildPreviewThemeCss(activeTheme);
  const floorVariantClass = activeLayout.每楼形态 === 'card'
    ? 'ygg-floor ygg-floor-card'
    : (activeLayout.每楼形态 === 'minimal' ? 'ygg-floor ygg-floor-minimal' : 'ygg-floor');

  const optionsHtml = allThemes.map(item => {
    const tag = item.source === 'card' ? (item.default ? '卡默认' : '卡专属') : '内置';
    const selected = item.id === activeTheme.id ? ' selected' : '';
    return `<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(item.name)}（${escapeHtml(item.id)} · ${tag}）</option>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-preview-mode="${initialMode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(activeTheme.name)}</title>
<style id="ygg-preview-shell">
:root {
  --mainFontSize: 15px;
  --shell-bg: #121318;
  --shell-surface: #1b1d24;
  --shell-border: rgba(255, 255, 255, 0.12);
  --shell-text: #e6e8ee;
  --shell-muted: #9aa0ad;
  --SmartThemeBodyColor: #e5e7eb;
  --SmartThemeEmColor: #b2b8c6;
  --SmartThemeQuoteColor: #4f9d7a;
  --SmartThemeBlurTintColor: rgba(24, 26, 33, 0.92);
  --SmartThemeBorderColor: rgba(229, 231, 235, 0.45);
}
html[data-preview-mode="light"] {
  --shell-bg: #efe8da;
  --shell-surface: #f7f1e3;
  --shell-border: rgba(58, 45, 28, 0.16);
  --shell-text: #27211a;
  --shell-muted: #6c5d4c;
  --SmartThemeBodyColor: #2a231b;
  --SmartThemeEmColor: #6b5b49;
  --SmartThemeQuoteColor: #9e3d28;
  --SmartThemeBlurTintColor: rgba(247, 241, 227, 0.96);
  --SmartThemeBorderColor: rgba(94, 72, 46, 0.45);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; max-width: 100%; overflow-x: hidden;
  background: var(--shell-bg); color: var(--shell-text);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
}
.preview-bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 10px 16px; background: var(--shell-surface); border-bottom: 1px solid var(--shell-border);
}
.preview-title { font-weight: 700; font-size: 14px; margin-right: auto; }
.preview-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
.preview-bar select, .preview-bar button {
  font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--shell-border); background: var(--shell-bg); color: var(--shell-text); cursor: pointer;
}
.preview-bar button[aria-pressed="true"] {
  border-color: var(--SmartThemeQuoteColor); font-weight: 600;
}
.preview-bar label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; }
.preview-main {
  max-width: 1220px; margin: 0 auto; padding: 18px 16px 32px;
  display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 18px; align-items: start;
}
@media (max-width: 860px) {
  .preview-main { grid-template-columns: minmax(0, 1fr); padding: 12px 12px 24px; gap: 14px; }
  .preview-bar { padding: 8px 12px; }
}
.preview-card {
  background: var(--SmartThemeBlurTintColor); border: 1px solid var(--shell-border);
  border-radius: 12px; padding: 16px; min-width: 0; max-width: 100%;
}
.preview-card-cap {
  font-size: 12px; letter-spacing: 0.04em; color: var(--shell-muted); margin: 0 0 10px;
}
.preview-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88em; padding: 1px 5px; border-radius: 4px;
  background: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
}
${BASE_UI_CSS}
</style>
<style id="ygg-preview-theme-style">${initialCss}</style>
</head>
<body>
<header class="preview-bar">
  <span class="preview-title">世界树·前端 离线预览</span>
  <div class="preview-group">
    <select id="ctrl-theme" aria-label="选择主题">${optionsHtml}</select>
  </div>
  <div class="preview-group" role="group" aria-label="宿主明暗模式">
    <button type="button" data-mode="dark" aria-pressed="${initialMode === 'dark'}">暗色宿主</button>
    <button type="button" data-mode="light" aria-pressed="${initialMode === 'light'}">亮色宣纸</button>
  </div>
  <div class="preview-group" role="group" aria-label="每楼形态">
    <button type="button" data-floor="bar" aria-pressed="${activeLayout.每楼形态 === 'bar'}">条状 bar</button>
    <button type="button" data-floor="card" aria-pressed="${activeLayout.每楼形态 === 'card'}">抬头卡 card</button>
    <button type="button" data-floor="minimal" aria-pressed="${activeLayout.每楼形态 === 'minimal'}">极简 minimal</button>
  </div>
  <div class="preview-group">
    <label><input id="ctrl-prose" type="checkbox"${activeLayout.正文美化 ? ' checked' : ''}> 正文美化</label>
    <label><input id="ctrl-dialogue" type="checkbox"${activeLayout.对白高亮 ? ' checked' : ''}> 对白高亮</label>
    <label><input id="ctrl-indent" type="checkbox"${activeLayout.首行缩进 ? ' checked' : ''}> 首行缩进</label>
  </div>
</header>

<main class="preview-main">
  <section class="preview-card" aria-label="模拟助手楼正文与每楼状态栏">
    <div class="preview-card-cap">助手楼正文（无损排版层）与每楼状态栏</div>
    <article id="preview-prose" class="${activeLayout.正文美化 ? 'ygg-prose-host' : ''}" data-ygg-theme="${escapeHtml(activeTheme.id)}" data-ygg-dialogue="${activeLayout.对白高亮 ? 'true' : 'false'}" data-ygg-indent="${activeLayout.首行缩进 ? 'true' : 'false'}">
      <p>中平元年四月，涿县城中。招军的榜文贴在榜栏上，墨迹犹湿。榜下人来人往，读过的人多半摇头走开，唯独一名汉子负手立于榜前，看了半晌，慨然长叹。</p>
      <p>叹息未落，身后一个声音炸雷似地滚过来：<span class="ygg-dialogue" data-ygg-enhanced="1">「大丈夫不与国家出力，何故长叹？」</span></p>
      <p>玄德回视其人，身长八尺，豹头环眼，燕颔虎须，声若巨雷。玄德遂拱手答道：<span class="ygg-dialogue" data-ygg-enhanced="1">“备乃中山靖王之后，欲破贼安民，恨力不能耳。”</span> <em>两人话投机处，遂同入村店饮酒。</em></p>
      <blockquote>史传眉批：桃园结义之前，张飞卖酒屠猪，颇有庄田；关羽亡命江湖五六年，适闻招军破贼，特来应募。</blockquote>
      <hr>
      <p>店外忽有一大汉推车而至，入店坐定，便唤酒保：<span class="ygg-dialogue" data-ygg-enhanced="1">『快斟酒来吃，我待赶入城去投军！』</span> 另测代码内引号不变色：<code class="preview-code">「此处为代码文本，不应高亮」</code>。</p>
    </article>

    <details id="preview-floor" class="${floorVariantClass}" data-ygg-theme="${escapeHtml(activeTheme.id)}">
      <summary id="preview-floor-summary"></summary>
      <div class="ygg-body">
        <div class="ygg-items">
          <div class="ygg-key">场景</div><div>涿县 · 招军榜文之前</div>
          <div class="ygg-key">在场</div><div><span class="ygg-chip">刘备</span><span class="ygg-chip">张飞</span><span class="ygg-chip">关羽</span></div>
          <div class="ygg-key">已写入</div><div>确认事件「榜前长叹」，时间推进至 中平001年04月02日</div>
        </div>
      </div>
    </details>
  </section>

  <aside class="preview-card" aria-label="本局面板预览">
    <div class="preview-card-cap">本局状态面板</div>
    <div id="preview-panel" class="ygg-panel" data-ygg-theme="${escapeHtml(activeTheme.id)}">
      <div class="ygg-panel-head">
        <div class="ygg-panel-brand"><span class="ygg-ico ygg-ico-tree"></span><h3>本局</h3></div>
        <div class="ygg-head-meta">
          <span class="ygg-head-pill" id="panel-theme-badge">${escapeHtml(activeTheme.name)}</span>
          <span class="ygg-head-pill">中平001年04月02日</span>
        </div>
      </div>
      <div class="ygg-hero">
        <div class="ygg-hero-head"><span class="ygg-ico ygg-ico-compass"></span>此刻</div>
        <div class="ygg-hero-grid">
          <div class="ygg-stat-card">
            <div class="ygg-stat-label"><span class="ygg-ico ygg-ico-clock"></span>时间</div>
            <div class="ygg-stat-val">中平001年04月02日</div>
          </div>
          <div class="ygg-stat-card">
            <div class="ygg-stat-label"><span class="ygg-ico ygg-ico-pin"></span>地点</div>
            <div class="ygg-stat-val">涿县 · 招军榜文之前</div>
          </div>
          <div class="ygg-stat-card">
            <div class="ygg-stat-label"><span class="ygg-ico ygg-ico-users"></span>在场</div>
            <div class="ygg-stat-val"><span class="ygg-chip">刘备</span><span class="ygg-chip">张飞</span></div>
          </div>
        </div>
      </div>
      <details class="ygg-sec" open>
        <summary><span class="ygg-ico ygg-ico-book"></span>经历 <span class="ygg-tag">2</span></summary>
        <div class="ygg-body">
          <div class="ygg-timeline">
            <div class="ygg-timeline-item">
              <span class="ygg-timeline-dot"></span>
              <span class="ygg-timeline-time">中平001年04月01日</span>
              <span class="ygg-timeline-desc">幽州太守刘焉出榜招募义兵，榜文行至涿县。</span>
            </div>
            <div class="ygg-timeline-item">
              <span class="ygg-timeline-dot"></span>
              <span class="ygg-timeline-time">中平001年04月02日</span>
              <span class="ygg-timeline-desc">刘备于招军榜前慨然长叹，与张飞初遇相谈。</span>
            </div>
          </div>
        </div>
      </details>
    </div>
  </aside>
</main>

<script>
const PREVIEW_THEMES = ${safeJsonForScript(allThemes)};
const PREVIEW_BUILTINS = ${safeJsonForScript(BUILTIN_THEMES)};
const SHARED_CSS = ${safeJsonForScript(SHARED_PROSE_AND_FLOOR_CSS)};
const TOKEN_KEY_RE = /^--ygg-[a-zA-Z0-9_-]+$/;
const state = {
  themeId: ${safeJsonForScript(activeTheme.id)},
  mode: ${safeJsonForScript(initialMode)},
  floorVariant: ${safeJsonForScript(activeLayout.每楼形态)},
  prose: ${safeJsonForScript(Boolean(activeLayout.正文美化))},
  dialogue: ${safeJsonForScript(Boolean(activeLayout.对白高亮))},
  indent: ${safeJsonForScript(Boolean(activeLayout.首行缩进))},
};

const themeById = new Map(PREVIEW_THEMES.map(item => [item.id, item]));
const builtinById = new Map(PREVIEW_BUILTINS.map(item => [item.id, item]));

function buildCss(theme) {
  const base = builtinById.get(theme.base || theme.id) || builtinById.get('modern');
  const id = theme.id;
  const merged = Object.assign({}, base.tokens || {}, theme.source === 'card' ? (theme.tokens || {}) : {}, {
    '--ygg-prose-scale': '1',
    '--ygg-prose-leading': '1.75',
  });
  const tokenLines = Object.entries(merged)
    .filter(([k, v]) => TOKEN_KEY_RE.test(k) && typeof v === 'string' && v.trim())
    .map(([k, v]) => '  ' + k + ': ' + v + ';')
    .join('\\n');
  const scope = [
    '[data-ygg-theme="' + id + '"].ygg-panel',
    '[data-ygg-theme="' + id + '"] .ygg-panel',
    '[data-ygg-theme="' + id + '"].ygg-floor',
    '[data-ygg-theme="' + id + '"] .ygg-floor',
    '[data-ygg-theme="' + id + '"].ygg-prose-host',
    '[data-ygg-theme="' + id + '"] .ygg-prose-host',
    '.ygg-panel', '.ygg-floor', '.ygg-prose-host',
  ].join(',\\n');
  const parts = [SHARED_CSS, scope + ' {\\n' + tokenLines + '\\n}'];
  if (base.css) {
    parts.push(theme.source === 'card'
      ? base.css.split('[data-ygg-theme="' + base.id + '"]').join('[data-ygg-theme="' + id + '"]')
      : base.css);
  }
  if (theme.source === 'card' && theme.css) parts.push(theme.css);
  return parts.join('\\n');
}

function renderFloorSummary() {
  const summary = document.getElementById('preview-floor-summary');
  const floor = document.getElementById('preview-floor');
  floor.className = 'ygg-floor' + (state.floorVariant === 'card' ? ' ygg-floor-card' : (state.floorVariant === 'minimal' ? ' ygg-floor-minimal' : ''));
  if (state.floorVariant === 'card') {
    summary.innerHTML =
      '<div class="ygg-floor-card-top">' +
        '<span class="ygg-floor-caret">▸</span>' +
        '<span class="ygg-label">已记账</span>' +
        '<span class="ygg-floor-scene">' +
          '<span class="ygg-scene-pill"><span class="ygg-ico ygg-ico-clock"></span>中平001年04月02日</span>' +
          '<span class="ygg-scene-pill"><span class="ygg-ico ygg-ico-pin"></span>涿县 · 招军榜文之前</span>' +
          '<span class="ygg-scene-pill"><span class="ygg-ico ygg-ico-users"></span>刘备、张飞</span>' +
        '</span>' +
      '</div>' +
      '<div class="ygg-brief">榜前长叹初遇张飞，移步村店共话时局。</div>';
  } else {
    summary.innerHTML =
      '<span class="ygg-label">已记账</span>' +
      '<span class="ygg-brief">中平001年04月02日 · 涿县 · 刘备、张飞（已写入 3 项）</span>';
  }
}

function applyState() {
  const theme = themeById.get(state.themeId) || PREVIEW_THEMES[0];
  document.documentElement.setAttribute('data-preview-mode', state.mode);
  document.getElementById('ygg-preview-theme-style').textContent = buildCss(theme);
  const prose = document.getElementById('preview-prose');
  const floor = document.getElementById('preview-floor');
  const panel = document.getElementById('preview-panel');
  prose.className = state.prose ? 'ygg-prose-host' : '';
  prose.setAttribute('data-ygg-theme', theme.id);
  prose.setAttribute('data-ygg-dialogue', state.dialogue ? 'true' : 'false');
  prose.setAttribute('data-ygg-indent', state.indent ? 'true' : 'false');
  floor.setAttribute('data-ygg-theme', theme.id);
  panel.setAttribute('data-ygg-theme', theme.id);
  document.getElementById('panel-theme-badge').textContent = theme.name;
  renderFloorSummary();

  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-mode') === state.mode));
  });
  document.querySelectorAll('[data-floor]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-floor') === state.floorVariant));
  });
  document.getElementById('ctrl-prose').checked = state.prose;
  document.getElementById('ctrl-dialogue').checked = state.dialogue;
  document.getElementById('ctrl-indent').checked = state.indent;
}

document.getElementById('ctrl-theme').addEventListener('change', event => {
  const next = themeById.get(event.target.value);
  if (!next) return;
  const base = builtinById.get(next.base || next.id) || builtinById.get('modern');
  const layout = Object.assign({每楼形态: 'bar', 正文美化: true, 对白高亮: true, 首行缩进: false}, base.layout || {}, next.layout || {});
  state.themeId = next.id;
  state.floorVariant = layout.每楼形态;
  state.prose = Boolean(layout.正文美化);
  state.dialogue = Boolean(layout.对白高亮);
  state.indent = Boolean(layout.首行缩进);
  applyState();
});
document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => { state.mode = btn.getAttribute('data-mode'); applyState(); });
});
document.querySelectorAll('[data-floor]').forEach(btn => {
  btn.addEventListener('click', () => { state.floorVariant = btn.getAttribute('data-floor'); applyState(); });
});
document.getElementById('ctrl-prose').addEventListener('change', e => { state.prose = e.target.checked; applyState(); });
document.getElementById('ctrl-dialogue').addEventListener('change', e => { state.dialogue = e.target.checked; applyState(); });
document.getElementById('ctrl-indent').addEventListener('change', e => { state.indent = e.target.checked; applyState(); });
applyState();
</script>
</body>
</html>
`;
}

// ---------- CLI 入口 ----------

function parseCliArgs(argv) {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    return {help: true};
  }
  const cmd = argv[0];
  if (cmd !== 'validate' && cmd !== 'preview') {
    throw new Error(`未知子命令：${cmd}（允许 validate / preview）`);
  }
  let target = null;
  let json = false;
  let themeId = null;
  let mode = 'dark';
  let out = null;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--theme') {
      if (i + 1 >= argv.length) throw new Error('--theme 缺少主题 ID');
      themeId = argv[++i];
    } else if (arg === '--mode') {
      if (i + 1 >= argv.length) throw new Error('--mode 缺少模式值（dark / light）');
      mode = argv[++i];
      if (mode !== 'dark' && mode !== 'light') throw new Error(`--mode 仅允许 dark 或 light：${mode}`);
    } else if (arg === '--out') {
      if (i + 1 >= argv.length) throw new Error('--out 缺少输出路径');
      out = argv[++i];
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else if (!target) {
      target = arg;
    } else {
      throw new Error(`多余的位置参数：${arg}`);
    }
  }
  if (!target) throw new Error(`${cmd} 缺少目标目录参数`);
  return {help: false, cmd, target, json, themeId, mode, out};
}

export async function runCli(argv, {stdout = process.stdout, stderr = process.stderr} = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`错误：${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }

  const targetAbs = path.resolve(parsed.target);
  const result = await validateThemesDir(targetAbs);

  if (parsed.cmd === 'validate') {
    if (parsed.json) {
      stdout.write(`${JSON.stringify({
        ok: result.ok,
        themeCount: result.summary.length,
        themes: result.summary,
        errors: result.errors,
      }, null, 2)}\n`);
    } else if (result.ok) {
      stdout.write(`主题校验通过：共 ${result.summary.length} 套主题\n`);
      for (const item of result.summary) {
        stdout.write(`- ${item.id}（${item.name}） · 基座 ${item.base}${item.default ? ' · 默认' : ''} · 令牌 ${item.tokenCount} 项 · CSS ${item.cssBytes} B · ${item.yamlFile}\n`);
      }
    } else {
      stderr.write(`主题校验失败（共 ${result.errors.length} 处错误）：\n`);
      for (const err of result.errors) stderr.write(`- ${err}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    stderr.write(`预览中止：主题校验存在 ${result.errors.length} 处错误：\n`);
    for (const err of result.errors) stderr.write(`- ${err}\n`);
    return 1;
  }

  if (parsed.themeId) {
    const exists = result.themes.some(t => t.id === parsed.themeId) || BUILTIN_MAP.has(parsed.themeId);
    if (!exists) {
      stderr.write(`预览中止：未找到主题 ID“${parsed.themeId}”\n`);
      return 1;
    }
  }

  const html = renderPreviewHtml(result.themes, {
    themeId: parsed.themeId,
    mode: parsed.mode,
  });
  let outPath;
  if (parsed.out) {
    outPath = path.resolve(parsed.out);
    await fs.mkdir(path.dirname(outPath), {recursive: true});
  } else {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-theme-preview-'));
    outPath = path.join(tmpDir, 'preview.html');
  }
  await fs.writeFile(outPath, html, 'utf8');
  stdout.write(`离线预览已生成：${outPath}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
