// 开局草稿：把卡面初值、世界线、方案与玩家改动整理成 seal 的输入，并在内存中预演或准备第 0 楼记录。
// 这里不处理历史求解、排斥检查或命令语义；这些仍由 protocol.seal 与 applyCommands 决定。
import {createCalendar} from '../core/calendar.mjs';
import {applyCommands} from '../core/commands.mjs';
import {dimensionKeys, resolveDomain} from '../core/fields.mjs';
import {parseYaml, stringifyYaml} from '../core/yaml.mjs';
import {codepointCompare, isMap} from '../core/utils.mjs';
import {fromText} from './commands-parser.mjs';

const has = (value, key) => Object.hasOwn(value ?? {}, key);
const clone = value => value === undefined ? undefined : structuredClone(value);
const FIELDS = ['世界线', '开局时间', '方案', '角色组', '玩家', '历史选择'];
const MAP_FIELDS = new Set(['角色组', '历史选择']);
const GREETING_MODES = ['预设', '自动生成', '提示扩写', '手写'];
const PROFILE_TEXT_FIELDS = new Set(['姓名', '性别', '种族', '出身', '出生年']);
const PROFILE_LIST_FIELDS = new Set(['称号', '穿着习惯']);
const APPEARANCE_TEXT_FIELDS = new Set(['发色发型', '瞳色', '体型']);

export function openingError(error) {
  return {code: error?.code ?? '开局.失败', 说明: String(error?.message ?? error ?? '未知错误')};
}

// 方案条目只覆盖写出的字段；其余回退顶层打包值，未配置时为 []。返回结构可直接用于封卷与命令执行。
export function resolvePlanOpening(planID, openingSpec = {}) {
  const plan = typeof planID === 'string' && isMap(openingSpec?.planOpenings) && Object.hasOwn(openingSpec.planOpenings, planID)
    ? openingSpec.planOpenings[planID] : null;
  const list = value => Array.isArray(value) ? [...value] : [];
  const pick = (key, fallback) => has(plan, key) ? clone(plan[key]) : fallback;
  return {
    方案: planID ?? null,
    开场白: pick('开场白', typeof openingSpec?.openingGreeting === 'string' ? openingSpec.openingGreeting : ''),
    开场命令: pick('开场命令', list(openingSpec?.commands)),
    可选在场: pick('可选在场', list(openingSpec?.optionalPresent)),
    必需角色组: pick('必需角色组', list(openingSpec?.requiredGroups)),
  };
}

// 方案提供同名字段时优先使用方案；玩家明确改过的字段覆盖方案；其余由卡面初值补充。
export function composeOpeningInput({defaults = {}, plan = null, overrides = {}} = {}) {
  const input = {}, source = plan?.内容 ?? {};
  for (const field of FIELDS) {
    if (field === '方案') continue;
    const value = has(overrides, field) ? overrides[field]
      : has(source, field) ? source[field]
        : has(defaults, field) ? defaults[field] : undefined;
    if (value !== undefined) input[field] = clone(value);
  }
  if (plan) input.方案 = plan.id;
  else if (!has(overrides, '方案') && has(defaults, '方案')) input.方案 = clone(defaults.方案);

  for (const field of MAP_FIELDS) {
    const base = has(source, field) ? source[field] : has(defaults, field) ? defaults[field] : undefined;
    const patch = overrides[field];
    if (!isMap(base) || !isMap(patch)) {
      if (patch !== undefined) input[field] = clone(patch);
      continue;
    }
    if (field === '角色组') {
      const merged = clone(base);
      for (const [id, item] of Object.entries(patch)) {
        merged[id] = isMap(merged[id]) && isMap(item) ? {...merged[id], ...clone(item)} : clone(item);
      }
      input[field] = merged;
    } else {
      input[field] = {...clone(base), ...clone(patch)};
    }
  }
  return input;
}

export function previewOpening(protocol, input) {
  try {
    return {ok: true, input: clone(input), state: protocol.seal(input)};
  } catch (error) {
    return {ok: false, input: clone(input), error: openingError(error)};
  }
}

// 当前地点写入后，扮演角色组自动在场并随当前地点移动，协议不允许用写场景改写它。
// 可选在场里被关停的角色同样静默略去：写场景的在场/所在删键，确认初始化整条省略；其余命令与字段原样保留。
// 扮演角色组只从写场景裁剪，确认初始化保留（否则玩家的角色会失去开局能力与装备）。
// 不在可选在场里的角色即使被关停也不裁剪，仍由协议触发明确失败。畸形命令不在此改写，仍交原校验。
const enabledGroup = (enabledGroups, id) => enabledGroups === undefined ? true
  : enabledGroups instanceof Set ? enabledGroups.has(id) : isMap(enabledGroups) && enabledGroups[id] === true;
const idSet = value => value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);

export function adaptOpeningCommands(commands, player, options = {}) {
  if (!Array.isArray(commands)) return commands;
  const roleplay = player?.模式 === '扮演' && typeof player.扮演角色组 === 'string' && player.扮演角色组
    ? player.扮演角色组 : null;
  const disabled = new Set();
  if (options?.enabledGroups !== undefined)
    for (const id of idSet(options?.optionalPresent)) if (!enabledGroup(options.enabledGroups, id)) disabled.add(id);
  const sceneSkip = new Set(disabled);
  if (roleplay) sceneSkip.add(roleplay);
  const result = [];
  for (const command of commands) {
    if (!isMap(command) || Object.keys(command).length !== 1) {
      result.push(clone(command));
      continue;
    }
    if (has(command, '确认初始化') && isMap(command.确认初始化) && disabled.has(command.确认初始化.角色组ID)) continue;
    if (!has(command, '写场景') || !isMap(command.写场景)) {
      result.push(clone(command));
      continue;
    }
    const scene = clone(command.写场景);
    let removed = false;
    for (const field of ['在场', '所在']) {
      if (!isMap(scene[field])) continue;
      for (const id of sceneSkip) {
        if (!has(scene[field], id)) continue;
        delete scene[field][id];
        removed = true;
      }
      if (!Object.keys(scene[field]).length) delete scene[field];
    }
    if (!removed) result.push(clone(command));
    else if (Object.keys(scene).length) result.push({写场景: scene});
  }
  return result;
}

// 汇总当前方案下必须启用的角色组与原因：方案必需角色组、非可选的开场命令涉及角色、生效历史事件的核心参与者、玩家扮演组。
// 返回 {角色组ID: [原因…]}；原因去重，顺序稳定。非预设开场白模式传 includeStatic: false 时不强加静态方案命令与必需角色组。
export function requiredOpeningGroups({catalog = {}, planID = null, openingSpec = {}, choiceOverrides = {}, player = null,
  state = null, includeStatic = true} = {}) {
  const active = resolvePlanOpening(planID, openingSpec);
  const optional = new Set(active.可选在场);
  const groups = new Set((catalog.groups ?? []).map(group => group.id));
  const events = new Map((catalog.events ?? []).map(event => [event.id, event]));
  const plans = new Map((catalog.openingPlans ?? []).map(plan => [plan.id, plan]));
  const required = Object.create(null);
  const add = (id, reason) => {
    if (typeof id !== 'string' || !id || id === '玩家' || !groups.has(id)) return;
    const reasons = required[id] ?? (required[id] = []);
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (includeStatic) {
    for (const id of active.必需角色组) add(id, '开局方案必需角色组');
    const commandAdd = id => { if (!optional.has(id)) add(id, '开场命令必需在场或初始化'); };
    for (const command of active.开场命令) {
      if (!isMap(command) || Object.keys(command).length !== 1) continue;
      const scene = command.写场景;
      const params = command.确认事件 ?? command.确认动态事件;
      if (has(command, '写场景') && isMap(scene)) {
        for (const field of ['在场', '所在']) if (isMap(scene[field]))
          for (const id of Object.keys(scene[field])) commandAdd(id);
      } else if (has(command, '确认初始化') && isMap(command.确认初始化)) {
        commandAdd(command.确认初始化.角色组ID);
      } else if (isMap(params)) {
        for (const id of Array.isArray(params.实际参与者) ? params.实际参与者 : []) commandAdd(id);
        const event = has(command, '确认事件') ? events.get(params.事件ID) : null;
        for (const id of event?.内容?.核心参与者 ?? []) commandAdd(id);
      }
    }
  }
  const plan = planID ? plans.get(planID) : null;
  const base = isMap(state?.开局?.历史选择) ? state.开局.历史选择
    : isMap(plan?.内容?.历史选择) ? plan.内容.历史选择 : {};
  const history = {...base, ...(isMap(choiceOverrides) ? choiceOverrides : {})};
  for (const [eventID, branch] of Object.entries(history)) {
    if (!branch || branch === '未发生') continue;
    const event = events.get(eventID), name = event?.内容?.事件标题 ?? eventID;
    for (const id of event?.内容?.核心参与者 ?? []) add(id, `前置历史事件「${name}」核心参与者`);
  }
  if (player?.模式 === '扮演' && typeof player.扮演角色组 === 'string') add(player.扮演角色组, '玩家扮演角色组');
  return required;
}

// 最终封卷与全部开场命令成功后才生成记录草稿；任一条失败都返回失败，不暴露部分本局。
export function prepareOpeningRecord(protocol, input, commands, options = {}) {
  let state;
  try { state = protocol.seal(input); }
  catch (error) { return {ok: false, 阶段: '封卷', error: openingError(error)}; }

  // 记录里保存实际执行的命令，重放才能得到同一状态。
  const adjusted = adaptOpeningCommands(commands, state.开局?.玩家, options);
  let executed;
  try { executed = applyCommands(protocol, state, adjusted); }
  catch (error) { return {ok: false, 阶段: '开场命令', error: openingError(error)}; }
  if (executed.失败?.length) {
    const first = executed.失败[0];
    return {ok: false, 阶段: '开场命令', failures: clone(executed.失败),
      error: {code: '开场.命令', 说明: `有 ${executed.失败.length} 条开场命令未执行：${first.错误码} ${first.说明}`}};
  }
  return {ok: true, record: {
    本局: executed.state,
    命令: clone(adjusted),
    失败: [],
    已写入: clone(executed.已写入 ?? []),
    记账: {方式: '开场命令', 应答格式: '无', 状态: '成功', 尝试次数: 1},
  }};
}

// 提取命令列表中首条 写场景.当前地点.地标。
function commandLocationOf(commands, locationMap) {
  for (const command of Array.isArray(commands) ? commands : []) {
    const landmark = command?.写场景?.当前地点?.地标;
    if (typeof landmark === 'string' && locationMap.has(landmark)) return landmark;
  }
  return null;
}

// 构造按上下级层级排布的地点选择列表。
function buildLocationList(locations) {
  if (!locations.length) return [];
  const byId = new Map(locations.map(entry => [entry.id, entry]));
  const children = new Map();
  const roots = [];
  for (const entry of locations) {
    const parent = typeof entry.上级 === 'string' && byId.has(entry.上级) ? entry.上级 : null;
    if (parent) {
      const list = children.get(parent) ?? [];
      list.push(entry);
      children.set(parent, list);
    } else {
      roots.push(entry);
    }
  }
  const sortById = items => [...items].sort((a, b) => codepointCompare(a.id, b.id));
  const result = [];
  const visited = new Set();
  function walk(entry, depth, chain) {
    if (visited.has(entry.id)) return;
    visited.add(entry.id);
    const pathChain = [...chain, entry.id];
    result.push({
      id: entry.id,
      上级: entry.上级 ?? null,
      深度: depth,
      路径: pathChain.join(' / '),
      标签: `${'　'.repeat(depth)}${entry.id}${depth > 0 ? `（${pathChain.slice(0, -1).join(' / ')}）` : ''}`,
    });
    for (const child of sortById(children.get(entry.id) ?? [])) walk(child, depth + 1, pathChain);
  }
  for (const root of sortById(roots)) walk(root, 0, []);
  for (const entry of sortById(locations)) if (!visited.has(entry.id)) walk(entry, 0, []);
  return result;
}

function cleanListInput(value) {
  const raw = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/[\r\n,，、]+/) : [];
  return raw.map(item => String(item ?? '').trim()).filter(Boolean);
}

function cleanAbilityMap(raw, dimensions = {}) {
  const out = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const dim = dimensions[name];
    if (!dim) continue;
    if (dim.类型 === '等级映射') {
      if (!isMap(value)) continue;
      const entries = Object.entries(value).filter(([, v]) => typeof v === 'string' && v.trim());
      if (entries.length) out[name] = Object.fromEntries(entries);
    } else if (dim.类型 === '单值等级') {
      if (typeof value === 'string' && value.trim()) out[name] = value.trim();
    } else if (dim.类型 === '集合') {
      const list = [...new Set(cleanListInput(value))];
      if (list.length) out[name] = list;
    }
  }
  return out;
}

function buildAbilityMeta(decl, catalog) {
  const dims = decl.ability?.维度 ?? {};
  return Object.entries(dims).map(([name, dim]) => {
    let memberOptions = [];
    if (dim.类型 === '集合' && isMap(dim.成员) && dim.成员.条目库) {
      const entries = catalog.entries?.[dim.成员.条目库] ?? [];
      memberOptions = entries
        .filter(entry => Object.entries(dim.成员.条件 ?? {}).every(([k, v]) => entry.内容?.[k] === v))
        .map(entry => ({id: entry.id, 名称: entry.内容?.名称 ?? entry.id}));
    }
    return {
      名称: name,
      类型: dim.类型,
      等级序列: dim.等级 ? resolveDomain(`等级.${dim.等级}`, decl) : [],
      键列表: dim.类型 === '等级映射' ? dimensionKeys(dim) : [],
      成员选项: memberOptions,
    };
  });
}

export function createOpeningDraft({protocol, catalog, decl, defaults = {}, commands = [], openingSpec = null}) {
  // 兼容旧调用：只传 commands 时按顶层单方案处理；打包值存在时以它为准。
  const spec = {
    openingGreeting: typeof openingSpec?.openingGreeting === 'string' ? openingSpec.openingGreeting : '',
    commands: Array.isArray(openingSpec?.commands) ? openingSpec.commands : commands,
    optionalPresent: Array.isArray(openingSpec?.optionalPresent) ? openingSpec.optionalPresent : [],
    requiredGroups: Array.isArray(openingSpec?.requiredGroups) ? openingSpec.requiredGroups : [],
    planOpenings: isMap(openingSpec?.planOpenings) ? openingSpec.planOpenings : {},
  };
  const calendar = createCalendar(decl.calendar);
  const worldlines = [...(catalog.worldlines ?? [])].sort((a, b) => codepointCompare(a.id, b.id));
  const worldlineMap = new Map(worldlines.map(wl => [wl.id, wl]));
  const plans = catalog.openingPlans ?? [];
  const planMap = new Map(plans.map(plan => [plan.id, plan]));
  const groupMap = new Map((catalog.groups ?? []).map(group => [group.id, group]));
  const eventMap = new Map((catalog.events ?? []).map(event => [event.id, event]));
  const locations = catalog.entries?.地点 ?? [];
  const locationMap = new Map(locations.map(entry => [entry.id, entry]));
  const locationOptions = buildLocationList(locations);
  const firstLocationId = locations.length ? [...locations].sort((a, b) => codepointCompare(a.id, b.id))[0].id : null;
  const optionSource = catalog.openingOptions?.内容 ?? null;
  const freeCombination = optionSource?.自由组合 === true;
  const options = Array.isArray(optionSource?.选项) ? optionSource.选项 : [];
  const abilityMeta = buildAbilityMeta(decl, catalog);
  const equipMeta = (catalog.entries?.装备 ?? []).map(entry => ({id: entry.id, 名称: entry.内容?.名称 ?? entry.id}));
  const equipStates = resolveDomain('词表.装备状态', decl);

  let planId = has(defaults, '方案') && planMap.has(defaults.方案) ? defaults.方案 : null;
  let worldlineId = null;
  if (worldlines.length) {
    worldlineId = has(defaults, '世界线') && worldlineMap.has(defaults.世界线) ? defaults.世界线
      : planId && worldlineMap.has(planMap.get(planId)?.内容?.世界线) ? planMap.get(planId).内容.世界线
        : worldlines.find(wl => wl.内容?.默认 === true)?.id ?? worldlines[0].id;
    if (planId && planMap.get(planId)?.内容?.世界线 && planMap.get(planId).内容.世界线 !== worldlineId) planId = null;
  }

  let overrides = {}, failure = null, preview = null;
  // 玩家选择与档案草稿是同一份状态：结构化表单、YAML 文本框、预览与提交都读这里。
  let playerMode = '自建', roleGroup = null, profileDraft = {}, initialAbility = {}, initialEquipment = [], profileText = '{}';
  let playerTouched = false, profileFailure = null;
  let locationOverride = null, locationTouched = false;
  let greetingModeTouched = false, greetingHint = '', customGreeting = '';

  const planContent = () => planId ? planMap.get(planId)?.内容 ?? {} : {};
  const stateNow = () => preview?.state ?? null;
  const activeNow = () => resolvePlanOpening(planId, spec);
  const hasPresetGreeting = () => Boolean(activeNow().开场白?.trim() || (!worldlines.length && activeNow().开场命令.length > 0));
  let greetingMode = worldlines.length && !planId ? '自动生成' : (hasPresetGreeting() ? '预设' : '自动生成');

  const sourcePlayer = () => {
    const source = planContent(), base = has(source, '玩家') ? source.玩家 : defaults.玩家;
    return isMap(base) ? base : {模式: '自建', 档案: {}};
  };
  function playerNow() {
    if (playerMode === '扮演') return {模式: '扮演', ...(roleGroup ? {扮演角色组: roleGroup} : {})};
    const cleanedAbility = cleanAbilityMap(initialAbility, decl.ability?.维度);
    const cleanedEquipment = initialEquipment.filter(item => isMap(item) && item.装备ID);
    return {
      模式: '自建',
      档案: clone(profileDraft),
      ...(Object.keys(cleanedAbility).length ? {初始能力: cleanedAbility} : {}),
      ...(cleanedEquipment.length ? {初始装备: clone(cleanedEquipment)} : {}),
    };
  }
  // 未编辑玩家选择时，方案或卡面初值提供模式、扮演角色组与档案草稿；编辑过就保留用户的选择。
  function adoptSourcePlayer() {
    const source = sourcePlayer();
    playerMode = source.模式 === '扮演' ? '扮演' : '自建';
    roleGroup = playerMode === '扮演' ? source.扮演角色组 ?? null : null;
    profileDraft = isMap(source.档案) ? clone(source.档案) : {};
    initialAbility = isMap(source.初始能力) ? clone(source.初始能力) : {};
    initialEquipment = Array.isArray(source.初始装备) ? clone(source.初始装备) : [];
    profileText = stringifyYaml(profileDraft);
    profileFailure = null;
  }

  const inputNow = () => composeOpeningInput({
    defaults,
    plan: planId ? planMap.get(planId) : null,
    overrides: {
      ...overrides,
      方案: planId,
      玩家: playerNow(),
      ...(worldlines.length && worldlineId ? {世界线: worldlineId} : {}),
    },
  });

  const currentEffectiveTime = () => has(overrides, '开局时间') ? overrides.开局时间
    : stateNow()?.开局?.开局时间 ?? planContent().开局时间 ?? defaults.开局时间 ?? '';

  const enabledNow = state => Object.fromEntries(Object.entries(state?.开局?.角色组 ?? {})
    .map(([id, run]) => [id, run?.启用 === true]));

  const requiredNow = state => requiredOpeningGroups({
    catalog, planID: planId, openingSpec: spec, choiceOverrides: overrides.历史选择,
    player: state?.开局?.玩家 ?? playerNow(), state, includeStatic: greetingMode === '预设',
  });

  function resolveDefaultLocation(state = stateNow()) {
    if (!locations.length) return null;
    const plan = planId ? planMap.get(planId) : null;
    const planLoc = typeof plan?.内容?.开局地点 === 'string' && locationMap.has(plan.内容.开局地点) ? plan.内容.开局地点 : null;
    const cmdLoc = greetingMode === '预设' ? commandLocationOf(activeNow().开场命令, locationMap) : null;
    if (plan && (planLoc || cmdLoc)) return planLoc ?? cmdLoc;
    if (playerMode === '扮演' && roleGroup) {
      const stateLoc = state?.角色?.[roleGroup]?.所在;
      if (typeof stateLoc === 'string' && locationMap.has(stateLoc)) return stateLoc;
      const initLoc = groupMap.get(roleGroup)?.内容?.初始所在;
      if (typeof initLoc === 'string' && locationMap.has(initLoc)) return initLoc;
    }
    if (planLoc) return planLoc;
    const topLoc = commandLocationOf(spec.commands, locationMap);
    if (topLoc) return topLoc;
    return firstLocationId;
  }

  const currentLocation = (state = stateNow()) => {
    if (!locations.length) return null;
    if (locationTouched && locationOverride && locationMap.has(locationOverride)) return locationOverride;
    return resolveDefaultLocation(state);
  };

  function presetDeviation() {
    if (greetingMode !== '预设') return null;
    if (worldlines.length && !planId) {
      return '当前为无预设（自由开局），建议切换为 AI 自动生成、提示扩写或玩家手写开场白。';
    }
    const plan = planId ? planMap.get(planId) : null;
    const baseTime = plan?.内容?.开局时间 ?? defaults.开局时间;
    const nowTime = currentEffectiveTime();
    const timeChanged = has(overrides, '开局时间') && baseTime && nowTime !== baseTime;
    const presetLoc = (typeof plan?.内容?.开局地点 === 'string' && locationMap.has(plan.内容.开局地点) ? plan.内容.开局地点 : null)
      ?? commandLocationOf(activeNow().开场命令, locationMap);
    const locChanged = locationTouched && presetLoc && locationOverride && locationOverride !== presetLoc;
    const baseWl = plan?.内容?.世界线 ?? defaults.世界线 ?? null;
    const wlChanged = Boolean(worldlines.length && baseWl && worldlineId && worldlineId !== baseWl);
    if (timeChanged || locChanged || wlChanged) {
      return '已调整时间、地点或世界线，预设精修开场白可能与当前设定不符，建议切换为 AI 自动生成、提示扩写或玩家手写开场白。';
    }
    return null;
  }

  // 清理已不再早于当前开局时间的失效历史覆盖；切世界线时一并清理在新世界线门槛明确不成立的事件覆盖。
  function pruneExpiredHistory({worldlineChanged = false} = {}) {
    if (!isMap(overrides.历史选择) || !Object.keys(overrides.历史选择).length) return;
    const input = inputNow();
    const openingInterval = calendar.time(input.开局时间);
    if (!openingInterval) return;
    const next = {...overrides.历史选择};
    let changed = false;
    for (const eventID of Object.keys(next)) {
      const event = eventMap.get(eventID);
      const latest = event ? calendar.time(event.内容?.触发时间?.最晚) : null;
      if (!latest || latest[1] > openingInterval[0]) {
        delete next[eventID];
        changed = true;
        continue;
      }
      if (worldlineChanged && event?.内容?.门槛) {
        try {
          const probe = protocol.seal({...input, 开局时间: event.内容.触发时间.最晚, 历史选择: {}});
          if (protocol.evaluate(probe, event.内容.门槛) === false) {
            delete next[eventID];
            changed = true;
          }
        } catch {}
      }
    }
    if (changed) {
      if (Object.keys(next).length) overrides = {...overrides, 历史选择: next};
      else { const rest = {...overrides}; delete rest.历史选择; overrides = rest; }
    }
  }

  function groupNow(id) {
    const group = groupMap.get(id);
    if (!group) return null;
    const effective = stateNow()?.开局?.角色组?.[id] ?? {};
    const fromOverride = overrides.角色组?.[id] ?? {};
    const declared = group.内容 ?? {};
    return {
      id,
      显示名: declared.显示名 ?? id,
      分类: declared.分类 ?? '',
      角色包: declared.角色包 ?? '',
      启用: has(fromOverride, '启用') ? fromOverride.启用
        : has(effective, '启用') ? effective.启用 : declared.默认启用 === true,
      版本ID: has(fromOverride, '版本ID') ? fromOverride.版本ID
        : has(effective, '版本ID') ? effective.版本ID : declared.默认版本 ?? group.版本清单?.[0] ?? id,
      版本: group.版本清单 ?? [id],
      版本内容: declared.版本 ?? [],
    };
  }

  function historyNow(eventID) {
    const chosen = overrides.历史选择?.[eventID];
    return chosen !== undefined ? chosen : stateNow()?.开局?.历史选择?.[eventID] ?? '';
  }

  // 严格按 docs/03-事件.md 过滤与排序：只展示开局前事件、按触发时间.最晚升序、仅保留核心参与者启用且前置门槛成立的事件与分支。
  function historyControls() {
    const input = inputNow();
    const openingInterval = calendar.time(input.开局时间);
    if (!openingInterval) return [];
    const currentGroups = Object.fromEntries((catalog.groups ?? []).map(group => {
      const row = groupNow(group.id);
      return [group.id, {启用: row?.启用 === true, 版本ID: row?.版本ID ?? group.内容?.默认版本 ?? group.id}];
    }));
    const pastOptions = options
      .map(item => {
        const event = eventMap.get(item.事件ID);
        const latest = event ? calendar.time(event.内容?.触发时间?.最晚) : null;
        return {item, event, latest};
      })
      .filter(({event, latest}) => event && latest && latest[1] <= openingInterval[0])
      .sort((a, b) => a.latest[0] - b.latest[0] || codepointCompare(a.item.事件ID, b.item.事件ID));

    const effectiveHistory = isMap(input.历史选择) ? input.历史选择 : {};
    const controls = [];
    for (const {item, event, latest} of pastOptions) {
      const coreParticipants = Array.isArray(event.内容?.核心参与者) ? event.内容.核心参与者 : [];
      if (coreParticipants.some(id => currentGroups[id]?.启用 !== true)) continue;

      const prefixHistory = {};
      for (const [eid, branch] of Object.entries(effectiveHistory)) {
        if (eid === item.事件ID) continue;
        const other = eventMap.get(eid);
        const otherLatest = other ? calendar.time(other.内容?.触发时间?.最晚) : null;
        if (otherLatest && otherLatest[1] <= latest[0]) prefixHistory[eid] = branch;
      }
      let prefixState = null;
      try {
        prefixState = protocol.seal({
          ...(worldlines.length && worldlineId ? {世界线: worldlineId} : {}),
          开局时间: event.内容.触发时间.最晚,
          角色组: currentGroups,
          玩家: {模式: '自建', 档案: {}},
          历史选择: prefixHistory,
        });
      } catch {
        try {
          prefixState = protocol.seal({
            ...(worldlines.length && worldlineId ? {世界线: worldlineId} : {}),
            开局时间: event.内容.触发时间.最晚,
            角色组: currentGroups,
            玩家: {模式: '自建', 档案: {}},
            历史选择: {},
          });
        } catch { continue; }
      }
      if (event.内容?.门槛 && protocol.evaluate(prefixState, event.内容.门槛) !== true) continue;

      const branchList = Array.isArray(event.内容?.分支) ? event.内容.分支 : [];
      const eligible = [];
      let hasNotHappened = false;
      for (const [branchId, label] of Object.entries(item.选项 ?? {})) {
        if (branchId === '未发生') {
          hasNotHappened = true;
          eligible.push({id: '未发生', label: String(label)});
          continue;
        }
        const branch = branchList.find(b => b.分支ID === branchId);
        if (!branch) continue;
        if (branch.门槛 && protocol.evaluate(prefixState, branch.门槛) !== true) continue;
        eligible.push({id: branchId, label: String(label)});
      }
      const realBranches = eligible.filter(b => b.id !== '未发生');
      if (!realBranches.length) continue;
      if (!hasNotHappened) eligible.push({id: '未发生', label: '未发生'});
      controls.push({
        事件ID: item.事件ID,
        问题: item.问题 || event.内容?.事件标题 || item.事件ID,
        值: historyNow(item.事件ID),
        分支: eligible,
      });
    }
    return controls;
  }

  // 预演与提交共用同一套管道：封卷 → 预设模式走静态开场命令，动态模式走初始地点与文本校验 → 查处必需角色未启用。
  // 任一步失败都保留上一份有效预览；previewNow 与 prepare 的分歧只剩档案错误。
  function evaluate() {
    const input = inputNow();
    const sealed = previewOpening(protocol, input);
    if (!sealed.ok) return {...sealed, error: sealed.error};
    const active = activeNow(), enabledGroups = enabledNow(sealed.state);
    if (greetingMode === '预设') {
      const prepared = prepareOpeningRecord(protocol, input, active.开场命令,
        {optionalPresent: active.可选在场, enabledGroups});
      if (!prepared.ok) {
        return {ok: false, input: sealed.input, 阶段: prepared.阶段, failures: prepared.failures, error: prepared.error};
      }
      const required = requiredNow(sealed.state);
      const missing = Object.entries(required).filter(([id]) => enabledGroups[id] !== true);
      if (missing.length) {
        return {ok: false, 阶段: '必需角色组', input: sealed.input, error: {code: '开局.必需角色组',
          说明: '必需角色未启用：' + missing.map(([id, reasons]) => `${id}（${reasons.join('；')}）`).join('、')}};
      }
      return {ok: true, mode: '预设', input: sealed.input, state: sealed.state, record: prepared.record,
        greeting: active.开场白, required};
    }

    if (greetingMode === '手写' && !customGreeting.trim()) {
      return {ok: false, 阶段: '开场白', input: sealed.input, error: {code: '开局.开场白', 说明: '玩家手写模式下开场白正文不能为空'}};
    }
    if (greetingMode === '提示扩写' && !greetingHint.trim()) {
      return {ok: false, 阶段: '开场白', input: sealed.input, error: {code: '开局.开场白', 说明: '提示扩写模式下请填写一句开场提示，或改选“AI 自动生成”'}};
    }
    const required = requiredNow(sealed.state);
    const missing = Object.entries(required).filter(([id]) => enabledGroups[id] !== true);
    if (missing.length) {
      return {ok: false, 阶段: '必需角色组', input: sealed.input, error: {code: '开局.必需角色组',
        说明: '必需角色未启用：' + missing.map(([id, reasons]) => `${id}（${reasons.join('；')}）`).join('、')}};
    }
    const loc = currentLocation(sealed.state);
    const baseCommands = loc ? [{写场景: {当前地点: {地标: loc, 场景: loc}}}] : [];
    let executed;
    try { executed = applyCommands(protocol, sealed.state, baseCommands); }
    catch (error) { return {ok: false, 阶段: '开场命令', input: sealed.input, error: openingError(error)}; }
    if (executed.失败?.length) {
      const first = executed.失败[0];
      return {ok: false, 阶段: '开场命令', input: sealed.input, failures: clone(executed.失败),
        error: {code: '开场.命令', 说明: `初始地点写入失败：${first.错误码} ${first.说明}`}};
    }
    return {
      ok: true,
      mode: greetingMode,
      input: sealed.input,
      state: sealed.state,
      baseState: executed.state,
      baseCommands: clone(baseCommands),
      baseWritten: clone(executed.已写入 ?? []),
      greeting: greetingMode === '手写' ? customGreeting.trim() : '',
      greetingHint: greetingHint.trim(),
      required,
    };
  }

  function previewNow() {
    const result = evaluate();
    if (result.ok) { preview = {ok: true, input: result.input, state: result.state}; failure = null; }
    else failure = clone(result.error);
    return {...result, error: failure ? clone(failure) : null};
  }

  // 档案错误只属于自建玩家；扮演模式不提交这份档案，预览与提交不受旧错误阻断。
  function afterChange() {
    const result = previewNow();
    const blocked = playerMode === '自建' && profileFailure !== null;
    if (blocked) failure = profileFailure;
    return {...result, ok: !blocked && result.ok, error: failure};
  }

  function setWorldline(id) {
    if (!worldlines.length || !worldlineMap.has(id)) {
      failure = {code: '开局.世界线', 说明: `世界线不存在：${id}`};
      return {ok: false, error: clone(failure)};
    }
    const prevTime = currentEffectiveTime();
    worldlineId = id;
    if (planId && planMap.get(planId)?.内容?.世界线 !== worldlineId) {
      planId = null;
      if (!has(overrides, '开局时间') && !(defaults.开局时间 && calendar.time(defaults.开局时间))
        && prevTime && calendar.time(prevTime)) {
        overrides.开局时间 = prevTime;
      }
      if (!playerTouched) adoptSourcePlayer();
      if (!greetingModeTouched) greetingMode = '自动生成';
    }
    pruneExpiredHistory({worldlineChanged: true});
    return afterChange();
  }

  function setPlan(id) {
    if (id && !planMap.has(id)) {
      failure = {code: '开局.方案', 说明: `开局方案不存在：${id}`};
      return {ok: false, error: clone(failure)};
    }
    const prevTime = currentEffectiveTime();
    if (id) {
      planId = id;
      const planWl = planMap.get(id)?.内容?.世界线;
      if (worldlines.length && planWl && worldlineMap.has(planWl)) worldlineId = planWl;
      delete overrides.开局时间;
      locationTouched = false;
      locationOverride = null;
      if (!greetingModeTouched) greetingMode = hasPresetGreeting() ? '预设' : '自动生成';
    } else {
      planId = null;
      if (!has(overrides, '开局时间') && !(defaults.开局时间 && calendar.time(defaults.开局时间))
        && prevTime && calendar.time(prevTime)) {
        overrides.开局时间 = prevTime;
      }
      if (worldlines.length && !greetingModeTouched) greetingMode = '自动生成';
      else if (greetingMode === '预设' && !hasPresetGreeting()) greetingMode = '自动生成';
    }
    if (!playerTouched) adoptSourcePlayer();
    pruneExpiredHistory();
    return afterChange();
  }

  function setTime(value) {
    overrides.开局时间 = String(value ?? '');
    pruneExpiredHistory();
    return afterChange();
  }

  function setLocation(id) {
    if (!locations.length || !id || !locationMap.has(id)) {
      failure = {code: '开局.地点', 说明: `开局地点不存在：${id}`};
      return {ok: false, error: clone(failure)};
    }
    locationOverride = id;
    locationTouched = true;
    return afterChange();
  }

  function setGroup(id, patch) {
    if (!groupMap.has(id) || !isMap(patch)) {
      failure = {code: '开局.角色组', 说明: `角色组选择不合法：${id}`};
      return {ok: false, error: clone(failure)};
    }
    overrides = {...overrides, 角色组: {...(overrides.角色组 ?? {}), [id]: {...(overrides.角色组?.[id] ?? {}), ...clone(patch)}}};
    pruneExpiredHistory();
    return afterChange();
  }

  function setPlayerMode(mode) {
    if (!['自建', '扮演'].includes(mode)) {
      failure = {code: '开局.玩家', 说明: '玩家模式不合法'};
      return {ok: false, error: clone(failure)};
    }
    playerTouched = true;
    playerMode = mode;
    if (mode === '扮演' && !roleGroup)
      roleGroup = catalog.groups.map(group => groupNow(group.id)).find(group => group?.启用)?.id ?? null;
    return afterChange();
  }

  function setPlayerGroup(id) {
    if (id && !groupMap.has(id)) {
      failure = {code: '开局.玩家', 说明: `扮演角色组不存在：${id}`};
      return {ok: false, error: clone(failure)};
    }
    playerTouched = true;
    playerMode = '扮演';
    roleGroup = id || null;
    return afterChange();
  }

  // 结构化编辑自建玩家档案字段，空值自动删键并同步 YAML 源码。
  function setProfileField(field, value) {
    playerTouched = true;
    profileFailure = null;
    if (PROFILE_TEXT_FIELDS.has(field)) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) profileDraft[field] = text; else delete profileDraft[field];
    } else if (PROFILE_LIST_FIELDS.has(field)) {
      const items = cleanListInput(value);
      if (items.length) profileDraft[field] = items; else delete profileDraft[field];
    } else if (typeof field === 'string' && field.startsWith('稳定体貌.')) {
      const sub = field.slice('稳定体貌.'.length);
      const appearance = isMap(profileDraft.稳定体貌) ? {...profileDraft.稳定体貌} : {};
      if (APPEARANCE_TEXT_FIELDS.has(sub)) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text) appearance[sub] = text; else delete appearance[sub];
      } else if (sub === '特征') {
        const items = cleanListInput(value);
        if (items.length) appearance.特征 = items; else delete appearance.特征;
      } else {
        failure = {code: '开局.档案', 说明: `未知体貌字段：${field}`};
        return {ok: false, error: clone(failure)};
      }
      if (Object.keys(appearance).length) profileDraft.稳定体貌 = appearance;
      else delete profileDraft.稳定体貌;
    } else {
      failure = {code: '开局.档案', 说明: `未知档案字段：${field}`};
      return {ok: false, error: clone(failure)};
    }
    profileText = stringifyYaml(profileDraft);
    return afterChange();
  }

  function setInitialAbility(dimension, value) {
    const dim = decl.ability?.维度?.[dimension];
    if (!dim) {
      failure = {code: '开局.玩家', 说明: `未知能力维度：${dimension}`};
      return {ok: false, error: clone(failure)};
    }
    playerTouched = true;
    profileFailure = null;
    const next = clone(initialAbility);
    if (value === null || value === undefined || value === '') {
      delete next[dimension];
    } else if (dim.类型 === '等级映射') {
      if (!isMap(value)) {
        failure = {code: '开局.玩家', 说明: `能力维度「${dimension}」须为映射`};
        return {ok: false, error: clone(failure)};
      }
      const entries = Object.entries(value).filter(([, rank]) => typeof rank === 'string' && rank.trim());
      if (entries.length) next[dimension] = Object.fromEntries(entries);
      else delete next[dimension];
    } else if (dim.类型 === '单值等级') {
      const text = String(value).trim();
      if (text) next[dimension] = text; else delete next[dimension];
    } else if (dim.类型 === '集合') {
      const items = [...new Set(cleanListInput(value))];
      if (items.length) next[dimension] = items; else delete next[dimension];
    }
    initialAbility = next;
    profileText = stringifyYaml(profileDraft);
    return afterChange();
  }

  function setInitialEquipment(list) {
    if (!Array.isArray(list)) {
      failure = {code: '开局.玩家', 说明: '初始装备须为列表'};
      return {ok: false, error: clone(failure)};
    }
    playerTouched = true;
    profileFailure = null;
    initialEquipment = clone(list);
    profileText = stringifyYaml(profileDraft);
    return afterChange();
  }

  // 解析失败的文本只留下错误提示，不覆盖最后一份有效草稿；提交也按这份错误拒绝。
  function setProfileText(text) {
    playerTouched = true;
    profileText = String(text ?? '');
    let parsed;
    try { parsed = parseYaml(profileText.trim() || '{}'); }
    catch (error) {
      profileFailure = {code: '开局.档案', 说明: '玩家档案 YAML 解析失败：' + error.message.split('\n')[0]};
      previewNow();
      failure = profileFailure;
      return {ok: false, error: clone(failure)};
    }
    if (parsed == null) parsed = {};
    if (!isMap(parsed)) {
      profileFailure = {code: '开局.档案', 说明: '玩家档案须为 YAML 映射'};
      previewNow();
      failure = profileFailure;
      return {ok: false, error: clone(failure)};
    }
    profileFailure = null;
    profileDraft = clone(parsed);
    return afterChange();
  }

  function setHistory(eventID, branch) {
    const item = options.find(option => option.事件ID === eventID);
    if (!freeCombination) {
      failure = {code: '开局.历史选择', 说明: '自由组合已关闭，历史选择由方案决定'};
      return {ok: false, error: clone(failure)};
    }
    if (!item || (branch && branch !== '未发生' && !has(item.选项 ?? {}, branch))) {
      failure = {code: '开局.历史选择', 说明: `历史选择无效：${eventID}`};
      return {ok: false, error: clone(failure)};
    }
    const next = {...(overrides.历史选择 ?? {})};
    if (branch) next[eventID] = branch; else delete next[eventID];
    overrides = {...overrides, 历史选择: next};
    return afterChange();
  }

  function setGreetingMode(mode) {
    if (!GREETING_MODES.includes(mode)) {
      failure = {code: '开局.开场白', 说明: `开场白模式不合法：${mode}`};
      return {ok: false, error: clone(failure)};
    }
    if (mode === '预设' && !hasPresetGreeting()) {
      failure = {code: '开局.开场白', 说明: '当前没有可用的预设开场白，请改选 AI 自动生成、提示扩写或玩家手写'};
      return {ok: false, error: clone(failure)};
    }
    greetingMode = mode;
    greetingModeTouched = true;
    return afterChange();
  }

  function setGreetingHint(text) {
    greetingHint = String(text ?? '');
    return afterChange();
  }

  function setCustomGreeting(text) {
    customGreeting = String(text ?? '');
    return afterChange();
  }

  function fail(value) {
    failure = isMap(value) ? clone(value) : openingError(value);
    return {ok: false, error: clone(failure)};
  }

  adoptSourcePlayer();
  previewNow();

  return {
    previewNow,
    setWorldline, setPlan, setTime, setLocation, setGroup,
    setPlayerMode, setPlayerGroup, setProfileField, setInitialAbility, setInitialEquipment, setProfileText,
    setHistory, setGreetingMode, setGreetingHint, setCustomGreeting, fail,
    input: inputNow,
    prepare: () => {
      if (playerMode === '自建' && profileFailure) return {ok: false, 阶段: '封卷', error: clone(profileFailure)};
      const result = evaluate();
      if (!result.ok) {
        return {ok: false, 阶段: result.阶段 ?? '开场命令', failures: result.failures, error: clone(result.error)};
      }
      if (result.mode === '预设') {
        return {ok: true, mode: '预设', record: result.record, greeting: result.greeting};
      }
      return {
        ok: true,
        mode: result.mode,
        sealedState: result.state,
        baseState: result.baseState,
        baseCommands: result.baseCommands,
        baseWritten: result.baseWritten,
        greeting: result.greeting,
        greetingHint: result.greetingHint,
      };
    },
    snapshot: () => {
      const active = activeNow(), state = stateNow(), required = requiredNow(state);
      const visiblePlans = worldlines.length ? plans.filter(plan => plan.内容?.世界线 === worldlineId) : plans;
      const nowTime = currentEffectiveTime();
      let playerSkills = [];
      if (playerMode === '自建' && state) {
        try { playerSkills = protocol.availableSkills(state, '玩家'); } catch {}
      }
      return {
        世界线列表: worldlines.map(wl => ({id: wl.id, 概述: wl.内容?.概述 ?? '', 默认: wl.内容?.默认 === true})),
        世界线: worldlineId,
        计划: visiblePlans.map(plan => ({id: plan.id, 概述: plan.内容?.概述 ?? '', 内容: clone(plan.内容 ?? {})})),
        方案: planId,
        开场白: active.开场白,
        主开场白: spec.openingGreeting,
        开场白模式: greetingMode,
        可用预设开场白: hasPresetGreeting(),
        开场提示: greetingHint,
        手写开场白: customGreeting,
        预设偏离提示: presetDeviation(),
        可选在场: [...active.可选在场],
        必需角色组: [...active.必需角色组],
        时间: nowTime,
        时间格式: calendar.pattern,
        地点: currentLocation(state),
        默认地点: resolveDefaultLocation(state),
        地点列表: clone(locationOptions),
        方案内容: clone(planContent()),
        自由组合: freeCombination,
        角色组: catalog.groups.map(group => {
          const row = groupNow(group.id);
          if (!row) return null;
          const reasons = required[row.id] ?? [];
          return {...row, 必选: reasons.length > 0, 依赖原因: [...reasons]};
        }).filter(Boolean),
        玩家: playerNow(),
        档案文本: profileText,
        自建表单: {
          档案: clone(profileDraft),
          初始能力: cleanAbilityMap(initialAbility, decl.ability?.维度),
          初始装备: clone(initialEquipment),
          可用技能: playerSkills,
          纪年: {前缀: decl.calendar.前缀, 年位数: decl.calendar.年位数, 格式: calendar.pattern, 当前年: calendar.year(nowTime)},
          能力维度: clone(abilityMeta),
          装备库: clone(equipMeta),
          装备状态: [...equipStates],
        },
        历史: historyControls(),
        预览: state ? clone(state) : null,
        上次预览: preview ? clone(preview.state) : null,
        错误: failure ? clone(failure) : null,
      };
    },
  };
}

export const isDynamicOpening = record => record?.记账?.方式 === '开场生成' || record?.记账?.方式 === '开场手写';

export function dynamicOpeningBase(protocol, originRecord) {
  const opening = originRecord.本局.开局;
  const seeded = protocol.seal({
    ...(opening.世界线 ? {世界线: opening.世界线} : {}),
    开局时间: opening.开局时间, 角色组: opening.角色组, 玩家: opening.玩家,
    历史选择: opening.历史选择, ...(opening.方案 ? {方案: opening.方案} : {}),
  });
  const first = originRecord.命令?.[0];
  if (isMap(first?.写场景) && Object.keys(first.写场景).length === 1 && isMap(first.写场景.当前地点)) {
    const run = applyCommands(protocol, seeded, [first]);
    if (!run.失败?.length) return {baseState: run.state, baseCommands: [first], baseWritten: run.已写入 ?? []};
  }
  return {baseState: seeded, baseCommands: [], baseWritten: []};
}

// ---------- 开局流程 ----------
// 宿主写正文：注入回调优先；否则按 setChatMessages → setChatMessage 降级。都没有时返回 false，
// 极简只读宿主照常写入记录，不把缺少可选 API 当作权限缺口。
async function writeOpeningGreeting(greeting, id = 0) {
  const writeMany = globalThis.setChatMessages;
  if (typeof writeMany === 'function') {
    const patch = [{message_id: id, message: greeting}];
    try { await writeMany(patch, {refresh: 'affected'}); return true; }
    catch (error) {
      try { await writeMany(patch); return true; }
      catch { throw error; }
    }
  }
  const writeOne = globalThis.setChatMessage;
  if (typeof writeOne === 'function') { await writeOne(id, greeting); return true; }
  return false;
}

// 弹窗、提交与失败提示：宿主函数（聊天读写、记录写入、队列与路由刷新）由调用方注入，草稿与预演仍用本文件上方的纯函数。
export function createOpeningFlow({protocol, catalog, decl, defaults, commands, openingSpec = null, updateOpeningMessage = null,
  generateOpening = null, bookkeepOpening = null, bookkeeping = () => false,
  messages, chatId, ownershipOf, recordOf, validateRecord, manifest, store, taskFor, enqueue, refresh, audit, session, status, nodeOf, popup}) {
  function openingFailure(draft, message, error = null) {
    const detail = error ? (error.说明 ?? error.message ?? String(error)) : '';
    const failure = {code: error?.code ?? '开局.失败',
      说明: message && detail ? `${message}（${detail}）` : (message || detail)};
    draft.fail(failure);
    status.pendingOpening(failure.说明);
    toastr.error(failure.说明, '世界树：无法开局');
    return false;
  }

  // 第 0 楼提交是原子的：先封卷与执行命令（或动态生成+记账），再同步正文，最后写变量；任一步失败都回滚已改的正文与变量。
  async function commit(draft, origin) {
    return enqueue(async () => {
      if (chatId() !== origin.聊天ID) return openingFailure(draft, '聊天已切换，本次开局草稿已作废');
      let list = messages(), first = list[0];
      if (!first || first.role !== 'assistant') return openingFailure(draft, '新聊天缺少开场白，不能在其它楼层上补开局');
      if (ownershipOf(first).正文指纹 !== origin.正文指纹) return openingFailure(draft, '开场白已改变，本次开局草稿已作废');

      const existing = recordOf(first);
      if (existing !== undefined) {
        const checked = validateRecord(existing, first, manifest);
        if (!checked.ok) { status.blocked({...checked, 楼号: 0}); return false; }
        session.openingPending = false;
        session.integrity = null;
        refresh();
        toastr.warning('第 0 楼已经有有效开局记录，本次重复提交未写入。', '世界树：开局已存在');
        return true;
      }
      if (list.length !== 1) return openingFailure(draft, '新聊天已有其它楼层，不能把开局写进第 0 楼');

      const prepared = draft.prepare();
      if (!prepared.ok) return openingFailure(draft, prepared.error?.说明 ?? '开局准备失败', prepared.error);

      let greeting = typeof prepared.greeting === 'string' ? prepared.greeting : '';
      let finalRecord = prepared.record;
      let taskKind = '开场命令';

      if (prepared.mode && prepared.mode !== '预设') {
        if (prepared.mode === '自动生成' || prepared.mode === '提示扩写') {
          if (typeof generateOpening !== 'function') {
            return openingFailure(draft, '当前环境不支持自动生成开场白', {code: '开局.生成失败'});
          }
          try {
            greeting = await generateOpening({state: prepared.baseState, mode: prepared.mode, hint: prepared.greetingHint});
          } catch (error) {
            return openingFailure(draft, '生成开场白失败，原封面与草稿已保留',
              error?.code ? error : {code: '开局.生成失败', 说明: error?.message ?? String(error)});
          }
          if (typeof greeting !== 'string' || !greeting.trim()) {
            return openingFailure(draft, '叙事模型返回了空开场白，原封面与草稿已保留', {code: '开局.生成失败'});
          }
          greeting = greeting.trim();
        }
        // 生成后重新核对聊天与封面未被改动。
        list = messages(); first = list[0];
        if (chatId() !== origin.聊天ID || !first || first.role !== 'assistant'
          || ownershipOf(first).正文指纹 !== origin.正文指纹 || list.length !== 1 || recordOf(first) !== undefined) {
          return openingFailure(draft, '聊天或封面已变化，本次开局草稿已作废');
        }
        let keepRecord;
        try {
          keepRecord = bookkeeping() && typeof bookkeepOpening === 'function'
            ? await bookkeepOpening(prepared.baseState, greeting)
            : fromText(protocol, prepared.baseState, greeting);
        } catch (error) {
          return openingFailure(draft, '开场白记账失败，原封面与草稿已保留',
            error?.code ? error : {code: '记账.调用', 说明: error?.message ?? String(error)});
        }
        if (!keepRecord || keepRecord.stale || keepRecord.命令 === null) {
          const firstErr = keepRecord?.失败?.[0];
          return openingFailure(draft, '开场白记账未产生有效结果，原封面与草稿已保留',
            firstErr ? {code: firstErr.错误码 ?? '记账.调用', 说明: firstErr.说明} : {code: '记账.调用', 说明: '记账失败'});
        }
        taskKind = prepared.mode === '手写' ? '开场手写' : '开场生成';
        finalRecord = {
          本局: keepRecord.本局,
          命令: [...(prepared.baseCommands ?? []), ...(keepRecord.命令 ?? [])],
          失败: keepRecord.失败 ?? [],
          已写入: [...(prepared.baseWritten ?? []), ...(keepRecord.已写入 ?? [])],
          记账: {
            ...(keepRecord.记账 ?? {应答格式: '无', 状态: '成功', 尝试次数: 1}),
            方式: taskKind,
          },
        };
      }

      const originalGreeting = first.message ?? '';
      const updateGreeting = typeof updateOpeningMessage === 'function' ? updateOpeningMessage : writeOpeningGreeting;
      let updated = false;
      if (greeting && greeting !== originalGreeting) {
        try { updated = await updateGreeting(greeting, 0) !== false; }
        catch (error) { return openingFailure(draft, '同步第 0 楼开场白失败：' + (error?.message ?? error), error); }
        if (updated) session.openingSelfEdit = ownershipOf({message: greeting}).正文指纹;
      }

      // 最后一次检查放在正文同步之后、变量写入之前；正文指纹按同步后的文本或原文本核对。
      list = messages(); first = list[0];
      const expected = updated ? session.openingSelfEdit : origin.正文指纹;
      if (chatId() !== origin.聊天ID || !first || first.role !== 'assistant'
        || ownershipOf(first).正文指纹 !== expected) return openingFailure(draft, '聊天或开场白已变化，本次开局草稿已作废');
      if (recordOf(first) !== undefined) return openingFailure(draft, '第 0 楼已经出现记录，本次开局草稿已作废');

      // 任务在第 0 楼正文定稿后生成，正文指纹与写入内容一致；后再写入记录。
      const task = taskFor(0, taskKind);
      const original = structuredClone(getVariables({type: 'message', message_id: 0}));
      try {
        const written = await store(0, finalRecord, task);
        if (!written) throw new Error('开场记录写入前，聊天或正文已经变化');
        const checked = validateRecord(recordOf(messages()[0]), messages()[0], manifest);
        if (!checked.ok) throw new Error('开场记录写入后校验失败：' + checked.说明);
      } catch (error) {
        if (updated) {
          try {
            await updateGreeting(originalGreeting, 0);
            session.openingSelfEdit = origin.正文指纹;
          } catch (rollbackError) {
            return openingFailure(draft, '开局保存失败，且第 0 楼开场白回滚失败：' + rollbackError.message, error);
          }
        }
        try { await replaceVariables(original, {type: 'message', message_id: 0}); }
        catch (rollbackError) {
          return openingFailure(draft, '开局保存失败，且原变量回滚失败：' + rollbackError.message, error);
        }
        return openingFailure(draft, '开局保存失败，原变量已保留：' + error.message, error);
      }

      session.openingPending = false;
      session.integrity = null;
      refresh();
      toastr.success('第 0 楼已原子写入；开场命令、记录与路由均已就绪。', '世界树：开局完成');
      return true;
    });
  }

  function modal(node, options) {
    if (typeof SillyTavern.Popup !== 'function') return popup(node, options);
    const instance = new SillyTavern.Popup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});
    session.openingPopup = instance;
    return instance.show().finally(() => { if (session.openingPopup === instance) session.openingPopup = null; });
  }

  async function open() {
    const list = messages(), first = list[0];
    if (!first || first.role !== 'assistant') return status.pendingOpening('尚未开局：缺少开场白');
    if (recordOf(first) !== undefined) {
      session.integrity = null;
      session.openingPending = false;
      const auditResult = audit(list);
      if (!auditResult.ok) return status.blocked(auditResult);
      if (!session.openingOpen) toastr.info('本局已经开局；如需新选择，请新建聊天。', '世界树：开局已存在');
      refresh();
      return false;
    }
    if (list.length !== 1) return status.blocked({code: '记录.缺失', 说明: '第 0 楼缺少开局记录，后面的楼层不能越过缺口', 楼号: 0});
    session.openingPending = true;
    session.integrity = null;
    if (session.openingOpen) { status.renderFloors(); return false; }
    session.openingOpen = true;
    const draft = createOpeningDraft({protocol, catalog, decl, defaults, commands, openingSpec});
    const origin = {聊天ID: chatId(), 正文指纹: ownershipOf(first).正文指纹};
    try {
      await modal(nodeOf(draft), {
        wide: true, large: true, okButton: '提交开局', cancelButton: '取消',
        onClosing: async dialog => {
          if (session.openingClosingForChat) return true;
          const affirmative = SillyTavern.POPUP_RESULT?.AFFIRMATIVE ?? 1;
          if (dialog?.result !== affirmative) {
            status.pendingOpening('已取消，可从“世界树：开局”重新打开');
            toastr.info('尚未开局；没有执行开场命令、创建记录或发送叙事请求。', '世界树：已取消开局');
            return true;
          }
          return commit(draft, origin);
        },
        onClose: () => {
          session.openingOpen = false;
          if (session.openingPending) status.renderFloors();
        },
      });
    } catch (error) {
      openingFailure(draft, '开局界面失败：' + error.message, error);
    } finally {
      session.openingOpen = false;
      if (session.openingPending) status.renderFloors();
    }
    return false;
  }

  return {open};
}
