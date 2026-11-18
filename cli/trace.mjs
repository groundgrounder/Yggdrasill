import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {buildReferenceIndex, isTraceFailure} from '../core/references.mjs';

export async function runTrace(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  const json = args.includes('--json');
  const positionals = args.filter(value => value !== '--json');
  if (positionals.length !== 2 || args.some(value => value.startsWith('-') && value !== '--json')) {
    stderr.write('用法：ygg trace <世界书目录> <对象键> [--json]\n');
    return 1;
  }
  const root = path.resolve(cwd, positionals[0]), objectKey = positionals[1];
  try {
    const {catalog, decl, issues} = await compileWorldbook(root, {fs, path});
    const index = buildReferenceIndex(catalog, decl, {issues});
    const result = index.query(objectKey);
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(formatTrace(result));
    return isTraceFailure(result) ? 1 : 0;
  } catch {
    const result = {
      对象: {对象键: objectKey, 类型: null, ID: null, 定义文件: null},
      引用它: [],
      它引用: [],
      出处: [],
      异常: [{规则: 'trace.读取失败', 级别: '错误', 文件: positionals[0], 说明: '无法完成只读查询，请核对世界书目录与文件权限'}],
    };
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`错误 trace.读取失败：无法完成只读查询，请核对世界书目录与文件权限\n`);
    return 1;
  }
}

export function formatTrace(result) {
  const lines = ['对象'];
  const object = result?.对象 ?? {};
  lines.push(`  对象键：${object.对象键 ?? '无'}`);
  lines.push(`  类型：${object.类型 ?? '无'}`);
  lines.push(`  ID：${object.ID ?? '无'}`);
  lines.push(`  定义文件：${object.定义文件 ?? '无'}`);

  lines.push('', `引用它（${result?.引用它?.length ?? 0}）`);
  if (result?.引用它?.length) for (const item of result.引用它) lines.push(
    `  - ${item.来源类型} ${item.来源对象} | ${item.来源文件} | ${item.字段} | ${kind(item)}`);
  else lines.push('  无');

  lines.push('', `它引用（${result?.它引用?.length ?? 0}）`);
  if (result?.它引用?.length) for (const item of result.它引用) lines.push(
    `  - ${item.目标类型} ${item.目标对象} | ${item.目标文件 ?? '无定义文件'} | ${item.字段} | ${kind(item)}`);
  else lines.push('  无');

  lines.push('', `出处（${result?.出处?.length ?? 0}）`);
  if (result?.出处?.length) for (const item of result.出处) {
    lines.push(`  - ${item.来源文件} #${item.记录序号} | ${item.记录类型} | ${oneLine(item.来源文本 ?? '（无来源文本）')}`);
    if (item.角色组ID) lines.push(`    角色组ID：${item.角色组ID}`);
    if (item.台词) lines.push(`    台词：${oneLine(item.台词)}`);
  } else lines.push('  无');

  lines.push('', `异常（${result?.异常?.length ?? 0}）`);
  if (result?.异常?.length) for (const item of result.异常) lines.push(
    `  - ${item.级别} ${item.规则} ${item.文件}：${item.说明}`);
  else lines.push('  无');
  return `${lines.join('\n')}\n`;
}

function kind(item) {
  return item.极性 ? `${item.引用种类}（${item.极性}）` : item.引用种类;
}

function oneLine(value) {
  return String(value).replace(/\s*[\r\n]+\s*/gu, ' ');
}
