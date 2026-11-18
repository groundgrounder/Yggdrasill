import {createCalendar} from './calendar.mjs';
import {checkCondition} from './conditions.mjs';
import {dimensionKeys, resolveDomain} from './fields.mjs';
import {isValidId} from './ids.mjs';
import {has, isMap, isText, list, pairs, freeze} from './utils.mjs';
import {createStateValidator} from './protocol/validation.mjs';
import {createChangeTools, clone, getOwn, own, setOwn} from './protocol/changes.mjs';
import {createHistoryTools} from './protocol/history.mjs';
import {checkChange, checkPendingPath} from './changes.mjs';

const DEBUT_PREFIX = '初次登场·';

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code, message) { throw new ProtocolError(code, message); }

export function createProtocol({catalog: sourceCatalog, decl: sourceDecl, onCheckState} = {}) {
  const catalog = sourceCatalog && freeze(clone(sourceCatalog)), decl = sourceDecl && freeze(clone(sourceDecl));
  if (!isMap(catalog) || !isMap(decl)) fail('协议.参数', '协议需要目录与声明');
  const calendar = createCalendar(decl.calendar);
  const groups = new Map(list(catalog.groups).map(group => [group.id, group]));
  const events = new Map(list(catalog.events).map(event => [event.id, event]));
  const chains = new Map(list(catalog.chains).map(chain => [chain.id, chain]));
  const locations = new Map(list(catalog.entries?.地点).map(entry => [entry.id, entry]));
  const skills = list(catalog.entries?.技能);
  const entries = new Map(Object.entries(catalog.entries ?? {}).map(([name, values]) => [name, new Map(values.map(entry => [entry.id, entry]))]));
  const dimensions = decl.ability?.维度 ?? {};
  const changeTools = createChangeTools({catalog, decl, fail, isEnabled});
  const validation = createStateValidator({catalog, decl, calendar, groups, events, chains, locations, fail,
    abilityValid: abilityValueValid});
  const history = createHistoryTools({catalog, decl, calendar, groups, events, chains, locations, validation,
    fail, isEnabled, resolveProfile: resolveProfileOn, changeTools});

  function isEnabled(id, state) {
    return groups.has(id) && getOwn(state?.开局?.角色组, id)?.启用 === true;
  }

  function checkState(state, sealed = false, options = {}) {
    if (onCheckState) onCheckState(state, sealed);
    validation.validate(state, sealed, options);
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

  function resolveProfileOn(state, groupID) {
    const group = groups.get(groupID);
    if (!group) fail('协议.参数', `角色组不存在：${groupID}`);
    if (!isEnabled(groupID, state)) return {结果: '未启用'};
    const version = getGroupVersion(state, groupID);
    const applicable = versionProfiles(group, version);
    const matched = applicable.filter(profile => profile.默认 === true
      || history.evaluateOn(state, profile.生效条件) === true);
    const selected = matched.filter(profile => !matched.some(other => other !== profile
      && ancestors(other, applicable).includes(profile.id)));
    if (selected.length === 1) return {结果: '成立', 档案ID: selected[0].id};
    if (selected.length > 1) return {结果: '冲突', 档案: selected.map(profile => profile.id)};
    return {结果: '异常'};
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
    if (!Array.isArray(value) || new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
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

  function applyPending(state, writeIDs) {
    const pending = history.findPending(state);
    if (!pending.length) return [];
    const solved = history.solveHistory(state, pending.map(item => events.get(item.事件ID)));
    const ids = [...solved.solved.keys()];
    writeIDs.push(...ids);
    return ids.flatMap(id => list(events.get(id)?.内容?.核心参与者));
  }

  function writeBase(state, {checked = false} = {}) {
    if (!checked) checkState(state, true);
    const draft = clone(state), writeIDs = [];
    const beforeEffective = history.effectiveState(state);
    const priorConfirmed = Object.entries(beforeEffective.事件 ?? {})
      .filter(([, record]) => record?.状态 === 1).map(([id]) => id).filter(id => events.has(id));
    const participants = applyPending(draft, writeIDs);
    return {draft, writeIDs, participants, priorConfirmed};
  }

  function finishWrite(context, participants = []) {
    const appeared = [...context.participants, ...participants];
    history.automaticInitialize(context.draft, appeared, context.writeIDs);
    history.exclusionCheck(context.draft, context.priorConfirmed);
    return {state: context.draft, 已写入: context.writeIDs};
  }

  function previewInitialization(state, groupID) {
    if (!isText(groupID) || !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    const effective = history.effectiveState(state);
    if (!isEnabled(groupID, effective) || getOwn(effective.角色, groupID)?.已初始化 === true) return null;
    const profile = resolveProfileOn(effective, groupID);
    if (profile.结果 !== '成立') return null;
    return history.profileSeed(effective, groupID, profile.档案ID);
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
    const context = writeBase(state, {checked: true}), {draft, writeIDs} = context;
    const extras = params.实际参与者 ?? [];
    if (own(state.事件, params.事件ID)) {
      history.validateParticipants(draft, extras);
      return finishWrite(context);
    }
    const pending = writeIDs.includes(params.事件ID)
      ? history.findPending(state).find(item => item.事件ID === params.事件ID) : null;
    if (pending) {
      if (pending.分支ID !== params.分支ID) fail('协议.事件状态', `待登记事件不能更换分支：${params.事件ID}`);
      return finishWrite(context);
    }
    const effective = history.effectiveState(draft);
    const status = history.statusOn(effective, params.事件ID, []);
    if (status.状态 !== '候选') fail('协议.事件状态', `事件不是候选：${params.事件ID}`);
    const branch = event.内容.分支.find(item => item.分支ID === params.分支ID);
    if (!history.branchCondition(event, branch, effective)) fail('协议.事件状态', `所选分支门槛不成立：${params.事件ID}/${params.分支ID}`);
    history.validateParticipants(draft, extras);
    const participants = [...new Set([...list(event.内容?.核心参与者), ...extras])];
    history.validateParticipants(draft, participants);
    history.writeRecord(draft, event.id, branch.分支ID, draft.世界.当前时间, participants);
    changeTools.applyBranch(draft, event, branch);
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
    const context = writeBase(state, {checked: true}), {draft, writeIDs} = context;
    const participants = params.实际参与者 ?? [];
    if (own(state.事件, id)) {
      history.validateParticipants(draft, participants);
      if (has(params, '结束事件串') && !chains.has(params.结束事件串))
        fail('协议.参数', `事件串不存在：${params.结束事件串}`);
      changeTools.validateChanges(params.变化, draft);
      return finishWrite(context);
    }
    history.validateParticipants(draft, participants);
    if (has(params, '结束事件串')) {
      if (!chains.has(params.结束事件串)) fail('协议.参数', `事件串不存在：${params.结束事件串}`);
      if (history.chainStatusFromState(history.effectiveState(draft), params.结束事件串) !== '进行中')
        fail('协议.事件状态', `事件串不在进行中：${params.结束事件串}`);
    }
    changeTools.applyChangesToState(draft, params.变化);
    history.writeRecord(draft, id, '完成', draft.世界.当前时间, participants,
      {摘要: params.摘要, ...(has(params, '结束事件串') ? {结束事件串: params.结束事件串} : {})});
    writeIDs.push(id);
    return finishWrite(context, participants);
  }

  function confirmInitialization(state, groupID) {
    checkState(state, true);
    if (!isText(groupID) || !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    if (!isEnabled(groupID, state)) fail('协议.初始化', `角色组未启用：${groupID}`);
    const context = writeBase(state, {checked: true});
    if (getOwn(context.draft.角色, groupID)?.已初始化 === true) return finishWrite(context);
    const profile = resolveProfileOn(context.draft, groupID);
    if (profile.结果 !== '成立') fail('协议.初始化', `当前档案不成立：${groupID}`);
    history.initialize(context.draft, groupID, context.writeIDs);
    return finishWrite(context, []);
  }

  function writeScene(state, params) {
    checkState(state, true);
    if (!isMap(params) || Object.keys(params).some(key => !['当前时间', '当前地点', '在场', '所在'].includes(key)))
      fail('协议.参数', '场景参数不合法');
    const context = writeBase(state, {checked: true}), {draft, writeIDs} = context;
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
    if (checkPendingPath(params.字段路径, {catalog, decl}).length)
      fail('协议.参数', '待定项字段路径须指向已声明的可写字段格，且不能是在场或所在');
    if (params.操作 === '新增' && (!Array.isArray(params.候选值) || !params.候选值.length
      || !isText(params.事件ID) || !isText(params.说明))) fail('协议.参数', '新增待定项须含非空候选值列表、事件ID与说明');
    if (has(params, '候选值')) validation.serializable(params.候选值);
    const context = writeBase(state, {checked: true}), {draft} = context;
    changeTools.checkRoleTargets({路径: params.字段路径}, draft);
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
    return history.presentIDs(state).has(id) || getOwn(state.角色, id)?.已初始化 === true
      || Object.values(state.事件 ?? {}).some(record => record?.状态 === 1 && list(record.实际参与者).includes(id));
  }

  function isViewedPresent(state, id) {
    return history.presentIDs(state).has(id);
  }

  function resolveProfile(state, groupID, options = {}) {
    checkState(state);
    if (!isMap(options) || Object.keys(options).some(key => key !== 'settle')
      || (has(options, 'settle') && typeof options.settle !== 'boolean')) fail('协议.参数', '档案解析选项不合法');
    const effective = options.settle === false ? state : history.effectiveState(state);
    return resolveProfileOn(effective, groupID);
  }

  function evaluate(state, condition) {
    const issues = checkCondition(condition, {decl, catalog});
    if (issues.some(item => item.级别 === '错误')) fail('协议.参数', issues.map(item => `${item.规则}：${item.说明}`).join('；'));
    const effective = history.effectiveState(state);
    return history.evaluateOn(effective, condition);
  }

  function pendingEvents(state) {
    return history.findPending(state).map(item => ({...item}));
  }

  function eventStatus(state, eventID) {
    if (!isText(eventID) || (!events.has(eventID) && !own(state?.事件, eventID))) fail('协议.参数', `事件不存在：${eventID}`);
    checkState(state);
    return history.statusOn(state, eventID);
  }

  function chainStatus(state, chainID) {
    if (!isText(chainID) || !chains.has(chainID)) fail('协议.参数', `事件串不存在：${chainID}`);
    const effective = history.effectiveState(state);
    return effective?.开局?.已封卷 ? history.chainStatusFromState(effective, chainID) : null;
  }

  function currentAbility(state, groupID) {
    if (!isText(groupID)) fail('协议.参数', '角色组ID须为文本');
    const effective = history.effectiveState(state);
    if (!effective?.开局?.已封卷) return null;
    if (groupID !== '玩家' && !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    return currentAbilityOn(effective, groupID);
  }

  function availableSkills(state, groupID) {
    if (!isText(groupID)) fail('协议.参数', '角色组ID须为文本');
    const effective = history.effectiveState(state);
    if (!effective?.开局?.已封卷) return [];
    if (groupID !== '玩家' && !groups.has(groupID)) fail('协议.参数', `角色组不存在：${groupID}`);
    return availableSkillsOn(effective, groupID);
  }

  // 每轮只求解一次待登记；其余读取共享同一份有效本局与缓存。
  function createReadView(state) {
    const settled = history.settleState(state, {allowUnknownLocation: true}), effective = freeze(clone(settled.state));
    const profiles = new Map(), abilities = new Map(), skills = new Map(), statuses = new Map();
    const cached = (cache, id, read) => {
      if (!cache.has(id)) cache.set(id, read());
      return clone(cache.get(id));
    };
    return Object.freeze({
      state: effective, pending: freeze(clone(settled.pending)),
      enabled: id => isEnabled(id, effective),
      presentIDs: () => [...history.presentIDs(effective)].filter(id => id === '玩家'
        ? effective?.开局?.玩家?.模式 === '自建' : isEnabled(id, effective)),
      leaf: (type, value, negative) => {
        if (!effective?.开局?.已封卷) return null;
        return history.conditionLeaf(effective, type, value, negative);
      },
      evaluate: condition => history.evaluateOn(effective, condition),
      eventStatus: id => cached(statuses, id, () => history.statusOn(state, id, settled.pending, effective)),
      chainStatus: id => effective?.开局?.已封卷 ? history.chainStatusFromState(effective, id) : null,
      resolveProfile: id => cached(profiles, id, () => resolveProfileOn(effective, id)),
      currentAbility: id => cached(abilities, id, () => effective?.开局?.已封卷 ? currentAbilityOn(effective, id) : null),
      availableSkills: id => {
        if (!isText(id)) fail('协议.参数', '角色组ID须为文本');
        return cached(skills, id, () => effective?.开局?.已封卷 ? availableSkillsOn(effective, id) : []);
      },
      initializationPreview: id => {
        if (!isEnabled(id, effective) || getOwn(effective?.角色, id)?.已初始化 === true) return null;
        const profile = cached(profiles, id, () => resolveProfileOn(effective, id));
        return profile.结果 === '成立' ? history.profileSeed(effective, id, profile.档案ID) : null;
      },
    });
  }

  const protocol = {
    evaluate, pendingEvents, eventStatus, chainStatus, resolveProfile, currentAbility,
    availableSkills, initializationPreview: (state, id) => previewInitialization(state, id),
    seal: config => history.seal(config), confirmEvent, confirmPending, confirmDynamicEvent, confirmInitialization,
    writeScene, writePendingItem, createReadView,
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
