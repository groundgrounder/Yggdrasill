// 页面上的画法：样式、本局面板的段落、每楼一行、设置表单。依赖酒馆页面的 jQuery（$）；数据见 view.mjs，逻辑在 runtime.mjs。
// 颜色都取酒馆主题的变量，换主题时随之变化；全量兼容极简 DOM 桩（仅用白名单方法）。
import {isDynamicOpening} from './opening.mjs';
import {
  BUILTIN_THEMES, DEFAULT_APPEARANCE, resolveAppearance, buildThemeCss,
  sanitizeCustomCss, enhanceProseNode, clearProseEnhancements,
} from './themes.mjs';

const STYLE_ID = 'ygg-style';
const CUSTOM_STYLE_ID = 'ygg-custom-style';
let activeAppearance = resolveAppearance(DEFAULT_APPEARANCE, []);
const ICONS = {
  tree: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDIydi05Ii8+PHBhdGggZD0iTTEyIDEzIDcgOCIvPjxwYXRoIGQ9Ik0xMiAxM2w1LTUiLz48cGF0aCBkPSJNMTIgMTNWNCIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMy41IiByPSIxLjUiIGZpbGw9IiMwMDAiLz48Y2lyY2xlIGN4PSI2LjUiIGN5PSI3LjUiIHI9IjEuNSIgZmlsbD0iIzAwMCIvPjxjaXJjbGUgY3g9IjE3LjUiIGN5PSI3LjUiIHI9IjEuNSIgZmlsbD0iIzAwMCIvPjxwYXRoIGQ9Ik04IDIyaDgiLz48L3N2Zz4=',
  compass: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOSIvPjxwb2x5Z29uIHBvaW50cz0iMTYgOCAxNCAxNCA4IDE2IDEwIDEwIDE2IDgiIGZpbGw9IiMwMDAiIHN0cm9rZT0ibm9uZSIvPjwvc3ZnPg==',
  clock: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOSIvPjxwYXRoIGQ9Ik0xMiA3djVsMyAyIi8+PC9zdmc+',
  pin: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDIxcy02LTUuNC02LTEwYTYgNiAwIDEgMSAxMiAwYzAgNC42LTYgMTAtNiAxMHoiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjExIiByPSIyIi8+PC9zdmc+',
  users: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iOSIgY3k9IjgiIHI9IjMiLz48cGF0aCBkPSJNMyAyMGE2IDYgMCAwIDEgMTIgMCIvPjxjaXJjbGUgY3g9IjE3IiBjeT0iOSIgcj0iMi41Ii8+PHBhdGggZD0iTTE2IDE0LjVhNSA1IDAgMCAxIDUgNS41Ii8+PC9zdmc+',
  book: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTQgNS41QTIuNSAyLjUgMCAwIDEgNi41IDNIMjB2MThINi41QTIuNSAyLjUgMCAwIDEgNCAxOC41eiIvPjxwYXRoIGQ9Ik00IDE4LjVBMi41IDIuNSAwIDAgMSA2LjUgMTZIMjAiLz48L3N2Zz4=',
  warn: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDMgMi41IDE5LjVoMTl6Ii8+PHBhdGggZD0iTTEyIDl2NSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTYuOCIgcj0iMC44IiBmaWxsPSIjMDAwIi8+PC9zdmc+',
  lock: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iNSIgeT0iMTEiIHdpZHRoPSIxNCIgaGVpZ2h0PSIxMCIgcng9IjIiLz48cGF0aCBkPSJNOCAxMVY3YTQgNCAwIDAgMSA4IDB2NCIvPjwvc3ZnPg==',
  upgrade: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iOSIvPjxwYXRoIGQ9Ik0xMiAxNlY4Ii8+PHBhdGggZD0ibTguNSAxMS41IDMuNS0zLjUgMy41IDMuNSIvPjwvc3ZnPg==',
  sliders: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTQgNmgxNiIvPjxwYXRoIGQ9Ik00IDEyaDE2Ii8+PHBhdGggZD0iTTQgMThoMTYiLz48Y2lyY2xlIGN4PSI5IiBjeT0iNiIgcj0iMiIgZmlsbD0iIzAwMCIvPjxjaXJjbGUgY3g9IjE1IiBjeT0iMTIiIHI9IjIiIGZpbGw9IiMwMDAiLz48Y2lyY2xlIGN4PSIxMCIgY3k9IjE4IiByPSIyIiBmaWxsPSIjMDAwIi8+PC9zdmc+',
  wrench: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE0LjcgNi4zYTQgNCAwIDAgMC01LjQgNS40bC01LjYgNS42YTEuNSAxLjUgMCAwIDAgMi4xIDIuMWw1LjYtNS42YTQgNCAwIDAgMCA1LjQtNS40bC0yLjMgMi4zLTIuMS0yLjF6Ii8+PC9zdmc+',
  spark: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0ibTEyIDMgMS44IDUuMkwxOSAxMGwtNS4yIDEuOEwxMiAxN2wtMS44LTUuMkw1IDEwbDUuMi0xLjh6Ii8+PC9zdmc+',
};

const CSS = `
/* 统一设计令牌：暗/亮双主题自适应 */
.ygg-panel, .ygg-floor, .ygg-prose-host {
  --ygg-text: var(--SmartThemeBodyColor, #e5e7eb);
  --ygg-muted: var(--SmartThemeEmColor, color-mix(in srgb, var(--ygg-text) 64%, transparent));
  --ygg-accent: var(--SmartThemeQuoteColor, #4f9d7a);
  --ygg-base: var(--SmartThemeBlurTintColor, rgba(22, 24, 29, 0.88));
  --ygg-bg-surface: color-mix(in srgb, var(--ygg-base) 84%, var(--ygg-text) 4%);
  --ygg-bg-elevated: color-mix(in srgb, var(--ygg-base) 76%, var(--ygg-text) 8%);
  --ygg-bg-subtle: color-mix(in srgb, var(--ygg-text) 5%, transparent);
  --ygg-border: color-mix(in srgb, var(--SmartThemeBorderColor, transparent) 30%, color-mix(in srgb, var(--ygg-text) 22%, transparent));
  --ygg-border-strong: color-mix(in srgb, var(--SmartThemeBorderColor, transparent) 42%, color-mix(in srgb, var(--ygg-text) 40%, transparent));
  --ygg-ok: #3fa36c;
  --ygg-warn: #d4943a;
  --ygg-bad: #cf5c5c;
  --ygg-info: #4b8fd4;
  --ygg-radius: 10px;
  --ygg-radius-sub: 7px;
  --ygg-radius-pill: 999px;
  --ygg-ease: 0.16s ease;
}
.ygg-panel, .ygg-floor {
  box-sizing: border-box;
  color: var(--ygg-text);
  line-height: 1.5;
}
.ygg-panel *, .ygg-floor * { box-sizing: border-box; }
.ygg-panel :focus-visible, .ygg-floor :focus-visible { outline: 2px solid var(--ygg-accent); outline-offset: 2px; border-radius: 4px; }

/* 纯 CSS SVG 微图标 */
.ygg-ico {
  display: inline-block; width: 14px; height: 14px; flex: 0 0 14px;
  background-color: currentColor; vertical-align: -2px;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}
.ygg-ico-lg { width: 18px; height: 18px; flex: 0 0 18px; }
.ygg-ico-tree { -webkit-mask-image: url("${ICONS.tree}"); mask-image: url("${ICONS.tree}"); }
.ygg-ico-compass { -webkit-mask-image: url("${ICONS.compass}"); mask-image: url("${ICONS.compass}"); }
.ygg-ico-clock { -webkit-mask-image: url("${ICONS.clock}"); mask-image: url("${ICONS.clock}"); }
.ygg-ico-pin { -webkit-mask-image: url("${ICONS.pin}"); mask-image: url("${ICONS.pin}"); }
.ygg-ico-users { -webkit-mask-image: url("${ICONS.users}"); mask-image: url("${ICONS.users}"); }
.ygg-ico-book { -webkit-mask-image: url("${ICONS.book}"); mask-image: url("${ICONS.book}"); }
.ygg-ico-warn { -webkit-mask-image: url("${ICONS.warn}"); mask-image: url("${ICONS.warn}"); }
.ygg-ico-lock { -webkit-mask-image: url("${ICONS.lock}"); mask-image: url("${ICONS.lock}"); }
.ygg-ico-upgrade { -webkit-mask-image: url("${ICONS.upgrade}"); mask-image: url("${ICONS.upgrade}"); }
.ygg-ico-sliders { -webkit-mask-image: url("${ICONS.sliders}"); mask-image: url("${ICONS.sliders}"); }
.ygg-ico-wrench { -webkit-mask-image: url("${ICONS.wrench}"); mask-image: url("${ICONS.wrench}"); }
.ygg-ico-spark { -webkit-mask-image: url("${ICONS.spark}"); mask-image: url("${ICONS.spark}"); }

/* 宽弹窗保护：仅作用于含 .ygg-panel 的宽/大弹窗，不影响不含 .ygg-panel 的普通酒馆弹窗 */
dialog.popup:is(.wide_dialogue_popup, .large_dialogue_popup):has(.ygg-panel) {
  width: min(880px, calc(100dvw - 32px)) !important;
}

/* 面板容器与精致顶栏 */
.ygg-panel {
  container-type: inline-size;
  width: 100%;
  text-align: left;
  font-size: calc(var(--mainFontSize, 14px) * 0.94);
  max-width: 100%;
  overflow-wrap: break-word;
}
.ygg-panel h3,
.ygg-panel .ygg-panel-head h3 {
  margin: 0 !important;
  text-align: left !important;
  font-size: 1.12em;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.3;
}
.ygg-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 0 10px; margin: 0 0 12px; border-bottom: 1px solid var(--ygg-border);
}
.ygg-panel-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ygg-panel-brand .ygg-ico { color: var(--ygg-accent); }
.ygg-head-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ygg-head-pill {
  font-size: 0.8em; font-weight: 500; padding: 2px 9px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); color: var(--ygg-muted); white-space: nowrap;
}

/* 「此刻」总览区 */
.ygg-hero {
  background: var(--ygg-bg-surface); border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius);
  padding: 12px 14px; margin: 0 0 12px;
}
.ygg-hero-head {
  display: flex; align-items: center; gap: 6px; font-size: 0.84em; font-weight: 650;
  color: var(--ygg-muted); margin-bottom: 10px; letter-spacing: 0.03em;
}
.ygg-hero-head .ygg-ico { color: var(--ygg-accent); }
.ygg-hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.ygg-stat-card {
  background: var(--ygg-bg-elevated); border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius-sub);
  padding: 8px 10px; min-width: 0;
}
.ygg-stat-label {
  display: flex; align-items: center; gap: 5px; font-size: 0.78em; color: var(--ygg-muted); margin-bottom: 4px;
}
.ygg-stat-label .ygg-ico { width: 12px; height: 12px; flex-basis: 12px; opacity: 0.85; }
.ygg-stat-val { font-size: 0.96em; font-weight: 600; color: var(--ygg-text); word-break: break-word; }
.ygg-stat-val .ygg-chip { font-weight: 500; font-size: 0.88em; }
.ygg-hero-chains { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--ygg-border); }
.ygg-chain-card {
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border);
  border-left: 3px solid var(--ygg-accent); border-radius: var(--ygg-radius-sub); padding: 8px 11px;
}
.ygg-chain-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 4px; }

/* 分段标签导航 */
.ygg-tabs {
  display: flex; align-items: center; gap: 4px; padding: 4px; margin: 0 0 10px;
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius-sub);
  overflow-x: auto; max-width: 100%;
}
.ygg-tab-btn {
  appearance: none; border: 1px solid transparent; background: transparent; color: var(--ygg-muted);
  font: inherit; font-size: 0.88em; font-weight: 500; padding: 5px 11px; border-radius: 5px;
  cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
  transition: background var(--ygg-ease), color var(--ygg-ease), border-color var(--ygg-ease);
}
.ygg-tab-btn:hover { color: var(--ygg-text); background: var(--ygg-bg-elevated); }
.ygg-tab-btn[aria-selected="true"] {
  background: var(--ygg-bg-elevated); color: var(--ygg-text); font-weight: 600;
  border-color: var(--ygg-border-strong);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 12%, transparent);
}
.ygg-tab-count {
  font-size: 0.82em; padding: 0 6px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); color: var(--ygg-muted);
}
.ygg-tab-btn[aria-selected="true"] .ygg-tab-count {
  background: color-mix(in srgb, var(--ygg-accent) 18%, transparent); color: var(--ygg-accent);
}
.ygg-tab-pane[data-hidden="true"] { display: none; }

/* 折叠卡片与嵌套子段 */
.ygg-sec {
  border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius); margin: 8px 0;
  background: var(--ygg-bg-surface); transition: border-color var(--ygg-ease);
}
.ygg-sec:hover { border-color: var(--ygg-border-strong); }
.ygg-sec .ygg-sec { background: var(--ygg-bg-subtle); border-radius: var(--ygg-radius-sub); margin: 8px 0 4px; }
.ygg-sec > summary {
  cursor: pointer; padding: 9px 12px; font-weight: 600; display: flex; flex-wrap: wrap;
  gap: 6px; align-items: center; list-style: none; user-select: none;
  border-radius: var(--ygg-radius); transition: background var(--ygg-ease);
}
.ygg-sec > summary:hover { background: var(--ygg-bg-subtle); }
.ygg-sec > summary::-webkit-details-marker { display: none; }
.ygg-sec > summary::before, .ygg-floor > summary::before {
  content: '▸'; display: inline-block; color: var(--ygg-muted); font-size: 0.9em;
  transition: transform var(--ygg-ease), color var(--ygg-ease);
}
.ygg-sec[open] > summary::before, .ygg-floor[open] > summary::before { transform: rotate(90deg); color: var(--ygg-accent); }
.ygg-sec > .ygg-body { padding: 4px 12px 12px; border-top: 1px solid color-mix(in srgb, var(--ygg-border) 60%, transparent); }
.ygg-sec:not([open]) > .ygg-body { border-top: none; }
.ygg-tag {
  font-weight: 500; font-size: 0.78em; padding: 1px 8px; border-radius: var(--ygg-radius-pill);
  border: 1px solid var(--ygg-border); background: var(--ygg-bg-subtle); color: var(--ygg-muted);
}

/* 键值项与胶囊 */
.ygg-items { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 6px 14px; margin: 6px 0; align-items: baseline; }
.ygg-key { color: var(--ygg-muted); white-space: nowrap; font-size: 0.9em; }
.ygg-chip {
  display: inline-flex; align-items: center; gap: 3px; margin: 0 5px 4px 0; padding: 2px 8px;
  border-radius: var(--ygg-radius-pill); border: 1px solid var(--ygg-border);
  background: var(--ygg-bg-subtle); font-size: 0.9em; line-height: 1.35;
}
.ygg-line { margin: 4px 0; }
.ygg-pre {
  white-space: pre-wrap; word-break: break-word; font-size: 0.84em; margin: 6px 0;
  padding: 9px 11px; border-radius: var(--ygg-radius-sub); border: 1px solid var(--ygg-border);
  background: var(--ygg-bg-subtle); max-height: 60vh; overflow: auto;
}

/* 「经历」编年时间轴 */
.ygg-timeline { position: relative; margin: 6px 0; padding-left: 16px; display: flex; flex-direction: column; gap: 8px; }
.ygg-timeline::before {
  content: ''; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 1.5px;
  background: var(--ygg-border-strong); border-radius: 1px;
}
.ygg-timeline-item {
  position: relative; display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 12px; align-items: baseline; padding: 4px 8px; border-radius: var(--ygg-radius-sub);
  transition: background var(--ygg-ease);
}
.ygg-timeline-item:hover { background: var(--ygg-bg-subtle); }
.ygg-timeline-dot {
  position: absolute; left: -14px; top: 10px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--ygg-accent); box-shadow: 0 0 0 2px var(--ygg-bg-surface);
}
.ygg-timeline-time {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82em; padding: 1px 7px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); color: var(--ygg-muted); white-space: nowrap;
}
.ygg-timeline-desc { min-width: 0; word-break: break-word; }

/* 表格与语义状态徽章 */
.ygg-table-wrap {
  width: 100%; max-width: 100%; overflow-x: auto; margin: 6px 0;
  border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius-sub); background: var(--ygg-bg-surface);
}
.ygg-table { border-collapse: collapse; width: 100%; margin: 0; font-size: 0.88em; }
.ygg-table th, .ygg-table td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--ygg-border); vertical-align: top; }
.ygg-table tr:last-child td { border-bottom: none; }
.ygg-table th {
  position: sticky; top: 0; background: var(--ygg-bg-elevated); color: var(--ygg-muted);
  font-weight: 600; font-size: 0.88em; white-space: nowrap;
}
.ygg-table tbody tr { transition: background var(--ygg-ease); }
.ygg-table tbody tr:hover { background: var(--ygg-bg-subtle); }
.ygg-badge {
  display: inline-block; padding: 1px 8px; border-radius: var(--ygg-radius-pill); white-space: nowrap;
  font-size: 0.86em; font-weight: 500; border: 1px solid transparent;
  background: var(--ygg-bg-subtle); color: var(--ygg-text);
}
.ygg-ok { background: color-mix(in srgb, var(--ygg-ok) 18%, transparent); border-color: color-mix(in srgb, var(--ygg-ok) 42%, transparent); color: color-mix(in srgb, var(--ygg-ok) 80%, var(--ygg-text)); }
.ygg-hot { background: color-mix(in srgb, var(--ygg-accent) 18%, transparent); border-color: color-mix(in srgb, var(--ygg-accent) 44%, transparent); color: color-mix(in srgb, var(--ygg-accent) 82%, var(--ygg-text)); }
.ygg-info { background: color-mix(in srgb, var(--ygg-info) 18%, transparent); border-color: color-mix(in srgb, var(--ygg-info) 42%, transparent); color: color-mix(in srgb, var(--ygg-info) 80%, var(--ygg-text)); }
.ygg-bad { background: color-mix(in srgb, var(--ygg-bad) 18%, transparent); border-color: color-mix(in srgb, var(--ygg-bad) 44%, transparent); color: color-mix(in srgb, var(--ygg-bad) 80%, var(--ygg-text)); }
.ygg-dim { opacity: 0.68; border-color: var(--ygg-border); }

/* 每楼底部记账条与状态卡 */
.ygg-floor {
  margin: 8px 0 0; font-size: 0.86em; color: var(--ygg-muted);
  border: 1px solid var(--ygg-border); border-left: 3px solid var(--ygg-ok);
  border-radius: var(--ygg-radius-sub); background: var(--ygg-bg-surface);
  transition: border-color var(--ygg-ease), background var(--ygg-ease);
}
.ygg-floor:hover { border-color: var(--ygg-border-strong); border-left-color: var(--ygg-ok); }
.ygg-floor.ygg-warn { border-left-color: var(--ygg-warn); }
.ygg-floor.ygg-warn:hover { border-left-color: var(--ygg-warn); }
.ygg-floor.ygg-blocked { border-left-color: var(--ygg-bad); border-left-width: 3px; }
.ygg-floor.ygg-blocked:hover { border-left-color: var(--ygg-bad); }
.ygg-floor.ygg-upgrade { border-left-color: var(--ygg-info); border-left-width: 3px; }
.ygg-floor.ygg-upgrade:hover { border-left-color: var(--ygg-info); }
.ygg-floor.ygg-pending { border-left-color: var(--ygg-muted); opacity: 0.88; }
.ygg-floor.ygg-opening-guide {
  opacity: 1;
  border-color: color-mix(in srgb, var(--ygg-accent) 36%, var(--ygg-border));
  border-left: 3px solid var(--ygg-accent);
  background: color-mix(in srgb, var(--ygg-accent) 6%, var(--ygg-bg-surface));
}
.ygg-floor.ygg-opening-guide:hover {
  border-color: color-mix(in srgb, var(--ygg-accent) 52%, var(--ygg-border));
  border-left-color: var(--ygg-accent);
}
.ygg-floor.ygg-opening-guide .ygg-label {
  color: color-mix(in srgb, var(--ygg-accent) 86%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--ygg-accent) 44%, transparent);
}
.ygg-floor .ygg-opening-status {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px 12px; margin-top: 8px;
}
.ygg-floor .ygg-opening-reason { font-size: 0.92em; color: var(--ygg-muted); min-width: 0; flex: 1 1 180px; }
.ygg-floor .menu_button.ygg-btn-primary {
  background: var(--ygg-accent); color: #ffffff;
  border: 1px solid color-mix(in srgb, var(--ygg-accent) 80%, #000);
  font-weight: 600; padding: 5px 14px; border-radius: 6px;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--ygg-accent) 28%, transparent);
  transition: filter var(--ygg-ease), transform var(--ygg-ease);
}
.ygg-floor .menu_button.ygg-btn-primary:hover { filter: brightness(1.08); }
.ygg-floor .menu_button.ygg-btn-primary:active { transform: translateY(0.5px); }
.ygg-floor > summary {
  cursor: pointer; list-style: none; padding: 6px 10px;
  display: flex; align-items: center; gap: 7px; min-width: 0;
}
.ygg-floor > summary::-webkit-details-marker { display: none; }
.ygg-floor > summary::before { margin-right: 0; flex: 0 0 auto; }
.ygg-floor .ygg-label {
  display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto;
  color: color-mix(in srgb, var(--ygg-ok) 75%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-ok) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ygg-ok) 32%, transparent);
  font-size: 0.86em; font-weight: 600; padding: 1px 8px; border-radius: var(--ygg-radius-pill);
}
.ygg-floor.ygg-warn .ygg-label {
  color: color-mix(in srgb, var(--ygg-warn) 78%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-warn) 16%, transparent);
  border-color: color-mix(in srgb, var(--ygg-warn) 38%, transparent);
}
.ygg-floor.ygg-blocked .ygg-label {
  color: color-mix(in srgb, var(--ygg-bad) 78%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-bad) 16%, transparent);
  border-color: color-mix(in srgb, var(--ygg-bad) 38%, transparent);
}
.ygg-floor.ygg-upgrade .ygg-label {
  color: color-mix(in srgb, var(--ygg-info) 78%, var(--ygg-text));
  background: color-mix(in srgb, var(--ygg-info) 16%, transparent);
  border-color: color-mix(in srgb, var(--ygg-info) 38%, transparent);
}
.ygg-floor.ygg-pending .ygg-label {
  color: var(--ygg-muted); background: var(--ygg-bg-subtle); border-color: var(--ygg-border);
}
.ygg-floor .ygg-brief { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--ygg-text); opacity: 0.88; }
.ygg-floor[open] .ygg-brief { display: none; }
.ygg-floor .ygg-body { padding: 8px 12px 10px 24px; border-top: 1px solid var(--ygg-border); color: var(--ygg-text); }
.ygg-floor .ygg-items { gap: 4px 12px; }
.ygg-floor .ygg-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ygg-border); }
.ygg-floor .menu_button { display: inline-flex; align-items: center; width: auto; padding: 3px 11px; margin: 0; font-size: 0.94em; border-radius: 6px; }
.ygg-pulse {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px;
  background: var(--ygg-accent); animation: ygg-pulse 1.4s ease-in-out infinite;
}
@keyframes ygg-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } }

/* 表单与设置 */
.ygg-form .ygg-field { margin: 10px 0; min-width: 0; }
.ygg-form .ygg-field > label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 0.92em; color: var(--ygg-text); }
.ygg-form .ygg-hint { font-size: 0.84em; color: var(--ygg-muted); margin-top: 3px; line-height: 1.45; }
.ygg-form .ygg-guide-hint {
  margin: 0 0 10px; padding: 8px 11px; border-radius: var(--ygg-radius-sub);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border);
}
.ygg-form .ygg-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.ygg-form .ygg-row > .text_pole { flex: 1 1 0; min-width: 0; margin: 0; }
.ygg-form .ygg-row > .menu_button { width: auto; flex: 0 0 auto; white-space: nowrap; margin: 0; padding: 5px 11px; border-radius: 6px; }
.ygg-form .ygg-check {
  display: flex; gap: 9px; align-items: flex-start; margin: 6px 0; padding: 8px 10px;
  border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius-sub);
  background: var(--ygg-bg-subtle); cursor: pointer; transition: border-color var(--ygg-ease), background var(--ygg-ease);
}
.ygg-form .ygg-check:hover { border-color: var(--ygg-border-strong); background: var(--ygg-bg-elevated); }
.ygg-form .ygg-check input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
.ygg-form .ygg-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ygg-form .ygg-test-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ygg-form .ygg-status { font-size: 0.88em; color: var(--ygg-muted); }
.ygg-form .ygg-status[data-tone="ok"] { color: var(--ygg-ok); font-weight: 500; }
.ygg-form .ygg-status[data-tone="bad"] { color: var(--ygg-bad); font-weight: 500; }

/* 修补弹窗 */
.ygg-repair-failures.ygg-has-failures { border-left: 3px solid var(--ygg-warn); }

/* 开局弹窗 */
.ygg-opening .ygg-opening-error {
  margin: 8px 0 10px; padding: 9px 12px; border-radius: var(--ygg-radius-sub);
  border: 1px solid color-mix(in srgb, var(--ygg-bad) 40%, transparent);
  border-left: 3px solid var(--ygg-bad);
  background: color-mix(in srgb, var(--ygg-bad) 12%, transparent); white-space: pre-wrap;
}
.ygg-opening .ygg-opening-warn {
  margin: 8px 0; padding: 9px 12px; border-radius: var(--ygg-radius-sub);
  border: 1px solid color-mix(in srgb, var(--ygg-warn) 38%, transparent);
  border-left: 3px solid var(--ygg-warn);
  background: color-mix(in srgb, var(--ygg-warn) 12%, transparent);
}
.ygg-opening .ygg-opening-warn .menu_button { width: auto; margin: 6px 0 0; padding: 3px 11px; }
.ygg-opening .ygg-preset-bar {
  margin: 10px 0; padding: 10px 12px; border: 1px solid var(--ygg-border); border-radius: var(--ygg-radius);
  background: var(--ygg-bg-surface); display: flex; flex-direction: column; gap: 8px;
}
.ygg-opening .ygg-preset-bar .ygg-subhead { margin: 0; }
.ygg-opening .ygg-preset-notice {
  font-size: 0.86em; color: var(--ygg-text); padding: 6px 10px; border-radius: var(--ygg-radius-sub);
  border: 1px solid color-mix(in srgb, var(--ygg-info) 36%, transparent);
  border-left: 3px solid var(--ygg-info);
  background: color-mix(in srgb, var(--ygg-info) 12%, transparent);
}
.ygg-opening .ygg-step-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; flex: 0 0 20px; border-radius: var(--ygg-radius-pill);
  background: color-mix(in srgb, var(--ygg-accent) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--ygg-accent) 42%, transparent);
  color: var(--ygg-accent); font-size: 0.78em; font-weight: 700; line-height: 1;
}
.ygg-opening .ygg-step-num::before { content: attr(data-step); }
.ygg-opening .ygg-sec-title { font-weight: 600; }
.ygg-opening .ygg-sec-summary {
  margin-left: auto; font-weight: 500; font-size: 0.8em; max-width: 52%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 9px; border-radius: var(--ygg-radius-pill);
  background: var(--ygg-bg-subtle); border: 1px solid var(--ygg-border); color: var(--ygg-muted);
}
.ygg-opening .ygg-sec-summary::before { content: attr(data-summary); }
.ygg-opening .ygg-opening-time-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
.ygg-opening .ygg-opening-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11em, 1fr)); gap: 8px 12px; }
.ygg-opening .ygg-subcard {
  margin: 10px 0; padding: 10px 12px; border: 1px solid var(--ygg-border);
  border-radius: var(--ygg-radius-sub); background: var(--ygg-bg-subtle);
}
.ygg-opening .ygg-subcard > .ygg-subhead:first-child { margin-top: 0; }
.ygg-opening .ygg-subhead { font-weight: 600; margin: 10px 0 6px; color: var(--ygg-muted); font-size: 0.88em; letter-spacing: 0.02em; }
.ygg-opening .ygg-tag-list { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
.ygg-opening .ygg-chip-del {
  border: none; background: transparent; color: var(--ygg-muted); cursor: pointer;
  padding: 0 3px; font-weight: 700; border-radius: var(--ygg-radius-pill);
  transition: color var(--ygg-ease), background var(--ygg-ease);
}
.ygg-opening .ygg-chip-del:hover { color: var(--ygg-bad); background: color-mix(in srgb, var(--ygg-bad) 14%, transparent); }
.ygg-opening .ygg-rp-bar {
  display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin: 6px 0 10px;
  padding: 8px 11px; border-radius: var(--ygg-radius-sub);
  border: 1px solid var(--ygg-border); border-left: 3px solid var(--ygg-accent);
  background: var(--ygg-bg-elevated); font-size: 0.9em;
}
.ygg-opening .ygg-rp-bar .menu_button { width: auto; margin: 0 0 0 auto; padding: 3px 10px; }
.ygg-opening .ygg-unique-hint {
  margin: 6px 0; padding: 6px 10px; border-radius: var(--ygg-radius-sub);
  border-left: 3px solid var(--ygg-warn); background: color-mix(in srgb, var(--ygg-warn) 12%, transparent); font-size: 0.86em;
}
.ygg-opening .ygg-req { color: var(--ygg-bad); margin-left: 3px; font-weight: 700; }
.ygg-opening .ygg-group-row {
  display: grid; grid-template-columns: minmax(10em, 1fr) minmax(9em, 1fr) auto;
  gap: 8px; align-items: center; margin: 6px 0; padding: 6px 8px;
  border-radius: var(--ygg-radius-sub); border: 1px solid var(--ygg-border); background: var(--ygg-bg-surface);
}
.ygg-opening .ygg-group-row .ygg-check { margin: 0; padding: 2px 4px; border: none; background: transparent; }
.ygg-opening .ygg-group-tags { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.ygg-opening .ygg-required { border-color: color-mix(in srgb, var(--ygg-bad) 45%, transparent); color: var(--ygg-bad); background: color-mix(in srgb, var(--ygg-bad) 10%, transparent); }
.ygg-opening .ygg-required-reason { grid-column: 1 / -1; font-size: 0.84em; color: var(--ygg-bad); margin: -2px 0 2px; }
.ygg-opening .ygg-opening-greeting {
  white-space: pre-wrap; margin: 6px 0; padding: 10px 12px; border-radius: var(--ygg-radius-sub);
  border: 1px solid var(--ygg-border); background: var(--ygg-bg-subtle); line-height: 1.65;
}
.ygg-opening .ygg-opening-status { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
.ygg-opening .ygg-opening-status .menu_button { width: auto; margin: 0; }
.ygg-opening .ygg-opening-preview {
  margin: 12px 0 4px; padding: 12px 14px; border: 1px solid var(--ygg-border);
  border-left: 3px solid var(--ygg-accent); border-radius: var(--ygg-radius); background: var(--ygg-bg-surface);
}
.ygg-opening .ygg-preview-head { font-weight: 600; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--ygg-border); }
.ygg-opening .ygg-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ygg-opening .ygg-preview-item {
  padding: 7px 10px; border-radius: var(--ygg-radius-sub); border: 1px solid var(--ygg-border);
  background: var(--ygg-bg-elevated); min-width: 0; font-size: 0.9em;
}
.ygg-opening .ygg-preview-item.ygg-preview-wide { grid-column: 1 / -1; }
.ygg-opening .ygg-preview-item .ygg-line { margin: 0; word-break: break-word; }

/* 窄容器响应兜底（不依赖视口宽度，避免第三方主题压窄弹窗时多列网格拥挤） */
@container (max-width: 580px) {
  .ygg-panel-head { flex-wrap: wrap; gap: 6px; }
  .ygg-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ygg-form .ygg-row { flex-wrap: wrap; }
  .ygg-form .ygg-row > .text_pole { flex: 1 1 130px; }
  .ygg-form .ygg-grid { grid-template-columns: 1fr; }
  .ygg-panel.ygg-form .ygg-appearance-grid,
  .ygg-panel.ygg-form .ygg-range-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-opening-time-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-group-row { grid-template-columns: 1fr; gap: 6px; }
  .ygg-opening .ygg-group-tags { justify-content: flex-start; }
  .ygg-opening .ygg-preview-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-sec-summary { max-width: 100%; margin-left: 0; }
  .ygg-timeline-item { grid-template-columns: 1fr; gap: 3px; }
  .ygg-items { grid-template-columns: 1fr; gap: 2px; }
  .ygg-key { font-size: 0.84em; margin-top: 4px; }
}

/* 移动端窄屏响应式适配 */
@media (max-width: 640px) {
  .ygg-panel-head { flex-wrap: wrap; gap: 6px; }
  .ygg-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ygg-form .ygg-row { flex-wrap: wrap; }
  .ygg-form .ygg-row > .text_pole { flex: 1 1 130px; }
  .ygg-form .ygg-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-opening-time-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-group-row { grid-template-columns: 1fr; gap: 6px; }
  .ygg-opening .ygg-group-tags { justify-content: flex-start; }
  .ygg-opening .ygg-preview-grid { grid-template-columns: 1fr; }
  .ygg-opening .ygg-sec-summary { max-width: 100%; margin-left: 0; }
  .ygg-timeline-item { grid-template-columns: 1fr; gap: 3px; }
  .ygg-items { grid-template-columns: 1fr; gap: 2px; }
  .ygg-key { font-size: 0.84em; margin-top: 4px; }
}

/* 尊重系统减少动态效果偏好 */
@media (prefers-reduced-motion: reduce) {
  .ygg-panel, .ygg-panel *, .ygg-floor, .ygg-floor *,
  .ygg-panel *::before, .ygg-floor *::before {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

export function installStyle(appearance = null, cardThemes = []) {
  if (appearance) {
    activeAppearance = appearance.theme && appearance.themeId
      ? appearance
      : resolveAppearance(appearance, cardThemes);
  }
  const fullCss = `${CSS}\n${buildThemeCss(activeAppearance)}`;
  $(`#${STYLE_ID}`).remove();
  $('head').append($('<style>').attr('id', STYLE_ID).text(fullCss));
  $(`#${CUSTOM_STYLE_ID}`).remove();
  const customCss = sanitizeCustomCss(activeAppearance.自定义CSS ?? '');
  if (customCss.trim()) {
    $('head').append($('<style>').attr('id', CUSTOM_STYLE_ID).text(customCss));
  }
  if (typeof document !== 'undefined') {
    if (typeof document.documentElement?.setAttribute === 'function') {
      document.documentElement.setAttribute('data-ygg-theme', activeAppearance.themeId);
    }
    if (typeof document.querySelectorAll === 'function') {
      for (const el of document.querySelectorAll('.ygg-panel[data-ygg-theme], .ygg-floor[data-ygg-theme]')) {
        el.setAttribute?.('data-ygg-theme', activeAppearance.themeId);
      }
    }
  }
  return activeAppearance;
}

// 无损正文美化：仅挂载 CSS 类/属性与可选对白 span（绝不改写 chat[i].mes 原始文本），在极简 DOM 桩中安全空转。
export function applyProseAppearance(resolved = activeAppearance, root = null) {
  const targetRoot = root ?? (typeof document !== 'undefined' ? document : null);
  if (!targetRoot || typeof targetRoot.querySelectorAll !== 'function') return {touched: 0};
  const active = resolved && resolved.theme ? resolved : activeAppearance;
  const hosts = [...targetRoot.querySelectorAll('#chat .mes[is_user="false"] .mes_text, .ygg-prose-target')];
  for (const el of hosts) {
    if (active.正文美化) {
      el.classList?.add?.('ygg-prose-host');
      el.setAttribute?.('data-ygg-theme', active.themeId);
      el.setAttribute?.('data-ygg-indent', active.首行缩进 ? 'true' : 'false');
      el.setAttribute?.('data-ygg-dialogue', active.对白高亮 ? 'true' : 'false');
      if (active.对白高亮) enhanceProseNode(el, {dialogue: true});
      else clearProseEnhancements(el);
    } else {
      clearProseEnhancements(el);
      el.classList?.remove?.('ygg-prose-host');
      el.removeAttribute?.('data-ygg-theme');
      el.removeAttribute?.('data-ygg-indent');
      el.removeAttribute?.('data-ygg-dialogue');
    }
  }
  return {touched: hosts.length};
}

const TONES = [['已确认', 'ok'], ['进行中', 'hot'], ['候选', 'hot'], ['待登记', 'info'], ['已结束', 'ok'], ['已排除', 'bad'], ['异常', 'bad'], ['不存在', 'bad']];
const DEBUG_TITLES = new Set(['事件', '记账员看到的事件', '各楼', '本局原文']);
const STAT_ICONS = {世界线: 'compass', 时间: 'clock', 地点: 'pin', 在场: 'users'};

const icon = (name, large = false) => $('<span>')
  .addClass(`ygg-ico ygg-ico-${name}${large ? ' ygg-ico-lg' : ''}`)
  .attr('aria-hidden', 'true');
const badge = text => $('<span>').addClass(`ygg-badge ygg-${TONES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? 'dim'}`).text(text);
const value = item => Array.isArray(item) ? $('<span>').append(item.map(chip => $('<span>').addClass('ygg-chip').text(chip))) : $('<span>').text(item);

function timelineNode(items) {
  return $('<div>').addClass('ygg-timeline').append(
    items.map(([time, desc]) => $('<div>').addClass('ygg-timeline-item').append(
      $('<span>').addClass('ygg-timeline-dot').attr('aria-hidden', 'true'),
      $('<span>').addClass('ygg-timeline-time').text(time),
      $('<div>').addClass('ygg-timeline-desc').append(value(desc)),
    )),
  );
}

function heroNode(item) {
  const hero = $('<div>').addClass('ygg-hero');
  hero.append($('<div>').addClass('ygg-hero-head').append(icon('compass'), $('<span>').text(item.标题)));
  if (item.项?.length) {
    hero.append($('<div>').addClass('ygg-hero-grid').append(
      item.项.map(([key, content]) => {
        const icoName = STAT_ICONS[key];
        const label = $('<div>').addClass('ygg-stat-label').append(
          ...(icoName ? [icon(icoName)] : []),
          $('<span>').text(key),
        );
        return $('<div>').addClass('ygg-stat-card').attr('data-key', key).append(
          label,
          $('<div>').addClass('ygg-stat-val').append(value(content)),
        );
      }),
    ));
  }
  for (const line of item.行 ?? []) hero.append($('<div>').addClass('ygg-line').text(line));
  if (item.子段?.length) {
    hero.append($('<div>').addClass('ygg-hero-chains').append(
      item.子段.map(chain => {
        const card = $('<div>').addClass('ygg-chain-card').append(
          $('<div>').addClass('ygg-chain-head').append(
            $('<span>').text(chain.标题),
            (chain.标记 ?? []).map(tag => $('<span>').addClass('ygg-tag').text(tag)),
          ),
        );
        for (const line of chain.行 ?? []) card.append($('<div>').addClass('ygg-line').text(line));
        if (chain.项?.length) {
          card.append($('<div>').addClass('ygg-items').append(
            chain.项.flatMap(([k, v]) => [$('<span>').addClass('ygg-key').text(k), value(v)]),
          ));
        }
        return card;
      }),
    ));
  }
  return hero;
}

// 段落（view.mjs 的形状）→ 可折叠的 <details>。
export function sectionNode(item) {
  const summary = $('<summary>').append($('<span>').text(item.标题), (item.标记 ?? []).map(tag => $('<span>').addClass('ygg-tag').text(tag)));
  const body = $('<div>').addClass('ygg-body');
  for (const line of item.行 ?? []) body.append($('<div>').addClass('ygg-line').text(line));
  if (item.项?.length) {
    if (item.标题 === '经历') body.append(timelineNode(item.项));
    else body.append($('<div>').addClass('ygg-items').append(item.项.flatMap(([key, content]) => [$('<span>').addClass('ygg-key').text(key), value(content)])));
  }
  if (item.表?.行.length) {
    body.append($('<div>').addClass('ygg-table-wrap').append(
      $('<table>').addClass('ygg-table').append(
        $('<thead>').append($('<tr>').append(item.表.列.map(name => $('<th>').text(name)))),
        $('<tbody>').append(item.表.行.map(row => $('<tr>').append(row.map((cell, index) => $('<td>').append(index === 0 ? badge(cell) : $('<span>').text(cell)))))),
      ),
    ));
  }
  if (item.原文) body.append($('<pre>').addClass('ygg-pre').text(item.原文));
  for (const child of item.子段 ?? []) body.append(sectionNode(child));
  return $('<details>').addClass('ygg-sec').prop('open', item.展开 === true).append(summary, body);
}

export function panelNode(title, sections = []) {
  const list = Array.isArray(sections) ? sections : [];
  const hasNow = list[0]?.标题 === '此刻';
  const rest = hasNow ? list.slice(1) : list;
  const historySections = hasNow ? rest.filter(s => s.标题 === '经历') : [];
  const debugSections = hasNow ? rest.filter(s => DEBUG_TITLES.has(s.标题)) : [];
  const roleSections = hasNow ? rest.filter(s => s.标题 !== '经历' && !DEBUG_TITLES.has(s.标题)) : [];

  const metaPills = [];
  if (hasNow && historySections.length) {
    const historyCount = historySections.reduce((sum, s) => sum + (s.项?.length ?? 0), 0);
    metaPills.push($('<span>').addClass('ygg-head-pill').text(`经历 ${historyCount} 件`));
  }
  const head = $('<div>').addClass('ygg-panel-head').append(
    $('<div>').addClass('ygg-panel-brand').append(icon('tree', true), $('<h3>').text(title)),
    ...(metaPills.length ? [$('<div>').addClass('ygg-head-meta').append(metaPills)] : []),
  );

  const root = $('<div>').addClass('ygg-panel').attr('data-ygg-theme', activeAppearance.themeId).append(head);
  if (!hasNow) {
    root.append(list.map(sectionNode));
    return root;
  }

  root.append(heroNode(list[0]));
  const useTabs = (roleSections.length > 0 && historySections.length > 0) || debugSections.length > 0;
  if (!useTabs) {
    root.append(rest.map(sectionNode));
    return root;
  }

  const roleCount = roleSections.reduce((sum, s) => sum + (s.标题 === '不在场' ? (s.子段?.length ?? 0) : 1), 0);
  const historyCount = historySections.reduce((sum, s) => sum + (s.项?.length ?? 0), 0);
  const tabDefs = [
    {id: 'all', label: '全部', count: null},
    ...(roleSections.length ? [{id: 'roles', label: '角色', count: roleCount}] : []),
    ...(historySections.length ? [{id: 'history', label: '经历', count: historyCount}] : []),
    ...(debugSections.length ? [{id: 'debug', label: '调试', count: debugSections.length}] : []),
  ];

  const panes = new Map();
  const historyNodes = historySections.map(sectionNode);
  if (roleSections.length) panes.set('roles', $('<div>').addClass('ygg-tab-pane').attr('data-tab', 'roles').attr('data-hidden', 'false').append(roleSections.map(sectionNode)));
  if (historySections.length) panes.set('history', $('<div>').addClass('ygg-tab-pane').attr('data-tab', 'history').attr('data-hidden', 'false').append(historyNodes));
  if (debugSections.length) panes.set('debug', $('<div>').addClass('ygg-tab-pane').attr('data-tab', 'debug').attr('data-hidden', 'false').append(debugSections.map(sectionNode)));

  const buttons = new Map();
  function activate(activeId) {
    for (const [id, btn] of buttons) {
      const selected = id === activeId;
      btn.attr('aria-selected', selected ? 'true' : 'false').attr('data-active', selected ? 'true' : 'false');
    }
    for (const [id, pane] of panes) {
      const visible = activeId === 'all' || id === activeId;
      pane.toggle(visible).attr('data-hidden', visible ? 'false' : 'true').prop('hidden', !visible);
    }
    if (activeId === 'history') for (const node of historyNodes) node.prop('open', true);
  }

  const tabBar = $('<div>').addClass('ygg-tabs').attr('role', 'tablist').append(
    tabDefs.map(def => {
      const btn = $('<button>').attr('type', 'button').attr('role', 'tab').attr('data-tab', def.id)
        .addClass('ygg-tab-btn')
        .append(
          $('<span>').text(def.label),
          ...(def.count !== null ? [$('<span>').addClass('ygg-tab-count').text(String(def.count))] : []),
        )
        .on('click', event => { event?.preventDefault?.(); activate(def.id); });
      buttons.set(def.id, btn);
      return btn;
    }),
  );
  activate('all');
  root.append(tabBar, ...panes.values());
  return root;
}

export const textNode = (title, text) => $('<div>').addClass('ygg-panel').attr('data-ygg-theme', activeAppearance.themeId).append(
  $('<div>').addClass('ygg-panel-head').append($('<div>').addClass('ygg-panel-brand').append(icon('tree', true), $('<h3>').text(title))),
  $('<pre>').addClass('ygg-pre').text(text),
);

export {openingNode} from './opening-ui.mjs';

export function openingStatusNode({open, reason = '尚未开局'}) {
  const body = $('<div>').addClass('ygg-body').append(
    $('<div>').addClass('ygg-line').text('尚未开局：确认开局前不会执行开场命令、创建第 0 楼记录、注入叙事上下文或发送叙事请求。'),
    $('<div>').addClass('ygg-opening-status').append(
      $('<span>').addClass('ygg-opening-reason').text(reason),
      $('<button>').attr('type', 'button').addClass('menu_button ygg-btn-primary').text('打开开局').on('click', event => {
        event?.preventDefault?.(); return open();
      }),
    ),
  );
  return $('<details>').addClass('ygg-floor ygg-pending ygg-opening-guide').attr('data-ygg-theme', activeAppearance.themeId).prop('open', true)
    .append($('<summary>').append(
      $('<span>').addClass('ygg-label').append(icon('spark'), $('<span>').text('待开局')),
      $('<span>').text('等待开局 — 点击下方按钮或顶栏「世界树：开局」开始'),
    ), body);
}

// 每楼一行：支持 bar（精简底条）/ card（场景抬头卡）/ minimal（极简徽章）三种形态。
// 收起时展示摘要或场景快照胶囊，展开为逐项详情、调试附录与“重新记账”“修补”。pending 时只显示“记账中”。
export function floorNode(line, {rekeep = null, repair = null, pending = false, variant = 'bar', scene = null} = {}) {
  const mode = variant === 'card' || variant === 'minimal' ? variant : 'bar';
  const node = $('<details>').addClass(`ygg-floor ygg-floor-${mode}`).attr('data-ygg-theme', activeAppearance.themeId);
  if (pending) {
    return node.addClass('ygg-pending').append(
      $('<summary>').append(
        $('<span>').addClass('ygg-label').append(icon('book'), $('<span>').text('记账')),
        $('<span>').addClass('ygg-pulse').attr('aria-hidden', 'true'),
        $('<span>').text('记账中…'),
      ),
    );
  }
  if (line.失败) node.addClass('ygg-warn');
  const body = $('<div>').addClass('ygg-body');
  if (line.详情.length) body.append($('<div>').addClass('ygg-items').append(line.详情.flatMap(([key, values]) => [$('<span>').addClass('ygg-key').text(key), value(values)])));
  if (line.调试) body.append($('<pre>').addClass('ygg-pre').text(line.调试));
  if (rekeep || repair) {
    const actions = $('<div>').addClass('ygg-actions');
    if (rekeep) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('重新记账').on('click', event => { event?.preventDefault?.(); return rekeep(); }));
    if (repair) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('修补').on('click', event => { event?.preventDefault?.(); return repair(); }));
    body.append(actions);
  }

  const labelEl = $('<span>').addClass('ygg-label').append(icon(line.失败 ? 'warn' : 'book'), $('<span>').text('记账'));
  if (mode === 'card') {
    const pills = [];
    if (scene?.时间) pills.push($('<span>').addClass('ygg-scene-pill').append(icon('clock'), $('<span>').text(scene.时间)));
    if (scene?.地点) pills.push($('<span>').addClass('ygg-scene-pill').append(icon('pin'), $('<span>').text(scene.地点)));
    if (Array.isArray(scene?.在场) && scene.在场.length) {
      const names = scene.在场.length <= 3 ? scene.在场.join('、') : `${scene.在场.slice(0, 3).join('、')} 等 ${scene.在场.length} 人`;
      pills.push($('<span>').addClass('ygg-scene-pill').append(icon('users'), $('<span>').text(names)));
    }
    const topRow = $('<div>').addClass('ygg-floor-card-top').append(
      $('<span>').addClass('ygg-floor-caret').attr('aria-hidden', 'true').text('▸'),
      labelEl,
      ...(pills.length ? [$('<div>').addClass('ygg-floor-scene').append(pills)] : []),
    );
    return node.append($('<summary>').append(topRow, $('<span>').addClass('ygg-brief').text(line.摘要)), body);
  }

  return node.append($('<summary>').append(
    labelEl,
    $('<span>').addClass('ygg-brief').text(line.摘要),
  ), body);
}

// 每楼修补弹窗：非调试模式下隐藏原始命令 YAML 与敏感协议/转换报错细节；开启调试后完整展示。
export function repairNode({id, line, record, commandsText = '', debug = false}) {
  const state = {instruction: '', touched: false};
  const root = $('<div>').addClass('ygg-panel ygg-form ygg-opening');
  const errorBox = $('<div>').addClass('ygg-opening-error').text('').hide();
  const failures = record?.失败 ?? [];
  let failureItems;
  if (!failures.length) {
    failureItems = [$('<div>').addClass('ygg-line').text('当前无失败项')];
  } else if (debug) {
    failureItems = failures.map(item => $('<div>').addClass('ygg-line')
      .text(`${item.阶段}/${item.错误码}${item.序号 ? `·第 ${item.序号} 条` : ''}：${item.说明}`));
  } else {
    const plainItems = failures.filter(item => item.错误码 === '记账.调用' || item.错误码 === '记账.JSON');
    const hiddenCount = failures.length - plainItems.length;
    failureItems = plainItems.map(item => $('<div>').addClass('ygg-line').text(`${item.命令 ?? '记账'}：${item.说明}`));
    if (hiddenCount > 0) {
      failureItems.push($('<div>').addClass('ygg-line')
        .text(`有 ${hiddenCount} 项未能写入；可留空尝试补记、填写修补说明，或在“世界树：设置”开启调试查看细节`));
    }
  }
  const textarea = $('<textarea>').addClass('text_pole').attr('rows', 4)
    .attr('placeholder', '留空＝仅定向修补上述失败项；或输入一句指令，例如：补记吕布与刘备、张飞相识 / 没换地点，撤回场景改动')
    .val('')
    .on('input', event => { state.touched = true; state.instruction = String(event?.target?.value ?? ''); })
    .on('change', event => { state.touched = true; state.instruction = String(event?.target?.value ?? ''); });
  const previewChildren = [
    $('<div>').addClass('ygg-line').text(`已记摘要：${line?.摘要 || '无变化'}`),
    ...(line?.详情?.length ? [$('<div>').addClass('ygg-items').append(line.详情.flatMap(([key, values]) => [$('<span>').addClass('ygg-key').text(key), value(values)]))] : []),
    ...(debug ? [$('<pre>').addClass('ygg-pre').text(commandsText || '[]')] : []),
  ];
  const failureSec = $('<details>').addClass(`ygg-sec ygg-repair-failures${failures.length ? ' ygg-has-failures' : ''}`).prop('open', true).append(
    $('<summary>').text('失败列表'),
    $('<div>').addClass('ygg-body').append(failureItems),
  );
  root.append(
    $('<div>').addClass('ygg-panel-head').append(
      $('<div>').addClass('ygg-panel-brand').append(icon('wrench', true), $('<h3>').text(`世界树：修补第 ${id} 楼记账`)),
    ),
    $('<div>').addClass('ygg-hint ygg-guide-hint').text('留空仅修补当前失败项；填写说明时按说明在原正文基础上增补、修改或撤回变化，失败不会覆盖原记录。'),
    errorBox,
    $('<div>').addClass('ygg-opening-preview').append(...previewChildren),
    failureSec,
    $('<div>').addClass('ygg-field').append($('<label>').text('修补说明（可选）'), textarea),
  );
  return {
    node: root,
    getInstruction: () => state.touched ? state.instruction : String(textarea.val() ?? ''),
    setError: message => { if (!message) errorBox.text('').hide(); else errorBox.text(String(message)).show(); },
  };
}
// 存档校验失败时只显示原因与只读边界；不显示记录原文、命令或任何可编辑入口。
export function readOnlyNode(title, text) {
  const body = $('<div>').addClass('ygg-body').append(text.split('\n').map(line => $('<div>').addClass('ygg-line').text(line)));
  return $('<details>').addClass('ygg-floor ygg-warn ygg-blocked').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').append(icon('lock'), $('<span>').text('只读')), $('<span>').text(title)), body);
}
// 权限不足与存档只读分开显示：脚本/正则未获准不是记录失配，不能误称存档只读。
export function permissionNode(text) {
  const body = $('<div>').addClass('ygg-body').append(text.split('\n').map(line => $('<div>').addClass('ygg-line').text(line)));
  return $('<details>').addClass('ygg-floor ygg-warn ygg-blocked').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').append(icon('lock'), $('<span>').text('权限')), $('<span>').text('权限不足')), body);
}
// 世界书纯增补（B 级）待升级卡片：只读展示新增角色组、新增剧情标记与待更新楼层，确认前不写任何楼层变量。
export function upgradeNode(upgrade, {onUpgrade = null, onInspect = null} = {}) {
  const floors = upgrade.待升级楼号?.length ?? 0;
  const floorList = (upgrade.待升级楼号 ?? []).map(id => `#${id}`).join('、') || '无';
  const body = $('<div>').addClass('ygg-body').append(
    $('<div>').addClass('ygg-line').text('世界书已增补更新（原有历史 0 冲突）：确认后将逐楼无损写入新快照与当前版本清单。'),
    $('<div>').addClass('ygg-items').append(
      $('<span>').addClass('ygg-key').text('新增角色组'), value(upgrade.新增角色组?.length ? upgrade.新增角色组 : '无'),
      $('<span>').addClass('ygg-key').text('新增剧情标记'), value(upgrade.新增剧情标记?.length ? upgrade.新增剧情标记 : '无'),
      $('<span>').addClass('ygg-key').text('将更新楼层'), value(`共 ${floors} 个助手楼（${floorList}）`),
    ),
  );
  if (onUpgrade || onInspect) {
    const actions = $('<div>').addClass('ygg-actions');
    if (onUpgrade) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('升级本局存档')
      .on('click', event => { event?.preventDefault?.(); return onUpgrade(); }));
    if (onInspect) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('查看差异详情')
      .on('click', event => { event?.preventDefault?.(); return onInspect(); }));
    body.append(actions);
  }
  return $('<details>').addClass('ygg-floor ygg-upgrade').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').append(icon('upgrade'), $('<span>').text('待升级')), $('<span>').text('世界书已增补更新（原有历史 0 冲突）')), body);
}
// 设置表单，分区仿 MVU 的额外模型解析：显示、记账（方式、连接、模型与拉取、参数、应答格式、测试）。改动即存。
// current 为当前设置，save(patch) 存，presets 为酒馆的代理预设名，activeModel 为酒馆当前的模型名；
// pull(settings) 返回模型列表，test(settings) 返回 {文本}，失败时抛出。
export function settingsNode({
  current, save, presets = [], activeModel = '', pull, test,
  appearance = null, saveAppearance = null, cardThemes = [], onAppearanceChange = null,
}) {
  const settings = {...current}, set = patch => {
    Object.assign(settings, patch);
    const saving = save(patch);
    saving?.catch?.(() => {});
    sync();
  };
  const hint = text => $('<div>').addClass('ygg-hint').text(text);
  const field = (label, control, note) => $('<div>').addClass('ygg-field').append($('<label>').text(label), control, ...(note ? [hint(note)] : []));
  const input = (key, type = 'text', attrs = {}) => $('<input>').addClass('text_pole').attr({type, ...attrs}).val(settings[key])
    .on('change', event => set({[key]: type === 'number' ? Number(event.target.value) : event.target.value}));
  const select = (key, options) => $('<select>').addClass('text_pole').append(options.map(([optionValue, label]) => $('<option>').val(optionValue).text(label)))
    .val(settings[key]).on('change', event => set({[key]: event.target.value}));
  const check = (key, label, note) => $('<label>').addClass('ygg-check').append(
    $('<input>').attr('type', 'checkbox').prop('checked', settings[key] === true).on('change', event => set({[key]: event.target.checked})),
    $('<span>').append($('<span>').text(label), ...(note ? [hint(note)] : [])));
  const section = (title, open, ...children) => $('<details>').addClass('ygg-sec').prop('open', open)
    .append($('<summary>').text(title), $('<div>').addClass('ygg-body').append(children));

  const sameHint = hint(`用酒馆当前的连接与模型${activeModel ? `（现在是 ${activeModel}）` : ''}。`);
  const manual = $('<div>').append(
    field('API 地址', input('地址', 'text', {placeholder: 'https://…/v1'}), 'OpenAI 兼容的地址，缺 /v1 时自动补上。'),
    field('密钥', input('密钥', 'password'), '以明文存在酒馆的全局变量里（MVU 也是这样存的），本机的其它脚本读得到。'));
  const modelInput = input('模型', 'text', {placeholder: '模型名'});
  const picker = $('<select>').addClass('text_pole').hide().on('change', event => { modelInput.val(event.target.value); set({模型: event.target.value}); });
  const pullButton = $('<button>').attr('type', 'button').addClass('menu_button').text('拉取模型');
  pullButton.on('click', async event => {
    event?.preventDefault?.();
    pullButton.prop('disabled', true).text('拉取中…');
    try {
      const models = await pull(settings);
      picker.empty().append($('<option>').val('').text(`选择模型（共 ${models.length} 个）`), models.map(id => $('<option>').val(id).text(id)))
        .val(models.includes(settings.模型) ? settings.模型 : '').show();
      toastr.success(`共 ${models.length} 个模型`, '世界树：拉取模型');
    } catch (error) { toastr.error(error.message, '世界树：拉取模型失败'); }
    finally { pullButton.prop('disabled', false).text('拉取模型'); }
  });
  const other = section('另设模型', true,
    field('连接', select('代理预设', [['', '手动填写地址与密钥'], ...presets.map(name => [name, `代理预设：${name}`])]),
      '选代理预设时，地址与密钥用酒馆里存的那一份；拉取模型只认手动填写的地址。'),
    manual,
    field('模型', $('<div>').addClass('ygg-row').append(modelInput, pullButton), '填写模型名，或拉取后从下面选。'),
    picker,
    field('来源', select('来源', [['openai', 'OpenAI 兼容'], ['custom', '自定义（custom）'], ['claude', 'Claude'], ['makersuite', 'Google AI Studio'], ['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter']]),
      '多数中转站选 OpenAI 兼容。'));

  const status = $('<span>').addClass('ygg-status');
  const testButton = $('<button>').attr('type', 'button').addClass('menu_button').css({display: 'inline-block', width: 'auto'}).text('测试记账连接');
  testButton.on('click', async event => {
    event?.preventDefault?.();
    testButton.prop('disabled', true);
    status.attr('data-tone', 'pending').text('测试中…');
    try { status.attr('data-tone', 'ok').text(`成功：${(await test(settings)).文本}`); }
    catch (error) { status.attr('data-tone', 'bad').text(`失败：${error.message}`); }
    finally { testButton.prop('disabled', false); }
  });
  const params = section('参数与应答格式', true,
    $('<div>').addClass('ygg-grid').append(
      field('温度', input('温度', 'number', {min: 0, max: 2, step: 0.1})),
      field('最大回复长度', input('最大长度', 'number', {min: 0, step: 256}), '0＝随预设'),
      field('尝试次数', input('尝试次数', 'number', {min: 1, max: 3, step: 1}), '结果不合规时重试')),
    field('应答格式', select('应答格式', [['结构化输出', '结构化输出（json_schema）'], ['提示词', '提示词要求 JSON']]),
      '源不支持 json_schema 时选“提示词要求 JSON”。'),
    $('<div>').addClass('ygg-field ygg-test-row').append(testButton, status));

  const mode = select('方式', [['同一模型', '同一模型'], ['另设模型', '另设模型'], ['关闭', '关闭（旧方式：叙事模型写 <命令>）']]);
  function sync() {
    sameHint.toggle(settings.方式 === '同一模型');
    other.toggle(settings.方式 === '另设模型');
    manual.toggle(!settings.代理预设);
    params.toggle(settings.方式 !== '关闭');
  }

  let appearanceSection = null;
  if (appearance && typeof appearance === 'object') {
    const appState = {...DEFAULT_APPEARANCE, ...appearance};
    const cards = Array.isArray(cardThemes) ? cardThemes.filter(item => item && typeof item.id === 'string') : [];
    const allThemes = [...cards, ...BUILTIN_THEMES];
    const triEncode = value => value === true ? 'on' : value === false ? 'off' : 'auto';
    const triDecode = value => value === 'on' ? true : value === 'off' ? false : null;

    const themeDesc = $('<div>').addClass('ygg-theme-desc');
    const updateThemeDesc = (resolved = resolveAppearance(appState, cards)) => {
      const sourceTag = resolved.theme.source === 'card' ? '本卡专属' : '内置官方';
      const autoNote = appState.主题 === 'auto' ? `（当前跟随默认：${resolved.theme.name}）` : '';
      themeDesc.text(`[${sourceTag}] ${resolved.theme.name}${autoNote} — ${resolved.theme.description || '无说明'}`);
    };

    const setApp = patch => {
      Object.assign(appState, patch);
      const saving = saveAppearance?.(patch);
      saving?.catch?.(() => {});
      const resolved = resolveAppearance(appState, cards);
      updateThemeDesc(resolved);
      form.attr('data-ygg-theme', resolved.themeId);
      onAppearanceChange?.({...appState});
    };

    const themeOptions = [
      ['auto', cards.length ? `跟随本卡默认（${(cards.find(t => t.default) ?? cards[0]).name}）` : '跟随本卡默认（现代工具）'],
      ...cards.map(t => [t.id, `[本卡] ${t.name}`]),
      ...BUILTIN_THEMES.map(t => [t.id, t.name]),
    ];
    const themeSelect = $('<select>').addClass('text_pole').attr('data-ygg-setting', 'theme')
      .append(themeOptions.map(([v, label]) => $('<option>').val(v).text(label)))
      .val(allThemes.some(t => t.id === appState.主题) || appState.主题 === 'auto' ? appState.主题 : 'auto')
      .on('change', event => setApp({主题: event.target.value}));

    const variantSelect = $('<select>').addClass('text_pole').attr('data-ygg-setting', 'floorVariant')
      .append([
        ['auto', '跟随主题默认'],
        ['bar', '精简底条'],
        ['card', '场景抬头卡'],
        ['minimal', '极简徽章'],
      ].map(([v, label]) => $('<option>').val(v).text(label)))
      .val(appState.每楼形态 || 'auto')
      .on('change', event => setApp({每楼形态: event.target.value}));

    const triSelect = (key, dataKey) => $('<select>').addClass('text_pole').attr('data-ygg-setting', dataKey)
      .append([
        ['auto', '跟随主题默认'],
        ['on', '开启'],
        ['off', '关闭'],
      ].map(([v, label]) => $('<option>').val(v).text(label)))
      .val(triEncode(appState[key]))
      .on('change', event => setApp({[key]: triDecode(event.target.value)}));

    const proseSelect = triSelect('正文美化', 'proseBeautify');
    const dialogueSelect = triSelect('对白高亮', 'dialogueHighlight');
    const indentSelect = triSelect('首行缩进', 'firstLineIndent');

    const scaleInput = $('<input>').addClass('text_pole').attr({type: 'number', min: 0.9, max: 1.2, step: 0.05, 'data-ygg-setting': 'proseScale'})
      .val(appState.正文字号)
      .on('change', event => {
        const num = Number(event.target.value);
        if (Number.isFinite(num)) setApp({正文字号: Math.min(1.2, Math.max(0.9, num))});
      });
    const leadingInput = $('<input>').addClass('text_pole').attr({type: 'number', min: 1.5, max: 2.2, step: 0.05, 'data-ygg-setting': 'proseLeading'})
      .val(appState.正文行距)
      .on('change', event => {
        const num = Number(event.target.value);
        if (Number.isFinite(num)) setApp({正文行距: Math.min(2.2, Math.max(1.5, num))});
      });

    const customCssInput = $('<textarea>').addClass('text_pole').attr({rows: 4, 'data-ygg-setting': 'customCss',
      placeholder: '例：.ygg-panel { --ygg-accent: #7c6bf0; }（外链、@import 与危险规则会被自动剥离）'})
      .val(appState.自定义CSS ?? '')
      .on('input', event => setApp({自定义CSS: String(event?.target?.value ?? '')}))
      .on('change', event => setApp({自定义CSS: String(event?.target?.value ?? '')}));

    const resetBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('恢复默认外观')
      .on('click', event => {
        event?.preventDefault?.();
        const resetPatch = {...DEFAULT_APPEARANCE};
        themeSelect.val(resetPatch.主题);
        variantSelect.val(resetPatch.每楼形态);
        proseSelect.val('auto');
        dialogueSelect.val('auto');
        indentSelect.val('auto');
        scaleInput.val(resetPatch.正文字号);
        leadingInput.val(resetPatch.正文行距);
        customCssInput.val(resetPatch.自定义CSS);
        setApp(resetPatch);
      });

    updateThemeDesc();
    appearanceSection = section('外观与正文', true,
      field('前端主题', themeSelect),
      themeDesc,
      field('每楼状态栏形态', variantSelect, '场景抬头卡展示本楼时间、地点与在场快照；极简徽章最克制。'),
      $('<div>').addClass('ygg-appearance-grid').append(
        field('正文美化排版', proseSelect),
        field('对白引号高亮', dialogueSelect),
        field('中文首行缩进', indentSelect),
      ),
      $('<div>').addClass('ygg-range-grid').append(
        field('正文字号缩放（0.9–1.2）', scaleInput),
        field('正文行距（1.5–2.2）', leadingInput),
      ),
      section('高级：自定义 CSS', false,
        field('附加样式（仅本机生效，自动消毒外链与危险规则）', customCssInput),
        $('<div>').addClass('ygg-field').append(resetBtn),
      ),
    );
  }

  const form = $('<div>').addClass('ygg-panel ygg-form').attr('data-ygg-theme', activeAppearance.themeId).append(
    $('<div>').addClass('ygg-panel-head').append(
      $('<div>').addClass('ygg-panel-brand').append(icon('sliders', true), $('<h3>').text('世界树：设置')),
    ),
    section('显示', true,
      check('每楼记录', '每楼下方显示这一楼记了什么', '只显示在页面上，不进提示词。'),
      check('调试', '调试', '本局面板显示全部事件与各楼的记账结果，每楼记录附命令，失败提示写出细节。会看到尚未发生的事件。')),
    ...(appearanceSection ? [appearanceSection] : []),
    section('记账', true, field('记账用的模型', mode), sameHint, other, params));
  sync();
  return form;
}

// 状态、弹窗与每楼一行：运行时状态由调用方持有（session），这里只按状态画提示并处理权限/只读的展示。
export const popup = (node, options = {wide: true, large: true}) =>
  SillyTavern.callGenericPopup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});

export function modalPopup(node, options = {wide: true, large: true}, track = null) {
  if (typeof SillyTavern.Popup !== 'function') return popup(node, options);
  const instance = new SillyTavern.Popup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});
  track?.(instance);
  return instance.show().finally(() => track?.(null, instance));
}

function extractFloorScene(state) {
  if (!state || typeof state !== 'object') return null;
  const time = state.世界?.当前时间 || '';
  const placeObj = state.世界?.当前地点;
  const place = placeObj ? `${placeObj.地标}${placeObj.场景 ? `·${placeObj.场景}` : ''}` : '';
  const present = [];
  for (const [id, role] of Object.entries(state.角色 ?? {})) {
    if (role?.在场 === true) present.push(role.名称 || id);
  }
  if (!time && !place && !present.length) return null;
  return {时间: time, 地点: place, 在场: present};
}

export function createStatusView({session, injectId, messages, chatId, recordOf, checkRecord, floorOf, keeperSettings,
  openOpening, rekeepFor, repairFor, runUpgrade, getAppearance = () => activeAppearance}) {
  const show = (title, text) => popup(textNode(title, text));
  const showSections = (title, sections) => popup(panelNode(title, sections));
  const showBlocked = () => {
    const sections = [{标题: '世界树', 展开: true, 行: [
      session.integrity.说明,
      '错误码：' + session.integrity.code + (Number.isSafeInteger(session.integrity.楼号) ? '，楼号：' + session.integrity.楼号 : ''),
      '原始变量保持不变；不会自动迁移、补记账、提交命令或继续生成。',
    ]}];
    if (session.integrity.差异?.length) {
      sections.push({
        标题: `冲突差异明细（共 ${session.integrity.差异总数 || session.integrity.差异.length} 处）`,
        展开: true,
        行: session.integrity.差异,
      });
    }
    return showSections('存档不可用（只读）', sections);
  };
  const showUpgrade = () => {
    const up = session.upgrade;
    if (!up) return;
    const floorList = (up.待升级楼号 ?? []).map(id => `#${id}`).join('、') || '无';
    const groupLines = (up.新增角色组详情 ?? []).map(item => `+ 开局.角色组.${item.id}（启用=${item.启用}，版本ID=${item.版本ID}）`);
    const markLines = (up.新增剧情标记详情 ?? []).map(item => `+ 世界.剧情标记.${item.id}=${item.初值}`);
    return showSections('世界书已增补更新（待升级）', [
      {标题: '升级摘要', 展开: true,
        行: ['世界书已增补更新（原有历史 0 冲突）；确认升级前保持只读且未修改任何楼层变量。'],
        项: [
          ['新增角色组', up.新增角色组?.length ? up.新增角色组 : '无'],
          ['新增剧情标记', up.新增剧情标记?.length ? up.新增剧情标记 : '无'],
          ['将更新楼层', `共 ${up.待升级楼号?.length ?? 0} 个助手楼（${floorList}）`],
        ]},
      {标题: '增补差异明细（只读）', 展开: true,
        行: [...groupLines, ...markLines].length ? [...groupLines, ...markLines] : ['无增补明细']},
    ]);
  };

  // 权限诊断自身可能运行在残缺宿主上：toast 缺失时保留控制台诊断，不把诊断变成新的异常。
  function toastError(body, title) {
    try {
      if (typeof globalThis.toastr?.error === 'function') { globalThis.toastr.error(body, title); return; }
    } catch (error) { console.warn('世界树：toast 失败', error); }
    console.error(title + '：' + body);
  }

  function clearInjection() {
    if (typeof globalThis.uninjectPrompts !== 'function') return;
    try { globalThis.uninjectPrompts([injectId]); } catch (error) { console.warn('世界树：注入清理失败', error); }
  }

  function attachFloor(id, node) {
    const box = retrieveDisplayedMessage(id);
    if (box.length) box.after(node); else $('#chat').append(node);
  }

  function renderFloors() {
    if (typeof globalThis.$ !== 'function') return;
    $('#chat .ygg-floor').remove();
    if (session.permission) {
      const id = messages().at(-1)?.message_id;
      const node = permissionNode('权限不足：' + session.permission.说明 + '\n原因：' + session.permission.code
        + '\n原始聊天与楼层变量未被改写；恢复权限后重新生成即可继续。');
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.openingPending) {
      const id = messages()[0]?.message_id, node = openingStatusNode({open: openOpening,
        reason: session.last?.error?.startsWith('已取消') ? '上一次开局已取消，选择仍可重新打开。' : '请先打开开局并确认。'});
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.upgrade) {
      const id = Number.isSafeInteger(session.upgrade.楼号) ? session.upgrade.楼号 : messages().at(-1)?.message_id;
      const node = upgradeNode(session.upgrade, {onUpgrade: runUpgrade, onInspect: showUpgrade});
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.integrity) {
      const id = Number.isSafeInteger(session.integrity.楼号) ? session.integrity.楼号 : messages().at(-1)?.message_id;
      const total = session.integrity.差异总数 || session.integrity.差异?.length || 0;
      const diffLines = session.integrity.差异?.length
        ? [`冲突差异（共 ${total} 处${total > session.integrity.差异.length ? `，显示前 ${session.integrity.差异.length} 处` : ''}）：`,
           ...session.integrity.差异]
        : [];
      const node = readOnlyNode('存档只读：' + session.integrity.说明,
        ['原因：' + session.integrity.code, ...diffLines,
         '原始楼层变量保持不变；不会自动迁移、补记账、提交命令或继续生成。',
         '继续游玩请新建兼容聊天，或切换到合法的聊天。'].join('\n'));
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    const resolved = getAppearance?.() ?? activeAppearance;
    if (!keeperSettings().每楼记录) {
      applyProseAppearance(resolved);
      return;
    }
    const verbose = keeperSettings().调试 === true, rekeep = keeperSettings().方式 !== '关闭';
    let before = null;
    for (const message of messages()) {
      const id = message.message_id;
      if (id === session.keepingFloor) { attachFloor(id, floorNode(null, {pending: true, variant: resolved.每楼形态})); continue; }
      if (message.role !== 'assistant') continue;
      const record = recordOf(message);
      if (!checkRecord(record, message)) continue;
      try {
        if (id === 0) before = {世界: {当前时间: record.本局?.世界?.当前时间, 剧情标记: record.本局?.世界?.剧情标记 ?? {}},
          开局: record.本局?.开局 ?? {}, 角色: {}, 事件: {}, 待定项: []};
        if (before === null) continue;
        const line = floorOf(before, record.本局, record, verbose);
        const editableFloor = id > 0 || (id === 0 && isDynamicOpening(record));
        const again = rekeep && editableFloor ? rekeepFor(id) : null;
        const repair = rekeep && editableFloor && repairFor ? repairFor(id) : null;
        attachFloor(id, floorNode(line, {
          rekeep: again, repair, variant: resolved.每楼形态, scene: extractFloorScene(record.本局),
        }));
        before = record.本局;
      } catch (error) { console.warn('世界树：每楼记录', error); }
    }
    applyProseAppearance(resolved);
  }

  function upgradePending(result) {
    const fresh = !session.upgrade;
    session.openingPending = false;
    session.integrity = null;
    session.upgrade = {
      chatId: result.chatId ?? chatId?.() ?? '',
      code: result.code ?? '运行清单.世界书哈希',
      说明: result.说明 ?? '世界书已增补更新，请先确认升级本局存档',
      楼号: result.楼号,
      ...(result.upgrade ?? {}),
      snapshots: result.snapshots ?? result.upgrade?.归属快照 ?? [],
    };
    session.last = {error: session.upgrade.说明, code: session.upgrade.code, floor: session.upgrade.楼号};
    uninjectPrompts([injectId]);
    renderFloors();
    if (fresh) toastr.warning('世界书已增补更新，请先确认升级本局存档。', '世界树：待升级存档');
    return false;
  }

  function blocked(result) {
    if (result?.级别 === 'B') return upgradePending(result);
    session.openingPending = false;
    session.upgrade = null;
    session.integrity = {
      code: result.code ?? '校验.失败',
      说明: result.说明 ?? '楼层记录不可用',
      楼号: result.楼号,
      差异: result.差异 ?? [],
      差异总数: result.差异总数 ?? (result.差异?.length ?? 0),
    };
    session.last = {error: session.integrity.说明, code: session.integrity.code, floor: session.integrity.楼号};
    uninjectPrompts([injectId]);
    renderFloors();
    toastr.error(session.integrity.说明, '世界树：存档只读（' + session.integrity.code + '）');
    return false;
  }

  function permissionBlocked(result) {
    const changed = !session.permission || session.permission.code !== result.code || session.permission.说明 !== result.说明;
    session.permission = {code: result.code ?? '权限.失败', 说明: result.说明 ?? '卡内脚本或局部正则未获准'};
    session.integrity = null;
    session.upgrade = null;
    session.last = {error: session.permission.说明, code: session.permission.code, floor: null};
    clearInjection();
    try { renderFloors(); } catch (error) { console.warn('世界树：权限提示渲染失败', error); }
    if (changed) toastError(session.permission.说明, '世界树：权限不足（' + session.permission.code + '）');
    return false;
  }

  function pendingOpening(reason = '尚未开局') {
    session.openingPending = true;
    session.integrity = null;
    session.upgrade = null;
    session.last = {error: reason, code: '开局.未完成', floor: 0};
    uninjectPrompts([injectId]);
    renderFloors();
    return false;
  }

  return {show, showSections, showBlocked, showUpgrade, toastError, clearInjection, renderFloors, attachFloor,
    blocked, upgradePending, permissionBlocked, pendingOpening};
}
