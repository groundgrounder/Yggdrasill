import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {analyzeEventTree, chainStructure} from '../core/graph.mjs';
import {exportEventTreeMarkdown, summarizeQuotes, TreeExportError} from '../core/tree-export.mjs';
import {codepointCompare, isText, list} from '../core/utils.mjs';

const USAGE = '用法：ygg tree <世界书目录> [--out <文件路径>] [--stats-only] [--json]';

export async function runTree(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath} = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? '事件树导出.参数'}：${error.message}\n`);
    if (args.includes('--json')) stdout.write(`${JSON.stringify(failureResult(null, error), null, 2)}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = path.resolve(cwd, parsed.世界书);
  try {
    const {catalog, decl, issues} = await compileWorldbook(root, {fs, path});
    if (issues.some(item => item?.级别 === '错误'))
      throw new TreeExportError('事件树导出.读取失败', issues.filter(item => item?.级别 === '错误')
        .map(item => `${item.文件}：${item.说明}`).join('；'));
    const title = path.basename(root) === '世界书' ? path.basename(path.dirname(root)) : path.basename(root);
    const analysis = analyzeEventTree(catalog, decl);
    const stats = buildStats(catalog, decl, title, analysis);
    const markdown = parsed.statsOnly ? null : exportEventTreeMarkdown(catalog, decl, {标题: title});
    let output = null;
    if (parsed.out) {
      const target = path.resolve(cwd, parsed.out);
      if (target === root || target.startsWith(`${root}${path.sep}`))
        throw new TreeExportError('事件树导出.路径', `导出路径不能落在世界书目录内：${parsed.out}`);
      await assertOutsideWorldbook(target, root, parsed.out, {fs, path});
      const content = parsed.statsOnly ? statsText(stats) : markdown;
      try {
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, content);
      } catch (error) {
        throw new TreeExportError('事件树导出.写入失败', `无法写入导出文件：${error?.message ?? error}`);
      }
      output = target;
    }
    if (parsed.json) {
      stdout.write(`${JSON.stringify({
        世界书: root, 摘要: stats, 事件串: chainSummaries(catalog, analysis), 独立事件: independentEvents(catalog),
        台词统计: summarizeQuotes(catalog), markdown, 输出文件: output, 异常: [],
      }, null, 2)}\n`);
      return 0;
    }
    if (parsed.out) {
      stdout.write(`已写入：${output}（事件 ${stats.事件}，事件串 ${stats.事件串}，`
        + `候选台词 ${stats.候选台词总数}，原台词 ${stats.原台词数}）\n`);
      return 0;
    }
    stdout.write(parsed.statsOnly ? statsText(stats) : markdown);
    return 0;
  } catch (error) {
    const known = error instanceof TreeExportError;
    const failure = known ? error : new TreeExportError('事件树导出.读取失败',
      `无法完成只读导出：${error?.message ?? String(error)}`);
    stderr.write(`错误 ${failure.code}：${failure.message}\n`);
    if (parsed?.json) stdout.write(`${JSON.stringify(failureResult(parsed, failure), null, 2)}\n`);
    return 1;
  }
}

export function parseArgs(args) {
  if (!Array.isArray(args)) throw argumentError('tree 参数须为列表');
  const result = {世界书: null, out: null, statsOnly: false, json: false, help: false};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') { result.help = true; continue; }
    if (value === '--json') { result.json = true; continue; }
    if (value === '--stats-only') { result.statsOnly = true; continue; }
    if (value === '--out') {
      if (result.out !== null) throw argumentError('--out 只能给出一次');
      result.out = optionValue(args, ++index, '--out');
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    positionals.push(value);
  }
  if ((!result.help && positionals.length !== 1) || (result.help && positionals.length > 1)) throw argumentError(positionals.length
    ? `多余位置参数：${positionals.slice(1).join(' ')}` : '缺少世界书目录');
  result.世界书 = positionals[0] ?? null;
  return result;
}

function buildStats(catalog, decl, title, analysis) {
  const quotes = summarizeQuotes(catalog);
  const chains = list(catalog.chains), events = list(catalog.events);
  const chainMembers = new Set(chains.flatMap(chain => list(chain.内容?.事件)));
  return {标题: title, 事件: events.length, 事件串: chains.length,
    独立事件: events.filter(event => !chainMembers.has(event.id)).length,
    可达事件: events.filter(event => analysis.reachable.has(event.id)).length,
    不可达事件: events.filter(event => !analysis.reachable.has(event.id)).length,
    结构异常数: analysis.issues.length, ...pickTotals(quotes.总计)};
}

function pickTotals(total) {
  return {候选台词总数: total.候选台词总数, 原台词数: total.原台词数, 作者台词数: total.作者台词数,
    原台词占比: total.原台词占比, 有事件级出处事件数: total.有事件级出处事件数, 台词记录总数: total.台词记录总数};
}

function chainSummaries(catalog, analysis) {
  return list(catalog.chains).slice().sort((left, right) => codepointCompare(left.id, right.id)).map(chain => {
    const structure = chainStructure(catalog, chain, analysis);
    return {事件串ID: chain.id, 概述: isText(chain.内容?.概述) ? chain.内容.概述 : null,
      起点: [...structure.起点], 结局: structure.结局.map(item => ({...item})),
      结局可达: structure.结局可达.map(item => ({...item})), 孤立成员: [...structure.孤立成员],
      事件: [...structure.成员]};
  });
}

// 符号链接防护：解析 root 与 target 最近已存在祖先的真实路径，防止经链接写进世界书内部。
async function assertOutsideWorldbook(target, root, out, {fs, path}) {
  if (typeof fs.realpath !== 'function') return;
  let realRoot = root;
  try { realRoot = await fs.realpath(root); } catch { realRoot = root; }
  let ancestor = target;
  for (;;) {
    try { await fs.stat(ancestor); break; }
    catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return;
      ancestor = parent;
    }
  }
  let realAncestor = ancestor;
  try { realAncestor = await fs.realpath(ancestor); } catch { return; }
  const realTarget = path.join(realAncestor, path.relative(ancestor, target));
  if (realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`))
    throw new TreeExportError('事件树导出.路径', `导出路径不能落在世界书目录内：${out}`);
}

function independentEvents(catalog) {
  const chainMembers = new Set(list(catalog.chains).flatMap(chain => list(chain.内容?.事件)));
  return list(catalog.events).filter(event => !chainMembers.has(event.id)).map(event => event.id)
    .sort(codepointCompare);
}

function statsText(stats) {
  const lines = [`事件树统计：${stats.标题}`];
  lines.push(`- 事件 ${stats.事件}（独立 ${stats.独立事件}），事件串 ${stats.事件串}；`
    + `可达 ${stats.可达事件}，不可达 ${stats.不可达事件}，结构异常 ${stats.结构异常数}`);
  lines.push(`- 候选台词 ${stats.候选台词总数}：原台词 ${stats.原台词数}（${(stats.原台词占比 * 100).toFixed(2)}%），`
    + `作者台词 ${stats.作者台词数}；台词记录 ${stats.台词记录总数} 条`);
  lines.push(`- 有事件级出处 ${stats.有事件级出处事件数} 个事件`);
  return `${lines.join('\n')}\n`;
}

function failureResult(parsed, error) {
  return {世界书: parsed?.世界书 ?? null, 摘要: null, 事件串: [], 独立事件: [], 台词统计: null,
    markdown: null, 输出文件: null,
    异常: [{规则: error?.code ?? '事件树导出.读取失败', 级别: '错误', 文件: parsed?.世界书 ?? 'tree',
      说明: error?.message ?? String(error)}]};
}

function optionValue(args, index, option) {
  const value = args[index];
  if (typeof value !== 'string' || !value.length || value.startsWith('-')) throw argumentError(`${option} 缺少值`);
  return value;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = '事件树导出.参数';
  return error;
}
