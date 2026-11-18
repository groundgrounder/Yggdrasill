import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {whatIf} from '../core/what-if.mjs';
import {codepointCompare} from '../core/utils.mjs';

const USAGE = '用法：ygg if <世界书目录> [--方案 <方案ID>] [--排除 <事件ID>]... '
  + '[--分支 <事件ID>:<分支ID>]... [--停用角色组 <角色组ID>]... [--json]';

export async function runIf(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? 'if.参数'}：${error.message}\n`);
    if (args.includes('--json')) stdout.write(`${JSON.stringify(failureInput(error.message), null, 2)}\n`);
    return 1;
  }

  const root = path.resolve(cwd, parsed.世界书);
  try {
    const {catalog, decl, issues} = await compileWorldbook(root, {fs, path});
    const result = whatIf(catalog, decl, {
      世界书: parsed.世界书, 方案: parsed.方案, 排除: parsed.排除, 分支: parsed.分支,
      停用角色组: parsed.停用角色组, issues,
    });
    const failed = result.异常.some(item => item?.级别 === '错误');
    if (parsed.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (failed) stderr.write(formatIf(result));
    else stdout.write(formatIf(result));
    return failed ? 1 : 0;
  } catch {
    const result = failureInput('无法完成只读封卷，请核对世界书目录、声明与文件权限', parsed);
    if (parsed.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(formatIf(result));
    return 1;
  }
}

export function parseArgs(args) {
  if (!Array.isArray(args)) throw argumentError('if 参数须为列表');
  const result = {世界书: null, 方案: null, 排除: [], 分支: [], 停用角色组: [], json: false};
  const positionals = [];
  let planSeen = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--json') { result.json = true; continue; }
    if (value === '--方案') {
      if (planSeen) throw argumentError('--方案 只能给出一次');
      result.方案 = optionValue(args, ++index, '--方案');
      planSeen = true;
      continue;
    }
    if (value === '--排除') {
      result.排除.push(optionValue(args, ++index, '--排除'));
      continue;
    }
    if (value === '--分支') {
      const branch = optionValue(args, ++index, '--分支');
      const colon = branch.indexOf(':');
      if (colon < 1 || colon === branch.length - 1)
        throw argumentError('--分支 须写成 <事件ID>:<分支ID>');
      result.分支.push({事件ID: branch.slice(0, colon), 分支ID: branch.slice(colon + 1)});
      continue;
    }
    if (value === '--停用角色组') {
      result.停用角色组.push(optionValue(args, ++index, '--停用角色组'));
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw argumentError(positionals.length ? '多余位置参数：' + positionals.slice(1).join(' ')
    : '缺少世界书目录');
  result.世界书 = positionals[0];
  result.排除 = [...new Set(result.排除)].sort(codepointCompare);
  result.停用角色组 = [...new Set(result.停用角色组)].sort(codepointCompare);
  result.分支.sort((left, right) => codepointCompare(left.事件ID, right.事件ID)
    || codepointCompare(left.分支ID, right.分支ID));
  return result;
}

export function formatIf(result) {
  const input = result?.输入 ?? {};
  const lines = ['输入'];
  lines.push(`  世界书：${input.世界书 ?? '无'}`);
  lines.push(`  时间轴末尾：${input.时间轴末尾 ?? '无'}`);
  lines.push(`  方案：${input.方案 ?? '默认'}`);
  lines.push(`  排除：${listText(input.排除)}`);
  lines.push(`  分支：${(input.分支 ?? []).length
    ? input.分支.map(item => `${item.事件ID}:${item.分支ID}`).join('、') : '无'}`);
  lines.push(`  停用角色组：${listText(input.停用角色组)}`);

  lines.push('', `没发生（${result?.没发生?.length ?? 0}）`);
  writeValues(lines, result?.没发生);
  lines.push('', `新发生（${result?.新发生?.length ?? 0}）`);
  writeValues(lines, result?.新发生);
  lines.push('', `分支不同（${result?.分支不同?.length ?? 0}）`);
  if (result?.分支不同?.length) for (const item of result.分支不同)
    lines.push(`  - ${item.事件ID}：默认 ${item.默认分支}；if ${item.if分支}`);
  else lines.push('  无');
  lines.push('', `停住的事件串（${result?.停住的事件串?.length ?? 0}）`);
  writeValues(lines, result?.停住的事件串);

  lines.push('', `影响面（${result?.影响面?.length ?? 0}）`);
  if (result?.影响面?.length) for (const item of result.影响面) {
    lines.push(`  - ${item.事件ID}：${item.下游?.length ?? 0} | ${listText(item.下游)}`);
    if (item.引用位置?.length) lines.push(`    引用位置：${item.引用位置.map(referenceText).join('；')}`);
  } else lines.push('  无');

  lines.push('', `异常（${result?.异常?.length ?? 0}）`);
  if (result?.异常?.length) for (const item of result.异常)
    lines.push(`  - ${item.级别} ${item.规则} ${item.文件}：${item.说明}`);
  else lines.push('  无');
  return `${lines.join('\n')}\n`;
}

function optionValue(args, index, option) {
  const value = args[index];
  if (typeof value !== 'string' || !value.length || value.startsWith('-')) throw argumentError(`${option} 缺少值`);
  return value;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'if.参数';
  return error;
}

function failureInput(message, parsed = {}) {
  return {
    输入: {
      世界书: parsed.世界书 ?? null,
      时间轴末尾: null,
      方案: parsed.方案 ?? null,
      排除: parsed.排除 ?? [],
      分支: parsed.分支 ?? [],
      停用角色组: parsed.停用角色组 ?? [],
    },
    没发生: [],
    新发生: [],
    分支不同: [],
    停住的事件串: [],
    影响面: [],
    异常: [{规则: parsed.世界书 ? 'if.读取失败' : 'if.参数', 级别: '错误', 文件: parsed.世界书 ?? 'if', 说明: message}],
  };
}

function listText(value) {
  return Array.isArray(value) && value.length ? value.join('、') : '无';
}

function writeValues(lines, value) {
  if (Array.isArray(value) && value.length) for (const item of value) lines.push(`  - ${item}`);
  else lines.push('  无');
}

function referenceText(item) {
  return `${item.目标事件ID} ← ${item.来源事件ID} @ ${item.字段}`;
}
