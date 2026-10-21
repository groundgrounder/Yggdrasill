// 从世界书目录读取运行目录。parse 为 YAML 解析函数（同步或异步）；fs、path 由宿主注入，便于在浏览器或酒馆环境复用。
import {LAYOUT, PROFILE_FILES} from './contract.mjs';
import {unwrap} from './yaml.mjs';

export async function loadCatalog(root, parse, fs, path) {
  const read = async rel => {
    const raw = await fs.readFile(path.join(root, rel), 'utf8');
    return (await parse(unwrap(raw))) ?? {};
  };
  const exists = rel => fs.access(path.join(root, rel)).then(() => true, () => false);
  const groups = [];
  for (const r of (await read(LAYOUT.roleIndex)).角色组) {
    const base = path.posix.dirname(LAYOUT.roleIndex);
    const g = await read(base + '/' + r.入口), dir = path.dirname(base + '/' + r.入口);
    g.files = {};
    for (const p of g.档案) {
      g.files[p.档案ID] = {};
      for (const kind of PROFILE_FILES) {
        const rel = `${dir}/档案/${p.档案ID}/${kind}.txt`;
        if (await exists(rel)) g.files[p.档案ID][kind] = await read(rel);
      }
    }
    if (await exists(`${dir}/${LAYOUT.growthTree}`)) g.growth = await read(`${dir}/${LAYOUT.growthTree}`);
    groups.push(g);
  }
  const events = [], storylines = [];
  const historyDir = path.posix.dirname(LAYOUT.historyIndex);
  const readEvents = async (dir, label) => {
    for (const ev of label.事件 || []) {
      const base = `${dir}/${ev.路径.replace(/\/$/, '')}`, e = await read(base + '/事件.txt');
      e.角色位置 = {};
      const posDir = path.join(root, base, '角色');
      if (await exists(base + '/角色')) for (const f of await fs.readdir(posDir)) e.角色位置[path.basename(f, '.txt')] = await read(`${base}/角色/${f}`);
      e.目录 = base;
      events.push(e);
    }
  };
  for (const entry of (await read(LAYOUT.historyIndex)).入口) {
    const dir = path.dirname(historyDir + '/' + entry), label = await read(historyDir + '/' + entry);
    if (entry === LAYOUT.storylineIndex) storylines.push(...label.剧情线 || []);
    else await readEvents(dir, label);
  }
  // 技能、装备沿索引逐层读取。
  const walk = async (indexRel, visit, {withDescription = false} = {}) => {
    const idx = await read(indexRel), dir = path.dirname(indexRel);
    for (const entry of [...(withDescription ? [idx.说明] : []), ...(idx.入口 || [])].filter(Boolean)) {
      const rel = `${dir}/${entry}`;
      if (entry.endsWith(LAYOUT.indexSuffix)) await walk(rel, visit, {withDescription});
      else visit(rel, await read(rel));
    }
  };
  const skills = [], equipment = [], locations = [];
  if (await exists(LAYOUT.skillIndex)) await walk(LAYOUT.skillIndex, (rel, s) => {
    if (s.技能ID) skills.push({技能ID: s.技能ID, 名称: s.名称, 来源: s.来源, 类别: s.类别, 体系: s.体系, 技能等级: s.技能等级, 路径: rel, 正文: s});
  });
  if (await exists(LAYOUT.equipmentIndex)) await walk(LAYOUT.equipmentIndex, (rel, e) => { if (e.装备ID) equipment.push({...e, 路径: rel}); });
  // 地点的父级由目录推导；地理索引的说明文件也是地点。
  if (await exists(LAYOUT.geographyIndex)) await walk(LAYOUT.geographyIndex, (rel, d) => {
    if (d.地点ID) locations.push({地点ID: d.地点ID, 类型: d.类型, 父级: parentFromPath(rel), 路径: rel, 正文: d});
  }, {withDescription: true});
  const meta = await exists(LAYOUT.systemsMeta) ? await read(LAYOUT.systemsMeta) : {};
  const systems = [...new Set([...(meta.一般体系 || []), ...(meta.固有或特殊体系 || [])])];
  return {groups, events, skills, equipment, locations, storylines, systems};
}

// 地点的父级由目录推导：同名说明文件的父级是上上级目录，其它文件的父级是所在目录；到达地理根即为顶层。
export function parentFromPath(rel) {
  const parts = rel.split('/'), name = parts.at(-1).replace(/\.txt$/, ''), dirs = parts.slice(0, -1);
  const up = name === dirs.at(-1) ? dirs.slice(0, -1) : dirs;
  return up.length <= 1 ? null : up.at(-1);
}
