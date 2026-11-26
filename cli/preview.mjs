import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {timelineEnd} from '../core/what-if.mjs';

const USAGE = '用法：ygg preview <世界书目录> <角色组ID> [--世界线 <世界线ID>] [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>] [--状态] [--json]';

export class PreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
  }
}

export async function runPreview(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? '预览.参数'}：${error.message}\n`);
    if (Array.isArray(args) && args.includes('--json'))
      stdout.write(`${JSON.stringify(failureResult(null, error, args.includes('--状态')), null, 2)}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const root = path.resolve(cwd, parsed.世界书);
  try {
    const {catalog, decl, issues} = await compileWorldbook(root, {fs, path});

    if (!listGroups(catalog).some(group => group.id === parsed.角色组))
      throw new PreviewError('预览.角色组', `角色组不存在：${parsed.角色组}`);

    const protocol = createProtocol({catalog, decl});
    const state = parsed.本局 ? await readState(parsed.本局, {cwd, fs, path}) : sealState(protocol, catalog, decl, parsed);

    let preview;
    try { preview = protocol.initializationPreview(state, parsed.角色组); }
    catch (error) {
      if (parsed.本局) throw new PreviewError('预览.本局', `本局状态不合法：${error?.message ?? error}`);
      throw error;
    }
    const reason = preview ? null : explain(state, parsed.角色组);
    const worldline = parsed.世界线 ?? state?.开局?.世界线 ?? null;
    const result = {
      角色组: parsed.角色组,
      ...(worldline ? {世界线: worldline} : {}),
      开局: state?.世界?.当前时间 ?? null,
      方案: parsed.方案 ?? state?.开局?.方案 ?? null,
      预览: preview ?? null,
      原因: reason,
      ...(parsed.状态 ? {状态: structuredClone(state?.角色?.[parsed.角色组] ?? {})} : {}),
      异常: issues,
    };
    writeResult(result, {json: parsed.json, stdout, stderr});
    return issues.some(item => item?.级别 === '错误') ? 1 : 0;
  } catch (error) {
    const result = failureResult(parsed, error);
    writeResult(result, {json: parsed.json, stdout, stderr});
    return 1;
  }
}

export function parseArgs(args) {
  if (!Array.isArray(args)) throw new PreviewError('预览.参数', 'preview 参数须为列表');
  const result = {世界书: null, 角色组: null, 世界线: null, 开局: null, 方案: null, 本局: null, 状态: false, json: false, help: false};
  const positionals = [];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') { result.help = true; continue; }
    if (value === '--json') { result.json = true; continue; }
    if (value === '--状态') { result.状态 = true; continue; }
    if (value === '--世界线') {
      once(seen, '--世界线');
      result.世界线 = optionValue(args, ++index, '--世界线');
      continue;
    }
    if (value === '--开局') {
      once(seen, '--开局');
      result.开局 = optionValue(args, ++index, '--开局');
      continue;
    }
    if (value === '--方案') {
      once(seen, '--方案');
      result.方案 = optionValue(args, ++index, '--方案');
      continue;
    }
    if (value === '--本局') {
      once(seen, '--本局');
      result.本局 = optionValue(args, ++index, '--本局');
      continue;
    }
    if (value.startsWith('-')) throw new PreviewError('预览.参数', `未知选项：${value}`);
    positionals.push(value);
  }
  if ((!result.help && positionals.length !== 2) || (result.help && positionals.length > 2))
    throw new PreviewError('预览.参数', positionals.length > 2
      ? `多余位置参数：${positionals.slice(2).join(' ')}` : '需要世界书目录与角色组ID');
  result.世界书 = positionals[0] ?? null;
  result.角色组 = positionals[1] ?? null;
  if (result.本局 && (result.开局 || result.方案 || result.世界线))
    throw new PreviewError('预览.参数', '--本局 不能与 --世界线、--开局 或 --方案 同用');
  return result;
}

export function formatPreview(result) {
  const lines = [`角色组：${result?.角色组 ?? '无'}`];
  if (result?.世界线) lines.push(`世界线：${result.世界线}`);
  lines.push(`开局：${result?.开局 ?? '无'}`);
  lines.push(`方案：${result?.方案 ?? '默认'}`);
  if (result?.预览) {
    const preview = result.预览;
    lines.push('预览');
    lines.push(`  档案：${preview.档案ID ?? '无'}`);
    lines.push(`  能力：${abilityText(preview.能力)}`);
    lines.push(`  装备：${equipmentText(preview.装备)}`);
  } else {
    lines.push(`预览：无${result?.原因 ? `（${result.原因}）` : ''}`);
  }
  if (result && Object.hasOwn(result, '状态')) {
    lines.push('', '状态', ...formatStateLines(result.状态));
  }
  lines.push('', `异常（${result?.异常?.length ?? 0}）`);
  if (result?.异常?.length) for (const item of result.异常)
    lines.push(`  - ${item.级别} ${item.规则} ${item.文件}：${item.说明}`);
  else lines.push('  无');
  return `${lines.join('\n')}\n`;
}

function sealState(protocol, catalog, decl, parsed) {
  if (parsed.世界线 && !listWorldlines(catalog).some(worldline => worldline.id === parsed.世界线))
    throw new PreviewError('预览.世界线', `世界线不存在：${parsed.世界线}`);
  if (parsed.方案 && !listPlans(catalog).some(plan => plan.id === parsed.方案))
    throw new PreviewError('预览.方案', `开局方案不存在：${parsed.方案}`);
  const opening = parsed.开局 ?? axisEnd(catalog, decl);
  const config = {开局时间: opening};
  if (parsed.世界线) config.世界线 = parsed.世界线;
  if (parsed.方案) config.方案 = parsed.方案;
  try { return protocol.seal(config); }
  catch (error) {
    if (error?.name === 'ProtocolError') throw new PreviewError('预览.封卷', `${error.code}：${error.message}`);
    throw error;
  }
}

// 时间轴末尾与 if 共用 core/what-if.mjs 的同一实现。
function axisEnd(catalog, decl) {
  try { return timelineEnd(catalog, decl); }
  catch (error) { throw new PreviewError('预览.时间轴', error?.message ?? '无法确定时间轴末尾'); }
}

async function readState(file, {cwd, fs, path}) {
  let text;
  try { text = await fs.readFile(path.resolve(cwd, file), 'utf8'); }
  catch { throw new PreviewError('预览.本局', `无法读取本局文件：${file}`); }
  let state;
  try { state = JSON.parse(text); }
  catch { throw new PreviewError('预览.本局', `本局文件不是合法 JSON：${file}`); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state?.开局?.已封卷 !== true)
    throw new PreviewError('预览.本局', '本局文件须是已封卷的本局状态');
  return state;
}

function explain(state, id) {
  if (state?.开局?.角色组?.[id]?.启用 !== true) return '未启用';
  if (state?.角色?.[id]?.已初始化 === true) return '已初始化';
  return '当前档案不成立';
}

function writeResult(result, {json, stdout, stderr}) {
  if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.异常.some(item => item?.级别 === '错误')) stderr.write(formatPreview(result));
  else stdout.write(formatPreview(result));
}

function failureResult(parsed, error, includeState = Boolean(parsed?.状态)) {
  const known = error instanceof PreviewError;
  return {
    角色组: parsed?.角色组 ?? null,
    开局: null,
    方案: parsed?.方案 ?? null,
    预览: null,
    原因: null,
    ...(includeState ? {状态: null} : {}),
    异常: [{规则: known ? error.code : '预览.读取失败', 级别: '错误', 文件: parsed?.世界书 ?? 'preview',
      说明: known ? error.message
        : `无法完成只读预览：${error?.code ? `${error.code}：` : ''}${error?.message ?? String(error)}`}],
  };
}

function optionValue(args, index, option) {
  const value = args[index];
  if (typeof value !== 'string' || !value.length || value.startsWith('-'))
    throw new PreviewError('预览.参数', `${option} 缺少值`);
  return value;
}

function once(seen, option) {
  if (seen.has(option)) throw new PreviewError('预览.参数', `${option} 只能给出一次`);
  seen.add(option);
}

function listGroups(catalog) { return Array.isArray(catalog?.groups) ? catalog.groups : []; }
function listPlans(catalog) { return Array.isArray(catalog?.openingPlans) ? catalog.openingPlans : []; }
function listWorldlines(catalog) { return Array.isArray(catalog?.worldlines) ? catalog.worldlines : []; }

function abilityText(ability) {
  const entries = Object.entries(ability ?? {});
  if (!entries.length) return '无';
  return entries.map(([name, value]) => `${name}: ${renderValue(value)}`).join('；');
}

function equipmentText(equipment) {
  if (!Array.isArray(equipment) || !equipment.length) return '无';
  return equipment.map(item => `${item.装备ID}（${item.状态}，${item.位置}）`).join('；');
}

const STATE_KEY_ORDER = ['在场', '所在', '已初始化', '身份', '职位', '关系', '好感度', '知识', '身体状态', '装备', '能力移除记录'];

function formatStateLines(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return ['  无'];
  const entries = Object.entries(state)
    .filter(([, value]) => !isEmptyStateValue(value))
    .sort(([left], [right]) => compareStateKeys(left, right));
  if (!entries.length) return ['  无'];
  return entries.map(([key, value]) => `  ${key}：${formatStateValue(key, value)}`);
}

function isEmptyStateValue(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compareStateKeys(left, right) {
  const leftRank = STATE_KEY_ORDER.indexOf(left);
  const rightRank = STATE_KEY_ORDER.indexOf(right);
  if (leftRank !== -1 || rightRank !== -1) {
    if (leftRank === -1) return 1;
    if (rightRank === -1) return -1;
    return leftRank - rightRank;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatStateValue(key, value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === '装备' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([id, item]) => item && typeof item === 'object' && !Array.isArray(item)
        ? `${id}（${item.状态 ?? '未知'}，${item.位置 ?? '未知'}）`
        : `${id}=${renderSortedValue(item)}`)
      .join('；');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, item]) => `${name}=${renderSortedValue(item)}`)
      .join('；');
  }
  return renderSortedValue(value);
}

function renderSortedValue(value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.map(renderSortedValue).join('、') : '无';
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${key}=${renderSortedValue(item)}`)
      .join('、');
  }
  return String(value);
}

function renderValue(value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '无';
  if (value && typeof value === 'object')
    return Object.entries(value).map(([key, item]) => `${key}=${renderValue(item)}`).join('、');
  return String(value);
}
