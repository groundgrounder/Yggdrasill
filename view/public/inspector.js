import {$, append, button, details, el, field, notice, pill, pre, section, selectOptions, source} from './dom.js';
import {renderEventEditor} from './event-editor.js';
import {renderPositionEditor} from './position-editor.js';

export function profileDocuments(profile) {
  const parts = [];
  for (const kind of ['基本信息', '角色印象']) {
    const item = profile?.文档?.[kind];
    if (item?.原文) parts.push(`# ${kind}（${item.文件}）\n${item.原文}`);
  }
  return parts.join('\n\n');
}

export function profileMeta(profile) {
  return el('dl', {class: 'fields'},
    el('dt', {}, '档案'), el('dd', {}, profile.档案ID),
    el('dt', {}, '适用版本'), el('dd', {}, (profile.适用版本 ?? []).join('、') || '—'),
    el('dt', {}, '默认'), el('dd', {}, profile.默认 ? '是' : '否'),
    el('dt', {}, '前置档案'), el('dd', {}, profile.前置档案 || '—'),
    el('dt', {}, '生效条件'), el('dd', {}, profile.生效条件 ? JSON.stringify(profile.生效条件) : '—'),
    el('dt', {}, '初始能力'), el('dd', {}, profile.初始能力 ? JSON.stringify(profile.初始能力) : '—'),
    el('dt', {}, '初始装备'), el('dd', {}, profile.初始装备 ? JSON.stringify(profile.初始装备) : '—'));
}

export function renderProfileDocs(profile, open = false) {
  if (!profile) return notice('没有可显示的档案。');
  const body = el('div', {}, profileMeta(profile));
  for (const [kind, document] of Object.entries(profile.文档 ?? {}))
    body.append(details(kind, el('div', {}, pre(document.原文), source(document.文件))));
  body.append(notice('手动查阅档案原文；不读取本局快照，不代表事件当时已生效。'));
  return open ? body : details(`档案 ${profile.档案ID}`, body);
}

function renderRoleControls(app, container, group, event = null) {
  const groupSelect = el('select', {'aria-label': '查看角色组'});
  selectOptions(groupSelect, app.groups().map(item => [item.角色组ID,
    `${(event?.相关角色组 ?? []).includes(item.角色组ID) ? '相关 · ' : '手动查阅 · '}${item.显示名}`]), group?.角色组ID);
  groupSelect.addEventListener('change', () => {
    app.state.groupView.groupID = groupSelect.value;
    app.state.groupView.versionID = '';
    app.state.groupView.profileID = '';
    if (app.state.selected?.type === 'group') app.state.selected = {type: 'group', id: groupSelect.value};
    app.renderInspector();
  });
  const current = app.groupByID(groupSelect.value) ?? group;
  const versionSelect = el('select', {'aria-label': '档案版本'});
  selectOptions(versionSelect, (current?.版本 ?? []).map(item => [item.版本ID, item.显示名 ?? item.版本ID]),
    app.state.groupView.versionID);
  app.state.groupView.versionID = versionSelect.value;
  versionSelect.addEventListener('change', () => {
    app.state.groupView.versionID = versionSelect.value;
    app.state.groupView.profileID = '';
    app.renderInspector();
  });
  const applicable = app.profilesOf(current).filter(profile => !profile.适用版本?.length
    || profile.适用版本.includes(app.state.groupView.versionID));
  const profileSelect = el('select', {'aria-label': '时期档案'});
  selectOptions(profileSelect, applicable.map(profile => [profile.档案ID, profile.档案ID]), app.state.groupView.profileID);
  app.state.groupView.profileID = profileSelect.value;
  profileSelect.addEventListener('change', () => { app.state.groupView.profileID = profileSelect.value; app.renderInspector(); });
  container.append(el('div', {class: 'two-fields'},
    field('角色组', groupSelect), field('版本', versionSelect)), field('时期档案', profileSelect));
  return {group: current, version: app.state.groupView.versionID, profile: app.profileOf(current, profileSelect.value) ?? applicable[0]};
}

function renderEventDetail(app, panel, event) {
  const related = (event.相关角色组 ?? []).map(id => app.groupByID(id)).filter(Boolean);
  panel.append(el('p', {}, event.事件概要 || '（没有事件概要）'));
  panel.append(el('div', {}, pill(event.主类型 ?? '未分类', event.主类型 ? '' : 'warn'),
    ...(event.标签 ?? []).map(tag => pill(tag)), ...(event.事件结果 ?? []).map(result => pill(result, 'good'))));
  panel.append(el('dl', {class: 'fields'},
    el('dt', {}, '时间'), el('dd', {}, app.eventTimeLabel(event)),
    el('dt', {}, '地点'), el('dd', {}, (event.地点 ?? []).join('、') || '—'),
    el('dt', {}, '确认策略'), el('dd', {}, event.确认策略 || '—'),
    el('dt', {}, '核心参与者'), el('dd', {}, (event.核心参与者 ?? []).join('、') || '—'),
    el('dt', {}, '结构状态'), el('dd', {}, event.结构?.状态 ?? '未解析'),
    el('dt', {}, '事件串'), el('dd', {}, (event.事件串 ?? []).join('、') || '独立事件'),
    el('dt', {}, '影响范围'), el('dd', {}, event.影响范围 || '—')));
  if (related.length) panel.append(section('相关角色组',
    el('div', {class: 'list'}, related.map(group => button(`${group.显示名} · ${group.角色组ID}`,
      () => app.selectGroup(group.角色组ID), 'related-link')))));
  panel.append(section('完整门槛', event.门槛 ? pre(event.门槛) : notice('没有机器门槛。')));
  if (event.叙事条件) panel.append(section('叙事条件', pre(event.叙事条件)));
  panel.append(section('分支与变化', el('div', {class: 'list'}, (event.分支 ?? []).map(branch =>
    details(`${branch.分支ID ?? '未命名分支'}${branch.默认 ? ' · 默认' : ''}`,
      el('div', {}, el('dl', {class: 'fields'},
        el('dt', {}, '分支条件'), el('dd', {}, branch.分支条件 || '—'),
        el('dt', {}, '分支结果'), el('dd', {}, branch.分支结果 || '—')),
      branch.门槛 ? details('分支门槛', pre(branch.门槛)) : null,
      pre(branch.变化 ?? [])), branch.默认)))));
  const incoming = (app.state.data.关系 ?? []).filter(relation => relation.to === event.事件ID);
  const outgoing = (app.state.data.关系 ?? []).filter(relation => relation.from === event.事件ID);
  panel.append(section('直接关系',
    incoming.length || outgoing.length ? el('div', {class: 'list'}, [
      ...incoming.map(relation => button(`${relation.from} → 本事件\n${relation.种类} · ${relation.字段}${relation.极性 === '排斥' ? ' · 排斥' : ''}`,
        () => app.selectEvent(relation.from), 'related-link')),
      ...outgoing.map(relation => button(`本事件 → ${relation.to}\n${relation.种类} · ${relation.字段}${relation.极性 === '排斥' ? ' · 排斥' : ''}`,
        () => app.selectEvent(relation.to), 'related-link')),
    ]) : notice('没有直接事件引用。')));
  const quotes = app.state.data.台词统计?.按事件?.find(item => item.事件ID === event.事件ID);
  if (quotes) panel.append(section('本事件台词统计', el('dl', {class: 'fields'},
    el('dt', {}, '候选台词'), el('dd', {}, String(quotes.候选台词总数)),
    el('dt', {}, '原台词'), el('dd', {}, String(quotes.原台词数)),
    el('dt', {}, '作者台词'), el('dd', {}, String(quotes.作者台词数)),
    el('dt', {}, '事件级出处'), el('dd', {}, quotes.有事件级出处 ? '有' : '无')),
    notice('原台词按 作者资料/出处 记录匹配；不读取 来源资料/。')));
  const readOnly = Boolean(app.isReadOnly?.());
  panel.append(section('角色位置', (event.角色位置 ?? []).length
    ? el('div', {class: 'list'}, event.角色位置.map(position => details(
      `${position.角色组ID ?? '未知角色'} · ${position.文件}`,
      el('div', {}, pre(position.内容 ?? position.原文 ?? null), source(position.文件),
        readOnly ? null : button('在编辑面板编辑此角色位置', () => {
          app.state.tab = 'edit';
          app.state.positionTarget = {eventID: event.事件ID, groupID: position.角色组ID};
          app.renderInspector();
        }, 'related-link')))))
    : notice('本事件没有角色位置文件。')));
  panel.append(details('完整原文', el('div', {}, pre(event.原文), source(event.文件))));
}

function renderGroupDetail(app, panel, group) {
  const profile = app.profileOf(group, app.state.groupView.profileID) ?? app.profilesOf(group)[0];
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
      () => app.selectEvent(change.事件ID), 'related-link'))) : notice('没有事件变化写入本组。')));
  panel.append(section('暂存未接回', group.暂存.length ? el('div', {}, notice('以下内容尚未接回世界书，不计入当前档案或本局。', 'warn'),
    pre(group.暂存)) : notice('本组没有暂存清单项。')));
  panel.append(details('档案原文', renderProfileDocs(profile, true)));
  panel.append(source(group.文件));
}

function renderCharactersPanel(app, panel) {
  const event = app.selectedEvent();
  const preferred = event ? (event.相关角色组 ?? []).map(app.groupByID).filter(Boolean) : [];
  const current = app.groupByID(app.state.groupView.groupID);
  const group = app.selectedGroup() ?? (preferred.some(item => item.角色组ID === current?.角色组ID) ? current : null)
    ?? preferred[0] ?? current ?? app.groups()[0];
  if (!group) { panel.append(notice('没有角色组。')); return; }
  if (app.state.groupView.groupID !== group.角色组ID) {
    app.state.groupView.groupID = group.角色组ID;
    app.state.groupView.versionID = '';
    app.state.groupView.profileID = '';
  }
  panel.append(notice('作者对照视图。手动选择版本与时期；不读取本局快照，不按日期推定档案、知情或能力已生效。'));
  const controls = el('div', {});
  panel.append(controls);
  const selected = renderRoleControls(app, controls, group, event);
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

function ensureNote(app, key) {
  if (!key) return null;
  if (!app.state.review.value.notes[key]) app.state.review.value.notes[key] = {text: '', status: '待审'};
  return app.state.review.value.notes[key];
}

export async function saveReview(app) {
  if (app.isReadOnly?.() || !app.state.review) return;
  try {
    const response = await app.request('/api/review', {revision: app.state.review.revision, value: app.state.review.value});
    app.state.review = {revision: response.revision, value: response.value, damaged: false, error: null};
    app.state.notesDirty = false;
    app.state.layoutDirty = false;
    app.state.reviewStale = false;
    app.toast('批注与布局已保存；事件正文未变。');
    app.renderInspector();
    app.renderHeader();
  }
  catch (error) {
    if (error.status === 409) { app.state.reviewStale = true; app.toast(`${error.message}。请重新读取后再保存。`); app.renderInspector(); return; }
    throw error;
  }
}

function renderEditPanel(app, panel) {
  const key = app.selectedKey();
  if (!key) { panel.append(el('p', {class: 'caption'}, '先选择节点，即可批注或编辑。')); return; }
  const note = app.state.review.value.notes[key] ?? {text: '', status: '待审'};
  const status = el('select', {'aria-label': '审阅状态'});
  selectOptions(status, ['待审', '通过', '需调整'].map(value => [value, value]), note.status);
  const editor = el('textarea', {class: 'note-editor', 'aria-label': '审阅批注',
    placeholder: '写下疑点、修改方向或待补依据…'});
  editor.value = note.text;
  const sync = () => {
    const current = ensureNote(app, key);
    current.text = editor.value;
    current.status = status.value;
    app.state.notesDirty = true;
    app.renderHeader();
  };
  editor.addEventListener('input', sync);
  status.addEventListener('change', sync);
  panel.append(section('作者批注', status, editor,
    el('div', {class: 'edit-actions'}, button('保存批注与布局', app.guarded(() => saveReview(app)), 'primary'),
      app.state.reviewStale ? button('重新读取', app.guarded(() => app.loadData(true))) : null,
      app.state.notesDirty || app.state.layoutDirty ? el('span', {class: 'caption'}, '有未保存的批注或布局') : null),
    app.state.review.damaged ? notice(`审阅状态文件损坏：${app.state.review.error}。保存会重建该文件。`, 'error') : null));

  const event = app.selectedEvent();
  if (!event) { panel.append(notice('本节点只支持批注与布局；事件正文、档案与其他文件在对应视图中查阅。')); return; }
  renderEventEditor(app, panel, event);
  renderPositionEditor(app, panel, event);
  if (app.state.layoutDirty) panel.append(notice('图节点位置已修改；保存批注与布局会一并写入。', 'warn'));
}

export function renderInspector(app) {
  const visible = app.state.data !== null;
  const readOnly = Boolean(app.isReadOnly?.());
  if (readOnly && app.state.tab === 'edit') app.state.tab = 'detail';
  const title = $('#selectionTitle');
  const event = app.selectedEvent();
  const group = app.selectedGroup();
  title.replaceChildren(el('span', {class: 'eyebrow'}, event ? '正式事件' : group ? '角色组' : '选择一个节点'),
    el('h2', {}, event ? (event.事件标题 ?? event.事件ID) : group ? group.显示名 : '从故事开始审阅'));
  document.querySelectorAll('[data-tab]').forEach(node => {
    const isEditTab = node.dataset.tab === 'edit';
    if (isEditTab) node.hidden = readOnly;
    const active = !node.hidden && node.dataset.tab === app.state.tab;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  for (const name of ['detail', 'characters', 'edit']) {
    $('#' + name + 'Panel').hidden = (readOnly && name === 'edit') || app.state.tab !== name;
  }
  const detail = $('#detailPanel'), characters = $('#charactersPanel'), edit = $('#editPanel');
  detail.replaceChildren(); characters.replaceChildren(); edit.replaceChildren();
  if (!visible) { detail.append(el('p', {class: 'caption'}, app.state.error ? `世界书读取失败：${app.state.error}` : '正在读取世界书…')); return; }
  if (event) renderEventDetail(app, detail, event);
  else if (group) renderGroupDetail(app, detail, group);
  else detail.append(el('p', {class: 'caption'}, '点击时间轴、关系图或角色汇总中的节点，查看详情。'));
  renderCharactersPanel(app, characters);
  if (!readOnly) renderEditPanel(app, edit);
}

export async function submitPreview(app, {route, body, raw, afterSave = null}) {
  const buttonNode = $('#saveEvent');
  buttonNode.disabled = true;
  try {
    app.state.previewError = null;
    const result = await app.request(route, body);
    app.state.preview = {...result, raw, route, afterSave, eventID: result.eventID ?? body.eventID};
    app.state.saveReport = null;
    renderPreview(app);
    const dialog = $('#previewDialog');
    if (!dialog.open) dialog.showModal();
  }
  catch (error) {
    app.state.previewError = error.message;
    if (error.status === 409) app.toast(`${error.message}。请重新读取后再编辑。`);
    else app.toast(error.message);
  }
}

function issueList(items) {
  if (!items?.length) return null;
  return el('ul', {class: 'issue-list'}, items.map(item =>
    el('li', {}, `${item.级别 ?? ''} ${item.规则 ?? ''} ${item.文件 ?? ''}：${item.说明 ?? ''}`)));
}

function renderPreview(app) {
  const content = $('#previewContent');
  const saveButton = $('#saveEvent');
  const preview = app.state.preview;
  const report = app.state.saveReport;
  content.replaceChildren();
  if (app.state.previewError && !report) content.append(notice(app.state.previewError, 'error'));
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
  if (!preview) { if (!app.state.previewError) content.append(notice('还没有预览。')); saveButton.disabled = true; return; }
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

export async function saveEvent(app) {
  const preview = app.state.preview;
  if (!preview?.token) return;
  const saveButton = $('#saveEvent');
  saveButton.disabled = true;
  try {
    const result = await app.request('/api/save', {token: preview.token, raw: preview.raw});
    app.state.saveReport = result;
    app.state.preview = null;
    app.state.previewError = null;
    if (preview.route === '/api/preview') app.state.drafts.delete(preview.eventID);
    renderPreview(app);
    app.toast(result.message);
    if (preview.afterSave) await preview.afterSave(result);
    else await app.loadData(true);
  }
  catch (error) {
    app.state.previewError = error.message;
    if (error.status === 409) {
      app.state.preview = null;
      app.toast(`${error.message}。预览已失效，请重新读取并预览。`);
      saveButton.disabled = true;
      renderPreview(app);
    }
    else { app.toast(error.message); renderPreview(app); }
  }
}
