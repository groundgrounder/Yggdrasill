import {FORBIDDEN_TERMS, SYSTEM_TERMS, WRITING_TERMS, LENGTH_BUDGETS, MACHINE_FIELDS} from '../../core/contract.mjs';
import {has, isMap, list, pairs, count, issue} from '../../core/utils.mjs';

export function visibleStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(visibleStrings);
  return pairs(value).filter(([key]) => !MACHINE_FIELDS.includes(key)).flatMap(([, child]) => visibleStrings(child));
}

export function checkText(catalog, decl) {
  const issues = [];
  const terms = [...FORBIDDEN_TERMS, ...list(decl.textRules.禁用词).filter(value => typeof value === 'string')];
  const budgets = {...LENGTH_BUDGETS};
  for (const [kind, budget] of pairs(decl.textRules.长度预算)) if (has(budgets, kind) && Number.isSafeInteger(budget) && budget > 0) budgets[kind] = Math.min(budget, budgets[kind]);
  const descriptions = new Set(catalog.descriptions.map(record => record.文件));
  for (const entries of Object.values(catalog.entries)) for (const entry of entries) if (entry.同名说明) descriptions.add(entry.文件);
  for (const record of catalog.files) {
    if (!['条目库实例', '条目库说明', '档案文件', '文本容器文件'].includes(record.种类) || record.扩展名 !== '.txt') continue;
    const values = visibleStrings(record.内容);
    const add = (rule, message, level = '错误') => issues.push(issue(rule, level, record.文件, message));
    for (const term of new Set(terms)) if (values.some(value => value.includes(term))) add('文本.禁用词', `正文含禁用词“${term}”`);
    if (descriptions.has(record.文件)) for (const term of SYSTEM_TERMS) if (values.some(value => value.includes(term))) add('文本.系统视角', `说明文件含系统视角词“${term}”`);
    if (values.some(value => /[\u2014\u2015]/u.test(value))) add('文本.破折号', '正文不能使用破折号');
    for (const term of WRITING_TERMS) if (values.some(value => value.includes(term))) add('文本.写法', `正文出现“${term}”`, '提示');
    const kind = record.种类 === '档案文件' ? record.文件.split('/').at(-1).slice(0, -4) : descriptions.has(record.文件) ? '同名说明' : null;
    if (kind && count(values.join('')) > budgets[kind]) add('文本.长度', `正文${count(values.join(''))}字，超过${kind}的${budgets[kind]}字预算`, '提示');
  }
  return issues;
}
