import path from 'node:path';
import {formatWorldbook} from '../core/format.mjs';

const USAGE = '用法：ygg format <世界书目录> [--check] [--write] [--json]\n';

export async function runFormat(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, fs, path: pathImpl} = {}) {
  const allowed = new Set(['--check', '--write', '--json', '--help', '-h']);
  const flags = new Set(args.filter(value => value.startsWith('-'))), positionals = args.filter(value => !value.startsWith('-'));
  const unknown = [...flags].filter(value => !allowed.has(value));
  const check = flags.has('--check'), write = flags.has('--write'), json = flags.has('--json');
  const help = flags.has('--help') || flags.has('-h');
  if (unknown.length || (check && write) || (!help && positionals.length !== 1) || (help && positionals.length > 1)) {
    stderr.write(USAGE);
    return 1;
  }
  if (help) {
    stdout.write(USAGE);
    return 0;
  }
  const root = (pathImpl ?? path).resolve(cwd, positionals[0]);
  let result;
  try { result = await formatWorldbook(root, {write: write && !check, fs, path: pathImpl}); }
  catch (error) {
    result = {项目: {目录: root, 模式: write ? '写入' : '检查', 文件: 0, 差异: 0, 已写入: 0, 异常: 1},
      文件: [], 异常: [{文件: root, 说明: `格式化失败：${error.message}`}], 已写入: []};
  }
  if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const item of result.异常) stderr.write(`异常 ${item.文件}：${item.说明}\n`);
    if (write) for (const item of result.已写入) stdout.write(`已写入 ${item.文件}\n`);
    else for (const item of result.文件.filter(entry => entry.状态 === '有差异')) stdout.write(`有差异 ${item.文件}\n`);
    stdout.write(`摘要：${result.项目.文件} 文件，${result.项目.差异} 差异，${result.项目.已写入} 已写入，${result.项目.异常} 异常\n`);
  }
  if (result.项目.异常) return 1;
  if (!write && result.项目.差异) return 1;
  return 0;
}
