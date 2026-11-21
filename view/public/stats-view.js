// 台词统计 / 导出树弹窗：纯静态统计 + Markdown 事件树预览与下载；不读 来源资料/，不写世界书。
import {$, button, el, notice, section} from './dom.js';

function missingPositions(events) {
  const rows = [];
  for (const event of events ?? []) {
    for (const position of event.角色位置 ?? []) {
      const quotes = (position.内容?.事件触发语料 ?? [])
        .flatMap(dialogue => (dialogue?.候选台词 ?? []).filter(item => typeof item === 'string' && item.trim()));
      if (!quotes.length) rows.push(`${event.事件ID}／${position.角色组ID ?? '未知角色'}`);
    }
  }
  return rows;
}

export function openStatsDialog(app) {
  const data = app.state.data;
  if (!data) return;
  const stats = data.台词统计;
  const body = $('#statsBody');
  if (!stats) {
    body.replaceChildren(notice('本次数据未包含台词统计。', 'warn'));
    $('#statsDialog').showModal();
    return;
  }
  const total = stats.总计;
  const percent = value => `${(Number(value ?? 0) * 100).toFixed(2)}%`;
  const missing = missingPositions(data.事件);
  const preview = el('pre', {class: 'raw'}, '点击「预览 Markdown 事件树」加载。');
  const treeBox = el('details', {class: 'tree-preview'}, el('summary', {}, '事件树预览'), preview);
  body.replaceChildren(
    section('总计',
      el('dl', {class: 'fields'},
        el('dt', {}, '事件总数'), el('dd', {}, String(total.事件总数)),
        el('dt', {}, '有角色位置事件数'), el('dd', {}, String(total.有角色位置事件数)),
        el('dt', {}, '角色位置总数'), el('dd', {}, String(total.角色位置总数)),
        el('dt', {}, '有台词角色位置数'), el('dd', {}, String(total.有台词角色位置数)),
        el('dt', {}, '缺台词角色位置数'), el('dd', {}, String(total.缺台词角色位置数)),
        el('dt', {}, '候选台词总数'), el('dd', {}, String(total.候选台词总数)),
        el('dt', {}, '原台词数'), el('dd', {}, `${total.原台词数}（占比 ${percent(total.原台词占比)}）`),
        el('dt', {}, '作者台词数'), el('dd', {}, String(total.作者台词数)),
        el('dt', {}, '有事件级出处事件数'), el('dd', {}, String(total.有事件级出处事件数)),
        el('dt', {}, '台词记录总数'), el('dd', {}, String(total.台词记录总数))),
      notice('原台词按 作者资料/出处 的记录精确匹配；不读取 来源资料/，逐字一致由作者人工核对。')),
    section('按角色组', el('table', {class: 'table'},
      el('thead', {}, el('tr', {}, ['角色组', '角色位置', '有台词', '候选台词', '原台词', '作者台词', '原台词占比']
        .map(head => el('th', {}, head)))),
      el('tbody', {}, (stats.按角色组 ?? []).map(group => el('tr', {},
        el('td', {}, group.显示名), el('td', {}, String(group.角色位置数)),
        el('td', {}, String(group.有台词角色位置数)), el('td', {}, String(group.候选台词总数)),
        el('td', {}, String(group.原台词数)), el('td', {}, String(group.作者台词数)),
        el('td', {}, percent(group.原台词占比))))))),
    section(`缺台词角色位置（${missing.length}）`,
      missing.length
        ? el('ul', {class: 'issue-list'}, missing.map(item => el('li', {}, item)))
        : notice('无。')),
    section('Markdown 事件树', el('div', {class: 'edit-actions'},
      button('预览 Markdown 事件树', app.guarded(async () => {
        preview.textContent = await (await fetch('/api/tree.md', {cache: 'no-store'})).text();
        treeBox.setAttribute('open', '');
      })),
      el('a', {class: 'download-link', href: '/api/tree.md?download=1', download: 'event-tree.md'},
        '下载事件树 (.md)'),
      notice('导出在内存中生成，不向世界书目录写入文件。')),
      treeBox));
  $('#statsDialog').showModal();
}

export function bindStatsDialog() {
  $('#closeStats').addEventListener('click', () => $('#statsDialog').close());
}
