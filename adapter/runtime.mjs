// 酒馆适配运行时：在酒馆助手的脚本 iframe 中运行内核。每轮生成前路由并注入上下文；收到回复后得到这一楼的命令，经协议写入，
// 连同命令存进该楼该 swipe 的楼层变量，重算时照存下的命令重放。命令有两种来源：记账（另调一次模型填 JSON，见 bookkeeper.mjs），
// 或旧方式由叙事模型在正文末尾写 <命令>。开场命令由卡面的独立列表给出，只在新聊天第 0 楼执行。每楼下方显示这一楼记了什么（见 view.mjs），不进提示词。
// 依赖酒馆助手注入 iframe 的全局：getChatMessages、getLastMessageId、getVariables、replaceVariables、injectPrompts、uninjectPrompts、
// eventOn、tavern_events、getButtonEvent、generateRaw、getModelList、getProxyPresetNames、retrieveDisplayedMessage、toastr、SillyTavern、
// 兼容阻断时用宿主 stopGeneration 或 triggerSlash('/stop') 真正中止生成；$（酒馆页面的 jQuery）。
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol, seal, ProtocolError} from '../core/protocol.mjs';
import {createRouter, route, renderContext} from '../core/router.mjs';
import {readSettings} from '../core/settings.mjs';
import {stringifyYaml} from '../core/yaml.mjs';
import {isMap} from '../core/utils.mjs';
import {createMemFs, memPath} from './memfs.mjs';
import {createBookkeeper, customApi, parseJson, keeperFailures} from './bookkeeper.mjs';
import {createView} from './view.mjs';
import {installStyle, createStatusView, popup, openingNode} from './ui.mjs';
import {createOpeningFlow} from './opening.mjs';
import {RECORD_KEY, RECORD_FORMAT, ownershipOf, swipeOf, validateRecord, storedManifest, sanitizeRaw, recordOf,
  failure, bookkeepingMeta, createHistoryAudit} from './records.mjs';
import {keeperSettings, showSettings, permissionFailure} from './settings.mjs';
import {stripCommands, fromText} from './commands-parser.mjs';
import bundle from './bundle.generated.json' with {type: 'json'};

const KEY = RECORD_KEY, INJECT_ID = 'yggdrasill-context';
const REQUIRED_MANIFEST_FIELDS = ['卡ID', '卡版本', '程序版本', '记录格式', '程序指纹', '世界书哈希', '兼容程序'];

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
const loaded = await compileWorldbook(bundle.root, {fs, path});
const decl = loaded.compiled.decl, catalog = loaded.catalog;
const loadErrors = loaded.issues.filter(item => item.级别 === '错误');
if (loadErrors.length) throw new Error(`世界书载入失败：${loadErrors.map(item => `${item.文件}：${item.说明}`).join('；')}`);
const settings = await readSettings(path.dirname(bundle.root), {fs, path, decl});
const protocol = createProtocol({catalog, decl});
const router = createRouter({catalog, decl, protocol, settings, templates: bundle.templates});
// 记账时叙事模型不写命令，变量更新规则换成这段说明。
const NARRATOR_RULES = `# 本局\n\n本局的状态由系统另行记录。正文里不宣布数值或状态的改变，也不写 <命令>。\n“待登记”中的事件已经发生，按已发生的事实叙述；“候选”中的事件在剧情走到时自然写出，不强求。\n\n## 地点\n\n{{地点列表}}`;
const quietRouter = createRouter({catalog, decl, protocol, settings, templates: {...bundle.templates, 变量更新规则: NARRATOR_RULES}});
const keeper = createBookkeeper({protocol, catalog, decl});
const view = createView({protocol, catalog, decl, keeper});
const history = createHistoryAudit({protocol, manifest});

const bookkeeping = () => keeperSettings().方式 !== '关闭';
const debugging = () => keeperSettings().调试 === true;

// ---------- 楼层记录与任务身份 ----------
const messages = () => getLastMessageId() < 0 ? [] : getChatMessages('0-' + getLastMessageId());

// 运行状态集中在一个对象里：状态视图与开局流程只读取这里，不再各自持有副本。
const session = {integrity: null, permission: null, last: null, openingPending: false, openingOpen: false,
  openingPopup: null, openingClosingForChat: false, keepingFloor: null};
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

function checkPermission() {
  const denied = permissionFailure({permissionIds, bookkeeping: bookkeeping()});
  if (denied) return status.permissionBlocked(denied);
  session.permission = null;
  return true;
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
  if (stopped) status.toastError(reason + '；未发送叙事请求。', '世界树：已阻止生成');
  else status.toastError('宿主没有提供可用的 stopGeneration，生成可能继续。' + (error ? ' ' + error.message : ''),
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
let keeping = false;

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
  session.keepingFloor = id;
  status.renderFloors();
  try { return await keepWith(base, {input, narration}, config, attempts, task); }
  finally { session.keepingFloor = null; }
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
      if (id === 0) return status.blocked({code: '开场.重复', 说明: '第 0 楼不会重新执行开场命令', 楼号: id});
      record = bookkeeping()
        ? await bookkeep(list, id, state, task)
        : fromText(protocol, state, message.message ?? '');
    } else {
      const stored = recordOf(message);
      const candidate = shifted && stored?.归属 && typeof stored.归属 === 'object'
        ? {...stored, 归属: {...stored.归属, 楼号: message.message_id}} : stored;
      const checked = validateRecord(candidate, message, manifest);
      if (!checked.ok) return status.blocked({...checked, 楼号: id});
      record = history.replay(state, candidate);
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
    if (record.replayFailed) return status.blocked({code: '重放.下游失效', 说明: '第 ' + id + ' 楼重放时有命令失败，已保留部分状态', 楼号: id});
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
  if (session.openingPending) {
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    return false;
  }
  if (session.integrity) {
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    return false;
  }
  const all = messages(), list = all.filter(message => message.message_id !== exclude);
  const end = exclude ?? all.length;
  const audit = history.audit(all, {end, skip: exclude});
  if (!audit.ok) return status.blocked(audit);
  try {
    const state = audit.state;
    const texts = list.filter(message => message.role !== 'system').map(message => stripCommands(message.message ?? ''));
    const quiet = bookkeeping();
    const {context, audit: routed} = route(quiet ? quietRouter : router, state, texts);
    const baseMessage = [...all.slice(0, end)].reverse().find(message => message.role === 'assistant');
    const baseRecord = baseMessage ? recordOf(baseMessage) : null;
    const content = (quiet ? '' : failureNote(baseRecord)) + renderContext(context) + reminder(state, quiet);
    injectPrompts([{id: INJECT_ID, position: 'in_chat', depth: 1, role: 'system', content}]);
    session.last = {content, audit: routed, exclude, state, 基于: exclude === null ? '楼层记录' : '前楼可信记录'};
  } catch (error) {
    return status.blocked({code: error instanceof ProtocolError ? error.code : '路由.失败', 说明: error.message, 楼号: null});
  }
  status.renderFloors();
  return true;
}

// ---------- 队列与事件 ----------
let queue = Promise.resolve();
const enqueue = job => {
  const run = queue.then(job);
  queue = run.catch(error => {
    toastr.error(error.message, '世界树：任务失败');
    status.blocked({code: '提交.失败', 说明: error.message});
  });
  return run;
};

function rekeepFor(id) {
  return () => enqueue(async () => {
    invalidateTasks();
    const list = messages(), prefix = history.audit(list, {end: id});
    if (!prefix.ok) return status.blocked(prefix);
    if (await replayFrom(id, prefix.state, {fresh: true, kind: '重新记账'})) refresh();
  });
}

const status = createStatusView({session, injectId: INJECT_ID, messages, recordOf,
  checkRecord: (record, message) => validateRecord(record, message, manifest).ok,
  floorOf: (before, after, record, verbose) => view.floor(before, after, record, {debug: verbose}),
  keeperSettings, openOpening: () => openingFlow.open(), rekeepFor});

const openingFlow = createOpeningFlow({protocol, catalog, decl, defaults: bundle.opening, commands: bundle.openingCommands,
  messages, chatId, ownershipOf, recordOf, validateRecord, manifest, store, taskFor, enqueue, refresh,
  audit: history.audit, session, status, nodeOf: draft => openingNode(draft), popup});

eventOn(tavern_events.GENERATION_AFTER_COMMANDS, async (type, options, dryRun) => {
  // 酒馆助手的 generateRaw 在记账中发 GENERATION_AFTER_COMMANDS，参数是空对象；它必须立即返回，避免等自己。
  // 酒馆按钮触发的正常生成参数非空，即使记账仍在进行也要等队列完成。
  if (dryRun || (keeping && options && typeof options === 'object' && Object.keys(options).length === 0)) return;
  await queue;
  const denied = permissionFailure({permissionIds, bookkeeping: bookkeeping()});
  if (denied) {
    status.permissionBlocked(denied);
    await stopHostGeneration('权限不足：' + denied.说明);
    return;
  }
  session.permission = null;
  if (session.openingPending) {
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    await stopHostGeneration('尚未开局');
    return;
  }
  if (session.integrity) { uninjectPrompts([INJECT_ID]); await stopHostGeneration(); return; }
  invalidateTasks();
  const list = messages(), tail = list.at(-1);
  const replacing = ['swipe', 'regenerate', 'continue'].includes(type) && tail?.role === 'assistant';
  const ok = refresh({exclude: replacing ? tail.message_id : null});
  if (!ok || session.integrity) await stopHostGeneration();
});

eventOn(tavern_events.MESSAGE_SENT, () => {
  invalidateTasks();
  if (session.openingPending) { uninjectPrompts([INJECT_ID]); status.renderFloors(); return; }
  return refresh();
});

eventOn(tavern_events.MESSAGE_RECEIVED, (id, type) => {
  invalidateTasks();
  return enqueue(async () => {
  if (session.integrity) return status.renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (message?.role !== 'assistant') return refresh();
  // 新聊天的开场白也会发 first_message 的“收到消息”事件；它由 init 写入开场命令记录，不是叙事模型新写的助手楼。
  if (number === 0 && type === 'first_message') return init();
  if (session.openingPending) return status.renderFloors();
  const prefix = history.audit(list, {end: number});
  if (!prefix.ok) return status.blocked(prefix);
  const stored = recordOf(message);
  // 酒馆会给新助手楼继承上一楼的变量；归属仍在旧楼时，它只是副本，不能当作本楼旧记录审计。
  if (stored !== undefined && stored?.归属?.楼号 === number) {
    const oldChain = history.audit(list, {ignoreOwnership: number});
    if (!oldChain.ok) return status.blocked(oldChain);
  }
  const downstream = history.checkRecords(list, {from: number + 1});
  if (!downstream.ok) return status.blocked(downstream);
  const changed = history.checkChangedAssistant(message);
  if (!changed.ok) return status.blocked({...changed, 楼号: number});
  if (!(await replayFrom(number, prefix.state, {fresh: true, kind: '新正文'}))) return;
  refresh();
  });
});

eventOn(tavern_events.MESSAGE_EDITED, id => {
  invalidateTasks();
  return enqueue(async () => {
  if (session.integrity) return status.renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (!message || message.role === 'system') return refresh();
  if (session.openingPending) return status.renderFloors();
  const prefix = history.audit(list, {end: number});
  if (!prefix.ok) return status.blocked(prefix);
  if (message.role === 'user') {
    const full = history.audit(list);
    if (!full.ok) return status.blocked(full);
    const downstream = history.checkRecords(list, {from: number + 1});
    if (!downstream.ok) return status.blocked(downstream);
    if (await replayFrom(number + 1, prefix.state, {kind: '编辑玩家楼后重放'})) refresh();
  } else {
    if (recordOf(message) !== undefined) {
      const oldChain = history.audit(list, {ignoreOwnership: number});
      if (!oldChain.ok) return status.blocked(oldChain);
    }
    const downstream = history.checkRecords(list, {from: number + 1});
    if (!downstream.ok) return status.blocked(downstream);
    const changed = history.checkChangedAssistant(message);
    if (!changed.ok) return status.blocked({...changed, 楼号: number});
    if (await replayFrom(number, prefix.state, {fresh: true, kind: '编辑助手楼后记账'})) refresh();
  }
  });
});

eventOn(tavern_events.MESSAGE_SWIPED, id => {
  invalidateTasks();
  return enqueue(async () => {
  if (session.integrity) return status.renderFloors();
  const number = Number(id), list = messages(), message = list[number];
  if (session.openingPending) return status.renderFloors();
  const prefix = history.audit(list, {end: number});
  if (!prefix.ok) return status.blocked(prefix);
  if (message?.role !== 'assistant') return refresh();
  if (!message.message) {
    if (list.slice(number + 1).some(item => item.role === 'assistant'))
      return status.blocked({code: '记录.当前 swipe', 说明: '空 swipe 后面还有助手楼，不能跳过它作答', 楼号: number});
    refresh({exclude: number});
    return;
  }
  const checked = validateRecord(recordOf(message), message, manifest);
  if (!checked.ok) return status.blocked({...checked, 楼号: number});
  const all = history.checkRecords(list);
  if (!all.ok) return status.blocked(all);
  if (await replayFrom(number, prefix.state, {kind: '切换 swipe 重放'})) refresh();
  });
});

// 删除事件只带新长度。从第 0 楼起用保留楼层的成功命令重放，不能只刷新显示。
eventOn(tavern_events.MESSAGE_DELETED, () => {
  invalidateTasks();
  return enqueue(async () => {
  if (session.integrity) return status.renderFloors();
  if (session.openingPending) return status.renderFloors();
  const list = messages(), checked = history.checkRecords(list, {shifted: true});
  if (!checked.ok) return status.blocked(checked);
  const opening = list[0]?.role === 'assistant' ? recordOf(list[0]) : null;
  const root = validateRecord(opening, list[0], manifest);
  if (!root.ok) return status.blocked({...root, 楼号: 0});
  if (await replayFrom(1, opening.本局, {kind: '删除楼层后传播', shifted: true})) refresh();
  });
});

eventOn(tavern_events.CHAT_CHANGED, () => {
  invalidateTasks();
  return enqueue(async () => {
  if (session.openingPopup) {
    session.openingClosingForChat = true;
    try { await session.openingPopup.completeCancelled(); } catch {}
    session.openingClosingForChat = false;
    session.openingPopup = null;
  }
  session.integrity = null; session.permission = null; session.last = null; session.keepingFloor = null; session.openingPending = false; session.openingOpen = false;
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
  if (!list.length) { status.pendingOpening('尚未开局：等待开场白'); return; }
  const opening = list[0];
  if (opening.role === 'assistant' && !recordOf(opening)) {
    // 新聊天只有开场白时先交给开局前端；确认并成功写第 0 楼之前不执行开场命令。
    if (list.length !== 1) return status.blocked({code: '记录.缺失', 说明: '第 0 楼缺少正式记录，后面的楼层不能越过缺口', 楼号: 0});
    session.openingPending = true;
    session.integrity = null;
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    void openingFlow.open();
    return;
  }
  session.openingPending = false;
  const audit = history.audit(list);
  if (!audit.ok) return status.blocked(audit);
  refresh();
}

// ---------- 按钮 ----------
eventOn(getButtonEvent('世界树：开局'), () => openingFlow.open());

eventOn(getButtonEvent('世界树：本轮上下文'), () => {
  if (session.openingPending) return status.show('尚未开局', '请先完成开局。确认前不会创建本局或注入叙事上下文。');
  if (session.integrity) return status.showBlocked();
  if (!debugging()) return status.show('本轮上下文', '本轮上下文中有尚未发生的事件。要看，先在“世界树：设置”中打开调试。');
  if (!session.last || session.last.error) refresh();
  if (session.last?.error) return status.show('本轮上下文', '路由失败：' + session.last.error);
  status.show('本轮上下文（' + [...session.last.content].length + ' 字符，基于' + session.last.基于 + '）',
    session.last.content + '\n\n===== 审计 =====\n' + stringifyYaml(session.last.audit));
});
eventOn(getButtonEvent('世界树：本局'), () => {
  if (session.openingPending) return status.show('尚未开局', '请先完成开局。确认前没有可显示的本局记录。');
  if (session.integrity) return status.showBlocked();
  const state = session.last?.state ?? seal(protocol, bundle.opening);
  if (!debugging()) return status.showSections('本局', view.player(state));
  const floors = messages().map(message => ({楼号: message.message_id, 角色: message.role, 记录: recordOf(message)}))
    .filter(item => item.角色 === 'assistant' && validateRecord(item.记录, messages()[item.楼号], manifest).ok);
  status.showSections('本局（调试）', view.debug(state, floors));
});
eventOn(getButtonEvent('世界树：重新记账'), () => enqueue(async () => {
  if (session.openingPending) return toastr.warning('尚未开局，没有可以记账的楼', '世界树');
  if (session.integrity) return status.renderFloors();
  const id = [...messages()].reverse().find(message => message.role === 'assistant' && message.message_id > 0)?.message_id;
  if (id === undefined) return toastr.warning('没有可以记账的楼', '世界树');
  const list = messages(), prefix = history.audit(list, {end: id});
  if (!prefix.ok) return status.blocked(prefix);
  const records = history.checkRecords(list, {from: id});
  if (!records.ok) return status.blocked(records);
  invalidateTasks();
  if (await replayFrom(id, prefix.state, {fresh: true, kind: '重新记账'})) refresh();
}));

eventOn(getButtonEvent('世界树：设置'), () => showSettings({call: callKeeper, parse: parseJson, queue: enqueue, refresh}));

installStyle();
await init();
toastr.success(catalog.groups.length + ' 角色组，' + catalog.events.length + ' 事件', '世界树原型已启动');
