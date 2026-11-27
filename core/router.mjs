import {PROFILE_FIELDS} from './contract.mjs';
import {evaluateCondition} from './conditions.mjs';
import {createCalendar} from './calendar.mjs';
import {protocolText, containerText, worldOverview, trimNewlines} from './text.mjs';
import {normalizeSettings, readSettings} from './settings.mjs';
import {createProtocol, ProtocolError} from './protocol.mjs';
import {compileWorldbook} from './catalog.mjs';
import {stringifyYaml} from './yaml.mjs';
import {codepointCompare, freeze, has, isMap, list, pairs} from './utils.mjs';
import {fileURLToPath} from 'node:url';

export const DEFAULT_TAGS = freeze({协议: '协议', 世界概况: '世界概况', 世界状态: '世界状态', 在场角色: '在场角色',
  被提及角色: '被提及角色', 条目: '条目', 事件: '事件'});

const clone = value => structuredClone(value);
const chars = value => [...JSON.stringify(value)].length;
const nonempty = value => value !== undefined && value !== null && value !== ''
  && (!Array.isArray(value) || value.length > 0) && (!isMap(value) || Object.keys(value).length > 0);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => has(value, key) && nonempty(value[key]))
  .map(key => [key, clone(value[key])]));
const atCompare = (a, b) => a.消息序号 - b.消息序号 || a.字符位置 - b.字符位置;
const byID = (a, b) => codepointCompare(a.id, b.id);

function profileFields(value, fields) {
  return Object.fromEntries(pairs(fields).filter(([key]) => has(value, key) && value[key] != null).map(([key, schema]) => {
    const item = value[key];
    return [key, schema.子字段 ? profileFields(item, schema.子字段) : schema.映射
      ? Object.fromEntries(pairs(item).map(([name, child]) => [name, profileFields({值: child}, {值: schema.映射.值}).值]))
      : clone(item)];
  }));
}

function groupIdentity(group, state) {
  const version = list(group.内容?.版本).find(item => item.版本ID === state?.开局?.角色组?.[group.id]?.版本ID);
  const aliases = [...new Set([...list(group.内容?.别名), ...list(version?.别名)])];
  return {角色组ID: group.id, 显示名: version?.显示名 ?? group.内容?.显示名 ?? group.id, ...(aliases.length ? {别名: aliases} : {})};
}

export function createRouter({catalog, decl, protocol, settings = {}, templates}) {
  if (!isMap(catalog) || !isMap(decl) || typeof protocol?.createReadView !== 'function')
    throw new ProtocolError('协议.参数', '路由需要目录、声明与协议');
  const source = freeze(clone(catalog)), declaration = freeze(clone(decl));
  return Object.freeze({catalog: source, decl: declaration, protocol, settings: freeze(normalizeSettings(settings, declaration.libraries)),
    text: protocolText({catalog: source, decl: declaration, templates}), overview: containerText(source, '世界概况'),
    calendar: createCalendar(declaration.calendar), groups: [...source.groups].sort(byID),
    entries: new Map(pairs(source.entries).map(([name, entries]) => [name, new Map(entries.map(entry => [entry.id, entry]))])),
    events: new Map(source.events.map(event => [event.id, event])),
    descriptions: new Map(source.descriptions.map(record => [record.文件, record])),
    eventChains: new Map(source.chains.flatMap(chain => list(chain.内容?.事件).map(id => [id, chain.id]))),
  });
}

function findMentions(router, state, messages) {
  const first = terms => {
    for (let index = Math.max(0, messages.length - router.settings.提及窗口); index < messages.length; index++) {
      const positions = [...new Set(terms)].filter(term => typeof term === 'string' && term.length)
        .map(term => messages[index].indexOf(term)).filter(position => position >= 0);
      if (positions.length) return {消息序号: index + 1, 字符位置: [...messages[index].slice(0, Math.min(...positions))].length + 1};
    }
    return null;
  };
  const roles = router.groups.map(group => {
    const version = list(group.内容?.版本).find(item => item.版本ID === state?.开局?.角色组?.[group.id]?.版本ID);
    const position = first([group.内容?.显示名 ?? group.id, ...list(group.内容?.别名), version?.显示名, ...list(version?.别名)]);
    return position && {角色组ID: group.id, 首次出现: position};
  }).filter(Boolean).sort((a, b) => atCompare(a.首次出现, b.首次出现) || codepointCompare(a.角色组ID, b.角色组ID));
  const entries = [...router.entries].flatMap(([name, entries], order) => [...entries.values()].map(entry => {
    const position = first([entry.id, entry.内容?.名称 ?? entry.id]);
    return position && {库名: name, 条目ID: entry.id, 首次出现: position, order};
  })).filter(Boolean).sort((a, b) => atCompare(a.首次出现, b.首次出现) || a.order - b.order || codepointCompare(a.条目ID, b.条目ID))
    .map(({order, ...item}) => item);
  const events = [...router.events.values()].map(event => {
    const position = first([event.id, event.内容?.事件标题 ?? event.id]);
    return position && {事件ID: event.id, 首次出现: position};
  }).filter(Boolean);
  for (const [id, record] of pairs(state?.事件)) if (!router.events.has(id) && !id.startsWith('初次登场·') && record.状态 === 1) {
    const position = first([id]);
    if (position) events.push({事件ID: id, 首次出现: position});
  }
  events.sort((a, b) => atCompare(a.首次出现, b.首次出现) || codepointCompare(a.事件ID, b.事件ID));
  return {角色组: roles, 条目: entries, 事件: events, 未启用: []};
}

function locationChain(router, state, anomalies) {
  const id = state?.世界?.当前地点?.地标;
  if (!id) return [];
  const locations = router.entries.get('地点'), result = [], seen = new Set();
  let current = locations?.get(id);
  if (!current) anomalies.push({类型: '地点异常', 地点ID: id, 说明: '当前地点不在地点库中'});
  while (current && !seen.has(current.id)) {
    result.push(current.id); seen.add(current.id);
    current = locations.get(current.上级);
  }
  return result;
}

function presentCharacters(router, view, present, anomalies, mentions) {
  const state = view.state, entries = [], initialization = [];
  const customEquipMap = new Map(list(state?.开局?.玩家?.自定义装备).map(item => [item.名称, item.说明]));
  const playerCustomSkills = list(state?.开局?.玩家?.自定义技能);
  for (const id of present) {
    const group = id === '玩家' ? null : router.groups.find(item => item.id === id);
    const identity = id === '玩家' ? {角色组ID: id, 显示名: state.开局.玩家.档案.姓名 ?? id}
      : pick(groupIdentity(group, state), ['角色组ID', '显示名']);
    let profile;
    if (id === '玩家') profile = clone(state.开局.玩家.档案);
    else {
      const resolved = view.resolveProfile(id);
      const files = group.档案.find(item => item.id === resolved.档案ID);
      if (resolved.结果 !== '成立' || !isMap(files?.基本信息) || !isMap(files?.角色印象)) {
        entries.push({id, identity, form: '异常'});
        anomalies.push({类型: resolved.结果 === '冲突' ? '档案冲突' : '档案异常', 角色组ID: id,
          ...resolved, 说明: '当前档案不能用于上下文'});
        continue;
      }
      profile = Object.fromEntries(['基本信息', '角色印象'].map(kind => [kind,
        profileFields(files[kind], {...PROFILE_FIELDS[kind], ...router.decl.textRules?.档案追加字段?.[kind]})]));
      const supplements = profile.基本信息.能力特征?.技能补充;
      if (Array.isArray(supplements)) profile.基本信息.能力特征.技能补充 = supplements
        .filter(item => view.availableSkills(id).includes(item.技能ID))
        .map(item => pick(item, ['技能ID', '个体表现', '个体限制']));
      const preview = view.initializationPreview(id);
      if (group.内容?.初始化方式 !== '出场自动' && preview) initialization.push({角色组ID: id, ...preview});
    }
    const birth = id === '玩家' ? profile.出生年 : profile.基本信息.出生年;
    const currentYear = router.calendar.year(state?.世界?.当前时间), birthYear = router.calendar.year(birth);
    const run = pick(state?.角色?.[id], [...Object.keys(router.decl.variables.角色), '装备']);
    const heldCustom = Object.keys(state?.角色?.[id]?.装备 ?? {}).filter(key => customEquipMap.has(key))
      .map(名称 => ({名称, 说明: customEquipMap.get(名称)}));
    const isPlayerControlled = (state?.开局?.玩家?.模式 === '自建' && id === '玩家')
      || (state?.开局?.玩家?.模式 === '扮演' && id === state?.开局?.玩家?.扮演角色组);
    const full = {...identity, ...(currentYear !== null && birthYear !== null ? {年龄: currentYear - birthYear} : {}),
      ...(state.开局.玩家.模式 === '扮演' && state.开局.玩家.扮演角色组 === id ? {玩家扮演: true} : {}),
      档案: profile, 当前能力: view.currentAbility(id), 可用技能: view.availableSkills(id),
      ...(isPlayerControlled && playerCustomSkills.length ? {自定义技能: clone(playerCustomSkills)} : {}),
      ...(nonempty(run) ? {本局状态: run} : {}),
      ...(heldCustom.length ? {自定义装备: heldCustom} : {})};
    entries.push({id, full});
  }

  // 分级压缩：按「玩家 > 最近提及 > 码点」逐人分配完整、精简或最小，最终仍按在场规范顺序输出。
  const budget = router.settings.在场角色, playerID = present.includes('玩家') ? '玩家'
    : state.开局.玩家.模式 === '扮演' && present.includes(state.开局.玩家.扮演角色组) ? state.开局.玩家.扮演角色组 : null;
  const mentioned = list(mentions?.角色组).map(item => item.角色组ID).filter(id => present.includes(id) && id !== playerID);
  const priority = [...new Set([playerID, ...mentioned, ...[...present].sort(codepointCompare)].filter(id => id !== null && present.includes(id)))];
  const byID = new Map(entries.map(entry => [entry.id, entry])), chosen = new Map();
  let complete = 0, used = 0;
  for (const id of priority) {
    const entry = byID.get(id);
    if (entry.form === '异常') {
      const size = chars(entry.identity);
      chosen.set(id, {form: '异常', item: entry.identity, size}); used += size;
      continue;
    }
    const full = entry.full, simple = compactCharacter(entry), minimal = minimalCharacter(entry);
    let form, item;
    if (complete < budget.完整人数 && used + chars(full) <= budget.字符) { form = '完整'; item = full; complete += 1; }
    else if (used + chars(simple) <= budget.字符) { form = '精简'; item = simple; }
    else { form = '最小'; item = minimal; }
    const size = chars(item);
    chosen.set(id, {form, item, size}); used += size;
  }
  const characters = [], selected = [];
  for (const id of present) {
    const choice = chosen.get(id);
    characters.push(choice.item);
    selected.push({角色组ID: id, 形式: choice.form, 字符: choice.size});
  }
  return {characters, initialization, present: {选入: selected, 字符: used}};
}

function compactCharacter({id, full}) {
  const profile = id === '玩家' ? pick(full.档案, ['姓名', '称号', '性别', '种族'])
    : {基本信息: pick(full.档案?.基本信息, ['姓名', '称号', '性别', '种族']),
      角色印象: pick(full.档案?.角色印象, ['核心身份', '表现禁区'])};
  const compact = id === '玩家' ? profile
    : {...(nonempty(profile.基本信息) ? {基本信息: profile.基本信息} : {}),
      ...(nonempty(profile.角色印象) ? {角色印象: profile.角色印象} : {})};
  return {角色组ID: full.角色组ID, 显示名: full.显示名, ...(has(full, '年龄') ? {年龄: full.年龄} : {}),
    ...(has(full, '玩家扮演') ? {玩家扮演: full.玩家扮演} : {}),
    ...(id === '玩家' && !nonempty(compact) ? {} : {档案: compact}),
    当前能力: full.当前能力, 可用技能: full.可用技能,
    ...(has(full, '自定义技能') ? {自定义技能: full.自定义技能} : {}),
    ...(has(full, '本局状态') ? {本局状态: full.本局状态} : {}),
    ...(has(full, '自定义装备') ? {自定义装备: full.自定义装备} : {})};
}

function minimalCharacter({full}) {
  return {角色组ID: full.角色组ID, 显示名: full.显示名, ...(has(full, '年龄') ? {年龄: full.年龄} : {}),
    ...(has(full, '玩家扮演') ? {玩家扮演: full.玩家扮演} : {}), ...(has(full, '本局状态') ? {本局状态: full.本局状态} : {})};
}

function worldState(router, view) {
  const world = pick(view.state?.世界, ['当前时间', '当前地点', '剧情标记', ...Object.keys(router.decl.variables.世界)]);
  const ongoing = [...router.catalog.chains].sort(byID).filter(chain => view.chainStatus(chain.id) === '进行中').map(chain => {
    const confirmed = list(chain.内容?.事件).filter(id => view.state?.事件?.[id]?.状态 === 1)
      .sort((a, b) => router.calendar.time(view.state.事件[a].实际时间)[0] - router.calendar.time(view.state.事件[b].实际时间)[0]
        || codepointCompare(a, b)).map(id => {
        const event = router.events.get(id), record = view.state.事件[id];
        if (!event || !record) return null;
        const branch = list(event.内容?.分支).find(item => item.分支ID === record.分支);
        return `${event.内容?.事件标题 ?? id}：${branch?.分支结果}`;
      }).filter(item => item !== null);
    return {事件串ID: chain.id, ...pick(chain.内容, ['概述']), ...(confirmed.length ? {已确认: confirmed} : {})};
  });
  if (ongoing.length) world.进行中事件串 = ongoing;
  if (view.state?.待定项?.length) world.待定项 = clone(view.state.待定项);
  return world;
}

function entryContext(router, view, present, places, mentions, audit) {
  const requests = [], seen = new Set();
  function request(name, id, reason) {
    if (!router.entries.has(name)) return;
    const key = JSON.stringify([name, id]);
    if (seen.has(key)) return;
    seen.add(key); requests.push({库名: name, 条目ID: id, 理由: reason});
  }
  function references(value, schema) {
    if (value === undefined) return;
    if (schema?.引用) for (const id of schema.列表 ? list(value) : [value]) request(schema.引用, id, '本局状态');
    else if (schema?.集合) for (const item of list(value)) references(item, schema.集合);
    else if (schema?.子字段) for (const [key, child] of pairs(schema.子字段)) references(value?.[key], child);
    else if (schema?.映射) for (const [key, item] of pairs(value)) {
      references(key, schema.映射.键); references(item, schema.映射.值);
    }
  }
  const customEquipNames = new Set(list(view.state?.开局?.玩家?.自定义装备).map(item => item.名称));
  for (const id of present) {
    const run = view.state?.角色?.[id];
    for (const [name, schema] of pairs(router.decl.variables.角色)) references(run?.[name], schema);
    for (const [name, dimension] of pairs(router.decl.ability.维度)) if (dimension.类型 === '集合' && dimension.成员?.条目库)
      for (const value of list(run?.[name])) request(dimension.成员.条目库, value, '本局状态');
    for (const key of Object.keys(run?.装备 ?? {})) if (!customEquipNames.has(key)) request('装备', key, '本局状态');
  }
  for (const id of places) request('地点', id, '地点链');
  for (const item of mentions.条目) request(item.库名, item.条目ID, '提及');
  const available = new Set(present.flatMap(id => view.availableSkills(id)));
  const output = {};
  for (const [name, library] of pairs(router.decl.libraries)) {
    const budget = router.settings.条目字符[name] ?? router.settings.条目字符.默认;
    const log = {选入: [], 略过: [], 字符: 0, 预算: budget}, items = [], descriptions = new Set();
    for (const request of requests.filter(item => item.库名 === name)) {
      const {条目ID: id, 理由: reason} = request, entry = router.entries.get(name).get(id);
      if (!entry) { log.略过.push({条目ID: id, 原因: '条目不存在'}); continue; }
      if (name === '技能' && !available.has(id)) { log.略过.push({条目ID: id, 原因: '不可用'}); continue; }
      if (!nonempty(entry.内容)) { log.略过.push({条目ID: id, 原因: '正文为空'}); continue; }
      const directories = library.分法 === '按种类' ? [name, ...entry.层级目录] : [name];
      const added = [];
      for (let index = 0; index < directories.length; index++) {
        const directory = directories.slice(0, index + 1).join('/'), file = `${directory}/${directories[index]}.txt`;
        if (descriptions.has(file)) continue;
        const record = router.descriptions.get(file);
        if (record && nonempty(record.内容)) added.push({file, item: {说明: directories[index], 内容: clone(record.内容)}});
      }
      const item = clone(entry.内容), size = chars(item) + added.reduce((sum, row) => sum + chars(row.item), 0);
      if (log.字符 + size > budget) { log.略过.push({条目ID: id, 原因: '超出字符'}); continue; }
      for (const row of added) { descriptions.add(row.file); items.push(row.item); }
      items.push(item); log.字符 += size;
      log.选入.push({条目ID: id, 理由: reason, 字符: size});
    }
    audit[name] = log;
    if (items.length) output[name] = items;
  }
  return output;
}

function eventPositions(event, present, branches, confirmed) {
  return present.flatMap(id => {
    const position = list(event.角色位置).find(item => item.角色组ID === id)?.内容;
    if (!position || (Array.isArray(position.适用分支) && !branches.some(branch => position.适用分支.includes(branch)))) return [];
    const item = {角色组ID: id, ...pick(position, confirmed ? ['角色概要', '角色定位', '角色知情', '主观记忆']
      : ['角色定位', '介入条件', '事件触发语料'])};
    if (confirmed) for (const key of ['角色知情', '主观记忆']) {
      const extra = position.按分支?.[branches[0]]?.[key];
      if (extra?.length) item[key] = [...list(item[key]), ...clone(extra)];
    }
    if (item.事件触发语料) item.事件触发语料 = item.事件触发语料.map(row => pick(row,
      ['触发情境', '候选台词', '表达目的', '情绪或语气', '触发限制']));
    return [item];
  });
}

function historyItem(router, view, id, present) {
  const event = router.events.get(id), record = view.state.事件[id];
  if (!event) return {事件ID: id, 摘要: record.摘要, 实际时间: record.实际时间};
  const branch = list(event.内容?.分支).find(item => item.分支ID === record.分支);
  const positions = eventPositions(event, present, [record.分支], true);
  // 所走分支声明了专属文本时覆盖事件顶层，未声明才回退；不拼接，避免原作主线文本混入 IF 分支。
  const text = key => {
    const value = nonempty(branch?.[key]) ? branch[key] : event.内容?.[key];
    return nonempty(value) ? {[key]: clone(value)} : {};
  };
  return {事件ID: id, 事件标题: event.内容?.事件标题 ?? id, ...text('事件概要'), ...text('影响范围'), 实际时间: record.实际时间,
    ...pick(branch, ['分支结果']), ...text('公开信息'), ...text('隐秘信息'), ...(positions.length ? {角色位置: positions} : {})};
}

function fitEvents(rows, budget, compact, log) {
  const output = [];
  for (const row of rows) {
    if (output.length >= budget.条数) { log.略过.push({事件ID: row.id, 原因: '超出条数'}); continue; }
    let item = row.item, form = '完整', size = chars(item);
    if (log.字符 + size > budget.字符 && compact && has(item, '角色位置')) {
      const {角色位置, ...summary} = item;
      item = summary; form = '摘要'; size = chars(item);
    }
    if (log.字符 + size > budget.字符) { log.略过.push({事件ID: row.id, 原因: '超出字符'}); continue; }
    output.push(item); log.字符 += size;
    log.选入.push({事件ID: row.id, 理由: row.reason, 形式: form, 字符: size});
  }
  return output;
}

// 只沿成立路径收集正极性的事件叶子，不能从失败的 any 路径捡取局部命中。
function supportingHistory(gate, view, negative = false) {
  if (!gate || evaluateCondition(gate, view.leaf, negative) !== true) return [];
  const [[type, value]] = Object.entries(gate);
  if (type === '事件确认') return !negative ? [value.事件ID] : [];
  if (!['all', 'any', 'none'].includes(type)) return [];
  return value.flatMap(child => supportingHistory(child, view, type === 'none' ? !negative : negative));
}

function eventContext(router, view, present, places, mentions, initialization, audit) {
  const here = new Set(present), pendingIDs = new Set(view.pending.map(item => item.事件ID));
  const shared = ids => new Set(list(ids).filter(id => here.has(id))).size;
  const local = event => list(event?.内容?.地点).some(id => places.includes(id));
  const ongoing = new Set(router.catalog.chains.filter(chain => view.chainStatus(chain.id) === '进行中').map(chain => chain.id));
  const candidates = [];
  for (const event of router.events.values()) {
    try {
      const status = view.eventStatus(event.id);
      if (status.状态 !== '候选') continue;
      const content = event.内容, participants = list(content?.核心参与者);
      const count = shared(participants), nearby = local(event);
      if (!count && !nearby && participants.length) { audit.候选.略过.push({事件ID: event.id, 原因: '无关联'}); continue; }
      const positions = eventPositions(event, present, status.分支, false);
      candidates.push({id: event.id, count, nearby, ongoing: ongoing.has(router.eventChains.get(event.id)),
        latest: router.calendar.time(content.触发时间.最晚)[0], reason: count ? '核心参与者在场' : nearby ? '当前地点' : '无核心参与者',
        item: {事件ID: event.id, 事件标题: content?.事件标题 ?? event.id, ...pick(content, ['事件概要', '影响范围', '叙事条件', '公开信息']),
          触发时间最晚: content.触发时间.最晚,
          分支: list(content?.分支).filter(branch => status.分支.includes(branch.分支ID)).map(branch => pick(branch, ['分支ID', '分支条件', '分支结果'])),
          ...(positions.length ? {角色位置: positions} : {})}});
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      audit.异常.push({类型: '事件异常', 事件ID: event.id, 说明: error.message});
    }
  }
  candidates.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || Number(b.nearby) - Number(a.nearby)
    || b.count - a.count || a.latest - b.latest || byID(a, b));
  const selected = fitEvents(candidates, router.settings.候选, false, audit.候选);
  const supports = new Set(selected.flatMap(item => {
    const event = router.events.get(item.事件ID);
    return [event.内容.门槛, ...event.内容.分支.filter(branch => item.分支.some(value => value.分支ID === branch.分支ID)).map(branch => branch.门槛)]
      .flatMap(gate => supportingHistory(gate, view));
  }));
  const requested = new Map(mentions.事件.map(item => [item.事件ID, item.首次出现]));
  const histories = [];
  for (const [id, record] of pairs(view.state?.事件)) {
    if (record.状态 !== 1 || pendingIDs.has(id) || id.startsWith('初次登场·')) continue;
    const event = router.events.get(id), count = shared(record.实际参与者);
    const reasons = [requested.has(id) && '点名', supports.has(id) && '候选前置', local(event) && '当前地点',
      count >= 2 && '共同经历', count >= 1 && '在场者经历'];
    const priority = reasons.findIndex(Boolean);
    if (priority < 0) { audit.经历.略过.push({事件ID: id, 原因: '无关联'}); continue; }
    histories.push({id, count, priority, reason: reasons[priority], at: router.calendar.time(record.实际时间)[0],
      item: historyItem(router, view, id, present)});
  }
  histories.sort((a, b) => a.priority - b.priority || (a.priority === 0 ? atCompare(requested.get(a.id), requested.get(b.id)) : 0)
    || b.count - a.count || b.at - a.at || byID(a, b));
  const history = fitEvents(histories, router.settings.经历, true, audit.经历).sort((a, b) =>
    router.calendar.time(a.实际时间)[0] - router.calendar.time(b.实际时间)[0] || codepointCompare(a.事件ID, b.事件ID));
  const pending = view.pending.map(item => ({...historyItem(router, view, item.事件ID, present), 已经发生: true}));
  return {...(history.length ? {已确认经历: history} : {}), ...(pending.length ? {待登记: pending} : {}),
    ...(selected.length ? {候选: selected} : {}), ...(initialization.length ? {待初始化: initialization} : {})};
}

export function route(router, state, messages) {
  if (!Array.isArray(messages) || messages.some(value => typeof value !== 'string')) throw new ProtocolError('协议.参数', '消息须为从旧到新的文本列表');
  const view = router.protocol.createReadView(state), mentions = findMentions(router, view.state, messages);
  const audit = {经历: {选入: [], 略过: [], 字符: 0, 预算: clone(router.settings.经历)},
    候选: {选入: [], 略过: [], 字符: 0, 预算: clone(router.settings.候选)}, 条目: {}, 提及: mentions, 异常: []};
  const present = view.presentIDs().sort((a, b) => a === '玩家' ? 1 : b === '玩家' ? -1 : codepointCompare(a, b));
  const places = locationChain(router, view.state, audit.异常);
  const {characters, initialization, present: presentAudit} = presentCharacters(router, view, present, audit.异常, mentions);
  audit.在场角色 = {...presentAudit, 预算: clone(router.settings.在场角色)};
  mentions.未启用 = mentions.角色组.filter(item => !view.enabled(item.角色组ID)).map(clone);
  const mentioned = mentions.角色组.filter(item => view.enabled(item.角色组ID) && !present.includes(item.角色组ID))
    .map(item => groupIdentity(router.groups.find(group => group.id === item.角色组ID), view.state));
  const world = worldState(router, view), entries = entryContext(router, view, present, places, mentions, audit.条目);
  const events = eventContext(router, view, present, places, mentions, initialization, audit);
  const overview = worldOverview(router.catalog, view.state?.开局?.世界线 ?? null);
  const context = {协议: router.text, ...(overview ? {世界概况: overview} : {}),
    ...(nonempty(world) ? {世界状态: world} : {}), ...(characters.length ? {在场角色: characters} : {}),
    ...(mentioned.length ? {被提及角色: mentioned} : {}), ...(nonempty(entries) ? {条目: entries} : {}), ...(nonempty(events) ? {事件: events} : {})};
  return {context, audit};
}

export function renderContext(context, tags = DEFAULT_TAGS) {
  return Object.keys(DEFAULT_TAGS).filter(key => has(context, key)).map(key => {
    const tag = tags[key] ?? DEFAULT_TAGS[key], value = ['协议', '世界概况'].includes(key) ? context[key] : trimNewlines(stringifyYaml(context[key]));
    return `<${tag}>\n${value}\n</${tag}>`;
  }).join('\n\n');
}

export async function loadRouter(root, {fs, path}) {
  const {catalog, decl, issues} = await compileWorldbook(root, {fs, path});
  const errors = issues.filter(item => item.级别 === '错误');
  if (errors.length) throw new ProtocolError('协议.参数', errors.map(item => `${item.文件}：${item.说明}`).join('；'));
  const settings = await readSettings(path.dirname(path.resolve(root)), {fs, path, decl});
  const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  const templates = Object.fromEntries(await Promise.all(['变量更新规则', '角色通用约束', '扮演准则'].map(async name =>
    [name, await fs.readFile(path.join(templateRoot, `${name}.txt`), 'utf8')])));
  const protocol = createProtocol({catalog, decl});
  return {protocol, router: createRouter({catalog, decl, protocol, settings, templates})};
}
