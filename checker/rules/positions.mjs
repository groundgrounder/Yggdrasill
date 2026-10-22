import {DIALOGUE_FIELDS, POSITION_FIELDS} from '../../core/contract.mjs';
import {has, isMap, isText, list, issue, texts} from '../../core/utils.mjs';

export function checkPositions(catalog) {
  const issues = [];
  const groups = new Set(catalog.groups.map(group => group.id));
  for (const event of catalog.events) {
    const branches = new Set(list(event.内容?.分支).map(branch => branch?.分支ID));
    for (const position of event.角色位置) {
      const file = position.文件, value = position.内容;
      const add = (rule, message) => issues.push(issue(rule, '错误', file, message));
      if (!isMap(value)) { add('角色位置.形态', '角色位置内容须为映射'); continue; }
      for (const key of Object.keys(value)) if (!POSITION_FIELDS.includes(key)) add('角色位置.未知字段', `含未知字段“${key}”`);
      for (const key of ['事件ID', '角色组ID', '角色概要', '角色定位']) if (!has(value, key)) add('角色位置.缺必填', `缺少必填字段“${key}”`);
      const expectedGroup = file.split('/').at(-1).slice(0, -4), expectedEvent = file.split('/')[2];
      if (value.事件ID !== expectedEvent || value.角色组ID !== expectedGroup || !groups.has(value.角色组ID)) add('角色位置.ID不符', '事件ID、角色组ID必须与目录和文件名一致，且角色组已登记');
      if (has(value, '角色概要') && (!isText(value.角色概要) || /[\r\n]/.test(value.角色概要.trim())) || has(value, '角色定位') && !phraseTexts(value.角色定位)) add('角色位置.形态', '角色概要须为文本，角色定位须为短语列表');
      if (has(value, '介入条件') && !isText(value.介入条件)) add('角色位置.形态', '介入条件须为文本');
      for (const key of ['角色知情', '主观记忆']) if (has(value, key) && !textList(value[key])) add('角色位置.形态', `${key}须为非空文本列表`);
      let applicable = null;
      if (has(value, '适用分支')) {
        applicable = value.适用分支;
        if (!texts(applicable) || applicable.some(id => !branches.has(id))) add('角色位置.适用分支', '适用分支须为存在分支的非空无重复列表');
      }
      if (has(value, '按分支')) {
        if (!isMap(value.按分支)) add('角色位置.按分支', '按分支须为映射');
        else for (const [branchID, branchValue] of Object.entries(value.按分支)) {
          if (!branches.has(branchID) || (applicable ? !list(applicable).includes(branchID) : false)) add('角色位置.按分支', `按分支键“${branchID}”不在适用分支内`);
          if (!isMap(branchValue) || Object.keys(branchValue).some(key => !['角色知情', '主观记忆'].includes(key))) add('角色位置.按分支', `分支“${branchID}”只能含角色知情、主观记忆`);
          for (const key of ['角色知情', '主观记忆']) if (has(branchValue, key) && !textList(branchValue[key])) add('角色位置.形态', `按分支.${branchID}.${key}须为非空文本列表`);
        }
      }
      if (has(value, '事件触发语料')) checkDialogues(value.事件触发语料, file, add);
    }
  }
  return issues;
}

function checkDialogues(value, file, add) {
  if (!Array.isArray(value)) { add('角色位置.触发语料', '事件触发语料须为列表'); return; }
  for (const item of value) {
    if (!isMap(item)) { add('角色位置.触发语料', '事件触发语料项须为映射'); continue; }
    for (const key of Object.keys(item)) if (!DIALOGUE_FIELDS.includes(key)) add('角色位置.触发语料', `触发语料含未知子字段“${key}”`);
    for (const key of ['触发情境', '候选台词']) if (!has(item, key)) add('角色位置.触发语料', `触发语料缺少“${key}”`);
    if (has(item, '触发情境') && !isText(item.触发情境)) add('角色位置.触发语料', '触发情境须为文本');
    if (has(item, '候选台词') && !textList(item.候选台词)) add('角色位置.触发语料', '候选台词须为非空文本列表');
    for (const key of ['表达目的', '情绪或语气']) if (has(item, key) && !isText(item[key])) add('角色位置.触发语料', `${key}须为文本`);
    if (has(item, '触发限制') && !textList(item.触发限制)) add('角色位置.触发语料', '触发限制须为非空文本列表');
  }
}


function textList(value) {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(item => isText(item) && !/[\r\n]/.test(item));
}

function phraseTexts(value) {
  return textList(value) && value.every(item => !/[。．.!！?？;；]$/.test(item.trim()));
}
