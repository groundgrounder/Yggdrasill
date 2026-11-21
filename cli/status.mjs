import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {inspectProjectStatus, StatusError} from '../core/project-status.mjs';

const USAGE = '用法：ygg status [项目目录或世界书目录] [--json]\n'
  + '      省略目录时诊断当前目录；目录可以是项目根或其中的 世界书/。';

export async function runStatus(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  const json = args.includes('--json');
  const positionals = args.filter(value => value !== '--json');
  if (positionals.length > 1 || args.some(value => value.startsWith('-') && value !== '--json')) {
    stderr.write(`${USAGE}\n`);
    if (json) stdout.write(`${JSON.stringify(argumentFailureResult(), null, 2)}\n`);
    return 1;
  }
  const target = path.resolve(cwd, positionals[0] ?? '.');
  try {
    const result = await inspectProjectStatus(target, {fs, path});
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(formatStatus(result));
    return 0;
  } catch (error) {
    const known = error instanceof StatusError;
    stderr.write(`错误 ${known ? error.code : '状态.路径'}：${known ? error.message : `无法完成诊断：${error?.message ?? String(error)}`}\n`);
    if (json) stdout.write(`${JSON.stringify(failureResult(target, error), null, 2)}\n`);
    return 1;
  }
}

export function formatStatus(result) {
  const layers = result?.各层 ?? {}, counts = result?.计数 ?? {}, check = result?.静态检查 ?? {};
  const checkText = check.错误 === null ? (check.说明 ?? '跳过') : `${check.错误} 错误、${check.提示 ?? 0} 提示`;
  const lines = [`项目：${result?.项目?.目录 ?? '无'}（识别：${result?.项目?.识别 ?? '无'}）`];
  lines.push(`世界书：${result?.项目?.世界书 ?? '无'}`);
  lines.push(`当前阶段：${result?.当前阶段 ?? '无'}`);
  lines.push(`推荐skill：${result?.推荐skill ?? '无'}`);
  lines.push(`第0层 通读：来源资料 ${counts.来源资料文件 ?? 0} 文件；通读分卷 ${counts.通读分卷文件 ?? 0}；`
    + `活词表 ${layers.第0层?.活词表 ? '有' : '无'}；总账 ${Object.values(layers.第0层?.全局总账 ?? {}).filter(Boolean).length}/5`);
  lines.push(`第1层 地基：必需声明 ${['纪年', '事件分类', '本局变量'].filter(name => layers.第1层?.声明文件?.[name]).length}/3；`
    + `声明文件 ${counts.声明文件 ?? 0} 份；世界概况 ${counts.世界概况文件 ?? 0}；扮演准则 ${counts.扮演准则文件 ?? 0}；`
    + `运行参数 ${layers.第1层?.运行参数文件 ? '有' : '无'}`);
  lines.push(`第2层 条目：声明库 ${counts.条目库 ?? 0} 个；`
    + `条目 ${Object.values(layers.第2层?.各库条目数 ?? {}).reduce((sum, value) => sum + value, 0)} 条`);
  lines.push(`第3层 骨架：角色组 ${counts.角色组 ?? 0}、档案 ${counts.档案 ?? 0}、事件 ${counts.事件 ?? 0}、`
    + `事件串 ${counts.事件串 ?? 0}、开局选项 ${counts.开局选项 ?? 0}、开局方案 ${counts.开局方案 ?? 0}；静态检查 ${checkText}`);
  const quotes = result?.台词统计;
  lines.push(`第4层 档案与填景：角色位置 ${counts.角色位置 ?? 0}；`
    + (quotes ? `候选台词 ${quotes.候选台词总数}（原台词 ${quotes.原台词数}，占比 ${(quotes.原台词占比 * 100).toFixed(2)}%，`
      + `缺台词 ${quotes.缺台词角色位置数}）` : '台词统计不可用')
    + `；暂存 ${counts.暂存文件 ?? 0}、候选 ${counts.候选文件 ?? 0}`);
  lines.push(`第5层 打包：卡面 ${layers.第5层?.卡面文件?.length ? layers.第5层.卡面文件.join('、') : '无'}`);
  lines.push('', `缺口（${result?.缺口?.length ?? 0}）：`);
  if (result?.缺口?.length) for (const item of result.缺口) lines.push(`  - ${item}`);
  else lines.push('  无');
  lines.push('', `异常（${result?.异常?.length ?? 0}）：无`);
  return `${lines.join('\n')}\n`;
}

function failureResult(target, error) {
  const known = error instanceof StatusError;
  return {项目: {目录: target, 世界书: null, 识别: null}, 各层: null, 计数: null, 台词统计: null, 静态检查: null,
    当前阶段: null, 缺口: [], 推荐skill: null,
    异常: [{规则: known ? error.code : '状态.路径', 级别: '错误', 文件: target,
      说明: known ? error.message : `无法完成诊断：${error?.message ?? String(error)}`}]};
}

function argumentFailureResult() {
  return {项目: {目录: null, 世界书: null, 识别: null}, 各层: null, 计数: null, 台词统计: null, 静态检查: null,
    当前阶段: null, 缺口: [], 推荐skill: null,
    异常: [{规则: '状态.参数', 级别: '错误', 文件: null, 说明: '仅接受一个项目目录或世界书目录与 --json'}]};
}
