// 记账：叙事模型只写正文，每轮之后另调一次模型，按程序给出的 JSON schema 填这一轮的变化，由程序转成命令交协议执行。
// 本文件不依赖酒馆的全局，可在 node 中测试。记账一方能看到未到的事件，它不写正文，不会剧透。
import {applyCommands} from '../core/commands.mjs';
import {eventStatus} from '../core/protocol.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {formatCalendar, writableFields, locationList} from '../core/text.mjs';
import {stringifyYaml} from '../core/yaml.mjs';
import {codepointCompare, isMap} from '../core/utils.mjs';

const UPCOMING = 15;
// 事件与分支是引用而不是封闭枚举：由转换层按所属事件核对，才能把“未知引用”与“JSON 形状/枚举错误”分开。
const REFERENCE_PATHS = new Set(['时间.事件ID', '发生的事件[].事件ID', '发生的事件[].分支ID']);
const joinPath = (path, key) => path ? `${path}.${key}` : key;

// 按 bookkeeper.schema() 实际使用的 JSON Schema 子集校验：type/required/additionalProperties/enum/items。
// 引用字段的 enum 只用于提示模型，不在这里拒绝；它们由 toCommands 归属核对后成为 记账.结果。
function validateNode(value, node, path, template, issues) {
  const label = path || '根';
  if (node.type === 'object') {
    if (!isMap(value)) { issues.push(`须为映射：${label}`); return; }
    for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) issues.push(`缺少必填字段：${joinPath(path, key)}`);
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(node.properties ?? {}, key)) issues.push(`表外字段：${joinPath(path, key)}`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) if (Object.hasOwn(value, key))
      validateNode(value[key], child, joinPath(path, key), joinPath(template, key), issues);
    return;
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) { issues.push(`须为列表：${label}`); return; }
    value.forEach((item, index) => validateNode(item, node.items, `${path}[${index}]`, `${template}[]`, issues));
    return;
  }
  if (node.type === 'string' && typeof value !== 'string') { issues.push(`须为文本：${label}`); return; }
  if (node.enum && !REFERENCE_PATHS.has(template) && !node.enum.includes(value))
    issues.push(`不在允许值内：${label}=${JSON.stringify(value)}`);
}

function validateSchema(value, schema) {
  const issues = [];
  validateNode(value, schema, '', '', issues);
  return issues;
}

const jsonFailure = message => Object.assign(new Error(message), {code: '记账.JSON'});

const RULES = `你是本局的记账员，不是叙述者。读最新的一段正文，把其中确实发生的变化填成 JSON。只记正文写明的，不推测，不补写。

- 时间：没有过去时间，方式填“不变”。正文写出了具体日期，或能算出日期，填“写日期”。正文停在某个将到事件开始的那一刻，填“到事件开始”并填事件ID。正文已经越过某个将到事件、写到了它之后，填“越过事件”并填事件ID；跨过好几个事件时，填正文确实写到其后的最远一个。拿不准时宁早勿晚。
- 地点：地标从地点列表中选，场景是一个短语；没有换场，地标留空。
- 在场：正文结束时在场的全部角色组，扮演角色组不填。
- 发生的事件：只填候选、待登记与将到的事件中，正文写明确实发生了的，并选所走的分支。待登记事件只能填协议给出的分支；只被提到、计划要做、还没发生的不填。
- 新情况：只记候选与将到的事件之外、会留下长期结果的事：受伤、得失物品、关系转变、得知会影响以后行为的事实。将到的事件已经安排的成长与结果不要另记。路径与操作只用可写字段中的；ID 只用已有的，世界书里没有的东西不记。装备的值写作“状态/位置”，例如“完好/随身”。
- 没有的项填空列表或空字符串。`;

export function createBookkeeper({protocol, catalog, decl}) {
  const calendar = createCalendar(decl.calendar);
  // 日期文本直接取内核日历；越界（年位数不够）返回 null，交给调用方跳过。
  const dayText = day => calendar.formatDay(day);
  const events = new Map(catalog.events.map(event => [event.id, event]));
  const groups = new Map(catalog.groups.map(group => [group.id, group]));
  const windowOf = id => {
    const time = events.get(id)?.内容?.触发时间, start = calendar.time(time?.最早), end = calendar.time(time?.最晚);
    return start && end ? {start: start[0], end: end[1]} : null;
  };
  const now = state => calendar.time(state.世界.当前时间)?.[0] ?? 0;
  const roleplayOf = state => state.开局?.玩家?.模式 === '扮演' ? state.开局.玩家.扮演角色组 : null;
  const enabled = state => [...groups.keys()].filter(id => state.开局?.角色组?.[id]?.启用 === true);
  const statusOf = (state, id) => { try { return eventStatus(protocol, state, id); } catch { return {状态: '异常'}; } };

  // 候选全收；未到与不适用按最早的起点取最近的若干个。
  function upcoming(state) {
    const items = catalog.events.map(event => ({event, status: statusOf(state, event.id)}));
    const candidates = items.filter(item => item.status.状态 === '候选');
    const later = items.filter(item => ['未到', '不适用'].includes(item.status.状态) && windowOf(item.event.id))
      .sort((a, b) => windowOf(a.event.id).start - windowOf(b.event.id).start || codepointCompare(a.event.id, b.event.id)).slice(0, UPCOMING);
    return {candidates, later};
  }

  const itemOf = ({event, status}) => {
    const content = event.内容, branches = status.分支 ?? content.分支.map(branch => branch.分支ID);
    return {事件ID: event.id, ...(content.事件标题 && content.事件标题 !== event.id ? {标题: content.事件标题} : {}), 概要: content.事件概要,
      触发时间: `${content.触发时间.最早} — ${content.触发时间.最晚}`,
      分支: content.分支.filter(branch => branches.includes(branch.分支ID)).map(branch => ({分支ID: branch.分支ID, 分支条件: branch.分支条件}))};
  };

  // 待登记事件只带协议已选定的分支；标题与概要取所属事件，供记账员在正文中认出它。
  const pendingItemOf = item => {
    const content = events.get(item.事件ID)?.内容 ?? {};
    const branch = (content.分支 ?? []).find(entry => entry.分支ID === item.分支ID);
    return {事件ID: item.事件ID, ...(content.事件标题 && content.事件标题 !== item.事件ID ? {标题: content.事件标题} : {}), 概要: content.事件概要,
      分支: {分支ID: item.分支ID, ...(branch?.分支条件 ? {分支条件: branch.分支条件} : {})}};
  };

  function schema(state, {candidates, later}) {
    // 协议已认定的“待登记”事件不进入 upcoming 的候选/将到视图，但正文写到它们时可以确认；只并入 Schema 的可确认引用。
    const pending = protocol.pendingEvents(state);
    const ids = [...new Set([...pending.map(item => item.事件ID), ...candidates.map(item => item.event.id), ...later.map(item => item.event.id)])];
    const branches = [...new Set([...pending.map(item => item.分支ID),
      ...[...candidates, ...later].flatMap(item => itemOf(item).分支.map(branch => branch.分支ID))])].filter(Boolean);
    const roleplay = roleplayOf(state), present = enabled(state).filter(id => id !== roleplay);
    const places = catalog.entries?.地点?.map(entry => entry.id) ?? [];
    const text = {type: 'string'}, list = items => ({type: 'array', items});
    const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
    return object({
      时间: object({方式: {type: 'string', enum: ['不变', '写日期', '到事件开始', '越过事件']}, 日期: text, 事件ID: {type: 'string', enum: ['', ...ids]}}),
      地点: object({地标: {type: 'string', enum: ['', ...places]}, 场景: text}),
      在场: list({type: 'string', enum: present.length ? present : ['']}),
      发生的事件: list(object({事件ID: {type: 'string', enum: ids.length ? ids : ['']}, 分支ID: {type: 'string', enum: branches.length ? branches : ['']}})),
      新情况: list(object({事件ID: text, 摘要: text, 变化: list(object({路径: text, 操作: {type: 'string', enum: ['设定', '新增', '移除', '提升', '增加', '减少']}, 值: text}))})),
    });
  }

  // 返回 generateRaw 的 ordered_prompts 与 json_schema。
  function request(state, {input = '', narration, hint = ''}) {
    const scope = upcoming(state), roleplay = roleplayOf(state), pending = protocol.pendingEvents(state);
    const facts = {
      当前时间: state.世界.当前时间, 当前地点: state.世界.当前地点 ?? '未写',
      在场: enabled(state).filter(id => id !== roleplay && state.角色?.[id]?.在场 === true), 扮演角色组: roleplay ?? '无（自建玩家）',
      纪年: formatCalendar(decl.calendar), 候选事件: scope.candidates.map(itemOf), 待登记事件: pending.map(pendingItemOf),
      将到的事件: scope.later.map(itemOf),
    };
    const system = `${RULES}\n\n## 本局\n${stringifyYaml(facts)}\n## 地点列表\n${locationList(catalog)}\n\n## 可写字段\n${writableFields(decl)}`;
    const user = `## 玩家的输入\n${input || '（无）'}\n\n## 要记账的正文\n${narration}${hint ? `\n\n## 上一次填写的问题，请改正\n${hint}` : ''}`;
    return {prompts: [{role: 'system', content: system}, {role: 'user', content: user}], schema: {name: '世界树记账', value: schema(state, scope), strict: true}};
  }

  // 变化路径落点的字段声明：只沿映射值与子字段下钻；集合成员、词表、引用、剧情标记与能力维度都视为文本。
  function schemaOf(path) {
    const parts = String(path ?? '').split('.');
    if (parts[0] === '世界' && parts[1] !== '剧情标记') return descend(decl.variables?.世界?.[parts[1]], parts.slice(2));
    if (parts[0] === '角色' && parts.length >= 3 && parts[2] !== '装备' && !decl.ability?.维度?.[parts[2]])
      return descend(decl.variables?.角色?.[parts[2]], parts.slice(3));
    return null;
  }
  function descend(schema, parts) {
    let current = schema;
    for (const key of parts) {
      if (current?.映射) current = current.映射.值;
      else if (current?.子字段?.[key]) current = current.子字段[key];
      else return null;
    }
    return current?.集合 ? current.集合 : current ?? null;
  }
  // 装备值只认恰好两段的“状态/位置”；不含斜杠或段数不对时保持原文，交协议拒绝并保留说明。
  const equipmentPath = path => {
    const parts = String(path ?? '').split('.');
    return parts.length === 4 && parts[0] === '角色' && parts[2] === '装备';
  };

  // 记账结果 → 命令。发生的事件按窗口的起点排序，同起点按事件ID码点；起点晚于当前时间的先把时间写到起点再确认。
  // 终点时间、地点与在场分别生成写场景，任一项被协议拒绝不拖垮其它合法变化。
  function toCommands(state, result) {
    const commands = [], errors = [], roleplay = roleplayOf(state);
    let cursor = now(state);
    const advance = day => {
      if (day <= cursor) return;
      const text = dayText(day);
      if (text === null) return;
      commands.push({写场景: {当前时间: text}});
      cursor = day;
    };
    // 在场差异先算：同回合新角色的确认初始化必须先于事件推进，按事件前状态选择档案。
    const listed = new Set((result?.在场 ?? []).filter(id => groups.has(id) && id !== roleplay));
    const presence = {}, leaving = [];
    for (const id of enabled(state).filter(id => id !== roleplay)) {
      const was = state.角色?.[id]?.在场 === true;
      if (listed.has(id) !== was) {
        presence[id] = listed.has(id);
        if (was && !listed.has(id)) leaving.push(id);
      }
    }
    // 显式确认的角色组在出场前由程序确认初始化。
    for (const id of [...Object.keys(presence).filter(id => presence[id]), ...(roleplay ? [roleplay] : [])])
      if (state.角色?.[id]?.已初始化 !== true && (groups.get(id)?.内容?.初始化方式 ?? '显式确认') === '显式确认')
        commands.push({确认初始化: {角色组ID: id}});
    const occurrences = [];
    for (const item of result?.发生的事件 ?? []) {
      const event = events.get(item?.事件ID);
      if (!event) { errors.push(`发生的事件中没有这个事件：${item?.事件ID}`); continue; }
      if (!(event.内容?.分支 ?? []).some(branch => branch.分支ID === item?.分支ID)) {
        errors.push(`事件的分支不属于该事件：${item?.事件ID}/${item?.分支ID}`);
        continue;
      }
      occurrences.push(item);
    }
    occurrences.sort((a, b) => windowOf(a.事件ID).start - windowOf(b.事件ID).start || codepointCompare(a.事件ID, b.事件ID));
    for (const item of occurrences) {
      advance(windowOf(item.事件ID).start);
      commands.push({确认事件: {事件ID: item.事件ID, 分支ID: item.分支ID}});
    }
    let target = null, targetText = '';
    const time = result?.时间 ?? {};
    if (time.方式 === '写日期') {
      target = calendar.time(time.日期)?.[0] ?? null; targetText = time.日期;
      if (target === null) errors.push(`日期不合法：${time.日期}`);
    } else if (['到事件开始', '越过事件'].includes(time.方式)) {
      const window = windowOf(time.事件ID);
      targetText = `${time.方式}：${time.事件ID}`;
      if (!window) errors.push(`时间所引的事件不存在：${time.事件ID}`);
      else target = time.方式 === '到事件开始' ? window.start : window.end;
    }
    const previousLocation = state.世界.当前地点?.地标;
    if (target !== null && target > cursor) {
      const text = dayText(target);
      if (text !== null) commands.push({写场景: {当前时间: text}});
    } else if (target !== null && target < cursor) errors.push(`时间早于当前：${targetText}（本局当前 ${dayText(cursor) ?? state.世界.当前时间}）`);
    // 场景取模型给的短语；模型留空时，只有地标没变才继承旧场景，否则用新地标，避免把旧地标的场景带到新地标。
    if (result?.地点?.地标) {
      const landmark = result.地点.地标, previous = state.世界.当前地点;
      const scene = result.地点.场景 || (landmark === previous?.地标 ? previous?.场景 : '') || landmark;
      commands.push({写场景: {当前地点: {地标: landmark, 场景: scene}}});
    }
    // 换场先于离场写入；离场者的所在取换场前的地标，显式带上，避免被新地点覆盖。
    if (Object.keys(presence).length) {
      const scene = {在场: presence};
      if (previousLocation) scene.所在 = Object.fromEntries(leaving.map(id => [id, previousLocation]));
      commands.push({写场景: scene});
    }
    // 变化值按声明转类型：只有落点是数值字段时才把整数文本转成数字；其余（文本、词表、引用、剧情标记、等级）保持字符串。
    const value = (path, text) => {
      if (equipmentPath(path)) {
        const parts = typeof text === 'string' ? text.split('/') : [];
        return parts.length === 2 && parts.every(part => part.trim()) ? {状态: parts[0], 位置: parts[1]} : text;
      }
      const schema = schemaOf(path);
      return isMap(schema) && Array.isArray(schema.数值) && /^-?\d+$/.test(String(text)) ? Number(text) : text;
    };
    for (const item of result?.新情况 ?? []) {
      const changes = (item?.变化 ?? []).map(change => ({路径: change.路径, 操作: change.操作,
        ...(change.操作 === '移除' && !change.值 ? {} : {值: value(change.路径, change.值)})}));
      if (changes.length) commands.push({动态事件: {事件ID: item.事件ID, 摘要: item.摘要, 变化: changes}});
    }
    return {commands, errors};
  }

  // 执行并返回要存的命令：只存成功的，重算时照此重放，不再调模型。
  function run(state, result) {
    // 提示词与 json_schema 只在传输层不同；进入转换前都必须通过同一份实际 Schema。
    const issues = validateSchema(result, schema(state, upcoming(state)));
    if (issues.length) throw jsonFailure(`记账结果不符合 Schema：${issues.slice(0, 5).join('；')}${issues.length > 5 ? `；另有 ${issues.length - 5} 项` : ''}`);
    const {commands, errors} = toCommands(state, result);
    const applied = applyCommands(protocol, state, commands);
    const failed = new Set(applied.失败.map(item => item.序号 - 1));
    return {state: applied.state, commands: commands.filter((command, index) => !failed.has(index)), 已写入: applied.已写入,
      失败: [...errors.map(说明 => ({命令: '记账', 错误码: '记账.结果', 说明})), ...applied.失败]};
  }

  return {request, run, toCommands, upcoming};
}

// ---------- 调用侧辅助 ----------
// 另设模型时用设置里的连接；这些字段只用于请求，不进入楼层记录。
export function customApi(config) {
  const connection = config.方式 !== '另设模型' ? {}
    : config.代理预设 ? {proxy_preset: config.代理预设} : {apiurl: config.地址, key: config.密钥};
  const extra = config.方式 === '另设模型' ? {model: config.模型, source: config.来源} : {};
  const temperature = Number(config.温度), length = Number(config.最大长度);
  return Object.fromEntries(Object.entries({...connection, ...extra, temperature: Number.isFinite(temperature) ? temperature : 0.2,
    ...(length > 0 ? {max_tokens: Math.round(length)} : {})}).filter(([, item]) => item !== '' && item !== undefined));
}

// 模型输出可能带 ``` 围栏或前后闲聊；只取最外层的 JSON 对象。
export function parseJson(text) {
  if (typeof text !== 'string') throw new Error('模型没有返回文本');
  const body = text.replace(/^\s*\u0060{3}[^\n]*\n/, '').replace(/\n\u0060{3}\s*$/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('找不到 JSON 对象');
  return JSON.parse(body.slice(start, end + 1));
}

// 带序号的失败来自协议执行；其余是转换阶段的问题。
export function keeperFailures(items) {
  return items.map(item => ({...item, 阶段: Number.isSafeInteger(item.序号) ? '协议执行' : '转换'}));
}
