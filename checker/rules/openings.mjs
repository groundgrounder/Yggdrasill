import {createCalendar} from '../../core/calendar.mjs';
import {OPENING_OPTION_FIELDS, OPENING_PLAN_FIELDS, WORLDLINE_FIELDS} from '../../core/contract.mjs';
import {referenceExists} from '../../core/fields.mjs';
import {has, isMap, isText, list, issue} from '../../core/utils.mjs';

export function checkOpenings(catalog, decl) {
  const issues = [], events = new Map(catalog.events.map(event => [event.id, event]));
  const add = (rule, file, message) => issues.push(issue(rule, '错误', file, message));
  const worldlines = list(catalog.worldlines);
  const worldlineIds = new Set(worldlines.map(worldline => worldline.id));
  let defaultWorldlineCount = 0;
  for (const worldline of worldlines) {
    const file = worldline.文件, value = worldline.内容;
    if (!isMap(value)) { add('开局.世界线格式', file, '世界线内容须为映射'); continue; }
    for (const key of Object.keys(value)) if (!WORLDLINE_FIELDS.includes(key)) add('开局.世界线格式', file, `含未知键“${key}”`);
    if (!isText(value.概述)) add('开局.世界线格式', file, '缺少概述或概述不是文本');
    if (has(value, '默认') && typeof value.默认 !== 'boolean') add('开局.世界线格式', file, '默认须为布尔');
    if (value.默认 === true) defaultWorldlineCount++;
    if (has(value, '角色组')) checkGroupChoices(value.角色组, file, '开局.世界线格式');
  }
  if (defaultWorldlineCount > 1) add('开局.世界线格式', '历史/世界线', '至多只能有一条世界线标记为默认');

  const optionIndex = new Map();
  if (catalog.openingOptions) {
    const file = catalog.openingOptions.文件, value = catalog.openingOptions.内容;
    if (!isMap(value)) add('开局.选项格式', file, '开局选项内容须为映射');
    else {
      for (const key of Object.keys(value)) if (!OPENING_OPTION_FIELDS.includes(key)) add('开局.选项格式', file, `含未知键“${key}”`);
      if (has(value, '自由组合') && typeof value.自由组合 !== 'boolean') add('开局.选项格式', file, '自由组合须为布尔');
      if (!Array.isArray(value.选项)) add('开局.选项格式', file, '选项须为列表');
      else for (const item of value.选项) {
        if (!isMap(item) || Object.keys(item).some(key => !['事件ID', '问题', '选项'].includes(key))
          || !isText(item.事件ID) || (has(item, '问题') && !isText(item.问题)) || !isMap(item.选项)) {
          add('开局.选项格式', file, '选项项须含事件ID与选项映射，问题若填写须为非空文本且不得含未知键');
          continue;
        }
        if (!events.has(item.事件ID) || optionIndex.has(item.事件ID)) add('开局.选项引用', file, `事件“${item.事件ID}”不存在或重复声明`);
        optionIndex.set(item.事件ID, item.选项);
        const event = events.get(item.事件ID);
        if (event?.内容?.确认策略 === '仅作候选') add('开局.选项引用', file, `仅作候选事件“${item.事件ID}”不能作为开局选项`);
        for (const [branchID, text] of Object.entries(item.选项)) {
          if (branchID !== '未发生' && !list(event?.内容?.分支).some(branch => branch?.分支ID === branchID)) add('开局.选项引用', file, `事件“${item.事件ID}”没有选项分支“${branchID}”`);
          if (!isText(text)) add('开局.选项引用', file, '选项文字须为文本');
        }
      }
    }
  }
  const calendar = decl.calendar ? createCalendar(decl.calendar) : null;
  for (const plan of catalog.openingPlans) {
    const file = plan.文件, value = plan.内容;
    if (!isMap(value)) { add('开局.方案格式', file, '方案内容须为映射'); continue; }
    for (const key of Object.keys(value)) if (!OPENING_PLAN_FIELDS.includes(key)) add('开局.方案格式', file, `含未知键“${key}”`);
    if (worldlineIds.size > 0) {
      if (!has(value, '世界线')) add('开局.方案格式', file, '多世界线世界书的开局方案必须指定世界线');
      else if (!isText(value.世界线) || !worldlineIds.has(value.世界线)) add('开局.世界线引用', file, `开局方案引用的世界线“${String(value.世界线)}”不存在`);
    } else if (has(value, '世界线')) {
      add('开局.世界线引用', file, '未声明世界线的世界书不能在开局方案中指定世界线');
    }
    if (!isText(value.概述)) add('开局.方案格式', file, '缺少概述或概述不是文本');
    if (has(value, '开局时间') && !calendar?.time(value.开局时间)) add('开局.方案格式', file, '开局时间须为合法纪年');
    if (has(value, '开局地点') && (!isText(value.开局地点) || !referenceExists(value.开局地点, '地点', catalog)))
      add('开局.方案格式', file, `开局地点“${String(value.开局地点)}”不在地点库中`);
    if (has(value, '角色组')) checkGroupChoices(value.角色组, file, '开局.方案格式');
    if (has(value, '历史选择')) {
      if (!isMap(value.历史选择)) add('开局.方案格式', file, '历史选择须为映射');
      else for (const [eventID, choice] of Object.entries(value.历史选择)) {
        if (!optionIndex.has(eventID) || !Object.hasOwn(optionIndex.get(eventID), choice)) add('开局.方案选择', file, `历史选择“${eventID}: ${choice}”未在开局选项中声明`);
        const event = events.get(eventID);
        if (value.开局时间 && event && calendar) {
          const latest = calendar.time(event.内容?.触发时间?.最晚);
          const start = calendar.time(value.开局时间);
          if (latest && start && latest[1] > start[0]) add('开局.方案选择', file, `所选事件“${eventID}”的触发时间最晚的终点晚于开局时间起点`);
        }
      }
    }
  }
  return issues;

  function checkGroupChoices(value, file, rule) {
    if (!isMap(value)) { add(rule, file, '角色组须为映射'); return; }
    const groups = new Map(catalog.groups.map(group => [group.id, group]));
    for (const [id, choice] of Object.entries(value)) {
      const group = groups.get(id);
      if (!group || !isMap(choice) || Object.keys(choice).some(key => !['启用', '版本ID'].includes(key))
        || (has(choice, '启用') && typeof choice.启用 !== 'boolean')
        || (has(choice, '版本ID') && !group.版本清单.includes(choice.版本ID))) add(rule, file, `角色组“${id}”的选择格式不正确`);
    }
  }
}
