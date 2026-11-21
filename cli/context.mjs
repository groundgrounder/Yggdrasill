import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {previewContext, ContextError} from '../core/context-preview.mjs';

const USAGE = '用法：ygg context <世界书目录> [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>]\n'
  + '      [--地点 <地标ID>] [--场景 <场景文本>] [--在场 <角色组ID>]... [--消息 <文本>]...\n'
  + '      [--不自动初始化] [--raw] [--json]';
const SINGLE_OPTIONS = ['--开局', '--方案', '--本局', '--地点', '--场景'];

export async function runContext(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? '上下文.参数'}：${error.message}\n`);
    if (args.includes('--json')) stdout.write(`${JSON.stringify(failureResult(null, error), null, 2)}\n`);
    return 1;
  }
  const root = path.resolve(cwd, parsed.世界书);
  try {
    const result = await previewContext(root, {fs, path, cwd,
      开局: parsed.开局, 方案: parsed.方案, 本局: parsed.本局, 地点: parsed.地点, 场景: parsed.场景,
      在场: parsed.在场, 消息: parsed.消息, 自动初始化: parsed.自动初始化, raw: parsed.raw});
    if (parsed.json) stdout.write(`${JSON.stringify({...result, 异常: []}, null, 2)}\n`);
    else if (parsed.raw) stdout.write(result.正文);
    else stdout.write(formatContext(result));
    return 0;
  } catch (error) {
    const known = error instanceof ContextError;
    const failure = known ? error : new ContextError('上下文.读取失败', `无法完成只读预览：${error?.message ?? String(error)}`);
    stderr.write(`错误 ${failure.code}：${failure.message}\n`);
    if (parsed.json) stdout.write(`${JSON.stringify(failureResult(parsed, failure), null, 2)}\n`);
    return 1;
  }
}

export function parseArgs(args) {
  if (!Array.isArray(args)) throw argumentError('context 参数须为列表');
  const result = {世界书: null, 开局: null, 方案: null, 本局: null, 地点: null, 场景: null,
    在场: [], 消息: [], 自动初始化: true, raw: false, json: false};
  const positionals = [], seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--json') { result.json = true; continue; }
    if (value === '--raw') { result.raw = true; continue; }
    if (value === '--不自动初始化') { result.自动初始化 = false; continue; }
    if (value === '--在场') { result.在场.push(optionValue(args, ++index, '--在场')); continue; }
    if (value === '--消息') { result.消息.push(optionValue(args, ++index, '--消息')); continue; }
    if (SINGLE_OPTIONS.includes(value)) {
      once(seen, value);
      result[value.slice(2)] = optionValue(args, ++index, value);
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw argumentError(positionals.length
    ? `多余位置参数：${positionals.slice(1).join(' ')}` : '缺少世界书目录');
  result.世界书 = positionals[0];
  return result;
}

export function formatContext(result) {
  const input = result.输入, summary = result.汇总, budget = result.预算, audit = result.审计;
  const lines = ['输入'];
  lines.push(`  世界书：${input.世界书}`);
  lines.push(`  开局：${input.开局 ?? '无'}${input.方案 ? `（方案：${input.方案}）` : ''}`);
  lines.push(`  地点：${input.地点 ?? '无'}｜场景：${input.场景 ?? '无'}`);
  lines.push(`  在场：${input.在场.length ? input.在场.join('、') : '无'}`
    + `${input.模拟初始化.length ? `（预初始化：${input.模拟初始化.join('、')}）` : ''}`);
  lines.push(`  消息：${input.消息.length} 条｜运行参数来源：${input.运行参数来源}`);
  lines.push('', '汇总');
  lines.push(`  总字符：${summary.总字符}`);
  for (const [key, value] of Object.entries(summary.分块字符)) lines.push(`  ${key}：${value}`);
  lines.push('', '预算');
  lines.push(`  经历：${budget.经历.已用条数}/${budget.经历.条数上限} 条、${budget.经历.已用字符}/${budget.经历.字符上限} 字符`);
  lines.push(`  候选：${budget.候选.已用条数}/${budget.候选.条数上限} 条、${budget.候选.已用字符}/${budget.候选.字符上限} 字符`);
  for (const [name, item] of Object.entries(budget.条目))
    lines.push(`  条目.${name}：${item.已用字符}/${item.预算上限} 字符`);
  lines.push('', '审计');
  appendLogs(lines, '经历', audit.经历);
  appendLogs(lines, '候选', audit.候选);
  for (const [name, log] of Object.entries(audit.条目)) {
    if (log.选入.length) lines.push(`  条目.${name} 选入（${log.选入.length}）：`
      + `${log.选入.map(item => `${item.条目ID}（${item.理由}）`).join('、')}`);
    if (log.略过.length) lines.push(`  条目.${name} 略过（${log.略过.length}）：`
      + `${log.略过.map(item => `${item.条目ID}（${item.原因}）`).join('、')}`);
  }
  lines.push(`  异常（${audit.异常.length}）：${audit.异常.length ? '' : '无'}`);
  for (const item of audit.异常) lines.push(`    - ${item.类型}：${item.说明}`);
  return `${lines.join('\n')}\n`;
}

function appendLogs(lines, label, log) {
  if (log.选入.length) lines.push(`  ${label}选入（${log.选入.length}）：`
    + `${log.选入.map(item => `${item.事件ID}（${item.理由}，${item.形式}，${item.字符} 字）`).join('、')}`);
  if (log.略过.length) lines.push(`  ${label}略过（${log.略过.length}）：`
    + `${log.略过.map(item => `${item.事件ID}（${item.原因}）`).join('、')}`);
}

function failureResult(parsed, error) {
  return {输入: {世界书: parsed?.世界书 ?? null, 开局: parsed?.开局 ?? null, 方案: parsed?.方案 ?? null,
    地点: parsed?.地点 ?? null, 场景: parsed?.场景 ?? null, 在场: parsed?.在场 ?? [], 模拟初始化: [],
    消息: parsed?.消息 ?? [], 运行参数来源: null},
    汇总: null, 预算: null, 审计: null, 正文: null,
    异常: [{规则: error?.code ?? '上下文.读取失败', 级别: '错误', 文件: parsed?.世界书 ?? 'context',
      说明: error?.message ?? String(error)}]};
}

function optionValue(args, index, option) {
  const value = args[index];
  if (typeof value !== 'string' || !value.length || value.startsWith('-')) throw argumentError(`${option} 缺少值`);
  return value;
}

function once(seen, option) {
  if (seen.has(option)) throw argumentError(`${option} 只能给出一次`);
  seen.add(option);
}

function argumentError(message) {
  const error = new Error(message);
  error.code = '上下文.参数';
  return error;
}
