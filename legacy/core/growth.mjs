// 成长树是定义；只有已确认事件才能把节点写入本局。展示上级不充当运行前置。
// 等级与装备状态取自方言，经 options.dialect 传入（协议对象自带 dialect）。
import {ABILITY, GROWTH, TRAITS} from './contract.mjs';
import {requireDialect} from './dialect.mjs';

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const list = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim()) && new Set(v).size === v.length;
export const abilityFields = GROWTH.ability;

// 静态事件与运行变化使用同一能力契约；移除段位不携带占位值。
export function abilityChangeIssues(c, {skills, systems, dialect} = {}) {
  const keys = typeof c?.路径 === 'string' ? c.路径.split('.') : [];
  if (keys[0] !== '角色') return [];
  const field = keys[2];
  if (field === ABILITY.initialized) return ['初始化标记只允许初始化协议写入'];
  if (field === ABILITY.removed) return ['能力移除记录只允许协议写入'];
  if (ABILITY.retired.includes(field)) return ['旧能力变量已撤除'];
  if (field === ABILITY.stages || field === ABILITY.strength) {
    const {rank} = requireDialect(dialect, '能力段位变化');
    const errors = [];
    if (keys.length !== (field === ABILITY.stages ? 4 : 3) ||
        !(c.操作 === '设定' && rank(c.值) || c.操作 === '移除' && !('值' in c))) errors.push('能力段位变化非法');
    if (field === ABILITY.stages && systems?.size && !systems.has(keys[3])) errors.push('修习体系未登记 ' + keys[3]);
    return errors;
  }
  if (ABILITY.sets.includes(field)) {
    if (keys.length !== 3 || !['新增', '移除'].includes(c.操作) || typeof c.值 !== 'string' || !c.值.trim()) return ['能力集合只允许逐项新增或移除'];
    if (field === '固有技能' && skills && skills.get(c.值)?.来源 !== '固有') return ['固有技能未登记 ' + c.值];
  }
  return [];
}

export function growthIssues(tree, group, {skills = new Map(), equipment = new Map(), systems, dialect} = {}) {
  if (!tree) return [];
  const {rank, equipmentStates} = requireDialect(dialect, '成长树检查');
  const errors = [], fail = s => errors.push(s), versions = (group?.版本 || []).map(v => v.版本ID);
  if (!plain(tree)) return ['成长树必须是对象'];
  if (!group?.角色组ID || !versions.length) return ['成长树缺少有效角色组定义'];
  for (const k of Object.keys(tree)) if (!GROWTH.tree.includes(k)) fail('成长树字段非法 ' + k);
  if (tree.角色组ID !== group.角色组ID) fail('成长树角色组不一致');
  if (!list(tree.版本) || [...tree.版本].sort().join('|') !== [...versions].sort().join('|')) fail('成长树版本与角色组不一致');
  if (!Array.isArray(tree.节点) || !tree.节点.length) return [...errors, '成长树缺少节点'];
  const nodes = new Map();
  for (const n of tree.节点) {
    if (!plain(n)) { fail('成长节点必须是对象'); continue; }
    const id = n.节点ID;
    if (typeof id !== 'string' || !id.trim() || /[A-Za-z.]/.test(id)) fail('节点ID必须使用中文短语 ' + id);
    if (nodes.has(id)) fail('重复节点ID ' + id);
    nodes.set(id, n);
    for (const k of Object.keys(n)) if (!GROWTH.node.includes(k)) fail(`${id} 节点字段非法 ${k}`);
    for (const k of ['名称', '节点类型', '说明']) if (typeof n[k] !== 'string' || !n[k].trim()) fail(`${id} 缺少${k}`);
    if (!list(n.适用版本) || n.适用版本.some(v => !versions.includes(v))) fail(`${id} 适用版本非法`);
    if (!list(n.上级节点)) fail(`${id} 上级节点必须是无重复字符串数组`);
    if (!GROWTH.review.includes(n.核定状态)) fail(`${id} 核定状态非法`);
    if (!GROWTH.effect.includes(n.运行效果)) fail(`${id} 运行效果非法`);
    if (n.核定状态 !== '已核定' && n.运行效果 !== '不激活') fail(`${id} 未核定节点不得激活`);
    const ab = n.能力效果;
    if (!plain(ab)) fail(`${id} 能力效果必须是对象`);
    else {
      for (const k of Object.keys(ab)) if (!GROWTH.ability.includes(k)) fail(`${id} 能力效果字段非法 ${k}`);
      if ('修习阶段' in ab && (!plain(ab.修习阶段) || Object.entries(ab.修习阶段).some(([s, r]) => !rank(r) || (systems && !systems.has(s))))) fail(`${id} 修习阶段非法`);
      if ('实力定位' in ab && !rank(ab.实力定位)) fail(`${id} 实力定位非法`);
      for (const k of ['固有技能新增', '施法方式新增']) if (k in ab && !list(ab[k])) fail(`${id} ${k}必须是无重复字符串数组`);
      for (const s of Array.isArray(ab.固有技能新增) ? ab.固有技能新增 : []) if (skills.get(s)?.来源 !== '固有') fail(`${id} 固有技能未登记 ${s}`);
    }
    if ('待核定效果' in n && !plain(n.待核定效果)) fail(`${id} 待核定效果必须是对象`);
    const gain = n.取得效果;
    if (gain !== undefined) {
      if (!plain(gain) || Object.keys(gain).some(k => k !== '装备新增') || !Array.isArray(gain.装备新增) || !gain.装备新增.length) fail(`${id} 取得效果只允许非空装备新增列表`);
      else {
        const seen = new Set();
        for (const x of gain.装备新增) {
          if (!plain(x) || Object.keys(x).sort().join(',') !== [...GROWTH.equipment_gain].sort().join(',')) { fail(`${id} 装备取得字段非法`); continue; }
          if (!equipment.has(x.装备ID)) fail(`${id} 装备不存在 ${x.装备ID}`);
          if (seen.has(x.装备ID)) fail(`${id} 重复取得装备 ${x.装备ID}`);
          seen.add(x.装备ID);
          if (!equipmentStates.includes(x.状态) || typeof x.位置 !== 'string' || !x.位置.trim()) fail(`${id} 装备状态或位置非法`);
        }
      }
    }
    if (n.运行效果 !== '激活' && (Object.keys(ab || {}).length || gain !== undefined)) fail(`${id} 不激活节点只能在待核定效果中保存候选`);
  }
  const roots = Array.isArray(tree.根节点) ? tree.根节点 : [];
  if (!list(tree.根节点) || !roots.length || roots.some(id => !nodes.has(id) || nodes.get(id).上级节点?.length)) fail('成长树根节点非法');
  for (const [id, n] of nodes) {
    for (const parent of Array.isArray(n.上级节点) ? n.上级节点 : []) if (!nodes.has(parent)) fail(`${id} 上级节点不存在 ${parent}`);
    if (!n.上级节点?.length && !roots.includes(id)) fail(`${id} 未列入根节点`);
  }
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) { fail('成长展示关系成环 ' + id); return; }
    if (done.has(id) || !nodes.has(id)) return;
    visiting.add(id);
    for (const parent of Array.isArray(nodes.get(id).上级节点) ? nodes.get(id).上级节点 : []) visit(parent);
    visiting.delete(id); done.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  return errors;
}

export function traitsIssues(traits, {skills = new Map()} = {}) {
  if (!plain(traits) || Object.keys(traits).some(k => !TRAITS.fields.includes(k)) || !list(traits.特征) || !Array.isArray(traits.技能补充)) return ['基本信息的能力特征须包含特征与技能补充数组'];
  const errors = [], seen = new Set();
  for (const s of traits.技能补充) {
    if (!plain(s) || Object.keys(s).some(k => !TRAITS.skill_override.includes(k)) || !skills.has(s.技能ID)) { errors.push('能力特征技能引用或字段非法'); continue; }
    if (seen.has(s.技能ID)) errors.push('能力特征技能补充重复 ' + s.技能ID);
    seen.add(s.技能ID);
    if (!['个体表现', '个体限制'].some(k => k in s)) errors.push('能力特征技能补充缺少正文 ' + s.技能ID);
    for (const k of ['个体表现', '个体限制']) if (k in s && !(typeof s[k] === 'string' && s[k].trim()) && !(list(s[k]) && s[k].length)) errors.push('能力特征补充内容非法 ' + k);
  }
  return errors;
}
