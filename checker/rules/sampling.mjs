import {createCalendar} from '../../core/calendar.mjs';
import {conditionReferences} from '../../core/conditions.mjs';
import {createProtocol, ProtocolError, seal, resolveProfile} from '../../core/protocol.mjs';
import {has, list, issue} from '../../core/utils.mjs';

export function samplingYears(catalog, decl) {
  const calendar = createCalendar(decl.calendar), years = new Set();
  for (const event of catalog.events) for (const end of ['最早', '最晚']) {
    const year = calendar.year(event.内容.触发时间[end]);
    years.add(year);
    years.add(year + 1);
  }
  if (years.size) years.add(Math.max(0, Math.min(...years) - 1));
  return [...years].sort((left, right) => left - right);
}

function* combinations(events, index = 0, records = {}) {
  if (index === events.length) { yield structuredClone(records); return; }
  const event = events[index];
  yield* combinations(events, index + 1, records);
  Object.defineProperty(records, event.id, {value: {状态: 2}, enumerable: true, configurable: true, writable: true});
  yield* combinations(events, index + 1, records);
  for (const branch of event.内容.分支) {
    records[event.id] = {状态: 1, 分支: branch.分支ID, 实际时间: event.内容.触发时间.最晚,
      实际参与者: [...event.内容.核心参与者]};
    yield* combinations(events, index + 1, records);
  }
  delete records[event.id];
}

function combinationText(state) {
  return JSON.stringify(state.事件);
}

export function checkSampling(catalog, decl) {
  const protocol = createProtocol({catalog, decl}), calendar = createCalendar(decl.calendar);
  const years = samplingYears(catalog, decl), issues = [];
  const add = (rule, level, file, message) => issues.push(issue(rule, level, file, message));
  const events = new Map(catalog.events.map(event => [event.id, event]));
  const empty = seal(protocol, {开局时间: calendar.format(0)});
  for (const group of catalog.groups) for (const version of group.版本清单) {
    const profiles = list(group.内容.档案).filter(profile => !has(group.内容, '版本') || profile.适用版本.includes(version));
    const references = new Set(profiles.flatMap(profile => conditionReferences(profile.生效条件).map(reference => reference.事件ID)));
    const selectedEvents = [...references].map(id => events.get(id));
    const count = selectedEvents.reduce((total, event) => total * (event.内容.分支.length + 2), 1);
    if (count > 4096) {
      add('抽样.组合过多', '提示', group.文件, `角色组“${group.id}”版本“${version}”有 ${count} 种事件状态组合，超过 4096，跳过该版本`);
      continue;
    }
    for (const year of years) {
      let reported = false;
      for (const records of combinations(selectedEvents)) {
        const state = structuredClone(empty);
        state.世界.当前时间 = state.开局.开局时间 = calendar.format(year);
        state.开局.角色组[group.id] = {启用: true, 版本ID: version};
        state.事件 = records;
        const result = resolveProfile(protocol, state, group.id, {settle: false});
        if (result.结果 === '冲突' && !reported) {
          add('抽样.档案冲突', '错误', group.文件,
            `年份 ${year}，角色组“${group.id}”，版本“${version}”，事件状态组合 ${combinationText(state)}；档案冲突：${result.档案.join('、')}`);
          reported = true;
        }
      }
    }
  }
  const variants = [{name: '默认开局', groups: undefined}];
  const versionCount = Math.max(0, ...catalog.groups.map(group => group.版本清单.length));
  for (let index = 0; index < versionCount; index++) variants.push({name: `全部启用·版本${index + 1}`,
    groups: Object.fromEntries(catalog.groups.map(group => [group.id,
      {启用: true, 版本ID: group.版本清单[index] ?? group.内容.默认版本 ?? group.id}]))});
  for (const year of years) for (const variant of variants) {
    try {
      const state = seal(protocol, {开局时间: calendar.format(year), ...(variant.groups ? {角色组: variant.groups} : {})});
      for (const group of catalog.groups) {
        if (state.开局.角色组[group.id].启用 !== true) continue;
        const result = resolveProfile(protocol, state, group.id);
        if (result.结果 === '冲突') add('抽样.档案冲突', '错误', group.文件,
          `年份 ${year}，开局变体“${variant.name}”，角色组“${group.id}”，版本“${state.开局.角色组[group.id].版本ID}”，事件状态组合 ${combinationText(state)}；档案冲突：${result.档案.join('、')}`);
        else if (result.结果 === '异常') add('抽样.档案异常', '提示', group.文件,
          `年份 ${year}，开局变体“${variant.name}”，角色组“${group.id}”档案解析异常`);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      add('抽样.封卷失败', '错误', '历史', `年份 ${year}，开局变体“${variant.name}”：${error.code}：${error.message}`);
    }
  }
  for (const plan of catalog.openingPlans) {
    const selected = Object.keys(plan.内容.历史选择 ?? {}).map(id => events.get(id));
    const year = selected.length ? Math.max(...selected.map(event => calendar.year(event.内容.触发时间.最晚))) + 1 : years.at(-1);
    const time = plan.内容.开局时间 ?? calendar.format(year);
    try { seal(protocol, {方案: plan.id, 开局时间: time}); }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      add('开局.方案封卷失败', '错误', plan.文件, `方案“${plan.id}”，开局时间 ${time}：${error.code}：${error.message}`);
    }
  }
  for (const option of list(catalog.openingOptions?.内容?.选项)) {
    const event = events.get(option.事件ID), year = calendar.year(event.内容.触发时间.最晚) + 1;
    for (const branchID of Object.keys(option.选项)) {
      try { seal(protocol, {开局时间: calendar.format(year), 历史选择: {[event.id]: branchID}}); }
      catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        const unavailable = error.code === '封卷.历史选择';
        add(unavailable ? '开局.选项不可选' : '开局.选项封卷失败', unavailable ? '提示' : '错误', catalog.openingOptions.文件,
          `年份 ${year}，选项“${event.id}/${branchID}”：${error.code}：${error.message}`);
      }
    }
  }
  return issues;
}
