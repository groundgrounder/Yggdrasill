const $ = (selector, root = document) => root.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') for (const [name, item] of Object.entries(value)) node.dataset[name] = String(item);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else if (key === 'open') { if (value) node.setAttribute('open', ''); }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

function svgEl(tag, attrs = {}, text = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined)
    node.setAttribute(key, String(value));
  if (text !== null) node.textContent = text;
  return node;
}

const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const pre = value => el('pre', {class: 'raw'}, text(value));
const button = (label, onClick, className = '') => el('button', {type: 'button', class: className, onClick}, label);
const section = (title, ...body) => el('section', {class: 'panel-section'}, el('h3', {}, title), ...body);
const notice = (value, kind = '') => el('p', {class: `notice ${kind}`.trim()}, value);
const pill = (value, kind = '') => el('span', {class: `pill ${kind}`.trim()}, value);
const source = file => el('p', {class: 'source'}, file);
const details = (title, body, open = false) => el('details', open ? {open: true} : {}, el('summary', {}, title), body);
const field = (label, control) => el('label', {class: 'field'}, el('span', {}, label), control);

const state = {
  data: null, token: null, review: {revision: '', value: {notes: {}, layout: {}}}, server: null,
  view: 'world', selected: null, tab: 'detail',
  filters: {search: '', character: '', version: '', primary: '', tag: '', result: ''},
  zoom: 64, depth: 1, collapsed: new Set(),
  drafts: new Map(), notesDirty: false, layoutDirty: false, reviewStale: false,
  preview: null, previewError: null, saveReport: null, ifResult: null, ifBusy: false, ifError: null,
  ifForm: {方案: '', 选择: {}, 停用: new Set()}, ifQueued: false,
  groupView: {groupID: '', versionID: '', profileID: '', compareA: '', compareB: ''},
  localFocus: '', error: null,
  toastTimer: null,
};

const events = () => state.data?.事件 ?? [];
const groups = () => state.data?.角色组 ?? [];
const eventByID = id => events().find(event => event.事件ID === id);
const groupByID = id => groups().find(group => group.角色组ID === id);
const chainByID = id => (state.data?.事件串 ?? []).find(chain => chain.事件串ID === id);
const profilesOf = group => group?.档案 ?? [];
const profileOf = (group, id) => profilesOf(group).find(profile => profile.档案ID === id);
const selectedEvent = () => state.selected?.type === 'event' ? eventByID(state.selected.id) : null;
const selectedGroup = () => state.selected?.type === 'group' ? groupByID(state.selected.id) : null;

function selectedKey() {
  if (state.selected?.type === 'event') return `事件:${state.selected.id}`;
  if (state.selected?.type === 'group') {
    const group = selectedGroup();
    const profile = state.groupView.profileID;
    return group && profile && profileOf(group, profile) ? `档案:${group.角色组ID}:${profile}` : `角色组:${state.groupView.groupID || state.selected.id}`;
  }
  return null;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
}

const guarded = fn => async (...args) => {
  try { return await fn(...args); }
  catch (error) { toast(error.message || String(error)); }
};

async function request(url, body) {
  const response = await fetch(url, {method: 'POST', cache: 'no-store',
    headers: {'Content-Type': 'application/json', 'X-Review-Token': state.token},
    body: JSON.stringify(body)});
  let value;
  try { value = await response.json(); }
  catch { value = {error: '响应不是 JSON'}; }
  if (!response.ok) {
    const error = new Error(value.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return value;
}

function selectOptions(select, items, value) {
  select.replaceChildren(...items.map(([key, label]) => el('option', {value: key}, label)));
  if (value !== undefined && value !== null && items.some(([key]) => String(key) === String(value))) select.value = value;
  else if (items.length) select.value = items[0][0];
}

function eventTimeLabel(event) {
  const time = event.触发时间 ?? {};
  if (!time.最早 && !time.最晚) return '未声明时间';
  if (!time.最晚 || time.最早 === time.最晚) return time.最早 ?? time.最晚;
  return `${time.最早} — ${time.最晚}`;
}

function eventGroupIDs(event) {
  return new Set([...(event.核心参与者 ?? []), ...(event.角色位置 ?? []).map(position => position.角色组ID),
    ...(event.相关角色组 ?? [])]);
}

function filteredEvents() {
  const search = state.filters.search.trim().toLowerCase();
  return events().filter(event => {
    const groupIDs = eventGroupIDs(event);
    if (state.filters.character && !groupIDs.has(state.filters.character)) return false;
    if (state.filters.version) {
      const involved = (event.核心参与者 ?? []).includes(state.filters.character)
        || (event.角色位置 ?? []).some(position => position.角色组ID === state.filters.character);
      if (!involved) return false;
    }
    if (state.filters.primary && event.主类型 !== state.filters.primary) return false;
    if (state.filters.tag && !(event.标签 ?? []).includes(state.filters.tag)) return false;
    if (state.filters.result && !(event.事件结果 ?? []).includes(state.filters.result)) return false;
    if (!search) return true;
    const haystack = [event.事件ID, event.事件标题, event.事件概要, event.影响范围, event.确认策略,
      event.主类型, ...(event.标签 ?? []), ...(event.事件结果 ?? []), ...(event.核心参与者 ?? []),
      ...(event.地点 ?? []), ...(event.角色位置 ?? []).map(item => item.角色组ID),
      JSON.stringify(event.门槛 ?? null)].join(' ').toLowerCase();
    return haystack.includes(search);
  }).sort((left, right) => (left.触发时间?.start ?? Infinity) - (right.触发时间?.start ?? Infinity)
    || String(left.事件ID).localeCompare(String(right.事件ID), 'zh'));
}

function ensureGroupView() {
  if (!state.data) return;
  const group = groupByID(state.groupView.groupID) ?? groups().find(item => item.角色组ID === state.filters.character) ?? groups()[0];
  if (!group) { state.groupView = {groupID: '', versionID: '', profileID: '', compareA: '', compareB: ''}; return; }
  state.groupView.groupID = group.角色组ID;
  const versionIDs = group.版本.map(version => version.版本ID);
  if (!versionIDs.includes(state.groupView.versionID)) state.groupView.versionID = group.默认版本 && versionIDs.includes(group.默认版本)
    ? group.默认版本 : versionIDs[0] ?? '';
  const applicable = profilesOf(group).filter(profile => !profile.适用版本?.length || profile.适用版本.includes(state.groupView.versionID));
  if (!applicable.some(profile => profile.档案ID === state.groupView.profileID))
    state.groupView.profileID = applicable.find(profile => profile.默认)?.档案ID ?? applicable[0]?.档案ID ?? '';
  const profileIDs = profilesOf(group).map(profile => profile.档案ID);
  if (!profileIDs.includes(state.groupView.compareA)) state.groupView.compareA = state.groupView.profileID || profileIDs[0] || '';
  if (!profileIDs.includes(state.groupView.compareB)) state.groupView.compareB = profileIDs.find(id => id !== state.groupView.compareA) ?? state.groupView.compareA;
}

function ensureLocalFocus() {
  if (!state.data) return;
  if (state.localFocus && eventByID(state.localFocus)) return;
  state.localFocus = selectedEvent()?.事件ID ?? filteredEvents()[0]?.事件ID ?? events()[0]?.事件ID ?? '';
}

function renderHeader() {
  const data = state.data;
  if (!data) {
    $('#counts').textContent = '';
    const node = $('#status');
    node.textContent = state.error ?? '正在读取世界书…';
    node.classList.toggle('error', Boolean(state.error));
    return;
  }
  const counts = data.元数据.计数;
  $('#counts').textContent = `${counts.事件} 事件 / ${counts.事件串} 事件串 / ${counts.角色组} 角色组 / ${counts.档案} 档案 / ${counts.条目} 条目`;
  const check = data.元数据.检查;
  const dirty = [state.notesDirty ? '批注未保存' : '', state.layoutDirty ? '布局未保存' : ''].filter(Boolean).join('，');
  const issues = data.元数据.数据异常?.length ?? 0;
  const status = state.error ? state.error
    : `${check.错误} 错误 / ${check.提示} 提示${issues ? ` / ${issues} 项读取异常` : ''}${dirty ? ` / ${dirty}` : ''}`;
  const node = $('#status');
  node.textContent = status;
  node.classList.toggle('error', Boolean(state.error) || check.错误 > 0);
}

function renderViews() {
  const view = $('#views');
  const filtered = filteredEvents();
  const entries = [
    ['world', '世界主树', `${filtered.length}/${events().length}`],
    ['local', '局部关系', `层 ${state.depth}`],
    ['characters', '角色汇总', `${groups().length} 组`],
    ['if', '如果视图', `${state.data?.开局?.方案?.length ?? 0} 方案`],
  ];
  view.replaceChildren(...entries.map(([key, label, note]) => el('button', {type: 'button',
    class: state.view === key ? 'active' : '', 'aria-pressed': state.view === key ? 'true' : 'false',
    onClick: () => showView(key)}, el('span', {}, label), el('span', {}, note))));
}

function renderFilters() {
  const data = state.data;
  if (!data) return;
  const character = $('#characterFilter');
  selectOptions(character, [['', '全部角色'], ...groups().map(group => [group.角色组ID,
    `${group.显示名}${group.显示名 !== group.角色组ID ? ` · ${group.角色组ID}` : ''}`])], state.filters.character);
  const version = $('#versionFilter');
  const group = groupByID(state.filters.character);
  selectOptions(version, group ? [['', '全部版本'], ...group.版本.map(item => [item.版本ID, item.显示名 ?? item.版本ID])] : [['', '先选角色']],
    state.filters.version);
  version.disabled = !group;
  selectOptions($('#primaryFilter'), [['', '全部主类型'], ...(data.分类.主类型 ?? []).map(value => [value, value])], state.filters.primary);
  selectOptions($('#tagFilter'), [['', '全部标签'], ...(data.分类.标签 ?? []).map(value => [value, value])], state.filters.tag);
  selectOptions($('#resultFilter'), [['', '全部结果'], ...(data.分类.事件结果 ?? []).map(value => [value, value])], state.filters.result);
  $('#search').value = state.filters.search;
  $('#navNote').textContent = state.filters.character
    ? '角色与版本筛选只限制相关事件；不推算事件在当时是否已生效。'
    : '筛选显示可能适用的事件，不计算本局事实。';
}

function renderToolbar() {
  const controls = $('#viewControls');
  const items = [];
  if (state.view === 'world') {
    items.push(button('－', () => { state.zoom = Math.max(32, state.zoom - 16); renderCanvas(); renderToolbar(); }, ''));
    items.push(el('span', {class: 'caption'}, `${state.zoom}px/年`));
    items.push(button('＋', () => { state.zoom = Math.min(240, state.zoom + 16); renderCanvas(); renderToolbar(); }, ''));
    items.push(button('折叠全部', () => { for (const chain of state.data?.事件串 ?? []) state.collapsed.add(chain.事件串ID); renderCanvas(); }));
    items.push(button('展开全部', () => { state.collapsed.clear(); renderCanvas(); }));
  }
  else if (state.view === 'local') {
    ensureLocalFocus();
    items.push(el('span', {class: 'caption'}, state.localFocus ? `焦点：${eventByID(state.localFocus)?.事件标题 ?? state.localFocus}` : '无焦点事件'));
    for (let depth = 1; depth <= 5; depth++) items.push(button(`${depth} 层`,
      () => { state.depth = depth; renderCanvas(); renderToolbar(); }, state.depth === depth ? 'active' : ''));
    items.push(button('保存布局', guarded(saveReview), state.layoutDirty ? 'primary' : ''));
  }
  else if (state.view === 'characters') {
    items.push(el('span', {class: 'caption'}, '档案初始值、事件变化与暂存分区显示'));
  }
  else if (state.view === 'if') {
    items.push(button(state.ifBusy ? '计算中…' : '运行如果视图', guarded(runIf), 'primary'));
  }
  controls.replaceChildren(...items);
}

function renderLegend() {
  const legend = $('#legend');
  if (state.view === 'world') {
    legend.replaceChildren(el('span', {}, '横向为时间窗口'), el('span', {}, '卡片底线为时间范围'),
      el('span', {}, '结构状态来自现行事件树分析'), el('span', {}, '缩放与折叠只影响显示'));
  }
  else if (state.view === 'local') {
    legend.replaceChildren(el('span', {}, el('i', {class: 'green'}), '条件引用'),
      el('span', {}, el('i', {class: 'dashed red'}), '排斥条件'),
      el('span', {}, el('i', {class: 'dashed blue'}), '普通关联'),
      el('span', {}, '箭头不替代完整 all / any / none'));
  }
  else if (state.view === 'characters') {
    legend.replaceChildren(el('span', {}, '档案初始值'), el('span', {}, '事件变化（定义，不等于已发生）'),
      el('span', {}, '暂存未接回（不计入当前档案）'), el('span', {}, '手动查阅，不读本局快照'));
  }
  else {
    legend.replaceChildren(el('span', {}, '唯一事实来源：core/what-if.mjs'), el('span', {}, '不另写路径计算'),
      el('span', {}, '影响面是提示，不是新门槛'));
  }
}

function renderCanvas() {
  const canvas = $('#canvas');
  canvas.replaceChildren();
  if (state.error) {
    canvas.append(el('div', {class: 'empty'}, state.error));
    return;
  }
  if (!state.data) { canvas.append(el('div', {class: 'empty'}, '正在读取世界书…')); return; }
  const check = state.data.元数据.检查;
  if (check.错误 > 0) {
    canvas.append(notice(`检查发现 ${check.错误} 个错误；保存前预览会拒绝。`, 'error'));
    canvas.append(details('查看检查错误', pre(check.错误列表)));
  }
  if (state.view === 'world') renderTimeline(canvas);
  else if (state.view === 'local') renderLocalGraph(canvas);
  else if (state.view === 'characters') renderCharacterSummary(canvas);
  else renderIfView(canvas);
}

function renderTimeline(canvas) {
  const filtered = filteredEvents();
  if (!filtered.length) { canvas.append(el('div', {class: 'empty'}, '没有符合筛选的事件。')); return; }
  const calendar = state.data.元数据.日历;
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
  const pxPerYear = state.zoom;
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

  const chainRows = (state.data.事件串 ?? []).map(chain => ({
    id: chain.事件串ID, label: chain.概述 || chain.事件串ID,
    events: filtered.filter(event => (event.事件串 ?? []).includes(chain.事件串ID)),
  })).filter(row => row.events.length);
  const assigned = new Set(chainRows.flatMap(row => row.events.map(event => event.事件ID)));
  const standalone = filtered.filter(event => !assigned.has(event.事件ID));
  if (standalone.length) chainRows.push({id: '__standalone', label: '独立事件', events: standalone});

  for (const row of chainRows) {
    const collapsed = state.collapsed.has(row.id);
    const rowNode = el('div', {class: 'timeline-row'});
    const rowStarts = row.events.map(event => event.触发时间?.start).filter(Number.isFinite);
    const rowEnds = row.events.map(event => event.触发时间?.end).filter(Number.isFinite);
    const rowMin = rowStarts.length ? Math.min(...rowStarts) : minStart;
    const rowMax = rowEnds.length ? Math.max(...rowEnds) : maxEnd;
    const label = el('button', {type: 'button', class: 'timeline-label', 'aria-expanded': collapsed ? 'false' : 'true',
      onClick: () => { if (collapsed) state.collapsed.delete(row.id); else state.collapsed.add(row.id); renderCanvas(); }},
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
      const card = el('button', {type: 'button', class: `interval ${selectedEvent()?.事件ID === event.事件ID ? 'selected' : ''}`,
        style: {left: `${x0}px`, top: `${top}px`, width: `${cardWidth}px`},
        'aria-label': `${event.事件标题 ?? event.事件ID}，${eventTimeLabel(event)}`,
        onClick: () => selectEvent(event.事件ID)},
        el('strong', {}, event.事件标题 ?? event.事件ID),
        el('small', {}, eventTimeLabel(event)),
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
      () => selectEvent(event.事件ID), 'related-link'));
    timeline.append(rowNode);
  }
  canvas.append(timeline);
}

function edgeClass(relation) {
  if (relation.极性 === '排斥') return 'exclude';
  if (relation.种类 === '事件确认') return 'cond';
  return 'related';
}

function renderLocalGraph(canvas) {
  ensureLocalFocus();
  const focus = state.localFocus;
  if (!focus || !eventByID(focus)) { canvas.append(el('div', {class: 'empty'}, '先选择一个事件。')); return; }
  const levels = new Map([[focus, 0]]);
  for (let depth = 0; depth < state.depth; depth++) {
    for (const relation of state.data.关系 ?? []) {
      const from = levels.get(relation.from), to = levels.get(relation.to);
      if (from === depth && !levels.has(relation.to)) levels.set(relation.to, depth + 1);
      if (to === depth && !levels.has(relation.from)) levels.set(relation.from, depth + 1);
    }
  }
  const rows = new Map(), positions = new Map(), elements = new Map();
  const nodeWidth = 220, nodeHeight = 78;
  const ordered = [...levels].sort((left, right) => left[1] - right[1]
    || (eventByID(left[0])?.触发时间?.start ?? Infinity) - (eventByID(right[0])?.触发时间?.start ?? Infinity)
    || String(left[0]).localeCompare(String(right[0]), 'zh'));
  for (const [id, level] of ordered) {
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    const saved = state.review.value.layout?.[`事件:${id}`];
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
    for (const relation of state.data.关系 ?? []) {
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
    const event = eventByID(id);
    if (!event) continue;
    const position = positions.get(id);
    const node = el('button', {type: 'button', class: `graph-node level-${levels.get(id)} ${selectedEvent()?.事件ID === id ? 'selected' : ''}`,
      style: {left: `${position.x}px`, top: `${position.y}px`}, 'aria-label': `事件 ${event.事件标题 ?? id}`,
      onClick: event_ => { if (node.dataset.dragged === 'true') { node.dataset.dragged = 'false'; return; } selectEvent(id); }},
      el('strong', {}, event.事件标题 ?? id),
      el('small', {}, `${id} · ${eventTimeLabel(event)}`),
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
      state.review.value.layout[`事件:${id}`] = {...next};
      state.layoutDirty = true;
      drawEdges();
      renderHeader();
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
  if (state.layoutDirty) canvas.append(notice('节点位置已修改；点击“保存布局”写入审阅状态。', 'warn'));
}

function profileDocuments(profile) {
  const parts = [];
  for (const kind of ['基本信息', '角色印象']) {
    const item = profile?.文档?.[kind];
    if (item?.原文) parts.push(`# ${kind}（${item.文件}）\n${item.原文}`);
  }
  return parts.join('\n\n');
}

function profileMeta(profile) {
  return el('dl', {class: 'fields'},
    el('dt', {}, '档案'), el('dd', {}, profile.档案ID),
    el('dt', {}, '适用版本'), el('dd', {}, (profile.适用版本 ?? []).join('、') || '—'),
    el('dt', {}, '默认'), el('dd', {}, profile.默认 ? '是' : '否'),
    el('dt', {}, '前置档案'), el('dd', {}, profile.前置档案 || '—'),
    el('dt', {}, '生效条件'), el('dd', {}, profile.生效条件 ? JSON.stringify(profile.生效条件) : '—'),
    el('dt', {}, '初始能力'), el('dd', {}, profile.初始能力 ? JSON.stringify(profile.初始能力) : '—'),
    el('dt', {}, '初始装备'), el('dd', {}, profile.初始装备 ? JSON.stringify(profile.初始装备) : '—'));
}

function renderProfileDocs(profile, open = false) {
  if (!profile) return notice('没有可显示的档案。');
  const body = el('div', {}, profileMeta(profile));
  for (const [kind, document] of Object.entries(profile.文档 ?? {}))
    body.append(details(kind, el('div', {}, pre(document.原文), source(document.文件))));
  body.append(notice('手动查阅档案原文；不读取本局快照，不代表事件当时已生效。'));
  return open ? body : details(`档案 ${profile.档案ID}`, body);
}

function renderRoleControls(container, group, event = null) {
  const groupSelect = el('select', {'aria-label': '查看角色组'});
  selectOptions(groupSelect, groups().map(item => [item.角色组ID,
    `${(event?.相关角色组 ?? []).includes(item.角色组ID) ? '相关 · ' : '手动查阅 · '}${item.显示名}`]), group?.角色组ID);
  groupSelect.addEventListener('change', () => {
    state.groupView.groupID = groupSelect.value;
    state.groupView.versionID = '';
    state.groupView.profileID = '';
    if (state.selected?.type === 'group') state.selected = {type: 'group', id: groupSelect.value};
    renderInspector();
  });
  const current = groupByID(groupSelect.value) ?? group;
  const versionSelect = el('select', {'aria-label': '档案版本'});
  selectOptions(versionSelect, (current?.版本 ?? []).map(item => [item.版本ID, item.显示名 ?? item.版本ID]),
    state.groupView.versionID);
  state.groupView.versionID = versionSelect.value;
  versionSelect.addEventListener('change', () => {
    state.groupView.versionID = versionSelect.value;
    state.groupView.profileID = '';
    renderInspector();
  });
  const applicable = profilesOf(current).filter(profile => !profile.适用版本?.length
    || profile.适用版本.includes(state.groupView.versionID));
  const profileSelect = el('select', {'aria-label': '时期档案'});
  selectOptions(profileSelect, applicable.map(profile => [profile.档案ID, profile.档案ID]), state.groupView.profileID);
  state.groupView.profileID = profileSelect.value;
  profileSelect.addEventListener('change', () => { state.groupView.profileID = profileSelect.value; renderInspector(); });
  container.append(el('div', {class: 'two-fields'},
    field('角色组', groupSelect), field('版本', versionSelect)), field('时期档案', profileSelect));
  return {group: current, version: state.groupView.versionID, profile: profileOf(current, profileSelect.value) ?? applicable[0]};
}

function renderEventDetail(panel, event) {
  const related = (event.相关角色组 ?? []).map(id => groupByID(id)).filter(Boolean);
  panel.append(el('p', {}, event.事件概要 || '（没有事件概要）'));
  panel.append(el('div', {}, pill(event.主类型 ?? '未分类', event.主类型 ? '' : 'warn'),
    ...(event.标签 ?? []).map(tag => pill(tag)), ...(event.事件结果 ?? []).map(result => pill(result, 'good'))));
  panel.append(el('dl', {class: 'fields'},
    el('dt', {}, '时间'), el('dd', {}, eventTimeLabel(event)),
    el('dt', {}, '地点'), el('dd', {}, (event.地点 ?? []).join('、') || '—'),
    el('dt', {}, '确认策略'), el('dd', {}, event.确认策略 || '—'),
    el('dt', {}, '核心参与者'), el('dd', {}, (event.核心参与者 ?? []).join('、') || '—'),
    el('dt', {}, '结构状态'), el('dd', {}, event.结构?.状态 ?? '未解析'),
    el('dt', {}, '事件串'), el('dd', {}, (event.事件串 ?? []).join('、') || '独立事件'),
    el('dt', {}, '影响范围'), el('dd', {}, event.影响范围 || '—')));
  if (related.length) panel.append(section('相关角色组',
    el('div', {class: 'list'}, related.map(group => button(`${group.显示名} · ${group.角色组ID}`,
      () => selectGroup(group.角色组ID), 'related-link')))));
  panel.append(section('完整门槛', event.门槛 ? pre(event.门槛) : notice('没有机器门槛。')));
  if (event.叙事条件) panel.append(section('叙事条件', pre(event.叙事条件)));
  panel.append(section('分支与变化', el('div', {class: 'list'}, (event.分支 ?? []).map(branch =>
    details(`${branch.分支ID ?? '未命名分支'}${branch.默认 ? ' · 默认' : ''}`,
      el('div', {}, el('dl', {class: 'fields'},
        el('dt', {}, '分支条件'), el('dd', {}, branch.分支条件 || '—'),
        el('dt', {}, '分支结果'), el('dd', {}, branch.分支结果 || '—')),
      branch.门槛 ? details('分支门槛', pre(branch.门槛)) : null,
      pre(branch.变化 ?? [])), branch.默认)))));
  const incoming = (state.data.关系 ?? []).filter(relation => relation.to === event.事件ID);
  const outgoing = (state.data.关系 ?? []).filter(relation => relation.from === event.事件ID);
  panel.append(section('直接关系',
    incoming.length || outgoing.length ? el('div', {class: 'list'}, [
      ...incoming.map(relation => button(`${relation.from} → 本事件\n${relation.种类} · ${relation.字段}${relation.极性 === '排斥' ? ' · 排斥' : ''}`,
        () => selectEvent(relation.from), 'related-link')),
      ...outgoing.map(relation => button(`本事件 → ${relation.to}\n${relation.种类} · ${relation.字段}${relation.极性 === '排斥' ? ' · 排斥' : ''}`,
        () => selectEvent(relation.to), 'related-link')),
    ]) : notice('没有直接事件引用。')));
  panel.append(section('角色位置', (event.角色位置 ?? []).length
    ? el('div', {class: 'list'}, event.角色位置.map(position => details(
      `${position.角色组ID ?? '未知角色'} · ${position.文件}`,
      el('div', {}, pre(position.内容 ?? position.原文 ?? null), source(position.文件)))))
    : notice('本事件没有角色位置文件。')));
  panel.append(details('完整原文', el('div', {}, pre(event.原文), source(event.文件))));
}

function renderGroupDetail(panel, group) {
  const profile = profileOf(group, state.groupView.profileID) ?? profilesOf(group)[0];
  panel.append(el('p', {}, `角色组 ${group.角色组ID} · ${group.显示名}`));
  panel.append(el('dl', {class: 'fields'},
    el('dt', {}, '初始化方式'), el('dd', {}, group.初始化方式 || '—'),
    el('dt', {}, '初始所在'), el('dd', {}, group.初始所在 || '—'),
    el('dt', {}, '默认启用'), el('dd', {}, group.默认启用 ? '是' : '否'),
    el('dt', {}, '默认版本'), el('dd', {}, group.默认版本 || '—'),
    el('dt', {}, '版本'), el('dd', {}, group.版本.map(version => version.显示名 ?? version.版本ID).join('、'))));
  panel.append(section('档案初始值', profile ? el('div', {}, profileMeta(profile),
    profile.初始能力 ? details('初始能力', pre(profile.初始能力), true) : null,
    profile.初始装备 ? details('初始装备', pre(profile.初始装备), true) : null) : notice('没有档案。')));
  panel.append(section('事件变化', group.事件变化.length ? el('div', {class: 'list'},
    group.事件变化.map(change => button(`${change.事件ID} · ${change.分支ID}\n${change.路径} ${change.操作}`,
      () => selectEvent(change.事件ID), 'related-link'))) : notice('没有事件变化写入本组。')));
  panel.append(section('暂存未接回', group.暂存.length ? el('div', {}, notice('以下内容尚未接回世界书，不计入当前档案或本局。', 'warn'),
    pre(group.暂存)) : notice('本组没有暂存清单项。')));
  panel.append(details('档案原文', renderProfileDocs(profile, true)));
  panel.append(source(group.文件));
}

function renderCharactersPanel(panel) {
  const event = selectedEvent();
  const preferred = event ? (event.相关角色组 ?? []).map(groupByID).filter(Boolean) : [];
  const current = groupByID(state.groupView.groupID);
  const group = selectedGroup() ?? (preferred.some(item => item.角色组ID === current?.角色组ID) ? current : null)
    ?? preferred[0] ?? current ?? groups()[0];
  if (!group) { panel.append(notice('没有角色组。')); return; }
  if (state.groupView.groupID !== group.角色组ID) {
    state.groupView.groupID = group.角色组ID;
    state.groupView.versionID = '';
    state.groupView.profileID = '';
  }
  panel.append(notice('作者对照视图。手动选择版本与时期；不读取本局快照，不按日期推定档案、知情或能力已生效。'));
  const controls = el('div', {});
  panel.append(controls);
  const selected = renderRoleControls(controls, group, event);
  if (event && selected.group) {
    const position = (event.角色位置 ?? []).find(item => item.角色组ID === selected.group.角色组ID);
    panel.append(section('本事件的角色专属内容', position
      ? el('div', {}, el('dl', {class: 'fields'},
        el('dt', {}, '角色概要'), el('dd', {}, position.内容?.角色概要 ?? '—'),
        el('dt', {}, '角色定位'), el('dd', {}, (position.内容?.角色定位 ?? []).join('、') || '—'),
        el('dt', {}, '角色知情'), el('dd', {}, (position.内容?.角色知情 ?? []).join('、') || '—')),
        pre(position.内容 ?? position.原文), source(position.文件),
        notice('按分支、知情、记忆与语料保留原文；此处是作者对照，不是本局注入结果。'))
      : notice('此事件没有为该角色组建立角色位置。')));
    const changes = (selected.group.事件变化 ?? []).filter(change => change.事件ID === event.事件ID);
    panel.append(section('本事件与该角色组的变化', changes.length ? pre(changes)
      : notice('本事件没有写入该角色组的变化。')));
  }
  if (selected.profile) panel.append(section('时期档案', renderProfileDocs(selected.profile, true)));
  else panel.append(notice('所选版本没有适用档案。'));
}

function ensureNote(key) {
  if (!key) return null;
  if (!state.review.value.notes[key]) state.review.value.notes[key] = {text: '', status: '待审'};
  return state.review.value.notes[key];
}

async function saveReview() {
  if (!state.review) return;
  try {
    const response = await request('/api/review', {revision: state.review.revision, value: state.review.value});
    state.review = {revision: response.revision, value: response.value, damaged: false, error: null};
    state.notesDirty = false;
    state.layoutDirty = false;
    state.reviewStale = false;
    toast('批注与布局已保存；事件正文未变。');
    renderInspector();
    renderHeader();
  }
  catch (error) {
    if (error.status === 409) { state.reviewStale = true; toast(`${error.message}。请重新读取后再保存。`); renderInspector(); return; }
    throw error;
  }
}

function renderEditPanel(panel) {
  const key = selectedKey();
  if (!key) { panel.append(el('p', {class: 'caption'}, '先选择节点，即可批注或编辑。')); return; }
  const note = state.review.value.notes[key] ?? {text: '', status: '待审'};
  const status = el('select', {'aria-label': '审阅状态'});
  selectOptions(status, ['待审', '通过', '需调整'].map(value => [value, value]), note.status);
  const editor = el('textarea', {class: 'note-editor', 'aria-label': '审阅批注',
    placeholder: '写下疑点、修改方向或待补依据…'});
  editor.value = note.text;
  const sync = () => {
    const current = ensureNote(key);
    current.text = editor.value;
    current.status = status.value;
    state.notesDirty = true;
    renderHeader();
  };
  editor.addEventListener('input', sync);
  status.addEventListener('change', sync);
  panel.append(section('作者批注', status, editor,
    el('div', {class: 'edit-actions'}, button('保存批注与布局', guarded(saveReview), 'primary'),
      state.reviewStale ? button('重新读取', guarded(() => loadData(true))) : null,
      state.notesDirty || state.layoutDirty ? el('span', {class: 'caption'}, '有未保存的批注或布局') : null),
    state.review.damaged ? notice(`审阅状态文件损坏：${state.review.error}。保存会重建该文件。`, 'error') : null));

  const event = selectedEvent();
  if (!event) { panel.append(notice('本节点只支持批注与布局；事件正文、档案与其他文件在对应视图中查阅。')); return; }
  const draft = state.drafts.get(event.事件ID) ?? {raw: event.原文, revision: event.revision};
  const rawEditor = el('textarea', {class: 'raw-editor', spellcheck: 'false', 'aria-label': '事件原文编辑'});
  rawEditor.value = draft.raw;
  rawEditor.addEventListener('input', () => {
    if (rawEditor.value === event.原文) state.drafts.delete(event.事件ID);
    else state.drafts.set(event.事件ID, {raw: rawEditor.value, revision: event.revision});
    state.preview = null;
    $('#saveEvent').disabled = true;
    renderHeader();
  });
  panel.append(section('编辑正式事件',
    notice('候选是现行事件 .txt 的 YAML 原文；不要添加 <事件> 外壳。事件ID固定，其他文档只读。'),
    rawEditor,
    el('div', {class: 'edit-actions'},
      button('检查并预览差异', guarded(() => previewEvent(event)), 'primary'),
      button('恢复已读取原文', () => {
        const current = state.drafts.get(event.事件ID);
        if (rawEditor.value !== event.原文 && !confirm('丢弃这个事件尚未保存的编辑？')) return;
        state.drafts.delete(event.事件ID);
        state.preview = null;
        renderInspector();
      })),
    source(event.文件),
    state.layoutDirty ? notice('图节点位置已修改；保存批注与布局会一并写入。', 'warn') : null));
}

function renderInspector() {
  const visible = state.data !== null;
  const title = $('#selectionTitle');
  const event = selectedEvent();
  const group = selectedGroup();
  title.replaceChildren(el('span', {class: 'eyebrow'}, event ? '正式事件' : group ? '角色组' : '选择一个节点'),
    el('h2', {}, event ? (event.事件标题 ?? event.事件ID) : group ? group.显示名 : '从故事开始审阅'));
  document.querySelectorAll('[data-tab]').forEach(node => {
    const active = node.dataset.tab === state.tab;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  for (const name of ['detail', 'characters', 'edit']) $('#' + name + 'Panel').hidden = state.tab !== name;
  const detail = $('#detailPanel'), characters = $('#charactersPanel'), edit = $('#editPanel');
  detail.replaceChildren(); characters.replaceChildren(); edit.replaceChildren();
  if (!visible) { detail.append(el('p', {class: 'caption'}, state.error ? `世界书读取失败：${state.error}` : '正在读取世界书…')); return; }
  if (event) renderEventDetail(detail, event);
  else if (group) renderGroupDetail(detail, group);
  else detail.append(el('p', {class: 'caption'}, '点击时间轴、关系图或角色汇总中的节点，查看详情。'));
  renderCharactersPanel(characters);
  renderEditPanel(edit);
}

function renderCharacterSummary(canvas) {
  ensureGroupView();
  const group = groupByID(state.groupView.groupID) ?? groups()[0];
  if (!group) { canvas.append(el('div', {class: 'empty'}, '没有角色组。')); return; }
  const groupSelect = el('select', {'aria-label': '角色组'});
  selectOptions(groupSelect, groups().map(item => [item.角色组ID, `${item.显示名} · ${item.角色组ID}`]), group.角色组ID);
  groupSelect.addEventListener('change', () => {
    state.groupView.groupID = groupSelect.value;
    state.groupView.versionID = '';
    state.groupView.profileID = '';
    renderCanvas();
  });
  const versionSelect = el('select', {'aria-label': '角色版本'});
  selectOptions(versionSelect, group.版本.map(item => [item.版本ID, item.显示名 ?? item.版本ID]), state.groupView.versionID);
  versionSelect.addEventListener('change', () => {
    state.groupView.versionID = versionSelect.value;
    state.groupView.profileID = '';
    renderCanvas();
  });
  const applicable = profilesOf(group).filter(profile => !profile.适用版本?.length
    || profile.适用版本.includes(state.groupView.versionID));
  const profileSelect = el('select', {'aria-label': '时期档案'});
  selectOptions(profileSelect, applicable.map(profile => [profile.档案ID, profile.档案ID]), state.groupView.profileID);
  profileSelect.addEventListener('change', () => { state.groupView.profileID = profileSelect.value; renderCanvas(); });
  state.groupView.profileID = profileSelect.value;
  const profile = profileOf(group, profileSelect.value) ?? applicable[0];
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
      () => selectEvent(change.事件ID), 'related-link'))) : notice('没有事件变化写入本组。')));
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '暂存未接回项（不计入当前档案）'),
    group.暂存.length ? el('div', {}, notice('以下内容尚未接回世界书，不能冒充当前已生效。', 'warn'), pre(group.暂存))
      : notice('本组没有暂存清单项。')));
  if (profile) canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '时期档案原文'), renderProfileDocs(profile, true)));
  const profileIDs = profilesOf(group).map(item => item.档案ID);
  const compareA = el('select', {'aria-label': '对照档案 A'});
  const compareB = el('select', {'aria-label': '对照档案 B'});
  selectOptions(compareA, profileIDs.map(id => [id, id]), state.groupView.compareA);
  selectOptions(compareB, profileIDs.map(id => [id, id]), state.groupView.compareB);
  const compareBox = el('div', {class: 'compare'});
  const drawCompare = () => {
    state.groupView.compareA = compareA.value;
    state.groupView.compareB = compareB.value;
    compareBox.replaceChildren(
      el('div', {}, el('h3', {}, compareA.value), pre(profileDocuments(profileOf(group, compareA.value)) || '（没有正文）')),
      el('div', {}, el('h3', {}, compareB.value), pre(profileDocuments(profileOf(group, compareB.value)) || '（没有正文）')));
  };
  compareA.addEventListener('change', drawCompare);
  compareB.addEventListener('change', drawCompare);
  drawCompare();
  canvas.append(el('div', {class: 'card', style: {marginTop: '14px'}},
    el('h3', {}, '版本/时期档案对照'),
    el('div', {class: 'two-fields'}, field('档案 A', compareA), field('档案 B', compareB)), compareBox,
    notice('对照只读原文；不推断事件当时的生效档案。')));
}

function renderIfView(canvas) {
  const data = state.data;
  const form = el('div', {class: 'if-form card'});
  const plan = el('select', {'aria-label': '开局方案'});
  selectOptions(plan, [['', '默认路径'], ...(data.开局?.方案 ?? []).map(item => [item.方案ID,
    `${item.方案ID}${item.概述 ? ` · ${item.概述}` : ''}`])], state.ifForm.方案);
  plan.addEventListener('change', () => { state.ifForm.方案 = plan.value; });
  form.append(field('开局方案', plan));
  const table = el('table', {class: 'table'});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '事件'), el('th', {}, '本路径选择'))));
  const body = el('tbody');
  for (const event of events()) {
    if (!(event.分支 ?? []).length) continue;
    const select = el('select', {'aria-label': `${event.事件标题 ?? event.事件ID} 的分支`});
    selectOptions(select, [['__default', '默认'], ['__exclude', '排除'],
      ...(event.分支 ?? []).map(branch => [branch.分支ID, `${branch.分支ID}${branch.默认 ? '（默认分支）' : ''}`])],
      state.ifForm.选择[event.事件ID] ?? '__default');
    select.addEventListener('change', () => {
      if (select.value === '__default') delete state.ifForm.选择[event.事件ID];
      else state.ifForm.选择[event.事件ID] = select.value;
    });
    body.append(el('tr', {}, el('td', {}, event.事件标题 ?? event.事件ID, el('small', {class: 'source'}, event.事件ID)),
      el('td', {}, select)));
  }
  table.append(body);
  form.append(el('div', {class: 'if-events'}, table));
  const groupBox = el('div', {class: 'list'});
  for (const group of groups()) {
    const checkbox = el('input', {type: 'checkbox', checked: state.ifForm.停用.has(group.角色组ID)});
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.ifForm.停用.add(group.角色组ID);
      else state.ifForm.停用.delete(group.角色组ID);
    });
    groupBox.append(el('label', {class: 'check-row'}, checkbox, `停用 ${group.显示名}`));
  }
  form.append(field('停用角色组', groupBox));
  form.append(el('div', {class: 'edit-actions'}, button(state.ifBusy ? '计算中…' : '运行如果视图',
    guarded(runIf), 'primary'), notice('使用 core/what-if.mjs 的唯一结果；不另写路径计算。')));
  canvas.append(form);
  if (state.ifError) canvas.append(notice(state.ifError, 'error'));
  if (state.ifResult) renderIfResult(canvas, state.ifResult);
  else canvas.append(el('div', {class: 'empty'}, '选择方案、排除、分支或停用角色组后运行；默认路径也会显示结果。'));
}

function eventLink(id, label = null) {
  const event = eventByID(id);
  if (!event) return el('span', {}, label ?? id);
  return button(label ?? `${event.事件标题 ?? id} · ${id}`, () => selectEvent(id), 'related-link');
}

function renderIfResult(canvas, result) {
  const box = el('div', {class: 'if-result'});
  box.append(el('h2', {}, '如果视图结果'));
  const anomalies = result.异常 ?? [];
  const errors = anomalies.filter(item => item.级别 === '错误');
  box.append(notice(`输入：${result.输入?.世界书 ?? '—'} · 时间轴末尾 ${result.输入?.时间轴末尾 ?? '—'} · 方案 ${result.输入?.方案 ?? '默认'}`,
    errors.length ? 'error' : ''));
  const list = (title, values, empty = '无') => box.append(section(title,
    values?.length ? el('div', {class: 'list'}, values.map(value => eventLink(typeof value === 'string' ? value : value.事件ID,
      typeof value === 'string' ? value : `${value.事件ID} · ${value.分支ID ?? ''}`))) : notice(empty)));
  list('没发生', result.没发生);
  list('新发生', result.新发生);
  box.append(section('分支不同', (result.分支不同 ?? []).length ? el('table', {class: 'table'},
    el('thead', {}, el('tr', {}, el('th', {}, '事件'), el('th', {}, '默认分支'), el('th', {}, '如果分支'))),
    el('tbody', {}, (result.分支不同 ?? []).map(item => el('tr', {}, el('td', {}, eventLink(item.事件ID)),
      el('td', {}, item.默认分支), el('td', {}, item.if分支))))) : notice('无')));
  list('停住的事件串', result.停住的事件串);
  box.append(section('影响面', (result.影响面 ?? []).length ? el('div', {class: 'list'},
    (result.影响面 ?? []).map(item => details(`${item.事件ID} · 下游 ${item.下游?.length ?? 0}`, el('div', {},
      el('p', {}, '下游：'), el('div', {class: 'list'}, (item.下游 ?? []).map(id => eventLink(id))),
      el('p', {}, '引用位置：'), pre(item.引用位置 ?? []))))) : notice('无')));
  box.append(section('异常', anomalies.length ? el('ul', {class: 'issue-list'}, anomalies.map(item =>
    el('li', {}, `${item.级别} ${item.规则} ${item.文件}：${item.说明}`))) : notice('无')));
  canvas.append(box);
}

async function runIf() {
  if (state.ifBusy) { state.ifQueued = true; return; }
  state.ifBusy = true;
  state.ifError = null;
  renderCanvas(); renderToolbar();
  try {
    const input = {};
    if (state.ifForm.方案) input.方案 = state.ifForm.方案;
    const excluded = [], branches = [];
    for (const [eventID, choice] of Object.entries(state.ifForm.选择)) {
      if (choice === '__exclude') excluded.push(eventID);
      else if (choice !== '__default') branches.push({事件ID: eventID, 分支ID: choice});
    }
    if (excluded.length) input.排除 = excluded;
    if (branches.length) input.分支 = branches;
    if (state.ifForm.停用.size) input.停用角色组 = [...state.ifForm.停用];
    const result = await request('/api/if', input);
    state.ifResult = result;
  }
  catch (error) { state.ifResult = null; state.ifError = error.message; }
  finally {
    state.ifBusy = false;
    renderCanvas();
    renderToolbar();
    if (state.ifQueued) { state.ifQueued = false; setTimeout(() => runIf(), 0); }
  }
}

async function previewEvent(event) {
  const draft = state.drafts.get(event.事件ID);
  const raw = draft?.raw ?? event.原文;
  const buttonNode = $('#saveEvent');
  buttonNode.disabled = true;
  try {
    state.previewError = null;
    const result = await request('/api/preview', {eventID: event.事件ID, raw, revision: event.revision});
    state.preview = {...result, raw, eventID: event.事件ID};
    state.saveReport = null;
    renderPreview();
    const dialog = $('#previewDialog');
    if (!dialog.open) dialog.showModal();
  }
  catch (error) {
    state.previewError = error.message;
    if (error.status === 409) toast(`${error.message}。请重新读取后再编辑。`);
    else toast(error.message);
  }
}

function issueList(items) {
  if (!items?.length) return null;
  return el('ul', {class: 'issue-list'}, items.map(item =>
    el('li', {}, `${item.级别 ?? ''} ${item.规则 ?? ''} ${item.文件 ?? ''}：${item.说明 ?? ''}`)));
}

function renderPreview() {
  const content = $('#previewContent');
  const saveButton = $('#saveEvent');
  const preview = state.preview;
  const report = state.saveReport;
  content.replaceChildren();
  if (state.previewError && !report) content.append(notice(state.previewError, 'error'));
  if (report) {
    append(content, [el('h3', {class: 'status-pass'}, '已保存'),
      el('dl', {class: 'fields'},
        el('dt', {}, '备份目录'), el('dd', {}, report.backup),
        el('dt', {}, '静态预览'), el('dd', {}, `${report.静态预览?.模式 ?? '—'} · ${report.静态预览?.通过 ? '通过' : '未通过'}`),
        el('dt', {}, '保存后检查'), el('dd', {}, `${report.检查?.模式 ?? '—'} · ${report.检查?.通过 ? '通过' : '未通过'}`),
        el('dt', {}, '摘要'), el('dd', {}, JSON.stringify(report.检查?.摘要 ?? {}))),
      notice(report.message ?? '', report.检查?.通过 ? '' : 'error'),
      issueList(report.检查?.错误列表), issueList(report.检查?.提示列表)]);
    saveButton.disabled = true;
    saveButton.textContent = '已保存';
    return;
  }
  if (!preview) { if (!state.previewError) content.append(notice('还没有预览。')); saveButton.disabled = true; return; }
  saveButton.textContent = '保存到原文件';
  const validation = preview.validation;
  content.append(el('h3', {class: validation.通过 ? 'status-pass' : 'status-fail'},
    `${validation.模式 ?? '静态检查'} · ${validation.通过 ? '通过' : '未通过'}${preview.unchanged ? ' · 内容未改变' : ''}`));
  if (!validation.通过) content.append(notice('预览未通过，不会签发保存令牌。', 'error'));
  if (validation.错误列表?.length) content.append(el('div', {}, el('p', {}, '错误：'), issueList(validation.错误列表)));
  if (validation.提示列表?.length) content.append(el('div', {}, el('p', {}, '提示：'), issueList(validation.提示列表)));
  content.append(section('预览保留的检查输入',
    el('dl', {class: 'fields'},
      el('dt', {}, '世界书'), el('dd', {}, preview.输入?.世界书 ?? '—'),
      el('dt', {}, '作者资料/出处'), el('dd', {}, `${preview.输入?.作者资料?.出处?.存在 ? '存在' : '不存在'} · ${preview.输入?.作者资料?.出处?.文件 ?? 0} 条`),
      el('dt', {}, '运行参数'), el('dd', {}, preview.输入?.运行参数?.来源 ?? '—'),
      el('dt', {}, '临时副本'), el('dd', {}, preview.输入?.临时副本 ?? '—'))));
  content.append(section('影响反查', el('dl', {class: 'fields'},
    el('dt', {}, '下游事件'), el('dd', {}, (preview.impact?.下游 ?? []).join('、') || '无'),
    el('dt', {}, '角色位置'), el('dd', {}, (preview.impact?.角色位置 ?? []).join('、') || '无'),
    el('dt', {}, '档案生效条件'), el('dd', {}, (preview.impact?.档案 ?? []).length
      ? JSON.stringify(preview.impact.档案) : '无')),
    el('p', {}, '引用它：'), pre(preview.impact?.引用它 ?? []),
    el('p', {}, '它引用：'), pre(preview.impact?.它引用 ?? []),
    preview.impact?.修改后 ? details('修改后的引用与结构', el('div', {},
      el('p', {}, '引用它：'), pre(preview.impact.修改后.引用它), el('p', {}, '下游：'),
      pre(preview.impact.修改后.下游))) : null));
  content.append(section('逐行差异', el('div', {class: 'diff'}, (preview.diff ?? []).map(row =>
    el('div', {class: `diff-row ${row.type === '+' ? 'add' : row.type === '-' ? 'remove' : ''}`},
      `${row.type} ${row.text}`)))));
  saveButton.disabled = !preview.token;
}

async function saveEvent() {
  const preview = state.preview;
  if (!preview?.token) return;
  const saveButton = $('#saveEvent');
  saveButton.disabled = true;
  try {
    const result = await request('/api/save', {token: preview.token, raw: preview.raw});
    state.saveReport = result;
    state.preview = null;
    state.previewError = null;
    state.drafts.delete(preview.eventID);
    renderPreview();
    toast(result.message);
    await loadData(true);
  }
  catch (error) {
    state.previewError = error.message;
    if (error.status === 409) {
      state.preview = null;
      toast(`${error.message}。预览已失效，请重新读取并预览。`);
      saveButton.disabled = true;
      renderPreview();
    }
    else { toast(error.message); renderPreview(); }
  }
}

function selectEvent(id) {
  if (!id) return;
  state.selected = {type: 'event', id};
  state.localFocus = id;
  renderCanvas();
  renderInspector();
}

function selectGroup(id) {
  if (!id) return;
  state.selected = {type: 'group', id};
  state.groupView.groupID = id;
  state.groupView.versionID = '';
  state.groupView.profileID = '';
  ensureGroupView();
  state.view = 'characters';
  renderAll();
}

function showView(view) {
  state.view = view;
  if (view === 'local') ensureLocalFocus();
  renderAll();
  if (view === 'if' && !state.ifResult && !state.ifBusy) runIf();
}

function renderAll() {
  renderHeader();
  renderViews();
  renderFilters();
  renderToolbar();
  renderCanvas();
  renderInspector();
  renderLegend();
  $('#viewTitle').textContent = {world: '世界主树', local: '局部关系', characters: '角色汇总', if: '如果视图'}[state.view] ?? '';
  $('#viewSubtitle').textContent = state.view === 'world'
    ? '按事件串分组的时间轴；缩放、折叠、搜索与筛选只影响显示。'
    : state.view === 'local'
      ? `围绕焦点展开 1–5 层；条件、排斥与普通关联来自现行引用索引。`
      : state.view === 'characters'
        ? '档案初始值、事件变化与暂存未接回项分区显示；替代旧成长树。'
        : '开局方案、排除、指定分支与停用角色组；结果由 whatIf 唯一计算。';
}

async function loadData(quiet = false) {
  try {
    const response = await fetch('/api/data', {cache: 'no-store'});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `读取失败（${response.status}）`);
    state.data = value;
    state.token = value.token;
    state.review = value.review ?? {revision: '', value: {notes: {}, layout: {}}};
    state.server = value.服务;
    state.error = null;
    if (state.selected?.type === 'event' && !eventByID(state.selected.id)) state.selected = null;
    if (state.selected?.type === 'group' && !groupByID(state.selected.id)) state.selected = null;
    ensureGroupView();
    ensureLocalFocus();
    if (state.preview?.eventID && !eventByID(state.preview.eventID)) state.preview = null;
  }
  catch (error) {
    state.error = error.message;
    state.data = null;
  }
  renderAll();
  if (!quiet && state.data) toast(`已读取 ${state.data.元数据.计数.事件} 个事件。`);
}

function bindControls() {
  $('#reload').addEventListener('click', guarded(() => loadData(true)));
  $('#search').addEventListener('input', event => { state.filters.search = event.target.value; renderCanvas(); });
  $('#characterFilter').addEventListener('change', event => {
    state.filters.character = event.target.value;
    state.filters.version = '';
    state.groupView.groupID = event.target.value;
    state.groupView.versionID = '';
    state.groupView.profileID = '';
    ensureGroupView();
    renderFilters(); renderCanvas();
  });
  $('#versionFilter').addEventListener('change', event => {
    state.filters.version = event.target.value;
    state.groupView.versionID = event.target.value;
    state.groupView.profileID = '';
    ensureGroupView();
    renderCanvas();
  });
  $('#primaryFilter').addEventListener('change', event => { state.filters.primary = event.target.value; renderCanvas(); });
  $('#tagFilter').addEventListener('change', event => { state.filters.tag = event.target.value; renderCanvas(); });
  $('#resultFilter').addEventListener('change', event => { state.filters.result = event.target.value; renderCanvas(); });
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    renderInspector();
  });
  $('#closePreview').addEventListener('click', () => $('#previewDialog').close());
  $('#saveEvent').addEventListener('click', guarded(saveEvent));
  window.addEventListener('beforeunload', event => {
    if (state.drafts.size || state.notesDirty || state.layoutDirty) { event.preventDefault(); event.returnValue = ''; }
  });
}

bindControls();
loadData(true);
