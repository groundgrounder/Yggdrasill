// 关闭记账时的正文命令：提取 <命令> 块、逐条容错解析，再把合法命令交给协议执行。
// 整块解析失败时按顶层的“- ”逐条解析，一条写坏不连累同块的其它命令；全失败时命令为 null。
import {applyCommands} from '../core/commands.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {bookkeepingMeta, failure} from './records.mjs';

export const COMMAND_BLOCK = /<命令>\s*\n?([\s\S]*?)<\/命令>/g;
export const stripCommands = text => text.replace(COMMAND_BLOCK, '').trim();

export function parseBlock(body) {
  try {
    const value = parseYaml(body);
    if (value == null) return [];
    return Array.isArray(value) ? value.map(command => ({命令: command})) : [{错误: '命令块须为 YAML 列表'}];
  } catch {}
  const lines = body.split('\n');
  const indent = Math.min(...lines.filter(line => /^\s*- /.test(line)).map(line => line.search(/\S/)));
  if (!Number.isFinite(indent)) return [{错误: '命令块不是合法的 YAML，也没有以“- ”开头的条目'}];
  const items = [];
  for (const line of lines) {
    if (line.search(/\S/) === indent && line.slice(indent).startsWith('- ')) items.push([line.slice(indent)]);
    else if (items.length && line.trim()) items.at(-1).push(line.slice(Math.min(indent, line.search(/\S/))));
  }
  return items.map(item => {
    try {
      const value = parseYaml(item.join('\n'));
      if (Array.isArray(value) && value.length === 1) return {命令: value[0]};
    } catch (error) { return {错误: '不是合法的 YAML：' + error.message.split('\n')[0] + '（' + item[0].slice(0, 40) + '）'}; }
    return {错误: '不是一条命令（' + item[0].slice(0, 40) + '）'};
  });
}

export function parseCommands(text) {
  return [...text.matchAll(COMMAND_BLOCK)].flatMap(match => parseBlock(match[1]
    .replace(/^\s*\u0060{3}[^\n]*\n/, '').replace(/\n\u0060{3}\s*$/, '')));
}

function execute(protocol, base, commands, extra = {}) {
  try {
    const result = applyCommands(protocol, base, commands);
    const failed = new Set((result.失败 ?? []).map(item => Number(item.序号) - 1));
    const failures = (result.失败 ?? []).map(item => failure('协议执行', item.错误码, item.说明,
      {...(Number.isSafeInteger(item.序号) ? {序号: item.序号} : {}), ...(item.命令 ? {命令: item.命令} : {})}));
    return {本局: result.state, 命令: commands.filter((command, index) => !failed.has(index)), 失败: failures,
      已写入: result.已写入, 命令数: commands.length, ...extra};
  } catch (error) {
    return {本局: base, 命令: null, 失败: [failure('执行', error.code ?? '执行.异常', error.message)],
      已写入: [], 命令数: Array.isArray(commands) ? commands.length : 0, ...extra};
  }
}

// 旧方式也写正式记录；解析失败项不进入可重放命令。没有任何合法命令且发生解析错误时，命令为 null。
export function fromText(protocol, base, text) {
  const items = parseCommands(text), positions = [], commands = [], parseFailures = [];
  items.forEach((item, index) => {
    if (item.错误) parseFailures.push(failure('解析', '命令.解析', item.错误, {序号: index + 1, 命令: '解析'}));
    else { positions.push(index + 1); commands.push(item.命令); }
  });
  const record = execute(protocol, base, commands);
  record.失败 = [...parseFailures, ...record.失败.map(item => Number.isSafeInteger(item.序号)
    ? {...item, 序号: positions[item.序号 - 1]} : item)].sort((left, right) => (left.序号 ?? 0) - (right.序号 ?? 0));
  record.命令数 = items.length;
  if (parseFailures.length && !record.命令?.length) record.命令 = null;
  record.记账 = bookkeepingMeta('正文', '正文命令',
    record.命令 === null ? '解析失败' : record.失败.length ? '部分失败' : '成功', 1);
  return record;
}
