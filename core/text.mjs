import {ProtocolError} from './protocol.mjs';
import {dimensionKeys, resolveDomain} from './fields.mjs';
import {codepointCompare, has, isMap, list, pairs} from './utils.mjs';

export const trimNewlines = value => value.replace(/[\r\n]+$/u, '');

export function containerText(catalog, name) {
  return list(catalog.texts).filter(record => record.文件.startsWith(`${name}/`))
    .sort((left, right) => codepointCompare(left.文件, right.文件))
    .map(record => trimNewlines(record.原文 ?? '')).join('\n\n');
}

export function formatCalendar(calendar) {
  const prefix = calendar.前缀, width = calendar.年位数, months = calendar.月数;
  const days = Array.isArray(calendar.每月天数) ? calendar.每月天数 : Array(months).fill(calendar.每月天数);
  const length = days.every(value => value === days[0]) ? `每月 ${days[0]} 天` : `各月 ${days.join('、')} 天`;
  const year = `${prefix}${'Y'.repeat(width)}年`;
  return `${year}或${year}MM月DD日（年份 ${width} 位，每年 ${months} 个月，${length}）`;
}

function keyText(schema) { return schema?.引用 ? `<${schema.引用}ID>` : '<键>'; }

function valueText(schema, decl) {
  if (schema?.取值) return schema.取值 === '纪年' ? formatCalendar(decl.calendar) : resolveDomain(schema.取值, decl).join(' / ');
  if (schema?.引用) return `<${schema.引用}ID>`;
  if (schema?.数值) return `${schema.数值[0]} 至 ${schema.数值[1]} 的整数`;
  if (schema?.集合) return valueText(schema.集合, decl);
  if (schema?.子字段) return `值为 {${pairs(schema.子字段).map(([name, child]) => `${name}: ${valueText(child, decl)}`).join(', ')}}`;
  return '文本';
}

export function writableFields(decl) {
  const lines = [];
  const append = (path, operation, values) => lines.push(`${path}：${operation}；${values}`);
  function visit(path, schema, mapped = false) {
    if (schema?.子字段 && !mapped) for (const [name, child] of pairs(schema.子字段)) visit(`${path}.${name}`, child);
    else if (schema?.映射) visit(`${path}.${keyText(schema.映射.键)}`, schema.映射.值, true);
    else append(path, schema?.数值 ? '增加、减少' : schema?.集合 ? '新增、移除' : mapped ? '设定、新增、移除' : '设定', valueText(schema, decl));
  }
  for (const [name, values] of pairs(decl.marks)) append(`世界.剧情标记.${name}`, '设定', values.join(' / '));
  for (const [name, schema] of pairs(decl.variables?.世界)) visit(`世界.${name}`, schema);
  for (const [name, schema] of pairs(decl.variables?.角色)) visit(`角色.<角色组ID>.${name}`, schema);
  for (const [name, dimension] of pairs(decl.ability?.维度)) {
    const root = `角色.<角色组ID>.${name}`;
    if (dimension.类型 === '集合') {
      const member = dimension.成员;
      let values = isMap(member) && member.条目库 ? `<${member.条目库}ID>` : member === '文本' ? '文本' : valueText(member, decl);
      if (member?.条件) values += `（${pairs(member.条件).map(([key, value]) => `${key}为 ${value}`).join('、')}）`;
      append(root, '新增、移除', values);
    } else {
      const mapped = dimension.类型 === '等级映射';
      append(mapped ? `${root}.<键>` : root, '提升、设定、移除', resolveDomain(`等级.${dimension.等级}`, decl).join(' / ')
        + (mapped ? `；键为 ${dimensionKeys(dimension).join(' / ')}` : ''));
    }
  }
  if (has(decl.libraries, '装备')) append('角色.<角色组ID>.装备.<装备ID>', '新增、设定、移除',
    `值为 {状态: ${resolveDomain('词表.装备状态', decl).join(' / ')}, 位置: 文本}`);
  return lines.join('\n');
}

export function locationList(catalog) {
  const entries = list(catalog.entries?.地点), lines = [], visited = new Set();
  function visit(parent, depth) {
    for (const entry of entries.filter(item => (item.上级 ?? null) === parent).sort((a, b) => codepointCompare(a.id, b.id))) {
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      lines.push(`${'  '.repeat(depth)}${entry.id}（${entry.内容?.类型}）`);
      visit(entry.id, depth + 1);
    }
  }
  visit(null, 0);
  return lines.join('\n') || '无';
}

export function protocolText({catalog, decl, templates}) {
  const values = {'纪年格式': formatCalendar(decl.calendar), '单次增减上限': decl.variables.单次增减上限,
    '可写字段': writableFields(decl), '地点列表': locationList(catalog), '本卡扮演准则': containerText(catalog, '扮演准则') || '无'};
  return ['变量更新规则', '角色通用约束', '扮演准则'].map(name => {
    if (typeof templates?.[name] !== 'string') throw new ProtocolError('协议.参数', `缺少模板“${name}”`);
    return trimNewlines(templates[name]).replace(/\{\{([^{}]*)\}\}/gu, (match, key) => {
      if (!has(values, key)) throw new ProtocolError('模板.占位符', `未知模板占位符“${key}”`);
      return String(values[key]);
    });
  }).join('\n\n');
}
