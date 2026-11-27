import {checkField, resolveDomain} from '../fields.mjs';
import {checkPendingPath} from '../changes.mjs';
import {valueProblem, valueText} from '../values.mjs';
import {PROFILE_FIELDS} from '../contract.mjs';
import {isValidId} from '../ids.mjs';
import {has, isMap, isText, texts, list, pairs} from '../utils.mjs';

const DEBUT_PREFIX = '初次登场·';
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COMMON_PLAYER_KEYS = ['自定义装备', '自定义技能', '额外技能', '移除技能'];
const ROLEPLAY_PLAYER_KEYS = ['模式', '扮演角色组', ...COMMON_PLAYER_KEYS, '能力覆写', '移除能力', '额外装备', '移除装备'];
const CUSTOM_PLAYER_KEYS = ['模式', '档案', '初始能力', '初始装备', ...COMMON_PLAYER_KEYS];
const get = (value, key) => has(value, key) ? value[key] : undefined;

export function createStateValidator({catalog, decl, calendar, groups, events, chains, locations, fail, abilityValid}) {
  const enabled = (state, id) => groups.has(id) && get(state.开局.角色组, id)?.启用 === true;
  const worldlines = new Set(list(catalog.worldlines).map(worldline => worldline.id));
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
        if (RESERVED_KEYS.has(key)) fail('协议.参数', `${label}含保留映射键`);
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
  function validateEquipmentList(items, label, code) {
    if (!Array.isArray(items) || !items.length) fail(code, `${label}须为非空列表`);
    const seen = new Set(), equipStates = resolveDomain('词表.装备状态', decl);
    for (const item of items) {
      if (!isMap(item) || Object.keys(item).some(key => !['装备ID', '状态', '位置'].includes(key)))
        fail(code, `${label}项须只含装备ID、状态、位置`);
      if (!isText(item.装备ID) || !catalog.entries?.装备?.some(entry => entry.id === item.装备ID))
        fail(code, `${label}不存在：${String(item.装备ID)}`);
      if (seen.has(item.装备ID)) fail(code, `${label}重复：${item.装备ID}`);
      seen.add(item.装备ID);
      if (!equipStates.includes(item.状态) || !isText(item.位置))
        fail(code, `${label}状态或位置不合法：${item.装备ID}`);
    }
    return seen;
  }
  function validateAbilityMap(mapValue, label, code) {
    if (!isMap(mapValue) || !Object.keys(mapValue).length) fail(code, `${label}须为非空维度映射`);
    for (const [name, initial] of pairs(mapValue)) {
      const dimension = get(decl.ability?.维度, name);
      if (!isMap(dimension)) fail(code, `${label}含未声明维度：${name}`);
      if (dimension.类型 === '等级映射' && (!isMap(initial) || !Object.keys(initial).length))
        fail(code, `${label}等级映射不能为空：${name}`);
      if (!abilityValid(initial, dimension)) fail(code, `${label}取值不合法：${name}`);
    }
  }
  function validateCommonPlayer(value, code) {
    const equipStates = resolveDomain('词表.装备状态', decl);
    if (has(value, '自定义装备')) {
      if (!Array.isArray(value.自定义装备) || !value.自定义装备.length)
        fail(code, '自定义装备须为非空列表');
      const seen = new Set();
      for (const item of value.自定义装备) {
        if (!isMap(item) || Object.keys(item).some(key => !['名称', '说明', '状态', '位置'].includes(key)))
          fail(code, '自定义装备项须只含名称、说明、状态、位置');
        if (!isText(item.名称) || !isValidId(item.名称) || item.名称.includes('.') || RESERVED_KEYS.has(item.名称))
          fail(code, `自定义装备名称不合法：${String(item.名称)}`);
        if (catalog.entries?.装备?.some(entry => entry.id === item.名称))
          fail(code, `自定义装备与世界书装备重名：${item.名称}`);
        if (seen.has(item.名称)) fail(code, `自定义装备名称重复：${item.名称}`);
        seen.add(item.名称);
        if (!isText(item.说明) || !equipStates.includes(item.状态) || !isText(item.位置))
          fail(code, `自定义装备说明、状态或位置不合法：${item.名称}`);
      }
    }
    if (has(value, '自定义技能')) {
      if (!Array.isArray(value.自定义技能) || !value.自定义技能.length)
        fail(code, '自定义技能须为非空列表');
      const seen = new Set();
      for (const item of value.自定义技能) {
        if (!isMap(item) || Object.keys(item).some(key => !['名称', '说明', '限制'].includes(key)))
          fail(code, '自定义技能项须只含名称、说明、限制');
        if (!isText(item.名称) || !isText(item.说明))
          fail(code, '自定义技能名称与说明须为非空文本');
        if (has(item, '限制') && !isText(item.限制))
          fail(code, `自定义技能限制须为非空文本：${item.名称}`);
        if (seen.has(item.名称)) fail(code, `自定义技能名称重复：${item.名称}`);
        seen.add(item.名称);
      }
    }
    const hasSkillLib = has(decl.libraries, '技能') || list(catalog.entries?.技能).length > 0;
    const skillIDs = new Set(list(catalog.entries?.技能).map(entry => entry.id));
    if (has(value, '额外技能')) {
      if (!hasSkillLib) fail(code, '当前世界书未声明技能条目库，不能填写额外技能');
      if (!texts(value.额外技能)) fail(code, '额外技能须为非空无重复文本列表');
      for (const id of value.额外技能) if (!skillIDs.has(id)) fail(code, `额外技能不存在：${id}`);
    }
    if (has(value, '移除技能')) {
      if (!hasSkillLib) fail(code, '当前世界书未声明技能条目库，不能填写移除技能');
      if (!texts(value.移除技能)) fail(code, '移除技能须为非空无重复文本列表');
      for (const id of value.移除技能) if (!skillIDs.has(id)) fail(code, `移除技能不存在：${id}`);
    }
    if (has(value, '额外技能') && has(value, '移除技能')) {
      const removed = new Set(value.移除技能);
      for (const id of value.额外技能) if (removed.has(id)) fail(code, `额外技能与移除技能重叠：${id}`);
    }
  }
  function player(value, state, code = '协议.参数') {
    if (!isMap(value) || !['扮演', '自建'].includes(value.模式)) fail(code, '玩家模式不合法');
    if (value.模式 === '扮演') {
      if (Object.keys(value).some(key => !ROLEPLAY_PLAYER_KEYS.includes(key)) || !enabled(state, value.扮演角色组))
        fail(code, '扮演角色组不存在或未启用');
      validateCommonPlayer(value, code);
      if (has(value, '能力覆写')) validateAbilityMap(value.能力覆写, '扮演能力覆写', code);
      if (has(value, '移除能力')) {
        if (!texts(value.移除能力)) fail(code, '移除能力须为非空无重复字段路径列表');
        for (const field of value.移除能力) {
          const [name, key, ...tail] = field.split('.');
          const dimension = get(decl.ability?.维度, name);
          if (!dimension || tail.length || (dimension.类型 === '等级映射'
            ? !resolveDomain(`能力.${name}`, decl).includes(key) : key !== undefined))
            fail(code, `移除能力含未知字段：${field}`);
          if (has(value, '能力覆写') && isMap(value.能力覆写)) {
            const conflict = dimension.类型 === '等级映射'
              ? isMap(get(value.能力覆写, name)) && has(value.能力覆写[name], key)
              : has(value.能力覆写, name);
            if (conflict) fail(code, `移除能力与能力覆写冲突：${field}`);
          }
        }
      }
      const extraEquipIDs = has(value, '额外装备') ? validateEquipmentList(value.额外装备, '扮演额外装备', code) : new Set();
      if (has(value, '移除装备')) {
        if (!texts(value.移除装备)) fail(code, '移除装备须为非空无重复装备ID列表');
        for (const id of value.移除装备) {
          if (!catalog.entries?.装备?.some(entry => entry.id === id)) fail(code, `移除装备不存在：${id}`);
          if (extraEquipIDs.has(id)) fail(code, `额外装备与移除装备重叠：${id}`);
        }
      }
    } else {
      const fields = Object.fromEntries(Object.entries(PROFILE_FIELDS.基本信息).filter(([key]) => key !== '能力特征'));
      if (Object.keys(value).some(key => !CUSTOM_PLAYER_KEYS.includes(key)) || !isMap(value.档案)
        || Object.keys(value.档案).some(key => !has(fields, key))) fail(code, '自建玩家档案字段不合法');
      for (const [key, item] of pairs(value.档案)) {
        if (checkField(item, fields[key], {catalog, decl}).some(issue => issue.级别 === '错误'))
          fail(code, `自建玩家档案取值不合法：${key}`);
      }
      if (has(value, '初始能力')) validateAbilityMap(value.初始能力, '自建玩家初始能力', code);
      if (has(value, '初始装备')) validateEquipmentList(value.初始装备, '自建玩家初始装备', code);
      validateCommonPlayer(value, code);
    }
  }
  function serializable(value, code = '协议.参数') {
    const problem = valueProblem(value);
    if (problem) fail(code, problem === 'cycle' ? valueText.cycle : valueText.type);
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
    keys(state.开局, ['世界线', '开局时间', '已封卷', '历史选择', '方案', '角色组', '玩家'], '开局');
    if (worldlines.size > 0) {
      if (!isText(state.开局.世界线) || !worldlines.has(state.开局.世界线)) fail('协议.参数', '开局世界线缺失或不存在');
    } else if (has(state.开局, '世界线')) {
      fail('协议.参数', '当前世界书未声明世界线');
    }
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
      || (branch !== '未发生' && !list(events.get(id).内容?.分支).some(item => item.分支ID === branch))) fail('协议.参数', `历史选择不合法：${id}`);
    if (has(state.开局, '方案') && !catalog.openingPlans.some(plan => plan.id === state.开局.方案)) fail('协议.参数', '开局方案不存在');
    const customEquipments = new Set(list(state.开局.玩家?.自定义装备).map(item => item.名称));
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
          if ((!catalog.entries.装备?.some(entry => entry.id === equipmentID) && !customEquipments.has(equipmentID))
            || !resolveDomain('词表.装备状态', decl).includes(item.状态)
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
      if (!isText(id) || ![1, 2].includes(record.状态)) fail('协议.参数', '事件ID或状态不合法');
      if (!events.has(id)) {
        if (id.startsWith(DEBUT_PREFIX)) {
          if (!groups.has(id.slice(DEBUT_PREFIX.length))) fail('协议.参数', '首次登场记录引用未知角色组');
        } else if (!isValidId(id)) fail('协议.参数', '动态事件ID不合法');
      }
      if (record.状态 !== 1) continue;
      if (!isText(record.分支) || !calendar.time(record.实际时间) || !Array.isArray(record.实际参与者)) fail('协议.参数', '确认记录不完整');
      if (events.has(id)) {
        if (!list(events.get(id).内容?.分支).some(item => item.分支ID === record.分支)) fail('协议.参数', `确认记录分支不存在：${id}`);
      } else if (id.startsWith(DEBUT_PREFIX)) {
        if (!groups.has(id.slice(DEBUT_PREFIX.length)) || record.分支 !== '初始化') fail('协议.参数', '首次登场记录不合法');
      } else if (!isValidId(id) || !isText(record.摘要) || record.分支 !== '完成') fail('协议.参数', '动态事件记录不合法');
      for (const participant of record.实际参与者) if (participant === '玩家'
        ? state.开局.玩家.模式 !== '自建' : !groups.has(participant)) fail('协议.参数', '确认记录含未知参与者');
      if (has(record, '结束事件串') && !chains.has(record.结束事件串)) fail('协议.参数', '确认记录含未知事件串');
    }
    if (!Array.isArray(state.待定项)) fail('协议.参数', '待定项须为列表');
    for (const item of state.待定项) {
      keys(item, ['字段路径', '候选值', '事件ID', '说明'], '待定项');
      if (!isText(item.字段路径) || !has(item, '候选值') || !isText(item.事件ID) || !isText(item.说明)) fail('协议.参数', '待定项缺少必填字段');
      if (checkPendingPath(item.字段路径, {decl, catalog, customEquipments}).length) fail('协议.参数', '待定项的字段路径不合法');
      if (!Array.isArray(item.候选值) || !item.候选值.length) fail('协议.参数', '待定项的候选值须为非空列表');
      serializable(item.候选值);
      if (get(state.事件, item.事件ID)?.状态 !== 1) fail('协议.参数', `待定项须引用已确认事件：${item.事件ID}`);
    }
  }
  return {validate, player, location, serializable};
}
