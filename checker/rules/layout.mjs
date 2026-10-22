import {FIXED_ROOTS, RESERVED_IDS, TEXT_CONTAINERS} from '../../core/contract.mjs';
import {has, isMap, list, pairs, issue} from '../../core/utils.mjs';
import {resolveDomain, dimensionKeys} from '../../core/fields.mjs';

const add = (out, rule, file, message, level = '错误') => out.push(issue(rule, level, file, message));
const badId = id => !id || id !== id.trim() || /[./\\]/.test(id);

export function checkLayout(catalog, decl) {
  const out = [], directories = new Set(catalog.directories), files = catalog.files;
  for (const name of FIXED_ROOTS) if (!directories.has(name)) add(out, '目录.缺少固定根', name, `缺少固定目录“${name}”`);
  for (const directory of catalog.directories) {
    const top = directory.split('/')[0];
    if (!FIXED_ROOTS.includes(directory) && directory.split('/').length === 1
      && !TEXT_CONTAINERS.includes(directory) && !has(decl.libraries, directory)) add(out, '目录.未声明目录', directory, '根下目录未在声明中登记');
    if (directory.split('/').length === 1 && TEXT_CONTAINERS.includes(directory)) continue;
    if (directory.split('/').length > 1 && !FIXED_ROOTS.includes(top) && !TEXT_CONTAINERS.includes(top) && !has(decl.libraries, top)) add(out, '目录.未声明目录', directory, '目录不属于固定根或已声明条目库');
    const parts = directory.split('/');
    if (top === '历史') {
      const eventSubdirectory = parts[1] === '事件';
      if ((eventSubdirectory && parts.length === 4 && parts[3] !== '角色') || (eventSubdirectory && parts.length >= 5))
        add(out, parts.length >= 3 ? '事件.未知文件' : '目录.未知文件', directory, '事件目录下出现未规定的目录');
      else if (!['历史', '事件', '事件串', '开局方案'].includes(parts.at(-1)) && parts.length < 3)
        add(out, '目录.未知文件', directory, '历史下出现未规定的目录');
    }
    if ((top === '设定' && parts.length > 1) || (top === '角色' && parts.length > 2 && parts[2] !== '档案')
      || (top === '角色' && parts.length > 4)) add(out, '目录.未知文件', directory, '固定根下出现未规定的目录结构');
    const library = has(decl.libraries, top) ? decl.libraries[top] : null;
    if (library?.分法 === '按种类') {
      const levels = list(library.分级);
      if (parts.length - 1 > levels.length) add(out, '条目.分级', directory, '分类目录层数超出分级声明');
      for (let index = 1; index < parts.length; index++) if (!resolveDomain(library.字段?.[levels[index - 1]]?.取值, decl).includes(parts[index])) add(out, '条目.分级', directory, `分类目录“${parts[index]}”不在声明的值域内`);
    }
    if (library?.分法 === '按上下级' && parts.length > 1
      && !list(catalog.entries[top]).some(entry => entry.文件 === `${directory}/${parts.at(-1)}.txt`)) add(out, '条目.上级类型', directory, '实例目录缺少同名实例文件');
  }
  for (const directory of catalog.directories.filter(value => value.startsWith('角色/') && value.split('/').length === 2)) {
    const id = directory.split('/')[1];
    out.push(...checkId(id, directory, '角色组ID', true, decl));
  }
  for (const file of files) {
    const {文件: name, 扩展名: suffix, 种类: kind, 内容: content, 原文: source} = file;
    const parts = name.split('/');
    if (source !== null && source.split(/\r?\n/u).some(line => /^<\/?[^>\r\n]+>$/u.test(line.trim()))) {
      add(out, '目录.包裹标签', name, '源文件不能包含单独成行的包裹标签');
    }
    if (!['.txt', '.yaml'].includes(suffix)) add(out, '目录.扩展名不符', name, '扩展名只能是 .txt 或 .yaml');
    if (kind === '未知') { add(out, '目录.未知文件', name, '文件无法按世界书目录规范归类'); continue; }
    const extension = expectedExtension(kind, parts);
    if (extension && suffix !== extension) add(out, '目录.扩展名不符', name, `此类文件必须使用 ${extension}`);
    if (kind === '历史' && !validHistoryPath(parts)) add(out, parts[1] === '事件' ? '事件.未知文件' : '目录.未知文件', name, '历史下出现未规定的文件或目录');
    if (kind === '历史' && parts[1] === '事件' && parts.length >= 4 && parts[3] === '角色' && parts.length === 5 && !parts[4].endsWith('.txt')) add(out, '事件.未知文件', name, '角色目录下只能有角色位置文本文件');
    if (kind === '条目库说明') {
      if (source !== null && !hasContent(content)) add(out, '目录.空壳说明', name, '说明文件没有任何内容', '提示');
      continue;
    }
    if (kind === '条目库实例' && isMap(content)) {
      const idField = `${parts[0]}ID`;
      if (has(content, idField)) out.push(...checkId(content[idField], name, idField, true, decl));
    }
  }
  for (const eventId of catalog.eventIds) out.push(...checkId(eventId, `历史/事件/${eventId}`, '事件ID', true, decl));
  for (const [library, entries] of Object.entries(catalog.entries)) for (const entry of entries) {
    out.push(...checkId(entry.id, entry.文件, `${library}ID`, true, decl));
    const schema = decl.libraries[library];
    if (schema?.分法 === '按种类') {
      if (entry.层级目录.length !== list(schema.分级).length) add(out, '目录.未知文件', entry.文件, '条目目录层数与分级声明不符');
      for (let index = 0; index < list(schema.分级).length; index++) {
        const field = schema.分级[index], expected = entry.层级目录[index];
        if (!resolveDomain(schema.字段?.[field]?.取值, decl).includes(expected)) add(out, '条目.分级', entry.文件, `目录“${expected}”不是${field}的声明取值`);
      }
    }
  }
  for (const [id] of pairs(decl.marks)) out.push(...checkId(id, '设定/剧情标记.yaml', '剧情标记ID', false, decl));
  for (const dimension of Object.values(decl.ability.维度)) for (const id of dimensionKeys(dimension)) out.push(...checkId(id, '设定/能力.yaml', '能力键', false, decl));
  for (const group of catalog.groups) for (const profile of group.档案) out.push(...checkId(profile.id, profile.目录, '档案ID', false, decl));
  return out;
}

function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (isMap(value)) return Object.values(value).some(hasContent);
  return value !== null && value !== undefined;
}

function validHistoryPath(parts) {
  const name = parts.at(-1) ?? '';
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  if (parts.length === 2 && parts[0] === '历史' && stem === '开局选项') return true;
  if (parts.length === 3 && parts[0] === '历史' && ['事件串', '开局方案'].includes(parts[1])) return true;
  if (parts.length === 4 && parts[0] === '历史' && parts[1] === '事件' && stem === '事件') return true;
  if (parts.length === 5 && parts[0] === '历史' && parts[1] === '事件' && parts[3] === '角色') return true;
  return false;
}

function expectedExtension(kind, parts) {
  if (['设定', '角色组文件'].includes(kind)) return '.yaml';
  if (['档案文件', '文本容器文件', '条目库实例', '条目库说明'].includes(kind)) return '.txt';
  if (kind === '历史') {
    if ((parts.length === 3 && ['事件串', '开局方案'].includes(parts[1]))
      || (parts.length === 2 && parts[1].startsWith('开局选项.'))) return '.yaml';
    if ((parts.length === 4 && parts[1] === '事件') || (parts.length === 5 && parts[1] === '事件' && parts[3] === '角色')) return '.txt';
  }
  return null;
}

export function checkId(id, file, namespace, readable, decl) {
  const out = [];
  if (typeof id !== 'string' || badId(id)) add(out, '命名.非法字符', file, `${namespace}为空、含非法字符或首尾有空白`);
  if (RESERVED_IDS.includes(id)) add(out, '命名.保留字', file, `${namespace}使用了保留字“${id}”`);
  if (readable && typeof id === 'string') {
    if (/^[A-Za-z0-9_-]+$/.test(id)) add(out, '命名.编码样式', file, `${namespace}呈编码样式`, '提示');
    if ([...id].length > 12) add(out, '命名.过长', file, `${namespace}超过12字`, '提示');
  }
  const rules = decl.textRules?.ID命名 ?? {};
  for (const rule of [rules['全部'], rules[namespace]]) if (rule?.只用中文 && typeof id === 'string' && /\p{Script=Latin}/u.test(id)) add(out, '命名.本卡规则', file, `${namespace}不能含拉丁字母`);
  return out;
}
