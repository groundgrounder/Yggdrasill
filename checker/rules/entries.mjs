import {checkField, dimensionKeys} from '../../core/fields.mjs';
import {has, isMap, isText, list, pairs, issue, matches} from '../../core/utils.mjs';

export function checkEntries(catalog, decl) {
  const issues = [], add = (rule, file, message) => issues.push(issue(rule, '错误', file, message));
  const ids = Object.create(null);
  for (const [library, entries] of Object.entries(catalog.entries)) {
    ids[library] = new Map();
    const declaredIds = new Map();
    const schema = decl.libraries[library] ?? {};
    const fields = schema?.字段 ?? {};
    for (const entry of entries) {
      const value = entry.内容, file = entry.文件;
      const idKey = `${library}ID`;
      if (!isMap(value)) { add('条目.形态', file, '条目内容须为映射'); continue; }
      if (has(value, idKey) && declaredIds.has(value[idKey])) add('条目.重复ID', file, `字段${idKey}“${value[idKey]}”重复`);
      else if (has(value, idKey)) declaredIds.set(value[idKey], file);
      if (ids[library].has(entry.id)) add('条目.重复ID', file, `ID“${entry.id}”重复，首次出现于${ids[library].get(entry.id)}`);
      else ids[library].set(entry.id, file);
      for (const key of Object.keys(value)) if (![idKey, '名称', ...Object.keys(fields)].includes(key)) add('条目.未声明字段', file, `字段“${key}”未声明`);
      if (!has(value, idKey)) add('条目.缺必填', file, `缺少必填字段“${idKey}”`);
      else if (value[idKey] !== entry.id) add('命名.文件名不符', file, `${idKey}必须等于文件名“${entry.id}”`);
      if (has(value, '名称') && !isText(value.名称)) add('条目.形态', file, '名称须为非空文本');
      const type = value.类型;
      for (const [field, fieldSchema] of pairs(fields)) {
        if (!has(value, field)) {
          if (fieldSchema?.必填 && (!fieldSchema.适用类型 || list(fieldSchema.适用类型).includes(type))) add('条目.缺必填', file, `缺少必填字段“${field}”`);
          continue;
        }
        issues.push(...checkField(value[field], fieldSchema, {decl, catalog, file, label: field, scope: '条目', entryType: type}));
      }
      if (library === '技能') {
        const required = new Set(decl.ability.技能可用.filter(isMap).flatMap(rule => [
          ...Object.keys(isMap(rule.适用) ? rule.适用 : {}), ...(rule.规则 === '等级门槛' ? [rule.键字段, rule.等级字段] : []),
        ]).filter(isText));
        for (const field of required) if (!has(value, field)) add('条目.缺必填', file, `缺少技能可用规则所需字段“${field}”`);
      }
      if (schema?.分法 === '按种类') {
        const hierarchy = entry.层级目录;
        for (let i = 0; i < list(schema.分级).length; i++) {
          const field = schema.分级[i];
          if (value[field] !== hierarchy[i]) add('条目.分级', file, `${field}“${value[field]}”与目录“${hierarchy[i]}”不一致`);
        }
      } else {
        if (entry.同名说明 && entry.id !== library && value[idKey] !== entry.id) add('命名.文件名不符', file, `${idKey}必须与目录名一致`);
        const parent = entry.上级 ? findById(catalog, library, entry.上级) : null;
        if (entry.上级 && !parent) add('条目.上级类型', file, `上级条目“${entry.上级}”不存在`);
        if (parent && isMap(schema.上级类型)) {
          const allowed = schema.上级类型[type] ?? [];
          if (!list(allowed).includes(parent.内容?.类型)) add('条目.上级类型', file, `类型“${type}”不能挂在“${parent.内容?.类型}”之下`);
        }
        if (!entry.上级 && isMap(schema.上级类型) && (!has(schema.上级类型, type) || list(schema.上级类型[type]).length !== 0)) add('条目.上级类型', file, `类型“${type}”不允许放在库根`);
      }
      checkPrefix(catalog, decl, library, entry, add);
    }
  }
  checkSkills(catalog, decl, add);
  return issues;
}

function findById(catalog, library, id) { return list(catalog.entries[library]).find(entry => entry.id === id); }

function checkPrefix(catalog, decl, library, entry, add) {
  const rules = [decl.textRules?.ID命名?.全部, decl.textRules?.ID命名?.[`${library}ID`]];
  for (const current of rules) {
    const rule = current?.前缀字段;
    if (!rule) continue;
    const prefix = entry.内容?.[rule];
    if (typeof prefix !== 'string' || !entry.id.startsWith(`${prefix}·`) || entry.id.length <= prefix.length + 1) add('命名.本卡规则', entry.文件, `${library}ID须写成“${rule}字段的值·名称”，名称不能为空`);
  }
}

function checkSkills(catalog, decl, add) {
  const skills = catalog.entries.技能;
  if (!skills) return;
  const rules = decl.ability?.技能可用 ?? [];
  for (const skill of skills) {
    const matchesRules = rules.filter(rule => isMap(rule) && matches(skill.内容, rule.适用));
    if (matchesRules.length !== 1) add('技能.可用规则', skill.文件, `技能须恰好适用一条可用规则，当前匹配${matchesRules.length}条`);
    for (const rule of matchesRules) {
      const dimension = decl.ability.维度[rule.维度];
      if (rule.规则 === '等级门槛' && dimension) {
        const key = skill.内容?.[rule.键字段], rank = skill.内容?.[rule.等级字段];
        const allowedKeys = dimensionKeys(dimension);
        const group = rule.键组 ? list(dimension.键?.[rule.键组]) : allowedKeys;
        if (!allowedKeys.includes(key) || !group.includes(key)) add('技能.门槛取值', skill.文件, `技能键字段“${key}”不属于维度的指定键`);
        const ranks = decl.ladders[dimension.等级] ?? [];
        if (!list(ranks).includes(rank)) add('技能.门槛取值', skill.文件, `技能等级“${rank}”不属于“${dimension.等级}”`);
      }
      if (rule.规则 === '集合持有' && dimension) {
        const member = dimension.成员;
        if (member !== '文本' && (!isMap(member) || member.条目库 !== '技能'
          || (has(member, '条件') && !matches(skill.内容, member.条件)))) add('技能.集合成员', skill.文件, `技能不符合集合维度“${rule.维度}”的成员声明`);
      }
    }
  }
}
