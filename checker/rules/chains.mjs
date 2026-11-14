import {CHAIN_FIELDS} from '../../core/contract.mjs';
import {conditionReferences} from '../../core/conditions.mjs';
import {chainStructure} from '../../core/graph.mjs';
import {has, isMap, isText, list, issue} from '../../core/utils.mjs';

export function checkChains(catalog, analysis) {
  const issues = [], owners = new Map(), events = new Map(catalog.events.map(event => [event.id, event]));
  const add = (rule, file, message, level = '错误') => issues.push(issue(rule, level, file, message));
  for (const chain of catalog.chains) {
    const file = chain.文件, value = chain.内容;
    if (!isMap(value)) { add('事件串.格式', file, '事件串内容须为映射'); continue; }
    for (const key of Object.keys(value)) if (!CHAIN_FIELDS.includes(key)) add('事件串.格式', file, `含未知字段“${key}”`);
    if (!isText(value.概述)) add('事件串.格式', file, '缺少概述或概述不是文本');
    if (!Array.isArray(value.事件) || !value.事件.length || new Set(value.事件).size !== value.事件.length) add('事件串.格式', file, '事件须为非空无重复列表');
    if (!Array.isArray(value.结局) || !value.结局.length) add('事件串.格式', file, '结局须为非空列表');
    const members = list(value.事件);
    if (members.some(id => !isText(id))) add('事件串.格式', file, '事件列表每项须为事件ID文本');
    for (const id of members) {
      if (!events.has(id)) add('事件串.引用', file, `事件“${id}”不存在`);
      if (owners.has(id)) add('事件串.重复归属', file, `事件“${id}”已属于事件串“${owners.get(id)}”`);
      else owners.set(id, chain.id);
    }
    for (const ending of list(value.结局)) {
      if (!isMap(ending) || !isText(ending.事件ID) || Object.keys(ending).some(key => !['事件ID', '分支ID'].includes(key))) { add('事件串.格式', file, '结局项须为含事件ID、可选分支ID的映射'); continue; }
      if (!events.has(ending.事件ID) || (ending.分支ID && !list(events.get(ending.事件ID)?.内容?.分支).some(branch => branch?.分支ID === ending.分支ID))) add('事件串.引用', file, '结局引用的事件或分支不存在');
      if (!members.includes(ending.事件ID)) add('事件串.引用', file, '结局事件必须属于本串');
    }
    if (!Array.isArray(value.事件) || !value.事件.length) continue;
    const structure = chainStructure(catalog, chain, analysis);
    if (!structure.起点.length) add('事件串.无起点', file, '本串没有起点');
    for (const ending of structure.结局) if (!structure.结局可达.some(item => item.事件ID === ending.事件ID && item.分支ID === ending.分支ID)) add('事件串.结局不可达', file, `结局“${ending.事件ID}${ending.分支ID ? `·${ending.分支ID}` : ''}”按乐观假设不可达`, '提示');
    for (const id of structure.孤立成员) add('事件串.孤立成员', file, `成员“${id}”与本串其它事件没有依赖关系`, '提示');
  }
  return issues;
}
