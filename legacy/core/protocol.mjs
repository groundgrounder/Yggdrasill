// 世界树运行协议参考实现。路由每轮只读调用；seal 由封卷前端调用一次。
// 条件为三值逻辑：true 成立，false 不成立，null 未知；未知不能经 none 取反成立。
// 纪年、等级、数值范围等作品取值来自方言：createProtocol(catalog, dialect)。
import {evaluateCondition, conditionReferences, analyzeEvents} from './relations.mjs';
import {selectEventContext} from './context.mjs';
import {growthIssues, traitsIssues, abilityChangeIssues} from './growth.mjs';
import {PLAYER, DEBUT_PREFIX, DEBUT_BRANCH, DYNAMIC_BRANCH, MACHINE_FIELDS, INITIALIZATION_MODES, PLAYER_MODES, ABILITY} from './contract.mjs';
import {requireDialect} from './dialect.mjs';
export {PLAYER} from './contract.mjs';
export const strip = new Set(MACHINE_FIELDS);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

export function eventRange(e, dialect) {
  const {time} = requireDialect(dialect, '事件时间范围');
  const from = time(e?.时间范围?.最早), to = time(e?.时间范围?.最晚);
  if (!from || !to || from[0] > to[0]) throw new Error('事件时间范围非法，须先核定：' + e?.事件ID);
  return [from, to];
}

function clearAbilityRemoval(run, field) {
  if (!own(run, '能力移除记录')) return;
  run.能力移除记录 = run.能力移除记录.filter(p => p !== field);
  if (!run.能力移除记录.length) delete run.能力移除记录;
}

// 场景条件由静态检查与运行求值共用参数校验。
export function sceneGateIssues(type, a, {groups, locations, dialect} = {}) {
  if (!['当前场景', '在场实力人数', '角色已出场'].includes(type)) return [];
  const {rank, ranks} = type === '在场实力人数' ? requireDialect(dialect, '在场实力人数') : {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return [type + '参数须为对象'];
  const issues = [], nonempty = v => typeof v === 'string' && !!v.trim();
  const fields = type === '当前场景' ? ['地标', '场景'] : type === '角色已出场' ? ['角色组ID'] : ['最低实力', '最少人数', '排除角色组'];
  for (const k of Object.keys(a)) if (!fields.includes(k)) issues.push(type + '字段非法 ' + k);
  if (type === '当前场景') {
    if (!nonempty(a.地标) || !locations?.has(a.地标)) issues.push('当前场景引用未知地点 ' + a.地标);
    if (!nonempty(a.场景)) issues.push('当前场景须有精确场景名');
  } else if (type === '角色已出场') {
    if (!groups?.has(a.角色组ID)) issues.push('角色已出场引用未知角色组 ' + a.角色组ID);
  } else {
    if (!rank(a.最低实力)) issues.push('最低实力须为等级之一：' + ranks.join('、'));
    if (!Number.isSafeInteger(a.最少人数) || a.最少人数 <= 0) issues.push('最少人数须为正安全整数');
    if (a.排除角色组 !== undefined) {
      if (!Array.isArray(a.排除角色组)) issues.push('排除角色组须为数组');
      else {
        if (new Set(a.排除角色组).size !== a.排除角色组.length) issues.push('排除角色组不得重复');
        for (const id of a.排除角色组) if (id !== PLAYER && !groups?.has(id)) issues.push('排除角色组引用未知角色组 ' + id);
      }
    }
  }
  return issues;
}

export function createProtocol(catalog, dialect = catalog?.dialect) {
  requireDialect(dialect, 'createProtocol');
  const {time, rank, rankValue, higher} = dialect;
  const range = e => eventRange(e, dialect);
  const events = new Map(catalog.events.map(e => [e.事件ID, e]));
  const skills = new Map((catalog.skills || []).map(s => [s.技能ID, s]));
  const locations = new Map((catalog.locations || []).map(l => [l.地点ID, l]));
  const equipment = new Map((catalog.equipment || []).map(e => [e.装备ID, e]));
  const systems = new Set(catalog.systems || [...skills.values()].map(s => s.体系));
  // 从当前地点沿父级链上溯到大陆。
  function locationChain(id) {
    const out = [];
    for (let l = locations.get(id), guard = 0; l; l = locations.get(l.父级), guard++) {
      if (guard > 16) throw new Error('地点父级成环 ' + id);
      out.push(l);
    }
    return out;
  }
  const groups = new Map(catalog.groups.map(g => [g.角色组ID, g]));
  for (const g of groups.values()) if (g.初始成长登记 !== undefined && !INITIALIZATION_MODES.includes(g.初始成长登记))
    throw new Error('初始成长登记方式非法 ' + g.角色组ID);
  const opening = stat => stat?.开局?.角色组 || {};
  const enabled = (stat, id) => opening(stat)[id]?.启用 === true;
  let structureChecked = false;
  function assertEventStructure() {
    if (structureChecked) return;
    const {issues} = analyzeEvents(catalog.events, time);
    if (issues.length) throw new Error('事件关系配置错误：' + issues.map(i => `${i.事件ID}：${i.说明}`).join('；'));
    structureChecked = true;
  }

  function atom(type, a, stat) {
    const issues = sceneGateIssues(type, a, {groups, locations, dialect});
    if (issues.length) throw new Error('场景条件配置错误：' + issues.join('；'));
    if (type === '当前场景') {
      const place = stat?.世界?.当前地点;
      if (!place?.地标 || !place?.场景) return null;
      return place.地标 === a.地标 && place.场景 === a.场景;
    }
    if (type === '角色已出场') {
      const id = a.角色组ID, run = stat?.角色?.[id];
      if (run?.在场 === true || run?.成长已初始化 === true || Object.values(stat?.事件 || {}).some(r =>
        r?.状态 === 1 && Array.isArray(r.实际参与者) && r.实际参与者.includes(id))) return true;
      if (stat?.事件?.[DEBUT_PREFIX + id]?.状态 === 1) return true;
      return stat?.开局?.已封卷 && stat.事件 && typeof stat.事件 === 'object' && !Array.isArray(stat.事件) ? false : null;
    }
    if (type === '在场实力人数') {
      if (!stat?.开局?.已封卷) return null;
      const excluded = new Set(a.排除角色组 || []);
      const ids = [...groups.keys()].filter(id => enabled(stat, id));
      if (stat.开局.玩家?.模式 === '自建') ids.push(PLAYER);
      let count = 0, unknown = false;
      for (const id of new Set(ids)) {
        const run = stat?.角色?.[id];
        if (excluded.has(id) || run?.在场 !== true) continue;
        if (own(run, '实力定位') && !rank(run.实力定位)) throw new Error('本局实力定位非法 ' + id);
        const level = rankValue(run.实力定位);
        if (level < 1) unknown = true;
        else if (level >= rankValue(a.最低实力)) count++;
      }
      return count >= a.最少人数 ? true : unknown ? null : false;
    }
    if (type === '角色启用') return stat?.开局?.已封卷 ? enabled(stat, a.角色组ID) : null;
    if (type === '角色版本') return stat?.开局?.已封卷 ? enabled(stat, a.角色组ID) && opening(stat)[a.角色组ID].版本ID === a.版本ID : null;
    if (type === '当前时间') {
      const now = time(stat?.世界?.当前时间), at = time(a.值);
      if (!now || !at) return null;
      if (a.比较 === '小于') return now[1] <= at[0];
      if (a.比较 === '大于等于') return now[0] >= at[0];
      throw new Error('未登记时间比较 ' + a.比较);
    }
    if (type === '剧情标记') {
      const v = stat?.世界?.剧情标记?.[a.标记ID];
      if (v === undefined || v === null || v === '') return null;
      if (a.比较 === '等于') return v === a.值;
      if (a.比较 === '不等于') return v !== a.值;
      throw new Error('未登记标记比较 ' + a.比较);
    }
    throw new Error('未登记条件类型 ' + type);
  }

  function conditionWithFacts(node, stat, facts = new Map(), {optimistic = new Set(), context = stat} = {}) {
    return evaluateCondition(node, (type, a, negative) => {
      if (type === '事件确认' && negative && optimistic.has(a.事件ID)) return true;
      let result;
      if (type === '事件确认') {
        const record = stat?.事件?.[a.事件ID];
        const stored = record?.状态 === 1 || record?.状态 === 2;
        const branch = stored ? record.分支 : facts.get(a.事件ID)?.分支;
        result = (stored ? record.状态 === 1 : facts.has(a.事件ID)) && (!a.分支ID || branch === a.分支ID);
      } else result = atom(type, a, context);
      return result === null ? null : negative ? !result : result;
    });
  }

  // 只检查新事实使原本成立的排斥失效；不把组合 none 拆成两两互斥。
  function exclusionConflicts(before, after, beforeFacts = new Map(), afterFacts = new Map()) {
    const conflicts = [];
    for (const e of events.values()) {
      if (before.事件?.[e.事件ID]?.状态 !== 1 && !beforeFacts.has(e.事件ID)) continue;
      if (!conditionReferences(e.门槛).some(r => r.排斥)) continue;
      const context = clone(before), at = before.事件?.[e.事件ID]?.实际时间;
      if (time(at)) (context.世界 ??= {}).当前时间 = at;
      if (conditionWithFacts(e.门槛, before, beforeFacts, {context}) === true &&
          conditionWithFacts(e.门槛, after, afterFacts, {context}) !== true) conflicts.push(e.事件ID);
    }
    return conflicts;
  }

  // 先求正向可达的默认事实，再同时检验排斥。冲突不能按遍历顺序选赢家。
  function resolveHistory(stat, eligible, apply = false) {
    assertEventStructure();
    const optimistic = new Set(eligible.map(e => e.事件ID)), facts = new Map(), contexts = new Map();
    const preview = apply ? clone(stat) : stat;
    const sorted = [...eligible].sort((a, b) => time(a.时间范围.最晚)[0] - time(b.时间范围.最晚)[0] || a.事件ID.localeCompare(b.事件ID, 'zh'));
    let lastAt = -Infinity;
    for (let changed = true; changed;) {
      changed = false;
      for (const e of sorted) {
        if (facts.has(e.事件ID) || [1, 2].includes(stat.事件?.[e.事件ID]?.状态) || (e.核心参与者 || []).some(id => !enabled(preview, id))) continue;
        const context = clone(preview);
        if (apply) context.世界.当前时间 = e.时间范围.最晚;
        if (e.门槛 && conditionWithFacts(e.门槛, preview, facts, {optimistic, context}) !== true) continue;
        const at = range(e)[1][0];
        if (apply && at < lastAt) throw new Error('事件默认历史时间顺序冲突：较晚事实或变化倒流解锁 ' + e.事件ID);
        contexts.set(e.事件ID, context);
        facts.set(e.事件ID, {分支: e.默认分支});
        if (apply) writeConfirmation(api, preview, e, e.事件ID, e.默认分支, e.时间范围.最晚);
        lastAt = at;
        changed = true;
        // 每次重新从最早事件选取，避免同年跨轮解锁后被更晚事件抢先写入。
        break;
      }
    }
    const conflicts = eligible.filter(e => facts.has(e.事件ID) && e.门槛 && conditionWithFacts(e.门槛, preview, facts, {context: contexts.get(e.事件ID)}) !== true);
    if (conflicts.length) throw new Error('事件默认历史配置冲突：' + conflicts.map(e => e.事件ID).sort().join('、'));
    const excluded = exclusionConflicts(stat, preview, new Map(), facts);
    if (excluded.length) throw new Error('事件默认历史配置冲突：新事实违反既有事件排斥 ' + excluded.sort().join('、'));
    return {facts, preview};
  }

  function automaticFacts(stat) {
    const now = time(stat?.世界?.当前时间);
    if (!stat?.开局?.已封卷 || !now) return new Map();
    const eligible = [...events.values()].filter(e => {
      if (e.确认策略 !== '自动确认' || [1, 2].includes(stat?.事件?.[e.事件ID]?.状态)) return false;
      const [, to] = range(e);
      return now[0] >= to[1];
    });
    return resolveHistory(stat, eligible).facts;
  }

  function condition(node, stat) {
    return conditionWithFacts(node, stat, automaticFacts(stat));
  }

  // 有效状态：已确认 / 已排除 / 待登记 / 候选 / 不适用 / 未到。只读计算，不写回。
  function eventStatus(id, stat) {
    const stored = stat?.事件?.[id];
    if (stored?.状态 === 1) return {状态: '已确认', 分支: stored.分支};
    if (stored?.状态 === 2) return {状态: '已排除'};
    const e = events.get(id);
    if (!e) return {状态: '未到'};
    if (!stat?.开局?.已封卷) return {状态: '未到'};
    if ((e.核心参与者 || []).some(g => !enabled(stat, g))) return {状态: '已排除'};
    const now = time(stat?.世界?.当前时间), [from, to] = range(e);
    if (!now) return {状态: '未到'};
    if (now[1] <= from[0]) return {状态: '未到'};
    const gate = e.门槛 ? condition(e.门槛, stat) : true;
    if (now[0] >= to[1]) {
      if (e.确认策略 === '自动确认' && gate === true) return {状态: '待登记', 分支: e.默认分支};
      return {状态: '已排除'};
    }
    return gate === true ? {状态: '候选'} : {状态: '不适用'};
  }

  function resolveProfile(groupID, stat) {
    const g = groups.get(groupID);
    if (!g) throw new Error('未登记角色组 ' + groupID);
    if (!enabled(stat, groupID)) return {状态: '未启用'};
    const version = opening(stat)[groupID].版本ID;
    const applies = p => p.版本ID === version || (Array.isArray(p.适用版本) && p.适用版本.includes(version));
    const list = g.档案.filter(applies);
    const byID = new Map(list.map(p => [p.档案ID, p]));
    const ancestors = p => {
      const out = [];
      for (let q = p, guard = 0; q?.前置档案; guard++) {
        if (guard > list.length) throw new Error('前置档案成环 ' + p.档案ID);
        q = byID.get(q.前置档案);
        if (!q) throw new Error('前置档案不在当前适用版本范围 ' + p.档案ID);
        out.push(q.档案ID);
      }
      return out;
    };
    const matched = list.filter(p => p.默认 ? true : condition(p.生效条件, stat) === true);
    const heads = matched.filter(p => !matched.some(q => q !== p && ancestors(q).includes(p.档案ID)));
    if (heads.length === 1) return {状态: '成立', 档案ID: heads[0].档案ID};
    if (heads.length > 1) return {状态: '冲突', 候选: heads.map(p => p.档案ID)};
    return {状态: '异常', 原因: '没有成立的档案，也没有默认档案'};
  }

  // 自建玩家使用保留ID“玩家”：没有时期档案，全部能力来自本局运行值。
  function profileFiles(groupID, profileID) {
    return groupID === PLAYER ? {} : groups.get(groupID).files[profileID] || {};
  }

  function effectiveAbility(groupID, profileID, stat) {
    const run = stat?.角色?.[groupID] || {};
    if (own(run, '实力定位') && !rank(run.实力定位)) throw new Error('本局实力定位非法 ' + groupID);
    if (own(run, '修习阶段') && (!run.修习阶段 || typeof run.修习阶段 !== 'object' || Array.isArray(run.修习阶段) ||
        Object.entries(run.修习阶段).some(([s, v]) => !rank(v) || systems.size && !systems.has(s)))) throw new Error('本局修习阶段非法 ' + groupID);
    return {...(own(run, '实力定位') ? {实力定位: run.实力定位} : {}), 修习阶段: clone(run.修习阶段 || {}),
      固有技能: clone(run.固有技能 || []), 施法方式: clone(run.施法方式 || [])};
  }

  function abilityTraits(groupID, profileID, stat) {
    const traits = profileFiles(groupID, profileID).基本信息?.能力特征;
    const issues = traitsIssues(traits, {skills});
    if (issues.length) throw new Error('能力特征配置错误：' + issues.join('；'));
    const usable = new Set(availableSkills(groupID, profileID, stat));
    return {特征: clone(traits.特征), 技能补充: clone(traits.技能补充.filter(s => usable.has(s.技能ID)))};
  }

  function growthNode(groupID, nodeID, stat) {
    if (!stat?.开局?.已封卷 || !enabled(stat, groupID)) throw new Error('成长角色未启用或未封卷 ' + groupID);
    const g = groups.get(groupID), issues = growthIssues(g?.growth, g, {skills, equipment, systems: systems.size ? systems : undefined, dialect});
    if (issues.length) throw new Error('成长树配置错误：' + issues.join('；'));
    const n = g?.growth?.节点.find(n => n.节点ID === nodeID);
    if (!n) throw new Error('成长节点不存在 ' + groupID + ' / ' + nodeID);
    if (n.核定状态 !== '已核定' || n.运行效果 !== '激活') throw new Error('成长节点尚不可激活 ' + nodeID);
    const version = opening(stat)[groupID].版本ID;
    if (!g.版本.some(v => v.版本ID === version) || (n.适用版本.length && !n.适用版本.includes(version))) throw new Error('成长节点版本不适用 ' + nodeID);
    return n;
  }

  function activeGrowth(groupID, stat) {
    const ids = stat?.角色?.[groupID]?.成长节点已激活 || [];
    if (!Array.isArray(ids)) throw new Error('成长激活记录必须是数组 ' + groupID);
    return [...new Set(ids)].map(id => growthNode(groupID, id, stat));
  }

  function activateGrowth(groupID, ids, stat, {initialize = false} = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('成长激活须提供非空节点列表');
    const nodes = ids.map(id => growthNode(groupID, id, stat));
    const run = (stat.角色 ??= {})[groupID] ??= {};
    effectiveAbility(groupID, null, stat);
    const active = new Set(activeGrowth(groupID, stat).map(n => n.节点ID));
    const baseline = {};
    for (const n of nodes) {
      if (active.has(n.节点ID)) continue;
      const ab = n.能力效果;
      // 成长效果只执行一次；初始化先汇集起点，再以本局已记载字段为准。
      const target = initialize ? baseline : run;
      for (const [system, value] of Object.entries(ab.修习阶段 || {})) {
        const stages = target.修习阶段 ??= {};
        stages[system] = higher(stages[system], value);
        if (!initialize) clearAbilityRemoval(run, '修习阶段.' + system);
      }
      if (ab.实力定位) {
        target.实力定位 = higher(target.实力定位, ab.实力定位);
        if (!initialize) clearAbilityRemoval(run, '实力定位');
      }
      for (const [effect, field] of [['固有技能新增', '固有技能'], ['施法方式新增', '施法方式']])
        if (ab[effect]) target[field] = [...new Set([...(target[field] || []), ...ab[effect]])];
      for (const e of n.取得效果?.装备新增 || []) {
        const held = run.装备 ??= {};
        if (!own(held, e.装备ID)) held[e.装备ID] = {状态: e.状态, 位置: e.位置};
      }
      active.add(n.节点ID);
    }
    if (initialize) {
      const removed = new Set(run.能力移除记录 || []);
      for (const [system, value] of Object.entries(baseline.修习阶段 || {})) {
        if (removed.has('修习阶段.' + system)) continue;
        const stages = run.修习阶段 ??= {};
        if (!own(stages, system)) stages[system] = value;
      }
      for (const field of ['实力定位', '固有技能', '施法方式']) if (!removed.has(field) && !own(run, field) && own(baseline, field)) run[field] = baseline[field];
    }
    run.成长节点已激活 = [...active];
  }

  function initialGrowth(groupID, profileID, stat) {
    if (!enabled(stat, groupID)) throw new Error('初始化角色未启用 ' + groupID);
    if (stat?.角色?.[groupID]?.成长已初始化) return null;
    const current = resolveProfile(groupID, stat);
    if (current.状态 !== '成立' || current.档案ID !== profileID) throw new Error('初始化须使用当前成立档案 ' + groupID);
    const profile = groups.get(groupID).档案.find(p => p.档案ID === profileID), ids = profile.初始成长 || [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('初始成长须为无重复节点列表 ' + groupID);
    const nodes = ids.map(id => growthNode(groupID, id, stat));
    const active = new Set(activeGrowth(groupID, stat).map(n => n.节点ID)), pending = nodes.filter(n => !active.has(n.节点ID));
    const 装备 = {};
    for (const n of pending) for (const e of n.取得效果?.装备新增 || [])
      if (!own(stat?.角色?.[groupID]?.装备, e.装备ID) && !own(装备, e.装备ID)) 装备[e.装备ID] = {状态: e.状态, 位置: e.位置};
    const preview = clone(stat);
    if (pending.length) activateGrowth(groupID, pending.map(n => n.节点ID), preview, {initialize: true});
    return {节点: pending.map(n => n.节点ID), 能力: effectiveAbility(groupID, profileID, preview), 装备};
  }

  // 可用技能：一般技能按体系的有效修习阶段 ≥ 技能等级匹配；固有技能只按有效固有技能集合匹配，不受修习阶段影响。
  function availableSkills(groupID, profileID, stat) {
    const ability = effectiveAbility(groupID, profileID, stat), owned = new Set(ability.固有技能);
    for (const s of skills.values()) if (!rank(s.技能等级)) throw new Error('技能等级非法 ' + s.技能ID);
    return [...skills.values()].filter(s => s.来源 === '一般'
      ? rankValue(ability.修习阶段[s.体系]) > 0 && rankValue(ability.修习阶段[s.体系]) >= rankValue(s.技能等级)
      : owned.has(s.技能ID)).map(s => s.技能ID);
  }

  const api = {dialect, time, eventRange: range, condition, conditionWithFacts, automaticFacts, resolveHistory, exclusionConflicts, assertEventStructure, eventStatus, resolveProfile, effectiveAbility, availableSkills, initialGrowth, activeGrowth, activateGrowth, growthNode, profileFiles, abilityTraits, locationChain, events, groups, skills, locations, equipment, systems};
  return api;
}

// 按变化表写入；事件记录已存在时不再写入（幂等）。供封卷与测试模拟叙事模型写入。
export function applyChanges(stat, changes, protocol) {
  const draft = clone(stat), ranges = protocol?.dialect?.ranges || {};
  for (const c of changes || []) {
    if (!c || typeof c.路径 !== 'string') throw new Error('变化路径非法');
    const keys = c.路径.split('.');
    if (keys.some(k => !k || ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('变化路径非法');
    if (keys[0] === '角色' && protocol && keys[1] !== PLAYER && !draft.开局?.角色组?.[keys[1]]?.启用) throw new Error('变化角色未启用 ' + keys[1]);
    const abilityIssues = abilityChangeIssues(c, protocol || {});
    if (abilityIssues.length) throw new Error(abilityIssues.join('；'));
    if (keys[0] === '角色' && ['修习阶段', '实力定位'].includes(keys[2])) {
      const run = (draft.角色 ??= {})[keys[1]] ??= {}, field = keys.slice(2).join('.');
      const node = keys[2] === '修习阶段' ? (run.修习阶段 ??= {}) : run;
      if (c.操作 === '移除') {
        delete node[keys.at(-1)];
        run.能力移除记录 = [...new Set([...(run.能力移除记录 || []), field])];
      } else {
        node[keys.at(-1)] = c.值;
        clearAbilityRemoval(run, field);
      }
      continue;
    }
    if (keys[0] === '角色' && keys.length < 3) throw new Error('不得整体覆盖角色及成长激活记录');
    if (keys[0] === '角色' && keys[2] === '成长节点已激活') {
      if (!protocol || keys.length !== 3 || c.操作 !== '新增') throw new Error('成长节点只允许通过协议新增，不能移除或覆写');
      protocol.activateGrowth(keys[1], Array.isArray(c.值) ? c.值 : [c.值], draft);
      continue;
    }
    let node = draft;
    for (const k of keys.slice(0, -1)) node = node[k] ??= {};
    const last = keys.at(-1), current = node[last];
    if (c.操作 === '设定') node[last] = clone(c.值);
    else if (c.操作 === '增加' || c.操作 === '减少') {
      const delta = Number(c.值);
      if (!Number.isFinite(delta)) throw new Error('增减值须为数字 ' + c.路径);
      const range = ranges[keys.at(-2)], next = (Number(current) || 0) + (c.操作 === '增加' ? delta : -delta);
      node[last] = range ? Math.min(range[1], Math.max(range[0], next)) : next;
    }
    else if (c.操作 === '新增') node[last] = [...new Set([...(current || []), c.值])];
    else if (c.操作 === '移除') {
      if (Array.isArray(current) || (keys[0] === '角色' && ['固有技能', '施法方式'].includes(keys[2]))) node[last] = (current || []).filter(v => v !== c.值);
      else if (current && typeof current === 'object') delete current[c.值];
    } else throw new Error('未登记变化操作 ' + c.操作);
  }
  Object.assign(stat, draft);
}

function writeConfirmation(protocol, stat, e, id, branchID, at, participants) {
  (stat.事件 ??= {})[id] = {状态: 1, 分支: branchID, 实际时间: at, 实际参与者: [...new Set([...(e?.核心参与者 || []), ...(participants || [])])]};
  applyChanges(stat, e?.分支.find(b => b.分支ID === branchID)?.变化, protocol);
}

export function confirmEvent(protocol, stat, id, branchID, at, participants, dynamic) {
  if ([1, 2].includes(stat?.事件?.[id]?.状态)) return false;
  if (!stat?.开局?.已封卷) throw new Error('确认事件前必须封卷');
  const {time} = protocol, actual = time(at), now = time(stat?.世界?.当前时间);
  if (!actual || !now) throw new Error('事件实际时间或当前时间非法');
  if (dynamic && protocol.events.has(id)) throw new Error('动态事件ID与预设事件冲突 ' + id);
  const e = protocol.events.get(id), status = e && protocol.eventStatus(id, stat);
  const pending = status?.状态 === '待登记';
  if (pending ? branchID !== e.默认分支 || at !== e.时间范围.最晚 : actual[0] >= now[1] || actual[1] <= now[0])
    throw new Error('事件实际时间须为当前时间；待登记事实须使用默认分支和最晚时间');
  if (e) {
    const [from, to] = protocol.eventRange(e);
    if (!e.分支.some(b => b.分支ID === branchID)) throw new Error('未登记分支 ' + id + ' ' + branchID);
    if (actual[0] < from[0] || actual[1] > to[1]) throw new Error('事件实际时间超出窗口 ' + id);
    if (!['候选', '待登记'].includes(status.状态)) throw new Error('事件门槛、版本或参与者不成立 ' + id);
  }
  for (const participant of participants || []) if (participant !== PLAYER && !stat.开局.角色组?.[participant]?.启用)
    throw new Error('事件参与者未启用 ' + participant);
  const draft = clone(stat);
  writeConfirmation(protocol, draft, e, id, branchID, at, participants);
  if (dynamic) {
    applyChanges(draft, dynamic.变化, protocol);
    draft.事件[id].摘要 = dynamic.摘要;
  }
  // 出场事实与初始能力在同一草稿内提交；只读组装不会触发，初始化事件也不递归触发自身。
  for (const [groupID, group] of protocol.groups) {
    if (group.初始成长登记 !== '出场自动' || id === DEBUT_PREFIX + groupID || draft.角色?.[groupID]?.成长已初始化) continue;
    const appeared = draft.事件[id].实际参与者.includes(groupID)
      || (stat.角色?.[groupID]?.在场 !== true && draft.角色?.[groupID]?.在场 === true);
    if (appeared) confirmInitialGrowth(protocol, draft, groupID);
  }
  const beforeFacts = protocol.automaticFacts(stat), afterFacts = protocol.automaticFacts(draft);
  const conflicts = protocol.exclusionConflicts(stat, draft, beforeFacts, afterFacts);
  if (conflicts.length) throw new Error('事件排斥冲突：' + conflicts.join('、') + ' / ' + id);
  Object.assign(stat, draft);
  return true;
}

// 自定义学习、能力丧失/恢复和离场成长均可用汇总事件原子登记，不要求静态成长节点。
export function confirmDynamicEvent(protocol, stat, {事件ID, 分支 = DYNAMIC_BRANCH, 实际时间 = stat?.世界?.当前时间, 实际参与者 = [], 摘要, 变化 = []}) {
  if (typeof 事件ID !== 'string' || !事件ID.trim() || typeof 摘要 !== 'string' || !摘要.trim() || !Array.isArray(变化)) throw new Error('动态事件须有ID、摘要与变化列表');
  if (['__proto__', 'constructor', 'prototype'].includes(事件ID) || 事件ID.startsWith(DEBUT_PREFIX)) throw new Error('动态事件ID为协议保留值');
  if (typeof 分支 !== 'string' || !分支.trim() || !Array.isArray(实际参与者)) throw new Error('动态事件分支或参与者非法');
  if (变化.some(c => !c || typeof c.路径 !== 'string' || !['角色', '世界'].includes(c.路径.split('.')[0]) || (c.路径.split('.')[0] === '世界' && !c.路径.startsWith('世界.剧情标记.')))) throw new Error('动态变化路径非法');
  return confirmEvent(protocol, stat, 事件ID, 分支, 实际时间, 实际参与者, {摘要, 变化});
}

// 首次登场显式登记已核定能力与装备起点；保留本局变化，空起点也封存。
export function confirmInitialGrowth(protocol, stat, groupID) {
  if (!stat?.开局?.已封卷) throw new Error('初始化前必须封卷');
  const profile = protocol.resolveProfile(groupID, stat);
  const seed = protocol.initialGrowth(groupID, profile.档案ID, stat);
  if (seed === null) return false;
  const id = DEBUT_PREFIX + groupID;
  if (protocol.events.has(id) || stat.事件?.[id]) throw new Error('初始化事件记录冲突 ' + id);
  const draft = clone(stat);
  confirmEvent(protocol, draft, id, DEBUT_BRANCH, draft.世界.当前时间, [groupID]);
  if (seed.节点.length) protocol.activateGrowth(groupID, seed.节点, draft, {initialize: true});
  const run = (draft.角色 ??= {})[groupID] ??= {};
  run.成长已初始化 = true;
  draft.事件[id].摘要 = `首次登场，确认${groupID}的既有能力与装备起点。`;
  Object.assign(stat, draft);
  return true;
}

// 封卷：写入开局选择，再按时间与门槛依赖顺序确认最晚早于开局时间的事件。
export function seal(protocol, config) {
  const stat = {世界: {当前时间: config.开局时间, 剧情标记: {}}, 开局: {开局时间: config.开局时间, 已封卷: true, 角色组: {}}, 角色: {}, 事件: {}, 待定项: []};
  for (const [id, g] of protocol.groups) {
    const pick = config.角色组?.[id] || {};
    stat.开局.角色组[id] = {启用: pick.启用 ?? g.默认启用, 版本ID: pick.版本ID ?? g.默认版本};
  }
  const player = config.玩家 || {模式: '自建', 档案: {}};
  if (player.模式 === '扮演' && !stat.开局.角色组[player.扮演角色组]?.启用) throw new Error('扮演的角色组未启用：' + player.扮演角色组);
  if (!PLAYER_MODES.includes(player.模式)) throw new Error('未登记玩家模式 ' + player.模式);
  stat.开局.玩家 = clone(player);
  const {time} = protocol, start = time(config.开局时间);
  if (!start) throw new Error('开局时间非法');
  for (const e of protocol.events.values()) protocol.eventRange(e);
  protocol.assertEventStructure();
  const past = [...protocol.events.values()].filter(e => time(e.时间范围.最晚)[1] <= start[0] && e.确认策略 !== '仅作候选');
  const {facts, preview} = protocol.resolveHistory(stat, past, true);
  for (const e of past) if (!facts.has(e.事件ID)) preview.事件[e.事件ID] = {状态: 2};
  return preview;
}

const stripMachine = v => Array.isArray(v) ? v.map(stripMachine) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !strip.has(k)).map(([k, x]) => [k, stripMachine(x)])) : v;

// 只读组装；audit 留给作者调试，只有 context 可注入叙事模型。
export function assembleWithAudit(protocol, stat, {present = [], mentioned = [], requestedSkills = [], skillLimit = protocol.dialect.context.skillLimit, ...eventOptions} = {}) {
  const RUNTIME_FIELDS = protocol.dialect.projectedFields;
  const out = {世界: Object.fromEntries(['当前时间', '当前地点', '剧情标记'].filter(k => own(stat?.世界, k)).map(k => [k, clone(stat.世界[k])])),
    角色: [], 被提及: [], 地点: [], 已确认事件: [], 待登记事件: [], 候选事件: [], 技能正文: [], 待初始化成长: {}, 异常: []};
  const here_ = stat?.世界?.当前地点?.地标;
  if (here_) {
    const chain = protocol.locationChain(here_);
    if (chain.length) out.地点 = chain.map(l => clone(l.正文));
    else out.异常.push({地点ID: here_, 状态: '未登记地点'});
  }
  const usable = new Set(), player = stat?.开局?.玩家;
  const here = [...new Set(present.filter(id => stat?.开局?.角色组?.[id]?.启用))];
  if (player?.模式 === '扮演' && !here.includes(player.扮演角色组)) here.unshift(player.扮演角色组);
  if (player?.模式 === '自建') {
    const run = stat.角色?.[PLAYER] || {};
    out.玩家 = {角色组ID: PLAYER, 档案: clone(player.档案), 当前能力: {...protocol.effectiveAbility(PLAYER, null, stat), 可用技能: protocol.availableSkills(PLAYER, null, stat)},
      本局状态: Object.fromEntries(RUNTIME_FIELDS.filter(k => own(run, k)).map(k => [k, clone(run[k])]))};
    out.玩家.当前能力.可用技能.forEach(s => usable.add(s));
  } else if (player?.模式 === '扮演') out.玩家 = {扮演角色组: player.扮演角色组};
  for (const id of here) {
    const p = protocol.resolveProfile(id, stat);
    if (p.状态 !== '成立') { out.异常.push({角色组ID: id, ...p}); continue; }
    const f = protocol.profileFiles(id, p.档案ID), run = stat.角色?.[id] || {};
    out.角色.push({
      角色组ID: id, 档案ID: p.档案ID,
      基本信息: {...clone(f.基本信息), 能力特征: protocol.abilityTraits(id, p.档案ID, stat)}, 角色印象: f.角色印象,
      已有成长: protocol.activeGrowth(id, stat).map(n => ({节点ID: n.节点ID, 名称: n.名称})),
      当前能力: {...protocol.effectiveAbility(id, p.档案ID, stat), 可用技能: protocol.availableSkills(id, p.档案ID, stat)},
      本局状态: Object.fromEntries(RUNTIME_FIELDS.filter(k => own(run, k)).map(k => [k, clone(run[k])])),
    });
    out.角色.at(-1).当前能力.可用技能.forEach(s => usable.add(s));
    const seed = protocol.initialGrowth(id, p.档案ID, stat);
    if (seed) out.待初始化成长[id] = seed;
  }
  for (const id of mentioned.filter(m => !here.includes(m) && stat?.开局?.角色组?.[m]?.启用)) {
    const g = protocol.groups.get(id);
    out.被提及.push({角色组ID: id, 显示名: g.显示名, 别名: g.别名});
  }
  const events = selectEventContext(protocol, stat, {present: here, ...eventOptions}, {time: protocol.time, stripPosition: stripMachine});
  Object.assign(out, events.context);
  // 只展开在场角色可用、且场景中用到的技能正文；不可用的技能不展开，避免模型补造效果。
  for (const sid of [...new Set(requestedSkills)].filter(s => usable.has(s)).slice(0, skillLimit))
    out.技能正文.push(clone(protocol.skills.get(sid).正文));
  return {context: out, audit: events.audit};
}

// present：在场角色组ID；mentioned：被提及角色组ID；requestedSkills：用到的技能；requestedEvents：点名回忆。
export function assemble(protocol, stat, options = {}) { return assembleWithAudit(protocol, stat, options).context; }

export {loadCatalog, parentFromPath} from './catalog.mjs';
