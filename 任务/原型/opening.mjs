// 开局草稿：把卡面初值、方案与玩家改动整理成 seal 的输入，并在内存中预演或准备第 0 楼记录。
// 这里不处理历史求解、排斥检查或命令语义；这些仍由 protocol.seal 与 applyCommands 决定。
import {createCalendar} from '../../core/calendar.mjs';
import {applyCommands} from '../../core/commands.mjs';
import {parseYaml, stringifyYaml} from '../../core/yaml.mjs';

const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value ?? {}, key);
const clone = value => value === undefined ? undefined : structuredClone(value);
const FIELDS = ['开局时间', '方案', '角色组', '玩家', '历史选择'];
const MAP_FIELDS = new Set(['角色组', '历史选择']);

export function openingError(error) {
  return {code: error?.code ?? '开局.失败', 说明: String(error?.message ?? error ?? '未知错误')};
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
  else if (has(defaults, '方案')) input.方案 = clone(defaults.方案);

  for (const field of MAP_FIELDS) {
    const base = has(source, field) ? source[field] : has(defaults, field) ? defaults[field] : undefined;
    const patch = overrides[field];
    if (!isMap(base) || !isMap(patch)) {
      if (patch !== undefined) input[field] = clone(patch);
      continue;
    }
    input[field] = {...clone(base), ...clone(patch)};
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
// 开场命令按最终封卷的玩家调整：只从写场景的“在场”与“所在”里删掉扮演角色组，其余字段原样保留；
// 删空的映射整键省略，写场景因此变空则整条省略。其他命令与畸形命令不在此改写，仍交原校验。
export function adaptOpeningCommands(commands, player) {
  if (!Array.isArray(commands)) return commands;
  const roleplay = player?.模式 === '扮演' && typeof player.扮演角色组 === 'string' && player.扮演角色组
    ? player.扮演角色组 : null;
  const result = [];
  for (const command of commands) {
    if (!roleplay || !isMap(command) || Object.keys(command).length !== 1
      || !has(command, '写场景') || !isMap(command.写场景)) {
      result.push(clone(command));
      continue;
    }
    const scene = clone(command.写场景);
    let removed = false;
    for (const field of ['在场', '所在']) {
      if (!isMap(scene[field]) || !has(scene[field], roleplay)) continue;
      delete scene[field][roleplay];
      removed = true;
      if (!Object.keys(scene[field]).length) delete scene[field];
    }
    if (!removed) result.push(clone(command));
    else if (Object.keys(scene).length) result.push({写场景: scene});
  }
  return result;
}

// 最终封卷与全部开场命令成功后才生成记录草稿；任一条失败都返回失败，不暴露部分本局。
export function prepareOpeningRecord(protocol, input, commands) {
  let state;
  try { state = protocol.seal(input); }
  catch (error) { return {ok: false, 阶段: '封卷', error: openingError(error)}; }

  // 记录里保存实际执行的命令，重放才能得到同一状态。
  const adjusted = adaptOpeningCommands(commands, state.开局?.玩家);
  let executed;
  try { executed = applyCommands(protocol, state, adjusted); }
  catch (error) { return {ok: false, 阶段: '开场命令', error: openingError(error)}; }
  if (executed.失败?.length) {
    return {ok: false, 阶段: '开场命令', failures: clone(executed.失败),
      error: {code: '开场.命令', 说明: `有 ${executed.失败.length} 条开场命令未执行`}};
  }
  return {ok: true, record: {
    本局: executed.state,
    命令: clone(adjusted),
    失败: [],
    已写入: clone(executed.已写入 ?? []),
    记账: {方式: '开场命令', 应答格式: '无', 状态: '成功', 尝试次数: 1},
  }};
}

export function createOpeningDraft({protocol, catalog, decl, defaults = {}, commands = []}) {
  const calendar = createCalendar(decl.calendar);
  const plans = catalog.openingPlans ?? [];
  const planMap = new Map(plans.map(plan => [plan.id, plan]));
  const optionSource = catalog.openingOptions?.内容 ?? null;
  const freeCombination = optionSource?.自由组合 === true;
  const options = Array.isArray(optionSource?.选项) ? optionSource.选项 : [];
  let planId = has(defaults, '方案') && planMap.has(defaults.方案) ? defaults.方案 : null;
  let overrides = {}, failure = null, preview = null;
  // 玩家选择与档案草稿是同一份状态：文本框、预览与提交都读这里，切换模式或方案不另存副本。
  let playerMode = '自建', roleGroup = null, profileDraft = {}, profileText = '{}';
  let playerTouched = false, profileFailure = null;

  const planContent = () => planId ? planMap.get(planId)?.内容 ?? {} : {};
  const stateNow = () => preview?.state ?? null;
  const sourcePlayer = () => {
    const source = planContent(), base = has(source, '玩家') ? source.玩家 : defaults.玩家;
    return isMap(base) ? base : {模式: '自建', 档案: {}};
  };
  function playerNow() {
    if (playerMode === '扮演') return {模式: '扮演', ...(roleGroup ? {扮演角色组: roleGroup} : {})};
    return {模式: '自建', 档案: clone(profileDraft)};
  }
  // 未编辑玩家选择时，方案或卡面初值提供模式、扮演角色组与档案草稿；编辑过就保留用户的选择。
  function adoptSourcePlayer() {
    const source = sourcePlayer();
    playerMode = source.模式 === '扮演' ? '扮演' : '自建';
    roleGroup = playerMode === '扮演' ? source.扮演角色组 ?? null : null;
    profileDraft = isMap(source.档案) ? clone(source.档案) : {};
    profileText = stringifyYaml(profileDraft);
    profileFailure = null;
  }
  const inputNow = () => composeOpeningInput({defaults, plan: planId ? planMap.get(planId) : null,
    overrides: {...overrides, 玩家: playerNow()}});

  function groupNow(id) {
    const group = catalog.groups.find(item => item.id === id);
    if (!group) return null;
    const effective = stateNow()?.开局?.角色组?.[id] ?? {};
    const fromOverride = overrides.角色组?.[id] ?? {};
    const declared = group.内容 ?? {};
    return {
      id,
      显示名: declared.显示名 ?? id,
      分类: declared.分类 ?? '',
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

  function historyControls() {
    return options.map(item => ({
      事件ID: item.事件ID,
      问题: item.问题,
      值: historyNow(item.事件ID),
      分支: [...Object.entries(item.选项 ?? {}).map(([id, label]) => ({id, label: String(label)})),
        ...(has(item.选项 ?? {}, '未发生') ? [] : [{id: '未发生', label: '未发生'}])],
    }));
  }

  function previewNow() {
    const input = inputNow();
    const result = previewOpening(protocol, input);
    if (result.ok) { preview = result; failure = null; }
    else failure = result.error;
    return {...result, error: failure};
  }

  // 档案错误只属于自建玩家；扮演模式不提交这份档案，预览与提交不受旧错误阻断。
  function afterChange() {
    const result = previewNow();
    const blocked = playerMode === '自建' && profileFailure !== null;
    if (blocked) failure = profileFailure;
    return {...result, ok: !blocked && result.ok, error: failure};
  }

  function setPlan(id) {
    if (id && !planMap.has(id)) {
      failure = {code: '开局.方案', 说明: `开局方案不存在：${id}`};
      return {ok: false, error: failure};
    }
    planId = id || null;
    if (!playerTouched) adoptSourcePlayer();
    return afterChange();
  }

  function setTime(value) {
    overrides.开局时间 = String(value ?? '');
    return afterChange();
  }

  function setGroup(id, patch) {
    if (!catalog.groups.some(group => group.id === id) || !isMap(patch)) {
      failure = {code: '开局.角色组', 说明: `角色组选择不合法：${id}`};
      return {ok: false, error: failure};
    }
    overrides = {...overrides, 角色组: {...(overrides.角色组 ?? {}), [id]: {...(overrides.角色组?.[id] ?? {}), ...clone(patch)}}};
    return afterChange();
  }

  function setPlayerMode(mode) {
    if (!['自建', '扮演'].includes(mode)) {
      failure = {code: '开局.玩家', 说明: '玩家模式不合法'};
      return {ok: false, error: failure};
    }
    playerTouched = true;
    playerMode = mode;
    if (mode === '扮演' && !roleGroup)
      roleGroup = catalog.groups.map(group => groupNow(group.id)).find(group => group?.启用)?.id ?? null;
    return afterChange();
  }

  function setPlayerGroup(id) {
    if (id && !catalog.groups.some(group => group.id === id)) {
      failure = {code: '开局.玩家', 说明: `扮演角色组不存在：${id}`};
      return {ok: false, error: failure};
    }
    playerTouched = true;
    playerMode = '扮演';
    roleGroup = id || null;
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
      return {ok: false, error: failure};
    }
    if (!item || (branch && branch !== '未发生' && !has(item.选项 ?? {}, branch))) {
      failure = {code: '开局.历史选择', 说明: `历史选择无效：${eventID}`};
      return {ok: false, error: failure};
    }
    const next = {...(overrides.历史选择 ?? {})};
    if (branch) next[eventID] = branch; else delete next[eventID];
    overrides = {...overrides, 历史选择: next};
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
    setPlan, setTime, setGroup, setPlayerMode, setPlayerGroup, setProfileText, setHistory, fail,
    input: inputNow,
    prepare: () => playerMode === '自建' && profileFailure
      ? {ok: false, 阶段: '封卷', error: clone(profileFailure)}
      : prepareOpeningRecord(protocol, inputNow(), commands),
    snapshot: () => ({
      计划: plans.map(plan => ({id: plan.id, 概述: plan.内容?.概述 ?? '', 内容: clone(plan.内容 ?? {})})),
      方案: planId,
      时间: has(overrides, '开局时间') ? overrides.开局时间
        : stateNow()?.开局?.开局时间 ?? planContent().开局时间 ?? defaults.开局时间 ?? '',
      时间格式: calendar.pattern,
      方案内容: clone(planContent()),
      自由组合: freeCombination,
      角色组: catalog.groups.map(group => groupNow(group.id)).filter(Boolean),
      玩家: playerNow(),
      档案文本: profileText,
      历史: historyControls(),
      预览: stateNow() ? clone(stateNow()) : null,
      上次预览: preview ? clone(preview.state) : null,
      错误: failure ? clone(failure) : null,
    }),
  };
}
