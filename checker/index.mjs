import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {compileWorldbook} from '../core/catalog.mjs';
import {checkLayout} from './rules/layout.mjs';
import {checkDeclarations} from './rules/declarations.mjs';
import {checkEntries} from './rules/entries.mjs';
import {checkGroups} from './rules/groups.mjs';
import {checkProfiles} from './rules/profiles.mjs';
import {checkText} from './rules/text.mjs';
import {checkEvents} from './rules/events.mjs';
import {checkPositions} from './rules/positions.mjs';
import {checkChains} from './rules/chains.mjs';
import {checkOpenings} from './rules/openings.mjs';
import {checkSources} from './rules/sources.mjs';
import {checkGraph} from './rules/graph.mjs';
import {checkSampling} from './rules/sampling.mjs';
import {checkSettings} from './rules/settings.mjs';
import {issue} from './issue.mjs';

export {issue} from './issue.mjs';
export {checkSampling, samplingYears} from './rules/sampling.mjs';

export async function checkWorldbook(root, options = {}) {
  const fs = options.fs ?? defaultFs, path = options.path ?? defaultPath;
  const {raw, compiled, decl, catalog, readIssues, loadIssues} = await compileWorldbook(root, {fs, path});
  const issues = [...readIssues, ...loadIssues];
  const run = async (stage, module, callback) => {
    try {
      const value = await callback();
      return Array.isArray(value) ? value : value?.issues ?? [];
    }
    catch (error) {
      const name = error?.name ?? 'Error', message = error?.message ?? String(error);
      return [issue('检查.规则失败', '错误', '.', `${stage}（${module}）内部失败：${name}: ${message}`)];
    }
  };
  issues.push(...await run('设定核对', 'checkDeclarations', () => checkDeclarations(raw, catalog, compiled)));
  issues.push(...await run('目录与布局', 'checkLayout', () => checkLayout(catalog, decl)));
  issues.push(...await run('条目', 'checkEntries', () => checkEntries(catalog, decl)));
  issues.push(...await run('角色组', 'checkGroups', () => checkGroups(catalog, decl)));
  issues.push(...await run('档案', 'checkProfiles', () => checkProfiles(catalog, decl)));
  issues.push(...await run('事件', 'checkEvents', () => checkEvents(catalog, decl)));
  issues.push(...await run('角色位置', 'checkPositions', () => checkPositions(catalog)));
  let analysis = null;
  const graphIssues = await run('事件树', 'checkGraph', () => {
    const graph = checkGraph(catalog, decl);
    analysis = graph.analysis;
    return graph.issues;
  });
  issues.push(...await run('事件串', 'checkChains', () => checkChains(catalog, analysis)));
  issues.push(...await run('开局', 'checkOpenings', () => checkOpenings(catalog, decl)));
  issues.push(...await run('出处', 'checkSources', () => checkSources(catalog)));
  issues.push(...graphIssues);
  issues.push(...await run('文本', 'checkText', () => checkText(catalog, decl)));
  issues.push(...await run('运行参数', 'checkSettings', () => checkSettings(path.dirname(root), {fs, path, decl})));
  if (options.sampling !== false) {
    if (issues.some(value => value.级别 === '错误')) issues.push(issue('抽样.未执行', '提示', '历史', '静态检查有错误，未执行抽样'));
    else issues.push(...await run('抽样', 'checkSampling', () => checkSampling(catalog, decl)));
  }
  const unique = [...new Map(issues.map(value => [JSON.stringify(value), value])).values()];
  const errors = unique.filter(value => value.级别 === '错误'), hints = unique.filter(value => value.级别 === '提示');
  const summary = {错误: errors.length, 提示: hints.length, 文件: catalog.files.length, 角色组: catalog.groups.length,
    档案: catalog.groups.reduce((sum, group) => sum + group.档案.length, 0),
    条目: Object.values(catalog.entries).reduce((sum, entries) => sum + entries.length, 0), 事件: catalog.eventIds.length};
  return {errors, hints, summary};
}
