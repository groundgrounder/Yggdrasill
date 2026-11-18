import {button, details, el, field, notice, pill, pre, section, selectOptions, svgEl} from './dom.js';
import {profileDocuments, profileMeta, renderProfileDocs} from './inspector.js';

export function renderTimeline(app, canvas) {
  const filtered = app.filteredEvents();
  if (!filtered.length) { canvas.append(el('div', {class: 'empty'}, '没有符合筛选的事件。')); return; }
  const calendar = app.state.data.元数据.日历;
  const yearDays = calendar?.年天数 || 365;
  const prefix = calendar?.前缀 || '';
  const digits = calendar?.年位数 || 4;
  const timed = filtered.filter(event => Number.isFinite(event.触发时间?.start) && Number.isFinite(event.触发时间?.end));
  const untimed = filtered.filter(event => !Number.isFinite(event.触发时间?.start) || !Number.isFinite(event.触发时间?.end));
  const starts = timed.map(event => event.触发时间.start);
  const ends = timed.map(event => event.触发时间.end);
  const minStart = starts.length ? Math.min(...starts) : 0;
  const maxEnd = ends.length ? Math.max(...ends) : 1;
  const pad = yearDays * .45;
  const left = 162;
  const pxPerYear = app.state.zoom;
  const x = day => left + ((day - minStart + pad) / yearDays) * pxPerYear;
  const width = Math.max(480, left + ((maxEnd - minStart + pad * 2) / yearDays) * pxPerYear + 120);
  const timeline = el('div', {class: 'timeline', style: {width: `${width}px`}});
  const axis = el('div', {class: 'timeline-axis'});
  const minYear = Math.floor((minStart - pad) / yearDays), maxYear = Math.ceil((maxEnd + pad) / yearDays);
  const step = Math.max(1, Math.ceil(70 / Math.max(20, pxPerYear)));
  for (let year = minYear; year <= maxYear; year += step) {
    axis.append(el('span', {class: 'timeline-tick', style: {left: `${x(year * yearDays)}px`}},
      `${prefix}${String(year).padStart(digits, '0')}`));
  }
  timeline.append(axis);

  const chainRows = (app.state.data.事件串 ?? []).map(chain => ({
    id: chain.事件串ID, label: chain.概述 || chain.事件串ID,
    events: filtered.filter(event => (event.事件串 ?? []).includes(chain.事件串ID)),
  })).filter(row => row.events.length);
  const assigned = new Set(chainRows.flatMap(row => row.events.map(event => event.事件ID)));
  const standalone = filtered.filter(event => !assigned.has(event.事件ID));
  if (standalone.length) chainRows.push({id: '__standalone', label: '独立事件', events: standalone});

  for (const row of chainRows) {
    const collapsed = app.state.collapsed.has(row.id);
    const rowNode = el('div', {class: 'timeline-row'});
    const rowStarts = row.events.map(event => event.触发时间?.start).filter(Number.isFinite);
    const rowEnds = row.events.map(event => event.触发时间?.end).filter(Number.isFinite);
    const rowMin = rowStarts.length ? Math.min(...rowStarts) : minStart;
    const rowMax = rowEnds.length ? Math.max(...rowEnds) : maxEnd;
    const label = el('button', {type: 'button', class: 'timeline-label', 'aria-expanded': collapsed ? 'false' : 'true',
      onClick: () => { if (collapsed) app.state.collapsed.delete(row.id); else app.state.collapsed.add(row.id); app.renderCanvas(); }},
      collapsed ? '▸ ' : '▾ ', row.label, el('small', {}, `${row.events.length} 个事件`));
    rowNode.append(label);
    if (collapsed) {
      rowNode.style.height = '38px';
      rowNode.append(el('div', {class: 'row-range', style: {left: `${x(rowMin)}px`, top: '17px',
        width: `${Math.max(4, x(rowMax) - x(rowMin))}px`}}));
      timeline.append(rowNode);
      continue;
    }
    const tracks = [];
    let height = 72;
    for (const event of row.events.sort((a, b) => (a.触发时间?.start ?? Infinity) - (b.触发时间?.start ?? Infinity))) {
      const start = event.触发时间?.start;
      const end = event.触发时间?.end;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const x0 = x(start), span = Math.max(2, x(end) - x0);
      let lane = tracks.findIndex(track => track + 12 <= x0);
      if (lane < 0) lane = tracks.length;
      tracks[lane] = x0 + Math.max(170, span);
      const top = 20 + lane * 74;
      const cardWidth = Math.max(160, Math.min(300, Math.max(span, 170)));
      const card = el('button', {type: 'button', class: `interval ${app.selectedEvent()?.事件ID === event.事件ID ? 'selected' : ''}`,
        style: {left: `${x0}px`, top: `${top}px`, width: `${cardWidth}px`},
        'aria-label': `${event.事件标题 ?? event.事件ID}，${app.eventTimeLabel(event)}`,
        onClick: () => app.selectEvent(event.事件ID)},
        el('strong', {}, event.事件标题 ?? event.事件ID),
        el('small', {}, app.eventTimeLabel(event)),
        el('small', {class: 'classification-line'}, [event.主类型, ...(event.标签 ?? []), ...(event.事件结果 ?? [])]
          .filter(Boolean).join(' · ') || '未分类'),
        el('small', {class: 'classification-line'}, `${event.结构?.状态 ?? '未解析'} · ${event.确认策略 ?? '无确认策略'}`));
      rowNode.append(card);
      rowNode.append(el('div', {class: 'time-range', style: {left: `${x0}px`, top: `${top + 60}px`,
        width: `${span}px`}}));
      height = Math.max(height, top + 72);
    }
    rowNode.style.height = `${height}px`;
    timeline.append(rowNode);
  }
  if (untimed.length) {
    const rowNode = el('div', {class: 'timeline-row', style: {height: 'auto', padding: '10px 10px 10px 170px'}});
    rowNode.append(el('div', {class: 'caption'}, '未定位时间的事件'));
    for (const event of untimed) rowNode.append(button(event.事件标题 ?? event.事件ID,
      () => app.selectEvent(event.事件ID), 'related-link'));
    timeline.append(rowNode);
  }
  canvas.append(timeline);
}

function edgeClass(relation) {
  if (relation.极性 === '排斥') return 'exclude';
  if (relation.种类 === '事件确认') return 'cond';
  return 'related';
}

export function renderLocalGraph(app, canvas) {
  app.ensureLocalFocus();
  const focus = app.state.localFocus;
  if (!focus || !app.eventByID(focus)) { canvas.append(el('div', {class: 'empty'}, '先选择一个事件。')); return; }
  const levels = new Map([[focus, 0]]);
  for (let depth = 0; depth < app.state.depth; depth++) {
    for (const relation of app.state.data.关系 ?? []) {
      const from = levels.get(relation.from), to = levels.get(relation.to);
      if (from === depth && !levels.has(relation.to)) levels.set(relation.to, depth + 1);
      if (to === depth && !levels.has(relation.from)) levels.set(relation.from, depth + 1);
    }
  }
  const rows = new Map(), positions = new Map(), elements = new Map();
  const nodeWidth = 220, nodeHeight = 78;
  const ordered = [...levels].sort((left, right) => left[1] - right[1]
    || (app.eventByID(left[0])?.触发时间?.start ?? Infinity) - (app.eventByID(right[0])?.触发时间?.start ?? Infinity)
    || String(left[0]).localeCompare(String(right[0]), 'zh'));
  for (const [id, level] of ordered) {
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    const saved = app.state.review.value.layout?.[`事件:${id}`];
    const x = saved && Number.isFinite(saved.x) ? saved.x : 30 + level * 300;
    const y = saved && Number.isFinite(saved.y) ? saved.y : 34 + row * 118;
    positions.set(id, {x, y});
  }
  let maxX = 600, maxY = 420;
  for (const {x, y} of positions.values()) { maxX = Math.max(maxX, x + nodeWidth + 80); maxY = Math.max(maxY, y + nodeHeight + 80); }
  const wrap = el('div', {class: 'graph-wrap', style: {width: `${maxX}px`, height: `${maxY}px`}});
  const svg = svgEl('svg', {class: 'graph-edges', viewBox: `0 0 ${maxX} ${maxY}`, width: maxX, height: maxY});
  const defs = svgEl('defs');
  for (const [id, color] of [['cond', '#276754'], ['exclude', '#b95d56'], ['related', '#5f8299']]) {
    const marker = svgEl('marker', {id: `arrow-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse'});
    marker.append(svgEl('path', {d: 'M 0 0 L 10 5 L 0 10 z', fill: color}));
    defs.append(marker);
  }
  svg.append(defs);
  wrap.append(svg);

  const drawEdges = () => {
    for (const line of [...svg.querySelectorAll('line, text')]) line.remove();
    for (const relation of app.state.data.关系 ?? []) {
      if (!positions.has(relation.from) || !positions.has(relation.to)) continue;
      const from = positions.get(relation.from), to = positions.get(relation.to);
      const x1 = from.x + nodeWidth / 2, y1 = from.y + nodeHeight / 2;
      const x2 = to.x + nodeWidth / 2, y2 = to.y + nodeHeight / 2;
      const kind = edgeClass(relation);
      svg.append(svgEl('line', {x1, y1, x2, y2, class: kind, 'marker-end': `url(#arrow-${kind})`}));
      svg.append(svgEl('text', {x: (x1 + x2) / 2 + 4, y: (y1 + y2) / 2 - 3},
        `${relation.极性 === '排斥' ? '排斥 · ' : ''}${relation.字段}`));
    }
  };

  for (const [id] of ordered) {
    const event = app.eventByID(id);
    if (!event) continue;
    const position = positions.get(id);
    const node = el('button', {type: 'button', class: `graph-node level-${levels.get(id)} ${app.selectedEvent()?.事件ID === id ? 'selected' : ''}`,
      style: {left: `${position.x}px`, top: `${position.y}px`}, 'aria-label': `事件 ${event.事件标题 ?? id}`,
      onClick: () => { if (node.dataset.dragged === 'true') { node.dataset.dragged = 'false'; return; } app.selectEvent(id); }},
      el('strong', {}, event.事件标题 ?? id),
      el('small', {}, `${id} · ${app.eventTimeLabel(event)}`),
      el('small', {}, `${event.结构?.状态 ?? '未解析'} · ${event.确认策略 ?? '无确认策略'}`),
      pill(`层 ${levels.get(id)}`, levels.get(id) === 0 ? 'good' : ''));
    let drag = null, moved = false;
    node.addEventListener('pointerdown', pointer => {
      if (pointer.button !== 0) return;
      drag = {x: pointer.clientX, y: pointer.clientY, left: position.x, top: position.y};
      moved = false;
      node.setPointerCapture(pointer.pointerId);
    });
    node.addEventListener('pointermove', pointer => {
      if (!drag) return;
      const dx = pointer.clientX - drag.x, dy = pointer.clientY - drag.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      const next = {x: Math.max(0, drag.left + dx), y: Math.max(0, drag.top + dy)};
      position.x = next.x; position.y = next.y;
      node.style.left = `${next.x}px`; node.style.top = `${next.y}px`;
      app.state.review.value.layout[`事件:${id}`] = {...next};
      app.state.layoutDirty = true;
      drawEdges();
      app.renderHeader();
    });
    const finish = pointer => {
      if (!drag) return;
      drag = null;
      try { node.releasePointerCapture(pointer.pointerId); } catch { /* 已释放 */ }
      if (moved) node.dataset.dragged = 'true';
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
    elements.set(id, node);
    wrap.append(node);
  }
  drawEdges();
  canvas.append(wrap);
  if (app.state.layoutDirty) canvas.append(notice('节点位置已修改；点击“保存布局”写入审阅状态。', 'warn'));
}

export function renderCharacterSummary(app, canvas) {
  app.ensureGroupView();
  const group = app.groupByID(app.state.groupView.groupID) ?? app.groups()[0];
  if (!group) { canvas.append(el('div', {class: 'empty'}, '没有角色组。')); return; }
  const groupSelect = el('select', {'aria-label': '角色组'});
  selectOptions(groupSelect, app.groups().map(item => [item.角色组ID, `${item.显示名} · ${item.角色组ID}`]), group.角色组ID);
  groupSelect.addEventListener('change', () => {
    app.state.groupView.groupID = groupSelect.value;
    app.state.groupView.versionID = '';
    app.state.groupView.profileID = '';
    app.renderCanvas();
  });
  const versionSelect = el('select', {'aria-label': '角色版本'});
  selectOptions(versionSelect, group.版本.map(item => [item.版本ID, item.显示名 ?? item.版本ID]), app.state.groupView.versionID);
  versionSelect.addEventListener('change', () => {
    app.state.groupView.versionID = versionSelect.value;
    app.state.groupView.profileID = '';
    app.renderCanvas();
  });
  const applicable = app.profilesOf(group).filter(profile => !profile.适用版本?.length
    || profile.适用版本.includes(app.state.groupView.versionID));
  const profileSelect = el('select', {'aria-label': '时期档案'});
  selectOptions(profileSelect, applicable.map(profile => [profile.档案ID, profile.档案ID]), app.state.groupView.profileID);
  profileSelect.addEventListener('change', () => { app.state.groupView.profileID = profileSelect.value; app.renderCanvas(); });
  app.state.groupView.profileID = profileSelect.value;
  const profile = app.profileOf(group, profileSelect.value) ?? applicable[0];
  canvas.append(el('div', {class: 'summary-grid'},
    el('div', {class: 'card'}, el('h3', {}, '角色组'), el('strong', {}, group.显示名),
      el('dl', {class: 'fields'},
        el('dt', {}, '角色组ID'), el('dd', {}, group.角色组ID),
        el('dt', {}, '初始化方式'), el('dd', {}, group.初始化方式 || '—'),
        el('dt', {}, '初始所在'), el('dd', {}, group.初始所在 || '—'),
        el('dt', {}, '版本'), el('dd', {}, group.版本.map(item => item.显示名 ?? item.版本ID).join('、')),
        el('dt', {}, '文件'), el('dd', {}, group.文件))),
    el('div', {class: 'card'}, el('h3', {}, '选择'), field('角色组', groupSelect),
      field('版本', versionSelect), field('时期档案', profileSelect),
      notice('手动查阅；不表示事件当时已生效。'))));
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '档案初始值'), profile ? el('div', {}, profileMeta(profile),
      profile.初始能力 ? details('初始能力', pre(profile.初始能力), true) : null,
      profile.初始装备 ? details('初始装备', pre(profile.初始装备), true) : null) : notice('该版本没有适用档案。')));
  const changes = group.事件变化 ?? [];
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '事件变化（分支定义，不等于默认已发生）'),
    changes.length ? el('div', {class: 'list'}, changes.map(change => button(
      `${change.事件ID} · ${change.分支ID}${change.默认分支 === change.分支ID ? ' · 默认' : ''}\n${change.路径} ${change.操作}`,
      () => app.selectEvent(change.事件ID), 'related-link'))) : notice('没有事件变化写入本组。')));
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '暂存未接回项（不计入当前档案）'),
    group.暂存.length ? el('div', {}, notice('以下内容尚未接回世界书，不能冒充当前已生效。', 'warn'), pre(group.暂存))
      : notice('本组没有暂存清单项。')));
  if (profile) canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '时期档案原文'), renderProfileDocs(profile, true)));
  const profileIDs = app.profilesOf(group).map(item => item.档案ID);
  const compareA = el('select', {'aria-label': '对照档案 A'});
  const compareB = el('select', {'aria-label': '对照档案 B'});
  selectOptions(compareA, profileIDs.map(id => [id, id]), app.state.groupView.compareA);
  selectOptions(compareB, profileIDs.map(id => [id, id]), app.state.groupView.compareB);
  const compareBox = el('div', {class: 'compare'});
  const drawCompare = () => {
    app.state.groupView.compareA = compareA.value;
    app.state.groupView.compareB = compareB.value;
    compareBox.replaceChildren(
      el('div', {}, el('h3', {}, compareA.value), pre(profileDocuments(app.profileOf(group, compareA.value)) || '（没有正文）')),
      el('div', {}, el('h3', {}, compareB.value), pre(profileDocuments(app.profileOf(group, compareB.value)) || '（没有正文）')));
  };
  compareA.addEventListener('change', drawCompare);
  compareB.addEventListener('change', drawCompare);
  drawCompare();
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '版本/时期档案对照'),
    el('div', {class: 'two-fields'}, field('档案 A', compareA), field('档案 B', compareB)), compareBox,
    notice('对照只读原文；不推断事件当时的生效档案。')));
}

export function renderIfView(app, canvas) {
  const data = app.state.data;
  const form = el('div', {class: 'if-form card'});
  const plan = el('select', {'aria-label': '开局方案'});
  selectOptions(plan, [['', '默认路径'], ...(data.开局?.方案 ?? []).map(item => [item.方案ID,
    `${item.方案ID}${item.概述 ? ` · ${item.概述}` : ''}`])], app.state.ifForm.方案);
  plan.addEventListener('change', () => { app.state.ifForm.方案 = plan.value; });
  form.append(field('开局方案', plan));
  const table = el('table', {class: 'table'});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '事件'), el('th', {}, '本路径选择'))));
  const body = el('tbody');
  for (const event of app.events()) {
    if (!(event.分支 ?? []).length) continue;
    const select = el('select', {'aria-label': `${event.事件标题 ?? event.事件ID} 的分支`});
    selectOptions(select, [['__default', '默认'], ['__exclude', '排除'],
      ...(event.分支 ?? []).map(branch => [branch.分支ID, `${branch.分支ID}${branch.默认 ? '（默认分支）' : ''}`])],
      app.state.ifForm.选择[event.事件ID] ?? '__default');
    select.addEventListener('change', () => {
      if (select.value === '__default') delete app.state.ifForm.选择[event.事件ID];
      else app.state.ifForm.选择[event.事件ID] = select.value;
    });
    body.append(el('tr', {}, el('td', {}, event.事件标题 ?? event.事件ID, el('small', {class: 'source'}, event.事件ID)),
      el('td', {}, select)));
  }
  table.append(body);
  form.append(el('div', {class: 'if-events'}, table));
  const groupBox = el('div', {class: 'list'});
  for (const group of app.groups()) {
    const checkbox = el('input', {type: 'checkbox', checked: app.state.ifForm.停用.has(group.角色组ID)});
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) app.state.ifForm.停用.add(group.角色组ID);
      else app.state.ifForm.停用.delete(group.角色组ID);
    });
    groupBox.append(el('label', {class: 'check-row'}, checkbox, `停用 ${group.显示名}`));
  }
  form.append(field('停用角色组', groupBox));
  form.append(el('div', {class: 'edit-actions'}, button(app.state.ifBusy ? '计算中…' : '运行如果视图',
    app.guarded(() => runIf(app)), 'primary'), notice('使用 core/what-if.mjs 的唯一结果；不另写路径计算。')));
  canvas.append(form);
  if (app.state.ifError) canvas.append(notice(app.state.ifError, 'error'));
  if (app.state.ifResult) renderIfResult(app, canvas, app.state.ifResult);
  else canvas.append(el('div', {class: 'empty'}, '选择方案、排除、分支或停用角色组后运行；默认路径也会显示结果。'));
}

function eventLink(app, id, label = null) {
  const event = app.eventByID(id);
  if (!event) return el('span', {}, label ?? id);
  return button(label ?? `${event.事件标题 ?? id} · ${id}`, () => app.selectEvent(id), 'related-link');
}

function renderIfResult(app, canvas, result) {
  const box = el('div', {class: 'if-result'});
  box.append(el('h2', {}, '如果视图结果'));
  const anomalies = result.异常 ?? [];
  const errors = anomalies.filter(item => item.级别 === '错误');
  box.append(notice(`输入：${result.输入?.世界书 ?? '—'} · 时间轴末尾 ${result.输入?.时间轴末尾 ?? '—'} · 方案 ${result.输入?.方案 ?? '默认'}`,
    errors.length ? 'error' : ''));
  const list = (title, values, empty = '无') => box.append(section(title,
    values?.length ? el('div', {class: 'list'}, values.map(value => eventLink(app, typeof value === 'string' ? value : value.事件ID,
      typeof value === 'string' ? value : `${value.事件ID} · ${value.分支ID ?? ''}`))) : notice(empty)));
  list('没发生', result.没发生);
  list('新发生', result.新发生);
  box.append(section('分支不同', (result.分支不同 ?? []).length ? el('table', {class: 'table'},
    el('thead', {}, el('tr', {}, el('th', {}, '事件'), el('th', {}, '默认分支'), el('th', {}, '如果分支'))),
    el('tbody', {}, (result.分支不同 ?? []).map(item => el('tr', {}, el('td', {}, eventLink(app, item.事件ID)),
      el('td', {}, item.默认分支), el('td', {}, item.if分支))))) : notice('无')));
  list('停住的事件串', result.停住的事件串);
  box.append(section('影响面', (result.影响面 ?? []).length ? el('div', {class: 'list'},
    (result.影响面 ?? []).map(item => details(`${item.事件ID} · 下游 ${item.下游?.length ?? 0}`, el('div', {},
      el('p', {}, '下游：'), el('div', {class: 'list'}, (item.下游 ?? []).map(id => eventLink(app, id))),
      el('p', {}, '引用位置：'), pre(item.引用位置 ?? []))))) : notice('无')));
  box.append(section('异常', anomalies.length ? el('ul', {class: 'issue-list'}, anomalies.map(item =>
    el('li', {}, `${item.级别} ${item.规则} ${item.文件}：${item.说明}`))) : notice('无')));
  canvas.append(box);
}

export async function runIf(app) {
  if (app.state.ifBusy) { app.state.ifQueued = true; return; }
  app.state.ifBusy = true;
  app.state.ifError = null;
  app.renderCanvas(); app.renderToolbar();
  try {
    const input = {};
    if (app.state.ifForm.方案) input.方案 = app.state.ifForm.方案;
    const excluded = [], branches = [];
    for (const [eventID, choice] of Object.entries(app.state.ifForm.选择)) {
      if (choice === '__exclude') excluded.push(eventID);
      else if (choice !== '__default') branches.push({事件ID: eventID, 分支ID: choice});
    }
    if (excluded.length) input.排除 = excluded;
    if (branches.length) input.分支 = branches;
    if (app.state.ifForm.停用.size) input.停用角色组 = [...app.state.ifForm.停用];
    const result = await app.request('/api/if', input);
    app.state.ifResult = result;
  }
  catch (error) { app.state.ifResult = null; app.state.ifError = error.message; }
  finally {
    app.state.ifBusy = false;
    app.renderCanvas();
    app.renderToolbar();
    if (app.state.ifQueued) { app.state.ifQueued = false; setTimeout(() => runIf(app), 0); }
  }
}
