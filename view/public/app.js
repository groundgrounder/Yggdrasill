import {$, button, details, el, notice, selectOptions} from './dom.js';
import {renderCharacterSummary, renderIfView, renderLocalGraph, renderTimeline, runIf} from './canvas-views.js';
import {renderInspector, saveEvent, saveReview} from './inspector.js';
import {renderContextView} from './context-view.js';
import {bindStatsDialog, openStatsDialog} from './stats-view.js';
import {bindCreateEventDialog, openCreateEventDialog} from './event-editor.js';

const state = {
  data: null, token: null, review: {revision: '', value: {notes: {}, layout: {}}}, server: null,
  view: 'world', selected: null, tab: 'detail',
  filters: {search: '', character: '', version: '', primary: '', tag: '', result: ''},
  zoom: 64, depth: 1, collapsed: new Set(),
  drafts: new Map(), notesDirty: false, layoutDirty: false, reviewStale: false,
  preview: null, previewError: null, saveReport: null, ifResult: null, ifBusy: false, ifError: null,
  ifForm: {方案: '', 选择: {}, 停用: new Set()}, ifQueued: false,
  groupView: {groupID: '', versionID: '', profileID: '', compareA: '', compareB: ''},
  positionDrafts: new Map(), positionTarget: null, createDraft: null,
  localFocus: '', error: null,
  toastTimer: null,
};

const events = () => state.data?.事件 ?? [];
const groups = () => state.data?.角色组 ?? [];
const eventByID = id => events().find(event => event.事件ID === id);
const groupByID = id => groups().find(group => group.角色组ID === id);
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
    ['context', '上下文预览', '只读'],
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
    items.push(button('台词统计 / 导出树', () => openStatsDialog(app), ''));
    items.push(button('＋ 新建事件', () => openCreateEventDialog(app), 'primary'));
  }
  else if (state.view === 'local') {
    ensureLocalFocus();
    items.push(el('span', {class: 'caption'}, state.localFocus ? `焦点：${eventByID(state.localFocus)?.事件标题 ?? state.localFocus}` : '无焦点事件'));
    for (let depth = 1; depth <= 5; depth++) items.push(button(`${depth} 层`,
      () => { state.depth = depth; renderCanvas(); renderToolbar(); }, state.depth === depth ? 'active' : ''));
    items.push(button('保存布局', guarded(() => saveReview(app)), state.layoutDirty ? 'primary' : ''));
  }
  else if (state.view === 'characters') {
    items.push(el('span', {class: 'caption'}, '档案初始值、事件变化与暂存分区显示'));
  }
  else if (state.view === 'context') {
    items.push(el('span', {class: 'caption'}, '只读推演一局；运行按钮在表单底部'));
  }
  else if (state.view === 'if') {
    items.push(button(state.ifBusy ? '计算中…' : '运行如果视图', guarded(() => runIf(app)), 'primary'));
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
  else if (state.view === 'context') {
    legend.replaceChildren(el('span', {}, '唯一事实来源：core/context-preview.mjs'),
      el('span', {}, '只读推演，不写世界书与本局'), el('span', {}, '预算审计与 ygg context 同源'));
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
    canvas.append(details('查看检查错误', el('pre', {class: 'raw'}, JSON.stringify(check.错误列表, null, 2))));
  }
  if (state.view === 'world') renderTimeline(app, canvas);
  else if (state.view === 'local') renderLocalGraph(app, canvas);
  else if (state.view === 'characters') renderCharacterSummary(app, canvas);
  else if (state.view === 'context') renderContextView(app, canvas);
  else renderIfView(app, canvas);
}

function selectEvent(id) {
  if (!id) return;
  state.selected = {type: 'event', id};
  state.localFocus = id;
  renderCanvas();
  renderInspector(app);
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
  if (view === 'if' && !state.ifResult && !state.ifBusy) runIf(app);
}

function renderAll() {
  renderHeader();
  renderViews();
  renderFilters();
  renderToolbar();
  renderCanvas();
  renderInspector(app);
  renderLegend();
  $('#viewTitle').textContent = {world: '世界主树', local: '局部关系', characters: '角色汇总',
    if: '如果视图', context: '上下文预览'}[state.view] ?? '';
  $('#viewSubtitle').textContent = state.view === 'world'
    ? '按事件串分组的时间轴；缩放、折叠、搜索与筛选只影响显示。'
    : state.view === 'local'
      ? `围绕焦点展开 1–5 层；条件、排斥与普通关联来自现行引用索引。`
      : state.view === 'characters'
        ? '档案初始值、事件变化与暂存未接回项分区显示；替代旧成长树。'
        : state.view === 'context'
          ? '封卷并路由一局，展示分块字符、预算占用与审计明细；单飞防重入。'
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
    for (const [key, draft] of state.drafts) if (!draft.dirty) state.drafts.delete(key);
    for (const [key, draft] of state.positionDrafts) if (!draft.dirty) state.positionDrafts.delete(key);
  }
  catch (error) {
    state.error = error.message;
    state.data = null;
  }
  renderAll();
  if (!quiet && state.data) toast(`已读取 ${state.data.元数据.计数.事件} 个事件。`);
}

const app = {
  state, events, groups, eventByID, groupByID, profilesOf, profileOf,
  selectedEvent, selectedGroup, selectedKey, eventGroupIDs, eventTimeLabel, filteredEvents,
  ensureGroupView, ensureLocalFocus, toast, guarded, request,
  renderHeader, renderToolbar, renderCanvas, renderAll,
  renderInspector: () => renderInspector(app),
  selectEvent, selectGroup, showView, loadData,
  runIf: () => runIf(app),
  saveEvent: () => saveEvent(app),
};

function bindControls() {
  $('#reload').addEventListener('click', guarded(() => loadData(true)));
  $('#search').addEventListener('input', event => { state.filters.search = event.target.value; renderViews(); renderCanvas(); });
  $('#characterFilter').addEventListener('change', event => {
    state.filters.character = event.target.value;
    state.filters.version = '';
    state.groupView.groupID = event.target.value;
    state.groupView.versionID = '';
    state.groupView.profileID = '';
    ensureGroupView();
    renderViews(); renderFilters(); renderCanvas();
  });
  $('#versionFilter').addEventListener('change', event => {
    state.filters.version = event.target.value;
    state.groupView.versionID = event.target.value;
    state.groupView.profileID = '';
    ensureGroupView();
    renderViews(); renderCanvas();
  });
  $('#primaryFilter').addEventListener('change', event => { state.filters.primary = event.target.value; renderViews(); renderCanvas(); });
  $('#tagFilter').addEventListener('change', event => { state.filters.tag = event.target.value; renderViews(); renderCanvas(); });
  $('#resultFilter').addEventListener('change', event => { state.filters.result = event.target.value; renderViews(); renderCanvas(); });
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    renderInspector(app);
  });
  $('#saveEvent').addEventListener('click', guarded(() => saveEvent(app)));
  bindCreateEventDialog(app);
  bindStatsDialog();
  $('#closePreview').addEventListener('click', () => $('#previewDialog').close());
  window.addEventListener('beforeunload', event => {
    const draftDirty = [...state.drafts.values()].some(draft => draft.dirty)
      || [...state.positionDrafts.values()].some(draft => draft.dirty);
    if (draftDirty || state.notesDirty || state.layoutDirty) { event.preventDefault(); event.returnValue = ''; }
  });
}

bindControls();
loadData(true);
