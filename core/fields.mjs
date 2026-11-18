import {createCalendar} from './calendar.mjs';
import {has, isMap, isText, list, pairs, issue} from './utils.mjs';

export function dimensionKeys(dimension) {
  return Array.isArray(dimension?.键) ? dimension.键 : pairs(dimension?.键).flatMap(([, values]) => list(values));
}

export function resolveDomain(domain, decl) {
  if (Array.isArray(domain)) return domain;
  if (typeof domain !== 'string') return [];
  const split = domain.indexOf('.'), kind = domain.slice(0, split), name = domain.slice(split + 1);
  if (kind === '等级') return has(decl?.ladders, name) ? list(decl.ladders[name]) : [];
  if (kind === '词表') return has(decl?.variables?.词表, name) ? list(decl.variables.词表[name]) : [];
  if (kind === '能力') return has(decl?.ability?.维度, name) ? dimensionKeys(decl.ability.维度[name]) : [];
  return [];
}

export function referenceExists(value, target, catalog, {allowPlayer = false, uniqueEntry = true} = {}) {
  if (!isText(value)) return false;
  if (target === '角色组') return (allowPlayer && value === '玩家') || list(catalog?.groups).some(group => group.id === value);
  if (target === '事件') return list(catalog?.eventIds).includes(value);
  if (!has(catalog?.entries, target)) return false;
  const entries = list(catalog.entries[target]).filter(entry => entry.id === value);
  return uniqueEntry ? entries.length === 1 : entries.length > 0;
}

export function checkField(value, schema, context = {}) {
  const {decl, catalog, file = '', label = '字段', scope = '条目', allowEmpty = false} = context;
  const issues = [];
  function add(suffix, message, level = '错误') {
    const actual = scope === '档案' && ['子字段或映射', '取值', '引用', '适用类型'].includes(suffix) ? '形态' : suffix;
    issues.push(issue(`${scope}.${actual}`, level, file, `${label}：${message}`));
  }
  if (!isMap(schema)) return issues;
  if (schema.适用类型 && !list(schema.适用类型).includes(context.entryType)) {
    add('适用类型', '本类型不能填写该字段');
    return issues;
  }
  const child = (next, nextSchema, name, extra = {}) => issues.push(...checkField(next, nextSchema, {...context, allowEmpty: false, label: name, ...extra}));
  if (has(schema, '形态')) {
    const shape = schema.形态;
    if (shape === '文本') {
      if (!isText(value) || /[\r\n]/.test(value.trim())) add('形态', '须为非空的一句话');
    } else if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) add('形态', '须为非空列表');
    else if (shape === '情境列表') {
      for (const item of value) {
        const entries = pairs(item);
        if (!isMap(item) || entries.length !== 1 || !isText(entries[0][0]) || !isText(entries[0][1])
          || /[\r\n]/.test(entries[0][1].trim())) add('形态', '情境列表每项须为单键文本映射');
      }
    } else {
      for (const item of value) {
        if (!isText(item) || /[\r\n]/.test(item.trim())) { add('形态', '列表每项须为非空的一句话'); continue; }
        if (shape === '短语列表' && /[。．.!！?？;；]$/.test(item.trim())) add('形态', '短语不能以句号等句末标点结尾');
        if (shape === '禁区列表' && !item.trim().startsWith('不')) add('形态', '禁区每项须以“不”开头');
        if (schema.最长 && [...item].length > schema.最长) add('形态', `每项不得超过${schema.最长}字`);
      }
    }
  } else if (has(schema, '取值') || has(schema, '引用')) {
    const values = schema.列表 ? value : [value];
    const suffix = has(schema, '引用') ? '引用' : '取值';
    if (!Array.isArray(values) || (schema.列表 && (!values.length || new Set(values).size !== values.length))) add(suffix, '须为非空无重复列表');
    else for (const item of values) {
      if (has(schema, '引用')) {
        if (!(context.allowPlayer && schema.引用 === '角色组' && item === '玩家')
          && !referenceExists(item, schema.引用, catalog)) add('引用', `不能解析“${String(item)}”至“${schema.引用}”`);
      } else if (schema.取值 === '纪年') {
        let valid = false;
        if (decl?.calendar) valid = createCalendar(decl.calendar).time(item) !== null;
        if (!valid) add(scope === '档案' && label === '出生年' ? '出生年' : '取值', '须为合法纪年，可写年或完整日期');
      } else if (!resolveDomain(schema.取值, decl).includes(item)) add('取值', `“${String(item)}”不在声明的值域内`);
    }
  } else if (has(schema, '子字段')) {
    if (!isMap(value) || !Object.keys(value).length) add('子字段或映射', '须为非空映射');
    else {
      const fields = schema.子字段;
      for (const key of Object.keys(value)) {
        if (!has(fields, key)) add('子字段或映射', `含未知子键“${key}”`);
        else child(value[key], fields[key], `${label}.${key}`);
      }
      for (const [key, field] of pairs(fields)) if (field?.必填 && !has(value, key)) add('缺必填', `缺少子字段“${key}”`);
    }
  } else if (has(schema, '映射')) {
    if (!isMap(value) || !Object.keys(value).length) add('子字段或映射', '须为非空映射');
    else for (const [key, item] of pairs(value)) {
      child(key, schema.映射?.键, `${label}的键“${key}”`);
      child(item, schema.映射?.值, `${label}.${key}`);
    }
  } else if (has(schema, '数值')) {
    const range = list(schema.数值);
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) add('取值', '须为范围内的整数');
  } else if (has(schema, '集合')) {
    if (!Array.isArray(value) || new Set(value.map(item => JSON.stringify(item))).size !== value.length) add('取值', '集合须为无重复列表');
    else for (const item of value) child(item, schema.集合, `${label}的成员`);
  }
  if (schema.建议条数 && Array.isArray(value)) {
    const [min, max] = schema.建议条数;
    if (value.length < min || value.length > max) add('建议条数', `建议${min}至${max}条，现有${value.length}条`, '提示');
  }
  return issues;
}
