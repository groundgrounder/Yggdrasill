import {parseYaml} from './yaml.mjs';
import {DECLARATION_FILES, TEXT_CONTAINERS} from './contract.mjs';
import {has, isMap, list, issue} from './utils.mjs';

export async function loadWorldbook(root, {fs, path, decl}) {
  const catalog = {entries: {}, descriptions: [], groups: [], texts: [], eventIds: [], files: [], directories: []};
  const issues = [];
  const libraries = decl?.libraries ?? {};
  for (const name of Object.keys(libraries)) Object.defineProperty(catalog.entries, name, {value: [], enumerable: true});
  function classify(parts, stem) {
    const top = parts[0];
    if (top === '历史') return '历史';
    if (top === '设定' && parts.length === 2 && DECLARATION_FILES.includes(stem)) return '设定';
    if (top === '角色' && parts.length === 3 && stem === '角色组') return '角色组文件';
    if (top === '角色' && parts.length === 5 && parts[2] === '档案' && ['基本信息', '角色印象'].includes(stem)) return '档案文件';
    if (TEXT_CONTAINERS.includes(top)) return '文本容器文件';
    if (has(libraries, top) && parts.length >= 2) {
      const directory = parts.length === 2 ? top : parts.at(-2);
      if ((libraries[top]?.分法 === '按种类' && stem === directory)
        || (parts.length === 2 && stem === top)) return '条目库说明';
      return '条目库实例';
    }
    return '未知';
  }
  async function walk(parts) {
    const relative = parts.join('/');
    let children;
    try { children = await fs.readdir(path.join(root, ...parts), {withFileTypes: true}); }
    catch { issues.push(issue('目录.读取失败', '错误', relative || '.', '无法读取目录')); return; }
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const next = [...parts, child.name], file = next.join('/');
      if (child.isDirectory()) {
        catalog.directories.push(file);
        await walk(next);
        continue;
      }
      if (!child.isFile()) { issues.push(issue('目录.读取失败', '错误', file, '不读取符号链接或特殊文件')); continue; }
      const extension = path.extname(child.name), stem = child.name.slice(0, child.name.length - extension.length);
      const kind = classify(next, stem);
      const record = {文件: file, 种类: kind, 扩展名: extension, 原文: null, 内容: null};
      if (['.txt', '.yaml'].includes(extension) && kind !== '历史') {
        try { record.原文 = await fs.readFile(path.join(root, ...next), 'utf8'); }
        catch { issues.push(issue('目录.读取失败', '错误', file, '无法读取文件')); }
        if (record.原文 !== null) {
          try { record.内容 = parseYaml(record.原文); }
          catch { issues.push(issue('目录.YAML错误', '错误', file, 'YAML 解析失败或含重复键、循环别名')); }
        }
      }
      catalog.files.push(record);
      if (kind === '条目库说明') catalog.descriptions.push(record);
      if (kind === '文本容器文件') catalog.texts.push(record);
      if (kind === '条目库实例') {
        const hierarchy = next.slice(1, -1);
        const parent = libraries[next[0]]?.分法 === '按上下级'
          ? (stem === hierarchy.at(-1) ? hierarchy.at(-2) : hierarchy.at(-1)) ?? null : null;
        catalog.entries[next[0]].push({id: stem, 文件: file, 层级目录: hierarchy, 上级: parent, 内容: record.内容,
          原文: record.原文, 同名说明: libraries[next[0]]?.分法 === '按上下级' && stem === hierarchy.at(-1)});
      }
    }
  }
  await walk([]);
  catalog.eventIds = catalog.directories.filter(directory => {
    const parts = directory.split('/');
    return parts.length === 3 && parts[0] === '历史' && parts[1] === '事件';
  }).map(directory => directory.split('/').at(-1));
  for (const directory of catalog.directories.filter(value => value.startsWith('角色/') && value.split('/').length === 2)) {
    const id = directory.split('/')[1], file = `${directory}/角色组.yaml`;
    const record = catalog.files.find(value => value.文件 === file);
    const content = record?.内容;
    const versions = isMap(content) && has(content, '版本')
      ? list(content.版本).map(version => version?.版本ID).filter(value => typeof value === 'string') : [id];
    const profiles = catalog.directories.filter(value => value.startsWith(`${directory}/档案/`) && value.split('/').length === 4).map(folder => {
      const basic = catalog.files.find(value => value.文件 === `${folder}/基本信息.txt`);
      const impression = catalog.files.find(value => value.文件 === `${folder}/角色印象.txt`);
      return {id: folder.split('/').at(-1), 目录: folder, 基本信息: basic?.内容 ?? null, 角色印象: impression?.内容 ?? null,
        原文: {基本信息: basic?.原文 ?? null, 角色印象: impression?.原文 ?? null}};
    });
    catalog.groups.push({id, 文件: file, 内容: content ?? null, 版本清单: versions, 档案: profiles});
  }
  return {catalog, issues};
}
