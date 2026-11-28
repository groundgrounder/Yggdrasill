// 酒馆适配运行时：在酒馆助手的脚本 iframe 中运行内核。每轮生成前路由并注入上下文；收到回复后得到这一楼的命令，经协议写入，
// 连同命令存进该楼该 swipe 的楼层变量，重算时照存下的命令重放。命令有两种来源：记账（另调一次模型填 JSON，见 bookkeeper.mjs），
// 或旧方式由叙事模型在正文末尾写 <命令>。开场命令由卡面的独立列表给出，只在新聊天第 0 楼执行。每楼下方显示这一楼记了什么（见 view.mjs），不进提示词。
// 依赖酒馆助手注入 iframe 的全局：getChatMessages、getLastMessageId、getVariables、replaceVariables、injectPrompts、uninjectPrompts、
// eventOn、tavern_events、getButtonEvent、generateRaw、getModelList、getProxyPresetNames、retrieveDisplayedMessage、toastr、SillyTavern、
// 兼容阻断时用宿主 stopGeneration 或 triggerSlash('/stop') 真正中止生成；$（酒馆页面的 jQuery）。
import {compileWorldbook} from '../core/catalog.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {applyCommands} from '../core/commands.mjs';
import {evaluateCondition, conditionReferences} from '../core/conditions.mjs';
import {createProtocol, seal, ProtocolError} from '../core/protocol.mjs';
import {createRouter, route, renderContext} from '../core/router.mjs';
import {readSettings} from '../core/settings.mjs';
import {stringifyYaml} from '../core/yaml.mjs';
import {isMap} from '../core/utils.mjs';
import {createMemFs, memPath} from './memfs.mjs';
import {createBookkeeper, customApi, parseJson, runKeeperLoop, buildKeepRecord, repairRecord} from './bookkeeper.mjs';
import {createView} from './view.mjs';
import {installStyle, applyProseAppearance, createStatusView, popup, modalPopup, openingNode, repairNode} from './ui.mjs';
import {
  BUILTIN_THEMES, resolveAppearance, buildThemeCss, validateThemeCss,
  validateThemeEntry, sanitizeCustomCss, enhanceProseNode, clearProseEnhancements,
} from './themes.mjs';
import {createOpeningDraft, createOpeningFlow, isDynamicOpening, dynamicOpeningBase} from './opening.mjs';
import {RECORD_KEY, RECORD_FORMAT, ownershipOf, swipeOf, validateRecord, validateManifest, storedManifest, sanitizeText,
  recordOf, createHistoryAudit, emptyTailAssistant} from './records.mjs';
import {createUpgradeFlow} from './upgrade.mjs';
import {keeperSettings, appearanceSettings, saveAppearance, showSettings, permissionFailure, createOpeningStorage} from './settings.mjs';
import {stripCommands, fromText} from './commands-parser.mjs';
import {registerAdapterEvents} from './events.mjs';
import bundle from './bundle.generated.json' with {type: 'json'};

const KEY = RECORD_KEY, INJECT_ID = 'yggdrasill-context';
const manifest = validateManifest(bundle.manifest, bundle.files);
const checkCompatRecord = (record, message) => validateRecord(record, message, manifest, RECORD_FORMAT, {allowWorldbookDiff: true});
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
const session = {integrity: null, upgrade: null, compatNotified: false, permission: null, last: null,
  openingPending: false, openingOpen: false, openingPopup: null, repairPopup: null, openingClosingForChat: false,
  openingSelfEdit: null, keepingFloor: null, dynamicOpening0: null};
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

const BUSY_MSG = '当前有回复正在生成或末尾楼层为空，请等待生成完成或删除空楼后再操作。';
const isGeneratingOrEmptyTail = (list, id = null) => ((typeof SillyTavern !== 'undefined'
  && SillyTavern.getContext?.()?.is_send_press === true) || emptyTailAssistant(list) || (id !== null && !(list[id]?.message ?? '')))
  ? BUSY_MSG : null;

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
  const loop = await runKeeperLoop({keeper, base, input, narration, config, attempts, call: callKeeper,
    isCurrent: () => !task || taskCurrent(task)});
  if (loop.stale) return {stale: true};
  return buildKeepRecord({base, loop, config, debugging: debugging()});
}

async function generateOpening({state, mode, hint}) {
  const quiet = bookkeeping();
  const {context} = route(quiet ? quietRouter : router, state, []);
  const sys = renderContext(context) + '\n\n请根据以上本局设定、当前时间、地点与主角身份，写出一段有画面感、自然留出玩家行动入口的开篇正文。'
    + (quiet ? '只写正文，不要输出 <命令> 或状态块。' : '如需变更场景或触发事件，在正文末尾按协议附 <命令>。');
  const usr = mode === '提示扩写' && hint
    ? `请将以下开场提示自然融入开篇正文：${hint}`
    : '请直接开始本局的开篇正文。';
  keeping = true;
  uninjectPrompts([INJECT_ID]);
  try {
    const text = await generateRaw({ordered_prompts: [{role: 'system', content: sys}, {role: 'user', content: usr}], should_stream: false});
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('叙事模型未返回有效开场白'), {code: '开局.生成失败'});
    return text.trim();
  } finally { keeping = false; }
}

async function bookkeepOpening(baseState, greeting) {
  const config = keeperSettings(), attempts = Math.min(3, Math.max(1, Math.round(Number(config.尝试次数) || 2)));
  session.keepingFloor = 0;
  status.renderFloors();
  try { return await keepWith(baseState, {input: '', narration: stripCommands(greeting ?? '')}, config, attempts, null); }
  finally { session.keepingFloor = null; }
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
async function replayFrom(from, base, {fresh = false, kind = '重放', shifted = false, end = null} = {}) {
  let state = base, list = messages();
  history.invalidateFrom(Math.max(0, from));
  for (let id = Math.max(0, from); id < (end === null ? list.length : Math.min(end, list.length)); id++) {
    const message = list[id];
    if (message.role !== 'assistant') continue;
    const task = taskFor(id, fresh && id === from ? kind : '重放');
    if (!task) break;
    let record;
    if (fresh && id === from) {
      if (id === 0) {
        const originRecord = isDynamicOpening(recordOf(message)) ? recordOf(message) : session.dynamicOpening0;
        if (!originRecord) return status.blocked({code: '开场.重复', 说明: '第 0 楼不会重新执行开场命令', 楼号: id});
        const {baseState, baseCommands, baseWritten} = dynamicOpeningBase(protocol, originRecord);
        const keep = bookkeeping() ? await bookkeep(list, 0, baseState, task) : fromText(protocol, baseState, message.message ?? '');
        if (keep.stale || !taskCurrent(task)) return false;
        record = keep.命令 === null
          ? {...keep, 本局: baseState, 命令: null, 已写入: baseWritten, 记账: {...keep.记账, 方式: originRecord.记账.方式}}
          : {...keep, 命令: [...baseCommands, ...keep.命令], 已写入: [...baseWritten, ...(keep.已写入 ?? [])],
            记账: {...keep.记账, 方式: originRecord.记账.方式}};
      } else {
        record = bookkeeping()
          ? await bookkeep(list, id, state, task)
          : fromText(protocol, state, message.message ?? '');
      }
    } else {
      const stored = recordOf(message);
      const candidate = shifted && stored?.归属 && typeof stored.归属 === 'object'
        ? {...stored, 归属: {...stored.归属, 楼号: message.message_id}} : stored;
      const checked = checkCompatRecord(candidate, message);
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
  if (session.openingPending || session.integrity || session.upgrade) {
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    return false;
  }
  const all = messages(), skip = exclude ?? emptyTailAssistant(all)?.message_id ?? null;
  const list = all.filter(message => message.message_id !== skip), end = skip ?? all.length;
  const audit = history.audit(all, {end, skip});
  if (!audit.ok) return status.blocked(audit);
  if (audit.worldbook?.级别 === 'A' && !session.compatNotified) {
    session.compatNotified = true;
    toastr.info('世界书内容已更新，当前存档完全兼容；新楼将写入当前版本清单。', '世界树：存档兼容');
  }
  if (isDynamicOpening(recordOf(all[0]))) session.dynamicOpening0 = structuredClone(recordOf(all[0]));
  try {
    const state = audit.state;
    const texts = list.filter(message => message.role !== 'system').map(message => stripCommands(message.message ?? ''));
    const quiet = bookkeeping();
    const {context, audit: routed} = route(quiet ? quietRouter : router, state, texts);
    const baseMessage = [...all.slice(0, end)].reverse().find(message => message.role === 'assistant');
    const baseRecord = baseMessage ? recordOf(baseMessage) : null;
    const content = (quiet ? '' : failureNote(baseRecord)) + renderContext(context) + reminder(state, quiet);
    injectPrompts([{id: INJECT_ID, position: 'in_chat', depth: 1, role: 'system', content}]);
    session.last = {content, audit: routed, exclude: skip, state, 基于: skip === null ? '楼层记录' : '前楼可信记录'};
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
    const safe = sanitizeText(error.message);
    toastr.error(safe, '世界树：任务失败');
    status.blocked({code: '提交.失败', 说明: safe});
  });
  return run;
};

async function rekeepFloor(list, id) {
  const busy = isGeneratingOrEmptyTail(list, id);
  if (busy) return toastr.warning(busy, '世界树');
  if (id === 0 && !isDynamicOpening(recordOf(list[0]))) return;
  const prefix = id === 0 ? {ok: true, state: null} : history.audit(list, {end: id});
  if (!prefix.ok) return status.blocked(prefix);
  const records = history.checkRecords(list, {from: id, allowWorldbookDiff: true});
  if (!records.ok) return status.blocked(records);
  history.invalidateFrom(id);
  invalidateTasks();
  if (await replayFrom(id, prefix.state, {fresh: true, kind: '重新记账'})) refresh();
}
const rekeepFor = id => () => enqueue(() => rekeepFloor(messages(), id));

function buildRepairTarget(list, id, curRecord) {
  if (id === 0) {
    if (!isDynamicOpening(curRecord)) return {ok: false, code: '开场.修补', 说明: '静态预设开局第 0 楼不支持修补', 楼号: 0};
    const {baseState, baseCommands, baseWritten} = dynamicOpeningBase(protocol, curRecord);
    const keeperRecord = {
      ...curRecord,
      命令: Array.isArray(curRecord.命令) ? curRecord.命令.slice(baseCommands.length) : curRecord.命令,
      已写入: Array.isArray(curRecord.已写入) ? curRecord.已写入.slice(baseWritten.length) : curRecord.已写入,
    };
    return {ok: true, baseState, baseCommands, baseWritten, keeperRecord, input: '', openingMode: curRecord.记账.方式};
  }
  const pre = history.audit(list, {end: id});
  if (!pre.ok) return pre;
  const input = [...list.slice(0, id)].reverse().find(item => item.role === 'user')?.message ?? '';
  return {ok: true, baseState: pre.state, baseCommands: [], baseWritten: [], keeperRecord: curRecord, input, openingMode: null};
}

async function openRepair(id) {
  if (session.openingPending || session.integrity || session.upgrade || !bookkeeping() || id < 0) return;
  const list = messages(), busy = isGeneratingOrEmptyTail(list, id);
  if (busy) return toastr.warning(busy, '世界树');
  const message = list[id], record = recordOf(message);
  if (!message || message.role !== 'assistant' || !checkCompatRecord(record, message).ok) return;
  if (id === 0 && !isDynamicOpening(record)) return;
  const target = buildRepairTarget(list, id, record);
  if (!target.ok) return status.blocked(target);
  const debug = debugging();
  const line = view.floor(target.baseState, record.本局, record, {debug});
  const origin = {聊天ID: chatId(), ...ownershipOf(message)};
  const dialog = repairNode({
    id, line, record, debug,
    ...(debug ? {commandsText: stringifyYaml(record.命令 ?? null)} : {}),
  });
  await modalPopup(dialog.node, {wide: true, large: true, okButton: '开始修补', cancelButton: '取消',
    onClosing: async instance => {
      if (session.openingClosingForChat) return true;
      if (instance?.result !== (SillyTavern.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return true;
      const instruction = dialog.getInstruction();
      dialog.setError('');
      return enqueue(async () => {
        if (session.openingPending || session.integrity || session.upgrade || !bookkeeping()) { dialog.setError('当前状态不可修补'); return false; }
        const nowList = messages(), nowMsg = nowList[id], nowBusy = isGeneratingOrEmptyTail(nowList, id);
        if (nowBusy) { dialog.setError(nowBusy); toastr.warning(nowBusy, '世界树'); return false; }
        if (chatId() !== origin.聊天ID || !nowMsg || nowMsg.role !== 'assistant'
          || swipeOf(nowMsg) !== origin.swipe || ownershipOf(nowMsg).正文指纹 !== origin.正文指纹) return true;
        const curRecord = recordOf(nowMsg);
        if (id === 0 && !isDynamicOpening(curRecord)) { dialog.setError('静态预设开局第 0 楼不支持修补'); return false; }
        const nowTarget = buildRepairTarget(nowList, id, curRecord);
        if (!nowTarget.ok) { dialog.setError(nowTarget.说明); return false; }
        const down = history.checkRecords(nowList, {from: id, allowWorldbookDiff: true});
        if (!down.ok) { dialog.setError(down.说明); return false; }
        if (!instruction.trim() && !(curRecord?.失败?.length)) {
          dialog.setError('本楼没有失败项，如需调整请填写修补说明');
          return false;
        }
        invalidateTasks();
        const task = taskFor(id, '修补记账');
        if (!task) return true;
        const config = keeperSettings(), attempts = Math.min(3, Math.max(1, Math.round(Number(config.尝试次数) || 2)));
        session.keepingFloor = id;
        status.renderFloors();
        let outcome;
        try {
          outcome = await repairRecord({
            keeper, protocol, base: nowTarget.baseState, record: nowTarget.keeperRecord, input: nowTarget.input,
            narration: stripCommands(nowMsg.message ?? ''), instruction, config, attempts, debugging: debugging(),
            call: callKeeper, isCurrent: () => taskCurrent(task),
          });
        } finally {
          session.keepingFloor = null;
          if (taskCurrent(task)) status.renderFloors();
        }
        if (outcome.stale || !taskCurrent(task)) return true;
        if (!outcome.ok) {
          const message = !debugging() && outcome.code === '修补.仍有失败'
            ? '修补后仍有局部失败，未覆盖原记录；可调整修补说明重试，或在“世界树：设置”开启调试查看细节。'
            : outcome.说明;
          dialog.setError(message);
          return false;
        }
        const finalRecord = id === 0 ? {
          ...outcome.record,
          命令: [...nowTarget.baseCommands, ...(outcome.record.命令 ?? [])],
          已写入: [...nowTarget.baseWritten, ...(outcome.record.已写入 ?? [])],
          失败: [],
          记账: {...outcome.record.记账, 方式: nowTarget.openingMode},
        } : outcome.record;
        try {
          history.invalidateFrom(id);
          if (!(await store(id, finalRecord, task))) return true;
        } catch (error) {
          dialog.setError('写入失败：' + sanitizeText(error.message));
          return false;
        }
        if (!(await replayFrom(id + 1, finalRecord.本局, {kind: '修补后重放'}))) return true;
        refresh();
        toastr.success(finalRecord.已写入.length ? finalRecord.已写入.join('、') : '已修补', `世界树：第 ${id} 楼已修补`);
        return true;
      });
    },
  }, (popupInstance, old) => {
    if (popupInstance) session.repairPopup = popupInstance;
    else if (!old || session.repairPopup === old) session.repairPopup = null;
  });
}

const cardThemes = Array.isArray(bundle.themes) ? bundle.themes : [];
const currentAppearance = () => resolveAppearance(appearanceSettings(), cardThemes);

let upgradeFlow = null;
const status = createStatusView({session, injectId: INJECT_ID, messages, chatId, recordOf,
  checkRecord: (record, message) => checkCompatRecord(record, message).ok,
  floorOf: (before, after, record, verbose) => view.floor(before, after, record, {debug: verbose}),
  keeperSettings, openOpening: () => openingFlow.open(), rekeepFor, repairFor: id => () => openRepair(id),
  runUpgrade: () => upgradeFlow.upgrade(), getAppearance: currentAppearance});

function applyCurrentAppearance(overrideConfig = null) {
  const resolved = resolveAppearance(overrideConfig ?? appearanceSettings(), cardThemes);
  installStyle(resolved);
  status.renderFloors();
  return resolved;
}
upgradeFlow = createUpgradeFlow({manifest, recordKey: KEY, recordFormat: RECORD_FORMAT, validateRecord, ownershipOf,
  sanitizeText, messages, chatId, enqueue, audit: history.audit, clearCache: history.clearCache, refresh, session, status});

function refreshOpening0(originRecord) {
  if (!checkPermission()) return false;
  try {
    const {baseState} = dynamicOpeningBase(protocol, originRecord), quiet = bookkeeping();
    const {context, audit: routed} = route(quiet ? quietRouter : router, baseState, []);
    const content = renderContext(context) + reminder(baseState, quiet);
    injectPrompts([{id: INJECT_ID, position: 'in_chat', depth: 1, role: 'system', content}]);
    session.last = {content, audit: routed, exclude: 0, state: baseState, 基于: '开局封卷底本'};
    status.renderFloors();
    return true;
  } catch (error) {
    return status.blocked({code: error instanceof ProtocolError ? error.code : '路由.失败', 说明: error.message, 楼号: 0});
  }
}

const openingStorage = createOpeningStorage(manifest.卡ID);
const openingFlow = createOpeningFlow({protocol, catalog, decl, defaults: bundle.opening, commands: bundle.openingCommands,
  openingSpec: {openingGreeting: bundle.openingGreeting, commands: bundle.openingCommands,
    optionalPresent: bundle.openingOptionalPresent, requiredGroups: bundle.openingRequiredGroups,
    planOpenings: bundle.planOpenings},
  generateOpening, bookkeepOpening, bookkeeping, openingStorage,
  messages, chatId, ownershipOf, recordOf, validateRecord, manifest, store, taskFor, enqueue, refresh,
  audit: history.audit, session, status, nodeOf: (draft, options) => openingNode(draft, options), popup});

async function init() {
  if (!checkPermission()) return;
  const list = messages();
  if (!list.length) { status.pendingOpening('尚未开局：等待开场白'); return; }
  const opening = list[0];
  if (opening.role === 'assistant' && !recordOf(opening)) {
    // 新聊天只有开场白时不自动弹窗，先在第 0 楼下方展示待开局引导卡；由玩家点击「打开开局」或顶栏「世界树：开局」开启，确认并成功写第 0 楼之前不执行开场命令。
    if (list.length !== 1) return status.blocked({code: '记录.缺失', 说明: '第 0 楼缺少正式记录，后面的楼层不能越过缺口', 楼号: 0});
    session.openingPending = true;
    session.integrity = null;
    session.upgrade = null;
    uninjectPrompts([INJECT_ID]);
    status.renderFloors();
    return;
  }
  session.openingPending = false;
  refresh();
}

registerAdapterEvents({
  INJECT_ID, manifest, bundle, protocol, view, history, session, messages, invalidateTasks, enqueue,
  checkPermission, isGeneratingOrEmptyTail, stopHostGeneration, isKeeping: () => keeping, bookkeeping, debugging,
  refresh, refreshOpening0, isDynamicOpening, replayFrom, rekeepFloor, openRepair, init, checkCompatRecord,
  openingFlow, status, recordOf, emptyTailAssistant, callKeeper, parseJson, showSettings, cardThemes,
  onAppearanceChange: nextConfig => applyCurrentAppearance(nextConfig), stringifyYaml, seal, ownershipOf,
});

installStyle(currentAppearance());
await init();
toastr.success(catalog.groups.length + ' 角色组，' + catalog.events.length + ' 事件', '世界树已启动');
if (typeof globalThis.__YGG_PLAYTEST_HOOK__ === 'function') {
  globalThis.__YGG_PLAYTEST_HOOK__(Object.freeze({
    bundle, manifest, loaded, decl, catalog, settings, protocol, router, quietRouter, keeper,
    createOpeningDraft, openingNode, runKeeperLoop, buildKeepRecord, repairRecord, callKeeper, generateOpening,
    parseJson, applyCommands, route, renderContext, stringifyYaml, createCalendar, evaluateCondition, conditionReferences, seal,
    cardThemes, BUILTIN_THEMES, resolveAppearance, buildThemeCss, validateThemeCss, validateThemeEntry,
    sanitizeCustomCss, enhanceProseNode, clearProseEnhancements, appearanceSettings, saveAppearance,
    applyCurrentAppearance, applyProseAppearance,
  }));
}
