import {STORYLINE} from './contract.mjs';
// 门槛保留原始逻辑树；引用表只用于查阅，不能作为扁平依赖表运行。
const union = sets => new Set(sets.flatMap(s => [...s]));
const intersect = sets => sets.length ? new Set([...sets[0]].filter(id => sets.every(s => s.has(id)))) : new Set();

export function evaluateCondition(node, leaf, negative = false) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1)
    throw new Error('条件必须只有一个类型键');
  const [[type, value]] = Object.entries(node);
  if (['all', 'any', 'none'].includes(type)) {
    if (!Array.isArray(value) || !value.length) throw new Error('逻辑组合不能为空');
    const neg = type === 'none' ? !negative : negative;
    const mode = (type === 'all' && !negative) || (type === 'any' && negative) || (type === 'none' && !negative) ? 'all' : 'any';
    const values = value.map(child => evaluateCondition(child, leaf, neg));
    return mode === 'all'
      ? values.includes(false) ? false : values.includes(null) ? null : true
      : values.includes(true) ? true : values.includes(null) ? null : false;
  }
  // leaf 接受极性，历史求解器可只对尚未决定的负向事件引用作乐观估计。
  return leaf(type, value, negative);
}

export function conditionReferences(node, negative = false, path = '门槛') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const [[type, value] = []] = Object.entries(node);
  if (type === '事件确认') return [{...value, 排斥: negative, 条件位置: path}];
  if (!['all', 'any', 'none'].includes(type) || !Array.isArray(value)) return [];
  return value.flatMap((child, i) => conditionReferences(child, type === 'none' ? !negative : negative, `${path}.${type}[${i + 1}]`));
}

export function requiredEventIDs(node, negative = false) {
  if (!node) return new Set();
  const [[type, value]] = Object.entries(node);
  if (type === '事件确认') return new Set(negative ? [] : [value.事件ID]);
  if (!['all', 'any', 'none'].includes(type) || !Array.isArray(value)) return new Set();
  const neg = type === 'none' ? !negative : negative;
  const sets = value.map(child => requiredEventIDs(child, neg));
  const all = (type === 'all' && !negative) || (type === 'any' && negative) || (type === 'none' && !negative);
  return all ? union(sets) : intersect(sets);
}

// 只判定正向前置是否有入口。非事件条件与负向引用作可满足估计，不替代实际门控。
export const prerequisitesPossible = (node, available) => !node || evaluateCondition(node,
  (type, value, negative) => type !== '事件确认' || negative || available(value));

export function analyzeEvents(events, time) {
  const byID = new Map(), issues = [], references = new Map(), successors = new Map();
  const issue = (id, message) => issues.push({事件ID: id, 说明: message});
  for (const e of events) {
    if (byID.has(e.事件ID)) issue(e.事件ID, '事件ID重复');
    byID.set(e.事件ID, e);
    references.set(e.事件ID, conditionReferences(e.门槛));
    successors.set(e.事件ID, []);
  }
  for (const e of events) {
    if (!Array.isArray(e.分支) || !e.分支.length) issue(e.事件ID, '事件缺少分支列表');
    else {
      const ids = e.分支.map(b => b.分支ID);
      if (new Set(ids).size !== ids.length) issue(e.事件ID, '分支ID重复');
      if (!ids.includes(e.默认分支)) issue(e.事件ID, '默认分支不存在');
    }
    for (const ref of references.get(e.事件ID)) {
      const target = byID.get(ref.事件ID);
      if (!target) issue(e.事件ID, '引用未知事件 ' + ref.事件ID);
      else {
        if (ref.分支ID && !target.分支?.some(b => b.分支ID === ref.分支ID)) issue(e.事件ID, '引用未知分支 ' + ref.事件ID + '·' + ref.分支ID);
        successors.get(ref.事件ID).push({...ref, 后续事件ID: e.事件ID});
      }
    }
    if (e.关联事件 !== undefined && !Array.isArray(e.关联事件)) issue(e.事件ID, '关联事件必须为事件ID列表');
    for (const id of Array.isArray(e.关联事件) ? e.关联事件 : []) {
      if (!byID.has(id)) issue(e.事件ID, '关联未知事件 ' + id);
      else successors.get(id).push({后续事件ID: e.事件ID, 普通关联: true});
    }
    const to = time(e.时间范围?.最晚);
    if (to && !prerequisitesPossible(e.门槛, ref => {
      const from = time(byID.get(ref.事件ID)?.时间范围?.最早);
      return !from || from[0] <= to[0];
    })) issue(e.事件ID, '正向前置的全部可选路径均超出本事件时间窗口');
    // 封卷按最晚时间顺序写入默认历史；前置最晚晚于本事件时会倒流解锁。
    else if (to && !prerequisitesPossible(e.门槛, ref => {
      const end = time(byID.get(ref.事件ID)?.时间范围?.最晚);
      return !end || end[0] <= to[0];
    })) issue(e.事件ID, '正向前置的全部可选路径最晚时间均晚于本事件，封卷时会倒流解锁');
  }
  const reachable = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const e of events) if (!reachable.has(e.事件ID) && prerequisitesPossible(e.门槛, ref => reachable.has(ref.事件ID))) {
      reachable.add(e.事件ID); changed = true;
    }
  }
  // Tarjan 仅分析无法从外部入口启动的正向引用，any 的可用出口会先进入 reachable。
  let serial = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set();
  const visit = id => {
    indices.set(id, serial); low.set(id, serial++); stack.push(id); onStack.add(id);
    const refs = references.get(id).filter(r => !r.排斥 && byID.has(r.事件ID) && !reachable.has(r.事件ID));
    for (const r of refs) {
      if (!indices.has(r.事件ID)) { visit(r.事件ID); low.set(id, Math.min(low.get(id), low.get(r.事件ID))); }
      else if (onStack.has(r.事件ID)) low.set(id, Math.min(low.get(id), indices.get(r.事件ID)));
    }
    if (low.get(id) === indices.get(id)) {
      const component = [];
      for (let x; x !== id;) { x = stack.pop(); onStack.delete(x); component.push(x); }
      if (component.length > 1 || refs.some(r => r.事件ID === id))
        issue(component.slice().sort().join('、'), '必需前置闭环，缺少可启动入口');
    }
  };
  for (const id of byID.keys()) if (!reachable.has(id) && !indices.has(id)) visit(id);
  return {byID, references, successors, reachable, issues};
}

export function checkStorylines(storylines, events) {
  const errors = [], ids = new Set(), owners = new Map(), eventIDs = new Set(events.map(e => e.事件ID));
  if (!Array.isArray(storylines)) return ['缺少剧情线列表'];
  // 空项目可以没有剧情线；有事件时由下方主归属检查逐个报告。
  for (const line of storylines) {
    const label = line.剧情线ID || '未命名剧情线';
    for (const key of Object.keys(line)) if (!STORYLINE.fields.includes(key)) errors.push(`${label} 字段非法 ${key}`);
    for (const key of ['剧情线ID', '名称', '概述']) if (typeof line[key] !== 'string' || !line[key].trim()) errors.push(`${label} 缺少${key}`);
    if (/[A-Za-z]/.test(label)) errors.push(`${label} 剧情线ID须用中文短语`);
    if (ids.has(label)) errors.push('重复剧情线ID ' + label);
    ids.add(label);
    for (const key of ['事件', '引用']) {
      if (!Array.isArray(line[key]) || (key === '事件' && !line[key].length)) { errors.push(`${label} ${key}列表非法`); continue; }
      if (new Set(line[key]).size !== line[key].length) errors.push(`${label} ${key}列表重复`);
      for (const id of line[key]) {
        if (!eventIDs.has(id)) errors.push(`${label} 引用未知事件 ${id}`);
        if (key === '事件') {
          if (owners.has(id)) errors.push(`${id} 有多个主归属`);
          owners.set(id, label);
        } else if (line.事件?.includes(id)) errors.push(`${label} 不能重复引用本线主事件 ${id}`);
      }
    }
  }
  for (const id of eventIDs) if (!owners.has(id)) errors.push('事件没有主归属 ' + id);
  return errors;
}
