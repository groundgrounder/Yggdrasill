#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkWorldbook} from '../checker/index.mjs';

export async function runCli(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr} = {}) {
  const json = args.includes('--json');
  const positionals = args.filter(value => value !== '--json');
  if (positionals[0] !== 'check' || positionals.length > 2 || args.some(value => value.startsWith('-') && value !== '--json')) {
    stderr.write('用法：ygg check [世界书目录] [--json]\n');
    return 1;
  }
  try {
    const result = await checkWorldbook(path.resolve(cwd, positionals[1] ?? '世界书'));
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const item of [...result.errors, ...result.hints]) stdout.write(`${item.级别} ${item.规则} ${item.文件}：${item.说明}\n`);
      stdout.write(`摘要：${result.summary.错误} 错误，${result.summary.提示} 提示；${result.summary.角色组} 角色组，${result.summary.档案} 档案，${result.summary.条目} 条目\n`);
    }
    return result.errors.length ? 1 : 0;
  } catch {
    const result = {errors: [{规则: '目录.读取失败', 级别: '错误', 文件: positionals[1] ?? '世界书', 说明: '检查未能完成，请核对目录与文件权限'}], hints: [], summary: {错误: 1, 提示: 0}};
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write('错误 目录.读取失败：检查未能完成，请核对目录与文件权限\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
