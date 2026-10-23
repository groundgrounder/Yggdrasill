import {FORBIDDEN_TERMS, SYSTEM_TERMS, WRITING_TERMS, LENGTH_BUDGETS, MACHINE_FIELDS, PROFILE_FIELDS} from '../../core/contract.mjs';
import {has, list, pairs, count, issue} from '../../core/utils.mjs';

export function visibleStrings(value, schema = {}, includeKeys = false) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(child => visibleStrings(child, schema, includeKeys));
  const dynamicKeys = schema?.形态 === '情境列表' || has(schema, '映射');
  const textKeys = includeKeys || schema?.形态 === '情境列表' || schema?.映射?.键?.形态 === '文本';
  return pairs(value).filter(([key]) => dynamicKeys || !MACHINE_FIELDS.includes(key)).flatMap(([key, child]) => [
    ...(textKeys ? [key] : []), ...visibleStrings(child, schema?.子字段?.[key] ?? schema?.映射?.值, includeKeys),
  ]);
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
    const profileKind = record.种类 === '档案文件' ? record.文件.split('/').at(-1).slice(0, -4) : null;
    checkValues(record.文件, record.内容, visibleStrings(record.内容, profileKind ? {子字段: {...decl.textRules?.档案追加字段?.[profileKind], ...PROFILE_FIELDS[profileKind]}} : {子字段: decl.libraries[record.文件.split('/')[0]]?.字段}, ['条目库说明', '文本容器文件'].includes(record.种类)), profileKind ?? (descriptions.has(record.文件) ? '同名说明' : null));
  }
  for (const event of catalog.events) {
    if (event.原文 === null) continue;
    const values = eventStrings(event.内容 ?? {});
    checkValues(event.文件, event.内容, values, '事件');
    for (const position of event.角色位置) {
      if (!position.内容) continue;
      const values = positionStrings(position.内容);
      checkValues(position.文件, position.内容, values, null, position);
    }
  }
  for (const group of catalog.groups) {
    const values = [];
    addText(values, group.内容?.显示名);
    addTexts(values, group.内容?.别名);
    for (const version of list(group.内容?.版本)) {
      addText(values, version?.显示名);
      addTexts(values, version?.别名);
      addText(values, version?.简介);
    }
    checkValues(group.文件, group.内容, values, null);
  }
  for (const chain of catalog.chains) checkValues(chain.文件, chain.内容, [chain.内容?.概述].filter(value => typeof value === 'string'), null);
  if (catalog.openingOptions) {
    const values = [];
    for (const option of list(catalog.openingOptions.内容?.选项)) {
      addText(values, option?.问题);
      for (const text of Object.values(option?.选项 ?? {})) addText(values, text);
    }
    checkValues(catalog.openingOptions.文件, catalog.openingOptions.内容, values, null);
  }
  for (const plan of catalog.openingPlans) checkValues(plan.文件, plan.内容, [plan.内容?.概述].filter(value => typeof value === 'string'), null);
  return issues;

  function checkValues(file, raw, values, kind, position = null) {
    const original = position ? originalDialogues(catalog, position) : new Set();
    const add = (rule, message, level = '错误') => issues.push(issue(rule, level, file, message));
    for (const term of new Set(terms)) if (values.some(value => value.includes(term))) add('文本.禁用词', `正文含禁用词“${term}”`);
    if (descriptions.has(file)) for (const term of SYSTEM_TERMS) if (values.some(value => value.includes(term))) add('文本.系统视角', `说明文件含系统视角词“${term}”`);
    for (const value of values) if (/[\u2014\u2015]/u.test(value)) {
      const level = original.has(value) ? '提示' : '错误';
      add('文本.破折号', original.has(value) ? '原台词含破折号' : '正文不能使用破折号', level);
    }
    for (const term of WRITING_TERMS) if (values.some(value => value.includes(term))) add('文本.写法', `正文出现“${term}”`, '提示');
    if (kind && count(values.join('')) > budgets[kind]) add('文本.长度', `正文${count(values.join(''))}字，超过${kind}的${budgets[kind]}字预算`, '提示');
  }

  function addText(values, value) {
    if (typeof value === 'string') values.push(value);
  }

  function addTexts(values, value) {
    for (const item of list(value)) addText(values, item);
  }
}

function eventStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(eventStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (['事件ID', '主类型', '标签', '事件结果', '触发时间', '地点', '确认策略', '核心参与者', '门槛', '关联事件', '默认分支', '变化', '分支ID'].includes(key)) return [];
    if (key === '分支') return Array.isArray(child) ? child.flatMap(branch => eventStrings(branch)) : [];
    return eventStrings(child);
  });
}

function positionStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(positionStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (['事件ID', '角色组ID', '适用分支'].includes(key)) return [];
    if (key === '按分支') return Object.values(child ?? {}).flatMap(positionStrings);
    if (key === '事件触发语料') return positionStrings(child);
    return positionStrings(child);
  });
}

function originalDialogues(catalog, position) {
  const set = new Set();
  const eventID = position.文件.split('/')[2], groupID = position.文件.split('/').at(-1).slice(0, -4);
  for (const record of catalog.sources?.记录 ?? []) {
    const item = record.内容;
    if (item?.事件ID === eventID && item?.角色组ID === groupID && typeof item.台词 === 'string') set.add(item.台词);
  }
  return set;
}
