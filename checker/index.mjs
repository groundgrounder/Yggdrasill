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

export {issue} from './issue.mjs';

export async function checkWorldbook(root, options = {}) {
  const fs = options.fs ?? defaultFs, path = options.path ?? defaultPath;
  const {raw, issues: readIssues} = await readDeclarations(root, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(root, {fs, path, decl: compiled.decl});
  const {decl, issues: declarationIssues} = checkDeclarations(raw, catalog, compiled);
  const issues = [...readIssues, ...loadIssues, ...declarationIssues, ...checkLayout(catalog, decl),
    ...checkEntries(catalog, decl), ...checkGroups(catalog, decl), ...checkProfiles(catalog, decl), ...checkText(catalog, decl)];
  const unique = [...new Map(issues.map(value => [JSON.stringify(value), value])).values()];
  const errors = unique.filter(value => value.级别 === '错误'), hints = unique.filter(value => value.级别 === '提示');
  const summary = {错误: errors.length, 提示: hints.length, 文件: catalog.files.length, 角色组: catalog.groups.length,
    档案: catalog.groups.reduce((sum, group) => sum + group.档案.length, 0),
    条目: Object.values(catalog.entries).reduce((sum, entries) => sum + entries.length, 0), 事件: catalog.eventIds.length};
  return {errors, hints, summary};
}
