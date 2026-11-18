// 记账设置与宿主权限自检：设置存在酒馆的全局变量里，不随卡导出；权限只检查宿主实际暴露的状态。
// 本模块不缓存本局状态；卡内脚本、局部正则与当前模式由调用方以 {permissionIds, bookkeeping} 显式传入。
import {isMap} from '../core/utils.mjs';
import {popup, settingsNode} from './ui.mjs';

export const SETTINGS_KEY = '世界树·记账';
// 应答格式取代旧的“结构化输出”开关；没有保存设置时默认走任意 OpenAI 兼容端点都可用的提示词 JSON。
// 调试关着时，玩家看不到候选、将到与已排除的事件，失败提示也不写细节（细节里可能有将到事件的ID）。
export const DEFAULTS = {方式: '同一模型', 应答格式: '提示词', 代理预设: '', 地址: '', 密钥: '', 模型: '', 来源: 'openai',
  温度: 0.2, 最大长度: 0, 尝试次数: 2, 每楼记录: true, 调试: false};

export const keeperSettings = () => {
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
export async function waitForSettings(expected) {
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

export function saveSettings(patch) {
  const write = settingsWrite.then(async () => {
    settingsWriteError = null;
    const globals = getVariables({type: 'global'}) ?? {};
    const saved = {...(globals[SETTINGS_KEY] ?? {}), ...patch};
    await replaceVariables({...globals, [SETTINGS_KEY]: saved}, {type: 'global'});
  });
  settingsWrite = write.catch(error => { settingsWriteError = error; });
  return write;
}

export async function flushSettings() {
  await settingsWrite;
  if (settingsWriteError) throw settingsWriteError;
  const globals = getVariables({type: 'global'}) ?? {};
  await waitForSettings(globals[SETTINGS_KEY] ?? {});
}

// 权限只检查宿主实际暴露的状态：脚本若根本没执行，代码无从自检，只能靠导入说明与宿主拒绝提示。
export const HOST_FUNCTIONS = ['getChatMessages', 'getLastMessageId', 'getVariables', 'replaceVariables', 'injectPrompts',
  'uninjectPrompts', 'eventOn', 'getButtonEvent', 'retrieveDisplayedMessage', 'getModelList'];

export function hostMissing({bookkeeping = true} = {}) {
  const missing = HOST_FUNCTIONS.filter(name => typeof globalThis[name] !== 'function');
  if (bookkeeping && typeof globalThis.generateRaw !== 'function') missing.push('generateRaw');
  if (!isMap(globalThis.tavern_events)) missing.push('tavern_events');
  if (typeof globalThis.SillyTavern?.getContext !== 'function') missing.push('SillyTavern.getContext');
  if (typeof globalThis.$ !== 'function') missing.push('$');
  if (!isMap(globalThis.toastr)) missing.push('toastr');
  return missing;
}

export const SCRIPT_HINT = '需要酒馆助手，并在角色设置中允许本卡脚本。脚本未执行时无法自检，只能由宿主拒绝提示。';
export const REGEX_HINT = '关闭记账时正文命令由本卡局部正则隐藏：需要在酒馆中允许本卡局部正则，并保持启用。';

// permissionIds 来自构建产物（脚本ID、正则ID）；bookkeeping 决定是否检查局部正则与记账函数。
export function permissionFailure({permissionIds, bookkeeping = true} = {}) {
  const missing = hostMissing({bookkeeping});
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
  if (bookkeeping) return null;
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

// 设置界面：连续修改按 saveSettings 的队列写入；关闭前从服务器读回，读回一致才允许关闭。
const PROBE = {name: '世界树记账测试', strict: true,
  value: {type: 'object', properties: {回答: {type: 'string'}}, required: ['回答'], additionalProperties: false}};

async function pullModels(config) {
  if (config.代理预设) throw new Error('选了代理预设时拉不到列表：改为手动填写地址与密钥，或在酒馆的 API 连接里查看模型');
  if (!config.地址) throw new Error('先填 API 地址');
  const models = await getModelList({apiurl: config.地址, key: config.密钥});
  if (!models.length) throw new Error('没有拉到模型，检查地址与密钥');
  return models;
}

// 连接测试与正式记账共用同一份调用与解析；测试本身也排进队列，避免与正在进行的记账重叠。
async function testKeeper(config, {queue, call, parse, refresh}) {
  if (config.方式 === '关闭') throw new Error('记账已关闭');
  const prompts = [{role: 'system', content: '这是连接测试，只输出 JSON。'}, {role: 'user', content: '把“回答”填为“可以”。'}];
  const started = Date.now();
  const result = await new Promise((resolve, reject) => queue(() =>
    call({prompts, schema: PROBE}, config).then(text => parse(text)).finally(refresh)).then(resolve, reject));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return {文本: JSON.stringify(result) + '（' + seconds + ' 秒'
    + (config.方式 === '另设模型' && config.模型 ? '，' + config.模型 : '') + '）'};
}

export async function showSettings({call, parse, queue, refresh}) {
  const current = keeperSettings();
  const names = typeof getProxyPresetNames === 'function' ? getProxyPresetNames() : [];
  const presets = [...new Set([...names.filter(name => name && name !== 'None'), current.代理预设].filter(Boolean))];
  let activeModel = '';
  try { activeModel = SillyTavern.getChatCompletionModel?.() ?? ''; } catch {}
  await popup(settingsNode({current, save: saveSettings, presets, activeModel, pull: pullModels,
    test: config => testKeeper(config, {queue, call, parse, refresh})}), {
    wide: true, large: false,
    onClosing: async () => {
      try { await flushSettings(); return true; }
      catch (error) { toastr.error(error.message, '世界树：设置未保存'); return false; }
    },
  });
  refresh();
}
