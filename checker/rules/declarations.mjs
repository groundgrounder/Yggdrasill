import {validateDeclarations} from '../../core/declarations.mjs';
import {issue} from '../../core/utils.mjs';

export function checkDeclarations(raw, catalog, compiled = validateDeclarations(raw)) {
  const {decl, issues: originalIssues} = compiled;
  const issues = [...originalIssues];
  const declared = new Set(Object.keys(raw ?? {}));
  const add = (rule, name, message) => issues.push(issue(rule, '错误', `设定/${name}.yaml`, message));
  if (catalog.groups.length && !declared.has('角色分类')) add('设定.缺少文件', '角色分类', '存在角色组时必须提供角色分类.yaml');
  return {decl, issues};
}
