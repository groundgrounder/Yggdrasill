// 一次性原型：在酒馆助手的脚本 iframe 中运行内核。每轮生成前路由并注入上下文；收到回复后得到这一楼的命令，经协议写入，
// 连同命令存进该楼该 swipe 的楼层变量，重算时照存下的命令重放。命令有两种来源：记账（另调一次模型填 JSON，见 bookkeeper.mjs），
// 或旧方式由叙事模型在正文末尾写 <命令>。开场命令由卡面的独立列表给出，只在新聊天第 0 楼执行。每楼下方显示这一楼记了什么（见 view.mjs），不进提示词。
// 依赖酒馆助手注入 iframe 的全局：getChatMessages、getLastMessageId、getVariables、replaceVariables、injectPrompts、uninjectPrompts、
// eventOn、tavern_events、getButtonEvent、generateRaw、getModelList、getProxyPresetNames、retrieveDisplayedMessage、toastr、SillyTavern、
// 兼容阻断时用宿主 stopGeneration 或 triggerSlash('/stop') 真正中止生成；
// $（酒馆页面的 jQuery）。
import {readDeclarations, validateDeclarations} from '../../core/declarations.mjs';
import {loadWorldbook} from '../../core/catalog.mjs';
import {createProtocol, seal, ProtocolError} from '../../core/protocol.mjs';
import {createRouter, route, renderContext} from '../../core/router.mjs';
import {readSettings} from '../../core/settings.mjs';
import {applyCommands} from '../../core/commands.mjs';
import {parseYaml, stringifyYaml} from '../../core/yaml.mjs';
import {createMemFs, memPath} from './memfs.mjs';
import {createBookkeeper} from './bookkeeper.mjs';
import {createView} from './view.mjs';
import {installStyle, panelNode, textNode, floorNode, readOnlyNode, permissionNode, settingsNode, openingNode, openingStatusNode} from './ui.mjs';
import {createOpeningDraft} from './opening.mjs';
import {RECORD_KEY, RECORD_FORMAT, ownershipOf, swipeOf, validateRecord, replayRecord, sameSnapshot,
  sanitizeRaw, storedManifest} from './records.mjs';
import bundle from './bundle.generated.json' with {type: 'json'};

const KEY = RECORD_KEY, INJECT_ID = 'yggdrasill-context';
const REQUIRED_MANIFEST_FIELDS = ['卡ID', '卡版本', '程序版本', '记录格式', '程序指纹', '世界书哈希', '兼容程序'];
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateManifest(value) {
  if (!isMap(value)) throw new Error('构建清单缺失或不是映射');
  for (const field of REQUIRED_MANIFEST_FIELDS) if (!Object.hasOwn(value, field)) throw new Error(`构建清单缺少字段：${field}`);
  if (typeof value.卡ID !== 'string' || !value.卡ID || typeof value.卡版本 !== 'string' || !value.卡版本 || typeof value.程序版本 !== 'string' || !value.程序版本)
    throw new Error('构建清单的卡ID、卡版本或程序版本不合法');
  if (value.记录格式 !== RECORD_FORMAT) throw new Error(`不支持的记录格式：${value.记录格式}`);
  for (const field of ['程序指纹', '世界书哈希']) if (!/^[0-9a-f]{64}$/.test(value[field])) throw new Error(`构建清单 ${field} 不合法`);
  if (!Array.isArray(value.兼容程序) || !Array.isArray(value.世界书文件) || !Array.isArray(value.程序文件)) throw new Error('构建清单列表字段不合法');
  for (const item of [...value.世界书文件, ...value.程序文件]) {
    if (!isMap(item) || typeof item.路径 !== 'string' || !Number.isSafeInteger(item.长度) || item.长度 < 0 || !/^[0-9a-f]{64}$/.test(item.SHA256))
      throw new Error('构建清单文件条目不合法');
    const virtual = item.路径.startsWith('/项目/'), relative = virtual ? item.路径.slice('/项目/'.length) : item.路径;
    if ((!virtual && item.路径.startsWith('/')) || relative.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error(`构建清单路径逃逸：${item.路径}`);
  }
  const declared = value.世界书文件.map(item => item.路径).sort();
  const mounted = Object.keys(bundle.files).sort();
  if (JSON.stringify(declared) !== JSON.stringify(mounted)) throw new Error('内存世界书与构建清单文件列表不一致');
  return value;
}

const manifest = validateManifest(bundle.manifest);
const permissionIds = (() => {
  const value = bundle.权限;
  if (!isMap(value) || typeof value.脚本ID !== 'string' || typeof value.正则ID !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(value.脚本ID)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(value.正则ID))
    throw new Error('构建产物缺少脚本或局部正则标识');
  return value;
})();
if (!Array.isArray(bundle.openingCommands) || bundle.openingCommands.some(command => !isMap(command) || Object.keys(command).length !== 1))
  throw new Error('构建产物缺少合法的开场命令列表');

// ---------- 载入 ----------
const fs = createMemFs(bundle.files), path = memPath;
const read = await readDeclarations(bundle.root, {fs, path});
const compiled = validateDeclarations(read.raw);
const loaded = await loadWorldbook(bundle.root, {fs, path, decl: compiled.decl});
const loadErrors = [...read.issues, ...compiled.issues, ...loaded.issues].filter(item => item.级别 === '错误');
if (loadErrors.length) throw new Error(`世界书载入失败：${loadErrors.map(item => `${item.文件}：${item.说明}`).join('；')}`);
const settings = await readSettings(path.dirname(bundle.root), {fs, path, decl: compiled.decl});
const protocol = createProtocol({catalog: loaded.catalog, decl: compiled.decl});
const router = createRouter({catalog: loaded.catalog, decl: compiled.decl, protocol, settings, templates: bundle.templates});
// 记账时叙事模型不写命令，变量更新规则换成这段说明。
const NARRATOR_RULES = `# 本局\n\n本局的状态由系统另行记录。正文里不宣布数值或状态的改变，也不写 <命令>。\n“待登记”中的事件已经发生，按已发生的事实叙述；“候选”中的事件在剧情走到时自然写出，不强求。\n\n## 地点\n\n{{地点列表}}`;
const quietRouter = createRouter({catalog: loaded.catalog, decl: compiled.decl, protocol, settings, templates: {...bundle.templates, 变量更新规则: NARRATOR_RULES}});
const keeper = createBookkeeper({protocol, catalog: loaded.catalog, decl: compiled.decl});
const view = createView({protocol, catalog: loaded.catalog, decl: compiled.decl, keeper});

// ---------- 设置：存在酒馆的全局变量里，不随卡导出 ----------
// 调试关着时，玩家看不到候选、将到与已排除的事件，失败提示也不写细节（细节里可能有将到事件的ID）。
const SETTINGS_KEY = '世界树·记账';
// 应答格式取代旧的“结构化输出”开关；没有保存设置时默认走任意 OpenAI 兼容端点都可用的提示词 JSON。
const DEFAULTS = {方式: '同一模型', 应答格式: '提示词', 代理预设: '', 地址: '', 密钥: '', 模型: '', 来源: 'openai',
  温度: 0.2, 最大长度: 0, 尝试次数: 2, 每楼记录: true, 调试: false};
const keeperSettings = () => {
  const stored = getVariables({type: 'global'})?.[SETTINGS_KEY] ?? {};
  // 旧布尔键双向兼容；显式的新键放在最后，始终优先。
  const legacy = typeof stored.结构化输出 === 'boolean' ? {应答格式: stored.结构化输出 ? '结构化输出' : '提示词'} : {};
  return {...DEFAULTS, ...legacy, ...stored};
};
let settingsWrite = Promise.resolve(), settingsWriteError = null;
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
const sameSetting = (left, right) => Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
async function persistedKeeperSettings() {
  const headers = typeof SillyTavern.getRequestHeaders === 'function'
    ? SillyTavern.getRequestHeaders()
    : SillyTavern.getContext().getRequestHeaders();
  const response = await fetch('/api/settings/get', {method: 'POST', headers, cache: 'no-cache'});
  if (!response.ok) throw new Error(`读取酒馆设置失败：HTTP ${response.status}`);
  const body = await response.json(), saved = typeof body.settings === 'string' ? JSON.parse(body.settings) : body.settings;
  return saved?.extension_settings?.variables?.global?.[SETTINGS_KEY] ?? {};
}
// replaceVariables 先改页面内存，再交给酒馆的防抖保存。只有服务器读回完整补丁，关闭设置才可以完成。
async function waitForSettings(expected) {
  const deadline = Date.now() + 10000;
  let lastError = null;
  while (true) {
    try {
      const saved = await persistedKeeperSettings();
      if (Object.entries(expected).every(([key, value]) => sameSetting(saved[key], value))) return;
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) throw lastError ?? new Error('酒馆设置未在限定时间内保存完成');
    await wait(50);
  }
}
function saveSettings(patch) {
  const write = settingsWrite.then(async () => {
    settingsWriteError = null;
    const globals = getVariables({type: 'global'}) ?? {};
    const saved = {...(globals[SETTINGS_KEY] ?? {}), ...patch};
    await replaceVariables({...globals, [SETTINGS_KEY]: saved}, {type: 'global'});
  });
  settingsWrite = write.catch(error => { settingsWriteError = error; });
  return write;
}
async function flushSettings() {
  await settingsWrite;
  if (settingsWriteError) throw settingsWriteError;
  const globals = getVariables({type: 'global'}) ?? {};
  await waitForSettings(globals[SETTINGS_KEY] ?? {});
}
const bookkeeping = () => keeperSettings().方式 !== '关闭';
const debugging = () => keeperSettings().调试 === true;

// 权限只检查宿主实际暴露的状态：脚本若根本没执行，代码无从自检，只能靠导入说明与宿主拒绝提示。
const HOST_FUNCTIONS = ['getChatMessages', 'getLastMessageId', 'getVariables', 'replaceVariables', 'injectPrompts',
  'uninjectPrompts', 'eventOn', 'getButtonEvent', 'retrieveDisplayedMessage', 'getModelList'];
function hostMissing() {
  const missing = HOST_FUNCTIONS.filter(name => typeof globalThis[name] !== 'function');
  if (bookkeeping() && typeof globalThis.generateRaw !== 'function') missing.push('generateRaw');
  if (!isMap(globalThis.tavern_events)) missing.push('tavern_events');
  if (typeof globalThis.SillyTavern?.getContext !== 'function') missing.push('SillyTavern.getContext');
  if (typeof globalThis.$ !== 'function') missing.push('$');
  if (!isMap(globalThis.toastr)) missing.push('toastr');
  return missing;
}
const SCRIPT_HINT = '需要酒馆助手，并在角色设置中允许本卡脚本。脚本未执行时无法自检，只能由宿主拒绝提示。';
const REGEX_HINT = '关闭记账时正文命令由本卡局部正则隐藏：需要在酒馆中允许本卡局部正则，并保持启用。';
function permissionFailure() {
  const missing = hostMissing();
  if (missing.length) return {code: '权限.脚本', 说明: `宿主 API 不完整（缺少 ${missing.join('、')}）。${SCRIPT_HINT}`};
  const context = SillyTavern.getContext() ?? {};
  // 群聊或宿主没有暴露角色数组时无法核对卡内脚本；不据此误报权限不足。
  if (!Array.isArray(context.characters)) return null;
  const character = context.characters[context.characterId];
  if (!character) return {code: '权限.脚本', 说明: `无法读取当前角色卡。${SCRIPT_HINT}`};
  const extensions = character.data?.extensions ?? character.extensions ?? null;
  if (!isMap(extensions)) return {code: '权限.脚本', 说明: `当前角色卡没有扩展数据。${SCRIPT_HINT}`};
  const scripts = extensions.tavern_helper?.scripts;
  if (!Array.isArray(scripts)) return {code: '权限.脚本', 说明: `当前角色卡没有酒馆助手脚本。${SCRIPT_HINT}`};
  const script = scripts.find(item => item?.id === permissionIds.脚本ID);
  if (!script) return {code: '权限.脚本', 说明: `当前角色卡缺少世界树脚本（${permissionIds.脚本ID}）。${SCRIPT_HINT}`};
  if (script.enabled === false) return {code: '权限.脚本', 说明: `世界树脚本已停用。${SCRIPT_HINT}`};
  if (bookkeeping()) return null;
  const regexes = extensions.regex_scripts;
  if (!Array.isArray(regexes)) return {code: '权限.正则', 说明: `当前角色卡没有局部正则。${REGEX_HINT}`};
  const regex = regexes.find(item => item?.id === permissionIds.正则ID);
  if (!regex) return {code: '权限.正则', 说明: `当前角色卡缺少世界树局部正则（${permissionIds.正则ID}）。${REGEX_HINT}`};
  if (regex.disabled === true) return {code: '权限.正则', 说明: `世界树局部正则已停用。${REGEX_HINT}`};
  if (!Array.isArray(regex.placement) || !regex.placement.includes(2))
    return {code: '权限.正则', 说明: '世界树局部正则未作用于 AI 输出（placement 不含 2）。' + REGEX_HINT};
  const allowed = context.extensionSettings?.character_allowed_regex;
  if (!character.avatar || !Array.isArray(allowed) || !allowed.includes(character.avatar))
    return {code: '权限.正则', 说明: `当前角色卡未获准使用局部正则（character_allowed_regex）。${REGEX_HINT}`};
  return null;
}

// ---------- 楼层记录与任务身份 ----------
const messages = () => getLastMessageId() < 0 ? [] : getChatMessages('0-' + getLastMessageId());
const recordOf = message => message?.data?.[KEY];
const COMMAND_BLOCK = /<命令>\s*\n?([\s\S]*?)<\/命令>/g;
const stripCommands = text => text.replace(COMMAND_BLOCK, '').trim();
const failure = (阶段, 错误码, 说明, extra = {}) => ({阶段, 错误码, 说明: sanitizeRaw(String(说明 ?? '')), ...extra});

let integrity = null, permission = null, last = null, openingPending = false, openingOpen = false;
let openingPopup = null, openingClosingForChat = false;
let epoch = 0, taskSequence = 0;
const latestTask = new Map();

function chatId() {
  try {
    const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
    const value = context?.chatId ?? context?.chatMetadata?.chat_id
      ?? (typeof getCurrentChatId === 'function' ? getCurrentChatId() : undefined);
    return value === undefined || value === null || value === '' ? '未命名聊天' : String(value);
  } catch {
    return '未命名聊天';
  }
}

function invalidateTasks() {
  epoch += 1;
  latestTask.clear();
}

function taskFor(id, 类型) {
  const message = messages()[id];
  if (!message || message.role !== 'assistant') return null;
  const ownership = ownershipOf(message);
  const task = {任务ID: String(++taskSequence), 聊天ID: chatId(), ...ownership, 类型, 时代: epoch};
  latestTask.set(id, task.任务ID);
  return task;
}

function taskCurrent(task, checkLatest = true) {
  if (!task || task.时代 !== epoch || task.聊天ID !== chatId()) return false;
  const message = messages()[task.楼号];
  if (!message || message.role !== task.角色) return false;
  if (swipeOf(message) !== task.swipe) return false;
  if (ownershipOf(message).正文指纹 !== task.正文指纹) return false;
  return !checkLatest || latestTask.get(task.楼号) === task.任务ID;
}

// 整块解析失败时按顶层的“- ”逐条解析，一条写坏不连累同块的其它命令。
function parseBlock(body) {
  try {
    const value = parseYaml(body);
    if (value == null) return [];
    return Array.isArray(value) ? value.map(command => ({命令: command})) : [{错误: '命令块须为 YAML 列表'}];
  } catch {}
  const lines = body.split('\n');
  const indent = Math.min(...lines.filter(line => /^\s*- /.test(line)).map(line => line.search(/\S/)));
  if (!Number.isFinite(indent)) return [{错误: '命令块不是合法的 YAML，也没有以“- ”开头的条目'}];
  const items = [];
  for (const line of lines) {
    if (line.search(/\S/) === indent && line.slice(indent).startsWith('- ')) items.push([line.slice(indent)]);
    else if (items.length && line.trim()) items.at(-1).push(line.slice(Math.min(indent, line.search(/\S/))));
  }
  return items.map(item => {
    try {
      const value = parseYaml(item.join('\n'));
      if (Array.isArray(value) && value.length === 1) return {命令: value[0]};
    } catch (error) { return {错误: '不是合法的 YAML：' + error.message.split('\n')[0] + '（' + item[0].slice(0, 40) + '）'}; }
    return {错误: '不是一条命令（' + item[0].slice(0, 40) + '）'};
  });
}

function parseCommands(text) {
  return [...text.matchAll(COMMAND_BLOCK)].flatMap(match => parseBlock(match[1]
    .replace(/^\s*\u0060{3}[^\n]*\n/, '').replace(/\n\u0060{3}\s*$/, '')));
}

function execute(base, commands, extra = {}) {
  try {
    const result = applyCommands(protocol, base, commands);
    const failed = new Set((result.失败 ?? []).map(item => Number(item.序号) - 1));
    const failures = (result.失败 ?? []).map(item => failure('协议执行', item.错误码, item.说明,
      {...(Number.isSafeInteger(item.序号) ? {序号: item.序号} : {}), ...(item.命令 ? {命令: item.命令} : {})}));
    return {本局: result.state, 命令: commands.filter((command, index) => !failed.has(index)), 失败: failures,
      已写入: result.已写入, 命令数: commands.length, ...extra};
  } catch (error) {
    return {本局: base, 命令: null, 失败: [failure('执行', error.code ?? '执行.异常', error.message)],
      已写入: [], 命令数: Array.isArray(commands) ? commands.length : 0, ...extra};
  }
}

function bookkeepingMeta(方式, 应答格式, 状态, 尝试次数, extra = {}) {
  return {方式, 应答格式, 状态, 尝试次数, ...extra};
}

// 旧方式也写正式记录；解析失败项不进入可重放命令。没有任何合法命令且发生解析错误时，命令为 null。
function fromText(base, text) {
  const items = parseCommands(text), positions = [], commands = [], parseFailures = [];
  items.forEach((item, index) => {
    if (item.错误) parseFailures.push(failure('解析', '命令.解析', item.错误, {序号: index + 1, 命令: '解析'}));
    else { positions.push(index + 1); commands.push(item.命令); }
  });
  const record = execute(base, commands);
  record.失败 = [...parseFailures, ...record.失败.map(item => Number.isSafeInteger(item.序号)
    ? {...item, 序号: positions[item.序号 - 1]} : item)].sort((left, right) => (left.序号 ?? 0) - (right.序号 ?? 0));
  record.命令数 = items.length;
  if (parseFailures.length && !record.命令?.length) record.命令 = null;
  record.记账 = bookkeepingMeta('正文', '正文命令',
    record.命令 === null ? '解析失败' : record.失败.length ? '部分失败' : '成功', 1);
  return record;
}

function mergeFailures(...groups) {
  const seen = new Set(), result = [];
  for (const item of groups.flat()) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

function replayAt(base, record) {
  let replayed;
  try { replayed = replayRecord(record, base, (state, commands) => applyCommands(protocol, state, commands)); }
  catch (error) {
    return {本局: base, 命令: null, 失败: mergeFailures(record.失败 ?? [], [failure('执行', error.code ?? '执行.异常', error.message)]),
      已写入: [], 记账: {...record.记账, 状态: '执行失败'}, replayFailed: true};
  }
  const failures = (replayed.失败 ?? []).map(item => failure('协议执行', item.错误码, item.说明,
    {...(Number.isSafeInteger(item.序号) ? {序号: item.序号} : {}), ...(item.命令 ? {命令: item.命令} : {})}));
  const allFailures = mergeFailures(record.失败 ?? [], failures);
  return {...record, 本局: replayed.state, 命令: replayed.commands, 失败: allFailures, 已写入: replayed.已写入,
    ...(failures.length ? {记账: {...record.记账, 状态: '部分失败'}} : {}), replayFailed: failures.length > 0};
}

// 所有已有助手楼的记录结构都必须兼容；快照是否相同由载入审计单独核对。
function checkRecords(list, {from = 0, skip = null, shifted = false} = {}) {
  for (let id = from; id < list.length; id++) {
    const message = list[id];
    if (message.role !== 'assistant' || id === skip) continue;
    const stored = recordOf(message);
    // 删除前置楼层会让酒馆重排楼号；只在这个用户触发的传播入口核对正文、角色与 swipe，写入时换新楼号。
    const candidate = shifted && stored?.归属 && typeof stored.归属 === 'object'
      ? {...stored, 归属: {...stored.归属, 楼号: message.message_id}} : stored;
    const checked = validateRecord(candidate, message, manifest);
    if (!checked.ok) return {...checked, 楼号: id};
  }
  return {ok: true};
}

// 本楼正文已变化时，只在内存里把归属换成当前正文，先验证旧记录仍属于兼容格式；不补字段、不迁移。
function checkChangedAssistant(message) {
  const stored = recordOf(message);
  if (stored === undefined) return {ok: true};
  if (!stored?.归属 || typeof stored.归属 !== 'object') return validateRecord(stored, message, manifest);
  return validateRecord({...stored, 归属: ownershipOf(message)}, message, manifest);
}

// 载入只读校验：第 0 楼是已封卷的选择结果，作为本局根；后续楼逐楼重放并比对快照。
// 不同聊天可以选择不同开局，不能再拿卡面默认封卷去重放每一份第 0 楼记录。
function auditHistory(list, {end = list.length, skip = null, ignoreOwnership = null} = {}) {
  let state = null;
  for (let id = 0; id < end; id++) {
    const message = list[id];
    if (message.role !== 'assistant' || id === skip) continue;
    const record = recordOf(message);
    const candidate = id === ignoreOwnership && record?.归属 && typeof record.归属 === 'object'
      ? {...record, 归属: ownershipOf(message)} : record;
    const checked = validateRecord(candidate, message, manifest);
    if (!checked.ok) return {...checked, 楼号: id};
    if (id === 0) {
      if (candidate.本局?.开局?.已封卷 !== true)
        return {ok: false, code: '开局.封卷', 说明: '第 0 楼没有已封卷的开局设定', 楼号: 0};
      let replayed;
      try {
        const opening = candidate.本局.开局;
        const seeded = protocol.seal({开局时间: opening.开局时间, 角色组: opening.角色组, 玩家: opening.玩家,
          历史选择: opening.历史选择, ...(opening.方案 ? {方案: opening.方案} : {})});
        replayed = replayRecord(candidate, seeded, (base, commands) => applyCommands(protocol, base, commands));
        protocol.createReadView(candidate.本局);
      } catch (error) {
        return {ok: false, code: error.code ?? '开局.封卷', 说明: '第 0 楼不是可重放的已封卷本局：' + error.message, 楼号: 0};
      }
      if (replayed.失败.length) return {ok: false, code: '重放.命令', 说明: '第 0 楼保存的开场命令重放失败', 楼号: 0};
      if (!sameSnapshot(replayed.state, candidate.本局))
        return {ok: false, code: '重放.失配', 说明: '第 0 楼命令重放结果与保存的本局不一致', 楼号: 0};
      if (JSON.stringify(replayed.已写入) !== JSON.stringify(candidate.已写入))
        return {ok: false, code: '重放.写入', 说明: '第 0 楼开场命令写入摘要与记录不一致', 楼号: 0};
      state = candidate.本局;
      continue;
    }
    if (state === null) return {ok: false, code: '记录.缺失', 说明: '第 0 楼没有可用的开局记录', 楼号: 0};
    let replayed;
    try { replayed = replayRecord(candidate, state, (base, commands) => applyCommands(protocol, base, commands)); }
    catch (error) { return {ok: false, code: '重放.执行', 说明: error.message, 楼号: id}; }
    if (replayed.失败.length) return {ok: false, code: '重放.命令', 说明: '保存的成功命令在当前底本上执行失败', 楼号: id};
    if (!sameSnapshot(replayed.state, record.本局))
      return {ok: false, code: '重放.失配', 说明: '命令重放结果与保存的本局不一致', 楼号: id};
    if (JSON.stringify(replayed.已写入) !== JSON.stringify(record.已写入))
      return {ok: false, code: '重放.写入', 说明: '命令重放写入摘要与记录不一致', 楼号: id};
    state = record.本局;
  }
  return {ok: true, state};
}

function blocked(result) {
  openingPending = false;
  integrity = {code: result.code ?? '校验.失败', 说明: result.说明 ?? '楼层记录不可用', 楼号: result.楼号};
  last = {error: integrity.说明, code: integrity.code, floor: integrity.楼号};
  uninjectPrompts([INJECT_ID]);
  renderFloors();
  toastr.error(integrity.说明, '世界树：存档只读（' + integrity.code + '）');
  return false;
}

// 权限诊断自身可能运行在残缺宿主上：toast 缺失时保留控制台诊断，不把诊断变成新的异常。
function toastError(body, title) {
  try {
    if (typeof globalThis.toastr?.error === 'function') { globalThis.toastr.error(body, title); return; }
  } catch (error) { console.warn('世界树：toast 失败', error); }
  console.error(title + '：' + body);
}

function clearInjection() {
  if (typeof globalThis.uninjectPrompts !== 'function') return;
  try { globalThis.uninjectPrompts([INJECT_ID]); } catch (error) { console.warn('世界树：注入清理失败', error); }
}

function permissionBlocked(result) {
  const changed = !permission || permission.code !== result.code || permission.说明 !== result.说明;
  permission = {code: result.code ?? '权限.失败', 说明: result.说明 ?? '卡内脚本或局部正则未获准'};
  integrity = null;
  last = {error: permission.说明, code: permission.code, floor: null};
  clearInjection();
  try { renderFloors(); } catch (error) { console.warn('世界树：权限提示渲染失败', error); }
  if (changed) toastError(permission.说明, '世界树：权限不足（' + permission.code + '）');
  return false;
}

function checkPermission() {
  const denied = permissionFailure();
  if (denied) return permissionBlocked(denied);
  permission = null;
  return true;
}

function pendingOpening(reason = '尚未开局') {
  openingPending = true;
  integrity = null;
  last = {error: reason, code: '开局.未完成', floor: 0};
  uninjectPrompts([INJECT_ID]);
  renderFloors();
  return false;
}

async function stopHostGeneration(reason = '当前存档不可继续生成') {
  let stopped = false, error = null;
  try {
    if (typeof stopGeneration === 'function') stopped = stopGeneration();
    else if (typeof globalThis.stopGeneration === 'function') stopped = globalThis.stopGeneration();
    else if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext?.().stopGeneration === 'function')
      stopped = SillyTavern.getContext().stopGeneration();
    else if (typeof triggerSlash === 'function') {
      await triggerSlash('/stop');
      stopped = true;
    }
  } catch (caught) { error = caught; }
  if (stopped) toastError(reason + '；未发送叙事请求。', '世界树：已阻止生成');
  else toastError('宿主没有提供可用的 stopGeneration，生成可能继续。' + (error ? ' ' + error.message : ''),
    '世界树：宿主限制');
  return stopped;
}

async function store(id, record, task) {
  if (task && !taskCurrent(task)) return false;
  const list = messages(), message = list[id];
  if (message?.role !== 'assistant') throw new Error('只有助手楼可以写入正式记录');
  const stored = {
    记录格式: RECORD_FORMAT,
    运行清单: storedManifest(manifest),
    归属: ownershipOf(message),
    本局: record.本局,
    命令: record.命令,
    失败: record.失败 ?? [],
    已写入: record.已写入 ?? [],
    记账: record.记账,
  };
  const checked = validateRecord(stored, message, manifest);
  if (!checked.ok) throw new Error('写入前记录校验失败：' + checked.说明);
  const variables = getVariables({type: 'message', message_id: id});
  if (task && !taskCurrent(task)) return false;
  await replaceVariables({...variables, [KEY]: stored}, {type: 'message', message_id: id});
  if (task && !taskCurrent(task)) return false;
  return true;
}

// ---------- 记账 ----------
let keepingFloor = null, keeping = false;

// 另设模型时用设置里的连接；这些字段只用于请求，不进入楼层记录。
function customApi(config) {
  const connection = config.方式 !== '另设模型' ? {}
    : config.代理预设 ? {proxy_preset: config.代理预设} : {apiurl: config.地址, key: config.密钥};
  const extra = config.方式 === '另设模型' ? {model: config.模型, source: config.来源} : {};
  const temperature = Number(config.温度), length = Number(config.最大长度);
  return Object.fromEntries(Object.entries({...connection, ...extra, temperature: Number.isFinite(temperature) ? temperature : 0.2,
    ...(length > 0 ? {max_tokens: Math.round(length)} : {})}).filter(([, item]) => item !== '' && item !== undefined));
}

async function callKeeper({prompts, schema}, config) {
  const structured = config.应答格式 !== '提示词';
  const ordered = structured ? prompts : [{...prompts[0], content: prompts[0].content
    + '\n\n只输出一个 JSON 对象，不要其它文字。它须符合下面的 JSON Schema：\n' + JSON.stringify(schema.value)}, prompts[1]];
  keeping = true;
  uninjectPrompts([INJECT_ID]);
  try {
    return await generateRaw({ordered_prompts: ordered, should_stream: false,
      ...(structured ? {json_schema: schema} : {}), custom_api: customApi(config)});
  } finally { keeping = false; }
}

function parseJson(text) {
  if (typeof text !== 'string') throw new Error('模型没有返回文本');
  const body = text.replace(/^\s*\u0060{3}[^\n]*\n/, '').replace(/\n\u0060{3}\s*$/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('找不到 JSON 对象');
  return JSON.parse(body.slice(start, end + 1));
}

function keeperFailures(items) {
  return items.map(item => ({...item, 阶段: Number.isSafeInteger(item.序号) ? '协议执行' : '转换'}));
}

async function keepWith(base, {input, narration}, config, attempts, task) {
  let hint = '', outcome = null, raw = null, calls = 0, lastError = null, lastCode = '记账.调用', executor = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!taskCurrent(task)) return {stale: true};
    let text;
    try {
      text = await callKeeper(keeper.request(base, {input, narration, hint}), config);
      calls += 1;
    } catch (error) {
      calls += 1; lastError = error; lastCode = '记账.调用';
      hint = '上一次的记账调用失败：' + error.message;
      continue;
    }
    try { raw = parseJson(text); }
    catch (error) {
      lastError = error; lastCode = '记账.JSON';
      hint = '上一次的输出不是合法的 JSON：' + error.message;
      continue;
    }
    try { outcome = keeper.run(base, raw); }
    catch (error) {
      if (error?.code === '记账.JSON') {
        lastError = error; lastCode = '记账.JSON';
        hint = '上一次的输出不符合 JSON Schema：' + error.message;
        continue;
      }
      executor = error;
      break;
    }
    outcome.失败 = keeperFailures(outcome.失败 ?? []);
    const convertFailed = outcome.失败.some(item => item.阶段 === '转换');
    if (!convertFailed) break;
    hint = outcome.失败.map(item => '- ' + item.说明).join('\n');
  }
  const common = {方式: config.方式, 应答格式: config.应答格式, 尝试次数: calls, 重试: Math.max(0, calls - 1)};
  if (config.方式 === '另设模型' && config.模型) common.模型 = config.模型;
  if (debugging() && raw) common.原始结果 = sanitizeRaw(raw);
  if (executor) {
    return {本局: base, 命令: null, 失败: [failure('执行', executor.code ?? '执行.异常', executor.message)],
      已写入: [], 记账: bookkeepingMeta(config.方式, config.应答格式, '执行失败', calls, common)};
  }
  if (!outcome) {
    const code = lastCode, status = code === '记账.JSON' ? 'JSON失败' : '调用失败';
    const summary = sanitizeRaw(lastError?.message ?? '未知错误');
    return {本局: base, 命令: null, 失败: [failure('记账', code, summary)],
      已写入: [], 记账: bookkeepingMeta(config.方式, config.应答格式, status, calls, {...common, 错误摘要: summary})};
  }
  const status = outcome.失败.length ? '部分失败' : '成功';
  return {本局: outcome.state, 命令: outcome.commands, 失败: outcome.失败, 已写入: outcome.已写入,
    命令数: outcome.commands.length, 记账: bookkeepingMeta(config.方式, config.应答格式, status, calls, common)};
}

async function bookkeep(list, id, base, task) {
  const input = [...list.slice(0, id)].reverse().find(message => message.role === 'user')?.message ?? '';
  const narration = stripCommands(list[id].message ?? '');
  const config = keeperSettings(), attempts = Math.min(3, Math.max(1, Math.round(Number(config.尝试次数) || 2)));
  keepingFloor = id;
  renderFloors();
  try { return await keepWith(base, {input, narration}, config, attempts, task); }
  finally { keepingFloor = null; }
}

// ---------- 重放、编辑与删除后的传播 ----------
async function replayFrom(from, base, {fresh = false, kind = '重放', shifted = false} = {}) {
  let state = base, list = messages();
  for (let id = Math.max(0, from); id < list.length; id++) {
    const message = list[id];
    if (message.role !== 'assistant') continue;
    const task = taskFor(id, fresh && id === from ? kind : '重放');
    if (!task) break;
    let record;
    if (fresh && id === from) {
      if (id === 0) return blocked({code: '开场.重复', 说明: '第 0 楼不会重新执行开场命令', 楼号: id});
      record = bookkeeping()
        ? await bookkeep(list, id, state, task)
        : fromText(state, message.message ?? '');
    } else {
      const stored = recordOf(message);
      const candidate = shifted && stored?.归属 && typeof stored.归属 === 'object'
        ? {...stored, 归属: {...stored.归属, 楼号: message.message_id}} : stored;
      const checked = validateRecord(candidate, message, manifest);
      if (!checked.ok) return blocked({...checked, 楼号: id});
      record = replayAt(state, candidate);
    }
    if (record.stale || !taskCurrent(task)) return false;
    await store(id, record, task);
    state = record.本局;
    if (record.失败?.length) {
      const plain = debugging() || record.失败.every(item => item.错误码 === '记账.调用' || item.错误码 === '记账.JSON');
      toastr.warning(plain ? record.失败.map(item => (item.命令 ?? '记账') + '：' + item.说明).join('<br>')
        : '可在这一楼下方重新记账', '世界树：第 ' + id + ' 楼有 ' + record.失败.length + ' 项没记上');
    } else if (fresh && id === from && record.记账 && record.已写入.length && !keeperSettings().每楼记录) {
      toastr.success(record.已写入.join('、'), '世界树：第 ' + id + ' 楼已记账');
    }
    if (record.replayFailed) return blocked({code: '重放.下游失效', 说明: '第 ' + id + ' 楼重放时有命令失败，已保留部分状态', 楼号: id});
    list = messages();
  }
  return true;
}

// ---------- 注入 ----------
const placeOf = state => {
  const place = state?.世界?.当前地点;
  return place ? place.地标 + (place.场景 ? '·' + place.场景 : '') : '未写';
};

function failureNote(record) {
  if (!record?.失败?.length) return '';
  const lines = record.失败.map(item => '- 第 ' + (item.序号 ?? '?') + ' 条 ' + (item.命令 ?? '') + '：' + item.错误码 + ' ' + item.说明);
  const now = '本局现在的当前时间是 ' + (record.本局?.世界?.当前时间 ?? '未写') + '，当前地点是 ' + placeOf(record.本局) + '。';
  return '<上一轮命令>\n上一轮回复中下列命令没有执行，其余命令已执行。' + now
    + '上一轮正文已经推进的，在本轮按协议重写对应的命令。\n' + lines.join('\n') + '\n</上一轮命令>\n\n';
}

function reminder(state, quiet) {
  const now = '本局的当前时间是 ' + (state.世界?.当前时间 ?? '未写') + '，当前地点是 ' + placeOf(state) + '。';
  return '\n\n<本轮提醒>\n' + now + (quiet ? ''
    : '本轮正文里时间推进、换场、有人来去或候选事件发生时，回复末尾必须写 <命令>；时间过了多久就写到那一刻。') + '\n</本轮提醒>';
}

function refresh({exclude = null} = {}) {
  if (!checkPermission()) return false;
  if (openingPending) {
    uninjectPrompts([INJECT_ID]);
    renderFloors();
    return false;
  }
  if (integrity) {
    uninjectPrompts([INJECT_ID]);
    renderFloors();
    return false;
  }
  const all = messages(), list = all.filter(message => message.message_id !== exclude);
  const end = exclude ?? all.length;
  const audit = auditHistory(all, {end, skip: exclude});
  if (!audit.ok) return blocked(audit);
  try {
    const state = audit.state;
    const texts = list.filter(message => message.role !== 'system').map(message => stripCommands(message.message ?? ''));
    const quiet = bookkeeping();
    const {context, audit: routed} = route(quiet ? quietRouter : router, state, texts);
    const baseMessage = [...all.slice(0, end)].reverse().find(message => message.role === 'assistant');
    const baseRecord = baseMessage ? recordOf(baseMessage) : null;
    const content = (quiet ? '' : failureNote(baseRecord)) + renderContext(context) + reminder(state, quiet);
    injectPrompts([{id: INJECT_ID, position: 'in_chat', depth: 1, role: 'system', content}]);
    last = {content, audit: routed, exclude, state, 基于: exclude === null ? '楼层记录' : '前楼可信记录'};
  } catch (error) {
    return blocked({code: error instanceof ProtocolError ? error.code : '路由.失败', 说明: error.message, 楼号: null});
  }
  renderFloors();
  return true;
}

// ---------- 每楼一行与只读错误 ----------
function renderFloors() {
  if (typeof globalThis.$ !== 'function') return;
  $('#chat .ygg-floor').remove();
  if (permission) {
    const id = messages().at(-1)?.message_id;
    const node = permissionNode('权限不足：' + permission.说明 + '\n原因：' + permission.code
      + '\n原始聊天与楼层变量未被改写；恢复权限后重新生成即可继续。');
    if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
    return;
  }
  if (openingPending) {
    const id = messages()[0]?.message_id, node = openingStatusNode({open: openOpening,
      reason: last?.error?.startsWith('已取消') ? '上一次开局已取消，选择仍可重新打开。' : '请先打开开局并确认。'});
    if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
    return;
  }
  if (integrity) {
    const id = Number.isSafeInteger(integrity.楼号) ? integrity.楼号 : messages().at(-1)?.message_id;
    const node = readOnlyNode('存档只读：' + integrity.说明,
      ['原因：' + integrity.code, '原始楼层变量保持不变；不会自动迁移、补记账、提交命令或继续生成。',
       '继续游玩请新建兼容聊天，或切换到合法的聊天。'].join('\n'));
    if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
    return;
  }
  if (!keeperSettings().每楼记录) return;
  const verbose = debugging(), rekeep = bookkeeping();
  let before = null;
  for (const message of messages()) {
    const id = message.message_id;
    if (id === keepingFloor) { attachFloor(id, floorNode(null, {pending: true})); continue; }
    if (message.role !== 'assistant') continue;
    const record = recordOf(message);
    if (!validateRecord(record, message, manifest).ok) continue;
    try {
      if (id === 0) before = {世界: {当前时间: record.本局?.世界?.当前时间, 剧情标记: record.本局?.世界?.剧情标记 ?? {}},
        开局: record.本局?.开局 ?? {}, 角色: {}, 事件: {}, 待定项: []};
      if (before === null) continue;
      const line = view.floor(before, record.本局, record, {debug: verbose});
      const again = rekeep && id > 0 ? () => enqueue(async () => {
        invalidateTasks();
        const list = messages(), prefix = auditHistory(list, {end: id});
        if (!prefix.ok) return blocked(prefix);
        if (await replayFrom(id, prefix.state, {fresh: true, kind: '重新记账'})) refresh();
      }) : null;
      attachFloor(id, floorNode(line, {rekeep: again}));
      before = record.本局;
    } catch (error) { console.warn('世界树：每楼记录', error); }
  }
}

function attachFloor(id, node) {
  const box = retrieveDisplayedMessage(id);
  if (box.length) box.after(node); else $('#chat').append(node);
}

// ---------- 队列与事件 ----------
let queue = Promise.resolve();
const enqueue = job => {
  const run = queue.then(job);
  queue = run.catch(error => {
    toastr.error(error.message, '世界树：任务失败');
    blocked({code: '提交.失败', 说明: error.message});
  });
  return run;
};

eventOn(tavern_events.GENERATION_AFTER_COMMANDS, async (type, options, dryRun) => {
  // 酒馆助手的 generateRaw 在记账中发 GENERATION_AFTER_COMMANDS，参数是空对象；它必须立即返回，避免等自己。
  // 酒馆按钮触发的正常生成参数非空，即使记账仍在进行也要等队列完成。
  if (dryRun || (keeping && options && typeof options === 'object' && Object.keys(options).length === 0)) return;
  await queue;
  const denied = permissionFailure();
  if (denied) {
    permissionBlocked(denied);
    await stopHostGeneration('权限不足：' + denied.说明);
    return;
  }
  permission = null;
  if (openingPending) {
    uninjectPrompts([INJECT_ID]);
    renderFloors();
    await stopHostGeneration('尚未开局');
    return;
  }
  if (integrity) { uninjectPrompts([INJECT_ID]); await stopHostGeneration(); return; }
  invalidateTasks();
  const list = messages(), tail = list.at(-1);
  const replacing = ['swipe', 'regenerate', 'continue'].includes(type) && tail?.role === 'assistant';
  const ok = refresh({exclude: replacing ? tail.message_id : null});
  if (!ok || integrity) await stopHostGeneration();
});

eventOn(tavern_events.MESSAGE_SENT, () => {
  invalidateTasks();
  if (openingPending) { uninjectPrompts([INJECT_ID]); renderFloors(); return; }
  return refresh();
});

eventOn(tavern_events.MESSAGE_RECEIVED, (id, type) => {
  invalidateTasks();
  return enqueue(async () => {
  if (integrity) return renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (message?.role !== 'assistant') return refresh();
  // 新聊天的开场白也会发 first_message 的“收到消息”事件；它由 init 写入开场命令记录，不是叙事模型新写的助手楼。
  if (number === 0 && type === 'first_message') return init();
  if (openingPending) return renderFloors();
  const prefix = auditHistory(list, {end: number});
  if (!prefix.ok) return blocked(prefix);
  const stored = recordOf(message);
  // 酒馆会给新助手楼继承上一楼的变量；归属仍在旧楼时，它只是副本，不能当作本楼旧记录审计。
  if (stored !== undefined && stored?.归属?.楼号 === number) {
    const oldChain = auditHistory(list, {ignoreOwnership: number});
    if (!oldChain.ok) return blocked(oldChain);
  }
  const downstream = checkRecords(list, {from: number + 1});
  if (!downstream.ok) return blocked(downstream);
  const changed = checkChangedAssistant(message);
  if (!changed.ok) return blocked({...changed, 楼号: number});
  if (!(await replayFrom(number, prefix.state, {fresh: true, kind: '新正文'}))) return;
  refresh();
  });
});

eventOn(tavern_events.MESSAGE_EDITED, id => {
  invalidateTasks();
  return enqueue(async () => {
  if (integrity) return renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (!message || message.role === 'system') return refresh();
  if (openingPending) return renderFloors();
  const prefix = auditHistory(list, {end: number});
  if (!prefix.ok) return blocked(prefix);
  if (message.role === 'user') {
    const full = auditHistory(list);
    if (!full.ok) return blocked(full);
    const downstream = checkRecords(list, {from: number + 1});
    if (!downstream.ok) return blocked(downstream);
    if (await replayFrom(number + 1, prefix.state, {kind: '编辑玩家楼后重放'})) refresh();
  } else {
    if (recordOf(message) !== undefined) {
      const oldChain = auditHistory(list, {ignoreOwnership: number});
      if (!oldChain.ok) return blocked(oldChain);
    }
    const downstream = checkRecords(list, {from: number + 1});
    if (!downstream.ok) return blocked(downstream);
    const changed = checkChangedAssistant(message);
    if (!changed.ok) return blocked({...changed, 楼号: number});
    if (await replayFrom(number, prefix.state, {fresh: true, kind: '编辑助手楼后记账'})) refresh();
  }
  });
});

eventOn(tavern_events.MESSAGE_SWIPED, id => {
  invalidateTasks();
  return enqueue(async () => {
  if (integrity) return renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (openingPending) return renderFloors();
  const prefix = auditHistory(list, {end: number});
  if (!prefix.ok) return blocked(prefix);
  if (message?.role !== 'assistant') return refresh();
  if (!message.message) {
    if (list.slice(number + 1).some(item => item.role === 'assistant'))
      return blocked({code: '记录.当前 swipe', 说明: '空 swipe 后面还有助手楼，不能跳过它作答', 楼号: number});
    refresh({exclude: number});
    return;
  }
  const checked = validateRecord(recordOf(message), message, manifest);
  if (!checked.ok) return blocked({...checked, 楼号: number});
  const all = checkRecords(list);
  if (!all.ok) return blocked(all);
  if (await replayFrom(number, prefix.state, {kind: '切换 swipe 重放'})) refresh();
  });
});

// 删除事件只带新长度。从第 0 楼起用保留楼层的成功命令重放，不能只刷新显示。
eventOn(tavern_events.MESSAGE_DELETED, () => {
  invalidateTasks();
  return enqueue(async () => {
  if (integrity) return renderFloors();
  if (openingPending) return renderFloors();
  const list = messages(), checked = checkRecords(list, {shifted: true});
  if (!checked.ok) return blocked(checked);
  const opening = list[0]?.role === 'assistant' ? recordOf(list[0]) : null;
  const root = validateRecord(opening, list[0], manifest);
  if (!root.ok) return blocked({...root, 楼号: 0});
  if (await replayFrom(1, opening.本局, {kind: '删除楼层后传播', shifted: true})) refresh();
  });
});

eventOn(tavern_events.CHAT_CHANGED, () => {
  invalidateTasks();
  return enqueue(async () => {
  if (openingPopup) {
    openingClosingForChat = true;
    try { await openingPopup.completeCancelled(); } catch {}
    openingClosingForChat = false;
    openingPopup = null;
  }
  integrity = null; permission = null; last = null; keepingFloor = null; openingPending = false; openingOpen = false;
  await init();
  });
});

let redraw = null;
const scheduleFloors = () => { clearTimeout(redraw); redraw = setTimeout(renderFloors, 50); };
for (const type of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED'])
  if (tavern_events[type]) eventOn(tavern_events[type], scheduleFloors);

async function init() {
  if (!checkPermission()) return;
  const list = messages();
  if (!list.length) { pendingOpening('尚未开局：等待开场白'); return; }
  const opening = list[0];
  if (opening.role === 'assistant' && !recordOf(opening)) {
    // 新聊天只有开场白时先交给开局前端；确认并成功写第 0 楼之前不执行开场命令。
    if (list.length !== 1) return blocked({code: '记录.缺失', 说明: '第 0 楼缺少正式记录，后面的楼层不能越过缺口', 楼号: 0});
    openingPending = true;
    integrity = null;
    uninjectPrompts([INJECT_ID]);
    renderFloors();
    void openOpening();
    return;
  }
  openingPending = false;
  const audit = auditHistory(list);
  if (!audit.ok) return blocked(audit);
  refresh();
}

// ---------- 按钮 ----------
const popup = (node, options = {wide: true, large: true}) => SillyTavern.callGenericPopup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});
const openingModal = (node, options) => {
  if (typeof SillyTavern.Popup !== 'function') return popup(node, options);
  const instance = new SillyTavern.Popup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});
  openingPopup = instance;
  return instance.show().finally(() => { if (openingPopup === instance) openingPopup = null; });
};
const show = (title, text) => popup(textNode(title, text));
const showSections = (title, sections) => popup(panelNode(title, sections));
const showBlocked = () => showSections('存档不可用（只读）', [{标题: '世界树', 展开: true,
  行: [integrity.说明, '错误码：' + integrity.code + (Number.isSafeInteger(integrity.楼号) ? '，楼号：' + integrity.楼号 : ''),
    '原始变量保持不变；不会自动迁移、补记账、提交命令或继续生成。']}]);

function openingFailure(draft, message, error = null) {
  const failure = error ? {code: error.code ?? '开局.失败', 说明: error.说明 ?? error.message ?? String(error)}
    : {code: '开局.失败', 说明: message};
  draft.fail(failure);
  pendingOpening(message);
  toastr.error(failure.说明, '世界树：无法开局');
  return false;
}

async function commitOpening(draft, session) {
  return enqueue(async () => {
    if (chatId() !== session.聊天ID) return openingFailure(draft, '聊天已切换，本次开局草稿已作废');
    let list = messages(), first = list[0];
    if (!first || first.role !== 'assistant') return openingFailure(draft, '新聊天缺少开场白，不能在其它楼层上补开局');
    if (ownershipOf(first).正文指纹 !== session.正文指纹) return openingFailure(draft, '开场白已改变，本次开局草稿已作废');

    const existing = recordOf(first);
    if (existing !== undefined) {
      const checked = validateRecord(existing, first, manifest);
      if (!checked.ok) { blocked({...checked, 楼号: 0}); return false; }
      openingPending = false;
      integrity = null;
      refresh();
      toastr.warning('第 0 楼已经有有效开局记录，本次重复提交未写入。', '世界树：开局已存在');
      return true;
    }
    if (list.length !== 1) return openingFailure(draft, '新聊天已有其它楼层，不能把开局写进第 0 楼');

    const task = taskFor(0, '开场命令');
    const prepared = draft.prepare();
    if (!prepared.ok) return openingFailure(draft, prepared.error?.说明 ?? '开局准备失败', prepared.error);

    // 最后一次检查放在完整封卷与命令执行之后、变量写入之前，避免并发提交覆盖。
    list = messages(); first = list[0];
    if (chatId() !== session.聊天ID || !first || first.role !== 'assistant'
      || ownershipOf(first).正文指纹 !== session.正文指纹) return openingFailure(draft, '聊天或开场白已变化，本次开局草稿已作废');
    if (recordOf(first) !== undefined) return openingFailure(draft, '第 0 楼已经出现记录，本次开局草稿已作废');

    const original = structuredClone(getVariables({type: 'message', message_id: 0}));
    try {
      const written = await store(0, prepared.record, task);
      if (!written) throw new Error('开场记录写入前，聊天或正文已经变化');
      const checked = validateRecord(recordOf(messages()[0]), messages()[0], manifest);
      if (!checked.ok) throw new Error('开场记录写入后校验失败：' + checked.说明);
    } catch (error) {
      try { await replaceVariables(original, {type: 'message', message_id: 0}); }
      catch (rollbackError) {
        return openingFailure(draft, '开局保存失败，且原变量回滚失败：' + rollbackError.message, error);
      }
      return openingFailure(draft, '开局保存失败，原变量已保留：' + error.message, error);
    }

    openingPending = false;
    integrity = null;
    refresh();
    toastr.success('第 0 楼已原子写入；开场命令、记录与路由均已就绪。', '世界树：开局完成');
    return true;
  });
}

async function openOpening() {
  const list = messages(), first = list[0];
  if (!first || first.role !== 'assistant') return pendingOpening('尚未开局：缺少开场白');
  if (recordOf(first) !== undefined) {
    integrity = null;
    openingPending = false;
    const audit = auditHistory(list);
    if (!audit.ok) return blocked(audit);
    if (!openingOpen) toastr.info('本局已经开局；如需新选择，请新建聊天。', '世界树：开局已存在');
    refresh();
    return false;
  }
  if (list.length !== 1) return blocked({code: '记录.缺失', 说明: '第 0 楼缺少开局记录，后面的楼层不能越过缺口', 楼号: 0});
  openingPending = true;
  integrity = null;
  if (openingOpen) { renderFloors(); return false; }
  openingOpen = true;
  const draft = createOpeningDraft({protocol, catalog: loaded.catalog, decl: compiled.decl,
    defaults: bundle.opening, commands: bundle.openingCommands});
  const session = {聊天ID: chatId(), 正文指纹: ownershipOf(first).正文指纹};
  const node = openingNode(draft);
  try {
    await openingModal(node, {
      wide: true, large: true, okButton: '提交开局', cancelButton: '取消',
      onClosing: async dialog => {
        if (openingClosingForChat) return true;
        const affirmative = SillyTavern.POPUP_RESULT?.AFFIRMATIVE ?? 1;
        if (dialog?.result !== affirmative) {
          pendingOpening('已取消，可从“世界树：开局”重新打开');
          toastr.info('尚未开局；没有执行开场命令、创建记录或发送叙事请求。', '世界树：已取消开局');
          return true;
        }
        return commitOpening(draft, session);
      },
      onClose: () => {
        openingOpen = false;
        if (openingPending) renderFloors();
      },
    });
  } catch (error) {
    openingFailure(draft, '开局界面失败：' + error.message, error);
  } finally {
    openingOpen = false;
    if (openingPending) renderFloors();
  }
  return false;
}

eventOn(getButtonEvent('世界树：开局'), () => openOpening());

eventOn(getButtonEvent('世界树：本轮上下文'), () => {
  if (openingPending) return show('尚未开局', '请先完成开局。确认前不会创建本局或注入叙事上下文。');
  if (integrity) return showBlocked();
  if (!debugging()) return show('本轮上下文', '本轮上下文中有尚未发生的事件。要看，先在“世界树：设置”中打开调试。');
  if (!last || last.error) refresh();
  if (last?.error) return show('本轮上下文', '路由失败：' + last.error);
  show('本轮上下文（' + [...last.content].length + ' 字符，基于' + last.基于 + '）',
    last.content + '\n\n===== 审计 =====\n' + stringifyYaml(last.audit));
});
eventOn(getButtonEvent('世界树：本局'), () => {
  if (openingPending) return show('尚未开局', '请先完成开局。确认前没有可显示的本局记录。');
  if (integrity) return showBlocked();
  const state = last?.state ?? seal(protocol, bundle.opening);
  if (!debugging()) return showSections('本局', view.player(state));
  const floors = messages().map(message => ({楼号: message.message_id, 角色: message.role, 记录: recordOf(message)}))
    .filter(item => item.角色 === 'assistant' && validateRecord(item.记录, messages()[item.楼号], manifest).ok);
  showSections('本局（调试）', view.debug(state, floors));
});
eventOn(getButtonEvent('世界树：重新记账'), () => enqueue(async () => {
  if (openingPending) return toastr.warning('尚未开局，没有可以记账的楼', '世界树');
  if (integrity) return renderFloors();
  const id = [...messages()].reverse().find(message => message.role === 'assistant' && message.message_id > 0)?.message_id;
  if (id === undefined) return toastr.warning('没有可以记账的楼', '世界树');
  const list = messages(), prefix = auditHistory(list, {end: id});
  if (!prefix.ok) return blocked(prefix);
  const records = checkRecords(list, {from: id});
  if (!records.ok) return blocked(records);
  invalidateTasks();
  if (await replayFrom(id, prefix.state, {fresh: true, kind: '重新记账'})) refresh();
}));

async function pullModels(config) {
  if (config.代理预设) throw new Error('选了代理预设时拉不到列表：改为手动填写地址与密钥，或在酒馆的 API 连接里查看模型');
  if (!config.地址) throw new Error('先填 API 地址');
  const models = await getModelList({apiurl: config.地址, key: config.密钥});
  if (!models.length) throw new Error('没有拉到模型，检查地址与密钥');
  return models;
}

const PROBE = {name: '世界树记账测试', strict: true,
  value: {type: 'object', properties: {回答: {type: 'string'}}, required: ['回答'], additionalProperties: false}};
const queued = job => new Promise((resolve, reject) => enqueue(() => job().then(resolve, reject)));
async function testKeeper(config) {
  if (config.方式 === '关闭') throw new Error('记账已关闭');
  const prompts = [{role: 'system', content: '这是连接测试，只输出 JSON。'}, {role: 'user', content: '把“回答”填为“可以”。'}];
  const started = Date.now();
  const result = await queued(async () => { try { return parseJson(await callKeeper({prompts, schema: PROBE}, config)); } finally { refresh(); } });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return {文本: JSON.stringify(result) + '（' + seconds + ' 秒'
    + (config.方式 === '另设模型' && config.模型 ? '，' + config.模型 : '') + '）'};
}

eventOn(getButtonEvent('世界树：设置'), async () => {
  const current = keeperSettings();
  const names = typeof getProxyPresetNames === 'function' ? getProxyPresetNames() : [];
  const presets = [...new Set([...names.filter(name => name && name !== 'None'), current.代理预设].filter(Boolean))];
  let activeModel = '';
  try { activeModel = SillyTavern.getChatCompletionModel?.() ?? ''; } catch {}
  await popup(settingsNode({current, save: saveSettings, presets, activeModel, pull: pullModels, test: testKeeper}), {
    wide: true, large: false,
    onClosing: async () => {
      try { await flushSettings(); return true; }
      catch (error) { toastr.error(error.message, '世界树：设置未保存'); return false; }
    },
  });
  refresh();
});

installStyle();
await init();
toastr.success(loaded.catalog.groups.length + ' 角色组，' + loaded.catalog.events.length + ' 事件', '世界树原型已启动');
