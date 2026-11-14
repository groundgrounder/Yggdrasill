#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkWorldbook} from '../checker/index.mjs';
import {runIf} from './if.mjs';
import {runTrace} from './trace.mjs';
import {runFormat} from './format.mjs';
import {runPreview} from './preview.mjs';
import {runView} from './view.mjs';

export async function runCli(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, fs, path: injectedPath} = {}) {
  if (args[0] === 'view') return runView(args.slice(1), {cwd, stdout, stderr});
  if (args[0] === 'if') return runIf(args.slice(1), {cwd, stdout, stderr});
  if (args[0] === 'trace') return runTrace(args.slice(1), {cwd, stdout, stderr});
  if (args[0] === 'preview') return runPreview(args.slice(1), {cwd, stdout, stderr});
  if (args[0] === 'format') return runFormat(args.slice(1), {cwd, stdout, stderr});
  const json = args.includes('--json');
  const positionals = args.filter(value => !['--json', '--static-only'].includes(value));
  if (positionals[0] !== 'check' || positionals.length > 2 || args.some(value => value.startsWith('-') && !['--json', '--static-only'].includes(value))) {
    stderr.write('用法：ygg check [世界书目录] [--json] [--static-only]\n      ygg format <世界书目录> [--check] [--write] [--json]\n      ygg trace <世界书目录> <对象键> [--json]\n      ygg if <世界书目录> [--方案 <方案ID>] [--排除 <事件ID>]... [--分支 <事件ID>:<分支ID>]... [--停用角色组 <角色组ID>]... [--json]\n      ygg preview <世界书目录> <角色组ID> [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>] [--json]\n      ygg view --worldbook <世界书目录> [--storage <审阅存储目录>] [--port <端口>]\n');
    return 1;
  }
  const root = path.resolve(cwd, positionals[1] ?? '世界书');
  try {
    const result = await checkWorldbook(root, {sampling: !args.includes('--static-only'), fs, path: injectedPath});
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const item of [...result.errors, ...result.hints]) stdout.write(`${item.级别} ${item.规则} ${item.文件}：${item.说明}\n`);
      stdout.write(`摘要：${result.summary.错误} 错误，${result.summary.提示} 提示；${result.summary.角色组} 角色组，${result.summary.档案} 档案，${result.summary.条目} 条目，${result.summary.事件 ?? 0} 事件\n`);
    }
    return result.errors.length ? 1 : 0;
  } catch (error) {
    const name = error?.name ?? 'Error', message = error?.message ?? String(error);
    const detail = `检查未能完成（检查器外层）：${name}: ${message}`;
    const result = {errors: [{规则: '检查.规则失败', 级别: '错误', 文件: root, 说明: detail}], hints: [],
      summary: {错误: 1, 提示: 0, 文件: 0, 角色组: 0, 档案: 0, 条目: 0, 事件: 0}};
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      stderr.write(`错误 检查.规则失败 ${root}：${detail}\n`);
      stderr.write(`摘要：1 错误，0 提示；0 角色组，0 档案，0 条目，0 事件\n`);
    }
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
