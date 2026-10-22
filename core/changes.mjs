import {dimensionKeys, resolveDomain} from './fields.mjs';
import {has, isMap, isText, list, pairs, issue} from './utils.mjs';

const RESERVED_ROLE_FIELDS = new Set(['能力移除记录', '已初始化']);

export function checkChange(change, context = {}) {
  const {decl = {}, catalog = {}, file = '', position = '变化'} = context;
  const issues = [];
  const add = (rule, message) => issues.push(issue(rule, '错误', file, `${position}：${message}`));
  if (!isMap(change)) { add('变化.格式', '变化项须为映射'); return issues; }
  const keys = Object.keys(change);
  if (!keys.includes('路径') || !keys.includes('操作')) add('变化.格式', '必须含路径、操作');
  for (const key of keys) if (!['路径', '操作', '值'].includes(key)) add('变化.格式', `含未知字段“${key}”`);
  if (!isText(change.路径) || !isText(change.操作)) return issues;
  const parts = change.路径.split('.');
  if (parts.some(part => !isText(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) { add('变化.路径', '路径各段必须为非空文本'); return issues; }
  const hasValue = has(change, '值');
  const requireValue = () => { if (!hasValue) add('变化.格式', '该操作必须提供值'); };
  const forbidValue = () => { if (hasValue) add('变化.取值', '移除不能带值'); };
  const validateDomain = (value, domain, label = '值') => { if (!domain.includes(value)) add('变化.取值', `${label}“${String(value)}”不在声明的值域内`); };
  const validateText = value => { if (!isText(value)) add('变化.取值', '值须为非空文本'); };
  const validateRole = id => {
    if (id === '玩家') return true;
    if (!list(catalog.groups).some(group => group.id === id)) { add('变化.路径', `角色组“${id}”不存在`); return false; }
    return true;
  };
  const validateMember = (value, schema) => {
    if (schema?.形态 === '文本') validateText(value);
    else if (schema?.取值) validateDomain(value, resolveDomain(schema.取值, decl));
    else if (schema?.引用) {
      if (!isText(value) || !referenceExists(value, schema.引用, catalog)) add('变化.取值', `值“${String(value)}”不能引用“${schema.引用}”`);
    } else if (schema?.集合) validateMember(value, schema.集合);
    else if (schema?.数值 && (!Number.isSafeInteger(value) || value < schema.数值[0] || value > schema.数值[1])) add('变化.取值', '值须为范围内整数');
    else if (!isMap(schema) || value === undefined) add('变化.取值', '值与字段声明不符');
  };
  const validateOperation = (allowed, label = '操作') => { if (!allowed.includes(change.操作)) add('变化.操作', `${label}“${change.操作}”不适用于该字段`); };

  if (parts[0] === '世界') {
    if (parts[1] === '剧情标记') {
      if (parts.length !== 3 || !has(decl.marks, parts[2])) { add('变化.路径', '剧情标记路径必须引用已声明标记'); return issues; }
      validateOperation(['设定']); requireValue(); if (hasValue) validateDomain(change.值, list(decl.marks[parts[2]]));
      return issues;
    }
    if (parts.length !== 2 || !has(decl.variables?.世界, parts[1])) { add('变化.路径', '世界路径必须写到已声明的二层世界字段'); return issues; }
    checkScalarTarget(decl.variables.世界[parts[1]], '世界字段');
    return issues;
  }
  if (parts[0] !== '角色' || parts.length < 3) { add('变化.路径', '路径根必须是世界.剧情标记、世界字段或角色字段'); return issues; }
  const roleID = parts[1];
  if (!validateRole(roleID)) return issues;
  const fieldName = parts[2];
  if (RESERVED_ROLE_FIELDS.has(fieldName)) { add('变化.协议字段', `不能写协议字段“${fieldName}”`); return issues; }
  if (fieldName === '在场') {
    if (parts.length !== 3) add('变化.路径', '在场只能写到字段本身');
    validateOperation(['设定']); requireValue(); if (hasValue && typeof change.值 !== 'boolean') add('变化.取值', '在场的值须为布尔');
    return issues;
  }
  if (fieldName === '所在') {
    if (parts.length !== 3) add('变化.路径', '所在只能写到字段本身');
    validateOperation(['设定']); requireValue();
    if (hasValue && (!list(catalog.entries?.地点).some(entry => entry.id === change.值))) add('变化.取值', '所在必须引用地点ID');
    return issues;
  }
  if (fieldName === '装备') {
    checkEquipment(parts, change, decl, catalog, add, validateOperation, requireValue, forbidValue, validateText);
    return issues;
  }
  const dimension = decl.ability?.维度?.[fieldName];
  if (dimension) {
    checkDimension(parts, change, dimension, decl, catalog, add, validateOperation, requireValue, forbidValue, validateDomain, validateMember);
    return issues;
  }
  const schema = decl.variables?.角色?.[fieldName];
  if (!schema) { add('变化.路径', `角色字段“${fieldName}”未声明`); return issues; }
  checkVariable(parts, change, schema, decl, catalog, add, validateOperation, requireValue, forbidValue, validateDomain, validateMember);
  return issues;

  function checkScalarTarget(target, label) {
    if (target?.取值 || target?.形态) {
      validateOperation(['设定']); requireValue(); if (hasValue) validateMember(change.值, target);
    } else add('变化.路径', `${label}必须写到可修改的字段格`);
  }
}

function checkEquipment(parts, change, decl, catalog, add, validateOperation, requireValue, forbidValue, validateText) {
  if (parts.length !== 4) { add('变化.路径', '装备路径必须写到装备ID'); return; }
  if (!referenceExists(parts[3], '装备', catalog)) add('变化.映射键', `装备“${parts[3]}”不存在`);
  if (!['设定', '新增', '移除'].includes(change.操作)) add('变化.操作', '装备只允许设定、新增、移除');
  if (change.操作 === '移除') { forbidValue(); return; }
  requireValue();
  if (change.值 !== undefined && (!isMap(change.值) || Object.keys(change.值).some(key => !['状态', '位置'].includes(key))
    || !isText(change.值.状态) || !isText(change.值.位置))) add('变化.取值', '装备值须为含状态、位置的映射');
  if (change.值?.状态 && !resolveDomain('词表.装备状态', decl).includes(change.值.状态)) add('变化.取值', '装备状态不在词表内');
}

function checkDimension(parts, change, dimension, decl, catalog, add, validateOperation, requireValue, forbidValue, validateDomain, validateMember) {
  const type = dimension.类型, ranks = resolveDomain(`等级.${dimension.等级}`, decl);
  if (type === '等级映射') {
    if (parts.length !== 4 || !dimensionKeys(dimension).includes(parts[3])) { add('变化.路径', '等级映射必须写到已声明的键'); return; }
    validateOperation(['提升', '设定', '移除']);
    if (change.操作 === '移除') forbidValue(); else { requireValue(); if (change.值 !== undefined) validateDomain(change.值, ranks); }
  } else if (type === '单值等级') {
    if (parts.length !== 3) { add('变化.路径', '单值等级必须写到维度字段'); return; }
    validateOperation(['提升', '设定', '移除']);
    if (change.操作 === '移除') forbidValue(); else { requireValue(); if (change.值 !== undefined) validateDomain(change.值, ranks); }
  } else if (type === '集合') {
    if (parts.length !== 3) { add('变化.路径', '集合必须写到集合字段'); return; }
    validateOperation(['新增', '移除']); requireValue();
    if (change.值 !== undefined) {
      const member = dimension.成员;
      if (member === '文本') { if (typeof change.值 !== 'string' || !change.值.trim()) add('变化.取值', '集合成员须为非空文本'); }
      else if (isMap(member) && member.条目库) {
        if (!referenceExists(change.值, member.条目库, catalog)) add('变化.取值', `集合成员“${change.值}”不存在`);
        const entry = list(catalog.entries?.[member.条目库]).find(item => item.id === change.值);
        if (entry && member.条件 && Object.entries(member.条件).some(([key, value]) => entry.内容?.[key] !== value)) add('变化.取值', `集合成员“${change.值}”不符合成员条件`);
      } else validateMember(change.值, member);
    }
  }
}

function checkVariable(parts, change, schema, decl, catalog, add, validateOperation, requireValue, forbidValue, validateDomain, validateMember) {
  let current = schema;
  let index = 3;
  while (index < parts.length) {
    if (isMap(current?.映射)) {
      const key = parts[index++];
      if (!key || !validMappingKey(current.映射.键, key, catalog)) { add('变化.映射键', `映射键“${key}”不能按声明解析`); return; }
      current = current.映射.值;
      if (index !== parts.length) {
        add('变化.路径', '映射值只能写到映射键这一格'); return;
      }
      checkMappedValue(current);
      return;
    }
    if (isMap(current?.子字段)) {
      const key = parts[index++];
      if (!has(current.子字段, key)) { add('变化.路径', `子字段“${key}”不存在`); return; }
      current = current.子字段[key];
      continue;
    }
    add('变化.路径', '路径深度与字段声明不符'); return;
  }
  if (current?.集合) {
    validateOperation(['新增', '移除']); requireValue(); if (change.值 !== undefined) validateMember(change.值, current.集合); return;
  }
  if (current?.取值 || current?.形态 || current?.数值) {
    const ops = current.数值 ? ['增加', '减少'] : current.取值 || current.形态 ? ['设定'] : [];
    validateOperation(ops);
    if (change.操作 === '移除') forbidValue(); else {
      requireValue();
      if (change.值 !== undefined) {
        if (current.数值) { if (!Number.isSafeInteger(change.值) || change.值 < 1 || change.值 > (decl.variables?.单次增减上限 ?? 100)) add('变化.取值', '增减值须为不超过单次上限的正整数'); }
        else validateMember(change.值, current);
      }
    }
    return;
  }
  add('变化.路径', '路径没有落到可修改字段');

  function checkMappedValue(target) {
    if (target?.数值) {
      if (!['增加', '减少'].includes(change.操作)) add('变化.操作', '数值映射键只允许增加或减少');
      requireValue(); if (change.值 !== undefined && (!Number.isSafeInteger(change.值) || change.值 < 1 || change.值 > (decl.variables?.单次增减上限 ?? 100))) add('变化.取值', '增减值须为不超过单次上限的正整数');
    } else if (target?.取值 || target?.形态 || target?.子字段) {
      if (target?.子字段) {
        if (!['设定', '新增', '移除'].includes(change.操作)) add('变化.操作', '映射子字段只允许设定、新增、移除');
        if (change.操作 === '移除') forbidValue(); else { requireValue(); if (change.值 !== undefined) validateMember(change.值, target); }
      } else {
        validateOperation(['设定', '新增', '移除']);
        if (change.操作 === '移除') forbidValue(); else { requireValue(); if (change.值 !== undefined) validateMember(change.值, target); }
      }
    } else add('变化.路径', '映射值声明不可写');
  }
}

function validMappingKey(schema, key, catalog) {
  if (schema?.引用) return referenceExists(key, schema.引用, catalog);
  return isText(key);
}

function referenceExists(value, target, catalog) {
  if (!isText(value)) return false;
  if (target === '角色组') return list(catalog.groups).some(group => group.id === value);
  return list(catalog.entries?.[target]).some(entry => entry.id === value);
}

export function changedFields(changes) {
  const result = new Set();
  for (const change of list(changes)) {
    const parts = typeof change?.路径 === 'string' ? change.路径.split('.') : [];
    if (parts[0] !== '角色' && parts[0] !== '世界') continue;
    if (parts[0] === '世界') result.add(parts[1] === '剧情标记' ? '剧情标记' : parts[1]);
    else result.add(parts[2]);
  }
  return [...result].sort();
}
