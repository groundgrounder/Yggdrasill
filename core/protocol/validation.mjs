import {checkField, resolveDomain} from '../fields.mjs';
import {PROFILE_FIELDS} from '../contract.mjs';
import {has, isMap, isText, pairs} from '../utils.mjs';

const DEBUT_PREFIX = '初次登场·';
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const get = (value, key) => has(value, key) ? value[key] : undefined;

export function createStateValidator({catalog, decl, calendar, groups, events, chains, locations, fail, abilityValid}) {
  const enabled = (state, id) => groups.has(id) && get(state.开局.角色组, id)?.启用 === true;
  function keys(value, allowed, label) {
    if (!isMap(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('协议.参数', `${label}须为合法映射`);
  }
  function location(value, allowUnknown = false) {
    keys(value, ['地标', '场景'], '当前地点');
    if ((!locations.has(value.地标) && !(allowUnknown && isText(value.地标))) || !isText(value.场景)) fail('协议.参数', '当前地点须含已声明地标与场景文本');
  }
  function variable(value, schema, label, state) {
    if (schema.映射) {
      if (!isMap(value)) fail('协议.参数', `${label}须为映射`);
      for (const [key, item] of pairs(value)) {
        if (RESERVED.has(key)) fail('协议.参数', `${label}含保留映射键`);
        const playerKey = key === '玩家' && schema.映射.键?.引用 === '角色组' && state.开局.玩家.模式 === '自建';
        if (!playerKey && checkField(key, schema.映射.键, {catalog, decl}).some(issue => issue.级别 === '错误'))
          fail('协议.参数', `${label}的映射键不合法：${key}`);
        variable(item, schema.映射.值, `${label}.${key}`, state);
      }
    } else if (schema.子字段) {
      keys(value, Object.keys(schema.子字段), label);
      for (const [key, item] of pairs(value)) variable(item, schema.子字段[key], `${label}.${key}`, state);
    } else if (checkField(value, schema, {catalog, decl, allowEmpty: true, allowPlayer: state.开局.玩家.模式 === '自建'}).some(issue => issue.级别 === '错误'))
      fail('协议.参数', `本局字段取值不合法：${label}`);
  }
  function player(value, state, code = '协议.参数') {
    if (!isMap(value) || !['扮演', '自建'].includes(value.模式)) fail(code, '玩家模式不合法');
    if (value.模式 === '扮演') {
      if (Object.keys(value).some(key => !['模式', '扮演角色组'].includes(key)) || !enabled(state, value.扮演角色组))
        fail(code, '扮演角色组不存在或未启用');
    } else {
      const fields = Object.fromEntries(Object.entries(PROFILE_FIELDS.基本信息).filter(([key]) => key !== '能力特征'));
      if (Object.keys(value).some(key => !['模式', '档案'].includes(key)) || !isMap(value.档案)
        || Object.keys(value.档案).some(key => !has(fields, key))) fail(code, '自建玩家档案字段不合法');
      for (const [key, item] of pairs(value.档案)) {
        if (checkField(item, fields[key], {catalog, decl}).some(issue => issue.级别 === '错误'))
          fail(code, `自建玩家档案取值不合法：${key}`);
      }
    }
  }
  function serializable(value, stack = new Set()) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || stack.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
      fail('协议.参数', '本局变量须由无环的数据组成');
    stack.add(value);
    for (const item of Object.values(value)) serializable(item, stack);
    stack.delete(value);
  }
  function validate(state, requireSealed = false, options = {}) {
    if (!isMap(state)) fail('协议.参数', '本局变量须为映射');
    serializable(state);
    if (has(state, '开局') && !isMap(state.开局)) fail('协议.参数', '开局须为映射');
    if (has(state.开局, '已封卷') && typeof state.开局.已封卷 !== 'boolean') fail('协议.参数', '已封卷须为布尔');
    if (state.开局?.已封卷 !== true) {
      if (requireSealed) fail('协议.未封卷', '写入前须先封卷');
      return;
    }
    keys(state, ['世界', '开局', '角色', '事件', '待定项'], '本局变量');
    keys(state.世界, ['当前时间', '当前地点', '剧情标记', ...Object.keys(decl.variables.世界)], '世界');
    if (has(state.世界, '当前时间') && !calendar.time(state.世界.当前时间)) fail('协议.参数', '当前时间不合法');
    if (requireSealed && !calendar.time(state.世界.当前时间)) fail('协议.参数', '写入须有当前时间');
    if (has(state.世界, '当前地点')) location(state.世界.当前地点, options.allowUnknownLocation === true);
    keys(state.世界.剧情标记, Object.keys(decl.marks), '剧情标记');
    for (const [key, value] of pairs(state.世界.剧情标记)) if (!decl.marks[key].includes(value)) fail('协议.参数', `剧情标记取值不合法：${key}`);
    for (const [key, value] of pairs(state.世界)) if (has(decl.variables.世界, key)) variable(value, decl.variables.世界[key], `世界.${key}`, state);
    keys(state.开局, ['开局时间', '已封卷', '历史选择', '方案', '角色组', '玩家'], '开局');
    if (!calendar.time(state.开局.开局时间)) fail('协议.参数', '开局时间不合法');
    if (!isMap(state.开局.角色组) || Object.keys(state.开局.角色组).length !== groups.size) fail('协议.参数', '开局须记录全部角色组');
    for (const [id, choice] of pairs(state.开局.角色组)) {
      keys(choice, ['启用', '版本ID'], `开局角色组“${id}”`);
      if (!groups.has(id) || typeof choice.启用 !== 'boolean' || !groups.get(id).版本清单.includes(choice.版本ID))
        fail('协议.参数', `开局角色组或版本不合法：${id}`);
    }
    player(state.开局.玩家, state);
    if (!isMap(state.开局.历史选择)) fail('协议.参数', '历史选择须为映射');
    for (const [id, branch] of pairs(state.开局.历史选择)) if (!events.has(id)
      || (branch !== '未发生' && !events.get(id).内容.分支.some(item => item.分支ID === branch))) fail('协议.参数', `历史选择不合法：${id}`);
    if (has(state.开局, '方案') && !catalog.openingPlans.some(plan => plan.id === state.开局.方案)) fail('协议.参数', '开局方案不存在');
    if (!isMap(state.角色)) fail('协议.参数', '角色须为映射');
    for (const [id, run] of pairs(state.角色)) {
      if (id !== '玩家' && !enabled(state, id)) fail('协议.参数', `本局角色未启用：${id}`);
      if (id === '玩家' && state.开局.玩家.模式 !== '自建') fail('协议.参数', '扮演模式不能保存玩家角色');
      keys(run, ['在场', '所在', '装备', '能力移除记录', '已初始化', ...Object.keys(decl.ability.维度), ...Object.keys(decl.variables.角色)], `角色“${id}”`);
      if (has(run, '在场') && typeof run.在场 !== 'boolean') fail('协议.参数', '在场须为布尔');
      if (has(run, '所在') && !locations.has(run.所在)) fail('协议.参数', '所在须为地点ID');
      if (has(run, '已初始化') && typeof run.已初始化 !== 'boolean') fail('协议.参数', '已初始化须为布尔');
      if (has(run, '能力移除记录')) {
        if (!Array.isArray(run.能力移除记录) || new Set(run.能力移除记录).size !== run.能力移除记录.length)
          fail('协议.参数', '能力移除记录须为无重复字段路径列表');
        for (const field of run.能力移除记录) {
          const [name, key, ...tail] = typeof field === 'string' ? field.split('.') : [];
          const dimension = get(decl.ability.维度, name);
          if (!dimension || tail.length || (dimension.类型 === '等级映射'
            ? !resolveDomain(`能力.${name}`, decl).includes(key) : key !== undefined)) fail('协议.参数', '能力移除记录含未知字段');
        }
      }
      if (has(run, '装备')) {
        if (!isMap(run.装备)) fail('协议.参数', '装备须为映射');
        for (const [equipmentID, item] of pairs(run.装备)) {
          keys(item, ['状态', '位置'], '装备');
          if (!catalog.entries.装备?.some(entry => entry.id === equipmentID) || !resolveDomain('词表.装备状态', decl).includes(item.状态)
            || !isText(item.位置)) fail('协议.参数', '本局装备不合法');
        }
      }
      for (const [name, dimension] of pairs(decl.ability.维度)) if (has(run, name) && !abilityValid(run[name], dimension))
        fail('协议.能力取值', `本局能力取值不合法：${id}.${name}`);
      for (const [key, value] of pairs(run)) if (has(decl.variables.角色, key)) variable(value, decl.variables.角色[key], `角色.${id}.${key}`, state);
    }
    if (!isMap(state.事件)) fail('协议.参数', '事件须为映射');
    for (const [id, record] of pairs(state.事件)) {
      keys(record, ['状态', '分支', '实际时间', '实际参与者', '摘要', '结束事件串'], `事件“${id}”`);
      if (!isText(id) || ![0, 1, 2].includes(record.状态)) fail('协议.参数', '事件ID或状态不合法');
      if (!events.has(id)) {
        if (id.startsWith(DEBUT_PREFIX)) {
          if (!groups.has(id.slice(DEBUT_PREFIX.length))) fail('协议.参数', '首次登场记录引用未知角色组');
        } else if (RESERVED.has(id) || id.includes('.')) fail('协议.参数', '动态事件ID不合法');
      }
      if (record.状态 !== 1) continue;
      if (!isText(record.分支) || !calendar.time(record.实际时间) || !Array.isArray(record.实际参与者)) fail('协议.参数', '确认记录不完整');
      if (events.has(id)) {
        if (!events.get(id).内容.分支.some(item => item.分支ID === record.分支)) fail('协议.参数', `确认记录分支不存在：${id}`);
      } else if (id.startsWith(DEBUT_PREFIX)) {
        if (!groups.has(id.slice(DEBUT_PREFIX.length)) || record.分支 !== '初始化') fail('协议.参数', '首次登场记录不合法');
      } else if (RESERVED.has(id) || id.includes('.') || !isText(record.摘要) || record.分支 !== '完成') fail('协议.参数', '动态事件记录不合法');
      for (const participant of record.实际参与者) if (participant === '玩家'
        ? state.开局.玩家.模式 !== '自建' : !groups.has(participant)) fail('协议.参数', '确认记录含未知参与者');
      if (has(record, '结束事件串') && !chains.has(record.结束事件串)) fail('协议.参数', '确认记录含未知事件串');
    }
    if (!Array.isArray(state.待定项)) fail('协议.参数', '待定项须为列表');
    for (const item of state.待定项) {
      keys(item, ['字段路径', '候选值', '事件ID', '说明'], '待定项');
      if (!isText(item.字段路径) || !has(item, '候选值') || !isText(item.事件ID) || !isText(item.说明)) fail('协议.参数', '待定项缺少必填字段');
    }
  }
  return {validate, player, location, serializable};
}
