import {EVENT_FIELDS, EVENT_BRANCH_FIELDS, CONFIRMATION_POLICIES} from '../../core/contract.mjs';
import {createCalendar} from '../../core/calendar.mjs';
import {checkCondition, conditionReferences, evaluateCondition} from '../../core/conditions.mjs';
import {checkChange, changedFields} from '../../core/changes.mjs';
import {has, isMap, isText, list, pairs, texts, issue} from '../../core/utils.mjs';

export function checkEvents(catalog, decl) {
  const issues = [];
  const add = (rule, file, message, level = '错误') => issues.push(issue(rule, level, file, message));
  const byID = new Map(catalog.events.map(event => [event.id, event]));
  const groupIDs = new Set(catalog.groups.map(group => group.id));
  const locations = new Set(list(catalog.entries?.地点).map(entry => entry.id));
  const writtenValues = collectWrittenValues(catalog, decl);
  const profileSupports = collectProfileEventRefs(catalog);
  for (const event of catalog.events) {
    const file = event.文件, content = event.内容;
    if (event.原文 === null) { add('事件.缺文件', file, '事件目录必须有事件.txt'); continue; }
    if (!isMap(content)) { add('事件.字段', file, '事件内容须为映射'); continue; }
    for (const key of Object.keys(content)) if (!EVENT_FIELDS.includes(key)) add('事件.未知字段', file, `含未知字段“${key}”`);
    for (const key of ['事件ID', '事件概要', '主类型', '标签', '事件结果', '触发时间', '确认策略', '核心参与者', '默认分支', '分支']) {
      if (!has(content, key)) add('事件.缺必填', file, `缺少必填字段“${key}”`);
    }
    if (has(content, '事件ID') && content.事件ID !== event.id) add('事件.ID不符', file, '事件ID必须等于目录名');
    for (const key of ['事件标题', '事件概要', '影响范围', '叙事条件']) if (has(content, key) && !isText(content[key])) add('事件.字段', file, `${key}须为非空文本`);
    for (const key of ['公开信息', '隐秘信息']) if (has(content, key) && !textList(content[key])) add('事件.字段', file, `${key}须为非空无重复文本列表`);
    for (const key of ['核心参与者', '关联事件']) if (has(content, key) && (!Array.isArray(content[key]) || new Set(content[key]).size !== content[key].length || content[key].some(value => !isText(value)))) add('事件.字段', file, `${key}须为${key === '核心参与者' ? '' : '非空'}无重复文本列表`);
    if (!isText(content.主类型) || !list(decl.classification?.主类型).includes(content.主类型)
      || !texts(content.标签) || content.标签.some(value => !list(decl.classification?.标签).includes(value))
      || !texts(content.事件结果) || content.事件结果.some(value => !list(decl.classification?.事件结果 ? Object.keys(decl.classification.事件结果) : []).includes(value)))
      add('事件.分类', file, '主类型、标签或事件结果不符合事件分类声明');
    checkTime(content, file, decl, add);
    if (!CONFIRMATION_POLICIES.includes(content.确认策略)) add('事件.确认策略', file, '确认策略须为自动确认、条件确认或仅作候选');
    if (!Array.isArray(content.核心参与者) || new Set(content.核心参与者).size !== content.核心参与者.length || content.核心参与者.some(id => !groupIDs.has(id) || id === '玩家')) add('事件.核心参与者', file, '核心参与者须为已登记且不含玩家的角色组ID列表');
    if (has(content, '地点')) {
      if (!Array.isArray(content.地点) || new Set(content.地点).size !== content.地点.length || content.地点.some(id => !locations.has(id))) add('事件.地点', file, '地点须为已声明地点ID的无重复列表');
    }
    if (has(content, '关联事件') && (!Array.isArray(content.关联事件) || new Set(content.关联事件).size !== content.关联事件.length || content.关联事件.some(id => !byID.has(id) || id === event.id))) add('事件.关联事件', file, '关联事件必须引用其它已存在事件');
    if (has(content, '门槛')) {
      if (content.门槛 === null) add('条件.格式', file, '门槛不能为 null');
      else issues.push(...checkCondition(content.门槛, {decl, catalog, file, policy: content.确认策略, writtenValues}, '门槛'));
    }
    checkBranches(event, file);
    checkResultSupport(event, profileSupports);
    if (content.主类型 === '世界' && conditionReferences(content.门槛).some(ref => !ref.排斥 && ['个人', '关系'].includes(byID.get(ref.事件ID)?.内容?.主类型))) add('事件.世界依赖个人', file, '世界事件的门槛正向引用了个人或关系事件', '提示');
  }
  return issues;

  function checkBranches(event, file) {
    const content = event.内容;
    if (!Array.isArray(content.分支) || !content.分支.length) { add('分支.格式', file, '分支须为非空列表'); return; }
    const ids = [];
    for (const branch of content.分支) {
      if (!isMap(branch)) { add('分支.格式', file, '分支项须为映射'); continue; }
      for (const key of Object.keys(branch)) if (!EVENT_BRANCH_FIELDS.includes(key)) add('分支.格式', file, `分支含未知字段“${key}”`);
      for (const key of ['分支ID', '分支条件', '分支结果']) if (!has(branch, key)) add('分支.格式', file, `分支缺少“${key}”`);
      if (!isText(branch.分支ID)) add('分支.格式', file, '分支ID须为非空文本');
      ids.push(branch.分支ID);
      if (!isText(branch.分支条件) || !isText(branch.分支结果)) add('分支.格式', file, '分支条件与分支结果须为非空文本');
      if (has(branch, '门槛')) {
        if (branch.门槛 === null) add('条件.格式', file, `分支“${branch.分支ID ?? '?'}”门槛不能为 null`);
        else issues.push(...checkCondition(branch.门槛, {decl, catalog, file, policy: content.确认策略, writtenValues}, `分支“${branch.分支ID ?? '?'}”门槛`));
      }
      if (has(branch, '变化')) {
        if (!Array.isArray(branch.变化)) add('变化.格式', file, `分支“${branch.分支ID ?? '?'}”的变化须为列表`);
        else for (let index = 0; index < branch.变化.length; index++) issues.push(...checkChange(branch.变化[index], {decl, catalog, file, position: `分支“${branch.分支ID ?? '?'}”变化[${index + 1}]`}));
      }
      checkRoleGuarantee(event, branch);
    }
    if (new Set(ids).size !== ids.length) add('分支.重复ID', file, '同一事件内分支ID必须唯一');
    if (!ids.includes(content.默认分支)) add('分支.默认分支', file, '默认分支不在分支ID中');
    if (content.确认策略 === '自动确认' && content.分支.some(branch => branch?.门槛) && !content.分支.some(branch => !branch?.门槛)) add('分支.缺兜底', file, '自动确认事件有带门槛分支时必须有不带门槛的兜底分支');
  }

  function checkRoleGuarantee(event, branch) {
    const ids = changedRoleIDs(branch.变化, decl, catalog);
    if (!ids.length) return;
    const condition = combine(event.内容?.门槛, branch?.门槛);
    for (const id of ids) {
      if (id === '玩家' || event.内容?.核心参与者?.includes(id)) continue;
      let value = true;
      if (condition) {
        // 假设目标角色未启用；叶子结果须自行处理取反。
        try {
          value = evaluateCondition(condition, (type, params, negative) => conditionInvolvesRole(type, params, id)
            ? (negative ? true : false)
            : null);
        }
        catch { value = null; }
      }
      if (value !== false) add('变化.角色未保证启用', event.文件, `分支“${branch?.分支ID ?? '?'}”写入角色组“${id}”，但门槛未保证其启用`);
    }
  }

  function checkResultSupport(event, profileRefs) {
    const content = event.内容, fields = new Set(content.分支?.flatMap(branch => changedFields(branch?.变化)) ?? []);
    const profileSupport = profileRefs.some(ref => ref.事件ID === event.id && !ref.排斥);
    for (const result of list(content.事件结果)) {
      const supports = list(decl.classification?.事件结果?.[result]);
      if (supports.length && !supports.some(field => fields.has(field) || (field === '档案切期' && profileSupport))) add('事件.结果缺支撑', event.文件, `事件结果“${result}”没有变化表支撑`, '提示');
    }
    for (const field of fields) {
      const matching = Object.entries(decl.classification?.事件结果 ?? {}).filter(([, supports]) => list(supports).includes(field)).map(([name]) => name);
      if (matching.length && !content.事件结果.some(result => matching.includes(result))) add('事件.结果遗漏', event.文件, `变化写到“${field}”，但事件结果未包含对应项`, '提示');
    }
    if (fields.has('档案切期') && !profileSupport) add('事件.结果遗漏', event.文件, '档案切期没有生效条件支撑', '提示');
    // profileSupport is intentionally also accepted for an explicit档案切期 result.
    if (profileSupport && content.事件结果.some(result => list(decl.classification?.事件结果?.[result]).includes('档案切期'))) return;
  }
}

function textList(value) { return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(value => isText(value) && !/[\r\n]/.test(value)); }

function checkTime(content, file, decl, add) {
  if (!isMap(content.触发时间) || !has(content.触发时间, '最早') || !has(content.触发时间, '最晚')) { add('事件.触发时间', file, '触发时间必须含最早与最晚'); return; }
  if (Object.keys(content.触发时间).some(key => !['最早', '最晚'].includes(key))) add('事件.触发时间', file, '触发时间只能含最早与最晚');
  const calendar = decl.calendar ? createCalendar(decl.calendar) : null;
  const earliest = calendar?.time(content.触发时间.最早), latest = calendar?.time(content.触发时间.最晚);
  if (!earliest || !latest || earliest[0] >= latest[1]) add('事件.触发时间', file, '最早、最晚必须是合法且非空的时间窗口');
}

function combine(first, second) {
  if (first && second) return {all: [first, second]};
  return first ?? second ?? null;
}

function conditionInvolvesRole(type, value, id) {
  if (['角色启用', '角色版本', '角色已出场', '角色状态'].includes(type)) return value?.角色组ID === id;
  if (type === '同处') return list(value?.角色组ID).includes(id);
  return false;
}

function changedRoleIDs(changes, decl, catalog) {
  const groups = new Set(catalog.groups.map(group => group.id));
  const result = new Set();
  for (const change of list(changes)) {
    const parts = typeof change?.路径 === 'string' ? change.路径.split('.') : [];
    if (parts[0] !== '角色') continue;
    if (groups.has(parts[1]) || parts[1] === '玩家') result.add(parts[1]);
    const schema = decl.variables?.角色?.[parts[2]];
    if (schema?.映射?.键?.引用 === '角色组' && groups.has(parts[3])) result.add(parts[3]);
  }
  return [...result];
}

function collectWrittenValues(catalog, decl) {
  const values = new Map();
  for (const event of catalog.events) for (const branch of list(event.内容?.分支)) for (const change of list(branch?.变化)) {
    const parts = typeof change?.路径 === 'string' ? change.路径.split('.') : [];
    if (parts[0] !== '角色' || parts.length < 3) continue;
    const field = parts.slice(2).join('.');
    if (!values.has(field)) values.set(field, new Set());
    if (change.操作 !== '移除' && (typeof change.值 === 'string' || typeof change.值 === 'number')) values.get(field).add(change.值);
  }
  for (const [field, schema] of Object.entries(decl.variables?.角色 ?? {})) {
    const domain = schema?.取值 ? (Array.isArray(schema.取值) ? schema.取值 : []) : [];
    if (!values.has(field)) values.set(field, new Set());
    values.get(field).domain = domain;
  }
  return values;
}

function collectProfileEventRefs(catalog) {
  return catalog.groups.flatMap(group => list(group.内容?.档案)).flatMap(profile => conditionReferences(profile?.生效条件));
}
