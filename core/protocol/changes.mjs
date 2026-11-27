import {checkChange, changeRoleReferences} from '../changes.mjs';
import {resolveDomain} from '../fields.mjs';
import {sameValue, valueProblem, valueText} from '../values.mjs';
import {has, isMap, list, pairs} from '../utils.mjs';

export const clone = value => structuredClone(value);
export const own = (value, key) => value != null && Object.hasOwn(value, key);
export const getOwn = (value, key) => own(value, key) ? value[key] : undefined;
export const setOwn = (value, key, item) => {
  Object.defineProperty(value, key, {value: item, enumerable: true, configurable: true, writable: true});
};

export function createChangeTools({catalog, decl, fail, isEnabled}) {
  const dimensions = decl.ability?.维度 ?? {};
  const uniqueEquipments = new Set(list(catalog.entries?.装备).filter(entry => entry?.内容?.唯一 === true).map(entry => entry.id));

  function isUniqueEquipment(equipID) {
    return uniqueEquipments.has(equipID);
  }

  function equipmentHolders(state, equipID) {
    const holders = [];
    for (const [roleID, run] of pairs(state?.角色)) {
      if (own(run?.装备, equipID)) holders.push(roleID);
    }
    return holders;
  }

  function stripUniqueFromOthers(state, equipID, keepRoleID) {
    for (const [roleID, run] of pairs(state?.角色)) {
      if (roleID === keepRoleID) continue;
      if (own(run?.装备, equipID)) delete run.装备[equipID];
    }
  }

  function customEquipmentNames(state) {
    return new Set(list(state?.开局?.玩家?.自定义装备).map(item => item?.名称).filter(Boolean));
  }

  function resolveVariableSlot(parts) {
    const root = parts[0] === '世界' ? decl.variables?.世界 : decl.variables?.角色;
    const offset = parts[0] === '世界' ? 1 : 2;
    let schema = getOwn(root, parts[offset]), isMappingSlot = false;
    for (let index = offset + 1; index < parts.length; index++) {
      if (isMap(schema?.映射)) {
        schema = schema.映射.值;
        if (index === parts.length - 1) isMappingSlot = true;
      } else if (isMap(schema?.子字段)) schema = getOwn(schema.子字段, parts[index]);
    }
    return {schema, isMappingSlot};
  }

  function schemaChange(change, state, {preset = false} = {}) {
    const customEquipments = preset ? undefined : customEquipmentNames(state);
    const issues = checkChange(change, {decl, catalog, preset, customEquipments});
    if (issues.length) fail('协议.变化', issues.map(item => `${item.规则}：${item.说明}`).join('；'));
    if (isMap(change) && has(change, '值') && change.值 !== undefined) {
      const problem = valueProblem(change.值);
      if (problem) fail('协议.变化', `变化.取值：${valueText[problem]}`);
    }
    const parts = change.路径.split('.');
    checkRoleTargets(change, state);
    return parts;
  }

  function validateChanges(changes, state, options = {}) {
    for (const change of changes) {
      if (!isMap(change)) fail('协议.变化', '变化项须为映射');
      schemaChange(change, state, options);
    }
  }

  function checkRoleTargets(change, state) {
    for (const id of changeRoleReferences({路径: change.路径}, decl)) {
      if (id !== '玩家' && !isEnabled(id, state)) fail('协议.变化', `路径中的角色组未启用：${id}`);
    }
    if (state.开局.玩家.模式 !== '自建' && changeRoleReferences(change, decl).includes('玩家'))
      fail('协议.变化', '扮演模式不能写保留角色组“玩家”');
  }

  function addMember(current, value) {
    const items = Array.isArray(current) ? current : [];
    return items.some(item => sameValue(item, value)) ? items : [...items, clone(value)];
  }

  function removeMember(current, value) {
    return (Array.isArray(current) ? current : []).filter(item => !sameValue(item, value));
  }

  function clearRemoval(run, field) {
    if (!Array.isArray(run.能力移除记录)) return;
    run.能力移除记录 = run.能力移除记录.filter(item => item !== field);
    if (!run.能力移除记录.length) delete run.能力移除记录;
  }

  function applyChangesToState(state, changes, {preset = false} = {}) {
    for (const change of changes) {
      if (!isMap(change)) fail('协议.变化', '变化项须为映射');
      const parts = schemaChange(change, state, {preset});
      const op = change.操作, value = change.值;
      if (parts[0] === '角色' && parts[2] === '装备' && op === '新增' && preset
        && isUniqueEquipment(parts[3]) && equipmentHolders(state, parts[3]).length) continue;
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
        setOwn(parent, key, op === '新增' ? addMember(current, value) : removeMember(current, value));
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
      const {schema, isMappingSlot} = resolveVariableSlot(parts);
      if (parts[0] === '角色' && parts[2] === '装备') {
        if (op === '移除') { if (own(parent, key)) delete parent[key]; }
        else if (isUniqueEquipment(key)) {
          if (op === '新增') {
            if (!own(parent, key)) {
              stripUniqueFromOthers(state, key, parts[1]);
              setOwn(parent, key, clone(value));
            }
          } else {
            stripUniqueFromOthers(state, key, parts[1]);
            setOwn(parent, key, clone(value));
          }
        } else if (op === '新增') { if (!own(parent, key)) setOwn(parent, key, clone(value)); }
        else setOwn(parent, key, clone(value));
      } else if (schema?.数值) {
        const [minimum, maximum] = schema.数值;
        const current = target ?? 0;
        setOwn(parent, key, Math.max(minimum, Math.min(maximum, current + (op === '增加' ? value : -value))));
      } else if (schema?.集合) {
        const current = Array.isArray(target) ? target : [];
        setOwn(parent, key, op === '新增' ? addMember(current, value) : removeMember(current, value));
      } else if (isMappingSlot) {
        if (op === '移除') { if (own(parent, key)) delete parent[key]; }
        else if (op === '新增') { if (!own(parent, key)) setOwn(parent, key, clone(value)); }
        else setOwn(parent, key, clone(value));
      } else if (op === '移除') {
        if (own(parent, key)) delete parent[key];
      } else if (op === '新增' && Array.isArray(target)) {
        if (!target.some(item => sameValue(item, value))) target.push(clone(value));
      } else if (op === '新增' && !own(parent, key)) setOwn(parent, key, clone(value));
      else if (op === '增加' || op === '减少') {
        setOwn(parent, key, (Number.isSafeInteger(target) ? target : 0) + (op === '增加' ? value : -value));
      } else setOwn(parent, key, clone(value));
    }
  }

  function applyEventChanges(state, event, changes) {
    try { applyChangesToState(state, changes, {preset: true}); }
    catch (error) {
      if (error?.name === 'ProtocolError' && error.code === '协议.变化')
        fail('协议.变化', `事件“${event.id}”：${error.message}`);
      throw error;
    }
  }

  function applyBranch(state, event, branch) {
    applyEventChanges(state, event, list(branch.变化));
  }

  return {validateChanges, applyChangesToState, applyEventChanges, applyBranch, checkRoleTargets,
    isUniqueEquipment, equipmentHolders, stripUniqueFromOthers, customEquipmentNames};
}
