import {conditionReferences, evaluateCondition} from '../conditions.mjs';
import {resolveDomain} from '../fields.mjs';
import {codepointCompare, has, isMap, isText, list, pairs} from '../utils.mjs';
import {clone, getOwn, own, setOwn} from './changes.mjs';

const DEBUT_PREFIX = '初次登场·';

export function createHistoryTools({catalog, decl, calendar, groups, events, chains, locations, validation, fail,
  isEnabled, resolveProfile, changeTools}) {
  const openingPlans = new Map(list(catalog.openingPlans).map(plan => [plan.id, plan]));
  const profiles = new Map(catalog.groups.map(group => [group.id, new Map(list(group.内容?.档案).map(profile => [profile.档案ID, profile]))]));
  const marks = decl.marks ?? {};
  const dimensions = decl.ability?.维度 ?? {};

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

  function getGroupVersion(state, id) { return getOwn(state?.开局?.角色组, id)?.版本ID; }

  function evaluateOn(state, condition, timeContext = state) {
    if (!state?.开局?.已封卷) return null;
    return evaluateCondition(condition, (type, value, negative) => {
      const raw = conditionRaw(type, value, state, timeContext);
      // 叶子回调返回已经计入 none 极性的值，未知取反仍保持未知。
      return raw === null ? null : negative ? !raw : raw;
    });
  }

  function conditionLeaf(state, type, value, negative) {
    const raw = conditionRaw(type, value, state);
    return raw === null ? null : negative ? !raw : raw;
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

  function eventRange(event) {
    const earliest = calendar.time(event?.内容?.触发时间?.最早);
    const latest = calendar.time(event?.内容?.触发时间?.最晚);
    if (!earliest || !latest || earliest[0] > latest[0]) fail('协议.参数', `事件时间不合法：${event?.id}`);
    return {earliest, latest};
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
      changeTools.applyEventChanges(draft, selected.event, list(selected.branch.变化));
      solved.set(selected.event.id, selected.branch.分支ID);
      lastAt = atStart;
    }
    return {state: draft, solved, skipped};
  }

  function settleState(state, options = {}) {
    validation.validate(state, false, options);
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
    const profile = resolveProfile(state, groupID);
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
      if ((appeared.has(id) || presentIDs(state).has(id)) && resolveProfile(state, id).结果 === '成立')
        initialize(state, id, writeIDs);
    }
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

    const normalizedPlayer = player.模式 === '自建' ? {模式: '自建', 档案: player.档案 ?? {}} : player;
    const provisional = {开局: {角色组: selectedGroups, 玩家: normalizedPlayer}};
    validation.serializable(normalizedPlayer, '封卷.参数');
    validation.player(normalizedPlayer, provisional, '封卷.参数');
    const state = {世界: {当前时间: openingTime, 剧情标记: {}},
      开局: {开局时间: openingTime, 已封卷: true, 历史选择: clone(choices.历史选择), 角色组: selectedGroups,
        玩家: clone(normalizedPlayer)},
      角色: {}, 事件: {}, 待定项: []};
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
      if (error?.name === 'ProtocolError' && error.code === '协议.排斥冲突')
        fail('封卷.配置冲突', error.message);
      throw error;
    }
    return state;
  }

  return {presentIDs, conditionLeaf, evaluateOn, writeRecord, solveHistory, settleState,
    findPending, effectiveState, chainStatusFromState, branchCondition, statusOn, validateParticipants,
    exclusionCheck, profileSeed, initialize, automaticInitialize, seal};
}
