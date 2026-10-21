// 事件上下文的只读筛选。完整作者树、筛选理由和预算统计不进入叙事正文。
import {evaluateCondition} from './relations.mjs';
import {PLAYER} from './contract.mjs';

export const eventContextDefaults = Object.freeze({historyLimit: 6, historyCharBudget: 3000, candidateLimit: 4, candidateCharBudget: 4000});
export const serializedChars = value => [...JSON.stringify(value)].length;
const arrayChars = items => items.length ? serializedChars(items) : 0;
const byID = (a, b) => a.id.localeCompare(b.id, 'zh');
const copy = value => JSON.parse(JSON.stringify(value));

// 不截断结构化条目。历史可整体退为摘要，候选必须保留全部分支和变化。
function fit(rows, limit, budget, compact = false) {
  const items = [], selected = [], omitted = [];
  for (const row of rows) {
    if (items.length >= limit) { omitted.push({事件ID: row.id, 原因: '数量预算'}); continue; }
    let item = row.item, detail = '完整';
    if (arrayChars([...items, item]) > budget && compact && item.角色位置?.length) {
      item = {...item, 角色位置: []}; detail = '摘要';
    }
    if (arrayChars([...items, item]) > budget) { omitted.push({事件ID: row.id, 原因: '字符预算'}); continue; }
    items.push(item);
    selected.push({事件ID: row.id, 依据: row.reasons, 正文: detail, 字符数: serializedChars(item)});
  }
  return {items: copy(items), audit: {数量上限: limit, 字符预算: budget, 字符数: arrayChars(items), 选入: selected, 略过: omitted}};
}

// 仅沿已经成立的逻辑路径取正向、分支匹配的存储事实；失败的 any 路径不会带入局部命中的叶子。
function supportingHistory(gate, protocol, stat, facts) {
  const truth = (node, negative) => evaluateCondition(node, (type, value, neg) => {
    const result = protocol.conditionWithFacts({[type]: value}, stat, facts);
    return result === null ? null : neg ? !result : result;
  }, negative);
  const visit = (node, negative = false) => {
    if (!node || truth(node, negative) !== true) return [];
    const [[type, value]] = Object.entries(node);
    if (type === '事件确认') return !negative && stat?.事件?.[value.事件ID]?.状态 === 1 ? [value.事件ID] : [];
    if (!['all', 'any', 'none'].includes(type)) return [];
    return value.flatMap(child => visit(child, type === 'none' ? !negative : negative));
  };
  return visit(gate);
}

// time 和 stripPosition 由运行协议提供，避免模块反向导入协议或复制日期、正文契约。
export function selectEventContext(protocol, stat, {
  present = [], requestedEvents = [], ...options
} = {}, {time, stripPosition}) {
  const fallback = protocol.dialect?.context || eventContextDefaults;
  const limits = Object.fromEntries(Object.keys(eventContextDefaults).map(k => [k, fallback[k] ?? eventContextDefaults[k]]));
  for (const key of Object.keys(limits)) if (options[key] !== undefined) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw new RangeError(`${key} 必须为非负安全整数`);
    limits[key] = options[key];
  }
  const enabled = id => id === PLAYER ? stat?.开局?.玩家?.模式 === '自建' : stat?.开局?.角色组?.[id]?.启用 === true;
  const here = new Set(present.filter(enabled));
  if (enabled(PLAYER)) here.add(PLAYER);
  const placeIDs = new Set(protocol.locationChain(stat?.世界?.当前地点?.地标).map(l => l.地点ID));
  const local = e => (Array.isArray(e?.地点或范围) ? e.地点或范围 : [e?.地点或范围]).some(id => placeIDs.has(id));
  const participants = (e, record) => [...new Set([...(e?.核心参与者 || []), ...(record?.实际参与者 || [])])];
  const shared = ids => ids.filter(id => here.has(id)).length;
  const requested = new Map([...new Set(requestedEvents)].map((id, index) => [id, index]));
  const pending = [], histories = [], candidates = [], rejected = [];
  for (const e of protocol.events.values()) {
    const status = protocol.eventStatus(e.事件ID, stat), record = stat?.事件?.[e.事件ID];
    const ids = participants(e, record);
    if (status.状态 === '待登记') {
      pending.push({事件ID: e.事件ID, 事件概要: e.事件概要, 分支: status.分支, 变化: e.分支.find(b => b.分支ID === status.分支)?.变化 || []});
    } else if (status.状态 === '候选' && (shared(e.核心参与者 || []) || local(e) || !e.核心参与者?.length)) {
      candidates.push({id: e.事件ID, local: local(e), shared: shared(e.核心参与者 || []), at: time(e.时间范围.最早)[0],
        reasons: [local(e) ? '当前地点' : '在场关联或公共候选'],
        item: {事件ID: e.事件ID, 事件概要: e.事件概要, 叙事条件: e.叙事条件 || [],
          分支: e.分支.map(b => ({分支ID: b.分支ID, 分支条件: b.分支条件, 变化: b.变化 || []}))}});
    } else if (status.状态 === '已确认') {
      if (!ids.every(enabled)) { rejected.push({事件ID: e.事件ID, 原因: '角色未启用'}); continue; }
      const branch = e.分支.find(b => b.分支ID === status.分支);
      const positions = [...here].map(id => e.角色位置?.[id])
        .filter(pos => pos && (!pos.适用分支 || pos.适用分支.includes(status.分支))).map(stripPosition);
      histories.push({id: e.事件ID, local: local(e), shared: shared(ids), at: time(record.实际时间)?.[0] ?? -Infinity,
        item: {事件ID: e.事件ID, 事件概要: e.事件概要, 分支结果: branch?.分支结果, 实际时间: record.实际时间, 角色位置: positions}});
    }
  }
  for (const [id, record] of Object.entries(stat?.事件 || {})) {
    if (protocol.events.has(id) || record.状态 !== 1) continue;
    const ids = participants(null, record);
    if (!ids.every(enabled)) { rejected.push({事件ID: id, 原因: '角色未启用'}); continue; }
    histories.push({id, local: false, shared: shared(ids), at: time(record.实际时间)?.[0] ?? -Infinity,
      item: {事件ID: id, 事件概要: record.摘要, 实际时间: record.实际时间, 角色位置: []}});
  }

  candidates.sort((a, b) => Number(b.local) - Number(a.local) || b.shared - a.shared || a.at - b.at || byID(a, b));
  const candidateSelection = fit(candidates, limits.candidateLimit, limits.candidateCharBudget);
  const facts = candidateSelection.items.length ? protocol.automaticFacts(stat) : new Map();
  const supports = new Set(candidateSelection.items.flatMap(item => supportingHistory(protocol.events.get(item.事件ID).门槛, protocol, stat, facts)));
  const relevant = [];
  for (const row of histories) {
    row.reasons = [requested.has(row.id) && '点名回忆', supports.has(row.id) && '候选直接前置', row.local && '当前地点',
      row.shared >= 2 ? '共同经历' : row.shared && '在场角色经历'].filter(Boolean);
    if (!row.reasons.length) { rejected.push({事件ID: row.id, 原因: '无当前关联'}); continue; }
    row.priority = requested.has(row.id) ? 0 : supports.has(row.id) ? 1 : row.local ? 2 : row.shared >= 2 ? 3 : 4;
    relevant.push(row);
  }
  relevant.sort((a, b) => a.priority - b.priority || (a.priority === 0 ? requested.get(a.id) - requested.get(b.id) : 0)
    || b.shared - a.shared || b.at - a.at || byID(a, b));
  const historySelection = fit(relevant, limits.historyLimit, limits.historyCharBudget, true);
  historySelection.audit.略过.push(...rejected.sort((a, b) => a.事件ID.localeCompare(b.事件ID, 'zh')));
  historySelection.audit.已确认总数 = histories.length + rejected.filter(r => r.原因 === '角色未启用').length;
  const unconfirmedRequests = [...requested.keys()].filter(id => stat?.事件?.[id]?.状态 !== 1).map(id => ({事件ID: id, 原因: '未确认或不存在'}));
  return {
    context: {已确认事件: historySelection.items, 待登记事件: copy(pending), 候选事件: candidateSelection.items},
    audit: {已确认事件: historySelection.audit, 候选事件: candidateSelection.audit, 点名未确认: unconfirmedRequests,
      待登记事件: {数量: pending.length, 字符数: arrayChars(pending), 预算外: true}},
  };
}
