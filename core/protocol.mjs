import {createCalendar} from './calendar.mjs';
import {evaluateCondition, conditionReferences, checkCondition} from './conditions.mjs';
import {checkChange, changeRoleReferences} from './changes.mjs';
import {dimensionKeys, resolveDomain} from './fields.mjs';
import {isValidId} from './ids.mjs';
import {has, isMap, isText, list, pairs, freeze, codepointCompare} from './utils.mjs';
import {createStateValidator} from './protocol/validation.mjs';

const DEBUT_PREFIX = '初次登场·';

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code, message) { throw new ProtocolError(code, message); }
function clone(value) { return structuredClone(value); }
function own(value, key) { return value != null && Object.hasOwn(value, key); }
function getOwn(value, key) { return own(value, key) ? value[key] : undefined; }
function setOwn(value, key, item) {
  Object.defineProperty(value, key, {value: item, enumerable: true, configurable: true, writable: true});
}
export function createProtocol({catalog: sourceCatalog, decl: sourceDecl} = {}) {
  const catalog = sourceCatalog && freeze(clone(sourceCatalog)), decl = sourceDecl && freeze(clone(sourceDecl));
  if (!isMap(catalog) || !isMap(decl)) fail('协议.参数', '协议需要目录与声明');
  const calendar = createCalendar(decl.calendar);
  const groups = new Map(list(catalog.groups).map(group => [group.id, group]));
  const events = new Map(list(catalog.events).map(event => [event.id, event]));
  const chains = new Map(list(catalog.chains).map(chain => [chain.id, chain]));
  const locations = new Map(list(catalog.entries?.地点).map(entry => [entry.id, entry]));
  const skills = list(catalog.entries?.技能);
  const entries = new Map(Object.entries(catalog.entries ?? {}).map(([name, values]) => [name, new Map(values.map(entry => [entry.id, entry]))]));
  const profiles = new Map(catalog.groups.map(group => [group.id, new Map(list(group.内容?.档案).map(profile => [profile.档案ID, profile]))]));
  const openingPlans = new Map(list(catalog.openingPlans).map(plan => [plan.id, plan]));
  const marks = decl.marks ?? {};
  const dimensions = decl.ability?.维度 ?? {};
  const validation = createStateValidator({catalog, decl, calendar, groups, events, chains, locations, fail,
    abilityValid: abilityValueValid});

  function isEnabled(id, state) {
    return groups.has(id) && getOwn(state?.开局?.角色组, id)?.启用 === true;
  }

  function checkState(state, sealed = false, options = {}) {
    validation.validate(state, sealed, options);
  }

  function eventRange(event) {
    const earliest = calendar.time(event?.内容?.触发时间?.最早);
    const latest = calendar.time(event?.内容?.触发时间?.最晚);
    if (!earliest || !latest || earliest[0] > latest[0]) fail('协议.参数', `事件时间不合法：${event?.id}`);
    return {earliest, latest};
  }

  function getGroupVersion(state, id) { return getOwn(state?.开局?.角色组, id)?.版本ID; }
  function versionProfiles(group, version) {
    const declarations = list(group?.内容?.档案);
    return declarations.filter(profile => !Array.isArray(profile?.适用版本)
      || profile.适用版本.includes(version)).map(profile => ({
      ...profile,
      id: profile.档案ID,
    }));
  }

  function ancestors(profile, available) {
    const out = [];
    let current = profile, guard = 0;
    while (current?.前置档案) {
      if (guard++ >= available.length) throw new Error(`前置档案成环：${profile.id}`);
      current = available.find(item => item.id === current.前置档案);
      if (!current) break;
      out.push(current.id);
    }
    return out;
  }

  function presentIDs(state) {
    const result = new Set(Object.entries(state?.角色 ?? {}).filter(([, value]) => value?.在场 === true).map(([id]) => id));
    const player = state?.开局?.玩家;
    if (state?.世界?.当前地点 && player?.模式 === '扮演') result.add(player.扮演角色组);
    if (state?.世界?.当前地点 && player?.模式 === '自建') result.add('玩家');
    return result;
  }

  function readLocation(state, id) {
    const run = getOwn(state?.角色, id) ?? {};
    if (presentIDs(state).has(id) && state?.世界?.当前地点) return state.世界.当前地点.地标;
    if (own(run, '所在')) return run.所在;
    return groups.get(id)?.内容?.初始所在 ?? null;
  }

  function isLocationWithin(location, target) {
    let current = locations.get(location), guard = 0;
    while (current && guard++ <= locations.size) {
      if (current.id === target) return true;
      current = locations.get(current.上级);
    }
    return false;
  }

  function readRoleField(state, id, field) {
    if (field === '所在') return readLocation(state, id);
    const parts = field.split('.');
    let schema = getOwn(decl.variables?.角色, parts[0]), value = getOwn(getOwn(state?.角色, id), parts[0]);
    if (!schema) return undefined;
    for (const part of parts.slice(1)) {
      if (isMap(schema?.映射)) {
        schema = schema.映射.值;
        value = getOwn(value, part);
      } else if (isMap(schema?.子字段)) {
        schema = getOwn(schema.子字段, part);
        value = getOwn(value, part);
      } else return undefined;
    }
    if (value !== undefined) return value;
    return schema?.取值 ? resolveDomain(schema.取值, decl)[0] : undefined;
  }

  function conditionRaw(type, value, state, timeContext = state) {
    switch (type) {
      case '角色启用':
        return groups.has(value.角色组ID) ? isEnabled(value.角色组ID, state) : false;
      case '角色版本':
        return groups.has(value.角色组ID) ? isEnabled(value.角色组ID, state)
          && getGroupVersion(state, value.角色组ID) === value.版本ID : false;
      case '事件确认': {
        const record = getOwn(state?.事件, value.事件ID);
        return record?.状态 === 1 && (!value.分支ID || record.分支 === value.分支ID);
      }
      case '事件串状态':
        return chains.has(value.事件串ID)
          ? chainStatusFromState(state, value.事件串ID) === value.状态 : false;
      case '当前时间': {
        const current = calendar.time(timeContext?.世界?.当前时间), target = calendar.time(value.值);
        if (!current || !target) return null;
        return value.比较 === '小于' ? current[1] <= target[0] : current[0] >= target[0];
      }
      case '剧情标记': {
        const actual = getOwn(state?.世界?.剧情标记, value.标记ID);
        if (actual === undefined) return null;
        return value.比较 === '等于' ? actual === value.值 : actual !== value.值;
      }
      case '角色状态': {
        if (!isEnabled(value.角色组ID, state)) return false;
        const actual = readRoleField(state, value.角色组ID, value.字段);
        if (actual === null || actual === undefined) return null;
        if (value.字段 === '所在') return value.属于.some(location => isLocationWithin(actual, location));
        return value.属于.includes(actual);
      }
      case '同处': {
        if (!Array.isArray(value.角色组ID) || value.角色组ID.some(id => !isEnabled(id, state))) return false;
        const places = value.角色组ID.map(id => readLocation(state, id));
        if (places.some(place => place === null || place === undefined)) return null;
        return places.every(place => place === places[0]);
      }
      case '角色已出场': {
        const id = value.角色组ID;
        if (!isEnabled(id, state)) return false;
        if (presentIDs(state).has(id) || getOwn(state?.角色, id)?.已初始化 === true) return true;
        return Object.values(state?.事件 ?? {}).some(record => record?.状态 === 1
          && list(record.实际参与者).includes(id));
      }
      case '当前场景': {
        const location = state?.世界?.当前地点;
        if (!location) return null;
        return location.地标 === value.地标 && location.场景 === value.场景;
      }
      case '在场实力人数': {
        if (!state?.世界?.当前地点) return null;
        const excluded = new Set(list(value.排除角色组));
        const present = [...presentIDs(state)].filter(id => id === '玩家'
          ? state?.开局?.玩家?.模式 === '自建' : isEnabled(id, state)).filter(id => !excluded.has(id));
        const dimensionName = decl.ability?.综合实力;
        if (!dimensionName) return null;
        const dimension = dimensions[dimensionName], ladder = resolveDomain(`等级.${dimension?.等级}`, decl);
        const threshold = ladder.indexOf(value.最低实力);
        let unknown = false, qualified = 0;
        for (const id of present) {
          const ability = getOwn(getOwn(state?.角色, id), dimensionName);
          if (ability === undefined) { unknown = true; continue; }
          const rank = ladder.indexOf(ability);
          if (rank < 0) fail('协议.能力取值', `本局能力取值不合法：${id}.${dimensionName}`);
          if (rank >= threshold) qualified++;
        }
        if (qualified >= value.最少人数) return true;
        return unknown ? null : false;
      }
      default:
        throw new Error(`未登记条件类型：${type}`);
    }
  }

  function evaluateOn(state, condition, timeContext = state) {
    if (!state?.开局?.已封卷) return null;
    return evaluateCondition(condition, (type, value, negative) => {
      const raw = conditionRaw(type, value, state, timeContext);
      // 叶子回调返回已经计入 none 极性的值，未知取反仍保持未知。
      return raw === null ? null : negative ? !raw : raw;
    });
  }

  function selectBranch(event, state, forced, timeContext = state) {
    const branches = list(event.内容?.分支);
    const candidates = forced ? branches.filter(branch => branch.分支ID === forced) : branches;
    if (forced && !candidates.length) return null;
    const eligible = candidates.filter(branch => !branch.门槛
      || evaluateOn(state, branch.门槛, timeContext) === true);
    if (forced) return eligible[0] ?? null;
    const fallback = eligible.find(branch => branch.分支ID === event.内容?.默认分支);
    return fallback ?? eligible[0] ?? null;
  }

  function sortedEvents(values) {
    return [...values].sort((left, right) => eventRange(left).latest[0] - eventRange(right).latest[0]
      || codepointCompare(left.id, right.id));
  }

  function confirmedAt(state) {
    let latest = -Infinity;
    for (const record of Object.values(state?.事件 ?? {})) if (record?.状态 === 1) {
      const interval = calendar.time(record.实际时间);
      if (interval) latest = Math.max(latest, interval[0]);
    }
    return latest;
  }

  function writeRecord(state, event, branch, at, participants, extra = {}) {
    const record = {状态: 1, 分支: branch, 实际时间: at, 实际参与者: [...new Set(participants)], ...extra};
    setOwn(state.事件, event, record);
  }

  function solveHistory(state, candidates, {seal = false, choices = {}} = {}) {
    const draft = state;
    const ordered = sortedEvents(candidates);
    const solved = new Map();
    const skipped = new Set();
    let lastAt = confirmedAt(draft);
    while (true) {
      let selected = null;
      for (const event of ordered) {
        if (skipped.has(event.id) || solved.has(event.id) || own(draft.事件, event.id)) continue;
        if (event.内容?.确认策略 === '仅作候选'
          || list(event.内容?.核心参与者).some(id => !isEnabled(id, draft))) continue;
        const context = {世界: {当前时间: event.内容.触发时间.最晚}};
        if (event.内容?.门槛 && evaluateOn(draft, event.内容.门槛, context) !== true) continue;
        const forced = getOwn(choices, event.id);
        const branch = selectBranch(event, draft, forced, context);
        if (!branch) continue;
        selected = {event, branch};
        break;
      }
      if (!selected) break;
      const at = selected.event.内容.触发时间.最晚;
      const atStart = calendar.time(at)[0];
      if (atStart < lastAt) {
        if (seal) fail('封卷.时间顺序冲突', `历史求解时间倒流：${selected.event.id}`);
        skipped.add(selected.event.id);
        continue;
      }
      writeRecord(draft, selected.event.id, selected.branch.分支ID, at,
        list(selected.event.内容?.核心参与者));
      applyChangesToState(draft, list(selected.branch.变化));
      solved.set(selected.event.id, selected.branch.分支ID);
      lastAt = atStart;
    }
    return {state: draft, solved, skipped};
  }

  function settleState(state, options = {}) {
    checkState(state, false, options);
    if (state?.开局?.已封卷 !== true || !calendar.time(state?.世界?.当前时间)) return {state, pending: []};
    const current = calendar.time(state.世界.当前时间);
    const eligible = [...events.values()].filter(event => {
      if (own(state.事件, event.id) || event.内容?.确认策略 !== '自动确认'
        || list(event.内容?.核心参与者).some(id => !isEnabled(id, state))) return false;
      return current[0] >= eventRange(event).latest[1];
    });
    const draft = clone(state), solved = solveHistory(draft, eligible);
    return {state: draft, pending: [...solved.solved].map(([eventID, branchID]) => ({事件ID: eventID, 分支ID: branchID}))};
  }

  function findPending(state) { return settleState(state).pending; }
  function effectiveState(state) { return settleState(state).state; }

  function chainStatusFromState(state, id) {
    const chain = chains.get(id)?.内容;
    if (!chain) return null;
    const confirmed = (eventID, branchID) => {
      const record = getOwn(state?.事件, eventID);
      return record?.状态 === 1 && (!branchID || record.分支 === branchID);
    };
    if (list(chain.结局).some(outcome => typeof outcome === 'string'
      ? confirmed(outcome) : confirmed(outcome?.事件ID, outcome?.分支ID))) return '已结束';
    if (Object.values(state?.事件 ?? {}).some(record => record?.状态 === 1 && record.结束事件串 === id)) return '已结束';
    const starts = list(chain.事件).filter(eventID => {
      const event = events.get(eventID);
      if (!event) return false;
      return !conditionReferences(event.内容?.门槛).some(reference => !reference.排斥 && list(chain.事件).includes(reference.事件ID));
    });
    return starts.some(eventID => confirmed(eventID)) ? '进行中' : '未开始';
  }

  function resolveProfileOn(state, groupID) {
    const group = groups.get(groupID);
    if (!group) fail('协议.参数', `角色组不存在：${groupID}`);
    if (!isEnabled(groupID, state)) return {结果: '未启用'};
    const version = getGroupVersion(state, groupID);
    const applicable = versionProfiles(group, version);
    const matched = applicable.filter(profile => profile.默认 === true
      || evaluateOn(state, profile.生效条件) === true);
    const selected = matched.filter(profile => !matched.some(other => other !== profile
      && ancestors(other, applicable).includes(profile.id)));
    if (selected.length === 1) return {结果: '成立', 档案ID: selected[0].id};
    if (selected.length > 1) return {结果: '冲突', 档案: selected.map(profile => profile.id)};
    return {结果: '异常'};
  }

  function schemaChange(change, state) {
    const issues = checkChange(change, {decl, catalog});
    if (issues.length) fail('协议.变化', issues.map(item => `${item.规则}：${item.说明}`).join('；'));
    const parts = change.路径.split('.');
    checkRoleTargets(change, state);
    return parts;
  }

  function checkRoleTargets(change, state) {
    for (const id of changeRoleReferences({路径: change.路径}, decl)) {
      if (id !== '玩家' && !isEnabled(id, state)) fail('协议.变化', `路径中的角色组未启用：${id}`);
    }
    if (state.开局.玩家.模式 !== '自建' && changeRoleReferences(change, decl).includes('玩家'))
      fail('协议.变化', '扮演模式不能写保留角色组“玩家”');
  }

  function clearRemoval(run, field) {
    if (!Array.isArray(run.能力移除记录)) return;
    run.能力移除记录 = run.能力移除记录.filter(item => item !== field);
    if (!run.能力移除记录.length) delete run.能力移除记录;
  }

  function applyChangesToState(state, changes) {
    for (const change of changes) {
      if (!isMap(change)) fail('协议.变化', '变化项须为映射');
      const parts = schemaChange(change, state);
      const op = change.操作, value = change.值;
      let parent = state;
      for (const part of parts.slice(0, -1)) {
        if (!isMap(getOwn(parent, part))) setOwn(parent, part, {});
        parent = getOwn(parent, part);
      }
      const key = parts.at(-1), target = getOwn(parent, key);
      const isDimension = parts[0] === '角色' && has(dimensions, parts[2]);
      const dimension = isDimension ? dimensions[parts[2]] : null;
      const run = parts[0] === '角色' ? getOwn(state.角色, parts[1]) : null;
      const relative = parts.slice(2).join('.');
      if (dimension?.类型 === '集合') {
        const current = Array.isArray(target) ? target : [];
        setOwn(parent, key, op === '新增' ? [...new Set([...current, value])] : current.filter(item => item !== value));
        continue;
      }
      if (dimension && dimension.类型 !== '集合') {
        const ladder = resolveDomain(`等级.${dimension.等级}`, decl);
        if (op === '移除') {
          if (own(parent, key)) delete parent[key];
          run.能力移除记录 = [...new Set([...list(run.能力移除记录), relative])];
        } else if (op === '设定' || ladder.indexOf(value) > ladder.indexOf(target)) {
          setOwn(parent, key, value);
          clearRemoval(run, relative);
        }
        continue;
      }
      const schema = schemaForPath(parts);
      const mapSlot = isMappingSlot(parts);
      if (parts[0] === '角色' && parts[2] === '装备') {
        if (op === '移除') { if (own(parent, key)) delete parent[key]; }
        else if (op === '新增') { if (!own(parent, key)) setOwn(parent, key, clone(value)); }
        else setOwn(parent, key, clone(value));
      } else if (schema?.数值) {
        const [minimum, maximum] = schema.数值;
        const current = target ?? 0;
        setOwn(parent, key, Math.max(minimum, Math.min(maximum, current + (op === '增加' ? value : -value))));
      } else if (schema?.集合) {
        const current = Array.isArray(target) ? target : [];
        setOwn(parent, key, op === '新增' ? [...new Set([...current, value])] : current.filter(item => item !== value));
      } else if (mapSlot) {
        if (op === '移除') { if (own(parent, key)) delete parent[key]; }
        else if (op === '新增') { if (!own(parent, key)) setOwn(parent, key, clone(value)); }
        else setOwn(parent, key, clone(value));
      } else if (op === '移除') {
        if (own(parent, key)) delete parent[key];
      } else if (op === '新增' && Array.isArray(target)) {
        if (!target.includes(value)) target.push(value);
      } else if (op === '新增' && !own(parent, key)) setOwn(parent, key, clone(value));
      else if (op === '增加' || op === '减少') {
        setOwn(parent, key, (Number.isSafeInteger(target) ? target : 0) + (op === '增加' ? value : -value));
      } else setOwn(parent, key, clone(value));
    }
  }

  function schemaForPath(parts) {
    const root = parts[0] === '世界' ? decl.variables?.世界 : decl.variables?.角色;
    const offset = parts[0] === '世界' ? 1 : 2;
    let schema = getOwn(root, parts[offset]);
    for (const part of parts.slice(offset + 1)) {
      if (schema?.映射) schema = schema.映射.值;
      else if (schema?.子字段) schema = getOwn(schema.子字段, part);
    }
    return schema;
  }

  function isMappingSlot(parts) {
    const root = parts[0] === '世界' ? decl.variables?.世界 : decl.variables?.角色;
    const offset = parts[0] === '世界' ? 1 : 2;
    let schema = getOwn(root, parts[offset]);
    for (const part of parts.slice(offset + 1)) {
      if (isMap(schema?.映射)) {
        schema = schema.映射.值;
        if (part === parts.at(-1)) return true;
      } else if (isMap(schema?.子字段)) schema = getOwn(schema.子字段, part);
    }
    return false;
  }

  function applyBranch(state, event, branch) {
    applyChangesToState(state, list(branch.变化));
  }

  function locationIsValid(id) { return locations.has(id); }

  function abilityValueValid(value, dimension) {
    if (dimension.类型 === '等级映射') {
      if (!isMap(value)) return false;
      const keys = new Set(dimensionKeys(dimension));
      const levels = resolveDomain(`等级.${dimension.等级}`, decl);
      return Object.entries(value).every(([key, rank]) => keys.has(key) && levels.includes(rank));
    }
    if (dimension.类型 === '单值等级') return resolveDomain(`等级.${dimension.等级}`, decl).includes(value);
    const member = dimension.成员;
    if (!Array.isArray(value) || new Set(value).size !== value.length) return false;
    return value.every(item => {
      if (member === '文本') return isText(item);
      if (isMap(member) && member.条目库) {
        const found = entries.get(member.条目库)?.get(item);
        return !!found && Object.entries(member.条件 ?? {}).every(([key, expected]) => found.内容?.[key] === expected);
      }
      return checkChange({路径: `角色.玩家.${Object.keys(dimensions).find(name => dimensions[name] === dimension)}`,
        操作: '新增', 值: item}, {decl, catalog}).length === 0;
    });
  }

  function currentAbilityOn(state, groupID) {
    if (groupID === '玩家' ? state?.开局?.玩家?.模式 !== '自建' : !isEnabled(groupID, state)) return null;
    const run = getOwn(state?.角色, groupID) ?? {};
    const result = {};
    for (const [name, dimension] of pairs(dimensions)) {
      const value = getOwn(run, name);
      if (dimension.类型 === '集合') {
        const actual = value === undefined ? [] : value;
        if (!abilityValueValid(actual, dimension)) fail('协议.能力取值', `本局能力取值不合法：${groupID}.${name}`);
        result[name] = clone(actual);
      } else if (value !== undefined) {
        if (!abilityValueValid(value, dimension)) fail('协议.能力取值', `本局能力取值不合法：${groupID}.${name}`);
        if (dimension.类型 === '等级映射' && Object.keys(value).length === 0) continue;
        result[name] = clone(value);
      }
    }
    return result;
  }

  function availableSkillsOn(state, groupID) {
    if (groupID === '玩家' ? state?.开局?.玩家?.模式 !== '自建' : !isEnabled(groupID, state)) return [];
    const ability = currentAbilityOn(state, groupID) ?? {};
    const rules = list(decl.ability?.技能可用);
    return skills.filter(skill => {
      const applicable = rules.filter(rule => Object.entries(rule.适用 ?? {})
        .every(([key, value]) => skill.内容?.[key] === value));
      if (applicable.length !== 1) return false;
      const rule = applicable[0], value = ability[rule.维度];
      if (rule.规则 === '集合持有') return list(value).includes(skill.id);
      const rank = skill.内容?.[rule.等级字段];
      const key = skill.内容?.[rule.键字段];
      const learned = getOwn(value, key);
      const ladder = resolveDomain(`等级.${dimensions[rule.维度]?.等级}`, decl);
      return ladder.includes(learned) && ladder.includes(rank) && ladder.indexOf(learned) >= ladder.indexOf(rank);
    }).map(skill => skill.id);
  }

  function profileSeed(state, groupID, profileID) {
    const profile = profiles.get(groupID)?.get(profileID);
    if (!profile) return null;
    const run = getOwn(state.角色, groupID) ?? {};
    const removed = new Set(list(run.能力移除记录));
    const ability = {};
    for (const [name, initial] of pairs(profile.初始能力)) {
      const dimension = dimensions[name];
      if (!dimension) continue;
      if (dimension.类型 === '等级映射') {
        for (const [key, value] of pairs(initial)) {
          if (removed.has(`${name}.${key}`) || own(run[name], key)) continue;
          (ability[name] ??= {})[key] = value;
        }
      } else if (dimension.类型 === '单值等级') {
        if (!removed.has(name) && !own(run, name)) ability[name] = initial;
      } else if (!removed.has(name) && !own(run, name)) ability[name] = clone(initial);
    }
    const equipment = [];
    for (const item of list(profile.初始装备)) if (!own(run.装备, item.装备ID))
      equipment.push({装备ID: item.装备ID, 状态: item.状态, 位置: item.位置});
    return {档案ID: profileID, 能力: ability, 装备: equipment};
  }

  function initialize(state, groupID, writeIDs) {
    const profile = resolveProfileOn(state, groupID);
    if (profile.结果 !== '成立') fail('协议.初始化', `当前档案不成立：${groupID}`);
    const run = getOwn(state.角色, groupID) ?? {};
    if (!own(state.角色, groupID)) setOwn(state.角色, groupID, run);
    if (run.已初始化 === true) return false;
    const eventID = `${DEBUT_PREFIX}${groupID}`;
    if (events.has(eventID) || own(state.事件, eventID)) fail('协议.参数', `初始化记录冲突：${eventID}`);
    const seed = profileSeed(state, groupID, profile.档案ID);
    if (!seed) fail('协议.初始化', `当前档案不存在：${groupID}`);
    writeRecord(state, eventID, '初始化', state.世界.当前时间, [groupID]);
    for (const [name, fields] of pairs(seed.能力)) {
      if (isMap(fields)) {
        const target = run[name] ??= {};
        for (const [key, value] of pairs(fields)) if (!own(target, key)) target[key] = value;
      } else if (!own(run, name)) run[name] = clone(fields);
    }
    for (const item of seed.装备) {
      const target = run.装备 ??= {};
      if (!own(target, item.装备ID)) target[item.装备ID] = {状态: item.状态, 位置: item.位置};
    }
    run.已初始化 = true;
    writeIDs.push(eventID);
    return true;
  }

  function automaticInitialize(state, eventParticipants, writeIDs) {
    const appeared = new Set(eventParticipants);
    for (const [id, group] of groups) {
      if (!isEnabled(id, state) || group.内容?.初始化方式 !== '出场自动'
        || getOwn(state.角色, id)?.已初始化 === true) continue;
      if ((appeared.has(id) || presentIDs(state).has(id)) && resolveProfileOn(state, id).结果 === '成立') initialize(state, id, writeIDs);
    }
  }

  function branchCondition(event, branch, state, timeContext = state) {
    return (!event.内容?.门槛 || evaluateOn(state, event.内容.门槛, timeContext) === true)
      && (!branch.门槛 || evaluateOn(state, branch.门槛, timeContext) === true);
  }

  function statusOn(state, eventID, pending = findPending(state), preparedEffective) {
    if (own(state?.事件, eventID)) {
      const record = getOwn(state.事件, eventID);
      if (record?.状态 === 1) return {状态: '已确认'};
      if (record?.状态 === 2) return {状态: '已排除'};
    }
    const pendingItem = pending.find(item => item.事件ID === eventID);
    if (pendingItem) return {状态: '待登记', 分支ID: pendingItem.分支ID};
    const event = events.get(eventID);
    if (!event || !state?.开局?.已封卷 || !calendar.time(state?.世界?.当前时间)) return {状态: '未到'};
    if (list(event.内容?.核心参与者).some(id => !isEnabled(id, state))) return {状态: '已排除'};
    const now = calendar.time(state.世界.当前时间), {earliest, latest} = eventRange(event);
    if (now[1] <= earliest[0]) return {状态: '未到'};
    if (now[0] >= latest[1]) return {状态: '已排除'};
    const effective = preparedEffective ?? effectiveState(state);
    const timeContext = clone(effective);
    timeContext.世界.当前时间 = state.世界.当前时间;
    if (event.内容?.门槛 && evaluateOn(effective, event.内容.门槛, timeContext) !== true) return {状态: '不适用'};
    const branches = list(event.内容?.分支).filter(branch => !branch.门槛
      || evaluateOn(effective, branch.门槛, timeContext) === true).map(branch => branch.分支ID);
    return branches.length ? {状态: '候选', 分支: branches} : {状态: '不适用'};
  }

  function validateParticipants(state, participants) {
    if (!Array.isArray(participants) || participants.some(id => !isText(id))) fail('协议.参数', '实际参与者须为角色组ID列表');
    const playerMode = state?.开局?.玩家?.模式;
    for (const id of participants) {
      if (id === '玩家') {
        if (playerMode !== '自建') fail('协议.参与者', '扮演模式不能把玩家列为实际参与者');
      } else {
        if (!groups.has(id)) fail('协议.参数', `实际参与者角色组不存在：${id}`);
        if (!isEnabled(id, state)) fail('协议.参与者', `实际参与者未启用：${id}`);
      }
    }
  }

  function applyPending(state, writeIDs) {
    const pending = findPending(state);
    if (!pending.length) return [];
    const solved = solveHistory(state, pending.map(item => events.get(item.事件ID)));
    const ids = [...solved.solved.keys()];
    writeIDs.push(...ids);
    return ids.flatMap(id => list(events.get(id)?.内容?.核心参与者));
  }

  function exclusionCheck(state, ids) {
    const checkGate = gate => !gate || evaluateCondition(gate, (type, value, negative) => {
      if (type !== '事件确认') return null;
      const record = getOwn(state?.事件, value.事件ID);
      const raw = record?.状态 === 1 && (!value.分支ID || record.分支 === value.分支ID);
      return negative ? !raw : raw;
    }) !== false;
    for (const eventID of ids) {
      const event = events.get(eventID);
      if (!event) continue;
      const record = getOwn(state.事件, eventID);
      const branch = list(event.内容?.分支).find(item => item.分支ID === record?.分支);
      if (!checkGate(event.内容?.门槛) || !checkGate(branch?.门槛))
        fail('协议.排斥冲突', `排斥检查不通过：${eventID}`);
    }
  }

  function writeBase(state) {
    checkState(state, true);
    const draft = clone(state), writeIDs = [];
    const beforeEffective = effectiveState(state);
    const priorConfirmed = Object.entries(beforeEffective.事件 ?? {})
      .filter(([, record]) => record?.状态 === 1).map(([id]) => id).filter(id => events.has(id));
    const participants = applyPending(draft, writeIDs);
    return {draft, writeIDs, participants, priorConfirmed};
  }

  function finishWrite(context, participants = []) {
    const appeared = [...context.participants, ...participants];
    automaticInitialize(context.draft, appeared, context.writeIDs);
    exclusionCheck(context.draft, context.priorConfirmed);
    return {state: context.draft, 已写入: context.writeIDs};
  }

  function previewInitialization(state, groupID) {
    if (!isText(groupID) || !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    const effective = effectiveState(state);
    if (!isEnabled(groupID, effective) || getOwn(effective.角色, groupID)?.已初始化 === true) return null;
    const profile = resolveProfileOn(effective, groupID);
    if (profile.结果 !== '成立') return null;
    return profileSeed(effective, groupID, profile.档案ID);
  }

  function seal(config) {
    if (!isMap(config)) fail('封卷.参数', '封卷参数须为映射');
    const allowed = ['开局时间', '方案', '角色组', '玩家', '历史选择'];
    if (Object.keys(config).some(key => !allowed.includes(key))) fail('封卷.参数', '封卷参数含未知字段');
    let plan = null;
    if (has(config, '方案')) {
      plan = openingPlans.get(config.方案);
      if (!plan) fail('封卷.参数', `开局方案不存在：${config.方案}`);
    }
    const source = plan?.内容 ?? {};
    const choices = {
      ...source,
      ...config,
      角色组: {...(source.角色组 ?? {}), ...(config.角色组 ?? {})},
      历史选择: {...(source.历史选择 ?? {}), ...(config.历史选择 ?? {})},
    };
    for (const key of ['角色组', '历史选择']) if ((has(config, key) && !isMap(config[key]))
      || (has(source, key) && !isMap(source[key]))) fail('封卷.参数', `${key}须为映射`);
    const openingTime = choices.开局时间;
    const openingInterval = calendar.time(openingTime);
    if (!openingInterval) fail('封卷.参数', '缺少合法开局时间');
    for (const id of Object.keys(choices.角色组)) if (!groups.has(id)) fail('封卷.参数', `角色组不存在：${id}`);
    const selectedGroups = {};
    for (const [id, group] of groups) {
      const choice = has(choices.角色组, id) ? getOwn(choices.角色组, id) : {};
      if (!isMap(choice) || Object.keys(choice).some(key => !['启用', '版本ID'].includes(key)))
        fail('封卷.参数', `角色组选择不合法：${id}`);
      const enabled = has(choice, '启用') ? choice.启用 : group.内容?.默认启用;
      const version = has(choice, '版本ID') ? choice.版本ID : group.内容?.默认版本 ?? id;
      if (typeof enabled !== 'boolean' || !group.版本清单.includes(version)) fail('封卷.参数', `角色组启用状态或版本不合法：${id}`);
      setOwn(selectedGroups, id, {启用: enabled, 版本ID: version});
    }
    const player = has(choices, '玩家') ? choices.玩家 : {模式: '自建', 档案: {}};
    if (!isMap(player) || !['自建', '扮演'].includes(player.模式)) fail('封卷.参数', '玩家模式不合法');
    if (Object.keys(player).some(key => !['模式', '档案', '扮演角色组'].includes(key))) fail('封卷.参数', '玩家参数含未知字段');
    if (player.模式 === '扮演' && (!isText(player.扮演角色组)
      || getOwn(selectedGroups, player.扮演角色组)?.启用 !== true)) fail('封卷.参数', '扮演角色组不存在或未启用');
    if (player.模式 === '自建' && has(player, '扮演角色组')) fail('封卷.参数', '自建模式不能指定扮演角色组');
    if (player.模式 === '自建' && player.档案 !== undefined && !isMap(player.档案)) fail('封卷.参数', '玩家档案须为映射');
    if (player.模式 === '扮演' && (has(player, '档案') || Object.keys(player).some(key => !['模式', '扮演角色组'].includes(key))))
      fail('封卷.参数', '扮演模式参数不合法');
    for (const id of Object.keys(choices.历史选择)) if (!isText(id) || !isText(getOwn(choices.历史选择, id))) fail('封卷.历史选择', '历史选择参数不合法');

    const state = {世界: {当前时间: openingTime, 剧情标记: {}},
      开局: {开局时间: openingTime, 已封卷: true, 历史选择: clone(choices.历史选择), 角色组: selectedGroups,
        玩家: clone(player.模式 === '自建' ? {模式: '自建', 档案: player.档案 ?? {}} : player)},
      角色: {}, 事件: {}, 待定项: []};
    validation.player(state.开局.玩家, state, '封卷.参数');
    if (has(choices, '方案')) state.开局.方案 = choices.方案;
    for (const [id, values] of pairs(marks)) if (list(values).length) setOwn(state.世界.剧情标记, id, values[0]);
    const past = [...events.values()].filter(event => event.内容?.确认策略 !== '仅作候选'
      && eventRange(event).latest[1] <= openingInterval[0]);
    const pastIDs = new Set(past.map(event => event.id));
    for (const [eventID, choice] of pairs(choices.历史选择)) {
      const event = events.get(eventID);
      if (!event || !pastIDs.has(eventID) || (choice !== '未发生'
        && !list(event.内容?.分支).some(branch => branch.分支ID === choice)))
        fail('封卷.历史选择', `历史选择无效：${eventID}`);
      if (choice === '未发生') setOwn(state.事件, eventID, {状态: 2});
    }
    const forced = Object.fromEntries(Object.entries(choices.历史选择).filter(([, value]) => value !== '未发生'));
    const pending = past.filter(event => !own(state.事件, event.id));
    const solved = solveHistory(state, pending, {seal: true, choices: forced});
    for (const eventID of Object.keys(forced)) if (!solved.solved.has(eventID))
      fail('封卷.历史选择', `所选分支未能写入：${eventID}`);
    for (const event of past) if (!own(state.事件, event.id)) setOwn(state.事件, event.id, {状态: 2});
    const confirmed = Object.keys(state.事件).filter(id => events.has(id) && getOwn(state.事件, id)?.状态 === 1);
    try { exclusionCheck(state, confirmed); }
    catch (error) {
      if (error instanceof ProtocolError && error.code === '协议.排斥冲突')
        fail('封卷.配置冲突', error.message);
      throw error;
    }
    return state;
  }

  function confirmPending(state) {
    const context = writeBase(state);
    return finishWrite(context);
  }

  function confirmEvent(state, params) {
    checkState(state, true);
    if (!isMap(params) || !isText(params.事件ID) || !isText(params.分支ID)
      || Object.keys(params).some(key => !['事件ID', '分支ID', '实际参与者'].includes(key)))
      fail('协议.参数', '确认事件参数不合法');
    const event = events.get(params.事件ID);
    if (!event || !list(event.内容?.分支).some(branch => branch.分支ID === params.分支ID))
      fail('协议.参数', `事件或分支不存在：${params.事件ID}/${params.分支ID}`);
    if (has(params, '实际参与者') && !Array.isArray(params.实际参与者)) fail('协议.参数', '实际参与者须为列表');
    const context = writeBase(state), {draft, writeIDs} = context;
    if (own(state.事件, params.事件ID)) return finishWrite(context);
    const pending = writeIDs.includes(params.事件ID)
      ? findPending(state).find(item => item.事件ID === params.事件ID) : null;
    if (pending) {
      if (pending.分支ID !== params.分支ID) fail('协议.事件状态', `待登记事件不能更换分支：${params.事件ID}`);
      return finishWrite(context);
    }
    const effective = effectiveState(draft);
    const status = statusOn(effective, params.事件ID, []);
    if (status.状态 !== '候选') fail('协议.事件状态', `事件不是候选：${params.事件ID}`);
    const branch = event.内容.分支.find(item => item.分支ID === params.分支ID);
    if (!branchCondition(event, branch, effective)) fail('协议.事件状态', `所选分支门槛不成立：${params.事件ID}/${params.分支ID}`);
    const extras = params.实际参与者 ?? [];
    validateParticipants(draft, extras);
    const participants = [...new Set([...list(event.内容?.核心参与者), ...extras])];
    validateParticipants(draft, participants);
    writeRecord(draft, event.id, branch.分支ID, draft.世界.当前时间, participants);
    applyBranch(draft, event, branch);
    writeIDs.push(event.id);
    return finishWrite(context, participants);
  }

  function confirmDynamicEvent(state, params) {
    checkState(state, true);
    if (!isMap(params) || !isText(params.事件ID) || !isText(params.摘要)
      || Object.keys(params).some(key => !['事件ID', '摘要', '实际参与者', '变化', '结束事件串'].includes(key)))
      fail('协议.参数', '动态事件参数不合法');
    const id = params.事件ID;
    if (!isValidId(id) || id.startsWith(DEBUT_PREFIX))
      fail('协议.参数', `动态事件ID不合法：${id}`);
    if (events.has(id)) fail('协议.参数', `动态事件ID与预设事件重复：${id}`);
    if (!Array.isArray(params.变化)) fail('协议.参数', '动态事件变化须为列表');
    if (has(params, '实际参与者') && !Array.isArray(params.实际参与者)) fail('协议.参数', '实际参与者须为列表');
    const context = writeBase(state), {draft, writeIDs} = context;
    if (own(state.事件, id)) return finishWrite(context);
    const participants = params.实际参与者 ?? [];
    validateParticipants(draft, participants);
    if (has(params, '结束事件串')) {
      if (!chains.has(params.结束事件串)) fail('协议.参数', `事件串不存在：${params.结束事件串}`);
      if (chainStatusFromState(effectiveState(draft), params.结束事件串) !== '进行中')
        fail('协议.事件状态', `事件串不在进行中：${params.结束事件串}`);
    }
    applyChangesToState(draft, params.变化);
    writeRecord(draft, id, '完成', draft.世界.当前时间, participants,
      {摘要: params.摘要, ...(has(params, '结束事件串') ? {结束事件串: params.结束事件串} : {})});
    writeIDs.push(id);
    return finishWrite(context, participants);
  }

  function confirmInitialization(state, groupID) {
    checkState(state, true);
    if (!isText(groupID) || !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    if (!isEnabled(groupID, state)) fail('协议.初始化', `角色组未启用：${groupID}`);
    const context = writeBase(state);
    if (getOwn(context.draft.角色, groupID)?.已初始化 === true) return finishWrite(context);
    const profile = resolveProfileOn(context.draft, groupID);
    if (profile.结果 !== '成立') fail('协议.初始化', `当前档案不成立：${groupID}`);
    initialize(context.draft, groupID, context.writeIDs);
    return finishWrite(context, []);
  }

  function writeScene(state, params) {
    checkState(state, true);
    if (!isMap(params) || Object.keys(params).some(key => !['当前时间', '当前地点', '在场', '所在'].includes(key)))
      fail('协议.参数', '场景参数不合法');
    checkState(state, true);
    const context = writeBase(state), {draft, writeIDs} = context;
    const sceneParticipants = [];
    if (has(params, '当前时间')) {
      const next = calendar.time(params.当前时间), previous = calendar.time(draft.世界.当前时间);
      if (!next) fail('协议.参数', '当前时间不是合法纪年');
      if (next[0] < previous[0]) fail('协议.场景', '当前时间不能倒退');
      draft.世界.当前时间 = params.当前时间;
      const previousCount = writeIDs.length;
      sceneParticipants.push(...applyPending(draft, writeIDs));
      context.priorConfirmed.push(...writeIDs.slice(previousCount));
    }
    const previousLocation = draft.世界.当前地点?.地标;
    if (has(params, '当前地点')) {
      const location = params.当前地点;
      if (!isMap(location) || Object.keys(location).some(key => !['地标', '场景'].includes(key))
        || !locationIsValid(location.地标) || !isText(location.场景)) fail('协议.参数', '当前地点参数不合法');
      draft.世界.当前地点 = {地标: location.地标, 场景: location.场景};
    }
    const inScene = has(params, '在场') ? params.在场 : {};
    const whereabouts = has(params, '所在') ? params.所在 : {};
    if (!isMap(inScene) || !isMap(whereabouts)) fail('协议.参数', '在场与所在须为映射');
    const roleplay = draft.开局.玩家?.模式 === '扮演' ? draft.开局.玩家.扮演角色组 : null;
    for (const [id, value] of pairs(inScene)) {
      if (id !== '玩家' && !groups.has(id)) fail('协议.参数', `在场角色组不存在：${id}`);
      if (typeof value !== 'boolean') fail('协议.参数', `在场须为布尔：${id}`);
      if (!isEnabled(id, draft) || id === roleplay) fail('协议.场景', `在场角色组不合法：${id}`);
      const run = getOwn(draft.角色, id) ?? {};
      if (!own(draft.角色, id)) setOwn(draft.角色, id, run);
      if (value && run.在场 !== true && !hasAppeared(draft, id)) {
        if (groups.get(id).内容?.初始化方式 !== '出场自动') fail('协议.场景', `角色组须先确认初始化：${id}`);
        sceneParticipants.push(id);
      }
      if (!value && run.在场 === true && !own(whereabouts, id) && previousLocation)
        run.所在 = previousLocation;
      run.在场 = value;
    }
    for (const [id, location] of pairs(whereabouts)) {
      if (!groups.has(id) || !locationIsValid(location)) fail('协议.参数', `所在角色组或地点不存在：${id}`);
      if (!isEnabled(id, draft)) fail('协议.场景', `所在角色组未启用：${id}`);
      if (isViewedPresent(draft, id)) fail('协议.场景', `在场角色不能写所在：${id}`);
      const run = getOwn(draft.角色, id) ?? {};
      if (!own(draft.角色, id)) setOwn(draft.角色, id, run);
      run.所在 = location;
    }
    return finishWrite(context, sceneParticipants);
  }

  function writePendingItem(state, params) {
    checkState(state, true);
    if (!isMap(params) || Object.keys(params).some(key => !['操作', '字段路径', '候选值', '事件ID', '说明'].includes(key))
      || !['新增', '移除'].includes(params.操作) || !isText(params.字段路径)) fail('协议.参数', '待定项参数不合法');
    const parts = params.字段路径.split('.');
    const pathIssues = checkChange({路径: params.字段路径, 操作: '设定'}, {catalog, decl})
      .filter(item => ['变化.路径', '变化.映射键', '变化.协议字段'].includes(item.规则));
    if (pathIssues.length || (parts[0] === '角色' && ['在场', '所在'].includes(parts[2])))
      fail('协议.参数', '待定项字段路径须指向已声明的可写字段格，且不能是在场或所在');
    if (params.操作 === '新增' && (!Array.isArray(params.候选值) || !params.候选值.length
      || !isText(params.事件ID) || !isText(params.说明))) fail('协议.参数', '新增待定项须含非空候选值列表、事件ID与说明');
    if (has(params, '候选值')) validation.serializable(params.候选值);
    const context = writeBase(state), {draft} = context;
    checkRoleTargets({路径: params.字段路径}, draft);
    if (params.操作 === '新增' && getOwn(draft.事件, params.事件ID)?.状态 !== 1)
      fail('协议.参数', `待定项须引用已确认事件：${params.事件ID}`);
    const index = draft.待定项.findIndex(item => item.字段路径 === params.字段路径);
    if (params.操作 === '移除') draft.待定项 = draft.待定项.filter(item => item.字段路径 !== params.字段路径);
    else {
      const item = {字段路径: params.字段路径, 候选值: clone(params.候选值), 事件ID: params.事件ID, 说明: params.说明};
      if (index < 0) draft.待定项.push(item); else draft.待定项[index] = item;
    }
    return finishWrite(context);
  }

  function hasAppeared(state, id) {
    return presentIDs(state).has(id) || getOwn(state.角色, id)?.已初始化 === true
      || Object.values(state.事件 ?? {}).some(record => record?.状态 === 1 && list(record.实际参与者).includes(id));
  }

  function isViewedPresent(state, id) {
    return presentIDs(state).has(id);
  }

  function resolveProfile(state, groupID, options = {}) {
    checkState(state);
    if (!isMap(options) || Object.keys(options).some(key => key !== 'settle')
      || (has(options, 'settle') && typeof options.settle !== 'boolean')) fail('协议.参数', '档案解析选项不合法');
    const effective = options.settle === false ? state : effectiveState(state);
    return resolveProfileOn(effective, groupID);
  }

  function evaluate(state, condition) {
    const issues = checkCondition(condition, {decl, catalog});
    if (issues.some(item => item.级别 === '错误')) fail('协议.参数', issues.map(item => `${item.规则}：${item.说明}`).join('；'));
    const effective = effectiveState(state);
    return evaluateOn(effective, condition);
  }

  function pendingEvents(state) {
    return findPending(state).map(item => ({...item}));
  }

  function eventStatus(state, eventID) {
    if (!isText(eventID) || (!events.has(eventID) && !own(state?.事件, eventID))) fail('协议.参数', `事件不存在：${eventID}`);
    checkState(state);
    return statusOn(state, eventID);
  }

  function chainStatus(state, chainID) {
    if (!isText(chainID) || !chains.has(chainID)) fail('协议.参数', `事件串不存在：${chainID}`);
    const effective = effectiveState(state);
    return effective?.开局?.已封卷 ? chainStatusFromState(effective, chainID) : null;
  }

  function currentAbility(state, groupID) {
    if (!isText(groupID)) fail('协议.参数', '角色组ID须为文本');
    const effective = effectiveState(state);
    if (!effective?.开局?.已封卷) return null;
    if (groupID !== '玩家' && !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    return currentAbilityOn(effective, groupID);
  }

  function availableSkills(state, groupID) {
    const effective = effectiveState(state);
    if (!effective?.开局?.已封卷) return [];
    if (groupID !== '玩家' && !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    return availableSkillsOn(effective, groupID);
  }

  // 每轮只求解一次待登记；其余读取共享同一份有效本局与缓存。
  function createReadView(state) {
    const settled = settleState(state, {allowUnknownLocation: true}), effective = freeze(clone(settled.state));
    const profiles = new Map(), abilities = new Map(), skills = new Map(), statuses = new Map();
    const cached = (cache, id, read) => {
      if (!cache.has(id)) cache.set(id, read());
      return clone(cache.get(id));
    };
    return Object.freeze({
      state: effective, pending: freeze(clone(settled.pending)),
      enabled: id => isEnabled(id, effective),
      presentIDs: () => [...presentIDs(effective)].filter(id => id === '玩家'
        ? effective?.开局?.玩家?.模式 === '自建' : isEnabled(id, effective)),
      leaf: (type, value, negative) => {
        if (!effective?.开局?.已封卷) return null;
        const raw = conditionRaw(type, value, effective);
        return raw === null ? null : negative ? !raw : raw;
      },
      evaluate: condition => evaluateOn(effective, condition),
      eventStatus: id => cached(statuses, id, () => statusOn(state, id, settled.pending, effective)),
      chainStatus: id => effective?.开局?.已封卷 ? chainStatusFromState(effective, id) : null,
      resolveProfile: id => cached(profiles, id, () => resolveProfileOn(effective, id)),
      currentAbility: id => cached(abilities, id, () => effective?.开局?.已封卷 ? currentAbilityOn(effective, id) : null),
      availableSkills: id => cached(skills, id, () => effective?.开局?.已封卷 ? availableSkillsOn(effective, id) : []),
      initializationPreview: id => {
        if (!isEnabled(id, effective) || getOwn(effective?.角色, id)?.已初始化 === true) return null;
        const profile = cached(profiles, id, () => resolveProfileOn(effective, id));
        return profile.结果 === '成立' ? profileSeed(effective, id, profile.档案ID) : null;
      },
    });
  }

  const protocol = {
    evaluate, pendingEvents, eventStatus, chainStatus, resolveProfile, currentAbility,
    availableSkills, initializationPreview: (state, id) => previewInitialization(state, id),
    seal, confirmEvent, confirmPending, confirmDynamicEvent, confirmInitialization, writeScene, writePendingItem, createReadView,
  };
  return Object.freeze(protocol);
}

export const evaluate = (protocol, state, condition) => protocol.evaluate(state, condition);
export const pendingEvents = (protocol, state) => protocol.pendingEvents(state);
export const eventStatus = (protocol, state, eventID) => protocol.eventStatus(state, eventID);
export const chainStatus = (protocol, state, chainID) => protocol.chainStatus(state, chainID);
export const resolveProfile = (protocol, state, groupID, options) => protocol.resolveProfile(state, groupID, options);
export const currentAbility = (protocol, state, groupID) => protocol.currentAbility(state, groupID);
export const availableSkills = (protocol, state, groupID) => protocol.availableSkills(state, groupID);
export const initializationPreview = (protocol, state, groupID) => protocol.initializationPreview(state, groupID);
export const seal = (protocol, choices) => protocol.seal(choices);
export const confirmEvent = (protocol, state, params) => protocol.confirmEvent(state, params);
export const confirmPending = (protocol, state) => protocol.confirmPending(state);
export const confirmDynamicEvent = (protocol, state, params) => protocol.confirmDynamicEvent(state, params);
export const confirmInitialization = (protocol, state, groupID) => protocol.confirmInitialization(state, groupID);
export const writeScene = (protocol, state, params) => protocol.writeScene(state, params);
export const writePendingItem = (protocol, state, params) => protocol.writePendingItem(state, params);
