import {createCalendar} from './calendar.mjs';
import {analyzeEventTree, chainStructure} from './graph.mjs';
import {codepointCompare, isMap, isText, list, pairs} from './utils.mjs';

export class TreeExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TreeExportError';
    this.code = code;
  }
}

// 纯静态台词统计：只对照 作者资料/出处 的记录区分原台词与作者台词，不读取、不扫描 来源资料/。
export function summarizeQuotes(catalog = {}) {
  const speechRecords = new Set();
  let speechRecordCount = 0;
  const eventSources = new Set();
  for (const record of list(catalog.sources?.记录)) {
    const value = isMap(record?.内容) ? record.内容 : null;
    if (!value) continue;
    if (isText(value.事件ID) && isText(value.角色组ID) && isText(value.台词)) {
      speechRecords.add(`${value.事件ID}\u0000${value.角色组ID}\u0000${value.台词}`);
      speechRecordCount++;
    } else if (isText(value.事件ID) && !hasKey(value, '角色组ID') && !hasKey(value, '台词') && isText(value.来源)) {
      eventSources.add(value.事件ID);
    }
  }
  const total = {事件总数: 0, 有角色位置事件数: 0, 角色位置总数: 0, 有台词角色位置数: 0, 缺台词角色位置数: 0,
    候选台词总数: 0, 原台词数: 0, 作者台词数: 0, 原台词占比: 0, 有事件级出处事件数: 0, 台词记录总数: 0};
  const byGroup = new Map(), byEvent = [];
  for (const event of list(catalog.events)) {
    if (list(event.角色位置).length) total.有角色位置事件数++;
    total.事件总数++;
    if (eventSources.has(event.id)) total.有事件级出处事件数++;
    const eventCount = {事件ID: event.id, 事件标题: event.内容?.事件标题 ?? event.id, 有事件级出处: eventSources.has(event.id),
      角色位置数: 0, 有台词角色位置数: 0, 候选台词总数: 0, 原台词数: 0, 作者台词数: 0};
    for (const position of list(event.角色位置)) {
      const groupID = position?.内容?.角色组ID ?? position?.角色组ID;
      total.角色位置总数++;
      eventCount.角色位置数++;
      if (!byGroup.has(groupID)) byGroup.set(groupID, {角色组ID: groupID,
        显示名: list(catalog.groups).find(group => group.id === groupID)?.内容?.显示名 ?? groupID,
        角色位置数: 0, 有台词角色位置数: 0, 候选台词总数: 0, 原台词数: 0, 作者台词数: 0, 原台词占比: 0});
      const groupCount = byGroup.get(groupID);
      groupCount.角色位置数++;
      const quotes = list(position?.内容?.事件触发语料)
        .flatMap(dialogue => list(dialogue?.候选台词).filter(isText));
      if (quotes.length) {
        total.有台词角色位置数++;
        eventCount.有台词角色位置数++;
        groupCount.有台词角色位置数++;
      }
      for (const quote of quotes) {
        total.候选台词总数++;
        eventCount.候选台词总数++;
        groupCount.候选台词总数++;
        if (speechRecords.has(`${event.id}\u0000${groupID}\u0000${quote}`)) { total.原台词数++; eventCount.原台词数++; groupCount.原台词数++; }
        else { total.作者台词数++; eventCount.作者台词数++; groupCount.作者台词数++; }
      }
    }
    byEvent.push(eventCount);
  }
  total.缺台词角色位置数 = total.角色位置总数 - total.有台词角色位置数;
  total.台词记录总数 = speechRecordCount;
  total.原台词占比 = total.候选台词总数 === 0
    ? 0 : Number((total.原台词数 / total.候选台词总数).toFixed(4));
  const groups = [...byGroup.values()].sort((left, right) => codepointCompare(left.角色组ID, right.角色组ID));
  for (const group of groups) group.原台词占比 = group.候选台词总数 === 0
    ? 0 : Number((group.原台词数 / group.候选台词总数).toFixed(4));
  return {总计: total, 按角色组: groups, 按事件: byEvent.sort((left, right) => codepointCompare(left.事件ID, right.事件ID))};
}

export function exportEventTreeMarkdown(catalog, decl = {}, options = {}) {
  const analysis = analyzeEventTree(catalog, decl);
  const quotes = summarizeQuotes(catalog);
  const calendar = isMap(decl?.calendar) ? createCalendar(decl.calendar) : null;
  const chains = list(catalog?.chains);
  const events = list(catalog?.events);
  const chainMembers = new Set(chains.flatMap(chain => list(chain.内容?.事件)));
  const eventsById = new Map(events.map(event => [event.id, event]));
  const quotesByEvent = new Map(quotes.按事件.map(item => [item.事件ID, item]));
  const title = isText(options.标题) ? options.标题 : '世界书';
  const eventOrder = sortedEvents(events, calendar);
  const orderIndex = new Map(eventOrder.map((event, index) => [event.id, index]));
  const independent = eventOrder.filter(event => !chainMembers.has(event.id));

  const lines = [`# 事件树：${title}`, ''];
  const reachableCount = events.filter(event => analysis.reachable.has(event.id)).length;
  lines.push('| 指标 | 值 |', '|---|---|',
    `| 事件 | ${events.length} |`,
    `| 事件串 | ${chains.length} |`,
    `| 独立事件 | ${independent.length} |`,
    `| 可达事件 | ${reachableCount} |`,
    `| 不可达事件 | ${events.length - reachableCount} |`,
    `| 候选台词 | ${quotes.总计.候选台词总数} |`,
    `| 原台词 | ${quotes.总计.原台词数}（占比 ${percent(quotes.总计.原台词占比)}） |`,
    `| 作者台词 | ${quotes.总计.作者台词数} |`,
    `| 事件级出处 | ${quotes.总计.有事件级出处事件数} 个事件 |`,
    `| 结构异常 | ${analysis.issues.length} |`,
    '');

  lines.push('## 事件串', '');
  if (chains.length) {
    for (const chain of chains.slice().sort((left, right) => codepointCompare(left.id, right.id))) {
      const structure = chainStructure(catalog, chain, analysis);
      lines.push(`### 事件串：${chain.id}`, '',
        `概述：${isText(chain.内容?.概述) ? chain.内容.概述 : '（缺概述）'}`,
        `起点：${structure.起点.length ? structure.起点.join('、') : '无'}`);
      const endings = structure.结局.map(ending => `${ending.事件ID}${ending.分支ID ? `（分支 ${ending.分支ID}）` : ''}`
        + (structure.结局可达.some(item => item.事件ID === ending.事件ID && item.分支ID === ending.分支ID) ? '' : '（不可达）'));
      lines.push(`结局：${endings.length ? endings.join('、') : '无'}`,
        `孤立成员：${structure.孤立成员.length ? structure.孤立成员.join('、') : '无'}`,
        '成员事件：');
      for (const id of orderedMembers(structure, orderIndex)) lines.push(...eventBlock(eventsById.get(id), analysis, quotesByEvent, '####'));
    }
  } else lines.push('无', '');
  lines.push('');

  lines.push('## 独立事件', '');
  if (independent.length) for (const event of independent) lines.push(...eventBlock(event, analysis, quotesByEvent, '###'));
  else lines.push('无');
  lines.push('');

  lines.push('## 台词统计', '');
  lines.push('| 角色组 | 角色位置 | 有台词 | 候选台词 | 原台词 | 作者台词 | 原台词占比 |', '|---|---|---|---|---|---|---|');
  for (const group of quotes.按角色组) lines.push(`| ${group.显示名} | ${group.角色位置数} | ${group.有台词角色位置数} | ${group.候选台词总数} | `
    + `${group.原台词数} | ${group.作者台词数} | ${percent(group.原台词占比)} |`);
  if (!quotes.按角色组.length) lines.push('| （无角色位置） | 0 | 0 | 0 | 0 | 0 | 0.00% |');
  const missing = missingPositions(events);
  lines.push('', `缺台词角色位置（${missing.length}）：`);
  if (missing.length) for (const item of missing) lines.push(`- ${item.事件ID}／${item.角色组ID}`);
  else lines.push('- 无');
  lines.push('');

  lines.push('## 结构异常', '');
  if (analysis.issues.length) {
    lines.push('| 规则 | 级别 | 文件 | 说明 |', '|---|---|---|---|');
    for (const item of analysis.issues) lines.push(`| ${item.规则} | ${item.级别} | ${item.文件} | ${item.说明} |`);
  } else lines.push('无');
  return `${lines.join('\n')}\n`;
}

function eventBlock(event, analysis, quotesByEvent, heading) {
  if (!event) return ['（事件不存在）'];
  const content = event.内容 ?? {};
  const references = analysis.references.get(event.id) ?? [];
  const positive = [...new Set(references.filter(item => !item.排斥).map(item => item.事件ID))].sort(codepointCompare);
  const excluded = [...new Set(references.filter(item => item.排斥).map(item => item.事件ID))].sort(codepointCompare);
  const branches = list(content.分支);
  const reachableBranches = branches.filter(branch => analysis.branchReachable.get(event.id)?.has(branch?.分支ID))
    .map(branch => branch.分支ID);
  const quotes = quotesByEvent.get(event.id);
  const lines = [`${heading} 事件：${event.id}`, '',
    `- 事件标题：${isText(content.事件标题) ? content.事件标题 : '（缺标题）'}`,
    `- 时间窗口：${text(content.触发时间?.最早) ?? '未知'} 至 ${text(content.触发时间?.最晚) ?? '未知'}`,
    `- 主类型：${text(content.主类型) ?? '未知'}｜标签：${texts(content.标签)}`,
    `- 事件结果：${texts(content.事件结果)}`,
    `- 确认策略：${text(content.确认策略) ?? '未知'}`,
    `- 核心参与者：${texts(content.核心参与者)}`,
    `- 地点：${texts(content.地点)}`,
    `- 正向前置：${positive.length ? positive.map(id => `事件:${id}`).join('、') : '无'}`,
    `- 排斥依赖：${excluded.length ? excluded.map(id => `事件:${id}`).join('、') : '无'}`,
    `- 可达状态：${analysis.reachable.has(event.id) ? '可达' : '不可达'}`
      + `（分支可达：${reachableBranches.length ? reachableBranches.join('、') : '无'}）`,
    '- 分支：'];
  if (branches.length) for (const branch of branches) lines.push(`  - ${branch?.分支ID ?? '（缺分支ID）'}${content.默认分支 === branch?.分支ID ? '（默认）' : ''}`
    + `：变化 ${list(branch?.变化).length} 条`);
  else lines.push('  - 无');
  lines.push(`- 台词：候选 ${quotes?.候选台词总数 ?? 0}、原台词 ${quotes?.原台词数 ?? 0}、作者台词 ${quotes?.作者台词数 ?? 0}`, '');
  return lines;
}

function sortedEvents(events, calendar) {
  const key = event => {
    const earliest = calendar?.time(event?.内容?.触发时间?.最早)?.[0] ?? Infinity;
    const latest = calendar?.time(event?.内容?.触发时间?.最晚)?.[1] ?? Infinity;
    return [earliest, latest, event?.id ?? ''];
  };
  return events.slice().sort((left, right) => {
    const [la, lb, lid] = key(left), [ra, rb, rid] = key(right);
    return la - ra || lb - rb || codepointCompare(lid, rid);
  });
}

function orderedMembers(structure, orderIndex) {
  const pending = new Set(structure.成员), emitted = [], order = id => orderIndex.get(id) ?? Infinity;
  while (pending.size) {
    const ready = [...pending].filter(id => [...structure.依赖.get(id) ?? []].every(dep => !pending.has(dep)))
      .sort((left, right) => order(left) - order(right) || codepointCompare(left, right));
    const batch = ready.length ? ready : [...pending].sort((left, right) => order(left) - order(right) || codepointCompare(left, right));
    for (const id of batch) { emitted.push(id); pending.delete(id); }
  }
  return emitted;
}

function missingPositions(events) {
  const result = [];
  for (const event of events) for (const position of list(event.角色位置)) {
    const quotes = list(position?.内容?.事件触发语料).flatMap(dialogue => list(dialogue?.候选台词).filter(isText));
    if (!quotes.length) result.push({事件ID: event.id, 角色组ID: position?.内容?.角色组ID ?? position?.角色组ID ?? '未知'});
  }
  return result.sort((left, right) => codepointCompare(left.事件ID, right.事件ID)
    || codepointCompare(left.角色组ID, right.角色组ID));
}

function texts(value) {
  return Array.isArray(value) && value.length && value.every(isText) ? value.join('、') : '无';
}

function text(value) { return isText(value) ? value : null; }

function percent(value) { return `${(Number(value) * 100).toFixed(2)}%`; }

function hasKey(value, key) { return isMap(value) && Object.hasOwn(value, key); }
