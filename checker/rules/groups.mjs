import {GROUP_FIELDS, VERSION_FIELDS, PROFILE_ITEM_FIELDS, INITIALIZATION_MODES} from '../../core/contract.mjs';
import {dimensionKeys, referenceExists} from '../../core/fields.mjs';
import {has, isMap, isText, texts, pairs, list, issue, matches} from '../../core/utils.mjs';
import {checkId} from './layout.mjs';
import {checkCondition, conditionReferences} from '../../core/conditions.mjs';

export function checkGroups(catalog, decl) {
  const issues = [], aliases = new Map();
  const add = (rule, file, message, level = '错误') => issues.push(issue(rule, level, file, message));
  function unknown(value, allowed, file, label) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add('角色组.未知字段', file, `${label}含未知字段“${key}”`);
  }
  function optionalText(value, key, file) {
    if (has(value, key) && !isText(value[key])) add('角色组.字段', file, `${key}须为非空文本`);
  }
  for (const group of catalog.groups) {
    const file = group.文件, content = group.内容;
    if (!catalog.files.some(record => record.文件 === file) || !catalog.directories.includes(`角色/${group.id}/档案`)) add('角色组.缺文件', file, '角色组必须有角色组.yaml与档案目录');
    if (!isMap(content)) { add('角色组.字段', file, '角色组内容须为映射'); continue; }
    unknown(content, GROUP_FIELDS, file, '角色组');
    for (const key of ['角色包', '分类']) {
      if (!isText(content[key]) || !list(decl.roleClasses[key]).includes(content[key])) add('角色组.角色分类', file, `${key}须取角色分类声明中的值`);
    }
    if (typeof content.默认启用 !== 'boolean') add('角色组.字段', file, '默认启用必填且须为布尔');
    optionalText(content, '显示名', file);
    if (has(content, '初始化方式') && !INITIALIZATION_MODES.includes(content.初始化方式)) add('角色组.字段', file, '初始化方式须为显式确认或出场自动');
    if (has(content, '初始所在') && !referenceExists(content.初始所在, '地点', catalog)) add('角色组.初始所在', file, '初始所在必须引用已声明地点库中的地点');
    const groupAliases = [], addAliases = value => {
      if (value === undefined) return;
      if (!texts(value)) add('角色组.字段', file, '别名须为非空无重复文本列表');
      groupAliases.push(...list(value).filter(isText));
    };
    addAliases(content.别名);
    const explicit = has(content, '版本');
    if (explicit) {
      if (!Array.isArray(content.版本) || !content.版本.length) add('角色组.版本', file, '版本须为非空列表');
      for (const version of list(content.版本)) {
        if (!isMap(version)) { add('角色组.字段', file, '版本项须为映射'); continue; }
        unknown(version, VERSION_FIELDS, file, '版本项');
        if (!isText(version.版本ID)) add('角色组.版本', file, '版本ID必填且须为非空文本');
        issues.push(...checkId(version.版本ID, file, '版本ID', true, decl));
        optionalText(version, '显示名', file); optionalText(version, '简介', file);
        addAliases(version.别名);
      }
      if (!isText(content.默认版本) || !group.版本清单.includes(content.默认版本)) add('角色组.版本', file, '必须指定已登记的默认版本');
      if (new Set(group.版本清单).size !== group.版本清单.length) add('角色组.版本', file, '版本ID重复');
    } else if (has(content, '默认版本')) add('角色组.版本', file, '未写版本清单时应省略默认版本');
    const local = new Set();
    for (const alias of groupAliases) {
      if (local.has(alias)) add('角色组.别名重复', file, `同组别名“${alias}”重复`);
      local.add(alias);
      if (aliases.has(alias) && aliases.get(alias) !== group.id) add('角色组.跨组别名', file, `别名“${alias}”也用于角色组“${aliases.get(alias)}”`, '提示');
      else aliases.set(alias, group.id);
    }
    if (!Array.isArray(content.档案) || !content.档案.length) add('角色组.字段', file, '档案须为非空列表');
    const items = list(content.档案).filter(isMap), registrations = new Map(), applicability = new Map();
    if (items.length !== list(content.档案).length) add('角色组.字段', file, '档案项须为映射');
    for (const item of items) {
      unknown(item, PROFILE_ITEM_FIELDS, file, '档案项');
      if (!isText(item.档案ID)) add('角色组.字段', file, '档案ID必填且须为非空文本');
      issues.push(...checkId(item.档案ID, file, '档案ID', false, decl));
      if (registrations.has(item.档案ID)) add('档案项.目录不符', file, `档案ID“${item.档案ID}”重复`);
      registrations.set(item.档案ID, item);
      if (explicit && (!texts(item.适用版本) || list(item.适用版本).some(version => !group.版本清单.includes(version)))) add('档案项.适用版本', file, `${item.档案ID}适用版本须为非空无重复的已登记版本列表`);
      if (!explicit && has(item, '适用版本')) add('档案项.适用版本', file, '单版本角色组应省略适用版本');
      const versions = explicit ? list(item.适用版本) : [group.id];
      applicability.set(item.档案ID, versions);
      if (has(item, '默认') && typeof item.默认 !== 'boolean') add('角色组.字段', file, '档案项的默认须为布尔');
      if ((item.默认 === true && has(item, '生效条件')) || (item.默认 !== true && (!has(item, '生效条件') || item.生效条件 === null))) add('档案项.默认', file, `${item.档案ID}默认档案不能写生效条件，非默认档案必须有生效条件`);
      if (has(item, '生效条件')) {
        if (item.生效条件 === null) issues.push(issue('条件.格式', '错误', file, `档案“${item.档案ID}”生效条件：不能为 null`));
        else issues.push(...checkCondition(item.生效条件, {decl, catalog, file, policy: '条件确认'}, `档案“${item.档案ID}”生效条件`));
        if (item.默认 !== true && !conditionReferences(item.生效条件).some(ref => !ref.排斥)) add('档案项.生效条件', file, `${item.档案ID}生效条件必须含正向事件确认`);
      }
      if (has(item, '前置档案') && !isText(item.前置档案)) add('档案项.前置档案', file, '前置档案须为非空档案ID');
      if (has(item, '初始能力')) checkInitialAbility(item.初始能力, item.档案ID, file, catalog, decl, add);
      if (has(item, '初始装备')) checkInitialEquipment(item.初始装备, item.档案ID, file, catalog, decl, add);
    }
    const folders = group.档案.map(profile => profile.id);
    for (const id of new Set([...registrations.keys(), ...folders])) if (!registrations.has(id) || !folders.includes(id)) add('档案项.目录不符', file, `档案“${id}”的登记与目录不对应`);
    for (const version of new Set(group.版本清单)) {
      const applicable = items.filter(item => applicability.get(item.档案ID)?.includes(version));
      if (!applicable.length) add('档案项.无适用档案', file, `版本“${version}”没有适用档案`);
      if (applicable.filter(item => item.默认 === true).length > 1) add('档案项.默认', file, `版本“${version}”有多个默认档案`);
    }
    for (const item of items) if (has(item, '前置档案')) {
      const previous = registrations.get(item.前置档案);
      if (!previous || !applicability.get(item.档案ID)?.some(version => applicability.get(previous.档案ID)?.includes(version))) add('档案项.前置档案', file, `${item.档案ID}前置不存在或适用版本无交集`);
      const seen = new Set([item.档案ID]);
      let current = item;
      while (current && has(current, '前置档案')) {
        if (seen.has(current.前置档案)) { add('档案项.前置档案', file, `${item.档案ID}前置链成环`); break; }
        seen.add(current.前置档案);
        current = registrations.get(current.前置档案);
      }
    }
  }
  return issues;
}

function checkInitialAbility(value, id, file, catalog, decl, add) {
  const fail = message => add('档案项.初始能力', file, `${id}：${message}`);
  if (!isMap(value) || !Object.keys(value).length) { fail('初始能力须为非空维度映射'); return; }
  for (const [name, initial] of pairs(value)) {
    const dimension = has(decl.ability.维度, name) ? decl.ability.维度[name] : null;
    if (!isMap(dimension)) { fail(`能力维度“${name}”未声明`); continue; }
    const ranks = list(decl.ladders[dimension.等级]);
    if (dimension.类型 === '等级映射') {
      if (!isMap(initial) || !Object.keys(initial).length) fail(`${name}须为非空的键与等级映射`);
      for (const [key, rank] of pairs(initial)) if (!dimensionKeys(dimension).includes(key) || !ranks.includes(rank)) fail(`${name}.${key}的键或等级非法`);
    } else if (dimension.类型 === '单值等级') {
      if (!ranks.includes(initial)) fail(`${name}等级非法`);
    } else if (dimension.类型 === '集合') {
      if (!Array.isArray(initial) || new Set(initial).size !== initial.length) { fail(`${name}须为无重复成员列表`); continue; }
      const member = dimension.成员;
      for (const item of initial) {
        if (member === '文本') { if (!isText(item)) fail(`${name}成员须为非空文本`); continue; }
        const entry = list(catalog.entries[member?.条目库]).find(candidate => candidate.id === item);
        if (!entry || (has(member, '条件') && !matches(entry.内容, member.条件))) fail(`${name}成员“${item}”不合声明`);
      }
    } else fail(`${name}维度类型非法`);
  }
}

function checkInitialEquipment(value, id, file, catalog, decl, add) {
  const fail = message => add('档案项.初始装备', file, `${id}：${message}`);
  if (!Array.isArray(value) || !value.length) { fail('初始装备须为非空列表'); return; }
  const seen = new Set();
  for (const item of value) {
    if (!isMap(item) || Object.keys(item).some(key => !['装备ID', '状态', '位置'].includes(key))) { fail('初始装备项只含装备ID、状态、位置'); continue; }
    if (!referenceExists(item.装备ID, '装备', catalog)) fail('装备ID不存在');
    if (!list(decl.variables.词表.装备状态).includes(item.状态)) fail('装备状态不在词表内');
    if (!isText(item.位置)) fail('位置须为非空文本');
    if (seen.has(item.装备ID)) fail('同一装备重复');
    seen.add(item.装备ID);
  }
}
