// 作者视图的数据投影：只读现行世界书，复用 core/checker，不另造解析器或路径计算。
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {createHash} from 'node:crypto';
import {readDeclarations, validateDeclarations} from '../core/declarations.mjs';
import {loadWorldbook} from '../core/catalog.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {analyzeEventTree, chainStructure, impactOf} from '../core/graph.mjs';
import {buildReferenceIndex, queryReference} from '../core/references.mjs';
import {readSettings, DEFAULT_SETTINGS} from '../core/settings.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {codepointCompare, has, isMap, isText, list, pairs} from '../core/utils.mjs';
import {checkWorldbook, issue} from '../checker/index.mjs';

export const digest = text => createHash('sha256').update(text).digest('hex');

const ORDER = (left, right) => codepointCompare(String(left), String(right));
const EMPTY_ANALYSIS = Object.freeze({reachable: new Set(), branchReachable: new Map(), issues: [],
  references: new Map(), byID: new Map()});
const EMPTY_INDEX = Object.freeze({objects: [], references: [], issues: [], query: () => null});

function safe(value, fallback) {
  try { return value(); }
  catch (error) { return typeof fallback === 'function' ? fallback(error) : fallback; }
}

function projectRoot(root) { return defaultPath.dirname(root); }

function calendarInfo(decl) {
  const declaration = decl?.calendar;
  if (!isMap(declaration)) return {calendar: null, info: null, error: '缺少纪年声明'};
  try {
    const calendar = createCalendar(declaration);
    const months = Array.isArray(declaration.每月天数)
      ? [...declaration.每月天数] : Array(declaration.月数).fill(declaration.每月天数);
    const yearDays = months.reduce((sum, days) => sum + days, 0);
    return {calendar: Object.assign(calendar, {yearDays}),
      info: {前缀: declaration.前缀, 年位数: declaration.年位数, 月数: declaration.月数,
        每月天数: months, 年天数: yearDays, 表达式: calendar.pattern}, error: null};
  }
  catch (error) { return {calendar: null, info: null, error: error.message}; }
}

async function readPending(root, {fs, path}) {
  const file = path.join(path.dirname(root), '作者资料', '暂存', '暂存清单.yaml');
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {items: [], file: null, issues: []};
    return {items: [], file: '作者资料/暂存/暂存清单.yaml',
      issues: [issue('视图.暂存', '错误', '作者资料/暂存/暂存清单.yaml', '无法读取暂存清单')]};
  }
  try {
    const value = parseYaml(raw);
    if (!Array.isArray(value)) return {items: [], file: '作者资料/暂存/暂存清单.yaml',
      issues: [issue('视图.暂存', '错误', '作者资料/暂存/暂存清单.yaml', '暂存清单须为列表')]};
    return {items: value.filter(isMap), file: '作者资料/暂存/暂存清单.yaml', issues: []};
  }
  catch {
    return {items: [], file: '作者资料/暂存/暂存清单.yaml',
      issues: [issue('视图.暂存', '错误', '作者资料/暂存/暂存清单.yaml', '暂存清单的 YAML 不合法')]};
  }
}

/**
 * 读取一个世界书项目并建立只读索引。预览、保存与页面数据共用这一入口。
 */
export async function loadProject(root, {fs = defaultFs, path = defaultPath} = {}) {
  root = path.resolve(root);
  const {raw, issues: readIssues} = await readDeclarations(root, {fs, path});
  const compiled = validateDeclarations(raw);
  const {catalog, issues: loadIssues} = await loadWorldbook(root, {fs, path, decl: compiled.decl});
  const decl = compiled.decl;
  const issues = [...readIssues, ...compiled.issues, ...loadIssues];
  const {calendar, info: calendarMeta, error: calendarError} = calendarInfo(decl);

  let settings = structuredClone(DEFAULT_SETTINGS), settingsSource = '默认', settingsError = null;
  const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
  try { await fs.access(settingsFile); settingsSource = 'yggdrasill.yaml'; }
  catch { /* 没有项目运行参数时使用默认值 */ }
  try { settings = await readSettings(path.dirname(root), {fs, path, decl}); }
  catch (error) { settingsError = error.message; }

  const analysis = safe(() => analyzeEventTree(catalog, decl), EMPTY_ANALYSIS);
  const index = safe(() => buildReferenceIndex(catalog, decl, {issues}), EMPTY_INDEX);
  const pending = await readPending(root, {fs, path});
  return {root, projectRoot: path.dirname(root), decl, raw, catalog, issues, analysis, index,
    settings, settingsSource, settingsError, calendar, calendarMeta, calendarError, pending};
}

function eventTime(content, calendar) {
  const earliest = isMap(content?.触发时间) ? content.触发时间.最早 : null;
  const latest = isMap(content?.触发时间) ? content.触发时间.最晚 : null;
  const from = calendar && earliest ? calendar.time(earliest) : null;
  const to = calendar && latest ? calendar.time(latest) : null;
  return {
    最早: isText(earliest) ? earliest : null,
    最晚: isText(latest) ? latest : null,
    start: from ? from[0] : null,
    end: to ? to[1] : null,
    startYear: from && calendar ? Math.floor(from[0] / calendar.yearDays) : null,
    endYear: to && calendar ? Math.floor(to[1] / calendar.yearDays) : null,
  };
}

function changeRows(event, groupID) {
  const rows = [];
  for (const [branchIndex, branch] of list(event.内容?.分支).entries()) {
    if (!isMap(branch)) continue;
    for (const [changeIndex, change] of list(branch.变化).entries()) {
      if (!isMap(change) || !isText(change.路径)) continue;
      const parts = change.路径.split('.');
      if (parts[0] !== '角色' || parts[1] !== groupID) continue;
      rows.push({事件ID: event.id, 事件标题: event.内容?.事件标题 ?? event.id, 文件: event.文件,
        分支ID: isText(branch.分支ID) ? branch.分支ID : `分支${branchIndex + 1}`,
        默认分支: event.内容?.默认分支 ?? null, 序号: changeIndex + 1,
        路径: change.路径, 操作: change.操作 ?? null, 值: has(change, '值') ? change.值 : null});
    }
  }
  return rows;
}

function relatedGroups(event, index) {
  const groups = new Set(list(event.内容?.核心参与者).filter(isText));
  for (const position of list(event.角色位置)) if (isText(position.角色组ID)) groups.add(position.角色组ID);
  for (const relation of list(index.references)) {
    if (relation.来源对象 !== `事件:${event.id}` || relation.目标类型 !== '角色组') continue;
    if (isText(relation.目标对象) && relation.目标对象.startsWith('角色组:')) groups.add(relation.目标对象.slice(4));
  }
  return [...groups].sort(ORDER);
}

function structural(event, analysis) {
  if (!analysis || !(analysis.reachable instanceof Set)) return {状态: '未解析', 可达: false, 分支: [], 异常: []};
  const reachable = analysis.reachable.has(event.id);
  const branchSet = analysis.branchReachable?.get?.(event.id) ?? new Set();
  const issues = list(analysis.issues).filter(item => item?.文件 === event.文件
    || (typeof item?.说明 === 'string' && item.说明.includes(event.id)));
  return {
    状态: reachable ? '可达' : '不可达',
    可达: reachable,
    分支: list(event.内容?.分支).filter(isMap).map(branch => ({
      分支ID: branch.分支ID ?? null, 可达: branchSet.has(branch.分支ID),
    })),
    异常: issues,
  };
}

function versionInfo(group) {
  const versions = list(group.内容?.版本);
  if (!versions.length) return [{版本ID: group.id, 显示名: group.内容?.显示名 ?? group.id, 别名: [], 简介: null}];
  return versions.filter(isMap).map(version => ({
    版本ID: version.版本ID, 显示名: version.显示名 ?? version.版本ID, 别名: list(version.别名),
    简介: isText(version.简介) ? version.简介 : null,
  }));
}

function groupProjection(group, catalog, pending) {
  const content = group.内容 ?? {};
  const versions = versionInfo(group);
  const registrationByID = new Map(list(content.档案).filter(isMap).map(item => [item.档案ID, item]));
  const profiles = list(group.档案).map(profile => {
    const registration = registrationByID.get(profile.id) ?? {};
    const documents = {};
    for (const kind of ['基本信息', '角色印象']) {
      const raw = profile.原文?.[kind] ?? null;
      if (raw !== null) documents[kind] = {原文: raw, 文件: `${profile.目录}/${kind}.txt`};
    }
    return {
      档案ID: profile.id, 目录: profile.目录, 文件: `${profile.目录}/`,
      适用版本: list(registration.适用版本).length ? list(registration.适用版本) : versions.map(value => value.版本ID),
      默认: registration.默认 === true,
      前置档案: isText(registration.前置档案) ? registration.前置档案 : null,
      生效条件: registration.生效条件 ?? null,
      初始能力: registration.初始能力 ?? null,
      初始装备: registration.初始装备 ?? null,
      文档: documents,
    };
  });
  const changes = [];
  for (const event of list(catalog.events)) changes.push(...changeRows(event, group.id));
  changes.sort((left, right) => ORDER(left.事件ID, right.事件ID) || ORDER(left.分支ID, right.分支ID)
    || left.序号 - right.序号);
  const groupPending = list(pending.items).filter(item => {
    const location = typeof item.接回位置 === 'string' ? item.接回位置 : '';
    const id = typeof item.ID === 'string' ? item.ID : '';
    return location.includes(`角色/${group.id}/`) || location === `角色/${group.id}`
      || id.includes(group.id) || (isText(content.显示名) && id.includes(content.显示名));
  });
  return {
    角色组ID: group.id, 文件: group.文件, 显示名: content.显示名 ?? group.id,
    别名: list(content.别名), 角色包: content.角色包 ?? null, 分类: content.分类 ?? null,
    默认启用: content.默认启用 !== false, 默认版本: content.默认版本 ?? group.id,
    初始化方式: content.初始化方式 ?? null, 初始所在: content.初始所在 ?? null,
    版本: versions, 档案: profiles, 事件变化: changes, 暂存: groupPending,
    档案文件: profiles.reduce((sum, profile) => sum + Object.keys(profile.文档).length, 0),
  };
}

function eventProjection(event, catalog, index, analysis, calendar) {
  const content = isMap(event.内容) ? event.内容 : {};
  const classification = {
    主类型: isText(content.主类型) ? content.主类型 : null,
    标签: list(content.标签).filter(isText),
    事件结果: list(content.事件结果).filter(isText),
  };
  const branches = list(content.分支).filter(isMap).map(branch => ({
    分支ID: branch.分支ID ?? null, 门槛: branch.门槛 ?? null, 分支条件: branch.分支条件 ?? '',
    分支结果: branch.分支结果 ?? '', 变化: list(branch.变化).filter(isMap),
    默认: branch.分支ID === content.默认分支,
  }));
  const positions = list(event.角色位置).map(position => ({
    角色组ID: position.角色组ID ?? position.内容?.角色组ID ?? null,
    文件: position.文件, 原文: position.原文 ?? null, 内容: position.内容 ?? null,
  }));
  const chainIDs = list(catalog.chains).filter(chain => list(chain.内容?.事件).includes(event.id))
    .map(chain => chain.id).sort(ORDER);
  return {
    事件ID: event.id, 文件: event.文件, 原文: event.原文 ?? '', revision: digest(event.原文 ?? ''),
    事件标题: isText(content.事件标题) ? content.事件标题 : event.id,
    事件概要: isText(content.事件概要) ? content.事件概要 : '',
    主类型: classification.主类型, 标签: classification.标签, 事件结果: classification.事件结果,
    影响范围: isText(content.影响范围) ? content.影响范围 : '',
    触发时间: eventTime(content, calendar),
    地点: list(content.地点).filter(isText),
    确认策略: content.确认策略 ?? null,
    核心参与者: list(content.核心参与者).filter(isText),
    门槛: content.门槛 ?? null, 叙事条件: content.叙事条件 ?? null,
    默认分支: content.默认分支 ?? null, 分支: branches,
    角色位置: positions,
    关联事件: list(content.关联事件).filter(isText),
    事件串: chainIDs,
    相关角色组: relatedGroups(event, index),
    结构: structural(event, analysis),
    分类完整: Boolean(isText(content.事件标题) && isText(content.主类型)
      && list(content.标签).length && list(content.事件结果).length),
  };
}

function relationProjection(index) {
  const seen = new Set(), relations = [];
  for (const reference of list(index.references)) {
    if (reference.来源类型 !== '事件' || reference.目标类型 !== '事件') continue;
    if (!isText(reference.来源对象) || !isText(reference.目标对象)) continue;
    const from = reference.来源对象.slice(3), to = reference.目标对象.slice(3);
    const signature = JSON.stringify([from, to, reference.字段, reference.引用种类, reference.极性]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    relations.push({from, to, 来源: reference.来源对象, 目标: reference.目标对象,
      种类: reference.引用种类, 极性: reference.极性 ?? null, 字段: reference.字段,
      文件: reference.来源文件});
  }
  relations.sort((left, right) => ORDER(left.from, right.from) || ORDER(left.to, right.to)
    || ORDER(left.种类, right.种类) || ORDER(left.极性 ?? '', right.极性 ?? '') || ORDER(left.字段, right.字段));
  return relations;
}

function chainProjection(chain, catalog, analysis) {
  const structure = safe(() => chainStructure(catalog, chain, analysis), {成员: [], 依赖: new Map(), 起点: [],
    结局: [], 结局可达: [], 孤立成员: []});
  return {事件串ID: chain.id, 文件: chain.文件, 概述: chain.内容?.概述 ?? '',
    事件: list(chain.内容?.事件).filter(isText), 结局: list(chain.内容?.结局).filter(isMap).map(item => ({
      事件ID: item.事件ID ?? null, 分支ID: item.分支ID ?? null,
    })),
    结构: {起点: structure.起点 ?? [], 结局可达: (structure.结局可达 ?? []).map(item => item.事件ID ?? item),
      孤立成员: structure.孤立成员 ?? []},
  };
}

function checkProjection(result) {
  return {模式: '静态检查', 通过: !result.errors.length, 错误: result.errors.length, 提示: result.hints.length,
    摘要: result.summary, 错误列表: result.errors, 提示列表: result.hints};
}

/**
 * 为页面、预览与保存共用的完整数据面。所有写入只由 store 负责。
 */
export async function loadViewData(root, {fs = defaultFs, path = defaultPath} = {}) {
  root = path.resolve(root);
  let project, check;
  try { project = await loadProject(root, {fs, path}); }
  catch (error) {
    throw Object.assign(new Error(`无法读取世界书：${error.message}`), {status: 400, code: error.code});
  }
  try { check = await checkWorldbook(root, {sampling: false, fs, path}); }
  catch (error) {
    check = {errors: [issue('视图.检查失败', '错误', '.', `检查器外层失败：${error.message}`)], hints: [],
      summary: {错误: 1, 提示: 0, 文件: 0, 角色组: 0, 档案: 0, 条目: 0, 事件: 0}};
  }
  const {catalog, decl, analysis, index, calendar, calendarMeta, pending} = project;
  const events = list(catalog.events).map(event => eventProjection(event, catalog, index, analysis, calendar))
    .sort((left, right) => (left.触发时间.start ?? Infinity) - (right.触发时间.start ?? Infinity)
      || ORDER(left.事件ID, right.事件ID));
  const chains = list(catalog.chains).map(chain => chainProjection(chain, catalog, analysis)).sort((a, b) => ORDER(a.事件串ID, b.事件串ID));
  const groups = list(catalog.groups).map(group => groupProjection(group, catalog, pending)).sort((a, b) => ORDER(a.角色组ID, b.角色组ID));
  const libraries = {};
  for (const [name, entries] of pairs(catalog.entries)) libraries[name] = {数量: list(entries).length,
    标识: list(entries).map(entry => entry.id).sort(ORDER)};
  return {
    元数据: {
      世界书: root, 项目根: project.projectRoot,
      日历: calendarMeta, 日历错误: project.calendarError,
      运行参数: {来源: project.settingsSource, 值: project.settings, 错误: project.settingsError},
      检查: checkProjection(check),
      计数: {事件: events.length, 事件串: chains.length, 角色组: groups.length,
        档案: groups.reduce((sum, group) => sum + group.档案.length, 0),
        条目: Object.values(libraries).reduce((sum, library) => sum + library.数量, 0),
        文件: list(catalog.files).length},
      数据异常: project.issues,
      引用异常: list(index.issues),
      暂存: {文件: pending.file, 数量: pending.items.length, 异常: pending.issues},
    },
    事件: events, 事件串: chains, 角色组: groups, 关系: relationProjection(index),
    开局: {
      选项: catalog.openingOptions ? {文件: catalog.openingOptions.文件, 内容: catalog.openingOptions.内容} : null,
      方案: list(catalog.openingPlans).map(plan => ({方案ID: plan.id, 文件: plan.文件,
        概述: plan.内容?.概述 ?? '', 开局时间: plan.内容?.开局时间 ?? null,
        角色组: plan.内容?.角色组 ?? null, 历史选择: plan.内容?.历史选择 ?? null}))
        .sort((left, right) => ORDER(left.方案ID, right.方案ID)),
    },
    分类: {
      主类型: list(decl.classification?.主类型), 世界事件: decl.classification?.世界事件 ?? null,
      标签: list(decl.classification?.标签), 事件结果: Object.keys(isMap(decl.classification?.事件结果)
        ? decl.classification.事件结果 : {}).sort(ORDER),
    },
    条目库: libraries,
    暂存: pending.items,
  };
}

export {queryReference, impactOf};
