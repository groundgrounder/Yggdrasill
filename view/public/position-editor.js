// A 档角色位置图形化编辑：10 字段结构化表单 ↔ YAML 原文双模式、触发语料列表、编辑与新建。
import {$, append, el, notice, section, selectOptions, source} from './dom.js';
import {readLines} from './condition-editor.js';
import {submitPreview} from './inspector.js';

const POSITION_FIELDS = ['事件ID', '角色组ID', '角色概要', '角色定位', '适用分支', '介入条件', '角色知情',
  '主观记忆', '按分支', '事件触发语料'];
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const textOf = value => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);

function linesArea(value, {placeholder = '每行一项', aria} = {}) {
  const area = el('textarea', {class: 'compact', spellcheck: 'false', placeholder, 'aria-label': aria ?? placeholder});
  area.value = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : textOf(value);
  return area;
}

function dialogueEditor(item, app) {
  const value = isObj(item) ? clone(item) : {};
  const trigger = el('textarea', {class: 'compact', 'aria-label': '触发情境', placeholder: '条件文本'});
  trigger.value = textOf(value.触发情境);
  const quotes = linesArea(value.候选台词, {aria: '候选台词'});
  const purpose = el('input', {type: 'text', 'aria-label': '表达目的'});
  purpose.value = textOf(value.表达目的);
  const mood = el('input', {type: 'text', 'aria-label': '情绪或语气'});
  mood.value = textOf(value.情绪或语气);
  const limits = linesArea(value.触发限制, {aria: '触发限制'});
  const node = el('div', {class: 'dialogue-editor'},
    el('label', {class: 'field'}, el('span', {}, '触发情境'), trigger),
    el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '候选台词（每行一句）'), quotes),
      el('label', {class: 'field'}, el('span', {}, '表达目的'), purpose)),
    el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '情绪或语气'), mood),
      el('label', {class: 'field'}, el('span', {}, '触发限制（可省略）'), limits)));
  return {node, read: () => {
    const result = {触发情境: trigger.value, 候选台词: readLines(quotes.value)};
    if (purpose.value.trim()) result.表达目的 = purpose.value.trim();
    if (mood.value.trim()) result.情绪或语气 = mood.value.trim();
    const limitValues = readLines(limits.value);
    if (limitValues.length) result.触发限制 = limitValues;
    return result;
  }};
}

function dialogueList(dialogues, app) {
  const handles = (Array.isArray(dialogues) ? dialogues : []).map(item => dialogueEditor(item, app));
  const rows = el('div', {class: 'editor-rows', 'aria-label': '事件触发语料'});
  const repaint = () => {
    rows.replaceChildren(...handles.map((handle, index) => el('div', {class: 'editor-row'},
      el('div', {class: 'row-tools'},
        el('button', {type: 'button', text: '上移', disabled: index === 0,
          onClick: () => { if (index > 0) { [handles[index - 1], handles[index]] = [handles[index], handles[index - 1]]; repaint(); } }}),
        el('button', {type: 'button', text: '下移', disabled: index === handles.length - 1,
          onClick: () => { if (index < handles.length - 1) { [handles[index + 1], handles[index]] = [handles[index], handles[index + 1]]; repaint(); } }}),
        el('button', {type: 'button', text: '删除', onClick: () => { handles.splice(index, 1); repaint(); }})),
      handle.node)));
  };
  repaint();
  return {node: el('div', {}, rows, el('div', {class: 'edit-actions'},
      el('button', {type: 'button', text: '＋ 添加语料', onClick: () => { handles.push(dialogueEditor({}, app)); repaint(); }}))),
    read: () => handles.map(handle => handle.read())};
}

function positionForm(value, app, event, {onSync = null} = {}) {
  const content = isObj(value) ? value : {};
  const eventID = el('input', {type: 'text', readonly: '', 'aria-label': '事件ID'});
  eventID.value = textOf(content.事件ID) || event.事件ID;
  const groupID = el('input', {type: 'text', readonly: '', 'aria-label': '角色组ID'});
  groupID.value = textOf(content.角色组ID);
  const summary = el('textarea', {class: 'compact', 'aria-label': '角色概要'});
  summary.value = textOf(content.角色概要);
  const positioning = linesArea(content.角色定位, {aria: '角色定位'});
  const interlude = el('textarea', {class: 'compact', 'aria-label': '介入条件'});
  interlude.value = textOf(content.介入条件);
  const knowledge = linesArea(content.角色知情, {aria: '角色知情'});
  const memory = linesArea(content.主观记忆, {aria: '主观记忆'});

  const branchIDs = (event.分支 ?? []).map(branch => branch.分支ID).filter(Boolean);
  const applicable = el('div', {class: 'check-grid', 'aria-label': '适用分支'});
  for (const branchID of branchIDs) {
    const input = el('input', {type: 'checkbox',
      checked: Array.isArray(content.适用分支) ? content.适用分支.includes(branchID) : false});
    input.value = branchID;
    applicable.append(el('label', {class: 'check-row'}, input, branchID));
  }
  applicable.read = () => [...applicable.querySelectorAll('input')].filter(node => node.checked).map(node => node.value);

  const byBranch = isObj(content.按分支) ? content.按分支 : {};
  const byBranchBox = el('div', {class: 'editor-rows'});
  const byBranchAreas = {};
  for (const branchID of branchIDs) {
    const detail = isObj(byBranch[branchID]) ? byBranch[branchID] : {};
    const knowledgeArea = linesArea(detail.角色知情, {aria: `${branchID} 角色知情`});
    const memoryArea = linesArea(detail.主观记忆, {aria: `${branchID} 主观记忆`});
    byBranchAreas[branchID] = {knowledgeArea, memoryArea};
    byBranchBox.append(el('div', {class: 'editor-row'}, el('p', {class: 'caption'}, `分支 ${branchID}`),
      el('div', {class: 'two-fields'},
        el('label', {class: 'field'}, el('span', {}, '角色知情（可省略）'), knowledgeArea),
        el('label', {class: 'field'}, el('span', {}, '主观记忆（可省略）'), memoryArea))));
  }
  const dialogues = dialogueList(content.事件触发语料, app);

  const node = el('div', {class: 'position-form'},
    el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '事件ID（只读）'), eventID),
      el('label', {class: 'field'}, el('span', {}, '角色组ID（只读）'), groupID)),
    el('label', {class: 'field'}, el('span', {}, '角色概要'), summary),
    section('角色定位（每行一条短语）', positioning),
    branchIDs.length ? section('适用分支（不勾选即适用全部分支）', applicable) : null,
    el('label', {class: 'field'}, el('span', {}, '介入条件（可省略）'), interlude),
    section('角色知情 / 主观记忆（可省略，每行一条）', el('div', {class: 'two-fields'},
      el('label', {class: 'field'}, el('span', {}, '角色知情'), knowledge),
      el('label', {class: 'field'}, el('span', {}, '主观记忆'), memory))),
    branchIDs.length ? section('按分支（留空的分支不会写入）', byBranchBox) : null,
    section('事件触发语料', dialogues.node));

  const read = () => {
    const result = {事件ID: eventID.value.trim(), 角色组ID: groupID.value.trim(), 角色概要: summary.value,
      角色定位: readLines(positioning.value)};
    const applicableValues = applicable.read();
    if (applicableValues.length) result.适用分支 = applicableValues;
    if (interlude.value.trim()) result.介入条件 = interlude.value.trim();
    const knowledgeValues = readLines(knowledge.value);
    if (knowledgeValues.length) result.角色知情 = knowledgeValues;
    const memoryValues = readLines(memory.value);
    if (memoryValues.length) result.主观记忆 = memoryValues;
    const details = {};
    for (const [branchID, areas] of Object.entries(byBranchAreas)) {
      const knowledgeValues2 = readLines(areas.knowledgeArea.value);
      const memoryValues2 = readLines(areas.memoryArea.value);
      if (knowledgeValues2.length || memoryValues2.length) details[branchID] = {
        ...(knowledgeValues2.length ? {角色知情: knowledgeValues2} : {}),
        ...(memoryValues2.length ? {主观记忆: memoryValues2} : {}),
      };
    }
    if (Object.keys(details).length) result.按分支 = details;
    const dialogueValues = dialogues.read();
    if (dialogueValues.length) result.事件触发语料 = dialogueValues;
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
  const extra = isObj(value) ? Object.keys(value).filter(key => !POSITION_FIELDS.includes(key)) : [];
  return extra.length
    ? notice(`原文含角色位置表外字段：${extra.join('、')}；表单模式会丢弃它们，请改用 YAML 原文模式或在保存前移除。`, 'warn')
    : null;
}

function dualModeBar(mode, {toForm, toYaml}) {
  return el('div', {class: 'edit-actions mode-bar'},
    el('button', {type: 'button', class: mode === 'form' ? 'active' : '', 'aria-pressed': String(mode === 'form'),
      text: '结构化表单', onClick: toForm}),
    el('button', {type: 'button', class: mode === 'yaml' ? 'active' : '', 'aria-pressed': String(mode === 'yaml'),
      text: 'YAML 原文', onClick: toYaml}),
    el('span', {class: 'caption'}, mode === 'form' ? '表单按规范键序重排且不保留行内注释' : 'YAML 原文保留注释与顺序'));
}

export function renderPositionEditor(app, panel, event) {
  const positions = event.角色位置 ?? [];
  const existingIDs = new Set(positions.map(position => position.角色组ID).filter(Boolean));
  const options = [];
  for (const position of positions) options.push([`edit:${position.角色组ID}`, `编辑 ${position.角色组ID}`]);
  for (const group of app.groups()) if (!existingIDs.has(group.角色组ID))
    options.push([`new:${group.角色组ID}`, `＋ 新建 ${group.角色组ID}`]);
  const target = app.state.positionTarget?.eventID === event.事件ID && app.state.positionTarget?.groupID
    && options.some(([key]) => key.endsWith(`:${app.state.positionTarget.groupID}`))
    ? `${existingIDs.has(app.state.positionTarget.groupID) ? 'edit' : 'new'}:${app.state.positionTarget.groupID}`
    : options[0]?.[0] ?? null;
  const selector = el('select', {'aria-label': '选择角色位置'});
  selectOptions(selector, options, target);
  if (!options.length) {
    panel.append(section('角色位置编辑', notice('没有可编辑的角色组。')));
    return;
  }
  const box = el('div', {});
  const editorArea = el('div', {});
  selector.addEventListener('change', () => {
    const [mode, groupID] = selector.value.split(':');
    app.state.positionTarget = {eventID: event.事件ID, groupID};
    void mode;
    renderSelected(groupID);
  });

  const renderSelected = groupID => {
    const position = positions.find(item => item.角色组ID === groupID);
    const isNew = !position;
    const key = `${event.事件ID}\u0000${groupID}`;
    let draft = app.state.positionDrafts.get(key);
    if (!draft) {
      draft = isNew
        ? {mode: 'form', raw: null, revision: '', isNew: true, dirty: false,
          value: {事件ID: event.事件ID, 角色组ID: groupID, 角色概要: '', 角色定位: []}}
        : {mode: 'yaml', raw: position.原文, revision: position.revision, isNew: false, dirty: false, value: null};
      app.state.positionDrafts.set(key, draft);
    }
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
          try { draft.value = (await app.request('/api/yaml/parse', {kind: 'position', raw: draft.raw})).value; }
          catch (error) { app.toast(error.message); return; }
          draft.mode = 'form';
          repaint();
        }),
        toYaml: app.guarded(async () => {
          if (draft.mode === 'yaml') return;
          if (draft.readForm) draft.value = draft.readForm();
          const raw = (await app.request('/api/yaml/format', {kind: 'position', value: draft.value})).raw;
          draft.raw = raw;
          draft.mode = 'yaml';
          draft.readForm = null;
          repaint();
        }),
      }));
      if (draft.mode === 'yaml') {
        const area = el('textarea', {class: 'raw-editor', spellcheck: 'false', 'aria-label': '角色位置原文编辑'});
        area.value = draft.raw;
        area.addEventListener('input', () => {
          draft.raw = area.value;
          draft.value = null;
          draft.readForm = null;
          draft.dirty = draft.isNew || draft.raw !== position?.原文;
          app.state.preview = null;
          $('#saveEvent').disabled = true;
        });
        box.append(area, el('div', {class: 'edit-actions'},
          el('button', {type: 'button', class: 'primary', text: '检查并预览差异',
            onClick: app.guarded(() => previewDraft(app, event, groupID, draft))}),
          el('button', {type: 'button', text: '放弃本次编辑', onClick: () => {
            app.state.positionDrafts.delete(key);
            app.state.preview = null;
            renderSelected(groupID);
          }})), source(position?.文件 ?? `历史/事件/${event.事件ID}/角色/${groupID}.txt`));
      }
      else {
        const form = positionForm(draft.value, app, event, {onSync: value => { draft.value = value; markDirty(); }});
        draft.readForm = form.read;
        form.node.addEventListener('click', event => {
          if (!event.target.closest('button')) return;
          draft.value = draft.readForm();
          markDirty();
        });
        append(box, [unknownFieldNotice(draft.value), form.node,
          el('div', {class: 'edit-actions'},
            el('button', {type: 'button', class: 'primary', text: '检查并预览差异',
              onClick: app.guarded(() => previewDraft(app, event, groupID, draft))}),
            el('button', {type: 'button', text: '放弃本次编辑', onClick: () => {
              app.state.positionDrafts.delete(key);
              app.state.preview = null;
              renderSelected(groupID);
            }})), source(position?.文件 ?? `历史/事件/${event.事件ID}/角色/${groupID}.txt`)]);
      }
    };
    repaint();
    editorArea.replaceChildren(box);
  };

  const [initialMode, initialGroup] = (target ?? '').split(':');
  void initialMode;
  renderSelected(initialGroup);
  panel.append(section('角色位置编辑',
    notice('角色位置只覆盖本事件内该角色组的视角与语料；删除与改名仍在源文件完成。'),
    selector, editorArea));
}

async function previewDraft(app, event, groupID, draft) {
  let raw;
  if (draft.mode === 'form') {
    if (draft.readForm) draft.value = draft.readForm();
    raw = (await app.request('/api/yaml/format', {kind: 'position', value: draft.value})).raw;
    draft.raw = raw;
  }
  else raw = draft.raw;
  await submitPreview(app, {
    route: '/api/position/preview',
    body: {eventID: event.事件ID, groupID, raw, revision: draft.isNew ? '' : draft.revision},
    raw,
    afterSave: async () => {
      app.state.positionDrafts.delete(`${event.事件ID}\u0000${groupID}`);
      await app.loadData(true);
    },
  });
}
