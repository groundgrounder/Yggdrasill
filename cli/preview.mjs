import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {timelineEnd} from '../core/what-if.mjs';

const USAGE = '用法：ygg preview <世界书目录> <角色组ID> [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>] [--json]';

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
    if (args.includes('--json')) stdout.write(`${JSON.stringify(failureResult(null, error), null, 2)}\n`);
    return 1;
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
    const result = {
      角色组: parsed.角色组,
      开局: state?.世界?.当前时间 ?? null,
      方案: parsed.方案 ?? state?.开局?.方案 ?? null,
      预览: preview ?? null,
      原因: reason,
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
  const result = {世界书: null, 角色组: null, 开局: null, 方案: null, 本局: null, json: false};
  const positionals = [];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--json') { result.json = true; continue; }
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
  if (positionals.length !== 2)
    throw new PreviewError('预览.参数', positionals.length > 2
      ? `多余位置参数：${positionals.slice(2).join(' ')}` : '需要世界书目录与角色组ID');
  result.世界书 = positionals[0];
  result.角色组 = positionals[1];
  if (result.本局 && (result.开局 || result.方案))
    throw new PreviewError('预览.参数', '--本局 不能与 --开局 或 --方案 同用');
  return result;
}

export function formatPreview(result) {
  const lines = [`角色组：${result?.角色组 ?? '无'}`];
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
  lines.push('', `异常（${result?.异常?.length ?? 0}）`);
  if (result?.异常?.length) for (const item of result.异常)
    lines.push(`  - ${item.级别} ${item.规则} ${item.文件}：${item.说明}`);
  else lines.push('  无');
  return `${lines.join('\n')}\n`;
}

function sealState(protocol, catalog, decl, parsed) {
  if (parsed.方案 && !listPlans(catalog).some(plan => plan.id === parsed.方案))
    throw new PreviewError('预览.方案', `开局方案不存在：${parsed.方案}`);
  const opening = parsed.开局 ?? axisEnd(catalog, decl);
  const config = {开局时间: opening};
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

function failureResult(parsed, error) {
  const known = error instanceof PreviewError;
  return {
    角色组: parsed?.角色组 ?? null,
    开局: null,
    方案: parsed?.方案 ?? null,
    预览: null,
    原因: null,
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

function abilityText(ability) {
  const entries = Object.entries(ability ?? {});
  if (!entries.length) return '无';
  return entries.map(([name, value]) => `${name}: ${renderValue(value)}`).join('；');
}

function equipmentText(equipment) {
  if (!Array.isArray(equipment) || !equipment.length) return '无';
  return equipment.map(item => `${item.装备ID}（${item.状态}，${item.位置}）`).join('；');
}

function renderValue(value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '无';
  if (value && typeof value === 'object')
    return Object.entries(value).map(([key, item]) => `${key}=${renderValue(item)}`).join('、');
  return String(value);
}
