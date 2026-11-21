// 递归条件树编辑器：覆盖 all/any/none 任意嵌套与 11 类条件；未知结构保留原样，不静默丢失。
import {el, notice, selectOptions} from './dom.js';

const COMBINATORS = ['all', 'any', 'none'];
const TYPES = ['角色启用', '角色版本', '事件确认', '事件串状态', '当前时间', '剧情标记', '角色状态', '同处', '角色已出场', '当前场景', '在场实力人数'];
const PARAM_SPEC = {
  角色启用: [['角色组ID', 'group', false]],
  角色版本: [['角色组ID', 'group', false], ['版本ID', 'version', false]],
  事件确认: [['事件ID', 'event', false], ['分支ID', 'branch', true]],
  事件串状态: [['事件串ID', 'chain', false], ['状态', 'const:未开始|进行中|已结束', false]],
  当前时间: [['比较', 'const:小于|大于等于', false], ['值', 'text', false]],
  剧情标记: [['标记ID', 'mark', false], ['比较', 'const:等于|不等于', false], ['值', 'markValue', false]],
  角色状态: [['角色组ID', 'group', false], ['字段', 'stateField', false], ['属于', 'lines', false]],
  同处: [['角色组ID', 'lines', false]],
  角色已出场: [['角色组ID', 'group', false]],
  当前场景: [['地标', 'location', false], ['场景', 'text', false]],
  在场实力人数: [['最低实力', 'powerLevel', false], ['最少人数', 'integer', false], ['排除角色组', 'lines', true]],
};

const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const readLines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
let datalistSeq = 0;

function classify(value) {
  if (!isObj(value) || Object.keys(value).length !== 1) return {kind: 'unknown', key: null};
  const key = Object.keys(value)[0];
  if (COMBINATORS.includes(key)) return Array.isArray(value[key]) ? {kind: 'comb', key} : {kind: 'unknown', key};
  if (TYPES.includes(key)) return {kind: 'type', key};
  return {kind: 'unknown', key};
}

export function conditionEditor(initial, ctx) {
  const handle = node(initial ?? {all: []}, ctx, 0);
  return {node: handle.node, read: () => clone(handle.read())};
}

function node(initial, ctx, depth) {
  const state = {value: clone(initial)};
  const root = el('div', {class: `condition-node${depth ? ' nested' : ''}`});
  const mode = el('select', {class: 'condition-mode', 'aria-label': '条件类型'});
  const body = el('div', {class: 'condition-body'});
  root.append(mode, body);
  let read = () => state.value;

  const modeItems = () => {
    const items = COMBINATORS.map(name => [`comb:${name}`, `组合 ${name}`]);
    for (const name of TYPES) items.push([`type:${name}`, name]);
    items.push(['unknown', classify(state.value).kind === 'unknown' ? '未知（保留原样）' : '转为保留原样']);
    return items;
  };

  const drawCombinator = key => {
    const children = Array.isArray(state.value[key]) ? state.value[key] : [];
    const handles = children.map(child => node(child, ctx, depth + 1));
    const rows = el('div', {class: 'condition-children'});
    const repaint = () => {
      rows.replaceChildren(...handles.map((handle, index) => el('div', {class: 'condition-child'},
        el('div', {class: 'row-tools'},
          el('button', {type: 'button', text: '上移', disabled: index === 0,
            onClick: () => { if (index > 0) { [handles[index - 1], handles[index]] = [handles[index], handles[index - 1]]; repaint(); } }}),
          el('button', {type: 'button', text: '下移', disabled: index === handles.length - 1,
            onClick: () => { if (index < handles.length - 1) { [handles[index + 1], handles[index]] = [handles[index], handles[index + 1]]; repaint(); } }}),
          el('button', {type: 'button', text: '删除', onClick: () => { handles.splice(index, 1); repaint(); }})),
        handle.node)));
    };
    repaint();
    read = () => ({[key]: handles.map(handle => handle.read())});
    body.replaceChildren(el('p', {class: 'caption'},
      '组合不能为空；处于偶数层 none 之内的事件确认是正向引用，奇数层之内是排斥。'), rows,
      el('div', {class: 'edit-actions'}, el('button', {type: 'button', text: '＋ 添加子条件',
        onClick: () => { handles.push(node({角色启用: {角色组ID: ctx.groups()[0]?.角色组ID ?? ''}}, ctx, depth + 1)); repaint(); }})));
  };

  const drawType = key => {
    const params = isObj(state.value?.[key]) ? state.value[key] : {};
    const keep = {...params};
    const grid = el('div', {class: 'two-fields'});
    const controls = {};
    for (const [name, spec, optional] of PARAM_SPEC[key]) {
      const handle = control(name, spec, optional, keep, ctx);
      controls[name] = handle;
      grid.append(handle.node);
    }
    const link = (parentName, childName) =>
      controls[parentName].input.addEventListener('change', () => controls[childName].relink?.());
    if (key === '角色版本') link('角色组ID', '版本ID');
    if (key === '事件确认') link('事件ID', '分支ID');
    if (key === '剧情标记') link('标记ID', '值');
    read = () => ({[key]: keep});
    body.replaceChildren(grid);
    if (Object.keys(params).some(name => !PARAM_SPEC[key].some(([known]) => known === name)))
      body.append(notice('此条件含规范外的参数，表单会原样保留；保存前请修正。', 'warn'));
  };

  const drawUnknown = () => {
    const area = el('textarea', {class: 'raw-editor compact', spellcheck: 'false', 'aria-label': '条件原样 JSON'});
    area.value = JSON.stringify(state.value, null, 2);
    area.addEventListener('input', () => {
      try { state.value = JSON.parse(area.value); }
      catch { /* 输入未完成时保留上一次可解析值 */ }
    });
    read = () => state.value;
    body.replaceChildren(notice('此条件含未知类型、非单键结构或空值；表单按原样保留，切换类型会替换它。', 'warn'), area);
  };

  const draw = () => {
    const {kind, key} = classify(state.value);
    selectOptions(mode, modeItems(), kind === 'comb' ? `comb:${key}` : kind === 'type' ? `type:${key}` : 'unknown');
    if (kind === 'comb') drawCombinator(key);
    else if (kind === 'type') drawType(key);
    else drawUnknown();
  };

  mode.addEventListener('change', () => {
    const selected = mode.value;
    if (selected.startsWith('comb:')) state.value = {[selected.slice(5)]: []};
    else if (selected.startsWith('type:')) state.value = {[selected.slice(5)]: {}};
    draw();
  });

  draw();
  return {node: root, read: () => read()};
}

function control(name, spec, optional, params, ctx) {
  const kind = spec.split(':')[0];
  const constant = spec.startsWith('const:') ? spec.split(':').slice(1).join(':').split('|') : null;
  const set = value => { if (value === '' || (Array.isArray(value) && !value.length)) delete params[name]; else params[name] = value; };
  const blank = value => value === undefined || value === null || value === '';
  let input;
  let relink = null;
  const builders = {
    const: () => constant.map(value => [value, value]),
    group: () => ctx.groups().map(group => [group.角色组ID,
      `${group.显示名}${group.显示名 !== group.角色组ID ? ` · ${group.角色组ID}` : ''}`]),
    version: () => (ctx.groupByID(params.角色组ID)?.版本 ?? [])
      .map(version => [version.版本ID, version.显示名 ?? version.版本ID]),
    event: () => ctx.events().map(event => [event.事件ID, `${event.事件标题 ?? event.事件ID} · ${event.事件ID}`]),
    branch: () => [['', '（不指定分支）'],
      ...(ctx.eventByID(params.事件ID)?.分支 ?? []).map(branch => [branch.分支ID, branch.分支ID])],
    chain: () => (ctx.state.data?.事件串 ?? []).map(chain => [chain.事件串ID, chain.事件串ID]),
    mark: () => Object.keys(ctx.state.data?.声明?.剧情标记 ?? {}).map(mark => [mark, mark]),
    markValue: () => {
      const values = ctx.state.data?.声明?.剧情标记?.[params.标记ID];
      return Array.isArray(values) && values.length ? values.map(item => [item, item]) : [['', '（先选标记）']];
    },
    location: () => (ctx.state.data?.条目库?.地点?.标识 ?? []).map(id => [id, id]),
    powerLevel: () => (ctx.state.data?.声明?.综合实力等级 ?? []).map(level => [level, level]),
  };
  if (builders[kind]) {
    input = el('select', {'aria-label': optional ? `${name}（可省略）` : name});
    const declared = options => {
      const current = params[name];
      if (blank(current) || options.some(([key]) => String(key) === String(current))) return options;
      return [[current, `${current}（声明外）`], ...options];
    };
    selectOptions(input, declared(builders[kind]()), params[name]);
    if (!optional && input.value !== '' && blank(params[name])) params[name] = input.value;
    relink = () => {
      const options = builders[kind]();
      const legal = !blank(params[name]) && options.some(([key]) => String(key) === String(params[name]));
      const fallback = legal ? params[name] : (optional ? '' : (options.find(([key]) => key !== '')?.[0] ?? ''));
      selectOptions(input, options, fallback);
      set(fallback);
    };
    input.addEventListener('change', () => set(input.value));
  }
  else if (kind === 'stateField') {
    const listId = `stateFields${++datalistSeq}`;
    input = el('input', {type: 'text', list: listId, 'aria-label': name});
    input.value = typeof params[name] === 'string' ? params[name] : '';
    input.addEventListener('input', () => set(input.value));
    return {node: el('label', {class: 'field'}, el('span', {}, name), input,
      el('datalist', {id: listId}, (ctx.state.data?.声明?.角色状态字段 ?? []).map(field => el('option', {value: field})))), input, relink};
  }
  else if (kind === 'integer') {
    input = el('input', {type: 'number', step: '1', 'aria-label': name});
    input.value = Number.isFinite(params[name]) ? params[name] : '';
    input.addEventListener('input', () => { if (input.value !== '') set(Number(input.value)); });
  }
  else if (kind === 'lines') {
    input = el('textarea', {class: 'compact', 'aria-label': name, placeholder: '每行一项'});
    input.value = Array.isArray(params[name]) ? params[name].join('\n') : '';
    input.addEventListener('input', () => set(readLines(input.value)));
  }
  else {
    input = el('input', {type: 'text', 'aria-label': name});
    input.value = typeof params[name] === 'string' ? params[name] : '';
    input.addEventListener('input', () => set(input.value));
  }
  return {node: el('label', {class: 'field'}, el('span', {}, name), input), input, relink};
}
