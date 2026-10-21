import {PROFILE_FIELDS} from '../../core/contract.mjs';
import {checkField, referenceExists} from '../../core/fields.mjs';
import {has, isMap, list, pairs, issue} from '../../core/utils.mjs';
import {visibleStrings} from './text.mjs';

export function checkProfiles(catalog, decl) {
  const issues = [], add = (rule, file, message) => issues.push(issue(rule, '错误', file, message));
  for (const group of catalog.groups) for (const profile of group.档案) {
    const expected = ['基本信息', '角色印象'].map(kind => `${profile.目录}/${kind}.txt`);
    const actual = catalog.files.filter(record => record.文件.startsWith(`${profile.目录}/`)).map(record => record.文件);
    if (expected.some(file => !actual.includes(file)) || actual.some(file => !expected.includes(file))
      || catalog.directories.some(directory => directory.startsWith(`${profile.目录}/`))) add('档案.缺文件', profile.目录, '每份档案必须且只能有基本信息.txt与角色印象.txt');
    for (const kind of ['基本信息', '角色印象']) {
      const file = `${profile.目录}/${kind}.txt`, value = profile[kind];
      if (!actual.includes(file)) continue;
      if (!isMap(value)) { add('档案.形态', file, '档案正文须为映射'); continue; }
      const additions = Object.fromEntries(pairs(decl.textRules?.档案追加字段?.[kind]).filter(([name]) => !has(PROFILE_FIELDS[kind], name)));
      const schemas = {...PROFILE_FIELDS[kind], ...additions};
      if (visibleStrings(value, {子字段: schemas}).some(text => /[\p{Decimal_Number}零〇一二两三四五六七八九十百千万亿]+岁/u.test(text)))
        issues.push(issue('档案.年龄', '提示', file, '档案不写年龄，当前年龄由出生年与当前时间计算'));
      for (const key of Object.keys(value)) if (!has(schemas, key)) add('档案.未知字段', file, `未知字段“${key}”`);
      for (const [name, schema] of pairs(schemas)) {
        if (!has(value, name)) { if (schema?.必填) add('档案.缺必填', file, `缺少必填字段“${name}”`); continue; }
        if (kind === '基本信息' && name === '能力特征') checkTraits(value[name], file, catalog, decl, issues, add);
        else issues.push(...checkField(value[name], schema, {file, decl, catalog, label: name, scope: '档案'}));
      }
    }
  }
  return issues;
}

function checkTraits(value, file, catalog, decl, issues, add) {
  if (!isMap(value)) { add('档案.形态', file, '能力特征须为子字段映射'); return; }
  for (const key of Object.keys(value)) if (!['特征', '技能补充'].includes(key)) add('档案.形态', file, `能力特征含未知子键“${key}”`);
  for (const key of ['特征', '技能补充']) if (!has(value, key)) add('档案.缺必填', file, `能力特征必须写“${key}”，可以为空列表`);
  if (has(value, '特征')) issues.push(...checkField(value.特征, {形态: '文本列表'}, {file, decl, catalog, scope: '档案', label: '能力特征.特征', allowEmpty: true}));
  if (!has(value, '技能补充')) return;
  if (!Array.isArray(value.技能补充)) { add('档案.技能补充', file, '技能补充须为列表'); return; }
  const seen = new Set();
  for (const item of value.技能补充) {
    if (!isMap(item)) { add('档案.技能补充', file, '技能补充项须为映射'); continue; }
    if (Object.keys(item).some(key => !['技能ID', '个体表现', '个体限制'].includes(key))) add('档案.技能补充', file, '技能补充含未知子键');
    if (!referenceExists(item.技能ID, '技能', catalog) || seen.has(item.技能ID)) add('档案.技能补充', file, '技能ID未登记或重复');
    seen.add(item.技能ID);
    if (!has(item, '个体表现') && !has(item, '个体限制')) add('档案.技能补充', file, '个体表现与个体限制至少写一项');
    for (const key of ['个体表现', '个体限制']) if (has(item, key)) {
      if (!Array.isArray(item[key]) || !item[key].length) add('档案.技能补充', file, `${key}须为非空文本列表`);
      issues.push(...checkField(item[key], {形态: '文本列表'}, {file, decl, catalog, scope: '档案', label: `能力特征.技能补充.${key}`}));
    }
  }
}
