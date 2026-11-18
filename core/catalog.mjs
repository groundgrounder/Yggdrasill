import {parseYaml} from './yaml.mjs';
import {readDeclarations, validateDeclarations} from './declarations.mjs';
import {DECLARATION_FILES, TEXT_CONTAINERS} from './contract.mjs';
import {has, isMap, list, issue} from './utils.mjs';

function historicalKind(parts) {
  if (parts.length === 1 && parts[0] === '历史') return '历史';
  if (parts[0] === '历史') return '历史';
  return null;
}

// 平台无关的三步加载入口：调用方注入 fs/path，浏览器与内存文件系统可直接复用。
export async function compileWorldbook(root, {fs, path} = {}) {
  if (!fs || !path) throw new Error('compileWorldbook 需要注入 {fs, path}');
  const {raw, issues: readIssues} = await readDeclarations(root, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(root, {fs, path, decl: compiled.decl});
  return {raw, compiled, decl: compiled.decl, catalog, readIssues, loadIssues,
    issues: [...readIssues, ...compiled.issues, ...loadIssues]};
}

export async function loadWorldbook(root, {fs, path, decl}) {
  const catalog = {entries: {}, descriptions: [], groups: [], texts: [], events: [], chains: [], openingOptions: null,
    openingPlans: [], sources: null, eventIds: [], files: [], directories: []};
  const issues = [];
  const libraries = decl?.libraries ?? {};
  for (const name of Object.keys(libraries)) Object.defineProperty(catalog.entries, name, {value: [], enumerable: true});
  function classify(parts, stem) {
    const top = parts[0];
    if (historicalKind(parts)) return '历史';
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
      if (['.txt', '.yaml'].includes(extension)) {
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
  catalog.events = catalog.eventIds.map(id => {
    const directory = `历史/事件/${id}`;
    const eventRecord = catalog.files.find(record => record.文件 === `${directory}/事件.txt`);
    const positions = catalog.files.filter(record => record.文件.startsWith(`${directory}/角色/`)
      && record.文件.split('/').length === 5 && record.扩展名 === '.txt')
      .map(record => ({角色组ID: record.文件.split('/').at(-1).slice(0, -4), 文件: record.文件, 内容: record.内容, 原文: record.原文}));
    return {id, 目录: directory, 文件: eventRecord?.文件 ?? `${directory}/事件.txt`, 内容: eventRecord?.内容 ?? null,
      原文: eventRecord?.原文 ?? null, 角色位置: positions};
  });
  catalog.chains = catalog.files.filter(record => /^历史\/事件串\/[^/]+\.yaml$/u.test(record.文件))
    .map(record => ({id: record.文件.split('/').at(-1).slice(0, -5), 文件: record.文件, 内容: record.内容}));
  const optionRecord = catalog.files.find(record => record.文件 === '历史/开局选项.yaml');
  if (optionRecord) catalog.openingOptions = {文件: optionRecord.文件, 内容: optionRecord.内容};
  catalog.openingPlans = catalog.files.filter(record => /^历史\/开局方案\/[^/]+\.yaml$/u.test(record.文件))
    .map(record => ({id: record.文件.split('/').at(-1).slice(0, -5), 文件: record.文件, 内容: record.内容}));

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

  catalog.sources = await loadSources(root, {fs, path}, issues);
  return {catalog, issues};
}

async function loadSources(root, {fs, path}, issues) {
  const directory = path.join(path.dirname(root), '作者资料', '出处');
  let children;
  try { children = await fs.readdir(directory, {withFileTypes: true}); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    issues.push(issue('目录.读取失败', '错误', '作者资料/出处', '无法读取目录'));
    return {目录: '作者资料/出处', 记录: []};
  }
  const records = [];
  children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const child of children) {
    if (child.name.startsWith('.') || !child.isFile() || path.extname(child.name) !== '.yaml') continue;
    const file = `作者资料/出处/${child.name}`;
    let content = null;
    try { content = parseYaml(await fs.readFile(path.join(directory, child.name), 'utf8')); }
    catch { issues.push(issue('目录.YAML错误', '错误', file, 'YAML 解析失败或含重复键、循环别名')); }
    if (Array.isArray(content)) content.forEach((item, index) => records.push({文件: file, 序号: index + 1, 内容: item}));
    else records.push({文件: file, 序号: 1, 内容: content});
  }
  return {目录: '作者资料/出处', 记录: records};
}
