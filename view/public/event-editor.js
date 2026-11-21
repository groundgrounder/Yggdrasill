// A 档单事件图形化编辑：18 字段结构化表单 ↔ YAML 原文双模式、递归条件与变化表、新建事件。
import {$, append, el, notice, pill, section, selectOptions, source} from './dom.js';
import {conditionEditor, readLines} from './condition-editor.js';
import {submitPreview} from './inspector.js';

const EVENT_FIELDS = ['事件ID', '事件标题', '事件概要', '主类型', '标签', '事件结果', '影响范围', '触发时间', '地点',
  '确认策略', '核心参与者', '门槛', '关联事件', '叙事条件', '公开信息', '隐秘信息', '默认分支', '分支'];
const CHANGE_OPS = ['设定', '新增', '移除', '增加', '减少', '提升'];
const VALUE_KINDS = [['text', '文本'], ['integer', '整数'], ['json', '映射或列表 JSON'], ['omit', '省略']];
let datalistSeq = 0;

const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const textOf = value => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);

function linesArea(value, {placeholder = '每行一项', aria} = {}) {
  const area = el('textarea', {class: 'compact', spellcheck: 'false', placeholder, 'aria-label': aria ?? placeholder});
  area.value = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : textOf(value);
  return area;
}

function checkboxGrid(values, options, aria) {
  const box = el('div', {class: 'check-grid', 'aria-label': aria});
  for (const option of options) {
    const input = el('input', {type: 'checkbox', checked: values.includes(option)});
    input.value = option;
    box.append(el('label', {class: 'check-row'}, input, option));
  }
  box.read = () => [...box.querySelectorAll('input')].filter(node => node.checked).map(node => node.value);
  return box;
}

function valueKind(change) {
  if (!isObj(change) || !('值' in change)) return 'omit';
  if (typeof change.值 === 'number') return 'integer';
  if (typeof change.值 === 'object') return 'json';
  return 'text';
}

function changeEditor(change, app) {
  const row = isObj(change) ? clone(change) : {};
  const listId = `changePaths${++datalistSeq}`;
  const path = el('input', {type: 'text', list: listId, 'aria-label': '变化路径', placeholder: '如：角色.灯塔学徒.所在'});
  path.value = textOf(row.路径);
  const op = el('select', {'aria-label': '操作'});
  selectOptions(op, CHANGE_OPS.map(value => [value, value]), textOf(row.操作) || '设定');
  const kind = el('select', {'aria-label': '值类型'});
  const initialKind = valueKind(row);
  selectOptions(kind, VALUE_KINDS, initialKind);
  const text = el('input', {type: 'text', 'aria-label': '值', placeholder: '文本值'});
  const number = el('input', {type: 'number', step: 'any', 'aria-label': '数值'});
  const json = el('textarea', {class: 'compact', spellcheck: 'false', 'aria-label': '映射或列表 JSON',
    placeholder: '{"键": "值"} 或 ["成员"]'});
  let kindValue = initialKind;
  text.value = typeof row.值 === 'string' ? row.值 : '';
  number.value = typeof row.值 === 'number' ? row.值 : '';
  json.value = typeof row.值 === 'object' && row.值 !== null ? JSON.stringify(row.值, null, 2) : '';
  const showKind = () => {
    text.hidden = kindValue !== 'text';
    number.hidden = kindValue !== 'integer';
    json.hidden = kindValue !== 'json';
  };
  kind.addEventListener('change', () => { kindValue = kind.value; showKind(); });
  showKind();
  const node = el('div', {class: 'change-row'}, el('datalist', {id: listId},
    [...(app.state.data?.声明?.角色可写字段 ?? []), ...(app.state.data?.声明?.世界可写字段 ?? [])]
      .map(item => el('option', {value: item}))),
    el('div', {class: 'two-fields'}, el('label', {class: 'field'}, el('span', {}, '路径'), path),
      el('label', {class: 'field'}, el('span', {}, '操作'), op)),
    el('div', {class: 'two-fields'}, el('label', {class: 'field'}, el('span', {}, '值类型'), kind),
      text, number, json));
  return {node, read: () => {
    const result = {路径: path.value.trim(), 操作: op.value};
    if (kindValue === 'integer') {
      const parsed = Number(number.value);
      result.值 = number.value !== '' && Number.isFinite(parsed) ? parsed : number.value;
    }
    else if (kindValue === 'json') { try { result.值 = JSON.parse(json.value); } catch { result.值 = json.value; } }
    else if (kindValue === 'text') result.值 = text.value;
    return result;
  }};
}

function listEditor({initial, create, render, toolbar, aria}) {
  const handles = (Array.isArray(initial) ? initial : []).map(item => create(item));
  const rows = el('div', {class: 'editor-rows', 'aria-label': aria});
  let ready = false;
  const repaint = () => {
    rows.replaceChildren(...handles.map((handle, index) => el('div', {class: 'editor-row'},
      el('div', {class: 'row-tools'},
        el('button', {type: 'button', text: '上移', disabled: index === 0,
          onClick: () => { if (index > 0) { [handles[index - 1], handles[index]] = [handles[index], handles[index - 1]]; repaint(); } }}),
        el('button', {type: 'button', text: '下移', disabled: index === handles.length - 1,
          onClick: () => { if (index < handles.length - 1) { [handles[index + 1], handles[index]] = [handles[index], handles[index + 1]]; repaint(); } }}),
        el('button', {type: 'button', text: '删除', disabled: handles.length <= (toolbar.min ?? 0),
          onClick: () => { handles.splice(index, 1); repaint(); }})),
      render(handle))));
    if (ready) toolbar.onChange?.();
  };
  repaint();
  ready = true;
  const node = el('div', {}, rows, el('div', {class: 'edit-actions'},
    el('button', {type: 'button', text: `＋ ${toolbar.addLabel}`,
      onClick: () => { handles.push(create(toolbar.blank(handles.length))); repaint(); }})));
  return {node, read: () => handles.map(handle => handle.read()), repaint};
}

function changeListEditor(changes, app) {
  return listEditor({initial: changes, aria: '变化表',
    create: item => changeEditor(item, app),
    render: handle => handle.node,
    toolbar: {addLabel: '添加变化', blank: () => ({路径: '', 操作: '设定', 值: ''})}});
}

function branchEditor(branch, app) {
  const value = isObj(branch) ? clone(branch) : {};
  const id = el('input', {type: 'text', 'aria-label': '分支ID'});
  id.value = textOf(value.分支ID);
  const condition = el('textarea', {class: 'compact', 'aria-label': '分支条件'});
  condition.value = textOf(value.分支条件);
  const outcome = el('textarea', {class: 'compact', 'aria-label': '分支结果'});
  outcome.value = textOf(value.分支结果);
  const gate = el('input', {type: 'checkbox', checked: isObj(value.门槛)});
  const gateEditor = conditionEditor(value.门槛, app);
  gateEditor.node.hidden = !gate.checked;
  gate.addEventListener('change', () => { gateEditor.node.hidden = !gate.checked; });
  const changes = changeListEditor(value.变化, app);
  const node = el('div', {class: 'branch-editor'},
    el('label', {class: 'field'}, el('span', {}, '分支ID'), id),
    el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '分支条件'), condition),
      el('label', {class: 'field'}, el('span', {}, '分支结果'), outcome)),
    el('label', {class: 'check-row'}, gate, '本分支带机器门槛'),
    gateEditor.node, changes.node);
  return {node, read: () => {
    const result = {分支ID: id.value.trim(), 分支条件: condition.value, 分支结果: outcome.value};
    if (gate.checked) result.门槛 = gateEditor.read();
    const rows = changes.read();
    if (rows.length) result.变化 = rows;
    return result;
  }};
}

function branchListEditor(branches, app, onBranches) {
  return listEditor({initial: branches, aria: '分支列表',
    create: item => branchEditor(item, app),
    render: handle => handle.node,
    toolbar: {addLabel: '添加分支', min: 1, blank: count => ({分支ID: `分支${count + 2}`, 分支条件: '', 分支结果: ''}),
      onChange: onBranches}});
}

function eventForm(value, app, {idInput = null, onSync = null} = {}) {
  const data = app.state.data;
  const content = isObj(value) ? value : {};
  const ownID = idInput ?? el('input', {type: 'text', readonly: '', 'aria-label': '事件ID'});
  if (!idInput) ownID.value = textOf(content.事件ID);
  const title = el('input', {type: 'text', 'aria-label': '事件标题'});
  title.value = textOf(content.事件标题);
  const summary = el('textarea', {class: 'compact', 'aria-label': '事件概要'});
  summary.value = textOf(content.事件概要);
  const scope = el('textarea', {class: 'compact', 'aria-label': '影响范围'});
  scope.value = textOf(content.影响范围);
  const narrative = el('textarea', {class: 'compact', 'aria-label': '叙事条件'});
  narrative.value = textOf(content.叙事条件);

  const primary = el('select', {'aria-label': '主类型'});
  selectOptions(primary, (data.分类.主类型 ?? []).map(item => [item, item]), content.主类型);
  const policy = el('select', {'aria-label': '确认策略'});
  selectOptions(policy, (data.声明?.确认策略 ?? []).map(item => [item, item]), content.确认策略);

  const tags = checkboxGrid(content.标签 ?? [], data.分类.标签 ?? [], '标签');
  const results = checkboxGrid(content.事件结果 ?? [], data.分类.事件结果 ?? [], '事件结果');
  const locations = checkboxGrid(content.地点 ?? [], data.条目库?.地点?.标识 ?? [], '地点');
  const participants = checkboxGrid(content.核心参与者 ?? [], app.groups().map(group => group.角色组ID), '核心参与者');

  const earliest = el('input', {type: 'text', 'aria-label': '触发时间最早'});
  earliest.value = textOf(content.触发时间?.最早);
  const latest = el('input', {type: 'text', 'aria-label': '触发时间最晚'});
  latest.value = textOf(content.触发时间?.最晚);

  const gate = el('input', {type: 'checkbox', checked: isObj(content.门槛)});
  const gateEditor = conditionEditor(content.门槛, app);
  gateEditor.node.hidden = !gate.checked;
  gate.addEventListener('change', () => { gateEditor.node.hidden = !gate.checked; });

  const related = linesArea(content.关联事件, {aria: '关联事件'});
  const open = linesArea(content.公开信息, {aria: '公开信息'});
  const secret = linesArea(content.隐秘信息, {aria: '隐秘信息'});

  const defaultBranch = el('select', {'aria-label': '默认分支'});
  const refreshDefaultBranch = () => {
    const current = defaultBranch.value;
    const ids = branches.read().map(item => item.分支ID).filter(Boolean);
    selectOptions(defaultBranch, ids.map(item => [item, item]), ids.includes(current) ? current : undefined);
  };
  const branches = branchListEditor(content.分支 ?? [], app, refreshDefaultBranch);
  const initialBranchIDs = branches.read().map(item => item.分支ID).filter(Boolean);
  selectOptions(defaultBranch, initialBranchIDs.map(item => [item, item]),
    initialBranchIDs.includes(content.默认分支) ? content.默认分支 : undefined);
  branches.node.addEventListener('input', event => {
    if (event.target.getAttribute('aria-label') === '分支ID') refreshDefaultBranch();
  });

  const node = el('div', {class: 'event-form'},
    idInput ? null : el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '事件ID（只读）'), ownID),
      el('label', {class: 'field'}, el('span', {}, '事件标题（可省略）'), title)),
    idInput ? el('label', {class: 'field'}, el('span', {}, '事件标题（可省略）'), title) : null,
    el('label', {class: 'field'}, el('span', {}, '事件概要'), summary),
    el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '主类型'), primary),
      el('label', {class: 'field'}, el('span', {}, '确认策略'), policy)),
    section('标签与事件结果（检查要求非空）', tags, results),
    section('触发时间（按纪年书写）',
      el('div', {class: 'two-fields'},
        el('label', {class: 'field'}, el('span', {}, '最早'), earliest),
        el('label', {class: 'field'}, el('span', {}, '最晚'), latest))),
    section('地点（可省略）', locations),
    section('核心参与者（可为空列表，不含玩家）', participants),
    el('label', {class: 'check-row'}, gate, '本事件带机器门槛'),
    gateEditor.node,
    section('关联事件（可省略，每行一个事件ID）', related),
    el('label', {class: 'field'}, el('span', {}, '影响范围（可省略）'), scope),
    el('label', {class: 'field'}, el('span', {}, '叙事条件（可省略）'), narrative),
    section('公开信息 / 隐秘信息（可省略，每行一条）', el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '公开信息'), open),
      el('label', {class: 'field'}, el('span', {}, '隐秘信息'), secret))),
    el('label', {class: 'field'}, el('span', {}, '默认分支'), defaultBranch),
    section('分支（至少一个；自动确认事件带门槛分支时须有不带门槛的兜底分支）', branches.node));

  const read = () => {
    const result = {事件ID: (idInput ?? ownID).value.trim(), 事件概要: summary.value};
    if (title.value.trim()) result.事件标题 = title.value.trim();
    result.主类型 = primary.value;
    const tagValues = tags.read();
    if (tagValues.length) result.标签 = tagValues;
    const resultValues = results.read();
    if (resultValues.length) result.事件结果 = resultValues;
    if (scope.value.trim()) result.影响范围 = scope.value.trim();
    result.触发时间 = {最早: earliest.value.trim(), 最晚: latest.value.trim()};
    const locationValues = locations.read();
    if (locationValues.length) result.地点 = locationValues;
    result.确认策略 = policy.value;
    result.核心参与者 = participants.read();
    if (gate.checked) result.门槛 = gateEditor.read();
    const relatedValues = readLines(related.value);
    if (relatedValues.length) result.关联事件 = relatedValues;
    if (narrative.value.trim()) result.叙事条件 = narrative.value.trim();
    const openValues = readLines(open.value);
    if (openValues.length) result.公开信息 = openValues;
    const secretValues = readLines(secret.value);
    if (secretValues.length) result.隐秘信息 = secretValues;
    result.默认分支 = defaultBranch.value;
    result.分支 = branches.read();
    return result;
  };
  if (onSync) {
    const sync = () => onSync(read());
    node.addEventListener('input', sync);
    node.addEventListener('change', sync);
  }
  return {node, read};
}

function unknownFieldNotice(value) {
  const extra = isObj(value) ? Object.keys(value).filter(key => !EVENT_FIELDS.includes(key)) : [];
  return extra.length
    ? notice(`原文含事件表外字段：${extra.join('、')}；表单模式会丢弃它们，请改用 YAML 原文模式或在保存前移除。`, 'warn')
    : null;
}

function dualModeBar(mode, {toForm, toYaml}) {
  return el('div', {class: 'edit-actions mode-bar'},
    el('button', {type: 'button', class: mode === 'form' ? 'active' : '', 'aria-pressed': String(mode === 'form'),
      text: '结构化表单', onClick: toForm}),
    el('button', {type: 'button', class: mode === 'yaml' ? 'active' : '', 'aria-pressed': String(mode === 'yaml'),
      text: 'YAML 原文', onClick: toYaml}),
    pill(mode === 'form' ? '表单按规范键序重排且不保留行内注释；需保留注释请用 YAML 原文模式' : 'YAML 原文保留注释与顺序'));
}

export function ensureEventDraft(app, event) {
  let draft = app.state.drafts.get(event.事件ID);
  if (!draft) {
    draft = {mode: 'yaml', raw: event.原文, value: null, revision: event.revision, dirty: false};
    app.state.drafts.set(event.事件ID, draft);
  }
  return draft;
}

export function renderEventEditor(app, panel, event) {
  const draft = ensureEventDraft(app, event);
  const box = el('div', {});
  const markDirty = () => {
    draft.dirty = true;
    app.state.preview = null;
    $('#saveEvent').disabled = true;
    app.renderHeader();
  };
  const repaint = () => {
    box.replaceChildren(dualModeBar(draft.mode, {
      toForm: app.guarded(async () => {
        if (draft.mode === 'form') return;
        try { draft.value = (await app.request('/api/yaml/parse', {kind: 'event', raw: draft.raw})).value; }
        catch (error) { app.toast(error.message); return; }
        draft.mode = 'form';
        repaint();
      }),
      toYaml: app.guarded(async () => {
        if (draft.mode === 'yaml') return;
        if (draft.readForm) draft.value = draft.readForm();
        const raw = (await app.request('/api/yaml/format', {kind: 'event', value: draft.value})).raw;
        draft.raw = raw;
        draft.mode = 'yaml';
        draft.readForm = null;
        repaint();
      }),
    }));
    if (draft.mode === 'yaml') {
      const area = el('textarea', {class: 'raw-editor', spellcheck: 'false', 'aria-label': '事件原文编辑'});
      area.value = draft.raw;
      area.addEventListener('input', () => {
        draft.raw = area.value;
        draft.value = null;
        draft.readForm = null;
        draft.dirty = draft.raw !== event.原文;
        app.state.preview = null;
        $('#saveEvent').disabled = true;
        app.renderHeader();
      });
      box.append(area, el('div', {class: 'edit-actions'},
        el('button', {type: 'button', class: 'primary', text: '检查并预览差异',
          onClick: app.guarded(() => previewDraft(app, event, draft))}),
        el('button', {type: 'button', text: '恢复已读取原文', onClick: () => {
          if (draft.dirty && !confirm('丢弃这个事件尚未保存的编辑？')) return;
          app.state.drafts.delete(event.事件ID);
          app.state.preview = null;
          app.renderInspector();
        }})), source(event.文件));
    }
    else {
      const form = eventForm(draft.value, app, {onSync: value => { draft.value = value; markDirty(); }});
      draft.readForm = form.read;
      form.node.addEventListener('click', event => {
        if (!event.target.closest('button')) return;
        draft.value = draft.readForm();
        markDirty();
      });
      append(box, [unknownFieldNotice(draft.value), form.node,
        el('div', {class: 'edit-actions'},
          el('button', {type: 'button', class: 'primary', text: '检查并预览差异',
            onClick: app.guarded(() => previewDraft(app, event, draft))}),
          el('button', {type: 'button', text: '恢复已读取原文', onClick: () => {
            if (draft.dirty && !confirm('丢弃这个事件尚未保存的编辑？')) return;
            app.state.drafts.delete(event.事件ID);
            app.state.preview = null;
            app.renderInspector();
          }})), source(event.文件)]);
    }
  };
  repaint();
  panel.append(section('编辑正式事件',
    notice('候选是现行事件 .txt 的 YAML 原文；不要添加 <事件> 外壳。事件ID固定，删除与改名仍在源文件完成。'),
    box));
}

async function previewDraft(app, event, draft) {
  let raw;
  if (draft.mode === 'form') {
    if (draft.readForm) draft.value = draft.readForm();
    raw = (await app.request('/api/yaml/format', {kind: 'event', value: draft.value})).raw;
    draft.raw = raw;
  }
  else raw = draft.raw;
  await submitPreview(app, {route: '/api/preview', body: {eventID: event.事件ID, raw, revision: draft.revision}, raw});
}

function createSkeleton(app) {
  const data = app.state.data;
  const calendar = data.元数据.日历;
  const day = `${calendar?.前缀 ?? ''}${String(75).padStart(calendar?.年位数 ?? 4, '0')}年01月01日`;
  return {
    事件ID: '', 事件概要: '', 主类型: data.分类.主类型[0] ?? '',
    标签: (data.分类.标签 ?? []).slice(0, 1), 事件结果: (data.分类.事件结果 ?? []).slice(0, 1),
    触发时间: {最早: day, 最晚: day}, 确认策略: data.声明?.确认策略?.[0] ?? '自动确认',
    核心参与者: [], 默认分支: '默认', 分支: [{分支ID: '默认',
      分支条件: '写下本分支成立的叙事条件。', 分支结果: '写下本分支的结果。'}],
  };
}

export function openCreateEventDialog(app) {
  if (!app.state.data) return;
  const dialog = $('#createEventDialog');
  if (!app.state.createDraft) app.state.createDraft = {eventID: '', mode: 'form', raw: null, value: createSkeleton(app)};
  const draft = app.state.createDraft;
  const idInput = el('input', {type: 'text', 'aria-label': '事件ID', placeholder: '用作目录名，不能含路径分隔符'});
  idInput.value = draft.eventID;
  idInput.addEventListener('input', () => { draft.eventID = idInput.value.trim(); });
  const box = el('div', {});
  const repaint = () => {
    box.replaceChildren();
    box.append(el('label', {class: 'field'}, el('span', {}, '事件ID（新建，同时用于目录名）'), idInput),
      dualModeBar(draft.mode, {
        toForm: app.guarded(async () => {
          if (draft.mode === 'form') return;
          try { draft.value = (await app.request('/api/yaml/parse', {kind: 'event', raw: draft.raw})).value; }
          catch (error) { app.toast(error.message); return; }
          draft.eventID = textOf(draft.value.事件ID);
          idInput.value = draft.eventID;
          draft.mode = 'form';
          repaint();
        }),
        toYaml: app.guarded(async () => {
          if (draft.mode === 'yaml') return;
          if (draft.readForm) draft.value = draft.readForm();
          draft.value.事件ID = draft.eventID;
          const raw = (await app.request('/api/yaml/format', {kind: 'event', value: draft.value})).raw;
          draft.raw = raw;
          draft.mode = 'yaml';
          draft.readForm = null;
          repaint();
        }),
      }));
    if (draft.mode === 'form') {
      const form = eventForm(draft.value, app, {idInput, onSync: value => { draft.value = value; }});
      draft.readForm = form.read;
      form.node.addEventListener('click', event => {
        if (!event.target.closest('button')) return;
        draft.value = draft.readForm();
      });
      append(box, [unknownFieldNotice(draft.value), form.node,
        notice('预填的是合法基础骨架；触发时间、概要与分类请按剧情改写。')]);
    }
    else {
      const area = el('textarea', {class: 'raw-editor', spellcheck: 'false', 'aria-label': '事件原文'});
      area.value = draft.raw;
      area.addEventListener('input', () => { draft.raw = area.value; });
      box.append(area, notice('YAML 模式下以顶部“事件ID”输入为准；与原文不一致时预览会拒绝。'));
    }
  };
  repaint();
  $('#createEventBody').replaceChildren(box);
  if (!dialog.open) dialog.showModal();
}

export function bindCreateEventDialog(app) {
  $('#closeCreateEvent').addEventListener('click', () => {
    $('#createEventDialog').close();
    app.state.createDraft = null;
  });
  $('#createEventPreview').addEventListener('click', app.guarded(async () => {
    const draft = app.state.createDraft;
    if (!draft) return;
    if (!draft.eventID) { app.toast('先在顶部输入事件ID。'); return; }
    let raw;
    if (draft.mode === 'form') {
      if (draft.readForm) draft.value = draft.readForm();
      raw = (await app.request('/api/yaml/format', {kind: 'event', value: {...draft.value, 事件ID: draft.eventID}})).raw;
    }
    else raw = draft.raw;
    await submitPreview(app, {
      route: '/api/event/create/preview', body: {eventID: draft.eventID, raw}, raw,
      afterSave: async () => {
        $('#createEventDialog').close();
        app.state.createDraft = null;
        await app.loadData(true);
        app.selectEvent(draft.eventID);
      },
    });
  }));
}
