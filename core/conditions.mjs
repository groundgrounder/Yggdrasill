import {createCalendar} from './calendar.mjs';
import {CONDITION_COMBINATORS, CONDITION_TYPES, UNSEALABLE_CONDITIONS} from './contract.mjs';
import {dimensionKeys, resolveDomain} from './fields.mjs';
import {has, isMap, isText, list, pairs, issue} from './utils.mjs';

export const unsealableTypes = new Set(UNSEALABLE_CONDITIONS);

export function evaluateCondition(node, leaf, negative = false) {
  if (!node || !isMap(node) || Object.keys(node).length !== 1) throw new Error('条件必须只有一个类型键');
  const [[type, value]] = Object.entries(node);
  if (CONDITION_COMBINATORS.includes(type)) {
    if (!Array.isArray(value) || !value.length) throw new Error('逻辑组合不能为空');
    const neg = type === 'none' ? !negative : negative;
    const mode = (type === 'all' && !negative) || (type === 'any' && negative) || (type === 'none' && !negative) ? 'all' : 'any';
    const values = value.map(child => evaluateCondition(child, leaf, neg));
    return mode === 'all'
      ? values.includes(false) ? false : values.includes(null) ? null : true
      : values.includes(true) ? true : values.includes(null) ? null : false;
  }
  return leaf(type, value, negative);
}

export function conditionReferences(node, negative = false, conditionPath = '门槛') {
  if (!isMap(node) || Object.keys(node).length !== 1) return [];
  const [[type, value]] = Object.entries(node);
  if (type === '事件确认' && isMap(value)) return [{...value, 排斥: negative, 条件位置: conditionPath}];
  if (!CONDITION_COMBINATORS.includes(type) || !Array.isArray(value)) return [];
  return value.flatMap((child, index) => conditionReferences(child, type === 'none' ? !negative : negative,
    `${conditionPath}.${type}[${index + 1}]`));
}

export function requiredEventIDs(node, negative = false) {
  if (!isMap(node) || Object.keys(node).length !== 1) return new Set();
  const [[type, value]] = Object.entries(node);
  if (type === '事件确认') return new Set(!negative && isMap(value) && isText(value.事件ID) ? [value.事件ID] : []);
  if (!CONDITION_COMBINATORS.includes(type) || !Array.isArray(value)) return new Set();
  const neg = type === 'none' ? !negative : negative;
  const sets = value.map(child => requiredEventIDs(child, neg));
  const all = (type === 'all' && !negative) || (type === 'any' && negative) || (type === 'none' && !negative);
  if (all) return new Set(sets.flatMap(set => [...set]));
  return sets.length ? new Set([...sets[0]].filter(id => sets.every(set => set.has(id)))) : new Set();
}

export function prerequisitesPossible(node, available) {
  return !node || evaluateCondition(node, (type, value, negative) => type !== '事件确认' || negative || available(value));
}

export function containsUnsealable(node) {
  let found = false;
  if (!isMap(node) || Object.keys(node).length !== 1) return found;
  const [[type, value]] = Object.entries(node);
  if (unsealableTypes.has(type)) return true;
  if (CONDITION_COMBINATORS.includes(type) && Array.isArray(value)) for (const child of value) if (containsUnsealable(child)) return true;
  return found;
}

export function hasPositiveCondition(node, types, negative = false) {
  if (!isMap(node) || Object.keys(node).length !== 1) return false;
  const [[type, value]] = Object.entries(node);
  if (CONDITION_COMBINATORS.includes(type)) {
    if (!Array.isArray(value)) return false;
    const neg = type === 'none' ? !negative : negative;
    return value.some(child => hasPositiveCondition(child, types, neg));
  }
  return !negative && types.includes(type);
}

export function checkCondition(condition, context = {}, position = '门槛') {
  const {decl = {}, catalog = {}, file = '', policy = null, writtenValues = null} = context;
  const issues = [];
  const add = (rule, message, level = '错误') => issues.push(issue(rule, level, file, `${position}：${message}`));
  const groups = new Map(list(catalog.groups).map(group => [group.id, group]));
  const events = new Map(list(catalog.events).map(event => [event.id, event]));
  const chains = new Map(list(catalog.chains).map(chain => [chain.id, chain]));
  const worldlines = new Set(list(catalog.worldlines).map(worldline => worldline.id));
  const locations = new Set(list(catalog.entries?.地点).map(entry => entry.id));
  const marks = decl.marks ?? {};
  const calendar = decl.calendar ? createCalendar(decl.calendar) : null;
  const failShape = () => { add('条件.格式', '须为只有一个类型键的映射'); return false; };
  function check(node, path, negative = false) {
    if (!isMap(node) || Object.keys(node).length !== 1) { failShape(); return; }
    const [[type, value]] = Object.entries(node);
    if (CONDITION_COMBINATORS.includes(type)) {
      if (!Array.isArray(value) || !value.length) { add('条件.格式', `${path}的组合项须为非空列表`); return; }
      value.forEach((child, index) => check(child, `${path}.${type}[${index + 1}]`, type === 'none' ? !negative : negative));
      return;
    }
    if (!CONDITION_TYPES.includes(type)) { add('条件.未知类型', `${path}含未知条件类型“${type}”`); return; }
    const params = conditionParameters(type);
    if (!isMap(value)) { add('条件.参数', `${path}参数须为映射`); return; }
    for (const key of Object.keys(value)) if (!params.includes(key)) add('条件.参数', `${path}含未知参数“${key}”`);
    for (const key of params.filter(key => key !== '分支ID' && key !== '排除角色组')) if (!has(value, key)) add('条件.参数', `${path}缺少参数“${key}”`);
    validateLeaf(type, value, path);
    if (policy && policy !== '仅作候选' && unsealableTypes.has(type)) add('条件.封卷不可求值', `${path}含封卷不可求值的条件“${type}”`);
    if (type === '角色状态' && writtenValues) checkValueSources(value, path, writtenValues);
  }
  function validateLeaf(type, value, path) {
    if (type === '角色启用' || type === '角色已出场') {
      if (!isText(value.角色组ID)) add('条件.参数', `${path}.角色组ID须为文本`);
      else if (!groups.has(value.角色组ID)) add('条件.引用', `角色组“${value.角色组ID}”不存在`);
      return;
    }
    if (type === '角色版本') {
      if (!isText(value.角色组ID) || !isText(value.版本ID)) { add('条件.参数', `${path}须含文本角色组ID与版本ID`); return; }
      const group = groups.get(value.角色组ID);
      if (!group) add('条件.引用', `角色组“${value.角色组ID}”不存在`);
      else if (!group.版本清单.includes(value.版本ID)) add('条件.引用', `角色组“${value.角色组ID}”没有版本“${value.版本ID}”`);
      return;
    }
    if (type === '事件确认') {
      if (!isText(value.事件ID)) { add('条件.参数', `${path}.事件ID须为文本`); return; }
      const event = events.get(value.事件ID);
      if (!event) add('条件.引用', `事件“${value.事件ID}”不存在`);
      if (has(value, '分支ID')) {
        if (!isText(value.分支ID)) add('条件.参数', `${path}.分支ID须为文本`);
        else if (!list(event?.内容?.分支).some(branch => branch?.分支ID === value.分支ID)) add('条件.引用', `事件“${value.事件ID}”没有分支“${value.分支ID}”`);
      }
      return;
    }
    if (type === '事件串状态') {
      if (!isText(value.事件串ID) || !['未开始', '进行中', '已结束'].includes(value.状态)) add('条件.参数', `${path}须含事件串ID与合法状态`);
      if (isText(value.事件串ID) && !chains.has(value.事件串ID)) add('条件.引用', `事件串“${value.事件串ID}”不存在`);
      return;
    }
    if (type === '当前时间') {
      if (!['小于', '大于等于'].includes(value.比较) || !calendar?.time(value.值)) add('条件.参数', `${path}的比较或值不合法`);
      return;
    }
    if (type === '剧情标记') {
      if (!isText(value.标记ID) || !['等于', '不等于'].includes(value.比较)) add('条件.参数', `${path}的标记ID或比较不合法`);
      else if (!has(marks, value.标记ID)) add('条件.引用', `剧情标记“${value.标记ID}”不存在`);
      else if (!list(marks[value.标记ID]).includes(value.值)) add('条件.引用', `剧情标记“${value.标记ID}”没有取值“${value.值}”`);
      return;
    }
    if (type === '角色状态') {
      validateRoleState(value, path);
      return;
    }
    if (type === '同处') {
      if (!Array.isArray(value.角色组ID) || value.角色组ID.length < 2 || new Set(value.角色组ID).size !== value.角色组ID.length
        || value.角色组ID.some(id => !isText(id))) add('条件.参数', `${path}.角色组ID须为至少两个无重复角色组ID`);
      else for (const id of value.角色组ID) if (!groups.has(id)) add('条件.引用', `角色组“${id}”不存在`);
      if (!locations.size) add('条件.不可用', `${path}需要地点库`);
      return;
    }
    if (type === '当前场景') {
      if (!isText(value.地标) || !isText(value.场景)) add('条件.参数', `${path}须含地标与场景文本`);
      else if (!locations.has(value.地标)) add('条件.引用', `地点“${value.地标}”不存在`);
      if (!locations.size) add('条件.不可用', `${path}需要地点库`);
      return;
    }
    if (type === '在场实力人数') {
      const domain = decl.ability?.综合实力 ? resolveDomain(`等级.${decl.ability.维度[decl.ability.综合实力]?.等级}`, decl) : [];
      if (!domain.includes(value.最低实力) || !Number.isSafeInteger(value.最少人数) || value.最少人数 < 1)
        add('条件.参数', `${path}的最低实力或最少人数不合法`);
      if (has(value, '排除角色组') && (!Array.isArray(value.排除角色组) || new Set(value.排除角色组).size !== value.排除角色组.length)) add('条件.参数', `${path}.排除角色组须为无重复列表`);
      for (const id of list(value.排除角色组)) if (!groups.has(id)) add('条件.引用', `排除角色组“${id}”不存在`);
      if (!decl.ability?.综合实力) add('条件.不可用', `${path}需要综合实力维度`);
      return;
    }
    if (type === '世界线') {
      if (!isText(value.世界线ID)) add('条件.参数', `${path}.世界线ID须为文本`);
      else if (!worldlines.has(value.世界线ID)) add('条件.引用', `世界线“${value.世界线ID}”不存在`);
    }
  }
  function validateRoleState(value, path) {
    if (!isText(value.角色组ID) || !isText(value.字段) || !Array.isArray(value.属于) || !value.属于.length
      || new Set(value.属于).size !== value.属于.length || value.属于.some(item => !isText(item))) { add('条件.参数', `${path}的角色组ID、字段、属于不合法`); return; }
    if (!groups.has(value.角色组ID)) add('条件.引用', `角色组“${value.角色组ID}”不存在`);
    if (value.字段 === '所在') {
      if (!locations.size) add('条件.不可用', `${path}需要地点库`);
      for (const id of value.属于) if (!locations.has(id)) add('条件.引用', `地点“${id}”不存在`);
      return;
    }
    const [root, ...tail] = value.字段.split('.');
    const schema = decl.variables?.角色?.[root];
    let current = schema;
    if (!schema) { add('条件.角色状态字段', `字段“${value.字段}”不是有取值表的角色字段`); return; }
    if (tail.length) {
      if (isMap(current?.映射) && tail.length === 1) {
        const mapKey = tail[0];
        if (!isText(mapKey) || !validReferenceKey(current.映射.键, mapKey, catalog)) add('条件.引用', `角色状态映射键“${mapKey}”不存在`);
        current = current.映射.值;
      } else {
        for (const key of tail) {
          if (!isMap(current?.子字段) || !has(current.子字段, key)) { add('条件.角色状态字段', `字段“${value.字段}”不是有取值表的角色字段`); return; }
          current = current.子字段[key];
        }
      }
    }
    const domain = current?.取值 ? resolveDomain(current.取值, decl) : [];
    if (!domain.length) add('条件.角色状态字段', `字段“${value.字段}”不是有取值表的角色字段`);
    for (const item of value.属于) if (!domain.includes(item)) add('条件.引用', `字段“${value.字段}”没有取值“${item}”`);
  }
  function checkValueSources(value, path, written) {
    if (!isText(value?.字段) || value.字段 === '所在') return;
    const required = list(value.属于);
    const source = written.get(value.字段) ?? new Set();
    const domain = source.domain ?? stateDomain(value.字段);
    if (required.length && !required.some(item => source.has(item) || (domain.length && domain[0] === item)))
      add('条件.取值无来源', `${path}要求的取值“${required.join('、')}”均没有预设事件变化来源`, '提示');
  }
  function stateDomain(field) {
    const [root, ...tail] = String(field).split('.');
    let current = decl.variables?.角色?.[root];
    if (tail.length && isMap(current?.映射) && tail.length === 1) current = current.映射.值;
    else for (const key of tail) current = current?.子字段?.[key];
    return current?.取值 ? resolveDomain(current.取值, decl) : [];
  }
  check(condition, position);
  return issues;
}

function conditionParameters(type) {
  return ({角色启用: ['角色组ID'], 角色版本: ['角色组ID', '版本ID'], 事件确认: ['事件ID', '分支ID'], 事件串状态: ['事件串ID', '状态'],
    当前时间: ['比较', '值'], 剧情标记: ['标记ID', '比较', '值'], 角色状态: ['角色组ID', '字段', '属于'], 同处: ['角色组ID'],
    角色已出场: ['角色组ID'], 当前场景: ['地标', '场景'], 在场实力人数: ['最低实力', '最少人数', '排除角色组'],
    世界线: ['世界线ID']})[type] ?? [];
}

function validReferenceKey(schema, key, catalog) {
  if (schema?.引用 === '角色组') return list(catalog.groups).some(group => group.id === key);
  if (schema?.引用) return list(catalog.entries?.[schema.引用]).some(entry => entry.id === key);
  return isText(key);
}
