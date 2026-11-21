// 「上下文预览」视图：只读推演一局的路由上下文与预算占用；单飞防重入，不写任何文件。
import {details, el, field, notice, pre, section, selectOptions, button} from './dom.js';

const initialForm = () => ({方案: '', 开局: '', 地点: '', 场景: '', 在场: [], 消息: '', 自动初始化: true, raw: false});

function ensureState(app) {
  if (!app.state.contextForm) {
    app.state.contextForm = initialForm();
    app.state.contextResult = null;
    app.state.contextBusy = false;
    app.state.contextError = null;
  }
  return app.state;
}

export function renderContextView(app, canvas) {
  const data = app.state.data;
  const state = ensureState(app);
  const form = state.contextForm;

  const plan = el('select', {'aria-label': '开局方案'});
  selectOptions(plan, [['', '默认路径（时间轴末尾封卷）'],
    ...(data.开局?.方案 ?? []).map(item => [item.方案ID, `${item.方案ID}${item.概述 ? ` · ${item.概述}` : ''}`])], form.方案);
  plan.addEventListener('change', () => { form.方案 = plan.value; });
  const opening = el('input', {type: 'text', 'aria-label': '开局时间', placeholder: '按纪年书写，可留空'});
  opening.value = form.开局;
  opening.addEventListener('input', () => { form.开局 = opening.value; });

  const location = el('select', {'aria-label': '当前地点'});
  selectOptions(location, [['', '（不设置地点）'], ...(data.条目库?.地点?.标识 ?? []).map(id => [id, id])], form.地点);
  location.addEventListener('change', () => { form.地点 = location.value; });

  const scene = el('input', {type: 'text', 'aria-label': '场景文本', placeholder: '场景文本，可留空'});
  scene.value = form.场景;
  scene.addEventListener('input', () => { form.场景 = scene.value; });

  const present = el('div', {class: 'check-grid', 'aria-label': '在场角色组'});
  for (const group of app.groups()) {
    const input = el('input', {type: 'checkbox', checked: form.在场.includes(group.角色组ID)});
    input.value = group.角色组ID;
    input.addEventListener('change', () => {
      form.在场 = [...present.querySelectorAll('input')].filter(node => node.checked).map(node => node.value);
    });
    present.append(el('label', {class: 'check-row'}, input, `${group.显示名}${group.显示名 !== group.角色组ID ? ` · ${group.角色组ID}` : ''}`));
  }

  const messages = el('textarea', {class: 'compact', 'aria-label': '最近消息', placeholder: '每行一条最近消息，可留空'});
  messages.value = form.消息;
  messages.addEventListener('input', () => { form.消息 = messages.value; });

  const autoInit = el('input', {type: 'checkbox', checked: form.自动初始化});
  autoInit.addEventListener('change', () => { form.自动初始化 = autoInit.checked; });
  const rawBox = el('input', {type: 'checkbox', checked: form.raw});
  rawBox.addEventListener('change', () => { form.raw = rawBox.checked; });

  const run = el('button', {type: 'button', class: 'primary',
    text: state.contextBusy ? '推演中…' : '运行上下文预览',
    onClick: app.guarded(() => runPreview(app))});

  canvas.append(el('div', {class: 'card context-form'},
    notice('只读推演：封卷并路由一局，展示上下文分块、预算占用与审计明细；不写世界书、不调用叙事模型、不访问外网。'),
    el('div', {class: 'two-fields'},
      field('开局方案', plan), field('开局时间（可留空）', opening)),
    el('div', {class: 'two-fields'},
      field('当前地点', location), field('场景', scene)),
    section('在场角色组', present),
    field('最近消息（按非空行拆分）', messages),
    el('div', {class: 'two-fields'},
      el('label', {class: 'check-row'}, autoInit, '自动初始化未初始化的在场角色'),
      el('label', {class: 'check-row'}, rawBox, '包含完整渲染正文（raw）')),
    el('div', {class: 'edit-actions'}, run)));

  if (state.contextError) canvas.append(notice(state.contextError, 'error'));
  if (state.contextBusy) canvas.append(el('div', {class: 'empty'}, '正在推演上下文…'));
  if (state.contextResult) canvas.append(renderResult(app, state.contextResult));
  else if (!state.contextError && !state.contextBusy) canvas.append(el('div', {class: 'empty'},
    '选择方案、地点、场景或在场角色后运行；默认路径也会给出结果。'));
}

async function runPreview(app) {
  const state = ensureState(app);
  if (state.contextBusy) return;
  state.contextBusy = true;
  state.contextError = null;
  app.renderCanvas();
  try {
    const form = state.contextForm;
    const input = {};
    if (form.方案) input.方案 = form.方案;
    if (form.开局.trim()) input.开局 = form.开局.trim();
    if (form.地点) input.地点 = form.地点;
    if (form.场景.trim()) input.场景 = form.场景.trim();
    if (form.在场.length) input.在场 = form.在场;
    const lines = form.消息.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length) input.消息 = lines;
    if (!form.自动初始化) input.自动初始化 = false;
    if (form.raw) input.raw = true;
    state.contextResult = await app.request('/api/context', input);
  }
  catch (error) {
    state.contextResult = null;
    state.contextError = error.message;
  }
  finally {
    state.contextBusy = false;
    app.renderCanvas();
  }
}

function renderResult(app, result) {
  const box = el('div', {class: 'card if-result'});
  const input = result.输入 ?? {}, summary = result.汇总 ?? {}, budget = result.预算 ?? {};
  box.append(el('h3', {class: 'status-pass'}, '输入摘要'));
  box.append(el('dl', {class: 'fields'},
    el('dt', {}, '实际开局时间'), el('dd', {}, input.开局 ?? '—'),
    el('dt', {}, '方案'), el('dd', {}, input.方案 ?? '默认路径'),
    el('dt', {}, '地点 / 场景'), el('dd', {}, `${input.地点 ?? '—'} / ${input.场景 ?? '—'}`),
    el('dt', {}, '在场'), el('dd', {}, input.在场?.length ? input.在场.join('、') : '无'),
    el('dt', {}, '模拟初始化'), el('dd', {}, input.模拟初始化?.length ? input.模拟初始化.join('、') : '无'),
    el('dt', {}, '消息'), el('dd', {}, `${input.消息?.length ?? 0} 条`),
    el('dt', {}, '运行参数来源'), el('dd', {}, input.运行参数来源 ?? '—')));
  box.append(section('汇总',
    el('p', {}, el('strong', {}, `总字符 ${summary.总字符 ?? '—'}`)),
    el('table', {class: 'table'},
      el('thead', {}, el('tr', {}, el('th', {}, '分块'), el('th', {}, '字符'))),
      el('tbody', {}, Object.entries(summary.分块字符 ?? {}).map(([key, value]) =>
        el('tr', {}, el('td', {}, key), el('td', {}, String(value))))))));
  const budgetRows = Object.entries(budget.条目 ?? {}).map(([name, item]) =>
    el('tr', {}, el('td', {}, `条目·${name}`), el('td', {}, '—'),
      el('td', {}, `${item.已用字符} / ${item.预算上限} 字符`)));
  box.append(section('预算占用', el('table', {class: 'table'},
    el('thead', {}, el('tr', {}, el('th', {}, '类别'), el('th', {}, '条数'), el('th', {}, '字符'))),
    el('tbody', {},
      el('tr', {}, el('td', {}, '经历'),
        el('td', {}, `${budget.经历?.已用条数 ?? 0} / ${budget.经历?.条数上限 ?? '—'}`),
        el('td', {}, `${budget.经历?.已用字符 ?? 0} / ${budget.经历?.字符上限 ?? '—'}`)),
      el('tr', {}, el('td', {}, '候选'),
        el('td', {}, `${budget.候选?.已用条数 ?? 0} / ${budget.候选?.条数上限 ?? '—'}`),
        el('td', {}, `${budget.候选?.已用字符 ?? 0} / ${budget.候选?.字符上限 ?? '—'}`)),
      ...budgetRows))));
  const audit = result.审计 ?? {};
  box.append(details('审计明细（选入、略过原因、提及与异常）', el('div', {},
    section('经历', pre({选入: audit.经历?.选入 ?? [], 略过: audit.经历?.略过 ?? []})),
    section('候选', pre({选入: audit.候选?.选入 ?? [], 略过: audit.候选?.略过 ?? []})),
    section('条目', pre(audit.条目 ?? {})),
    section('提及检测', pre(audit.提及 ?? {})),
    section('异常', (audit.异常 ?? []).length
      ? el('ul', {class: 'issue-list'}, audit.异常.map(item =>
        el('li', {}, `${item.类型 ?? ''} ${item.事件ID ?? item.角色组ID ?? item.地点ID ?? ''}：${item.说明 ?? ''}`)))
      : notice('无异常。'))), false));
  if (result.正文) box.append(section('完整渲染正文', pre(result.正文)));
  void app;
  return box;
}
