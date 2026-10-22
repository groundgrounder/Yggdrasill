import {has, isMap, isText, issue} from '../../core/utils.mjs';

export function checkSources(catalog) {
  if (!catalog.sources) return [];
  const issues = [], events = new Map(catalog.events.map(event => [event.id, event]));
  const add = (rule, file, message) => issues.push(issue(rule, '错误', file, message));
  for (const record of catalog.sources.记录) {
    const file = record.文件, value = record.内容, at = `${file}#${record.序号}`;
    if (!isMap(value)) { add('出处.格式', at, '记录须为映射'); continue; }
    for (const key of Object.keys(value)) if (!['事件ID', '角色组ID', '台词', '来源'].includes(key)) add('出处.格式', at, `含未知键“${key}”`);
    if (!isText(value.事件ID) || !isText(value.来源)) add('出处.格式', at, '记录须含事件ID与文本来源');
    if (has(value, '角色组ID') && !isText(value.角色组ID)) add('出处.格式', at, '角色组ID须为文本');
    if (has(value, '台词') && !isText(value.台词)) add('出处.格式', at, '台词须为文本');
    if (has(value, '角色组ID') !== has(value, '台词')) add('出处.格式', at, '角色组ID与台词必须同时出现');
    const event = events.get(value.事件ID);
    if (!event) { add('出处.引用', at, `事件“${value.事件ID}”不存在`); continue; }
    if (has(value, '角色组ID')) {
      const position = event.角色位置.find(item => item.角色组ID === value.角色组ID);
      if (!position) add('出处.引用', at, `事件“${value.事件ID}”没有角色组“${value.角色组ID}”的角色位置`);
      else {
        const candidates = position.内容?.事件触发语料?.flatMap(dialogue => dialogue?.候选台词 ?? []) ?? [];
        if (!candidates.includes(value.台词)) add('出处.引用', at, '台词不在该角色位置的候选台词中');
      }
    }
  }
  return issues;
}
