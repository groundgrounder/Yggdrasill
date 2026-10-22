import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {readDeclarations, validateDeclarations} from '../core/declarations.mjs';
import {loadWorldbook} from '../core/catalog.mjs';
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
  const {raw, issues: readIssues} = await readDeclarations(root, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(root, {fs, path, decl: compiled.decl});
  const {decl, issues: declarationIssues} = checkDeclarations(raw, catalog, compiled);
  const graph = checkGraph(catalog, decl);
  const issues = [...readIssues, ...loadIssues, ...declarationIssues, ...checkLayout(catalog, decl),
    ...checkEntries(catalog, decl), ...checkGroups(catalog, decl), ...checkProfiles(catalog, decl), ...checkEvents(catalog, decl),
    ...checkPositions(catalog), ...checkChains(catalog, graph.analysis), ...checkOpenings(catalog, decl), ...checkSources(catalog),
    ...graph.issues, ...checkText(catalog, decl), ...await checkSettings(path.dirname(root), {fs, path, decl})];
  if (options.sampling !== false) {
    if (issues.some(value => value.级别 === '错误')) issues.push(issue('抽样.未执行', '提示', '历史', '静态检查有错误，未执行抽样'));
    else issues.push(...checkSampling(catalog, decl));
  }
  const unique = [...new Map(issues.map(value => [JSON.stringify(value), value])).values()];
  const errors = unique.filter(value => value.级别 === '错误'), hints = unique.filter(value => value.级别 === '提示');
  const summary = {错误: errors.length, 提示: hints.length, 文件: catalog.files.length, 角色组: catalog.groups.length,
    档案: catalog.groups.reduce((sum, group) => sum + group.档案.length, 0),
    条目: Object.values(catalog.entries).reduce((sum, entries) => sum + entries.length, 0), 事件: catalog.eventIds.length};
  return {errors, hints, summary};
}
