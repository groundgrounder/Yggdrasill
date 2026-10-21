// 方言：结构通用、取值随作品变化的部分（纪年、等级、分类词表、数值范围等）。
// 配置写在项目根的 yggdrasill.yaml，键为中文；createDialect 把它编译为协议可用的对象。
import {CLASSIFICATION, CONDITION_TYPES, CONTEXT_DEFAULTS, PROJECTED_ROLE_FIELDS} from './contract.mjs';

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const uniqueTexts = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim()) && new Set(v).size === v.length;
const fail = m => { throw new Error('方言配置错误：' + m); };
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 纪年：前缀 + 定长年份 + 可选两位月日。每月天数可为整数或逐月列表。
export function createCalendar({前缀, 年位数 = 4, 月数 = 12, 每月天数 = 30} = {}) {
  if (typeof 前缀 !== 'string' || !前缀.trim()) fail('纪年.前缀须为非空文本');
  if (!Number.isSafeInteger(年位数) || 年位数 < 1) fail('纪年.年位数须为正整数');
  if (!Number.isSafeInteger(月数) || 月数 < 1 || 月数 > 99) fail('纪年.月数须为 1–99 的整数');
  const months = Array.isArray(每月天数) ? 每月天数 : Array(月数).fill(每月天数);
  if (months.length !== 月数 || months.some(d => !Number.isSafeInteger(d) || d < 1 || d > 99)) fail('纪年.每月天数须为 1–99 的整数或逐月列表');
  const offsets = months.reduce((acc, d, i) => [...acc, acc[i] + d], [0]), yearDays = offsets.at(-1);
  const pattern = new RegExp(`^${escape(前缀)}(\\d{${年位数}})年(?:(\\d{2})月(\\d{2})日)?$`);
  // 返回半开区间 [起, 止)，单位为日；只写年时覆盖整年。非法值返回 null。
  function time(value) {
    const m = typeof value === 'string' && pattern.exec(value);
    if (!m) return null;
    if (m[2] && (+m[2] < 1 || +m[2] > 月数 || +m[3] < 1 || +m[3] > months[+m[2] - 1])) return null;
    const start = +m[1] * yearDays + (m[2] ? offsets[+m[2] - 1] + +m[3] - 1 : 0);
    return [start, start + (m[2] ? 1 : yearDays)];
  }
  return {
    prefix: 前缀, yearDays, time,
    year: value => { const t = time(value); return t ? Math.floor(t[0] / yearDays) : null; },
    format: year => `${前缀}${String(year).padStart(年位数, '0')}年`,
    looksLike: value => typeof value === 'string' && value.startsWith(前缀),
    pattern: `${前缀}${'Y'.repeat(年位数)}年[MM月DD日]`,
  };
}

export function createRanks(tiers = []) {
  if (!uniqueTexts(tiers)) fail('等级须为无重复的文本列表');
  const list = Object.freeze([...tiers]);
  const rank = v => typeof v === 'string' && list.includes(v);
  // 比较值从 1 起；缺失或非法为 0，不参与比较。
  const rankValue = v => rank(v) ? list.indexOf(v) + 1 : 0;
  return {ranks: list, rank, rankValue, higher: (a, b) => rankValue(b) > rankValue(a) ? b : a};
}

const contextKeys = {经历条数: 'historyLimit', 经历字符: 'historyCharBudget', 候选条数: 'candidateLimit', 候选字符: 'candidateCharBudget', 技能条数: 'skillLimit'};

export function createDialect(config = {}) {
  if (!plain(config)) fail('须为映射');
  const calendar = createCalendar(config.纪年);
  const ranks = createRanks(config.等级 ?? []);
  const ranges = {};
  for (const [field, range] of Object.entries(config.数值范围 || {})) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] > range[1]) fail(`数值范围.${field} 须为 [下限, 上限]`);
    ranges[field] = Object.freeze([...range]);
  }
  const maxDelta = config.单次增减上限 ?? 100;
  if (!Number.isSafeInteger(maxDelta) || maxDelta < 1) fail('单次增减上限须为正整数');
  const equipmentStates = config.装备状态 ?? ['完好', '破损', '报废'];
  if (!uniqueTexts(equipmentStates)) fail('装备状态须为无重复的文本列表');
  const classification = {};
  for (const [k, fallback] of Object.entries(CLASSIFICATION)) {
    const v = config.事件分类?.[k] ?? fallback;
    if (!uniqueTexts(v) || !v.length) fail(`事件分类.${k} 须为非空无重复文本列表`);
    classification[k] = Object.freeze([...v]);
  }
  const conditionNames = config.条件类型 ?? Object.keys(CONDITION_TYPES);
  if (!uniqueTexts(conditionNames) || conditionNames.some(c => !CONDITION_TYPES[c])) fail('条件类型只能从核心条件中选取');
  const context = {...CONTEXT_DEFAULTS};
  for (const [k, v] of Object.entries(config.上下文预算 || {})) {
    if (!contextKeys[k] || !Number.isSafeInteger(v) || v < 0) fail('上下文预算项非法 ' + k);
    context[contextKeys[k]] = v;
  }
  const projected = config.运行变量?.输出字段 ?? PROJECTED_ROLE_FIELDS;
  if (!uniqueTexts(projected)) fail('运行变量.输出字段须为无重复文本列表');
  const visible = config.模型可见 || {};
  for (const k of ['来源标签', '说明豁免']) if (visible[k] !== undefined && !uniqueTexts(visible[k])) fail(`模型可见.${k} 须为无重复文本列表`);
  const earliestYear = config.抽样?.最早开局年 ?? 0;
  if (!Number.isSafeInteger(earliestYear) || earliestYear < 0) fail('抽样.最早开局年须为非负整数');
  return Object.freeze({
    name: config.项目 ?? '', config,
    calendar, time: calendar.time, ...ranks,
    ranges: Object.freeze(ranges), maxDelta, equipmentStates: Object.freeze([...equipmentStates]),
    classification: Object.freeze(classification), conditions: Object.freeze(new Set(conditionNames)),
    context: Object.freeze(context), projectedFields: Object.freeze([...projected]),
    sourceLabels: Object.freeze([...(visible.来源标签 || [])]), descriptionExempt: Object.freeze([...(visible.说明豁免 || [])]),
    earliestYear,
  });
}

export const isDialect = d => !!d && typeof d.time === 'function' && typeof d.rank === 'function';
export function requireDialect(d, where = '') {
  if (!isDialect(d)) throw new Error('缺少方言' + (where ? '：' + where : '') + '；请先用 createDialect 读取 yggdrasill.yaml');
  return d;
}
