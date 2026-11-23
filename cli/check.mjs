import path from 'node:path';
import {checkWorldbook} from '../checker/index.mjs';

export const CHECK_USAGE = '用法：ygg check [世界书目录] [--json] [--static-only]\n';

export const USAGE = CHECK_USAGE
  + '      ygg format <世界书目录> [--check] [--write] [--json]\n'
  + '      ygg trace <世界书目录> <对象键> [--json]\n'
  + '      ygg if <世界书目录> [--方案 <方案ID>] [--排除 <事件ID>]... [--分支 <事件ID>:<分支ID>]... [--停用角色组 <角色组ID>]... [--json]\n'
  + '      ygg preview <世界书目录> <角色组ID> [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>] [--状态] [--json]\n'
  + '      ygg context <世界书目录> [--开局 <纪年>] [--方案 <方案ID>] [--本局 <本局JSON>] [--地点 <地标ID>] [--场景 <场景文本>] [--在场 <角色组ID>]... [--消息 <文本>]... [--不自动初始化] [--raw] [--json]\n'
  + '      ygg tree <世界书目录> [--out <文件路径>] [--stats-only] [--json]\n'
  + '      ygg status [项目目录或世界书目录] [--json]\n'
  + '      ygg init <项目目录> [--纪年前缀 <前缀>] [--年位数 <整数>] [--月数 <整数>] [--每月天数 <整数>] [--force] [--json]\n'
  + '      ygg view [<世界书目录> | --worldbook <世界书目录>] [--storage <审阅存储目录>] [--port <端口>]\n'
  + '      ygg pack [项目目录] [--face <卡面文件>] [--prepare-only] [--compatible <64位指纹>]...\n'
  + '      ygg [--help | -h] [--version | -v]\n';

export async function runCheck(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs, path: pathImpl} = {}) {
  const allowed = new Set(['--json', '--static-only', '--help', '-h']);
  const help = args.includes('--help') || args.includes('-h');
  const json = args.includes('--json');
  const positionals = args.filter(value => !allowed.has(value));
  if (positionals[0] !== 'check' || positionals.length > 2 || args.some(value => value.startsWith('-') && !allowed.has(value))) {
    stderr.write(USAGE);
    return 1;
  }
  if (help) {
    stdout.write(CHECK_USAGE);
    return 0;
  }
  const root = (pathImpl ?? path).resolve(cwd, positionals[1] ?? '世界书');
  try {
    const result = await checkWorldbook(root, {sampling: !args.includes('--static-only'), fs, path: pathImpl});
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
