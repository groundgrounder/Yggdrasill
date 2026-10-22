import {createCalendar} from './calendar.mjs';
import {conditionReferences, evaluateCondition, requiredEventIDs} from './conditions.mjs';
import {isMap, list} from './utils.mjs';

export function analyzeEventTree(catalog, decl = {}) {
  const events = list(catalog?.events);
  const byID = new Map(events.map(event => [event.id, event]));
  const calendar = decl.calendar ? createCalendar(decl.calendar) : null;
  const references = new Map(events.map(event => [event.id, eventReferences(event)]));
  const branchReachable = new Map(events.map(event => [event.id, new Set()]));
  const reachable = new Set();
  const issues = [];
  const add = (rule, eventID, message, level = '错误') => issues.push({规则: rule, 级别: level, 文件: byID.get(eventID)?.文件 ?? `历史/事件/${eventID}/事件.txt`, 说明: message});

  const timePossible = (sourceID, targetID, strict = false) => {
    const source = byID.get(sourceID)?.内容, target = byID.get(targetID)?.内容;
    if (!calendar || !isMap(source?.触发时间) || !isMap(target?.触发时间)) return true;
    const sourceTime = calendar.time(source.触发时间[strict ? '最晚' : '最早']), targetTime = calendar.time(target.触发时间.最晚);
    return !sourceTime || !targetTime || sourceTime[0] <= targetTime[0];
  };
  const leafPossible = (type, value, negative, targetID, available, branchAvailable) => {
    if (type === '事件确认') {
      if (negative) return true;
      const id = value?.事件ID;
      if (!available.has(id) || !timePossible(id, targetID, false)) return false;
      return !value?.分支ID || branchAvailable.get(id)?.has(value.分支ID);
    }
    if (type === '事件串状态') {
      if (negative) return true;
      const chain = list(catalog.chains).find(item => item.id === value?.事件串ID);
      if (!chain) return true;
      const members = list(chain.内容?.事件);
      const starts = members.filter(id => !conditionReferences(byID.get(id)?.内容?.门槛).some(ref => !ref.排斥 && members.includes(ref.事件ID)));
      return starts.some(id => available.has(id));
    }
    return true;
  };
  const possible = (condition, targetID, available = reachable, branches = branchReachable) => {
    if (!condition) return true;
    try { return evaluateCondition(condition, (type, value, negative) => leafPossible(type, value, negative, targetID, available, branches)) === true; }
    catch { return false; }
  };
  const combined = (eventID, branch) => {
    const gate = byID.get(eventID)?.内容?.门槛, branchGate = branch?.门槛;
    if (gate && branchGate) return {all: [gate, branchGate]};
    return gate ?? branchGate ?? null;
  };

  // 反复扩展乐观可达事件与分支。
  for (let changed = true; changed;) {
    changed = false;
    for (const event of events) {
      const content = event.内容;
      if (!isMap(content)) continue;
      if (!reachable.has(event.id) && possible(content.门槛, event.id)) { reachable.add(event.id); changed = true; }
      if (reachable.has(event.id)) {
        for (const branch of list(content.分支)) if (branch?.分支ID && possible(combined(event.id, branch), event.id)) {
          const set = branchReachable.get(event.id);
          if (!set.has(branch.分支ID)) { set.add(branch.分支ID); changed = true; }
        }
      }
    }
  }

  for (const event of events) {
    const content = event.内容;
    if (!isMap(content)) continue;
    if (!possible(content.门槛, event.id)) add('事件树.不可达', event.id, '按乐观假设，事件门槛不可能成立', '提示');
    if (reachable.has(event.id)) for (const branch of list(content.分支)) {
      if (branch?.分支ID && !possible(combined(event.id, branch), event.id)) add('事件树.分支不可达', event.id, `分支“${branch.分支ID}”按乐观假设不可达`, '提示');
    }
    const eventTimeIssue = checkTime(event, content.门槛, false);
    for (const branch of list(content.分支)) {
      if (branch?.门槛) checkTime(event, combined(event.id, branch), true, eventTimeIssue);
    }
  }

  const requiredGraph = new Map(events.map(event => {
    const conditions = [event.内容?.门槛, ...list(event.内容?.分支).map(branch => branch?.门槛)];
    return [event.id, new Set(conditions.flatMap(condition => [...requiredEventIDs(condition)]).filter(id => byID.has(id)))];
  }));
  let serial = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set();
  const visit = id => {
    indices.set(id, serial); low.set(id, serial++); stack.push(id); onStack.add(id);
    for (const next of requiredGraph.get(id) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id), low.get(next))); }
      else if (onStack.has(next)) low.set(id, Math.min(low.get(id), indices.get(next)));
    }
    if (low.get(id) !== indices.get(id)) return;
    const component = [];
    for (let current; current !== id;) { current = stack.pop(); onStack.delete(current); component.push(current); }
    const cyclic = component.length > 1 || requiredGraph.get(id)?.has(id);
    if (cyclic && component.every(item => !reachable.has(item))) {
      add('事件树.前置闭环', component.slice().sort().join('、'), `必需的正向前置成环，且没有可启动入口`);
    }
  };
  for (const event of events) if (!reachable.has(event.id) && !indices.has(event.id)) visit(event.id);

  return {byID, references, reachable, branchReachable, issues,
    timePossible: (sourceID, targetID, strict = false) => timePossible(sourceID, targetID, strict)};

  function checkTime(event, condition, branchSpecific, suppressed = null) {
    if (!condition || !calendar || !isMap(event.内容?.触发时间)) return null;
    const targetTime = calendar.time(event.内容.触发时间.最晚);
    if (!targetTime) return null;
    const rule = !conditionPossibleByTime(condition, event.id, false) ? '事件树.前置超出窗口'
      : !conditionPossibleByTime(condition, event.id, true) ? '事件树.前置倒流' : null;
    if (rule && rule !== suppressed) {
      const message = rule === '事件树.前置超出窗口'
        ? (branchSpecific ? '分支门槛的正向前置全部超出本事件时间窗口' : '正向前置的全部可选路径均超出本事件时间窗口')
        : (branchSpecific ? '分支门槛的正向前置最晚时间晚于本事件' : '正向前置的全部可选路径最晚时间均晚于本事件');
      add(rule, event.id, message);
    }
    return rule;
  }
  function conditionPossibleByTime(condition, targetID, strict) {
    if (!condition) return true;
    try { return evaluateCondition(condition, (type, value, negative) => type !== '事件确认' || negative
      || (byID.has(value?.事件ID) && timePossible(value.事件ID, targetID, strict))); }
    catch { return true; }
  }
}

function eventReferences(event) {
  const content = event?.内容;
  const refs = conditionReferences(content?.门槛);
  for (const branch of list(content?.分支)) refs.push(...conditionReferences(branch?.门槛, false, `分支.${branch?.分支ID ?? '?'}.门槛`));
  return refs;
}

function chainMemberDependsOn(id, chain, byID) {
  const refs = conditionReferences(byID.get(id)?.内容?.门槛).filter(ref => !ref.排斥);
  return refs.some(ref => list(chain.事件).includes(ref.事件ID));
}

export function chainStructure(catalog, chain, analysis = null) {
  const value = typeof chain === 'string' ? list(catalog.chains).find(item => item.id === chain) : chain;
  const members = list(value?.内容?.事件);
  const memberSet = new Set(members);
  const dependencies = new Map(members.map(id => [id, new Set()]));
  for (const id of members) {
    const event = list(catalog.events).find(item => item.id === id);
    const content = event?.内容;
    const conditions = [content?.门槛, ...list(content?.分支).map(branch => branch?.门槛)];
    for (const condition of conditions) for (const ref of conditionReferences(condition)) if (!ref.排斥 && memberSet.has(ref.事件ID)) dependencies.get(id).add(ref.事件ID);
  }
  const starts = members.filter(id => !conditionReferences(list(catalog.events).find(item => item.id === id)?.内容?.门槛).some(ref => !ref.排斥 && memberSet.has(ref.事件ID)));
  const endings = list(value?.内容?.结局).filter(item => isMap(item) && memberSet.has(item.事件ID));
  const reachable = new Set(analysis?.reachable ? members.filter(id => analysis.reachable.has(id)) : members);
  const endingReachable = endings.filter(item => reachable.has(item.事件ID)
    && (!item.分支ID || analysis?.branchReachable?.get(item.事件ID)?.has(item.分支ID) || !analysis));
  const isolated = members.filter(id => {
    const hasDependency = dependencies.get(id)?.size;
    const dependedOn = members.some(other => dependencies.get(other)?.has(id));
    return !hasDependency && !dependedOn && members.length > 1;
  });
  return {成员: members, 依赖: dependencies, 起点: starts, 结局: endings, 结局可达: endingReachable, 孤立成员: isolated};
}

export function impactOf(catalog, eventID) {
  const events = list(catalog?.events);
  const byID = new Map(events.map(event => [event.id, event]));
  if (!byID.has(eventID)) return [];
  const absent = new Set([eventID]);
  for (let changed = true; changed;) {
    changed = false;
    for (const event of events) {
      if (absent.has(event.id) || !isMap(event.内容)) continue;
      if (!event.内容.门槛) continue;
      const result = evaluateCondition(event.内容.门槛, (type, value, negative) => {
        if (type !== '事件确认') return true;
        if (!absent.has(value?.事件ID)) return null;
        return negative ? true : false;
      });
      if (result === false) { absent.add(event.id); changed = true; }
    }
  }
  return [...absent].filter(id => id !== eventID).sort();
}
