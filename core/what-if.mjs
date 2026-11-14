import {createCalendar} from './calendar.mjs';
import {analyzeEventTree, chainStructure, impactOf} from './graph.mjs';
import {createProtocol} from './protocol.mjs';
import {buildReferenceIndex} from './references.mjs';
import {codepointCompare, has, isMap, isText, issue, list} from './utils.mjs';

const OPTION_KEYS = ['世界书', '方案', '排除', '分支', '停用角色组', 'issues'];

export class WhatIfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WhatIfError';
    this.code = code;
  }
}

function fail(code, message) { throw new WhatIfError(code, message); }

/**
 * 比较时间轴末尾的默认封卷与一个只读 if 封卷。
 * catalog、decl 与 options 都不会被修改。
 */
export function whatIf(catalog, decl = {}, options = {}) {
  let input = inputSummary(options), resolved;
  try {
    resolved = resolveOptions(catalog, decl, options);
    input = inputSummary(resolved, resolved.axisEnd);
  } catch (error) {
    return failure(input, [errorIssue(error)]);
  }

  let anomalies = normalizeIssues(options?.issues ?? []);
  if (hasErrors(anomalies)) return failure(input, anomalies);

  let index, analysis;
  try {
    index = buildReferenceIndex(catalog, decl, {issues: anomalies});
    analysis = analyzeEventTree(catalog, decl);
    anomalies = normalizeIssues([...index.issues, ...analysis.issues]);
  } catch (error) {
    return failure(input, [...anomalies, errorIssue(error)]);
  }
  if (hasErrors(anomalies)) return failure(input, anomalies);

  let defaultState, ifState;
  try {
    const protocol = createProtocol({catalog, decl});
    defaultState = protocol.seal({开局时间: resolved.axisEnd});
    ifState = protocol.seal(resolved.ifSeal);
    const confirmed = confirmedEvents(catalog, ifState);
    const stopped = stoppedChains(catalog, protocol, ifState, confirmed, analysis, decl);
    const impacts = impactReport(catalog, index);
    return {
      输入: input,
      没发生: difference(confirmedEvents(catalog, defaultState), confirmed, 'default-only'),
      新发生: difference(confirmedEvents(catalog, defaultState), confirmed, 'if-only'),
      分支不同: branchDifferences(confirmedEvents(catalog, defaultState), confirmed),
      停住的事件串: stopped,
      影响面: impacts,
      异常: anomalies,
    };
  } catch (error) {
    return failure(input, [...anomalies, errorIssue(error)]);
  }
}

export const computeWhatIf = whatIf;

function resolveOptions(catalog, decl, options) {
  if (!isMap(options)) fail('if.参数', 'if 参数须为映射');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.includes(key)) fail('if.参数', `if 参数含未知字段：${key}`);
  if (has(options, '世界书') && !isText(options.世界书)) fail('if.参数', '世界书路径须为文本');

  const planID = has(options, '方案') ? options.方案 : null;
  if (planID !== null && !isText(planID)) fail('if.参数', '方案 ID 须为文本');
  const plan = planID === null ? null : list(catalog?.openingPlans).find(item => item.id === planID);
  if (planID !== null && !plan) fail('if.方案不存在', `开局方案不存在：${planID}`);
  if (planID !== null && !isMap(plan.内容)) fail('if.方案不存在', `开局方案“${planID}”没有可用的配置`);

  const exclusions = uniqueIDs(options.排除 ?? [], '排除');
  const groups = uniqueIDs(options.停用角色组 ?? [], '停用角色组');
  const branches = normalizeBranches(options.分支 ?? []);

  const events = new Map(list(catalog?.events).map(event => [event.id, event]));
  const groupMap = new Map(list(catalog?.groups).map(group => [group.id, group]));
  for (const id of exclusions) if (!events.has(id)) fail('if.事件不存在', `事件不存在：${id}`);
  for (const id of groups) if (!groupMap.has(id)) fail('if.角色组不存在', `角色组不存在：${id}`);
  for (const item of branches) {
    const event = events.get(item.事件ID);
    if (!event) fail('if.事件不存在', `事件不存在：${item.事件ID}`);
    if (!list(event.内容?.分支).some(branch => branch?.分支ID === item.分支ID))
      fail('if.分支不存在', `事件“${item.事件ID}”没有分支“${item.分支ID}”`);
  }
  const excluded = new Set(exclusions);
  const conflict = branches.find(item => excluded.has(item.事件ID));
  if (conflict) fail('if.参数冲突', `事件“${conflict.事件ID}”不能同时排除并指定分支`);

  const axisEnd = timelineEnd(catalog, decl);
  const ifSeal = {开局时间: axisEnd};
  if (plan) ifSeal.方案 = plan.id;

  const history = Object.fromEntries(exclusions.map(id => [id, '未发生']));
  for (const item of branches) history[item.事件ID] = item.分支ID;
  if (Object.keys(history).length) ifSeal.历史选择 = history;

  if (groups.length) {
    ifSeal.角色组 = {};
    for (const id of groups) {
      const planChoice = plan?.内容?.角色组?.[id];
      ifSeal.角色组[id] = {启用: false};
      if (isText(planChoice?.版本ID)) ifSeal.角色组[id].版本ID = planChoice.版本ID;
    }
  }

  return {
    世界书: options.世界书 ?? null, 方案: planID, 排除: exclusions, 分支: branches,
    停用角色组: groups, axisEnd, ifSeal,
  };
}

function uniqueIDs(value, label) {
  if (!Array.isArray(value) || value.some(id => !isText(id))) fail('if.参数', `${label}须为事件或对象 ID 列表`);
  return [...new Set(value)].sort(codepointCompare);
}

function normalizeBranches(value) {
  if (!Array.isArray(value)) fail('if.参数', '分支须为列表');
  const byEvent = new Map();
  for (const item of value) {
    if (!isMap(item) || !isText(item.事件ID) || !isText(item.分支ID)
      || Object.keys(item).some(key => !['事件ID', '分支ID'].includes(key)))
      fail('if.参数', '分支须含文本事件ID与分支ID');
    const previous = byEvent.get(item.事件ID);
    if (previous && previous !== item.分支ID) fail('if.参数冲突', `事件“${item.事件ID}”指定了多个分支`);
    byEvent.set(item.事件ID, item.分支ID);
  }
  return [...byEvent].map(([事件ID, 分支ID]) => ({事件ID, 分支ID}))
    .sort((left, right) => codepointCompare(left.事件ID, right.事件ID) || codepointCompare(left.分支ID, right.分支ID));
}

function timelineEnd(catalog, decl) {
  const events = list(catalog?.events);
  if (!events.length) fail('if.时间轴为空', '世界书没有预设事件，无法确定时间轴末尾');
  let calendar;
  try { calendar = createCalendar(decl?.calendar); }
  catch { fail('if.纪年', '纪年声明不可用，无法确定时间轴末尾'); }

  let maxEnd = -Infinity;
  for (const event of events) {
    const value = event?.内容?.触发时间?.最晚;
    const interval = calendar.time(value);
    if (!interval) fail('if.时间轴', `事件“${event?.id ?? '未知'}”的触发时间不合法：${String(value)}`);
    maxEnd = Math.max(maxEnd, interval[1]);
  }
  const yearDays = calendarYearDays(decl.calendar);
  const year = Math.ceil(maxEnd / yearDays);
  const end = calendar.format(year);
  const interval = calendar.time(end);
  if (!end || !interval || interval[0] < maxEnd)
    fail('if.时间轴', '纪年范围不足以表示全部事件窗口结束后的时间');
  return end;
}

function calendarYearDays(calendar) {
  const months = Array.isArray(calendar.每月天数)
    ? calendar.每月天数 : Array(calendar.月数).fill(calendar.每月天数);
  return months.reduce((sum, days) => sum + days, 0);
}

function inputSummary(value, axisEnd = null) {
  const strings = field => Array.isArray(value?.[field])
    ? value[field].filter(isText).slice().sort(codepointCompare) : [];
  return {
    世界书: isText(value?.世界书) ? value.世界书 : null,
    时间轴末尾: axisEnd,
    方案: isText(value?.方案) ? value.方案 : null,
    排除: strings('排除'),
    分支: Array.isArray(value?.分支)
      ? value.分支.filter(item => isMap(item) && isText(item.事件ID) && isText(item.分支ID))
        .map(item => ({事件ID: item.事件ID, 分支ID: item.分支ID}))
        .sort((left, right) => codepointCompare(left.事件ID, right.事件ID) || codepointCompare(left.分支ID, right.分支ID))
      : [],
    停用角色组: strings('停用角色组'),
  };
}

function confirmedEvents(catalog, state) {
  const eventIDs = new Set(list(catalog?.events).map(event => event.id));
  return new Map(Object.entries(state?.事件 ?? {})
    .filter(([id, record]) => eventIDs.has(id) && record?.状态 === 1)
    .map(([id, record]) => [id, record.分支]));
}

function difference(defaultEvents, ifEvents, side) {
  const ids = side === 'default-only'
    ? [...defaultEvents.keys()].filter(id => !ifEvents.has(id))
    : [...ifEvents.keys()].filter(id => !defaultEvents.has(id));
  return ids.sort(codepointCompare);
}

function branchDifferences(defaultEvents, ifEvents) {
  return [...defaultEvents.keys()].filter(id => ifEvents.has(id) && defaultEvents.get(id) !== ifEvents.get(id))
    .sort(codepointCompare)
    .map(id => ({事件ID: id, 默认分支: defaultEvents.get(id), if分支: ifEvents.get(id)}));
}

function stoppedChains(catalog, protocol, state, confirmed, analysis, decl) {
  const read = protocol.createReadView(state);
  const blocked = blockedEvents(catalog, read.state, read);
  const reachability = blocked.size
    ? analyzeEventTree({...catalog, events: list(catalog?.events).filter(event => !blocked.has(event.id))}, decl)
    : analysis;
  return list(catalog?.chains).slice().sort((left, right) => codepointCompare(left.id, right.id))
    .filter(chain => {
      if (read.chainStatus(chain.id) !== '进行中') return false;
      const structure = chainStructure(catalog, chain, reachability);
      if (!structure.起点.some(id => confirmed.has(id))) return false;
      return !structure.结局可达.some(ending => endingReachable(read.state, ending));
    })
    .map(chain => chain.id);
}

function blockedEvents(catalog, state, read) {
  const blocked = new Set();
  for (const [id, choice] of Object.entries(state?.开局?.历史选择 ?? {})) if (choice === '未发生') blocked.add(id);
  for (const event of list(catalog?.events)) {
    if (list(event?.内容?.核心参与者).some(id => !read.enabled(id))) blocked.add(event.id);
  }
  return blocked;
}

function endingReachable(state, ending) {
  const record = state?.事件?.[ending?.事件ID];
  return record?.状态 !== 1 || !ending.分支ID || record.分支 === ending.分支ID;
}

function impactReport(catalog, index) {
  const edges = index.references.filter(reference => reference.来源类型 === '事件'
    && reference.目标类型 === '事件' && reference.引用种类 === '事件确认' && reference.极性 === '正向'
    && (reference.字段 === '门槛' || reference.字段.startsWith('门槛.')))
    .map(reference => ({来源事件ID: eventIDFromKey(reference.来源对象), 目标事件ID: eventIDFromKey(reference.目标对象),
      字段: reference.字段}))
    .filter(edge => edge.来源事件ID !== null && edge.目标事件ID !== null)
    .sort((left, right) => codepointCompare(left.来源事件ID, right.来源事件ID)
      || codepointCompare(left.目标事件ID, right.目标事件ID) || codepointCompare(left.字段, right.字段));

  return list(catalog?.events).slice().sort((left, right) => codepointCompare(left.id, right.id)).map(event => {
    const downstream = impactOf(catalog, event.id).slice().sort(codepointCompare);
    const closure = new Set([event.id, ...downstream]);
    return {
      事件ID: event.id,
      下游: downstream,
      引用位置: edges.filter(edge => closure.has(edge.来源事件ID)).map(edge => ({...edge})),
    };
  });
}

function eventIDFromKey(key) {
  return isText(key) && key.startsWith('事件:') ? key.slice('事件:'.length) : null;
}

function failure(input, values) {
  return {
    输入: input,
    没发生: [],
    新发生: [],
    分支不同: [],
    停住的事件串: [],
    影响面: [],
    异常: normalizeIssues(values),
  };
}

function errorIssue(error) {
  if (error instanceof WhatIfError) return issue(error.code, '错误', 'if', error.message);
  if (isText(error?.code) && isText(error?.message)) return issue(error.code, '错误', 'if', error.message);
  return issue('if.计算失败', '错误', 'if', error instanceof Error && isText(error.message) ? error.message : 'if 计算失败');
}

function hasErrors(values) { return list(values).some(item => item?.级别 === '错误'); }

function normalizeIssues(values) {
  const map = new Map();
  for (const value of list(values)) {
    if (!isMap(value)) continue;
    const normalized = {
      规则: String(value.规则 ?? 'if.未知异常'),
      级别: String(value.级别 ?? '错误'),
      文件: String(value.文件 ?? ''),
      说明: String(value.说明 ?? ''),
    };
    map.set(JSON.stringify(normalized), normalized);
  }
  return [...map.values()].sort((left, right) => codepointCompare(left.文件, right.文件)
    || codepointCompare(left.规则, right.规则) || codepointCompare(left.级别, right.级别)
    || codepointCompare(left.说明, right.说明));
}
