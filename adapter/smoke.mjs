// 酒馆适配冒烟测试：在 node 中模拟酒馆助手的全局与酒馆的事件顺序，运行 runtime.mjs（未经打包），核对注入、楼层变量、每楼一行与本局面板。
// 先运行 node adapter/build.mjs --prepare-only。传入打包后的脚本（如 ./adapter/dist/runtime.js）则测打包产物。
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadRouter, seal, applyCommands, route, renderContext, parseYaml} from '../core/index.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {createMemFs} from './memfs.mjs';
import {manifestIssue, storedManifest, MANIFEST_FIELDS, createHistoryAudit, ownershipOf, RECORD_FORMAT} from './records.mjs';
import {createOpeningDraft, adaptOpeningCommands} from './opening.mjs';
import {openingNode} from './ui.mjs';
import {createBookkeeper, buildKeepRecord, runKeeperLoop} from './bookkeeper.mjs';
import bundle from './bundle.generated.json' with {type: 'json'};

const face = parseYaml(await fs.readFile(new URL('./卡面.yaml', import.meta.url), 'utf8'));
const openingFailureMode = process.env.YGG_SMOKE_OPENING_FAILURE === '1';
if (openingFailureMode) bundle.openingCommands = [face.开场命令[0], {写场景: {在场: {玩家: true}}}];
const clone = value => value === undefined ? undefined : structuredClone(value);
// 酒馆助手在酒馆页面里克隆数据再交给脚本 iframe，脚本拿到的对象来自另一个 realm，Object.prototype 不是自己的那个。
// getChatMessages 与 getVariables 都必须走这条宿主边界，不能只测同 realm 的 structuredClone。
const foreign = value => value === undefined ? undefined : vm.runInNewContext('JSON.parse(text)', {text: JSON.stringify(value)});

// ---------- 卡面、清单与路径：不调用构建侧 helper，按规范独立复算 ----------
const repo = path.resolve(import.meta.dirname, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => {
  const a = [...left].map(char => char.codePointAt(0)), b = [...right].map(char => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
};
const digest = entries => sha256(JSON.stringify(entries.map(item => [item.路径, item.SHA256]).sort((a, b) => compare(a[0], b[0]))));
const manifest = bundle.manifest;
assert.deepEqual(Object.keys(face).filter(key => !['卡ID', '卡版本', '名称', '描述', '开场白', '开局', '开场命令'].includes(key)), []);
assert.equal(manifest.卡ID, face.卡ID);
assert.equal(manifest.卡版本, face.卡版本);
assert.equal(manifest.记录格式, 1);
assert.ok(Array.isArray(manifest.兼容程序));
assert.equal(new Set(manifest.兼容程序).size, manifest.兼容程序.length);
for (const fingerprint of manifest.兼容程序) assert.match(fingerprint, /^[0-9a-f]{64}$/);
const compatibleManifest = {...manifest, 兼容程序: ['a'.repeat(64)]};
assert.equal(manifestIssue({...manifest, 程序指纹: 'a'.repeat(64)}, compatibleManifest).ok, true,
  '当前清单明确列入的旧程序指纹应兼容');
for (const field of ['卡ID', '卡版本', '程序版本', '程序指纹', '世界书哈希']) assert.ok(manifest[field], `清单缺少 ${field}`);
assert.match(manifest.程序指纹, /^[0-9a-f]{64}$/);
assert.match(manifest.世界书哈希, /^[0-9a-f]{64}$/);
const idOf = salt => {
  const hex = sha256(`${face.卡ID}/${salt}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
assert.deepEqual(bundle.权限, {脚本ID: idOf('script'), 正则ID: idOf('regex')});
assert.equal(manifest.卡版本, face.卡版本);
if (!openingFailureMode) assert.deepEqual(bundle.openingCommands, face.开场命令);
assert.ok(face.开场命令.length >= 2);
assert.doesNotMatch(face.开场白, /<\/?命令>|^\s*[{[]/m);

const worldPaths = manifest.世界书文件.map(item => item.路径);
assert.deepEqual(worldPaths, [...worldPaths].sort(compare));
assert.deepEqual(worldPaths, Object.keys(bundle.files));
for (const item of manifest.世界书文件) {
  assert.match(item.路径, /^\/项目\/(?:世界书\/.+|yggdrasill\.yaml)$/);
  assert.doesNotMatch(item.路径, /\/\.\.?\/|\/\//);
  const content = bundle.files[item.路径];
  assert.equal(item.长度, Buffer.byteLength(content, 'utf8'));
  assert.equal(item.SHA256, sha256(Buffer.from(content, 'utf8')));
}
assert.ok(worldPaths.every(file => !file.includes('/作者资料/')), '作者资料不应进入运行世界书');
assert.equal(digest(manifest.世界书文件), manifest.世界书哈希);

const programPaths = manifest.程序文件.map(item => item.路径);
assert.deepEqual(programPaths, [...programPaths].sort(compare));
for (const name of ['runtime', 'events', 'memfs', 'bookkeeper', 'records', 'opening', 'opening-ui', 'settings', 'commands-parser', 'view', 'ui', 'upgrade'])
  assert.ok(programPaths.includes(`adapter/${name}.mjs`), name);
for (const name of ['变量更新规则', '角色通用约束', '扮演准则']) assert.ok(programPaths.includes(`templates/${name}.txt`));
assert.ok(programPaths.every(file => !/^(?:adapter\/(?:build|smoke|bundle\.generated)|adapter\/dist\/|证据\/|test\/|日志|截图)/.test(file)));
for (const item of manifest.程序文件) {
  assert.doesNotMatch(item.路径, /(?:^|\/)\.\.?(?:\/|$)|^\/|\\/);
  const content = await fs.readFile(path.join(repo, item.路径));
  assert.equal(item.长度, content.byteLength);
  assert.equal(item.SHA256, sha256(content));
}
assert.equal(digest(manifest.程序文件), manifest.程序指纹);

assert.throws(() => createMemFs({'/项目/世界书/a.txt': 'a', '/项目/世界书/./a.txt': 'b'}), /重复/);
assert.throws(() => createMemFs({'/etc/passwd': 'secret'}), /运行时根|运行时路径/);
const memory = createMemFs({'/项目/世界书/a.txt': 'a'});
await assert.rejects(memory.readFile('/项目/../etc/passwd'), /逃逸|运行时根/);
await assert.rejects(memory.readdir('/项目/缺失'), error => error.code === 'ENOENT');
console.log(`0 清单：${worldPaths.length} 个世界书文件、${programPaths.length} 个程序文件；独立复算 ${manifest.世界书哈希.slice(0, 12)}… / ${manifest.程序指纹.slice(0, 12)}…；路径逃逸、重复与缺失目录均拒绝`);

// ---------- 酒馆与酒馆助手的模拟 ----------
const chat = [], injected = {}, listeners = new Map(), toasts = [], popups = [], popupNodes = [], keeperCalls = [], keeperReplies = [];
const pendingSeen = [], modelRequests = [];
// 每楼一行：retrieveDisplayedMessage(id).after(节点) 记在 floors 里，$('#chat .ygg-floor').remove() 清空。
// $ 的模拟只记树形、文字、类名、取值与事件处理，text() 把各节点的文字按行拼起来。
const floors = new Map();
const floorText = id => floors.get(id)?.text() ?? '';
const node = tag => {
  const self = {tag, children: [], value: '', classes: [], handlers: {}, field: undefined, properties: {}, shown: true};
  return Object.assign(self, {
    css: () => self, attr: () => self, remove: () => self,
    prop: (key, value) => value === undefined ? self.properties[key] : (self.properties[key] = value, self),
    addClass: names => { self.classes.push(...names.split(' ')); return self; },
    val: value => value === undefined ? self.field : (self.field = value, self),
    on: (type, fn) => { self.handlers[type] = fn; return self; },
    toggle: shown => { self.shown = shown; return self; }, hide: () => self.toggle(false), show: () => self.toggle(true),
    empty: () => { self.children = []; return self; },
    append: (...children) => { self.children.push(...children.flat(Infinity).filter(Boolean)); return self; },
    text: value => value === undefined ? [self.value, ...self.children.map(child => child.text())].filter(Boolean).join('\n') : (self.value = value, self),
  });
};
const find = (root, test) => test(root) ? root : root.children.map(child => find(child, test)).find(Boolean);
// 第 1—8 步测旧方式（叙事模型写 <命令>），第 9 步起测记账。
let globals = {'世界树·记账': {方式: '关闭'}};
let serverGlobals = clone(globals), settingsPersistDelay = 0, holdPopup = false, closePopup = null;
let activeChatId = 'YG-ADAPTER-04-smoke-chat', stopCalls = 0, messageWrites = 0, openingWrites = 0;
let failNextMessageWrite = false, keeperThrowOnce = false, holdNextKeeper = false, releaseKeeper = null;
let emitKeeperGeneration = false, sendingPress = false;
const settingsWrites = [];
const waitUntil = async (test, label) => {
  for (let i = 0; i < 500; i++) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
};
// 当前卡的权限状态：缺失/停用脚本、缺失/停用/错误 placement/未授权的局部正则都可以按需切换。
const cardState = {avatar: '雾港.png', scriptId: bundle.权限.脚本ID, scriptPresent: true, scriptEnabled: true,
  regexId: bundle.权限.正则ID, regexPresent: true, regexDisabled: false, regexPlacement: [2], allowedRegex: ['雾港.png']};
const cardData = () => ({avatar: cardState.avatar, data: {extensions: {
  tavern_helper: {scripts: cardState.scriptPresent ? [{id: cardState.scriptId, enabled: cardState.scriptEnabled}] : []},
  regex_scripts: cardState.regexPresent ? [{id: cardState.regexId, disabled: cardState.regexDisabled,
    placement: cardState.regexPlacement, findRegex: '/<命令>[\\s\\S]*?<\\/命令>/g'}] : []}}});
const role = message => message.is_system ? 'system' : message.is_user ? 'user' : 'assistant';
// 实测中，新的玩家楼带着从上一楼复制来的楼层变量，这里照样模拟。
const push = (mes, isUser) => chat.push({mes, is_user: isUser, is_system: false, swipe_id: 0, swipes: [mes],
  variables: [isUser && chat.length ? clone(chat.at(-1).variables[chat.at(-1).swipe_id] ?? {}) : {}]});
Object.assign(globalThis, {
  stopGeneration: () => { stopCalls += 1; return true; },
  getLastMessageId: () => chat.length - 1,
  getChatMessages: range => {
    const [from, to] = String(range).split('-').map(Number);
    return foreign(chat.slice(from, (to ?? from) + 1).map((message, index) => ({message_id: from + index, role: role(message),
      message: message.mes, swipe_id: message.swipe_id, data: message.variables[message.swipe_id] ?? {}})));
  },
  getVariables: ({type, message_id}) => foreign(type === 'global' ? globals : chat.at(message_id).variables[chat.at(message_id).swipe_id] ?? {}),
  replaceVariables: (variables, {type, message_id}) => {
    if (type === 'global') {
      globals = clone(variables);
      const saved = clone(variables);
      settingsWrites.push({调试: saved['世界树·记账']?.调试, 每楼记录: saved['世界树·记账']?.每楼记录});
      if (settingsPersistDelay) setTimeout(() => { serverGlobals = saved; }, settingsPersistDelay);
      else serverGlobals = saved;
      return;
    }
    if (failNextMessageWrite) { failNextMessageWrite = false; throw new Error('模拟变量提交失败'); }
    const message = chat.at(message_id); message.variables[message.swipe_id] = clone(variables); messageWrites += 1;
  },
  // 真实宿主在改正文后异步广播编辑事件；这里保留同一顺序，事件不阻塞本次写入。
  setChatMessages: async (patches, options) => {
    for (const patch of patches) {
      const message = chat.at(patch.message_id);
      message.mes = patch.message;
      message.swipes[message.swipe_id] = patch.message;
      openingWrites += 1;
    }
    for (const patch of patches) {
      try { void Promise.resolve(emit('message_edited', patch.message_id)).catch(() => {}); } catch {}
    }
    return options?.refresh === 'affected';
  },
  generateRaw: async config => {
    keeperCalls.push(config);
    pendingSeen.push([...floors.values()].some(item => item.classes.includes('ygg-pending')));
    if (emitKeeperGeneration) await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    if (holdNextKeeper) {
      holdNextKeeper = false;
      await new Promise(resolve => { releaseKeeper = resolve; });
    }
    if (keeperThrowOnce) { keeperThrowOnce = false; throw new Error('模拟记账调用失败'); }
    return keeperReplies.shift();
  },
  getModelList: async config => { modelRequests.push(config); return ['model-a', 'model-b', 'model-c']; },
  getProxyPresetNames: () => ['None', '中转'],
  fetch: async url => {
    if (String(url) === '/api/settings/get') {
      const settings = {extension_settings: {variables: {global: clone(serverGlobals)}}};
      return {ok: true, status: 200, json: async () => ({settings: JSON.stringify(settings)})};
    }
    throw new Error(`未模拟的请求：${url}`);
  },
  retrieveDisplayedMessage: id => ({length: id < chat.length ? 1 : 0, after: element => floors.set(id, element)}),
  injectPrompts: prompts => prompts.forEach(prompt => { injected[prompt.id] = prompt; }),
  uninjectPrompts: ids => ids.forEach(id => delete injected[id]),
  eventOn: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  tavern_events: {GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_SWIPED: 'message_swiped', MESSAGE_DELETED: 'message_deleted', CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered'},
  getButtonEvent: name => `button:${name}`,
  toastr: Object.fromEntries(['success', 'warning', 'error', 'info'].map(level => [level, (body, title) => toasts.push({level, title, body})])),
  SillyTavern: {POPUP_TYPE: {TEXT: 1}, POPUP_RESULT: {AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null},
    getRequestHeaders: () => ({}), getContext: () => ({chatId: activeChatId, characters: [cardData()], characterId: 0,
      is_send_press: sendingPress, extensionSettings: {character_allowed_regex: cardState.allowedRegex}}), callGenericPopup: (element, type, input, options = {}) => {
    popupNodes.push(element); popups.push(element.text());
    if (!holdPopup) return Promise.resolve(1);
    return new Promise((resolve, reject) => {
      closePopup = async (result = 1) => {
        try {
          if (await options.onClosing?.({result}) === false) return false;
          resolve(result); closePopup = null; await options.onClose?.({result}); return true;
        } catch (error) { reject(error); closePopup = null; return true; }
      };
    });
  }},
  $: selector => selector === '#chat .ygg-floor' ? {remove: () => floors.clear()} : node(selector),
});
const emit = async (type, ...args) => { for (const fn of listeners.get(type) ?? []) await fn(...args); };
const generationOptions = {automatic_trigger: false, force_name2: false, quiet_prompt: undefined, quietToLoud: false,
  skipWIAN: false, force_chid: undefined, signal: undefined, quietImage: undefined};
const content = () => injected['yggdrasill-context']?.content ?? '';
const record = id => chat[id].variables[chat[id].swipe_id]?.世界树;

// 酒馆的顺序：普通发送时，GENERATION_AFTER_COMMANDS 先于用户消息入列，入列后发 MESSAGE_SENT；回复写完后发 MESSAGE_RECEIVED。
async function send(userText, replyText) {
  await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
  push(userText, true);
  await emit('message_sent', chat.length - 1);
  const before = content();
  push(replyText, false);
  await emit('message_received', chat.length - 1, 'normal');
  return before;
}

// ---------- 对照：用内核在 node 中直接算 ----------
const {protocol, router} = await loadRouter(path.resolve(import.meta.dirname, '../test/fixtures/雾港/世界书'), {fs, path});
const strip = text => text.replace(/<命令>\s*\n?([\s\S]*?)<\/命令>/g, '').trim();

// 开局纯计算：自由组合使用雾港真实选项声明，只在内存里把开关打开，不改世界书。
const freeCatalog = clone(router.catalog);
freeCatalog.openingOptions.内容.自由组合 = true;
const freeDraft = createOpeningDraft({protocol, catalog: freeCatalog, decl: router.decl, defaults: face.开局});
freeDraft.setTime('潮历074年');
assert.equal(freeDraft.setHistory('拜师', '拜师').ok, true);
assert.equal(freeDraft.setHistory('出师考核', '未发生').ok, true);
const freeSnapshot = freeDraft.snapshot();
assert.deepEqual(freeSnapshot.预览.开局.历史选择, {拜师: '拜师', 出师考核: '未发生'});
assert.equal(freeSnapshot.预览.事件.拜师.分支, '拜师');
assert.equal(freeSnapshot.预览.事件.出师考核.状态, 2);
assert.ok(freeSnapshot.历史.every(item => item.分支.some(branch => branch.id === '未发生')));
const rejectedHistory = freeDraft.setHistory('大雾之夜', '发生');
assert.equal(rejectedHistory.ok, false);
assert.equal(rejectedHistory.error.code, '开局.历史选择');
console.log('0b 开局纯计算：自由组合开启时，“拜师”与“未发生”写入真实声明分支；未声明事件被拒绝');

// 0c 开场命令按最终封卷的玩家调整：扮演角色组在当前地点写入后自动在场，协议不许用写场景改写它。
const cardCommands = clone(face.开场命令);
const roleplayDraft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: face.开局, commands: cardCommands});
roleplayDraft.setPlayerMode('扮演');
roleplayDraft.setPlayerGroup('灯塔学徒');
const roleplayPrepared = roleplayDraft.prepare();
assert.equal(roleplayPrepared.ok, true, '默认扮演灯塔学徒的开场命令应成功');
const roleplayRecord = roleplayPrepared.record;
assert.deepEqual(roleplayRecord.命令, [
  {确认初始化: {角色组ID: '灯塔学徒'}},
  {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {秦守: true}}},
], '记录保存实际执行的命令：扮演组从在场移除，其余字段保持');
assert.ok(protocol.createReadView(roleplayRecord.本局).presentIDs().includes('灯塔学徒'), '当前地点写入后扮演组应视为在场');
assert.equal(roleplayRecord.本局.角色.灯塔学徒.已初始化, true, '扮演组已有的确认初始化保持');
assert.equal(roleplayRecord.本局.角色.秦守.在场, true);
assert.equal(roleplayRecord.本局.角色.秦守.已初始化, true);
assert.deepEqual(roleplayRecord.本局.世界.当前地点, {地标: '灯塔', 场景: '值守室'});
const roleplayReplay = applyCommands(protocol, seal(protocol, roleplayDraft.input()), roleplayRecord.命令);
assert.deepEqual(roleplayReplay.失败, []);
assert.deepEqual(roleplayReplay.state, roleplayRecord.本局, '第 0 楼记录重放应得到同一状态');

// 扮演白棠不命中开场命令：命令逐字保持，灯塔学徒的初始化与在场照旧。
const baiDraft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: face.开局, commands: cardCommands});
baiDraft.setPlayerMode('扮演');
baiDraft.setPlayerGroup('白棠');
const baiPrepared = baiDraft.prepare();
assert.equal(baiPrepared.ok, true);
assert.deepEqual(baiPrepared.record.命令, cardCommands, '未命中扮演组的命令逐字保持');
assert.equal(baiPrepared.record.本局.开局.玩家.扮演角色组, '白棠');
assert.ok(protocol.createReadView(baiPrepared.record.本局).presentIDs().includes('白棠'));
assert.equal(baiPrepared.record.本局.角色.灯塔学徒.在场, true);

// 自建模式不动开场命令。
const ownPrepared = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: face.开局, commands: cardCommands}).prepare();
assert.equal(ownPrepared.ok, true);
assert.deepEqual(ownPrepared.record.命令, cardCommands, '自建模式的命令逐字保持');

// 适配只动写场景的在场与所在：只含扮演组的写场景整条省略，混合命令保留其他字段。
const roleplayPlayer = {模式: '扮演', 扮演角色组: '灯塔学徒'};
assert.deepEqual(adaptOpeningCommands([{写场景: {在场: {灯塔学徒: true}}}], roleplayPlayer), [], '只含扮演组的写场景可省略');
assert.deepEqual(adaptOpeningCommands([{写场景: {所在: {灯塔学徒: '灯塔'}}}], roleplayPlayer), [], '只含扮演组的所在可省略');
assert.deepEqual(adaptOpeningCommands([{写场景: {当前时间: '潮历071年04月02日', 在场: {灯塔学徒: true, 秦守: true}, 所在: {秦守: '灯塔'}}}], roleplayPlayer),
  [{写场景: {当前时间: '潮历071年04月02日', 在场: {秦守: true}, 所在: {秦守: '灯塔'}}}], '混合命令保留其他角色、时间与地点');
assert.deepEqual(adaptOpeningCommands([{确认初始化: {角色组ID: '灯塔学徒'}}], roleplayPlayer),
  [{确认初始化: {角色组ID: '灯塔学徒'}}], '确认初始化不在此改写');

// 畸形命令不被修复逻辑吞掉：仍由原校验拒绝。
const malformedCommand = (commands, label) => {
  const draft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
    defaults: face.开局, commands});
  draft.setPlayerMode('扮演');
  draft.setPlayerGroup('灯塔学徒');
  const prepared = draft.prepare();
  assert.equal(prepared.ok, false, label + ' 应被原校验拒绝');
  assert.equal(prepared.阶段, '开场命令');
  assert.equal(prepared.error.code, '开场.命令');
};
malformedCommand([{写场景: {在场: {秦守: '是'}}}], '在场值非布尔');
malformedCommand([{写场景: '不是映射'}], '写场景非映射');
malformedCommand([{写场景: {在场: '不是映射'}}], '在场非映射');
malformedCommand([{写场景: {未知: 1}, 确认初始化: {角色组ID: '灯塔学徒'}}], '多键命令');
console.log('0c 默认扮演灯塔学徒：开场命令生效且记录不含扮演组在场；白棠与自建逐字保持；只含扮演组的写场景省略、混合命令保留其余字段；第 0 楼重放一致；畸形命令仍被拒绝');

// 1. 开局门禁、五类选择、预演、三种失败与原子提交
push(face.开场白, false);
const greeting = applyCommands(protocol, seal(protocol, face.开局), face.开场命令);
const initialChat = JSON.stringify(chat);
holdPopup = true;
const entry = process.argv[2] || (process.env.SMOKE_USE_DIST === '1' ? 'adapter/dist/runtime.js' : null);
await import(entry ? pathToFileURL(path.resolve(process.cwd(), entry)).href : new URL('./runtime.mjs', import.meta.url).href);
await waitUntil(() => popupNodes.length >= 1, '新聊天打开开局界面');
assert.equal(record(0), undefined, '确认开局前不得创建第 0 楼记录');
assert.equal(injected['yggdrasill-context'], undefined, '确认开局前不得注入叙事上下文');
assert.equal(keeperCalls.length, 0, '预演与开局门禁不得调用记账模型');
assert.equal(messageWrites, 0, '确认开局前不得写楼层变量');
assert.match(floorText(0), /尚未开局/);
const stoppedBeforeOpening = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stoppedBeforeOpening + 1, '未开局生成应实际调用宿主停止');
assert.ok(toasts.some(item => item.title?.includes('已阻止生成') && /尚未开局/.test(item.body)), '未开局阻断原因应明确为“尚未开局”');
assert.equal(record(0), undefined);
assert.equal(injected['yggdrasill-context'], undefined);

assert.equal(await closePopup(null), true, '取消开局应关闭界面但不提交');
await new Promise(resolve => setTimeout(resolve, 10));
assert.match(floorText(0), /打开开局/);
assert.equal(JSON.stringify(chat), initialChat, '取消开局不得改变任何聊天变量');
const reopen = emit('button:世界树：开局');
await waitUntil(() => popupNodes.length >= 2, '取消后重新打开开局界面');
let openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /潮历071年04月01日/);

if (openingFailureMode) {
  assert.equal(await closePopup(1), false, '开场命令失败时提交应被拒绝');
  assert.equal(record(0), undefined, '开场命令失败不得创建第 0 楼记录');
  assert.equal(injected['yggdrasill-context'], undefined);
  assert.match(popupNodes.at(-1).text(), /开场命令/);
  bundle.openingCommands.splice(0, bundle.openingCommands.length, ...face.开场命令);
  assert.equal(await closePopup(1), true, '修正开场命令后应能重新提交');
  await reopen;
  assert.deepEqual(record(0).命令, face.开场命令);
  assert.deepEqual(record(0).失败, []);
  assert.deepEqual(record(0).本局, greeting.state);
  assert.ok(content().length > 0);
  console.log('1 原子开场失败：失败提交零记录、零注入；修正后重新提交才写入第 0 楼');
  process.exit(0);
}

let planSelect = find(openingForm, item => item.tag === '<select>' && item.children.some(option => option.field === '码头少年'));
planSelect.handlers.change({target: {value: '码头少年'}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /潮历072年/);
assert.match(openingForm.text(), /少年没有拜师，在码头长大/);
assert.match(openingForm.text(), /拜师=未拜师/);
planSelect = find(openingForm, item => item.tag === '<select>' && item.children.some(option => option.field === '补考之年'));
planSelect.handlers.change({target: {value: '补考之年'}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /潮历073年/);
assert.match(openingForm.text(), /出师考核=未通过/);
planSelect = find(openingForm, item => item.tag === '<select>' && item.children.some(option => option.field === '码头少年'));
planSelect.handlers.change({target: {value: ''}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /有效预览：潮历071年04月01日/);
assert.equal(find(openingForm, item => item.tag === '<select>' && item.children.some(option => option.field === '未拜师')), undefined,
  '自由组合关闭时不得出现自由历史选择框');

let timeInput = find(openingForm, item => item.tag === '<input>' && item.field === face.开局.开局时间);
timeInput.handlers.change({target: {value: '不是纪年'}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /缺少合法开局时间/);
assert.match(openingForm.text(), /有效预览：潮历071年04月01日/, '预演失败时应保留上一份有效预览');
const writesBeforeSealFailure = messageWrites;
assert.equal(await closePopup(1), false, '最终封卷失败时提交应被拒绝');
assert.equal(record(0), undefined, '封卷失败不得创建第 0 楼记录');
assert.equal(messageWrites, writesBeforeSealFailure);
assert.equal(injected['yggdrasill-context'], undefined);
openingForm = popupNodes.at(-1);
timeInput = find(openingForm, item => item.tag === '<input>' && item.field === '不是纪年');
timeInput.handlers.change({target: {value: face.开局.开局时间}});

let versionSelect = find(popupNodes.at(-1), item => item.tag === '<select>'
  && item.children.some(option => option.field === '林汐'));
versionSelect.handlers.change({target: {value: '林汐'}});
assert.match(popupNodes.at(-1).text(), /灯塔学徒\(林汐\)/);
versionSelect = find(popupNodes.at(-1), item => item.tag === '<select>'
  && item.children.some(option => option.field === '林澜'));
versionSelect.handlers.change({target: {value: '林澜'}});

const modeSelect = find(popupNodes.at(-1), item => item.tag === '<select>'
  && item.children.some(option => option.field === '自建') && item.children.some(option => option.field === '扮演'));
modeSelect.handlers.change({target: {value: '扮演'}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /玩家：扮演 灯塔学徒/);
let roleSelect = find(openingForm, item => item.tag === '<select>' && item.children.some(option => option.field === '灯塔学徒')
  && item.children.some(option => option.field === '白棠'));
roleSelect.handlers.change({target: {value: '白棠'}});
assert.match(popupNodes.at(-1).text(), /玩家：扮演 白棠/);
roleSelect = find(popupNodes.at(-1), item => item.tag === '<select>' && item.children.some(option => option.field === '灯塔学徒')
  && item.children.some(option => option.field === '白棠'));
roleSelect.handlers.change({target: {value: '灯塔学徒'}});
openingForm = popupNodes.at(-1);
const groupRow = find(openingForm, item => item.classes.includes('ygg-group-row') && item.text().includes('灯塔学徒'));
let groupEnable = find(groupRow, item => item.tag === '<input>');
groupEnable.handlers.change({target: {checked: false}});
openingForm = popupNodes.at(-1);
assert.match(openingForm.text(), /扮演角色组不存在或未启用/);
assert.match(openingForm.text(), /玩家：扮演 灯塔学徒/);
const disabledRow = find(openingForm, item => item.classes.includes('ygg-group-row') && item.text().includes('灯塔学徒'));
groupEnable = find(disabledRow, item => item.tag === '<input>');
groupEnable.handlers.change({target: {checked: true}});
const modeAgain = find(popupNodes.at(-1), item => item.tag === '<select>'
  && item.children.some(option => option.field === '自建') && item.children.some(option => option.field === '扮演'));
modeAgain.handlers.change({target: {value: '自建'}});
let profile = find(popupNodes.at(-1), item => item.tag === '<textarea>');
profile.handlers.change({target: {value: '姓名: 海生\n出生年: 潮历050年\n'}});
assert.match(popupNodes.at(-1).text(), /玩家：自建 海生/);
profile = find(popupNodes.at(-1), item => item.tag === '<textarea>');
profile.handlers.change({target: {value: '姓名: 海生\n出生年: 不是纪年\n'}});
assert.match(popupNodes.at(-1).text(), /自建玩家档案取值不合法：出生年/);
assert.match(popupNodes.at(-1).text(), /有效预览：潮历071年04月01日/);
profile = find(popupNodes.at(-1), item => item.tag === '<textarea>');
profile.handlers.change({target: {value: '{}'}});
assert.match(popupNodes.at(-1).text(), /玩家：自建 未命名/);

const beforeSaveFailure = JSON.stringify(chat);
failNextMessageWrite = true;
assert.equal(await closePopup(1), false, '变量保存失败时提交应被拒绝');
assert.equal(record(0), undefined, '变量保存失败不得留下第 0 楼记录');
assert.equal(injected['yggdrasill-context'], undefined);
assert.equal(JSON.stringify(chat), beforeSaveFailure, '变量保存失败后应保留原始变量');
assert.ok(toasts.some(item => item.level === 'error' && /模拟变量提交失败/.test(item.body)));
const writesBeforeOpeningSuccess = messageWrites;
assert.equal(await closePopup(1), true, '修正保存故障后应能提交');
await reopen;
holdPopup = false;
assert.equal(messageWrites, writesBeforeOpeningSuccess + 1, '合法提交只写一次第 0 楼记录');
assert.deepEqual(greeting.失败, []);
assert.deepEqual(record(0).本局, greeting.state);
assert.deepEqual(record(0).命令, face.开场命令);
assert.equal(record(0).记录格式, 1);
assert.deepEqual(record(0).运行清单, storedManifest(manifest));
assert.deepEqual(Object.keys(record(0).运行清单).sort(), [...MANIFEST_FIELDS].sort());
assert.ok(!('世界书文件' in record(0).运行清单) && !('程序文件' in record(0).运行清单));
assert.equal(record(0).记账.方式, '开场命令');
assert.equal(record(0).记账.状态, '成功');
assert.deepEqual(Object.keys(record(0)).sort(), ['失败', '已写入', '归属', '命令', '运行清单', '记录格式', '记账', '本局'].sort());
assert.deepEqual(record(0).归属, {楼号: 0, 角色: 'assistant', swipe: 0,
  正文指纹: sha256(Buffer.from(chat[0].mes, 'utf8'))});
assert.equal(record(0).记账.应答格式, '无');
assert.equal(record(0).记账.尝试次数, 1);
assert.ok(!('原始结果' in record(0).记账));
assert.ok(content().startsWith(`${renderContext(route(router, greeting.state, [strip(face.开场白)]).context)}\n\n<本轮提醒>\n`));
assert.match(content(), /本局的当前时间是 潮历071年04月01日/);
assert.ok(floors.has(0));
assert.equal(keeperCalls.length, 0, '开局预演和合法提交都不得调用记账模型');

const openingBeforeDuplicate = JSON.stringify(record(0)), writesBeforeDuplicate = messageWrites;
await emit('button:世界树：开局');
assert.equal(JSON.stringify(record(0)), openingBeforeDuplicate, '重复开局不得覆盖已有第 0 楼记录');
assert.equal(messageWrites, writesBeforeDuplicate, '重复开局不得再次写楼层变量');
assert.ok(toasts.some(item => item.title?.includes('开局已存在')));
const openingBeforeReload = JSON.stringify(record(0));
await emit('chat_id_changed');
assert.equal(JSON.stringify(record(0)), openingBeforeReload, '重载第 0 楼时不应重新执行或改写开场命令记录');
const firstMessageWrites = messageWrites, firstMessageCalls = keeperCalls.length;
await emit('message_received', 0, 'first_message');
assert.equal(JSON.stringify(record(0)), openingBeforeReload, '宿主发送开场白事件时不应重新执行或改写第 0 楼记录');
assert.equal(messageWrites, firstMessageWrites, '合规开场白事件不应补写楼层变量');
assert.equal(keeperCalls.length, firstMessageCalls, '合规开场白事件不应调用记账模型');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '合规开场白事件不应进入只读视图');
assert.deepEqual(record(0).本局, greeting.state, '合法第 0 楼记录应通过审计');

const openingTime = record(0).本局.世界.当前时间;
record(0).本局.世界.当前时间 = '潮历999年01月01日';
const mismatchedOpening = JSON.stringify(record(0)), mismatchWrites = messageWrites, mismatchCalls = keeperCalls.length;
await emit('chat_id_changed');
assert.equal(JSON.stringify(record(0)), mismatchedOpening, '第 0 楼真实失配时不得改写原变量');
assert.equal(messageWrites, mismatchWrites, '第 0 楼真实失配时不得补写楼层变量');
assert.equal(keeperCalls.length, mismatchCalls, '第 0 楼真实失配时不得调用记账模型');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '第 0 楼真实失配时仍应阻断');
assert.ok(toasts.some(item => item.level === 'error' && item.title?.includes('重放.失配')), '第 0 楼真实失配应报告重放.失配');
record(0).本局.世界.当前时间 = openingTime;
await emit('chat_id_changed');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '恢复合法第 0 楼后应退出只读视图');

// 酒馆会给新助手楼复制上一楼变量；副本不能冒充这一楼的旧记录，也不能阻止本楼取得新记录。
push('新助手楼继承上一楼变量的测试正文。', false);
chat[1].variables[0] = clone(chat[0].variables[0]);
const inheritedWrites = messageWrites, inheritedCalls = keeperCalls.length;
await emit('message_received', 1, 'normal');
assert.equal(record(1).归属.楼号, 1, '继承副本应被本楼新记录替换');
assert.equal(record(1).记账.状态, '成功');
assert.equal(messageWrites, inheritedWrites + 1, '新助手楼应只写入一次本楼记录');
assert.equal(keeperCalls.length, inheritedCalls, '关闭记账时不应调用记账模型');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '继承副本不应触发只读视图');
chat.pop();
await emit('chat_id_changed');
console.log(`1 开局：取消、预演失败、封卷失败、保存失败均零记录；方案/角色/玩家选择可重试；合法提交写入 ${JSON.stringify(record(0).已写入)}；重复提交与重载不重写`);

// 2. 普通的一轮：候选出现，模型确认
const reply2 = '秦守讲完旧事，举灯示范了一次长短间隔。\n<命令>\n- 确认事件: {事件ID: 秦守讲旧事, 分支ID: 讲述并示范}\n</命令>';
const injected2 = await send('我刮干净鞋底上楼，问秦守：听说您年轻时在雾里救过人？', reply2);
assert.match(injected2, /事件ID: 秦守讲旧事/);
assert.deepEqual(record(2).已写入, ['秦守讲旧事']);
assert.deepEqual(record(2).失败, []);
assert.equal(record(2).记账.方式, '正文');
assert.equal(record(2).记账.应答格式, '正文命令');
assert.equal(record(2).记账.状态, '成功');
assert.match(floorText(2), /^记账\n发生 秦守讲旧事（讲述并示范）/);
console.log(`2 候选“秦守讲旧事”进入上下文；回复确认后写入 ${JSON.stringify(record(2).已写入)}；第 2 楼下方：${floorText(2).split('\n')[1]}`);

// 3. 写错命令：写场景的在场写了“玩家”，整条被拒；下一轮注入失败提示
await send('我在值守室坐下，等天黑。', '天色暗下来。\n<命令>\n- 写场景: {当前时间: 潮历071年04月20日, 在场: {玩家: true}}\n</命令>');
assert.equal(record(4).失败.length, 1);
assert.equal(record(4).失败[0].阶段, '协议执行');
assert.deepEqual(record(4).命令, [], '失败命令不能进入重放列表');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.match(content(), /^<上一轮命令>\n[^\n]*本局现在的当前时间是 潮历071年04月01日/);
console.log(`3 第 4 楼失败：${record(4).失败[0].说明}；下一轮注入以失败提示开头，写明本局时间`);

// 4. 重 roll 第 4 楼：新 swipe 没有记录，按第 2 楼的本局路由；写对之后存在 swipe 1
chat[4].swipes.push(''); chat[4].swipe_id = 1; chat[4].mes = '';
await emit('message_swiped', 4);
await emit('GENERATION_AFTER_COMMANDS', 'swipe', generationOptions, false);
assert.doesNotMatch(content(), /^<上一轮命令>/);
chat[4].mes = chat[4].swipes[1] = '夜里起了雾。\n<命令>\n- 写场景: {当前时间: 潮历071年04月20日}\n</命令>';
await emit('message_received', 4, 'swipe');
assert.deepEqual(record(4).失败, []);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.match(content(), /事件ID: 大雾之夜/);
console.log('4 重 roll 后按上一楼的本局路由；新 swipe 写对后，大雾之夜成为候选');

// 5. 切回 swipe 0：本局随 swipe 回到失败的那一份
chat[4].swipe_id = 0; chat[4].mes = chat[4].swipes[0];
await emit('message_swiped', 4);
assert.match(content(), /^<上一轮命令>/);
assert.equal(record(4).本局.世界.当前时间, '潮历071年04月01日');
console.log('5 切回 swipe 0，本局与失败提示随之恢复');

// 6. 编辑第 2 楼：改走“讲述”分支，后面各楼按新的本局重算
chat[4].swipe_id = 1; chat[4].mes = chat[4].swipes[1];
chat[2].mes = chat[2].swipes[0] = reply2.replace('讲述并示范', '讲述');
await emit('message_edited', 2);
assert.equal(record(2).本局.事件.秦守讲旧事.分支, '讲述');
assert.equal(record(4).本局.事件.秦守讲旧事.分支, '讲述');
chat[4].swipe_id = 0; chat[4].mes = chat[4].swipes[0];
await emit('message_swiped', 4);
assert.equal(record(4).本局.事件.秦守讲旧事.分支, '讲述');
chat[4].swipe_id = 1; chat[4].mes = chat[4].swipes[1];
await emit('message_swiped', 4);
assert.ok(!toasts.some(item => item.title?.includes('第 3 楼')), '第 3 楼复制来的记录被当成自己的命令重放了');
console.log('6 编辑第 2 楼后，第 2、4 楼的本局都改为“讲述”分支，第 3 楼复制来的旧记录既不重放也不作底；切到第 4 楼未选中的 swipe 时也随之重算');

// 7. 命令块中一条写坏（花括号提前闭合）：只丢这一条，其余照常执行
await send('我推开窗看雾。', '雾很浓。\n<命令>\n- 写场景: {当前时间: 潮历071年04月21日}\n- 动态事件: {事件ID: 开窗, 摘要: 学徒推开窗。}, 实际参与者: [灯塔学徒]}\n</命令>');
assert.equal(record(6).失败.length, 1);
assert.equal(record(6).失败[0].错误码, '命令.解析');
assert.equal(record(6).失败[0].序号, 2);
assert.equal(record(6).失败[0].阶段, '解析');
assert.equal(record(6).命令.length, 1, '坏掉的一条不进入重放，但前一条仍可重放');
assert.equal(record(6).本局.世界.当前时间, '潮历071年04月21日');
console.log(`7 命令块第 2 条解析失败，第 1 条照常执行：${record(6).失败[0].说明.split('（')[0]}`);

// 8. 删楼与本局面板：调试关着时看不到候选（大雾之夜已是候选），本轮上下文也不给看；打开调试后都有
chat.splice(5);
await emit('message_deleted', 5);
assert.doesNotMatch(content(), /^<上一轮命令>/);
assert.match(content(), /事件ID: 大雾之夜/);
assert.ok(!floors.has(5) && !floors.has(6));
await emit('button:世界树：本轮上下文');
await emit('button:世界树：本局');
let panels = popups.slice(-2);
assert.match(panels[0], /先在“世界树：设置”中打开调试/);
assert.match(panels[1], /秦守讲旧事（讲述）/);
assert.doesNotMatch(panels[1], /大雾|候选|将到/);
globals['世界树·记账'].调试 = true;
await emit('button:世界树：本轮上下文');
await emit('button:世界树：本局');
panels = popups.slice(-2);
assert.match(panels[0], /事件ID: 大雾之夜/);
assert.match(panels[1], /候选\n北湾大雾〔大雾之夜〕/);
assert.match(panels[1], /#4 assistant\n正文·正文命令·(?:成功|部分失败)·1 次\n格式 1\n命令 1/);
console.log(`8 删去第 5、6 楼后按第 4 楼路由，两楼的记录行随之消失；本局面板 ${[...panels[0]].length} 字符，不含候选；调试面板 ${[...panels[1]].length} 字符`);

// 9. 记账：叙事模型只写正文；记账第一次的日期不合法，第二次改正。注入中不再有变量更新规则。
globals = {'世界树·记账': {方式: '同一模型', 结构化输出: true}};
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.doesNotMatch(content(), /# 变量更新规则/);
assert.match(content(), /正文里不宣布数值或状态的改变，也不写 <命令>/);
const keep = (时间, 发生的事件) => JSON.stringify({时间, 地点: {地标: '', 场景: ''}, 在场: ['灯塔学徒', '秦守'], 发生的事件, 新情况: []});
keeperReplies.push(keep({方式: '写日期', 日期: '潮历071年13月01日', 事件ID: ''}, [{事件ID: '大雾之夜', 分支ID: '发生'}]),
  keep({方式: '写日期', 日期: '潮历071年04月21日', 事件ID: ''}, [{事件ID: '大雾之夜', 分支ID: '发生'}]));
await send('我守着灯，不敢合眼。', '那一夜雾压下来，灯塔的灯灭了。学徒和秦守守到天亮。');
assert.equal(keeperCalls.length, 2);
assert.ok(keeperCalls[0].json_schema.value.properties.发生的事件.items.properties.事件ID.enum.includes('大雾之夜'));
assert.match(keeperCalls[1].ordered_prompts[1].content, /日期不合法/);
assert.deepEqual(record(6).失败, []);
assert.ok(record(6).已写入.includes('大雾之夜'));
assert.equal(record(6).本局.世界.当前时间, '潮历071年04月21日');
assert.equal(record(6).记账.重试, 1);
assert.equal(record(6).记账.状态, '成功');
assert.equal(record(6).记账.尝试次数, 2);
assert.equal(record(6).记账.应答格式, '结构化输出');
assert.ok(!('原始结果' in record(6).记账), '调试关闭时不保留解析后的记账结果');
assert.doesNotMatch(JSON.stringify(record(6)), /sk-test|apiurl|密钥/);
assert.match(floorText(6), /^记账\n时间 071年04月20日 → 071年04月21日 · 发生 北湾大雾/);
assert.equal(pendingSeen.at(-2), true, '记账进行中，这一楼下方应显示“记账中”');
assert.ok(!toasts.some(item => item.title?.includes('已记账')), '每楼记录开着时不再弹出已记账');
console.log(`9 记账两次（第一次日期不合法）后写入 ${JSON.stringify(record(6).已写入)}；注入中没有变量更新规则；第 6 楼下方：${floorText(6).split('\n')[1]}`);

// 10. 重放：切 swipe 时第 6 楼照存下的命令重放，不再调模型；点这一楼下方的“重新记账”才重新调模型。
const calls = keeperCalls.length;
await emit('message_swiped', 6);
assert.equal(keeperCalls.length, calls);
assert.ok(record(6).已写入.includes('大雾之夜'));
keeperReplies.push(keep({方式: '写日期', 日期: '潮历071年04月22日', 事件ID: ''}, [{事件ID: '大雾之夜', 分支ID: '发生'}]));
const rekeep = find(floors.get(6), item => item.tag === '<button>' && item.value === '重新记账');
await rekeep.handlers.click();
assert.equal(keeperCalls.length, calls + 1);
assert.equal(record(6).本局.世界.当前时间, '潮历071年04月22日');
assert.match(floorText(6), /时间 071年04月20日 → 071年04月22日/);
console.log(`10 切 swipe 重放不调模型；点第 6 楼的“重新记账”调一次模型：${floorText(6).split('\n')[1]}`);

// 11. 设置：另设模型，拉取模型后从列表选，测试按同样的连接与参数发一次记账请求。代理预设列表不含酒馆的“None”。
globals['世界树·记账'] = {...globals['世界树·记账'], 方式: '另设模型', 地址: 'https://relay.example/v1', 密钥: 'sk-test', 温度: 0.3, 最大长度: 2048};
serverGlobals = clone(globals);
await emit('button:世界树：设置');
const form = popupNodes.at(-1);
const connection = find(form, item => item.tag === '<select>' && item.children.some(option => option.value === '代理预设：中转'));
assert.equal(connection.children.length, 2);
await find(form, item => item.tag === '<button>' && item.value === '拉取模型').handlers.click();
assert.deepEqual(modelRequests.at(-1), {apiurl: 'https://relay.example/v1', key: 'sk-test'});
const picker = find(form, item => item.tag === '<select>' && item.children.some(option => option.value === 'model-b'));
assert.equal(picker.shown, true);
picker.handlers.change({target: {value: 'model-b'}});
await waitUntil(() => globals['世界树·记账'].模型 === 'model-b', '选择模型');
keeperReplies.push('{"回答": "可以"}');
await find(form, item => item.tag === '<button>' && item.value === '测试记账连接').handlers.click();
const probe = keeperCalls.at(-1);
assert.deepEqual(probe.custom_api, {apiurl: 'https://relay.example/v1', key: 'sk-test', model: 'model-b', source: 'openai', temperature: 0.3, max_tokens: 2048});
assert.equal(probe.json_schema.name, '世界树记账测试');
assert.match(find(form, item => item.classes.includes('ygg-status')).value, /^成功：\{"回答":"可以"\}/);
assert.ok(content().length > 0, '测试之后注入应恢复');
await waitUntil(() => serverGlobals['世界树·记账'].模型 === 'model-b', '模型设置写入酒馆');
console.log(`11 设置：拉到 ${picker.children.length - 1} 个模型，选 model-b；测试请求带上地址、模型、温度与最大长度，返回合法 JSON`);
console.log(`提示：${toasts.map(item => `${item.level} ${item.title}`).join('；')}`);

// 12. 宿主边界：楼层变量来自酒馆页面 realm。调试开启时每楼记录仍要全部显示；记账写场景要能在该对象上把角色移出在场。
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 每楼记录: true, 调试: true};
const hostState = getChatMessages('6')[0].data.世界树.本局;
assert.notEqual(Object.getPrototypeOf(hostState), Object.prototype, '宿主边界对象应来自另一个 realm');
assert.equal(hostState.角色.秦守.在场, true);
const previousPlace = hostState.世界.当前地点.地标;
keeperReplies.push(JSON.stringify({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: ['灯塔学徒'], 发生的事件: [], 新情况: []}));
await send('秦守把钥匙交给学徒，独自离开值守室。', '秦守推门出去，值守室里只剩学徒一人。');
assert.deepEqual(record(8).失败, []);
assert.equal(record(8).本局.角色.秦守.在场, false);
assert.equal(record(8).本局.角色.秦守.所在, previousPlace);
assert.ok(record(8).记账.原始结果, '调试开启时保留解析后的记账结果');
assert.doesNotMatch(JSON.stringify(record(8)), /sk-test|apiurl|密钥/);
assert.ok(floors.has(6) && floors.has(8), '调试开启后，已记录的楼层仍应逐楼显示');
assert.match(floorText(6), /事件状态[\s\S]*命令/);
assert.match(floorText(8), /离开 秦守/);
assert.match(floorText(8), /事件状态[\s\S]*命令/);
console.log(`12 宿主 realm 本局写入成功：秦守在场→${record(8).本局.角色.秦守.在场}，所在→${record(8).本局.角色.秦守.所在}；调试时第 6、8 楼记录仍在并带命令`);

// 13. 设置保存：快速连续修改依次入队；关闭必须等酒馆设置文件读回，模拟关闭后重载仍读到最后值。
globals['世界树·记账'] = {...globals['世界树·记账'], 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
settingsPersistDelay = 60;
holdPopup = true;
const writeStart = settingsWrites.length;
const openingSettings = emit('button:世界树：设置');
const saveForm = popupNodes.at(-1);
const checkboxes = root => {
  const found = [];
  const collect = item => {
    if (item.tag === '<label>' && item.classes.includes('ygg-check')) found.push(item.children.find(child => child.tag === '<input>'));
    item.children.forEach(collect);
  };
  collect(root);
  return found;
};
const [floorBox, debugBox] = checkboxes(saveForm);
debugBox.handlers.change({target: {checked: true}});
debugBox.handlers.change({target: {checked: false}});
floorBox.handlers.change({target: {checked: false}});
floorBox.handlers.change({target: {checked: true}});
assert.equal(serverGlobals['世界树·记账'].调试, false, '测试前置：酒馆尚未写入新值');
const closingSettings = closePopup();
let closedEarly = false;
closingSettings.then(() => { closedEarly = true; });
assert.equal(closedEarly, false, '设置弹窗不应在保存完成前关闭');
assert.equal(serverGlobals['世界树·记账'].调试, false, '关闭开始时不得伪造服务器写入');
await closingSettings;
await openingSettings;
holdPopup = false;
settingsPersistDelay = 0;
const quickWrites = settingsWrites.slice(writeStart);
assert.equal(quickWrites.length, 4, '四次改动应按顺序各保存一次');
assert.deepEqual(quickWrites.map(item => item.调试), [true, false, false, false]);
assert.deepEqual(quickWrites.map(item => item.每楼记录), [true, true, false, true]);
assert.equal(serverGlobals['世界树·记账'].调试, false);
assert.equal(serverGlobals['世界树·记账'].每楼记录, true);
globals = clone(serverGlobals);
await emit('button:世界树：设置');
const reloadedForm = popupNodes.at(-1);
const [reloadedFloor, reloadedDebug] = checkboxes(reloadedForm);
assert.equal(reloadedDebug.properties.checked, false);
assert.equal(reloadedFloor.properties.checked, true);
console.log('13 连续修改 调试:true→false、每楼记录:false→true；关闭等待 4 次写入落盘，重载后仍为 false/true');

// ---------- 14. 正式记录、兼容负例与真实阻断 ----------
const stable = clone(chat);
const stableJSON = JSON.stringify(stable);
const statuses = [];
const restoreChat = async () => {
  chat.splice(0, chat.length, ...clone(stable));
  await emit('chat_id_changed');
  assert.ok(content().length > 0, '恢复合法聊天后应重新注入');
};
const blockedReload = async (label, mutate, expectedCode) => {
  chat.splice(0, chat.length, ...clone(stable));
  mutate(chat);
  const before = JSON.stringify(chat), writes = messageWrites, keeper = keeperCalls.length, stopped = stopCalls;
  await emit('chat_id_changed');
  assert.equal(JSON.stringify(chat), before, label + '：失配时原始变量必须保持不变');
  assert.equal(messageWrites, writes, label + '：校验失败不能写入任何楼层');
  const readOnlyShown = [...floors.values()].some(node => node.text().includes('存档只读'));
  if (!readOnlyShown) console.log('只读诊断', label, [...floors.entries()].map(([id, node]) => [id, node.text().slice(0, 120)]));
  assert.ok(readOnlyShown, label + '：界面应显示只读原因');
  await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
  assert.equal(stopCalls, stopped + 1, label + '：生成前应调用宿主停止生成');
  assert.equal(keeperCalls.length, keeper, label + '：阻断时不能调用记账');
  assert.equal(injected['yggdrasill-context'], undefined, label + '：阻断时应移除注入');
  assert.ok(toasts.some(item => item.level === 'error' && item.title?.includes(expectedCode)), label + '：应显示错误码 ' + expectedCode);
  statuses.push(label + '=' + expectedCode);
  await restoreChat();
};

const hash8 = sha256(Buffer.from(chat[8].mes, 'utf8'));
assert.equal(record(8).归属.正文指纹, hash8);
assert.deepEqual(record(8).归属, {楼号: 8, 角色: 'assistant', swipe: 0, 正文指纹: hash8});
for (const field of ['记录格式', '运行清单', '归属', '本局', '命令', '失败', '已写入', '记账'])
  assert.ok(Object.hasOwn(record(8), field), '正式记录缺少 ' + field);

await blockedReload('缺中间记录', states => { delete states[2].variables[0].世界树; }, '记录.缺失');
await blockedReload('正文归属失配', states => { states[2].mes = states[2].swipes[0] += '（改）'; }, '归属.失配');
await blockedReload('跨楼复制记录', states => { states[2].variables[0].世界树 = clone(states[8].variables[0].世界树); }, '归属.失配');
await blockedReload('快照重放失配', states => { states[2].variables[0].世界树.本局.世界.当前时间 = '损坏日期'; }, '重放.失配');
await blockedReload('程序指纹不同', states => { states[2].variables[0].世界树.运行清单.程序指纹 = '0'.repeat(64); }, '运行清单.程序指纹');
await blockedReload('世界书哈希不同（C 级破坏性冲突）', states => {
  states[2].variables[0].世界树.运行清单.世界书哈希 = '1'.repeat(64);
  states[2].variables[0].世界树.本局.世界.当前时间 = '损坏日期';
}, '运行清单.世界书哈希');
await blockedReload('记录格式不同', states => { states[2].variables[0].世界树.记录格式 = 2; }, '记录.格式');
await blockedReload('无清单旧记录', states => { delete states[2].variables[0].世界树.运行清单; }, '运行清单.缺失');
await blockedReload('无归属旧记录', states => { delete states[2].variables[0].世界树.归属; }, '归属.格式');
await blockedReload('混合卡ID', states => { states[4].variables[states[4].swipe_id].世界树.运行清单.卡ID = 'other.card'; }, '运行清单.卡ID');

// 玩家楼即使带着完整复制记录也不进入审计，不阻断合法助手楼。
chat.splice(0, chat.length, ...clone(stable));
chat[7].variables[0].世界树 = clone(chat[8].variables[0].世界树);
const playerCopy = clone(chat);
await emit('chat_id_changed');
assert.equal(JSON.stringify(chat), JSON.stringify(playerCopy));
assert.ok(content().length > 0, '玩家楼记录被忽略后仍应正常载入');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
await restoreChat();

// 程序指纹只有在当前清单的“兼容程序”明确列出时才行。
const oldProgram = 'a'.repeat(64);
chat[2].variables[0].世界树.运行清单.程序指纹 = oldProgram;
// 源 smoke 与 runtime 共享 JSON 模块，可改清单验证端到端；打包 runtime 有自己的模块实例，兼容性由上面的纯校验覆盖。
if (!entry) {
  const originalCompatible = [...bundle.manifest.兼容程序];
  try {
    bundle.manifest.兼容程序.push(oldProgram);
    await emit('chat_id_changed');
    assert.ok(content().length > 0, '兼容程序应允许载入');
    assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
  } finally {
    bundle.manifest.兼容程序 = originalCompatible;
  }
}
await restoreChat();
assert.equal(JSON.stringify(chat), stableJSON);
console.log('14 正式字段、SHA-256 归属、玩家楼忽略与兼容程序通过；负例：' + statuses.join('；'));

// ---------- 15. 记账失败、空命令与提交边界 ----------
const noCommands = state => JSON.stringify({时间: {方式: '不变', 日期: '', 事件ID: ''},
  地点: {地标: '', 场景: ''},
  在场: Object.entries(state.角色 ?? {}).filter(([id, run]) => id !== state.开局?.玩家?.扮演角色组 && run?.在场 === true).map(([id]) => id),
  发生的事件: [], 新情况: []});
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 2, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
keeperReplies.push(noCommands(record(6).本局));
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.deepEqual(record(8).命令, []);
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.应答格式, '提示词');
assert.ok(!('原始结果' in record(8).记账), '调试关闭时不得保留原始结果');

globals['世界树·记账'].调试 = true;
keeperReplies.push(noCommands(record(6).本局));
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.deepEqual(record(8).命令, []);
assert.ok(record(8).记账.原始结果, '调试开启时保留原始结果');
assert.doesNotMatch(JSON.stringify(record(8)), /sk-test|apiurl|密钥/);

globals['世界树·记账'].尝试次数 = 1;
keeperReplies.push('不是 JSON');
let callCount = keeperCalls.length;
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(keeperCalls.length, callCount + 1);
assert.equal(record(8).命令, null);
assert.equal(record(8).记账.状态, 'JSON失败');
assert.equal(record(8).失败[0].阶段, '记账');
assert.equal(record(8).失败[0].错误码, '记账.JSON');
assert.equal(record(8).记账.尝试次数, 1);

keeperThrowOnce = true;
callCount = keeperCalls.length;
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(keeperCalls.length, callCount + 1);
assert.equal(record(8).命令, null);
assert.equal(record(8).记账.状态, '调用失败');
assert.equal(record(8).失败[0].错误码, '记账.调用');

const beforeCommit = clone(record(8));
failNextMessageWrite = true;
keeperReplies.push(noCommands(record(6).本局));
try { await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click(); }
catch {}
assert.deepEqual(record(8), beforeCommit, '变量提交失败时应保留旧记录');
assert.ok(toasts.some(item => item.level === 'error' && /模拟变量提交失败/.test(item.body)), '提交失败应显示错误');
await restoreChat();
console.log('15 空命令=[], JSON/调用失败=null；调试外无原始结果；提交失败保留旧变量');

// ---------- 16. 迟到任务、继续生成与传播 ----------
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
push('请继续讲灯塔的旧事。', true);
await emit('message_sent', chat.length - 1);
push('旧正文', false);
const newFloor = chat.length - 1;
holdNextKeeper = true;
const oldReply = noCommands(record(8).本局);
const newReply = noCommands(record(8).本局);
keeperReplies.push(oldReply, newReply);
const pendingOld = emit('message_received', newFloor, 'normal');
await waitUntil(() => typeof releaseKeeper === 'function', '迟到的记账调用进入等待');
chat[newFloor].mes = chat[newFloor].swipes[chat[newFloor].swipe_id] = '新正文完整替换旧正文';
const pendingEdit = emit('message_edited', newFloor);
const release = releaseKeeper;
releaseKeeper = null;
release();
await Promise.all([pendingOld, pendingEdit]);
assert.equal(record(newFloor).归属.正文指纹, sha256(Buffer.from('新正文完整替换旧正文', 'utf8')));
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /新正文完整替换旧正文/);
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /## 要记账的正文\n新正文完整替换旧正文$/);

// 继续生成时完整正文进入一次记账，而不是只记追加部分。
const oldBody = chat[newFloor].mes;
chat[newFloor].mes = chat[newFloor].swipes[chat[newFloor].swipe_id] = oldBody + '\n灯影又向前延伸了一寸。';
keeperReplies.push(noCommands(record(newFloor).本局));
callCount = keeperCalls.length;
await emit('message_received', newFloor, 'continue');
assert.equal(keeperCalls.length, callCount + 1);
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /新正文完整替换旧正文/);
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /灯影又向前延伸了一寸/);

// 编辑玩家楼不调模型，只重放其后助手楼。
const beforeUserEdit = clone(chat);
chat[newFloor - 1].mes = chat[newFloor - 1].swipes[chat[newFloor - 1].swipe_id] = '请只讲旧事。';
callCount = keeperCalls.length;
await emit('message_edited', newFloor - 1);
assert.equal(keeperCalls.length, callCount, '编辑玩家楼不得调用模型');
assert.equal(record(newFloor).本局.世界.当前时间, beforeUserEdit[newFloor].variables[0].世界树.本局.世界.当前时间);

// 删除中间助手楼后，保留楼层的命令从可信起点重放，快照随之前移而不是只刷新。
chat.splice(0, chat.length, ...clone(stable));
await emit('chat_id_changed');
const removedBranch = record(2).本局.事件.秦守讲旧事.分支;
assert.ok(removedBranch);
chat.splice(2, 1);
await emit('message_deleted', chat.length);
const shifted = 3;
assert.equal(chat[shifted].is_user, false);
assert.equal(chat.some(message => message.variables[message.swipe_id]?.世界树?.本局?.事件?.秦守讲旧事 && message.is_user === false), false,
  '删除后保留楼层的本局不能再含已删除楼的事件');
await restoreChat();

// 重载当前合法聊天只校验与重放，不调用模型，也不改写记录。
const beforeReload = JSON.stringify(chat);
callCount = keeperCalls.length;
await emit('chat_id_changed');
assert.equal(keeperCalls.length, callCount);
assert.equal(JSON.stringify(chat), beforeReload);
console.log('16 迟到编辑任务不覆盖新正文；继续按完整正文记账；玩家编辑与重载不调模型；删除中间楼传播重算');

// ---------- 17. 删除、swipe 与聊天切换使旧任务失效 ----------
async function heldTask(label, action) {
  await restoreChat();
  globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
  serverGlobals = clone(globals);
  await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
  push('旧任务动作：' + label, true);
  await emit('message_sent', chat.length - 1);
  push('待作废正文：' + label, false);
  const id = chat.length - 1, text = chat[id].mes, fingerprint = sha256(Buffer.from(text, 'utf8'));
  const before = messageWrites;
  holdNextKeeper = true;
  keeperReplies.push(noCommands(record(8).本局));
  const pending = emit('message_received', id, 'normal');
  await waitUntil(() => typeof releaseKeeper === 'function', label + '：旧任务开始记账');
  const actionPending = action(id);
  const release = releaseKeeper;
  releaseKeeper = null;
  release();
  await pending;
  if (actionPending) await actionPending;
  assert.equal(messageWrites, before, label + '：旧任务不得覆盖新上下文');
  assert.ok(!chat.some(message => !message.is_user && message.variables[message.swipe_id]?.世界树?.归属?.正文指纹 === fingerprint),
    label + '：不应对旧正文留下记录');
  await restoreChat();
}
await heldTask('删除', async id => chat.splice(id, 1));
await heldTask('切 swipe', async id => {
  chat[id].swipes.push('新的空 swipe');
  chat[id].swipe_id = 1;
  chat[id].mes = chat[id].swipes[1];
  return emit('message_swiped', id);
});
await heldTask('切聊天', async () => {
  activeChatId = 'YG-ADAPTER-04-other-chat';
});
activeChatId = 'YG-ADAPTER-04-smoke-chat';
await restoreChat();
console.log('17 删除、切 swipe、切聊天时，等待中的旧记账任务均未写入旧正文');

// ---------- 18. 下游重放失败、队列等待与记账防重入 ----------
await restoreChat();
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
chat[2].mes = chat[2].swipes[0] = chat[2].mes + '（改写并推进时间）';
const ahead = JSON.stringify({时间: {方式: '写日期', 日期: '潮历071年04月25日', 事件ID: ''},
  地点: {地标: '', 场景: ''},
  在场: Object.entries(record(0).本局.角色).filter(([id, run]) => id !== record(0).本局.开局?.玩家?.扮演角色组 && run?.在场 === true).map(([id]) => id),
  发生的事件: [], 新情况: []});
keeperReplies.push(ahead);
callCount = keeperCalls.length;
await emit('message_edited', 2);
assert.equal(keeperCalls.length, callCount + 1, '编辑助手楼只调用一次本楼记账');
assert.equal(record(2).本局.世界.当前时间, '潮历071年04月25日');
assert.equal(record(4).本局.世界.当前时间, '潮历071年04月25日', '下游失败前的底本与已确认部分应保留');
assert.equal(record(4).失败.at(-1).阶段, '协议执行');
assert.deepEqual(record(4).命令, [], '下游失败命令不得保留为可重放命令');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
const stoppedAfterFailure = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stoppedAfterFailure + 1, '下游失败后从该处继续生成应被阻止');
assert.equal(keeperCalls.length, callCount + 1, '下游失败后不得自动调用模型重写');
await restoreChat();

// 叙事生成排在记账队列之后；记账自己的 generateRaw 事件在 keeping 标记下立即返回。
await restoreChat();
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
push('等待队列后再生成。', true);
await emit('message_sent', chat.length - 1);
push('队列中的正文', false);
const queuedFloor = chat.length - 1;
holdNextKeeper = true;
emitKeeperGeneration = true;
keeperReplies.push(noCommands(record(8).本局));
const pendingKeep = emit('message_received', queuedFloor, 'normal');
await waitUntil(() => typeof releaseKeeper === 'function', '队列等待：记账调用开始');
let generationDone = false, stoppedForQueue = stopCalls;
const pendingGeneration = emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false).then(() => { generationDone = true; });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(generationDone, false, '记账未完成时叙事生成必须等待');
const releaseQueue = releaseKeeper;
releaseKeeper = null;
releaseQueue();
await Promise.all([pendingKeep, pendingGeneration]);
emitKeeperGeneration = false;
assert.equal(generationDone, true);
assert.equal(stopCalls, stoppedForQueue, '合法队列完成后不应阻止生成');
assert.ok(record(queuedFloor), '队列中的助手楼应写入正式记录');
await restoreChat();
console.log('18 下游命令失配保留部分并阻断；生成等待记账队列；记账生成事件不递归等待');

// ---------- 19. 编辑前发现缺口或旧记录时不补写、不调模型 ----------
await restoreChat();
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
delete chat[4].variables[chat[4].swipe_id].世界树;
const beforeGapEdit = clone(chat[2].variables[chat[2].swipe_id].世界树);
chat[2].mes = chat[2].swipes[chat[2].swipe_id] = chat[2].mes + '（缺口测试）';
let writes = messageWrites;
callCount = keeperCalls.length;
await emit('message_edited', 2);
assert.equal(messageWrites, writes, '下游缺口存在时不得先改写本楼');
assert.equal(keeperCalls.length, callCount, '下游缺口存在时不得先调用模型');
assert.deepEqual(chat[2].variables[chat[2].swipe_id].世界树, beforeGapEdit);
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
await restoreChat();

delete chat[2].variables[chat[2].swipe_id].世界树.归属;
const beforeOldEdit = clone(chat[2].variables[chat[2].swipe_id].世界树);
chat[2].mes = chat[2].swipes[chat[2].swipe_id] = chat[2].mes + '（旧记录测试）';
writes = messageWrites;
callCount = keeperCalls.length;
await emit('message_edited', 2);
assert.equal(messageWrites, writes, '旧记录不得在编辑时自动补归属');
assert.equal(keeperCalls.length, callCount, '旧记录不得自动交给记账');
assert.deepEqual(chat[2].variables[chat[2].swipe_id].世界树, beforeOldEdit);
await restoreChat();
console.log('19 编辑前检查下游缺口与旧记录；均保持原始变量、不补写、不调模型');

// 编辑本楼前，不改写已失效的下游快照；先审计旧链并阻断。
await restoreChat();
globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
chat[4].variables[chat[4].swipe_id].世界树.本局.世界.当前时间 = '潮历0999年01月01日';
const invalidDownstream = clone(chat[4].variables[chat[4].swipe_id].世界树);
const unchangedFloor2 = clone(chat[2].variables[chat[2].swipe_id].世界树);
chat[2].mes = chat[2].swipes[chat[2].swipe_id] = chat[2].mes + '（旧链审计）';
writes = messageWrites;
callCount = keeperCalls.length;
await emit('message_edited', 2);
assert.equal(messageWrites, writes, '下游快照已失效时不得先改写本楼或其下游');
assert.equal(keeperCalls.length, callCount, '下游快照已失效时不得自动记账');
assert.deepEqual(chat[2].variables[chat[2].swipe_id].世界树, unchangedFloor2);
assert.deepEqual(chat[4].variables[chat[4].swipe_id].世界树, invalidDownstream);
await restoreChat();
console.log('20 编辑前旧链审计发现下游快照失配；保持整条链原来的楼层变量');

// ---------- 21. 记账默认值、时间顺序与 Schema 分类 ----------
// 21a 未保存设置默认提示词 JSON；旧布尔键双向映射，显式新键优先。
const formatSelect = form => find(form, item => item.tag === '<select>'
  && item.children.some(option => option.field === '结构化输出')
  && item.children.some(option => option.field === '提示词'));
const openKeeperSettings = async () => { await emit('button:世界树：设置'); return popupNodes.at(-1); };
const testKeeperConnection = async form => {
  keeperReplies.push('{"回答": "可以"}');
  await find(form, item => item.tag === '<button>' && item.value === '测试记账连接').handlers.click();
  return keeperCalls.at(-1);
};
globals = {};
let settingsForm = await openKeeperSettings();
assert.equal(formatSelect(settingsForm).field, '提示词', '未保存设置应默认提示词 JSON');
let probeRequest = await testKeeperConnection(settingsForm);
assert.equal(Object.hasOwn(probeRequest, 'json_schema'), false, '默认请求不得带 json_schema');
assert.match(probeRequest.ordered_prompts[0].content, /只输出一个 JSON 对象/);
assert.match(probeRequest.ordered_prompts[0].content, /须符合下面的 JSON Schema/);
globals = {'世界树·记账': {方式: '同一模型', 结构化输出: true}};
settingsForm = await openKeeperSettings();
assert.equal(formatSelect(settingsForm).field, '结构化输出', '旧键 true 应映射为结构化输出');
probeRequest = await testKeeperConnection(settingsForm);
assert.ok(probeRequest.json_schema, '旧键 true 的请求应带 json_schema');
globals = {'世界树·记账': {方式: '同一模型', 结构化输出: false}};
settingsForm = await openKeeperSettings();
assert.equal(formatSelect(settingsForm).field, '提示词', '旧键 false 应映射为提示词');
probeRequest = await testKeeperConnection(settingsForm);
assert.equal(Object.hasOwn(probeRequest, 'json_schema'), false, '旧键 false 的请求不得带 json_schema');
globals = {'世界树·记账': {方式: '同一模型', 结构化输出: true, 应答格式: '提示词'}};
settingsForm = await openKeeperSettings();
assert.equal(formatSelect(settingsForm).field, '提示词', '显式新键应压过旧键 true');
probeRequest = await testKeeperConnection(settingsForm);
assert.equal(Object.hasOwn(probeRequest, 'json_schema'), false, '显式新键提示词的请求不得带 json_schema');
globals = {'世界树·记账': {方式: '同一模型', 结构化输出: false, 应答格式: '结构化输出'}};
settingsForm = await openKeeperSettings();
assert.equal(formatSelect(settingsForm).field, '结构化输出', '显式新键应压过旧键 false');
probeRequest = await testKeeperConnection(settingsForm);
assert.ok(probeRequest.json_schema, '显式新键结构化输出的请求应带 json_schema');
console.log('21a 未保存设置默认提示词；旧键 true/false 双向映射；显式新键优先');

// 21b 时间边界与事件推进后的 cursor：倒退是转换错误，相等不写，前进才写。
const directKeeper = createBookkeeper({protocol, catalog: router.catalog, decl: router.decl});
const directOpen = applyCommands(protocol, seal(protocol, face.开局), face.开场命令).state;
const directAt = value => applyCommands(protocol, directOpen, [{写场景: {当前时间: value}}]).state;
const direct10 = directAt('潮历071年04月10日');
const presentOf = state => Object.entries(state.角色 ?? {})
  .filter(([id, run]) => id !== state.开局?.玩家?.扮演角色组 && run?.在场 === true).map(([id]) => id);
const directFull = (state, patch = {}) => ({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''},
  在场: presentOf(state), 发生的事件: [], 新情况: [], ...patch});
const withDate = (state, date, patch = {}) => directFull(state, {时间: {方式: '写日期', 日期: date, 事件ID: ''}, ...patch});
let times = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月01日'));
assert.deepEqual(times.commands, [], '倒退不得生成时间命令');
assert.equal(times.errors.length, 1);
assert.match(times.errors[0], /时间早于当前/);
times = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月10日'));
assert.deepEqual(times, {commands: [], errors: []}, '相等合法且不写时间');
times = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月11日'));
assert.deepEqual(times.commands, [{写场景: {当前时间: '潮历071年04月11日'}}], '前进才写当前时间');
assert.deepEqual(times.errors, []);
times = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月19日', {发生的事件: [{事件ID: '大雾之夜', 分支ID: '发生'}]}));
assert.deepEqual(times.commands, [{写场景: {当前时间: '潮历071年04月20日'}}, {确认事件: {事件ID: '大雾之夜', 分支ID: '发生'}}]);
assert.equal(times.errors.length, 1);
assert.match(times.errors[0], /时间早于当前：潮历071年04月19日.*潮历071年04月20日/, '事件推进后的 cursor 也须拒绝倒退');
times = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年13月01日'));
assert.deepEqual(times.commands, []);
assert.match(times.errors[0], /日期不合法/);
times = directKeeper.toCommands(direct10, directFull(direct10, {时间: {方式: '到事件开始', 日期: '', 事件ID: '不存在的事件'}}));
assert.deepEqual(times.commands, []);
assert.match(times.errors[0], /时间所引的事件不存在/);
times = directKeeper.toCommands(direct10, directFull(direct10));
assert.deepEqual(times, {commands: [], errors: []}, '方式不变保持既有行为');
console.log('21b 时间：倒退拒绝、相等不写、前进写入；事件推进后的 cursor 也拒绝倒退；非法日期与未知事件引用保持');

// 21c keeper.run 进入转换前按实际 Schema 校验；形状/枚举是 JSON失败，引用错配是转换失败。
const rejectsJson = (input, pattern) => assert.throws(() => directKeeper.run(direct10, input),
  error => error.code === '记账.JSON' && pattern.test(error.message), pattern.source);
rejectsJson({}, /缺少必填字段：时间/);
rejectsJson({时间: {方式: '不变'}}, /缺少必填字段：地点/);
rejectsJson({...directFull(direct10), 额外: 1}, /表外字段：额外/);
rejectsJson({...directFull(direct10), 时间: {方式: '倒退', 日期: '', 事件ID: ''}}, /不在允许值内：时间\.方式/);
rejectsJson({...directFull(direct10), 地点: {地标: '不存在', 场景: ''}}, /不在允许值内：地点\.地标/);
rejectsJson({...directFull(direct10), 在场: ['不存在']}, /不在允许值内：在场\[0\]/);
rejectsJson({...directFull(direct10), 发生的事件: ['拜师']}, /须为映射：发生的事件\[0\]/);
rejectsJson({...directFull(direct10), 新情况: [{事件ID: '测试', 摘要: 'x', 变化: '坏'}]}, /须为列表：新情况\[0\]\.变化/);
rejectsJson({...directFull(direct10), 新情况: [{事件ID: '测试', 摘要: 'x', 变化: [{路径: '角色.灯塔学徒.身份', 操作: '乱写', 值: 'x'}]}]},
  /不在允许值内：新情况\[0\]\.变化\[0\]\.操作/);
let converted = directKeeper.run(direct10, {...directFull(direct10), 发生的事件: [{事件ID: '不存在的事件', 分支ID: '发生'}]});
assert.deepEqual(converted.commands, []);
assert.equal(converted.失败[0].错误码, '记账.结果');
assert.match(converted.失败[0].说明, /没有这个事件/);
converted = directKeeper.run(direct10, {...directFull(direct10), 发生的事件: [{事件ID: '拜师', 分支ID: '发生'}]});
assert.deepEqual(converted.commands, [], '错配分支不得进入确认事件');
assert.equal(converted.失败[0].错误码, '记账.结果');
assert.match(converted.失败[0].说明, /分支不属于该事件/);
converted = directKeeper.run(direct10, {...directFull(direct10), 发生的事件: [{事件ID: '拜师', 分支ID: '不存在的分支'}]});
assert.deepEqual(converted.commands, []);
assert.match(converted.失败[0].说明, /分支不属于该事件/);
const emptyRun = directKeeper.run(direct10, directFull(direct10));
assert.deepEqual(emptyRun.commands, [], '合法空结果仍允许命令 []');
assert.deepEqual(emptyRun.失败, []);

// 待登记事件不在候选/将到视图，但必须在可确认引用中，且合法确认不被 Schema 误拒。
const pendingState = clone(directOpen);
pendingState.世界.当前时间 = '潮历071年04月21日';
const pendingItems = protocol.pendingEvents(pendingState);
assert.ok(pendingItems.length > 0);
const pendingRequest = directKeeper.request(pendingState, {input: '', narration: '测试正文'});
const pendingSystem = pendingRequest.prompts[0].content;
assert.match(pendingSystem, /待登记事件/);
const pendingEnum = pendingRequest.schema.value.properties.发生的事件.items.properties.事件ID.enum;
for (const item of pendingItems) {
  assert.ok(pendingSystem.includes(item.事件ID), `待登记事件 ${item.事件ID} 应出现在 prompts/facts 中`);
  assert.ok(pendingSystem.includes(item.分支ID), `待登记分支 ${item.事件ID}/${item.分支ID} 应出现在 prompts/facts 中`);
  const pendingEvent = router.catalog.events.find(event => event.id === item.事件ID);
  if (pendingEvent.内容.事件标题) assert.ok(pendingSystem.includes(pendingEvent.内容.事件标题), `待登记事件 ${item.事件ID} 的标题应出现在 facts 中`);
  assert.ok(pendingSystem.includes(pendingEvent.内容.事件概要), `待登记事件 ${item.事件ID} 的概要应出现在 facts 中`);
  assert.ok(pendingEnum.includes(item.事件ID), `待登记事件 ${item.事件ID} 应进入可确认枚举`);
}
const pendingItem = pendingItems[0];
const pendingRun = directKeeper.run(pendingState, {...directFull(pendingState),
  发生的事件: [{事件ID: pendingItem.事件ID, 分支ID: pendingItem.分支ID}]});
assert.deepEqual(pendingRun.失败, []);
assert.ok(pendingRun.已写入.includes(pendingItem.事件ID), '合法待登记事件应被确认');

// 时间倒退与合法地点/在场/新情况并存：只拒绝时间，其余仍执行；本局时间不回退。
const mixed = directKeeper.run(direct10, withDate(direct10, '潮历071年04月01日', {
  地点: {地标: '码头区', 场景: '栈桥'}, 在场: ['灯塔学徒', '秦守'],
  新情况: [{事件ID: '开窗', 摘要: '学徒推开窗。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '窗外起雾'}]}]}));
assert.equal(mixed.state.世界.当前时间, '潮历071年04月10日', '时间倒退不得写入');
assert.equal(mixed.state.世界.当前地点.地标, '码头区', '合法地点仍应执行');
assert.equal(mixed.state.角色.秦守.在场, true, '合法在场仍应执行');
assert.ok(mixed.commands.some(command => command.动态事件?.事件ID === '开窗'), '合法新情况仍应执行');
assert.ok(mixed.失败.some(item => item.错误码 === '记账.结果' && /时间早于当前/.test(item.说明)));
console.log('21c {}、缺字段、表外键、非法方式/地点/操作/形状均为 JSON失败；未知事件与跨事件分支为转换失败；待登记事件出现在 prompts/facts 与枚举中且同分支确认合法；时间错误不丢合法变化');

// 21d 真实记账路径：默认提示词、倒退部分失败、{} JSON失败、非法分支转换失败；两种传输都走同一校验。
const rekeepButton = () => find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账');
let floorBase = clone(record(6).本局);
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 2, 调试: false, 每楼记录: true}};
const regressionReply = JSON.stringify(withDate(floorBase, '潮历071年04月01日', {
  地点: {地标: floorBase.世界.当前地点?.地标 === '码头区' ? '灯塔' : '码头区', 场景: '栈桥'}, 在场: presentOf(floorBase)}));
keeperReplies.push(regressionReply, regressionReply);
let rekeepCalls = keeperCalls.length;
await rekeepButton().handlers.click();
assert.equal(keeperCalls.length, rekeepCalls + 2, '转换错误按现有重试路径再调用一次');
assert.equal(record(8).记账.状态, '部分失败', '时间倒退不得记成功');
assert.equal(record(8).记账.应答格式, '提示词');
assert.equal(record(8).记账.尝试次数, 2);
assert.equal(record(8).记账.重试, 1);
assert.equal(record(8).本局.世界.当前时间, floorBase.世界.当前时间, '时间倒退后本局时间不变');
assert.notEqual(record(8).本局.世界.当前地点.地标, floorBase.世界.当前地点?.地标, '合法地点仍写入');
assert.ok(record(8).失败.some(item => item.错误码 === '记账.结果' && /时间早于当前/.test(item.说明)));
assert.ok(record(8).命令.length > 0, '命令列表保留合法写场景，不能是 null');
assert.equal(Object.hasOwn(keeperCalls.at(-1), 'json_schema'), false, '提示词路径不得带 json_schema');

globals['世界树·记账'].尝试次数 = 1;
keeperReplies.push('{}');
await rekeepButton().handlers.click();
assert.equal(record(8).命令, null);
assert.equal(record(8).记账.状态, 'JSON失败');
assert.equal(record(8).失败[0].错误码, '记账.JSON');
assert.deepEqual(record(8).本局, floorBase, 'JSON失败保存正文前底本');

keeperReplies.push(JSON.stringify({...directFull(floorBase), 时间: {方式: '倒退', 日期: '', 事件ID: ''}}));
await rekeepButton().handlers.click();
assert.equal(record(8).命令, null);
assert.equal(record(8).记账.状态, 'JSON失败');
assert.equal(record(8).失败[0].错误码, '记账.JSON');

keeperReplies.push(JSON.stringify({...directFull(floorBase), 发生的事件: [{事件ID: '拜师', 分支ID: '发生'}]}));
await rekeepButton().handlers.click();
assert.equal(record(8).记账.状态, '部分失败');
assert.deepEqual(record(8).命令, []);
assert.equal(record(8).失败[0].错误码, '记账.结果');
assert.ok(!record(8).失败.some(item => item.阶段 === '协议执行'), '跨事件分支不得落到协议执行');
assert.deepEqual(record(8).本局, floorBase);

keeperReplies.push(noCommands(floorBase));
await rekeepButton().handlers.click();
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.应答格式, '提示词');
assert.deepEqual(record(8).命令, []);

globals['世界树·记账'] = {...globals['世界树·记账'], 应答格式: '结构化输出'};
keeperReplies.push(noCommands(floorBase));
await rekeepButton().handlers.click();
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.应答格式, '结构化输出');
assert.ok(keeperCalls.at(-1).json_schema, '显式结构化输出应带 json_schema');
keeperReplies.push('{}');
await rekeepButton().handlers.click();
await waitUntil(() => record(8).记账.状态 === 'JSON失败' && record(8).命令 === null, '结构化输出 JSON失败');
assert.equal(record(8).失败[0].错误码, '记账.JSON');

// Schema 失败也走同一重试路径：第一次 `{}` 失败，第二次合法结果成功。
globals['世界树·记账'] = {...globals['世界树·记账'], 尝试次数: 2, 应答格式: '结构化输出', 调试: true};
keeperReplies.push('{}', noCommands(floorBase));
await rekeepButton().handlers.click();
await waitUntil(() => record(8).记账.状态 === '成功' && record(8).记账.尝试次数 === 2, 'Schema失败后重试成功');
assert.equal(record(8).记账.重试, 1);
assert.deepEqual(record(8).命令, []);
assert.deepEqual(record(8).失败, []);
assert.ok(record(8).记账.原始结果, '重试成功后保留合法原始结果');
console.log('21d 固定响应：默认提示词、倒退部分失败且合法写场景保留、{} JSON失败、跨事件分支转换失败；提示词与结构化输出都走同一 Schema；Schema失败重试成功');

// ---------- 22. 写场景拆分、同起点排序与离场者所在 ----------
const splitCommands = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '码头区', 场景: '栈桥'}, 在场: ['灯塔学徒']}));
assert.deepEqual(splitCommands.commands, [
  {写场景: {当前时间: '潮历071年04月12日'}},
  {写场景: {当前地点: {地标: '码头区', 场景: '栈桥'}}},
  {写场景: {在场: {秦守: false}, 所在: {秦守: '灯塔'}}},
], '时间、地点与在场应各自一条写场景，离场者的所在取换场前地标');
const splitRun = directKeeper.run(direct10, withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '码头区', 场景: '栈桥'}, 在场: ['灯塔学徒']}));
assert.deepEqual(splitRun.失败, []);
assert.equal(splitRun.state.世界.当前时间, '潮历071年04月12日');
assert.equal(splitRun.state.世界.当前地点.地标, '码头区');
assert.equal(splitRun.state.角色.秦守.在场, false);
assert.equal(splitRun.state.角色.秦守.所在, '灯塔');

// 初始化命令与写场景已经分槽：确认初始化失败时，后面的时间与在场仍执行。
const brokenInit = applyCommands(protocol, direct10, [
  {确认初始化: {角色组ID: '不存在'}},
  {写场景: {当前时间: '潮历071年04月12日'}},
  {写场景: {在场: {秦守: false}, 所在: {秦守: '灯塔'}}},
]);
assert.equal(brokenInit.失败.length, 1);
assert.equal(brokenInit.失败[0].命令, '确认初始化');
assert.equal(brokenInit.state.世界.当前时间, '潮历071年04月12日');
assert.equal(brokenInit.state.角色.秦守.在场, false);
assert.equal(brokenInit.state.角色.秦守.所在, '灯塔');

const brokenPlace = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '不存在', 场景: '栈桥'}, 在场: ['灯塔学徒']}));
const brokenApplied = applyCommands(protocol, direct10, brokenPlace.commands);
assert.equal(brokenApplied.失败.length, 1);
assert.equal(brokenApplied.失败[0].错误码, '协议.参数');
assert.ok(brokenApplied.state.世界.当前时间 === '潮历071年04月12日', '地点失败不得拖垮合法时间');
assert.equal(brokenApplied.state.角色.秦守.在场, false, '地点失败不得拖垮合法在场');
assert.equal(brokenApplied.state.角色.秦守.所在, '灯塔');

const sameStart = ['白棠在码头', '学徒守灯', '大雾之夜'];
const sameBranch = id => router.catalog.events.find(event => event.id === id)?.内容?.分支?.[0]?.分支ID;
const sameInput = ids => ids.map(id => ({事件ID: id, 分支ID: sameBranch(id)}));
const sameForward = directKeeper.toCommands(direct10, directFull(direct10, {发生的事件: sameInput(sameStart)}));
const sameReverse = directKeeper.toCommands(direct10, directFull(direct10, {发生的事件: sameInput([...sameStart].reverse())}));
const sameRepeat = directKeeper.toCommands(direct10, directFull(direct10, {发生的事件: sameInput([...sameStart].reverse())}));
assert.deepEqual(sameForward.commands, sameReverse.commands, '同起点事件不得随输入数组顺序改变命令');
assert.deepEqual(sameReverse.commands, sameRepeat.commands, '重复运行命令序列应一致');
assert.deepEqual(sameReverse.commands.filter(command => command.确认事件).map(command => command.确认事件.事件ID),
  ['大雾之夜', '学徒守灯', '白棠在码头']);

// 同回合事件与新角色：确认初始化必须先于事件起点与确认事件，初次登场按事件前状态与时间写入。
const sameTurnResult = withDate(direct10, '潮历071年04月20日', {
  在场: ['灯塔学徒', '白棠'], 发生的事件: [{事件ID: '大雾之夜', 分支ID: '发生'}]});
const sameTurn = directKeeper.toCommands(direct10, sameTurnResult);
const initIndex = sameTurn.commands.findIndex(command => command.确认初始化?.角色组ID === '白棠');
const timeIndex = sameTurn.commands.findIndex(command => command.写场景?.当前时间 === '潮历071年04月20日');
const eventIndex = sameTurn.commands.findIndex(command => command.确认事件?.事件ID === '大雾之夜');
assert.ok(initIndex >= 0 && timeIndex > initIndex && eventIndex > timeIndex,
  '确认初始化应先于事件起点时间与确认事件');
const sameTurnRun = directKeeper.run(direct10, sameTurnResult);
assert.deepEqual(sameTurnRun.失败, []);
assert.equal(sameTurnRun.state.角色.白棠.已初始化, true);
assert.equal(sameTurnRun.state.事件['初次登场·白棠'].实际时间, '潮历071年04月10日', '初次登场应发生在事件推进前');
assert.equal(sameTurnRun.state.事件['大雾之夜'].实际时间, '潮历071年04月20日');
assert.equal(sameTurnRun.state.角色.白棠.在场, true);

// 档案选择必须取事件前的状态：潮汐号首航确认后才成立的航海期档案含旧罗盘，初始化先于事件就不得带上。
const profileState = clone(direct10);
profileState.世界.当前时间 = '潮历072年02月20日';
profileState.开局.角色组.白棠.版本ID = '白棠·船长';
const profileResult = withDate(profileState, '潮历072年03月01日', {
  在场: ['灯塔学徒', '白棠'], 发生的事件: [{事件ID: '潮汐号首航', 分支ID: '启航'}]});
const profileRun = directKeeper.run(profileState, profileResult);
assert.deepEqual(profileRun.失败, []);
assert.equal(profileRun.state.角色.白棠.已初始化, true);
assert.equal(profileRun.state.角色.白棠.装备, undefined, '初始化先于事件，不得采用事件后才成立的航海期初始装备');
assert.equal(profileRun.state.事件['初次登场·白棠'].实际时间, '潮历072年02月20日');
assert.equal(profileRun.state.事件['潮汐号首航'].状态, 1);
assert.ok(profileRun.state.角色.白棠.身份.includes('潮汐号船长'), '合法事件变化仍应执行');
console.log('22 写场景拆分：时间/地点/在场各一条，离场者所在=换场前地标；地点失败不影响时间与在场；同起点按事件ID码点，逆序与重复运行一致；同回合初始化先于事件，档案按事件前状态');

// ---------- 22b. keeper.run 协议失败命令剔除 ----------
// 真实 run()：同一次输入里一条动态事件因未声明路径被协议拒绝，合法时间/地点/在场与另一条新情况仍执行。
const protocolFailInput = withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '码头区', 场景: '栈桥'}, 在场: ['灯塔学徒'],
  新情况: [
    {事件ID: '坏命令', 摘要: '写不存在的角色字段。', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
    {事件ID: '好命令', 摘要: '记下窗外起雾。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '窗外起雾'}]},
  ]});
const protocolFail = directKeeper.run(direct10, protocolFailInput);
assert.equal(protocolFail.失败.length, 1, '只应报告一条协议失败');
assert.equal(protocolFail.失败[0].序号, 4, '失败序号应保留原命令索引');
assert.equal(protocolFail.失败[0].错误码, '协议.变化');
assert.equal(protocolFail.失败[0].命令, '动态事件');
assert.deepEqual(protocolFail.commands.map(command => Object.keys(command)[0]), ['写场景', '写场景', '写场景', '动态事件']);
assert.ok(!protocolFail.commands.some(command => command.动态事件?.事件ID === '坏命令'), '失败命令不得进入最终记录命令');
assert.equal(protocolFail.state.世界.当前时间, '潮历071年04月12日', '合法时间仍执行');
assert.equal(protocolFail.state.世界.当前地点.地标, '码头区', '合法地点仍执行');
assert.equal(protocolFail.state.角色.秦守.在场, false, '合法在场仍执行');
assert.equal(protocolFail.state.角色.秦守.所在, '灯塔', '离场者旧所在仍写入');
assert.deepEqual(protocolFail.state.角色.灯塔学徒.知识, ['窗外起雾'], '合法新情况仍执行');
assert.ok(protocolFail.已写入.includes('好命令'));
assert.ok(!('坏命令' in protocolFail.state.事件));
// 既有分类：转换错误没有序号，协议执行错误有序号。
assert.equal(Object.hasOwn(converted.失败[0], '序号'), false, '转换错误不带协议序号');
assert.ok(Object.hasOwn(protocolFail.失败[0], '序号'), '协议执行错误带协议序号');
console.log('22b keeper.run：协议失败命令按原序号剔除且不进入命令列表；同批合法时间/地点/在场/新情况仍执行；转换错误无序号、协议执行错误有序号的分类保持');

// ---------- 22c. 新地标空场景不继承旧场景 ----------
const sceneOf = (state, landmark, scene) => {
  const result = directKeeper.toCommands(state, {...directFull(state), 地点: {地标: landmark, 场景: scene}});
  assert.deepEqual(result.errors, []);
  return result.commands.find(command => command.写场景?.当前地点)?.写场景.当前地点 ?? null;
};
assert.deepEqual(sceneOf(direct10, '码头区', '栈桥'), {地标: '码头区', 场景: '栈桥'}, '模型给非空场景时直接使用');
assert.deepEqual(sceneOf(direct10, '灯塔', ''), {地标: '灯塔', 场景: '值守室'}, '同地标空场景保留旧场景');
const bareScene = clone(direct10);
bareScene.世界.当前地点 = {地标: '灯塔', 场景: ''};
assert.deepEqual(sceneOf(bareScene, '灯塔', ''), {地标: '灯塔', 场景: '灯塔'}, '同地标空场景且旧场景也为空时回退到地标');
assert.deepEqual(sceneOf(direct10, '码头区', ''), {地标: '码头区', 场景: '码头区'}, '新地标空场景不继承旧场景');
const newLandmark = directKeeper.toCommands(direct10, withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '码头区', 场景: ''}, 在场: ['灯塔学徒']}));
assert.deepEqual(newLandmark.commands, [
  {写场景: {当前时间: '潮历071年04月12日'}},
  {写场景: {当前地点: {地标: '码头区', 场景: '码头区'}}},
  {写场景: {在场: {秦守: false}, 所在: {秦守: '灯塔'}}},
], '新地标空场景与离场拆分、离场者旧所在保持');
const newLandmarkRun = directKeeper.run(direct10, withDate(direct10, '潮历071年04月12日', {
  地点: {地标: '码头区', 场景: ''}, 在场: ['灯塔学徒']}));
assert.deepEqual(newLandmarkRun.失败, []);
assert.deepEqual(newLandmarkRun.state.世界.当前地点, {地标: '码头区', 场景: '码头区'});
assert.equal(newLandmarkRun.state.角色.秦守.所在, '灯塔');
console.log('22c 场景回退：模型非空场景直接使用；同地标空场景保留旧场景、旧场景为空时回退地标；新地标空场景用新地标且不带旧场景；地点拆分与离场者旧所在不回退');

// ---------- 23. 自建档案：文本、预览、提交同源 ----------
const planCatalog = clone(router.catalog);
planCatalog.openingPlans.push({id: '测试方案', 内容: {概述: '方案自带玩家档案。',
  玩家: {模式: '自建', 档案: {姓名: '方案甲'}}}});
const planProtocol = createProtocol({catalog: planCatalog, decl: router.decl});
const profileDraft = createOpeningDraft({protocol: planProtocol, catalog: planCatalog, decl: router.decl,
  defaults: face.开局, commands: face.开场命令});
profileDraft.setPlan('测试方案');
const planSnapshot = profileDraft.snapshot();
assert.deepEqual(planSnapshot.玩家, {模式: '自建', 档案: {姓名: '方案甲'}});
assert.deepEqual(planSnapshot.预览.开局.玩家, {模式: '自建', 档案: {姓名: '方案甲'}});
assert.deepEqual(parseYaml(planSnapshot.档案文本), {姓名: '方案甲'}, '未编辑时方案档案应同步到文本框');

profileDraft.setProfileText('姓名: 海生\n出生年: 潮历050年\n');
const typedProfile = {姓名: '海生', 出生年: '潮历050年'};
profileDraft.setPlayerMode('扮演');
profileDraft.setPlayerMode('自建');
const roundTrip = profileDraft.snapshot();
assert.deepEqual(roundTrip.玩家, {模式: '自建', 档案: typedProfile});
assert.deepEqual(roundTrip.预览.开局.玩家.档案, typedProfile);
assert.deepEqual(parseYaml(roundTrip.档案文本), typedProfile);
const profilePrepared = profileDraft.prepare();
assert.equal(profilePrepared.ok, true);
assert.deepEqual(profilePrepared.record.本局.开局.玩家, {模式: '自建', 档案: typedProfile});

profileDraft.setPlan('补考之年');
assert.deepEqual(profileDraft.snapshot().玩家.档案, typedProfile, '换方案不得覆盖用户编辑过的档案');

const invalidYaml = createOpeningDraft({protocol: planProtocol, catalog: planCatalog, decl: router.decl,
  defaults: face.开局, commands: face.开场命令});
invalidYaml.setProfileText('姓名: 旧值\n');
invalidYaml.setProfileText('[');
assert.equal(invalidYaml.snapshot().错误.code, '开局.档案');
assert.deepEqual(invalidYaml.snapshot().预览.开局.玩家.档案, {姓名: '旧值'}, '解析失败不得覆盖最后有效草稿');
assert.equal(invalidYaml.prepare().ok, false, '解析失败不得按最后有效草稿静默提交');
assert.equal(invalidYaml.snapshot().档案文本, '[', '文本框保留用户输入以显示错误');

const scalarDraft = createOpeningDraft({protocol: planProtocol, catalog: planCatalog, decl: router.decl,
  defaults: face.开局, commands: face.开场命令});
scalarDraft.setProfileText('- 不是映射\n');
assert.equal(scalarDraft.snapshot().错误.code, '开局.档案');
assert.match(scalarDraft.snapshot().错误.说明, /YAML 映射/);
assert.equal(scalarDraft.prepare().ok, false);
const arrayDraft = createOpeningDraft({protocol: planProtocol, catalog: planCatalog, decl: router.decl,
  defaults: face.开局, commands: face.开场命令});
arrayDraft.setProfileText('[1, 2]\n');
assert.equal(arrayDraft.snapshot().错误.code, '开局.档案');
assert.equal(arrayDraft.prepare().ok, false);

// 非法档案只在自建模式阻断；切到扮演后合法预览必须能提交，切回自建原错误仍在，修正后可继续。
const roleplayAfterProfile = text => {
  const draft = createOpeningDraft({protocol: planProtocol, catalog: planCatalog, decl: router.decl,
    defaults: face.开局, commands: face.开场命令});
  const invalid = draft.setProfileText(text);
  assert.equal(invalid.ok, false, `${text} 应明确失败`);
  assert.equal(invalid.error.code, '开局.档案');
  assert.equal(draft.setPlayerMode('扮演').ok, true, `${text} 切扮演不应被档案错误阻断`);
  assert.equal(draft.setPlayerGroup('白棠').ok, true);
  const roleplay = draft.snapshot();
  assert.equal(roleplay.错误, null, `${text} 扮演模式不应显示自建档案错误`);
  assert.equal(roleplay.玩家.模式, '扮演');
  assert.ok(roleplay.预览, '扮演预览应合法');
  const prepared = draft.prepare();
  assert.equal(prepared.ok, true, `${text} 扮演提交应成功`);
  assert.deepEqual(prepared.record.本局.开局.玩家, {模式: '扮演', 扮演角色组: '白棠'});
  assert.equal(draft.setPlayerMode('自建').ok, false, `${text} 切回自建应恢复原错误`);
  assert.equal(draft.snapshot().错误.code, '开局.档案');
  assert.equal(draft.snapshot().档案文本, text, '文本框应保留非法输入');
  assert.equal(draft.prepare().ok, false, `${text} 未修正不得提交`);
  assert.equal(draft.setProfileText('姓名: 海生\n').ok, true);
  const fixed = draft.prepare();
  assert.equal(fixed.ok, true, `${text} 修正后应可提交`);
  assert.deepEqual(fixed.record.本局.开局.玩家.档案, {姓名: '海生'});
};
for (const text of ['[', '42', '[1, 2]']) roleplayAfterProfile(text);
console.log('23 档案草稿/文本框/预览/提交同源；方案档案在未编辑时同步，编辑后换方案保留；YAML/标量/数组失败均明确拒绝且不覆盖最后有效草稿；非法档案只在自建阻断，切扮演可提交，切回自建仍报错，修正后可提交');

// ---------- 24. 权限不足：脚本、宿主 API 与关闭模式局部正则 ----------
await restoreChat();
globals = {'世界树·记账': {方式: '关闭'}};
serverGlobals = clone(globals);
const permissionText = () => [...floors.values()].map(node => node.text()).find(text => text.includes('权限不足')) ?? '';
const resetCardState = () => Object.assign(cardState, {avatar: '雾港.png', scriptId: bundle.权限.脚本ID,
  scriptPresent: true, scriptEnabled: true, regexId: bundle.权限.正则ID, regexPresent: true,
  regexDisabled: false, regexPlacement: [2], allowedRegex: ['雾港.png']});
const recoverPermission = async () => {
  resetCardState();
  await emit('chat_id_changed');
  assert.ok(content().length > 0, '权限恢复后应重新注入');
  assert.equal(permissionText(), '', '权限恢复后不应保留权限不足提示');
};
const permissionFault = async (label, patch, code) => {
  resetCardState();
  Object.assign(cardState, patch);
  const stopped = stopCalls, writes = messageWrites;
  await emit('chat_id_changed');
  assert.ok(permissionText().includes(code), label + '：应显示 ' + code);
  assert.doesNotMatch(permissionText(), /存档只读/, label + '：权限不足不得误写为存档只读');
  assert.ok(toasts.some(item => item.level === 'error' && item.title?.includes('权限不足')), label + '：应有权限不足 toast');
  assert.equal(injected['yggdrasill-context'], undefined, label + '：权限失败应清除注入');
  await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
  assert.equal(stopCalls, stopped + 1, label + '：生成前应停止宿主生成');
  assert.equal(messageWrites, writes, label + '：权限失败不得写楼层变量');
  await recoverPermission();
};
await permissionFault('脚本缺失', {scriptPresent: false}, '权限.脚本');
await permissionFault('脚本停用', {scriptPresent: true, scriptEnabled: false}, '权限.脚本');
await permissionFault('脚本 ID 不一致', {scriptId: '00000000-0000-4000-8000-000000000000'}, '权限.脚本');
await permissionFault('局部正则缺失', {regexPresent: false}, '权限.正则');
await permissionFault('局部正则停用', {regexPresent: true, regexDisabled: true}, '权限.正则');
await permissionFault('局部正则 placement 不含 2', {regexPlacement: [1]}, '权限.正则');
await permissionFault('未授权 character_allowed_regex', {allowedRegex: []}, '权限.正则');

// 开启记账时正文不含命令，不依赖局部正则；同样的正则故障不应阻断。
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 每楼记录: true}};
serverGlobals = clone(globals);
resetCardState();
await emit('chat_id_changed');
cardState.regexPresent = false;
const noRegexStop = stopCalls;
await emit('chat_id_changed');
assert.equal(permissionText(), '', '开启记账时局部正则故障不得报权限不足');
assert.ok(content().length > 0);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, noRegexStop, '开启记账时局部正则故障不得阻断生成');

// 宿主 API 缺失按脚本/API 权限处理；恢复后可继续。
const savedGenerateRaw = globalThis.generateRaw;
delete globalThis.generateRaw;
const stoppedForApi = stopCalls;
await emit('chat_id_changed');
assert.ok(permissionText().includes('权限.脚本'), '宿主 API 缺失应报 权限.脚本');
assert.match(permissionText(), /generateRaw/);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stoppedForApi + 1);
globalThis.generateRaw = savedGenerateRaw;
await recoverPermission();

// 权限诊断自身缺少 $ 或 toastr 时：不得抛未捕获异常，仍清理可用注入、停止生成，并保留诊断。
const savedDollar = globalThis.$, savedToastr = globalThis.toastr;
const stopNoRender = stopCalls, writesNoRender = messageWrites, keeperNoRender = keeperCalls.length;
delete globalThis.$;
const toastMark = toasts.length;
await emit('chat_id_changed');
assert.equal(injected['yggdrasill-context'], undefined, '缺少 $ 时仍应清除注入');
assert.equal(messageWrites, writesNoRender, '缺少 $ 时不得写楼层变量');
assert.equal(keeperCalls.length, keeperNoRender, '缺少 $ 时不得调用模型');
assert.ok(toasts.slice(toastMark).some(item => item.title?.includes('权限不足')), '缺少 $ 时应使用可用 toast 保留诊断');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopNoRender + 1, '缺少 $ 时仍应停止生成');
globalThis.$ = savedDollar;
await recoverPermission();

const stopNoToast = stopCalls, writesNoToast = messageWrites, keeperNoToast = keeperCalls.length;
const consoleLogged = [], savedConsoleError = console.error;
console.error = (...args) => { consoleLogged.push(args.join(' ')); };
delete globalThis.toastr;
try {
  await emit('chat_id_changed');
  assert.ok(permissionText().includes('权限.脚本'), '缺少 toastr 时仍应渲染权限节点');
  assert.match(permissionText(), /toastr/);
  assert.equal(injected['yggdrasill-context'], undefined, '缺少 toastr 时仍应清除注入');
  assert.equal(messageWrites, writesNoToast, '缺少 toastr 时不得写楼层变量');
  assert.equal(keeperCalls.length, keeperNoToast, '缺少 toastr 时不得调用模型');
  await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
  assert.equal(stopCalls, stopNoToast + 1, '缺少 toastr 时仍应停止生成');
} finally {
  console.error = savedConsoleError;
  globalThis.toastr = savedToastr;
}
assert.ok(consoleLogged.some(text => text.includes('权限.脚本')), '缺少 toastr 时控制台保留权限诊断');
await recoverPermission();
console.log('24 脚本缺失/停用/ID 不符、宿主 API 缺失均报 权限.脚本；关闭记账时正则缺失/停用/placement/未授权报 权限.正则；均清除注入并阻断，恢复后继续；开启记账不受正则故障影响；缺少 $ 或 toastr 时诊断不抛错，仍清理注入并停止生成');

// ---------- 25. 模式无关的卡面、预设与共享模板 ----------
const preset = JSON.parse(await fs.readFile(new URL('../presets/yggdrasill.json', import.meta.url), 'utf8'));
const presetMain = preset.prompts.find(item => item.identifier === 'main')?.content ?? '';
assert.doesNotMatch(face.描述, /只写正文/);
assert.doesNotMatch(face.描述, /另行记账/, '卡面不得把独立记账写成关闭模式的工作');
assert.match(face.描述, /本局状态由系统维护/);
assert.doesNotMatch(presetMain, /不包含标签、YAML 或命令/);
assert.doesNotMatch(presetMain, /另行记账/);
assert.match(presetMain, /本局状态由系统维护/);
assert.doesNotMatch(bundle.templates.角色通用约束, /写成命令/);
assert.doesNotMatch(bundle.templates.扮演准则, /写场景|确认初始化/);
assert.match(bundle.templates.变量更新规则, /<命令>/);
assert.match(bundle.templates.变量更新规则, /写场景/);
assert.equal((bundle.templates.角色通用约束.match(/<命令>/g) ?? []).length, 0);
assert.equal((bundle.templates.扮演准则.match(/<命令>/g) ?? []).length, 0);

globals = {'世界树·记账': {方式: '关闭'}};
serverGlobals = clone(globals);
await emit('chat_id_changed');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.match(content(), /# 变量更新规则/);
assert.match(content(), /<命令>/);
assert.match(content(), /写场景: \{当前时间/);
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词'}};
serverGlobals = clone(globals);
await emit('chat_id_changed');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.doesNotMatch(content(), /# 变量更新规则/);
assert.doesNotMatch(content(), /写成命令|写场景: \{|确认初始化: \{/);
assert.match(content(), /也不写 <命令>/);
await restoreChat();
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 每楼记录: true}};
serverGlobals = clone(globals);
await emit('chat_id_changed');
const quietBase = record(8).本局;
keeperReplies.length = 0;
keeperReplies.push(noCommands(quietBase));
await rekeepButton().handlers.click();
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.应答格式, '提示词');
console.log('25 卡面/预设/共享模板不再出现模式相反的写命令要求；关闭模式注入变量更新规则与 <命令>，开启模式注入不写命令说明且记账 JSON 正常驱动状态');

// ---------- 26. 每楼七字段清单与旧完整记录 ----------
await restoreChat();
const sevenFields = record(8).运行清单;
assert.deepEqual(Object.keys(sevenFields).sort(), [...MANIFEST_FIELDS].sort());
assert.deepEqual(sevenFields, storedManifest(manifest));
assert.ok(!('世界书文件' in sevenFields) && !('程序文件' in sevenFields) && !('哈希算法' in sevenFields));
assert.ok(Buffer.byteLength(JSON.stringify(sevenFields), 'utf8') < 1000, '七字段清单应只有几百字节');
assert.ok(Buffer.byteLength(JSON.stringify(record(8)), 'utf8') < 4000, '每楼记录不应再复制完整清单');
assert.equal(record(0).记录格式, 1);
const clonedManifest = storedManifest(manifest);
clonedManifest.兼容程序.push('f'.repeat(64));
assert.notDeepEqual(manifest.兼容程序, clonedManifest.兼容程序, '七字段清单应克隆数组');

const oldFull = clone(chat);
oldFull[8].variables[oldFull[8].swipe_id].世界树.运行清单 = clone(manifest);
chat.splice(0, chat.length, ...clone(oldFull));
const oldFullBefore = JSON.stringify(chat);
await emit('chat_id_changed');
assert.equal(JSON.stringify(chat), oldFullBefore, '旧完整记录载入不得改写原始变量');
assert.ok(content().length > 0, '旧完整记录应可读并通过门禁');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '旧完整记录不应被误判只读');
await restoreChat();
console.log('26 每楼只存七字段清单（<1 KB），记录体积下降；旧完整清单记录仍通过门禁与重放，记录格式保持 1');

// ---------- 27. 兼容程序指纹 ----------
if (manifest.兼容程序.length) {
  const oldFingerprint = manifest.兼容程序[0];
  assert.equal(manifestIssue({...manifest, 程序指纹: oldFingerprint}, manifest).ok, true);
  assert.equal(manifestIssue({...manifest, 程序指纹: 'e'.repeat(64)}, manifest).ok, false);
}
console.log(`27 兼容程序 ${manifest.兼容程序.length} 个：显式列入的旧指纹可载入，未列入的仍拒绝`);

// ---------- 28. UI 路径：默认扮演灯塔学徒开局、记录命令与第 0 楼重放 ----------
chat.splice(0, chat.length);
chat.push({mes: face.开场白, is_user: false, is_system: false, swipe_id: 0, swipes: [face.开场白], variables: [{}]});
floors.clear();
holdPopup = true;
const openingPopupBase = popupNodes.length;
await emit('chat_id_changed');
await waitUntil(() => popupNodes.length > openingPopupBase, '新聊天应自动打开开局界面');
const roleplayMode = find(popupNodes.at(-1), item => item.tag === '<select>'
  && item.children.some(option => option.field === '自建') && item.children.some(option => option.field === '扮演'));
roleplayMode.handlers.change({target: {value: '扮演'}});
assert.match(popupNodes.at(-1).text(), /玩家：扮演 灯塔学徒/, '扮演模式的默认角色组应为灯塔学徒');
const roleplayWrites = messageWrites;
assert.equal(await closePopup(1), true, '默认扮演灯塔学徒应能提交开局');
assert.equal(messageWrites, roleplayWrites + 1, '合法提交只写一次第 0 楼记录');
const uiOpening = record(0);
assert.ok(uiOpening, '提交后应写入第 0 楼记录');
assert.deepEqual(uiOpening.本局.开局.玩家, {模式: '扮演', 扮演角色组: '灯塔学徒'});
assert.deepEqual(uiOpening.命令, roleplayRecord.命令, '真实 UI 记录的实际命令与纯计算一致');
const uiScene = uiOpening.命令.find(command => command.写场景);
assert.ok(uiScene && !Object.hasOwn(uiScene.写场景.在场 ?? {}, '灯塔学徒'), '记录中的写场景不得含扮演组在场');
assert.ok(protocol.createReadView(uiOpening.本局).presentIDs().includes('灯塔学徒'));
assert.equal(uiOpening.本局.角色.灯塔学徒.已初始化, true);
assert.equal(uiOpening.本局.角色.秦守.在场, true);
assert.equal(uiOpening.本局.角色.秦守.已初始化, true);
assert.deepEqual(uiOpening.本局.世界.当前地点, {地标: '灯塔', 场景: '值守室'});
assert.deepEqual(uiOpening.失败, []);
const uiReplay = applyCommands(protocol, seal(protocol, roleplayDraft.input()), uiOpening.命令);
assert.deepEqual(uiReplay.失败, []);
assert.deepEqual(uiReplay.state, uiOpening.本局, '真实第 0 楼记录重放应得到同一状态');
const uiOpeningJSON = JSON.stringify(uiOpening);
await emit('chat_id_changed');
assert.equal(JSON.stringify(record(0)), uiOpeningJSON, '重载第 0 楼不得改写记录');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '重载重放失败会进入只读视图');
assert.ok(content().length > 0, '重载后应正常注入');
console.log('28 UI 路径：默认扮演灯塔学徒开局成功，记录命令与纯计算一致且不含扮演组在场，第 0 楼重载重放一致');

// ---------- 29. YG-ADAPTER-10：自动修补内循环（覆盖局部协议失败 + 防倒退） ----------
chat.splice(0, chat.length, ...clone(stable));
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 2, 调试: false, 每楼记录: true}};
serverGlobals = clone(globals);
await emit('chat_id_changed');
const floor6Base = clone(record(6).本局);
const keepWithChanges = (state, patch = {}) => JSON.stringify({
  时间: {方式: '不变', 日期: '', 事件ID: ''},
  地点: {地标: '', 场景: ''},
  在场: presentOf(state),
  发生的事件: [],
  新情况: [],
  ...patch,
});

// 29a 局部协议失败（协议.变化）不再在第 1 次 break，内循环携带原 JSON + 失败命令体与报错定向修补并成功
keeperReplies.push(
  keepWithChanges(floor6Base, {
    地点: {地标: '码头区', 场景: '栈桥'},
    新情况: [
      {事件ID: '栈桥初晤', 摘要: '学徒到栈桥。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起潮'}]},
      {事件ID: '错误字段', 摘要: '写不存在字段。', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
    ],
  }),
  keepWithChanges(floor6Base, {
    地点: {地标: '码头区', 场景: '栈桥'},
    新情况: [
      {事件ID: '栈桥初晤', 摘要: '学徒到栈桥。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起潮'}]},
      {事件ID: '栈桥记事', 摘要: '补记秦守提醒。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '潮位上涨'}]},
    ],
  }),
);
const autoCallStart = keeperCalls.length;
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(keeperCalls.length, autoCallStart + 2, '局部协议失败应在剩余 attempts 内发起定向修补');
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /原始命令：.*"事件ID":"错误字段"/);
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /协议\.变化/);
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /保留上一次已经合理且成功的改动/);
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.尝试次数, 2);
assert.equal(record(8).记账.重试, 1);
assert.deepEqual(record(8).已写入, ['栈桥初晤', '栈桥记事']);
assert.equal(record(8).本局.世界.当前地点.地标, '码头区');

// 29b 防倒退：第 1 次取得部分成功结果，第 2 次遇到调用异常 / 坏 JSON / 更差结果时，保留第 1 次最佳结果
const partialAttempt1 = keepWithChanges(floor6Base, {
  地点: {地标: '码头区', 场景: '栈桥'},
  新情况: [
    {事件ID: '栈桥初晤', 摘要: '学徒到栈桥。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起潮'}]},
    {事件ID: '坏项', 摘要: '触发协议失败。', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]},
  ],
});
for (const [label, setupSecond] of [
  ['502异常', () => { keeperThrowOnce = false; keeperReplies.push(partialAttempt1); }],
  ['坏JSON', () => { keeperReplies.push(partialAttempt1, '非JSON文本'); }],
  ['结果倒退', () => {
    keeperReplies.push(partialAttempt1, keepWithChanges(floor6Base, {
      新情况: [{事件ID: '只剩坏项', 摘要: '把好结果丢了。', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]}],
    }));
  }],
]) {
  keeperReplies.length = 0;
  setupSecond();
  if (label === '502异常') {
    const origGen = globalThis.generateRaw;
    let count = 0;
    globalThis.generateRaw = async cfg => {
      count += 1;
      if (count === 2) { keeperCalls.push(cfg); throw new Error('HTTP 502 Bad Gateway'); }
      return origGen(cfg);
    };
    try { await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click(); }
    finally { globalThis.generateRaw = origGen; }
  } else {
    await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
  }
  assert.equal(record(8).记账.状态, '部分失败', label);
  assert.equal(record(8).记账.尝试次数, 2, label);
  assert.equal(record(8).记账.重试, 1, label);
  assert.ok(Array.isArray(record(8).命令) && record(8).命令.length === 2, `${label} 不得覆盖为 null`);
  assert.deepEqual(record(8).已写入, ['栈桥初晤'], `${label} 应保留第 1 次最佳已写入`);
}
console.log('29 自动修补内循环覆盖局部协议失败并成功；第 2 次遇 502/坏 JSON/结果倒退均防倒退保留最佳部分结果');

// ---------- 30. YG-ADAPTER-10：每楼「修补」按钮边界与留空双分支（增量优先 / 全量回退） ----------
// 按钮显示边界：第 0 楼不显示；关闭记账不显示；开启记账 id>0 成功楼与失败楼均显示
assert.equal(find(floors.get(0), item => item.tag === '<button>' && item.value === '修补'), undefined, '第 0 楼不得显示修补按钮');
assert.ok(find(floors.get(6), item => item.tag === '<button>' && item.value === '修补'), '成功助手楼应显示修补按钮');
assert.ok(find(floors.get(8), item => item.tag === '<button>' && item.value === '修补'), '部分失败助手楼应显示修补按钮');
globals['世界树·记账'].方式 = '关闭';
await emit('chat_id_changed');
assert.equal(find(floors.get(8), item => item.tag === '<button>' && item.value === '修补'), undefined, '关闭记账不得显示修补按钮');

globals['世界树·记账'] = {方式: '同一模型', 应答格式: '提示词', 尝试次数: 2, 调试: false, 每楼记录: true};
serverGlobals = clone(globals);
await emit('chat_id_changed');
// 留空修补第 6 楼（无失败项）：不发请求，弹窗原地提示并保持打开
holdPopup = true;
const noFailCalls = keeperCalls.length, noFailWrites = messageWrites;
const open6 = find(floors.get(6), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 6 楼记账'), '打开第 6 楼修补弹窗');
assert.match(popupNodes.at(-1).text(), /当前无失败项/);
assert.equal(await closePopup(1), false, '无失败项且留空应保持弹窗打开');
assert.match(popupNodes.at(-1).text(), /本楼没有失败项，如需调整请填写修补说明/);
assert.equal(keeperCalls.length, noFailCalls, '无失败项且留空不得发记账请求');
assert.equal(messageWrites, noFailWrites);
assert.equal(await closePopup(null), true);
await open6;

// 先在第 8 楼后加一轮下游楼层，用于验证修补后自动向后续楼层重放
keeperReplies.push(keepWithChanges(record(8).本局));
await send('我回到灯塔外望去。', '潮水刚涨过栈桥，远处的灯塔还在亮着。');
assert.ok(record(10), '应已建立第 10 楼下游记录');
assert.ok(!('原始结果' in record(8).记账), '非调试模式没有原始结果');

// 30a 留空增量补记第 8 楼（已有 栈桥初晤 + 写场景，失败为 动态事件 坏项）：100% 保留原已成功命令并重放到第 10 楼
const open8Inc = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开第 8 楼修补弹窗');
keeperReplies.push(keepWithChanges(record(8).本局, {
  新情况: [{事件ID: '潮水记录', 摘要: '补记潮水上涌。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '潮水漫过栈桥'}]}],
}));
assert.equal(await closePopup(1), true, '留空增量修补应成功并关闭弹窗');
await open8Inc;
assert.deepEqual(record(8).失败, []);
assert.equal(record(8).记账.状态, '成功');
assert.equal(record(8).记账.修补, true);
assert.ok(!('原始结果' in record(8).记账), '非调试模式修补后也不持久化原始结果');
assert.deepEqual(record(8).已写入, ['栈桥初晤', '潮水记录']);
assert.equal(record(8).本局.世界.当前地点.地标, '码头区');
assert.ok(record(10).本局.角色.灯塔学徒.知识.includes('潮水漫过栈桥'), '修补后应向第 10 楼重放');
assert.equal(record(10).本局.世界.当前地点.地标, '码头区');

// 30b 留空全量回退：先让第 8 楼回到 JSON失败（命令为 null），再留空全量修补成功
keeperReplies.push('不是 JSON', '不是 JSON');
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(record(8).命令, null);
const open8Full = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开第 8 楼全量修补弹窗');
keeperReplies.push(keepWithChanges(floor6Base, {
  地点: {地标: '码头区', 场景: '栈桥'},
  新情况: [{事件ID: '栈桥重记', 摘要: '全量修补后记入。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥夜雾'}]}],
}));
assert.equal(await closePopup(1), true, '命令为 null 时留空应走全量修补成功');
await open8Full;
assert.deepEqual(record(8).失败, []);
assert.equal(record(8).记账.修补, true);
assert.ok(record(10).本局.角色.灯塔学徒.知识.includes('栈桥夜雾'), '全量修补后应向第 10 楼重放');
console.log('30 修补按钮边界、留空增量补记（不依赖原始结果、保留原命令+重放）与 null 命令全量回退通过');

// ---------- 31. YG-ADAPTER-10：带一句话人工说明修补（补记新变化 + 撤回场景改动 + 下游重放） ----------
const open8Add = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开第 8 楼带说明修补弹窗（补记）');
find(popupNodes.at(-1), item => item.tag === '<textarea>').handlers.change({target: {value: '补记秦守对学徒好感增加'}});
keeperReplies.push(keepWithChanges(floor6Base, {
  地点: {地标: '码头区', 场景: '栈桥'},
  新情况: [
    {事件ID: '栈桥重记', 摘要: '全量修补后记入。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥夜雾'}]},
    {事件ID: '秦守赏识', 摘要: '补记好感。', 变化: [{路径: '角色.秦守.好感度.灯塔学徒', 操作: '增加', 值: '5'}]},
  ],
}));
assert.equal(await closePopup(1), true);
await open8Add;
const expectedFavor = (floor6Base.角色?.秦守?.好感度?.灯塔学徒 ?? 0) + 5;
assert.equal(record(8).本局.角色.秦守.好感度.灯塔学徒, expectedFavor);
assert.equal(record(10).本局.角色.秦守.好感度.灯塔学徒, expectedFavor, '带说明补记后应重放到第 10 楼');

const open8Withdraw = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开第 8 楼带说明修补弹窗（撤回）');
find(popupNodes.at(-1), item => item.tag === '<textarea>').handlers.change({target: {value: '没换地点，撤回场景改动'}});
keeperReplies.push(keepWithChanges(floor6Base));
assert.equal(await closePopup(1), true);
await open8Withdraw;
assert.deepEqual(record(8).命令, [], '撤回后允许空命令 []');
assert.equal(record(8).本局.世界.当前地点.地标, floor6Base.世界.当前地点.地标);
assert.equal(record(10).本局.世界.当前地点.地标, floor6Base.世界.当前地点.地标, '撤回场景改动后应重放到第 10 楼并刷新上下文');
assert.match(content(), new RegExp(floor6Base.世界.当前地点.地标));
console.log('31 带一句话说明修补支持「补记新变化」与「撤回场景改动」，并自动重放到后续楼层且刷新上下文');

// ---------- 32. YG-ADAPTER-10：手动修补事务性失败保护（零覆写 + 原地留字重试 + 任务过期） ----------
const snapshotBeforeFailures = JSON.stringify(chat);
const writesBeforeFailures = messageWrites;
const open8Protect = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开保护测试弹窗');
const textarea8 = find(popupNodes.at(-1), item => item.tag === '<textarea>');
textarea8.handlers.change({target: {value: '用户保留说明：补记测试'}});

// 32a 调用异常（502）
const origGenProtect = globalThis.generateRaw;
globalThis.generateRaw = async cfg => { keeperCalls.push(cfg); throw new Error('HTTP 502 Bad Gateway'); };
try { assert.equal(await closePopup(1), false, '调用异常必须拦截并保持弹窗打开'); }
finally { globalThis.generateRaw = origGenProtect; }
assert.equal(messageWrites, writesBeforeFailures);
assert.equal(JSON.stringify(chat), snapshotBeforeFailures);
assert.match(popupNodes.at(-1).text(), /502/);

// 32b 非 JSON、Schema 失败、仍残留局部失败
globals['世界树·记账'].尝试次数 = 1;
for (const [label, reply] of [
  ['非JSON', '不是 JSON'],
  ['Schema失败', '{}'],
  ['残留局部失败', keepWithChanges(floor6Base, {
    新情况: [{事件ID: '仍坏', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]}],
  })],
]) {
  keeperReplies.push(reply);
  assert.equal(await closePopup(1), false, `${label} 不得关闭弹窗`);
  assert.equal(messageWrites, writesBeforeFailures, `${label} 写入次数必须 0 增量`);
  assert.equal(JSON.stringify(chat), snapshotBeforeFailures, `${label} 不得覆盖本楼或下游楼层`);
}
// 保留原输入文本后直接修改重试成功（只清掉错误，沿用用户已输入的文本）
keeperReplies.push(keepWithChanges(floor6Base, {
  地点: {地标: '码头区', 场景: '栈桥'},
}));
assert.equal(await closePopup(1), true, '原输入文本仍在，调整后直接重试应成功');
await open8Protect;
assert.equal(record(8).本局.世界.当前地点.地标, '码头区');
assert.match(keeperCalls.at(-1).ordered_prompts[1].content, /用户保留说明：补记测试/);

// 32c 任务过期保护：执行期间用户编辑/切 swipe，旧修补任务静默放弃写入并关闭弹窗
const beforeStale = JSON.stringify(chat);
const writesBeforeStale = messageWrites;
const open8Stale = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开过期测试弹窗');
find(popupNodes.at(-1), item => item.tag === '<textarea>').handlers.change({target: {value: '过期测试说明'}});
holdNextKeeper = true;
keeperReplies.push(keepWithChanges(floor6Base, {
  新情况: [{事件ID: '不该写入', 摘要: '过期任务', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '脏数据'}]}],
}));
const closingStale = closePopup(1);
await waitUntil(() => typeof releaseKeeper === 'function', '等待手动修补请求挂起');
chat[8].mes = chat[8].swipes[chat[8].swipe_id] = chat[8].mes + '（修补中途被编辑）';
const staleEdit = emit('message_edited', 8);
const releaseStale = releaseKeeper;
releaseKeeper = null;
releaseStale();
assert.equal(await closingStale, true, '任务过期时应静默放弃并关闭弹窗');
await open8Stale;
keeperReplies.push(keepWithChanges(floor6Base));
await staleEdit;
assert.ok(!JSON.stringify(chat).includes('不该写入'), '过期修补任务结果不得写入');
assert.doesNotMatch(JSON.stringify(chat), /sk-test|apiurl|密钥/);
holdPopup = false;
await restoreChat();
console.log('32 手动修补事务保护：502/非JSON/Schema/残留局部失败均 0 覆写并原地留字重试；任务过期静默放弃且无凭据泄露');

// ---------- 33. YG-ADAPTER-11：A 级无缝兼容 + 混合哈希续写与全操作闭环 ----------
keeperReplies.length = 0;
chat.splice(0, chat.length, ...clone(stable));
for (const id of [0, 2, 4, 6, 8]) chat[id].variables[chat[id].swipe_id].世界树.运行清单.世界书哈希 = 'a'.repeat(64);
const aCompatChatBefore = JSON.stringify(chat);
const aCompatWrites = messageWrites;
const aCompatToastsStart = toasts.length;
await emit('chat_id_changed');
assert.equal(messageWrites, aCompatWrites, 'A 级兼容载入旧楼写入次数必须 0 增量');
assert.equal(JSON.stringify(chat), aCompatChatBefore, 'A 级兼容载入不得改写旧楼任何变量');
assert.ok(content().length > 0, 'A 级兼容应正常注入上下文');
assert.ok(![...floors.values()].some(item => item.text().includes('存档只读') || item.text().includes('待升级')));
const compatToasts1 = toasts.slice(aCompatToastsStart).filter(item => item.level === 'info' && item.title === '世界树：存档兼容');
assert.equal(compatToasts1.length, 1, '切换/载入 A 级聊天应弹出一次轻提示');

// 普通 refresh 不反复刷屏轻提示
await emit('message_sent', chat.length - 1);
const compatToasts2 = toasts.slice(aCompatToastsStart).filter(item => item.level === 'info' && item.title === '世界树：存档兼容');
assert.equal(compatToasts2.length, 1, '同一聊天会话后续普通 refresh 不得反复刷屏');

// 续写新助手楼写入当前清单新世界书哈希（混合哈希：0–8 旧哈希，10 新哈希）
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true}};
serverGlobals = clone(globals);
keeperReplies.push(noCommands(record(8).本局));
await send('我回头望向灯塔值守室。', '灯室窗口在夜色里重新亮起微光。');
assert.equal(record(10).运行清单.世界书哈希, manifest.世界书哈希, '新助手楼应写入当前构建的世界书哈希');
assert.equal(record(0).运行清单.世界书哈希, 'a'.repeat(64), '旧楼仍保持原世界书哈希');

// 混合哈希聊天重载、编辑玩家楼、编辑助手楼、切 swipe、手动修补、重新记账、删除传播全闭环
await emit('chat_id_changed');
assert.ok(content().length > 0, '混合哈希重载应通过审计并注入');
assert.ok(![...floors.values()].some(item => item.text().includes('存档只读')));
const compatToastsReload = toasts.slice(aCompatToastsStart).filter(item => item.level === 'info' && item.title === '世界树：存档兼容');
assert.equal(compatToastsReload.length, 2, '再次重载/切聊应重新弹出一次轻提示');

chat[9].mes = chat[9].swipes[0] = '我仔细端详灯塔。';
await emit('message_edited', 9);
assert.ok(content().length > 0, '混合哈希编辑玩家楼应正常通过');

chat[6].mes = chat[6].swipes[0] = chat[6].mes + '（混合哈希编辑助手楼）';
keeperReplies.push(noCommands(record(4).本局));
await emit('message_edited', 6);
assert.equal(record(6).运行清单.世界书哈希, manifest.世界书哈希);
assert.ok(content().length > 0, '混合哈希编辑助手楼应正常通过');

chat[10].swipes.push('');
chat[10].swipe_id = 1;
chat[10].mes = '';
await emit('message_swiped', 10);
chat[10].mes = chat[10].swipes[1] = '另一条分支正文';
keeperReplies.push(noCommands(record(8).本局));
await emit('message_received', 10, 'swipe');
chat[10].swipe_id = 0;
chat[10].mes = chat[10].swipes[0];
await emit('message_swiped', 10);
assert.ok(content().length > 0, '混合哈希切 swipe 应正常通过');

holdPopup = true;
const openRepair10 = find(floors.get(10), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 10 楼记账'), '混合哈希打开第 10 楼修补');
find(popupNodes.at(-1), item => item.tag === '<textarea>').handlers.change({target: {value: '补记一条知识'}});
keeperReplies.push(keepWithChanges(record(8).本局, {
  新情况: [{事件ID: '灯室微光', 摘要: '补记微光线索。', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '灯室留有余火'}]}],
}));
assert.equal(await closePopup(1), true);
await openRepair10;
holdPopup = false;
assert.ok(record(10).本局.角色.灯塔学徒.知识.includes('灯室留有余火'), '混合哈希手动修补应成功');

keeperReplies.push(noCommands(record(8).本局));
await find(floors.get(10), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(record(10).记账.状态, '成功', '混合哈希重新记账应成功');

chat.splice(9);
await emit('message_deleted', 9);
assert.ok(content().length > 0, '混合哈希删除传播应正常通过');
console.log('33 A 级无缝兼容：旧楼 0 改写、轻提示单次不刷屏；混合哈希续写后重载/编辑/切 swipe/修补/重新记账/删除传播全通过');

// ---------- 34. YG-ADAPTER-11：B 级待升级阻断与一键无损升级事务闭环 ----------
chat.splice(0, chat.length, ...clone(stable.slice(0, 3)));
for (const id of [0, 2]) {
  const rec = chat[id].variables[chat[id].swipe_id].世界树;
  rec.运行清单.世界书哈希 = 'b'.repeat(64);
  delete rec.本局.开局.角色组.白棠;
  delete rec.本局.世界.剧情标记.灯塔状态;
}
const bBeforeLoad = JSON.stringify(chat);
const bWritesBeforeLoad = messageWrites;
await emit('chat_id_changed');
assert.equal(messageWrites, bWritesBeforeLoad, 'B 级载入绝不得自动改写任何楼层变量');
assert.equal(JSON.stringify(chat), bBeforeLoad, 'B 级载入必须保留原始楼层变量');
assert.equal(injected['yggdrasill-context'], undefined, 'B 级待升级态必须移除叙事注入');
const upgradeFloorText = [...floors.values()].map(item => item.text()).join('\n');
assert.match(upgradeFloorText, /世界书已增补更新（原有历史 0 冲突）/);
assert.match(upgradeFloorText, /白棠/);
assert.match(upgradeFloorText, /灯塔状态=运转/);
assert.match(upgradeFloorText, /共 2 个助手楼/);

const bStopped = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, bStopped + 1, 'B 级待升级态必须阻止生成');
assert.ok(toasts.some(item => item.body?.includes('世界书已增补更新，请先确认升级本局存档')), '阻止生成应提示确认升级本局存档');

// 只读查看差异详情：不改写任何楼层变量，也不清除待升级态
const inspectButton = find([...floors.values()].find(item => item.text().includes('升级本局存档')),
  item => item.tag === '<button>' && item.value === '查看差异详情');
assert.ok(inspectButton);
const inspectWrites = messageWrites;
await inspectButton.handlers.click();
assert.equal(messageWrites, inspectWrites, '只读查看差异详情不得写楼层变量');
assert.match(popups.at(-1), /白棠/);
assert.match(popups.at(-1), /灯塔状态=运转/);
assert.equal(injected['yggdrasill-context'], undefined);

// 升级写入中途抛错：立即停止并报错，不伪造升级成功
const upgradeButton = find([...floors.values()].find(item => item.text().includes('升级本局存档')),
  item => item.tag === '<button>' && item.value === '升级本局存档');
assert.ok(upgradeButton);
failNextMessageWrite = true;
const failUpgradeResult = await upgradeButton.handlers.click();
assert.equal(failUpgradeResult, false, '升级写入中途失败应返回失败');
assert.equal(injected['yggdrasill-context'], undefined, '升级写入失败不得恢复注入或伪造成功');
assert.ok([...floors.values()].some(item => item.text().includes('升级本局存档')), '升级失败后待升级卡片应保持可重试');
assert.ok(toasts.some(item => item.level === 'error' && item.title === '世界树：升级失败'));

// 恢复写入后点击「升级本局存档」完成逐楼无损升级，重载与继续生成均通过
const okUpgradeResult = await upgradeButton.handlers.click();
assert.equal(okUpgradeResult, true, '确认升级本局存档应成功');
assert.equal(record(0).运行清单.世界书哈希, manifest.世界书哈希);
assert.equal(record(2).运行清单.世界书哈希, manifest.世界书哈希);
assert.deepEqual(record(2).本局.开局.角色组.白棠, {启用: true, 版本ID: '白棠'});
assert.equal(record(2).本局.世界.剧情标记.灯塔状态, '运转');
assert.deepEqual(record(2).命令, stable[2].variables[0].世界树.命令, '原有命令应保持不变');
assert.ok(content().length > 0, '升级完成后应立即恢复注入');
assert.ok(![...floors.values()].some(item => item.text().includes('升级本局存档')), '升级完成后应清理待升级态');

await emit('chat_id_changed');
assert.ok(content().length > 0, '升级后重载应 100% 通过严格审计');
keeperReplies.push(noCommands(record(2).本局));
await send('升级后继续对话。', '海风平缓下来，学徒记录下今天的巡视。');
assert.equal(record(4).运行清单.世界书哈希, manifest.世界书哈希, '升级后继续生成应正常记账');
console.log('34 B 级待升级阻断与一键无损升级：0 自动写入、阻止生成、只读看详情、写入失败不伪造成功、确认升级后重载与续写全通过');

// ---------- 35. YG-ADAPTER-11：C 级破坏性冲突严格只读与精准差异诊断 ----------
chat.splice(0, chat.length, ...clone(stable));
chat[2].variables[0].世界树.运行清单.世界书哈希 = 'c'.repeat(64);
chat[2].variables[0].世界树.本局.角色.秦守.在场 = false;
const cBefore = JSON.stringify(chat), cWrites = messageWrites, cStopped = stopCalls;
await emit('chat_id_changed');
assert.equal(JSON.stringify(chat), cBefore, 'C 级必须严格保持只读且原变量不变');
assert.equal(messageWrites, cWrites, 'C 级写入次数必须 0 增量');
const cReadOnlyText = [...floors.values()].map(item => item.text()).join('\n');
assert.match(cReadOnlyText, /存档只读/);
assert.match(cReadOnlyText, /运行清单\.世界书哈希/);
assert.match(cReadOnlyText, /#2 字段变化：角色\.秦守\.在场（false → true）/);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, cStopped + 1, 'C 级必须阻止继续生成');
await emit('button:世界树：本局');
assert.match(popups.at(-1), /冲突差异明细/);
assert.match(popups.at(-1), /#2 字段变化：角色\.秦守\.在场（false → true）/);

chat.splice(0, chat.length, ...clone(stable));
chat[2].variables[0].世界树.运行清单.世界书哈希 = 'c'.repeat(64);
chat[2].variables[0].世界树.命令 = [{写场景: {当前时间: '潮历070年01月01日'}}];
await emit('chat_id_changed');
assert.match([...floors.values()].map(item => item.text()).join('\n'), /#2 命令失败（协议\.场景）/);

await restoreChat();
console.log('35 C 级严格只读与精准差异诊断：字段冲突与命令失败均 0 写入、阻止生成，并在界面与本局弹窗展示精准楼号与差异明细');

// ---------- 36. YG-ADAPTER-12：生成中/空尾楼误点防锁 + 空尾楼占位排除 + MESSAGE_RECEIVED 空正文防护 ----------
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true}};
serverGlobals = clone(globals);
await restoreChat();
push('请继续推进剧情。', true);
push('', false);
// 真机现场：酒馆建出空白占位尾楼（#10，mes: ""）并自动复制上一助手楼 #8 的 世界树 变量（归属.楼号 === 8）
chat[10].variables[0] = clone(chat[8].variables[0]);
const emptyTailChatBefore = JSON.stringify(chat);
const emptyTailWritesBefore = messageWrites, emptyTailCallsBefore = keeperCalls.length;
const busyToastText = '当前有回复正在生成或末尾楼层为空，请等待生成完成或删除空楼后再操作。';

let toastMark12 = toasts.length;
await emit('button:世界树：重新记账');
assert.equal(messageWrites, emptyTailWritesBefore, '空尾楼存在时全局重新记账必须 0 写入');
assert.equal(keeperCalls.length, emptyTailCallsBefore, '空尾楼存在时全局重新记账不得调模型');
assert.equal(JSON.stringify(chat), emptyTailChatBefore);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '空尾楼存在时全局重新记账绝不得锁死 session.integrity');
assert.ok(toasts.slice(toastMark12).some(item => item.level === 'warning' && item.body === busyToastText));

toastMark12 = toasts.length;
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(messageWrites, emptyTailWritesBefore, '空尾楼存在时单楼重新记账必须 0 写入');
assert.equal(keeperCalls.length, emptyTailCallsBefore);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '空尾楼存在时单楼重新记账绝不得锁死只读');
assert.ok(toasts.slice(toastMark12).some(item => item.level === 'warning' && item.body === busyToastText));

toastMark12 = toasts.length;
const popupCountBeforeBusyRepair = popupNodes.length;
await find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
assert.equal(popupNodes.length, popupCountBeforeBusyRepair, '空尾楼存在时点修补只弹警告，不打开弹窗');
assert.equal(messageWrites, emptyTailWritesBefore);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
assert.ok(toasts.slice(toastMark12).some(item => item.level === 'warning' && item.body === busyToastText));

// 重载聊天与 normal / regenerate 生成前事件均自动排除空尾楼，按 #8 合法底本注入且不阻断
const stopBeforeEmptyTail = stopCalls;
await emit('chat_id_changed');
assert.ok(content().length > 0, '空尾楼存在时重载应自动排除空尾楼并正常注入');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '空尾楼存在时重载不得误锁只读');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
await emit('GENERATION_AFTER_COMMANDS', 'regenerate', generationOptions, false);
assert.equal(stopCalls, stopBeforeEmptyTail, '空尾楼存在时 normal/regenerate 不得误阻断');
assert.ok(content().length > 0);

// MESSAGE_RECEIVED 收到空正文尾楼：不调记账、不写入、不锁只读、弹空正文警告并维持前楼注入
toastMark12 = toasts.length;
await emit('message_received', 10, 'normal');
assert.equal(keeperCalls.length, emptyTailCallsBefore, 'MESSAGE_RECEIVED 收到空正文尾楼不得调用记账模型');
assert.equal(messageWrites, emptyTailWritesBefore, 'MESSAGE_RECEIVED 收到空正文尾楼不得写变量');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), 'MESSAGE_RECEIVED 空尾楼不得锁死只读');
assert.ok(toasts.slice(toastMark12).some(item => item.level === 'warning' && item.body === '本楼正文为空，未记账；可重新生成或删除该楼。'));
assert.ok(content().length > 0, 'MESSAGE_RECEIVED 空尾楼后应维持前楼合法注入');

// 宿主明确处于生成中（is_send_press === true，无空尾楼）：全局/单楼「重新记账」与「修补」点击及弹窗内提交均防误锁
await restoreChat();
sendingPress = true;
const sendingWrites = messageWrites, sendingCalls = keeperCalls.length;
for (const action of [
  () => emit('button:世界树：重新记账'),
  () => find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click(),
  () => find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click(),
]) {
  toastMark12 = toasts.length;
  await action();
  assert.equal(messageWrites, sendingWrites, '生成中点击操作必须 0 写入');
  assert.equal(keeperCalls.length, sendingCalls, '生成中点击操作不得调记账');
  assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '生成中点击操作不得锁只读');
  assert.ok(toasts.slice(toastMark12).some(item => item.level === 'warning' && item.body === busyToastText));
}
// 弹窗打开后生成开始，再点击「开始修补」：错误区原地提示并保持弹窗打开、0 写入、不锁只读
sendingPress = false;
holdPopup = true;
const open8WhileIdle = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '打开第 8 楼修补弹窗');
sendingPress = true;
assert.equal(await closePopup(1), false, '生成中在弹窗内提交修补应拦截并保持弹窗打开');
assert.match(popupNodes.at(-1).text(), /当前有回复正在生成或末尾楼层为空/);
assert.equal(messageWrites, sendingWrites);
assert.equal(keeperCalls.length, sendingCalls);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
sendingPress = false;
assert.equal(await closePopup(null), true);
await open8WhileIdle;
holdPopup = false;
console.log('36 生成中与空尾楼防误锁：全局/单楼重新记账与修补 0 写入且不锁只读；空尾楼重载/normal/regenerate 与 MESSAGE_RECEIVED 空正文防护通过');

// ---------- 37. YG-ADAPTER-12：反例硬守卫（中间空楼、中间空正文接收、非空错楼号复制尾楼仍严格阻断） ----------
// 37a 中间空助手楼（后面仍有助手楼）重载必须严格阻断
await restoreChat();
chat[6].mes = chat[6].swipes[0] = '';
let stopCounter = stopCalls, toastCounter = toasts.length;
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '中间空楼仍必须进入存档只读');
assert.equal(injected['yggdrasill-context'], undefined, '中间空楼阻断时应移除注入');
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopCounter + 1, '中间空楼必须阻断生成');

// 37b MESSAGE_RECEIVED 收到中间空正文（非尾楼）仍严格阻断且不调用记账
await restoreChat();
chat[6].mes = chat[6].swipes[0] = '';
const midRecvCalls = keeperCalls.length;
await emit('message_received', 6, 'normal');
assert.equal(keeperCalls.length, midRecvCalls, '中间空正文不得送入记账');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '中间空正文接收仍必须阻断');

// 37c 末尾助手楼正文非空且带旧楼复制变量（归属.楼号 !== 10）：重载、生成前与点击重新记账均严格阻断为 归属.失配
await restoreChat();
push('请写一段新剧情。', true);
push('这是一段非空正文，绝不能当作空占位楼跳过。', false);
chat[10].variables[0] = clone(chat[8].variables[0]);
stopCounter = stopCalls; toastCounter = toasts.length;
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '非空错楼号尾楼重载必须阻断');
assert.ok(toasts.slice(toastCounter).some(item => item.level === 'error' && item.title?.includes('归属.失配')));
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopCounter + 1, '非空错楼号尾楼必须阻断生成');

// 即使从未在只读态下，未生成中直接点击全局重新记账遇到非空错楼号尾楼也仍按 归属.失配 阻断
await restoreChat();
push('请写一段新剧情。', true);
push('非空正文的尾楼带旧楼复制变量。', false);
chat[10].variables[0] = clone(chat[8].variables[0]);
toastCounter = toasts.length;
await emit('button:世界树：重新记账');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '非空错楼号尾楼点击重新记账仍应严格阻断');
assert.ok(toasts.slice(toastCounter).some(item => item.level === 'error' && item.title?.includes('归属.失配')));
await restoreChat();
console.log('37 反例硬守卫通过：中间空楼、中间空正文接收与非空错楼号复制尾楼均严格进入只读阻断');

// ---------- 38. YG-ADAPTER-12：MESSAGE_DELETED 删楼后自动重审自愈与残留损坏继续只读 ----------
// 38a 损坏尾楼导致整局进入只读后，删除该坏尾楼触发 MESSAGE_DELETED 自动重审自愈并恢复续写
await restoreChat();
push('这一步产生了坏尾楼。', true);
push('损坏的非空尾楼。', false);
chat[10].variables[0] = clone(chat[8].variables[0]);
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '坏尾楼应触发只读');
assert.equal(injected['yggdrasill-context'], undefined);
const stopLocked = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopLocked + 1, '删除前只读态应阻止生成');

chat.splice(9);
const healToastStart = toasts.length;
await emit('message_deleted', chat.length);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '删除坏尾楼后应自动退出只读');
assert.ok(content().length > 0, '自愈后应立即恢复上下文注入');
assert.ok(toasts.slice(healToastStart).some(item => item.level === 'info' && item.title === '世界树：已恢复'
  && item.body === '删除问题楼层后校验通过，已恢复正常游玩。'), '自愈后应提示已恢复正常游玩');
const stopHealed = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopHealed, '自愈后生成前检查应放行');
keeperReplies.push(noCommands(record(8).本局));
await send('自愈后继续对话。', '灯室的雾渐渐散开，学徒记下新的巡视。');
assert.equal(record(10).记账.状态, '成功', '自愈后应能正常续写并记账');

// 38b 若删除尾楼后剩余楼层仍有损坏，仍保持只读且绝不误放行或弹已恢复
await restoreChat();
chat[8].variables[0].世界树.归属.正文指纹 = '0'.repeat(64);
push('坏尾楼输入。', true);
push('坏尾楼回复。', false);
chat[10].variables[0] = clone(chat[6].variables[0]);
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
chat.splice(9);
const stillBrokenToastStart = toasts.length;
await emit('message_deleted', chat.length);
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')), '仍有损坏楼层时删除尾楼后必须继续只读');
assert.equal(injected['yggdrasill-context'], undefined, '仍有损坏时不得恢复注入');
assert.ok(!toasts.slice(stillBrokenToastStart).some(item => item.title === '世界树：已恢复'), '未恢复时不得误弹已恢复提示');
const stopStillBroken = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopStillBroken + 1, '仍有损坏时生成前必须继续阻止');

// 38c 删除到只剩空尾楼（前楼均合法）与删除到空聊均按新范围自愈
await restoreChat();
push('空尾楼前玩家。', true);
push('', false);
chat[10].variables[0] = clone(chat[8].variables[0]);
push('待删坏楼玩家。', true);
push('待删坏楼。', false);
chat[12].variables[0] = clone(chat[8].variables[0]);
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
chat.splice(11);
const healWithEmptyTailStart = toasts.length;
await emit('message_deleted', chat.length);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')), '删掉坏尾楼后即使留有空尾楼也应自愈');
assert.ok(content().length > 0);
assert.ok(toasts.slice(healWithEmptyTailStart).some(item => item.title === '世界树：已恢复'));

// 删除到待开局第 0 楼（无记录）与删除到空聊均交由 init() 处理，从只读态退出并进入尚未开局
await restoreChat();
delete chat[2].variables[0].世界树;
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
chat.splice(1);
delete chat[0].variables[0].世界树;
holdPopup = true;
const emptyOpeningBase = popupNodes.length;
await emit('message_deleted', 1);
await waitUntil(() => popupNodes.length > emptyOpeningBase, '删到无记录第 0 楼应交由 init 打开开局界面');
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
assert.match(floorText(0), /尚未开局/);
assert.equal(await closePopup(null), true);
holdPopup = false;

chat[0].variables[0].世界树 = clone(stable[0].variables[0]);
chat.push({mes: '损坏楼', is_user: false, is_system: false, swipe_id: 0, swipes: ['损坏楼'], variables: [{}]});
await emit('chat_id_changed');
assert.ok([...floors.values()].some(node => node.text().includes('存档只读')));
chat.splice(0);
const stopBeforeEmpty = stopCalls;
await emit('message_deleted', 0);
assert.ok(![...floors.values()].some(node => node.text().includes('存档只读')));
assert.equal(injected['yggdrasill-context'], undefined);
await emit('GENERATION_AFTER_COMMANDS', 'normal', generationOptions, false);
assert.equal(stopCalls, stopBeforeEmpty + 1, '删到空聊后应处于尚未开局并阻止生成');
assert.ok(toasts.some(item => item.title?.includes('已阻止生成') && /尚未开局/.test(item.body)));

await restoreChat();
console.log('38 MESSAGE_DELETED 删楼自愈：删掉坏尾楼即刻恢复注入与续写；残留损坏继续只读；留空尾楼或删至空聊均正确处置');

// ---------- 39. YG-REL-01：修补弹窗在非调试与调试模式下的信息隔离对比 ----------
await restoreChat();
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true}};
serverGlobals = clone(globals);
await emit('chat_id_changed');
const isoBase = clone(record(6).本局);
keeperReplies.push(keepWithChanges(isoBase, {
  地点: {地标: '码头区', 场景: '栈桥'},
  发生的事件: [{事件ID: '隐秘将来事件_隔离测试', 分支ID: '发生'}],
  新情况: [{事件ID: '坏字段', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]}],
}));
await find(floors.get(8), item => item.tag === '<button>' && item.value === '重新记账').handlers.click();
assert.equal(record(8).记账.状态, '部分失败');
assert.ok(record(8).命令.length > 0 && record(8).失败.length === 2);

holdPopup = true;
const openIsoOff = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '非调试打开修补弹窗');
const nonDebugText = popupNodes.at(-1).text();
assert.match(nonDebugText, /已记摘要：地点 码头区·栈桥/);
assert.match(nonDebugText, /有 2 项未能写入；可留空尝试补记、填写修补说明，或在“世界树：设置”开启调试查看细节/);
assert.doesNotMatch(nonDebugText, /写场景:|当前地点:|隐秘将来事件_隔离测试|协议\.变化|记账\.结果|协议执行|角色\.秦守\.姓名/);
// 非调试模式原地校验残留局部失败也不得泄露内部错误码或未发生事件 ID
find(popupNodes.at(-1), item => item.tag === '<textarea>').handlers.change({target: {value: '尝试修补'}});
keeperReplies.push(keepWithChanges(isoBase, {
  发生的事件: [{事件ID: '隐秘将来事件_原地校验', 分支ID: '发生'}],
}));
assert.equal(await closePopup(1), false);
const nonDebugErr = popupNodes.at(-1).text();
assert.match(nonDebugErr, /修补后仍有局部失败/);
assert.doesNotMatch(nonDebugErr, /隐秘将来事件_原地校验|记账\.结果/);
assert.equal(await closePopup(null), true);
await openIsoOff;

globals['世界树·记账'].调试 = true;
const openIsoOn = find(floors.get(8), item => item.tag === '<button>' && item.value === '修补').handlers.click();
await waitUntil(() => popupNodes.at(-1)?.text().includes('修补第 8 楼记账'), '调试打开修补弹窗');
const debugText = popupNodes.at(-1).text();
assert.match(debugText, /写场景:/);
assert.match(debugText, /当前地点:/);
assert.match(debugText, /转换\/记账\.结果：.*隐秘将来事件_隔离测试/);
assert.match(debugText, /协议执行\/协议\.变化·第 \d+ 条：/);
assert.equal(await closePopup(null), true);
await openIsoOn;
holdPopup = false;
await restoreChat();
console.log('39 YG-REL-01 修补弹窗隔离对比：非调试隐藏原始命令 YAML 与内部失败明细，调试模式完整展示');

// ---------- 40. YG-FIX-01：已排除/异分支事件确认拒绝与自动重试防倒退 ----------
const keeper = createBookkeeper({protocol, catalog: router.catalog, decl: router.decl});
const fixBase = seal(protocol, {开局时间: '潮历071年04月01日'});
const fixFull = (patch = {}) => ({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''},
  在场: [], 发生的事件: [], 新情况: [], ...patch});
const fixLocation = {地标: '码头区', 场景: '栈桥'};
const fixGood = {事件ID: '好发现', 摘要: '好', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '栈桥起风'}]};
const fixBad = {事件ID: '坏路径', 摘要: '坏', 变化: [{路径: '角色.秦守.姓名', 操作: '设定', 值: 'x'}]};
const fixFixed = {事件ID: '坏路径', 摘要: '修正后记入知识', 变化: [{路径: '角色.灯塔学徒.知识', 操作: '新增', 值: '秦守在栈桥'}]};
const excludedState = seal(protocol, {开局时间: '潮历071年04月31日', 历史选择: {港务署问责: '未发生'}});
const rejectedRun = keeper.run(excludedState, fixFull({地点: fixLocation,
  发生的事件: [{事件ID: '港务署问责', 分支ID: '问责秦守'}], 新情况: [fixGood]}));
assert.ok(rejectedRun.失败.some(item => item.错误码 === '协议.事件状态' && item.命令 === '确认事件'));
assert.ok(!rejectedRun.commands.some(command => command.确认事件), '已排除事件的确认命令不得进入可重放命令');
assert.ok(rejectedRun.已写入.includes('好发现'));
assert.equal(rejectedRun.state.世界.当前地点.地标, '码头区');
const mismatchRun = keeper.run(excludedState, fixFull({发生的事件: [{事件ID: '拜师', 分支ID: '未拜师'}]}));
assert.ok(mismatchRun.失败.some(item => item.错误码 === '协议.事件状态' && /其他分支/.test(item.说明)));

const partialReply = JSON.stringify(fixFull({地点: fixLocation, 新情况: [fixGood, fixBad]}));
const fixConfig = {方式: '同一模型', 应答格式: '提示词'}, retained = [];
for (const [label, retry] of [['空变化', fixFull({})], ['丢场景', fixFull({新情况: [fixGood]})],
  ['丢已写入', fixFull({地点: fixLocation})]]) {
  let index = 0;
  const loop = await runKeeperLoop({keeper, base: fixBase, narration: '栈桥局部成功。', config: fixConfig, attempts: 2,
    call: async () => (index++ === 0 ? partialReply : JSON.stringify(retry))});
  const rec = buildKeepRecord({base: fixBase, loop, config: fixConfig, debugging: false});
  assert.equal(rec.记账.状态, '部分失败', label);
  assert.deepEqual(rec.已写入, ['好发现'], label);
  assert.equal(rec.命令.length, 2, label);
  assert.equal(rec.本局.世界.当前地点.地标, '码头区', label);
  assert.ok(rec.失败.length > 0, label);
  retained.push(label);
}
let fixedIndex = 0;
const fixedLoop = await runKeeperLoop({keeper, base: fixBase, narration: '栈桥修正。', config: fixConfig, attempts: 2,
  call: async () => (fixedIndex++ === 0 ? partialReply
    : JSON.stringify(fixFull({地点: fixLocation, 新情况: [fixGood, fixFixed]})))});
const fixedRecord = buildKeepRecord({base: fixBase, loop: fixedLoop, config: fixConfig, debugging: false});
assert.equal(fixedRecord.记账.状态, '成功');
assert.deepEqual(fixedRecord.已写入, ['好发现', '坏路径']);
assert.deepEqual(fixedRecord.失败, []);
console.log(`40 YG-FIX-01：已排除/异分支确认均报 协议.事件状态 且不进入重放；自动重试 ${retained.join('/')} 均保留合法地点与已写入并判部分失败；修正后成功`);

// ---------- 41. YG-OPEN-01：第 0 楼开场白同步、回滚、多方案裁剪与必选依赖 ----------
holdPopup = true;
const openBefore = popupNodes.length, writesBeforeGreeting = openingWrites;
chat.splice(0, chat.length);
push('旧的开场白占位。', false);
await emit('chat_id_changed');
await waitUntil(() => popupNodes.length > openBefore, '新聊天打开开局界面');
assert.match(popupNodes.at(-1).text(), /确认开局后使用这段正文作为第 0 楼开场白/);
assert.equal(await closePopup(1), true, '开场白与选中方案不同时应同步后提交');
assert.equal(openingWrites, writesBeforeGreeting + 1, '只同步一次第 0 楼正文');
assert.equal(chat[0].mes, face.开场白, '提交后第 0 楼正文应为选中方案开场白');
assert.equal(record(0).归属.正文指纹, sha256(Buffer.from(face.开场白, 'utf8')), '记录归属应按同步后的正文计算');
assert.deepEqual(record(0).命令, face.开场命令);
assert.deepEqual(record(0).失败, []);
assert.ok(!toasts.some(item => item.title?.includes('开局已存在') && item.body?.includes('重复提交')), '同步不应被当成重复开局');

holdPopup = true;
const rollbackBefore = popupNodes.length, rollbackGreeting = '回滚前的开场白。';
chat.splice(0, chat.length);
push(rollbackGreeting, false);
await emit('chat_id_changed');
await waitUntil(() => popupNodes.length > rollbackBefore, '回滚用例打开开局界面');
failNextMessageWrite = true;
assert.equal(await closePopup(1), false, '记录写入失败时提交必须失败');
assert.equal(chat[0].mes, rollbackGreeting, '记录写入失败应把第 0 楼正文恢复为提交前原文');
assert.equal(record(0), undefined, '回滚后不得留下半份记录');
assert.ok(toasts.some(item => item.level === 'error' && /原变量已保留/.test(item.body)));
await closePopup(null);
holdPopup = false;

// 极简只读宿主没有写正文接口：不报权限缺口，照常写记录，第 0 楼正文保持原样。
holdPopup = true;
const noApiBefore = popupNodes.length, noApiGreeting = '无写正文接口的开场白。';
chat.splice(0, chat.length);
push(noApiGreeting, false);
await emit('chat_id_changed');
await waitUntil(() => popupNodes.length > noApiBefore, '无写正文接口用例打开开局界面');
const toastBase = toasts.length, savedSetChatMessages = globalThis.setChatMessages;
delete globalThis.setChatMessages;
try {
  assert.equal(await closePopup(1), true, '缺少写正文接口时仍应照常提交');
} finally {
  globalThis.setChatMessages = savedSetChatMessages;
}
assert.equal(chat[0].mes, noApiGreeting, '没有写正文接口时第 0 楼正文保持原样');
assert.ok(record(0), '没有写正文接口时仍应写入第 0 楼记录');
assert.ok(!toasts.slice(toastBase).some(item => item.title?.includes('无法开局')), '缺少可选接口不得当作权限缺口');
holdPopup = false;

const trimmedSpec = {openingGreeting: '主开场白。', commands: [
  {确认初始化: {角色组ID: '白棠'}},
  {确认初始化: {角色组ID: '秦守'}},
  {写场景: {在场: {白棠: true, 秦守: true}}},
], optionalPresent: ['白棠'], requiredGroups: [], planOpenings: {}};
const trimmedDraft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: {开局时间: face.开局.开局时间}, openingSpec: trimmedSpec});
assert.equal(trimmedDraft.snapshot().错误, null);
assert.match(openingNode(trimmedDraft).text(), /主开场白。/);
assert.equal(trimmedDraft.setGroup('白棠', {启用: false}).ok, true);
assert.deepEqual(trimmedDraft.prepare().record.命令, [
  {确认初始化: {角色组ID: '秦守'}},
  {写场景: {在场: {秦守: true}}},
], '可选在场角色关停后不执行初始化与在场');

const planSpec = {...trimmedSpec, planOpenings: {码头少年: {开场白: '方案开场白预览。'}}};
const planDraft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: {开局时间: face.开局.开局时间, 方案: '码头少年'}, openingSpec: planSpec});
assert.equal(planDraft.snapshot().开场白, '方案开场白预览。');
assert.match(openingNode(planDraft).text(), /确认开局后将同步第 0 楼开场白/);

const requiredDraft = createOpeningDraft({protocol, catalog: router.catalog, decl: router.decl,
  defaults: {开局时间: face.开局.开局时间, 方案: '补考之年'},
  openingSpec: {openingGreeting: '主开场白。', optionalPresent: [], requiredGroups: [],
    planOpenings: {补考之年: {开场白: '补考开场白预览。', 必需角色组: ['周岚']}}}});
const requiredText = openingNode(requiredDraft).text();
assert.match(requiredText, /补考开场白预览。/);
assert.match(requiredText, /必选/);
assert.match(requiredText, /依赖：开局方案必需角色组/);
assert.match(requiredText, /开局\.必需角色组|必需角色未启用/);
assert.equal(requiredDraft.prepare().ok, false, '必选角色默认关闭时提交必须被拒绝');
console.log('41 YG-OPEN-01：第 0 楼开场白同步并回滚成功；可选在场角色裁剪初始化与在场；方案预览与必选依赖在 UI 可见且阻断提交');

// ---------- 42. YG-ROUTE-01：长聊已验真前缀缓存与增量重放 ----------
const cacheManifest = {...manifest};
const auditMsg = (id, text) => ({message_id: id, role: 'assistant', message: text, swipe_id: 0});
const auditRecord = (message, state, commands) => ({记录格式: RECORD_FORMAT, 运行清单: storedManifest(cacheManifest),
  归属: ownershipOf(message), 本局: state, 命令: commands, 失败: [], 已写入: [],
  记账: {方式: '正文', 应答格式: '正文命令', 状态: '成功', 尝试次数: 1}});
const longChat = [];
let longState = seal(protocol, face.开局);
const firstMessage = auditMsg(0, '开场白。');
firstMessage.data = {世界树: auditRecord(firstMessage, longState, [])};
longChat.push(firstMessage);
for (let id = 1; id < 11; id++) {
  const commands = [{写场景: {当前时间: `潮历071年04月${String(id + 1).padStart(2, '0')}日`}}];
  const run = applyCommands(protocol, longState, commands);
  assert.deepEqual(run.失败, []);
  const message = auditMsg(id, `第 ${id} 楼正文。`);
  message.data = {世界树: auditRecord(message, run.state, commands)};
  longChat.push(message); longState = run.state;
}
const longAudit = createHistoryAudit({protocol, manifest: cacheManifest});
assert.equal(longAudit.audit(longChat).ok, true);
const firstReplay = longAudit.cacheStats().replayedFloors;
assert.deepEqual(longAudit.cacheStats(), {hits: 0, misses: 11, replayedFloors: 11, cachedFloors: 11});
assert.equal(longAudit.audit(longChat).ok, true);
assert.equal(longAudit.cacheStats().replayedFloors, firstReplay);
const extraCommands = [{写场景: {当前时间: '潮历071年04月20日'}}];
const extraRun = applyCommands(protocol, longState, extraCommands);
const extraMessage = auditMsg(11, '第 11 楼正文。');
extraMessage.data = {世界树: auditRecord(extraMessage, extraRun.state, extraCommands)};
longChat.push(extraMessage);
assert.equal(longAudit.audit(longChat).ok, true);
assert.deepEqual(longAudit.cacheStats(), {hits: 22, misses: 12, replayedFloors: 12, cachedFloors: 12});

const tamperedChat = structuredClone(longChat);
tamperedChat[6].data.世界树.本局.世界.当前时间 = '潮历071年05月01日';
const noCache = createHistoryAudit({protocol, manifest: cacheManifest}).audit(tamperedChat);
const withCache = longAudit.audit(tamperedChat);
assert.equal(noCache.ok, false);
assert.equal(withCache.ok, false);
assert.equal(withCache.code, noCache.code);
assert.equal(withCache.楼号, noCache.楼号);
assert.equal(withCache.说明, noCache.说明);
assert.equal(longAudit.cacheStats().cachedFloors, 6);
longAudit.clearCache();
assert.equal(longAudit.cacheStats().cachedFloors, 0);
assert.equal(longAudit.audit(longChat).ok, true);
longAudit.invalidateFrom(4);
assert.equal(longAudit.cacheStats().cachedFloors, 4);
assert.equal(longAudit.audit(longChat).ok, true);
assert.equal(longAudit.cacheStats().cachedFloors, 12);
console.log(`42 YG-ROUTE-01：12 楼长聊首次重放 ${firstReplay} 层，重复审计新增 0 层，追加仅重放新增尾楼；篡改历史本局报 ${noCache.code} 与无缓存一致；clearCache/invalidateFrom 精确失效通过`);

// ---------- 43. YG-OPEN-02：第 0 楼封面 + 动态开场白（自动生成/提示扩写/手写）+ 重刷/swipe/编辑 ----------
globals = {'世界树·记账': {方式: '同一模型', 应答格式: '提示词', 尝试次数: 1, 调试: false, 每楼记录: true}};
serverGlobals = clone(globals);
holdPopup = true;
const open43Before = popupNodes.length, cover43 = '【封面占位】请点击世界树：开局。';
chat.splice(0, chat.length);
push(cover43, false);
await emit('chat_id_changed');
await waitUntil(() => popupNodes.length > open43Before, '段43 打开开局界面');
let form43 = popupNodes.at(-1);
// 切换为 提示扩写 并填写一句提示
let mode43 = find(form43, item => item.tag === '<select>' && item.children.some(o => o.field === '提示扩写'));
mode43.handlers.change({target: {value: '提示扩写'}});
form43 = popupNodes.at(-1);
const hintField43 = find(form43, item => item.classes.includes('ygg-field') && item.text().includes('开场提示'));
const hintInput43 = find(hintField43, item => item.tag === '<input>');
hintInput43.handlers.change({target: {value: '黄昏时分在码头边眺望雾海'}});
// 先模拟生成失败：封面与变量均不动
keeperThrowOnce = true;
assert.equal(await closePopup(1), false, '动态开场白生成失败时应保留封面供重试');
assert.equal(chat[0].mes, cover43, '生成失败不得覆写第 0 楼封面');
assert.equal(record(0), undefined, '生成失败不得写入第 0 楼记录');
// 重试：第一次 generateRaw 为叙事生成开场白，第二次 generateRaw 为记账 JSON
const genOpening43 = '黄昏的潮气扑上码头，秦守提着铜灯站在栈桥边。';
keeperReplies.push(
  genOpening43,
  JSON.stringify({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: ['秦守'], 发生的事件: [], 新情况: []}),
);
const callsBefore43 = keeperCalls.length;
assert.equal(await closePopup(1), true, '重试后提示扩写开场白应提交成功');
holdPopup = false;
assert.equal(keeperCalls.length, callsBefore43 + 2, '动态开场应依次调用叙事生成与记账');
assert.match(keeperCalls[callsBefore43].ordered_prompts[1].content, /黄昏时分在码头边眺望雾海/);
assert.equal(chat[0].mes, genOpening43);
assert.equal(record(0).记账.方式, '开场生成');
assert.equal(record(0).本局.角色.秦守.在场, true);
assert.equal(createHistoryAudit({protocol, manifest}).audit(getChatMessages('0-0')).ok, true, '动态第 0 楼必须通过严格重放');

// 在动态第 0 楼后推一轮普通对话，再编辑第 0 楼正文并验证重记 + 下游重放
keeperReplies.push(JSON.stringify({时间: {方式: '写日期', 日期: '潮历071年04月02日', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: ['秦守'], 发生的事件: [], 新情况: []}));
await send('我走近秦守打招呼。', '秦守点点头，把灯挂在柱上。');
assert.equal(record(2).本局.世界.当前时间, '潮历071年04月02日');

const editedOpening43 = '夜色初降，白棠提着鱼篓从码头走过。';
chat[0].mes = chat[0].swipes[0] = editedOpening43;
keeperReplies.push(JSON.stringify({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: ['白棠'], 发生的事件: [], 新情况: []}));
await emit('message_edited', 0);
assert.equal(record(0).记账.方式, '开场生成');
assert.equal(record(0).本局.角色.白棠.在场, true);
assert.equal(record(2).本局.角色.白棠.在场, true, '编辑动态第 0 楼后下游楼层应同步重放');
assert.equal(createHistoryAudit({protocol, manifest}).audit(getChatMessages('0-2')).ok, true, '编辑动态第 0 楼后整聊通过严格审计');

// 删去后续楼层，对动态第 0 楼执行新建空 swipe + regenerate + 收到新正文
chat.splice(1);
await emit('message_deleted', 1);
chat[0].swipes.push(''); chat[0].swipe_id = 1; chat[0].mes = '';
await emit('message_swiped', 0);
const stopBeforeSwipe0 = stopCalls;
await emit('GENERATION_AFTER_COMMANDS', 'swipe', generationOptions, false);
assert.equal(stopCalls, stopBeforeSwipe0, '动态第 0 楼刷 swipe 生成前不得被阻断');
assert.ok(content().length > 0, '动态第 0 楼刷 swipe 应注入开局封卷底本上下文');
chat[0].mes = chat[0].swipes[1] = '清晨海雾未散，灯塔门前静悄悄的。';
keeperReplies.push(JSON.stringify({时间: {方式: '不变', 日期: '', 事件ID: ''}, 地点: {地标: '', 场景: ''}, 在场: [], 发生的事件: [], 新情况: []}));
await emit('message_received', 0, 'swipe');
assert.equal(record(0).记账.方式, '开场生成');
assert.equal(record(0).归属.swipe, 1);
assert.equal(createHistoryAudit({protocol, manifest}).audit(getChatMessages('0-0')).ok, true, '动态第 0 楼新 swipe 应通过严格审计');
console.log('43 YG-OPEN-02：第 0 楼封面 + 提示扩写失败保留封面 + 重试生成记账落盘 + 动态第 0 楼编辑重放与 swipe 重刷均通过严格审计');
