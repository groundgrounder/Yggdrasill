// 正式楼层记录：正文归属、运行清单兼容、字段完整性、历史裁决与快照重放。这里只做纯计算，不读写酒馆。
// 正文指纹使用 UTF-8 字节的 SHA-256；浏览器与 node 共用，不能依赖 node:crypto。
import {applyCommands} from '../core/commands.mjs';
import {isMap} from '../core/utils.mjs';
import {assessWorldbookCompat, canonical, sameSnapshot} from './upgrade.mjs';

export {canonical, sameSnapshot};

export const RECORD_KEY = '世界树';
export const RECORD_FORMAT = 1;
export const REQUIRED_FIELDS = ['记录格式', '运行清单', '归属', '本局', '命令', '失败', '已写入', '记账'];
export const MANIFEST_FIELDS = ['卡ID', '卡版本', '程序版本', '记录格式', '程序指纹', '世界书哈希', '兼容程序'];
const HEX64 = /^[0-9a-f]{64}$/;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
const hex = value => (value >>> 0).toString(16).padStart(8, '0');

// 对字符串的严格 UTF-8 编码计算 SHA-256。TextEncoder 会把孤立代理项写成 U+FFFD，与 node Buffer 的 UTF-8 一致。
export function sha256Utf8(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const zeros = (64 - ((bytes.length + 9) % 64)) % 64, total = bytes.length + 9 + zeros;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer), bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(total - 4, bits >>> 0, false);
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return state.map(hex).join('');
}

export function swipeOf(message) {
  for (const value of [message?.swipe_id, message?.swipeId, message?.data?.swipe_id, 0]) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
}

export function ownershipOf(message) {
  return {
    楼号: Number(message?.message_id),
    角色: message?.role,
    swipe: swipeOf(message),
    正文指纹: sha256Utf8(message?.message ?? ''),
  };
}

function issue(code, message, extra = {}) {
  return {ok: false, code, 说明: message, ...extra};
}

// 每楼只保留兼容判定必需的最小清单；构建清单仍留在 bundle 里供 validateManifest 对照文件树。
export function storedManifest(manifest) {
  if (!isMap(manifest)) throw new Error('当前构建清单缺失');
  const stored = {};
  for (const field of MANIFEST_FIELDS) {
    if (!Object.hasOwn(manifest, field)) throw new Error(`构建清单缺少字段：${field}`);
    const value = manifest[field];
    stored[field] = Array.isArray(value) ? [...value] : isMap(value) ? {...value} : value;
  }
  return stored;
}

export function validateManifest(value, mountedFiles = null) {
  if (!isMap(value)) throw new Error('构建清单缺失或不是映射');
  for (const field of MANIFEST_FIELDS) if (!Object.hasOwn(value, field)) throw new Error(`构建清单缺少字段：${field}`);
  if (typeof value.卡ID !== 'string' || !value.卡ID || typeof value.卡版本 !== 'string' || !value.卡版本 || typeof value.程序版本 !== 'string' || !value.程序版本)
    throw new Error('构建清单的卡ID、卡版本或程序版本不合法');
  if (value.记录格式 !== RECORD_FORMAT) throw new Error(`不支持的记录格式：${value.记录格式}`);
  for (const field of ['程序指纹', '世界书哈希']) if (!HEX64.test(value[field])) throw new Error(`构建清单 ${field} 不合法`);
  if (!Array.isArray(value.兼容程序) || !Array.isArray(value.世界书文件) || !Array.isArray(value.程序文件)) throw new Error('构建清单列表字段不合法');
  for (const item of [...value.世界书文件, ...value.程序文件]) {
    if (!isMap(item) || typeof item.路径 !== 'string' || !Number.isSafeInteger(item.长度) || item.长度 < 0 || !HEX64.test(item.SHA256))
      throw new Error('构建清单文件条目不合法');
    const virtual = item.路径.startsWith('/项目/'), relative = virtual ? item.路径.slice('/项目/'.length) : item.路径;
    if ((!virtual && item.路径.startsWith('/')) || relative.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error(`构建清单路径逃逸：${item.路径}`);
  }
  if (mountedFiles) {
    const declared = value.世界书文件.map(item => item.路径).sort();
    const mounted = Object.keys(mountedFiles).sort();
    if (JSON.stringify(declared) !== JSON.stringify(mounted)) throw new Error('内存世界书与构建清单文件列表不一致');
  }
  return value;
}

export function manifestIssue(stored, current, {allowWorldbookDiff = false} = {}) {
  if (!isMap(stored)) return issue('运行清单.缺失', '记录没有运行清单');
  for (const field of MANIFEST_FIELDS) if (!Object.hasOwn(stored, field)) return issue(`运行清单.${field}`, `运行清单缺少字段：${field}`);
  if (!isMap(current)) return issue('运行清单.当前', '当前构建清单缺失');
  if (stored.卡ID !== current.卡ID) return issue('运行清单.卡ID', `卡ID不一致：${stored.卡ID ?? '未写'} ≠ ${current.卡ID}`);
  if (stored.记录格式 !== current.记录格式) return issue('运行清单.记录格式', `运行清单记录格式不一致：${stored.记录格式} ≠ ${current.记录格式}`);
  if (typeof stored.世界书哈希 !== 'string' || !HEX64.test(stored.世界书哈希))
    return issue('运行清单.世界书哈希', `世界书哈希格式不合法：${stored.世界书哈希 ?? '未写'}`);
  const compatible = Array.isArray(current.兼容程序) ? current.兼容程序 : [];
  if (stored.程序指纹 !== current.程序指纹 && !compatible.includes(stored.程序指纹))
    return issue('运行清单.程序指纹', `程序指纹不兼容：${stored.程序指纹 ?? '未写'}`);
  if (!allowWorldbookDiff && stored.世界书哈希 !== current.世界书哈希)
    return issue('运行清单.世界书哈希', '世界书哈希不一致');
  return {ok: true};
}

export function validateRecord(record, message, currentManifest, currentFormat = RECORD_FORMAT, {allowWorldbookDiff = false} = {}) {
  if (!isMap(record)) return issue('记录.缺失', message?.role === 'assistant' ? '助手楼没有记录' : '这里没有可用的世界树记录');
  if (message?.role !== 'assistant') return issue('记录.角色', `玩家楼或系统楼的记录不能作为助手记录（${message?.role ?? '未知角色'}）`);
  for (const field of REQUIRED_FIELDS) {
    if (Object.hasOwn(record, field)) continue;
    if (field === '运行清单') return issue('运行清单.缺失', '记录没有运行清单');
    if (field === '归属') return issue('归属.格式', '记录没有正文归属');
    return issue('记录.字段', `记录缺少字段：${field}`);
  }
  if (!Number.isSafeInteger(record.记录格式)) return issue('记录.格式', '记录格式须为整数');
  if (record.记录格式 !== currentFormat) return issue('记录.格式', `记录格式不同：${record.记录格式} ≠ ${currentFormat}`);
  const compatible = manifestIssue(record.运行清单, currentManifest, {allowWorldbookDiff});
  if (!compatible.ok) return compatible;
  if (!isMap(record.归属)) return issue('归属.格式', '记录没有正文归属');
  const expected = ownershipOf(message);
  for (const field of ['楼号', '角色', 'swipe', '正文指纹']) {
    if (record.归属[field] !== expected[field]) return issue('归属.失配', `归属${field}与当前正文不一致`, {期望: expected[field], 实际: record.归属[field]});
  }
  if (!isMap(record.本局)) return issue('记录.本局', '记录的本局不是映射');
  if (record.命令 !== null && !Array.isArray(record.命令)) return issue('记录.命令', '命令须为列表或 null');
  if (!Array.isArray(record.失败)) return issue('记录.失败', '失败须为列表');
  for (const item of record.失败) {
    if (!isMap(item) || typeof item.阶段 !== 'string' || typeof item.错误码 !== 'string' || typeof item.说明 !== 'string')
      return issue('记录.失败', '失败项须有阶段、错误码与说明');
  }
  if (!Array.isArray(record.已写入) || record.已写入.some(item => typeof item !== 'string')) return issue('记录.已写入', '已写入须为文本列表');
  if (!isMap(record.记账)) return issue('记录.记账', '记账须为映射');
  for (const field of ['方式', '应答格式', '状态']) if (typeof record.记账[field] !== 'string') return issue('记录.记账', `记账缺少字段：${field}`);
  if (!Number.isSafeInteger(record.记账.尝试次数) || record.记账.尝试次数 < 0) return issue('记录.记账', '记账尝试次数须为非负整数');
  return {ok: true, 归属: expected};
}

// 执行记录中可重放的命令。调用方只保存成功命令；这里按执行结果再裁掉因新底本失效的命令。
export function replayRecord(record, base, applyCommands) {
  if (record.命令 === null) return {state: base, commands: null, 已写入: [], 失败: [], 命令数: 0};
  const commands = record.命令 ?? [], result = applyCommands(base, commands);
  const failed = new Set((result.失败 ?? []).map(item => Number(item.序号) - 1));
  return {state: result.state, commands: commands.filter((command, index) => !failed.has(index)), 已写入: result.已写入 ?? [],
    失败: result.失败 ?? [], 命令数: commands.length};
}

export function sanitizeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[已隐藏]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[已隐藏]');
}

// 原始记账结果只在调试开启时写进记录；递归删除常见的连接凭据键和值，避免把设置误带进楼层变量。
export function sanitizeRaw(value, key = '') {
  if (/(?:密钥|秘钥|api[_-]?key|authorization|token|password|secret)/i.test(key)) return '[已隐藏]';
  if (Array.isArray(value)) return value.map(item => sanitizeRaw(item));
  if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, sanitizeRaw(item, child)]));
  return typeof value === 'string' ? sanitizeText(value) : value;
}

// 任务的楼层记录挂在 message.data 的固定键下；玩家楼即使带着复制变量也不是助手记录。
export const recordOf = message => message?.data?.[RECORD_KEY];

// 严格判定末尾空白占位助手楼：仅当存在最后一条 role === 'assistant'、message_id > 0 且正文严格为空时返回该楼。
export function emptyTailAssistant(list) {
  if (!Array.isArray(list) || !list.length) return null;
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index];
    if (message?.role !== 'assistant') continue;
    if (!(Number(message.message_id) > 0)) return null;
    return !(message.message ?? '') ? message : null;
  }
  return null;
}

// 失败项与记账摘要的固定形状；说明先去掉连接凭据再写入记录。
export const failure = (阶段, 错误码, 说明, extra = {}) => ({阶段, 错误码, 说明: sanitizeRaw(String(说明 ?? '')), ...extra});
export const bookkeepingMeta = (方式, 应答格式, 状态, 尝试次数, extra = {}) => ({方式, 应答格式, 状态, 尝试次数, ...extra});

function mergeFailures(...groups) {
  const seen = new Set(), result = [];
  for (const item of groups.flat()) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

// 历史裁决：载入审计、逐楼重放与归属核对都只读记录，调用方负责写入。
export function createHistoryAudit({protocol, manifest}) {
  // 按记录重放；执行器异常时保留底本，并把执行失败并入记录失败。
  function replay(base, record) {
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
  function checkRecords(list, {from = 0, skip = null, shifted = false, allowWorldbookDiff = false} = {}) {
    for (let id = from; id < list.length; id++) {
      const message = list[id];
      if (message.role !== 'assistant' || id === skip) continue;
      const stored = recordOf(message);
      // 删除前置楼层会让酒馆重排楼号；只在这个用户触发的传播入口核对正文、角色与 swipe，写入时换新楼号。
      const candidate = shifted && stored?.归属 && typeof stored.归属 === 'object'
        ? {...stored, 归属: {...stored.归属, 楼号: message.message_id}} : stored;
      const checked = validateRecord(candidate, message, manifest, RECORD_FORMAT, {allowWorldbookDiff});
      if (!checked.ok) return {...checked, 楼号: id};
    }
    return {ok: true};
  }

  // 本楼正文已变化时，只在内存里把归属换成当前正文，先验证旧记录仍属于兼容格式；不补字段、不迁移。
  function checkChangedAssistant(message, {allowWorldbookDiff = false} = {}) {
    const stored = recordOf(message);
    if (stored === undefined) return {ok: true};
    if (!stored?.归属 || typeof stored.归属 !== 'object')
      return validateRecord(stored, message, manifest, RECORD_FORMAT, {allowWorldbookDiff});
    return validateRecord({...stored, 归属: ownershipOf(message)}, message, manifest, RECORD_FORMAT, {allowWorldbookDiff});
  }

  // 已验真前缀快照缓存：键含楼号、归属、七项运行清单与 本局/命令/已写入 的逐字快照。
  // 任何已缓存楼层的编辑、swipe 切换或原地篡改都会让键失配，从失配处起完整重放，错误码与无缓存一致。
  let prefixCache = [];
  const stats = {hits: 0, misses: 0, replayedFloors: 0};
  const stepKey = (record, id) => JSON.stringify([id, record.归属, record.运行清单,
    JSON.stringify([record.本局, record.命令, record.已写入])]);
  function clearCache() { prefixCache = []; }
  function invalidateFrom(floorId) { prefixCache = prefixCache.filter(item => item.楼号 < floorId); }
  function cacheStats() {
    return {hits: stats.hits, misses: stats.misses, replayedFloors: stats.replayedFloors, cachedFloors: prefixCache.length};
  }

  // 载入只读校验：先过硬门禁；若存在世界书哈希差异则走内存只读试重放分级（A/B/C），同哈希仍按原严格重放。
  function audit(list, {end = list.length, skip = null, ignoreOwnership = null} = {}) {
    let hasAssistant0 = false, hasWorldbookDiff = false;
    const floors = [];
    for (let id = 0; id < end; id++) {
      const message = list[id];
      if (message.role !== 'assistant' || id === skip) continue;
      const record = recordOf(message);
      const candidate = id === ignoreOwnership && record?.归属 && typeof record.归属 === 'object'
        ? {...record, 归属: ownershipOf(message)} : record;
      const checked = validateRecord(candidate, message, manifest, RECORD_FORMAT, {allowWorldbookDiff: true});
      if (!checked.ok) return {...checked, 楼号: id};
      if (id === 0) {
        hasAssistant0 = true;
        if (candidate.本局?.开局?.已封卷 !== true)
          return {ok: false, code: '开局.封卷', 说明: '第 0 楼没有已封卷的开局设定', 楼号: 0};
      } else if (!hasAssistant0) {
        return {ok: false, code: '记录.缺失', 说明: '第 0 楼没有可用的开局记录', 楼号: 0};
      }
      if (candidate.运行清单.世界书哈希 !== manifest.世界书哈希) hasWorldbookDiff = true;
      floors.push({id, record: candidate});
    }
    if (hasWorldbookDiff) {
      return assessWorldbookCompat({
        list, end, skip, ignoreOwnership, protocol, manifest,
        recordOf, replayRecord, storedManifest, ownershipOf, recordFormat: RECORD_FORMAT,
      });
    }
    // 常规严格路径（ignoreOwnership === null）才读写缓存；试重放分级与忽略归属路径不碰缓存。
    const cached = ignoreOwnership === null, keys = cached ? floors.map(floor => stepKey(floor.record, floor.id)) : null;
    let start = 0, state = null;
    if (cached) {
      while (start < floors.length && start < prefixCache.length
        && prefixCache[start].楼号 === floors[start].id && prefixCache[start].键 === keys[start]) start += 1;
      if (start < floors.length && start < prefixCache.length) prefixCache.length = start;
      stats.hits += start;
      if (start > 0) state = prefixCache[start - 1].state;
    }
    for (let index = start; index < floors.length; index++) {
      const {id, record} = floors[index];
      if (cached) stats.misses += 1;
      if (id === 0) {
        let replayed;
        try {
          const opening = record.本局.开局;
          const seeded = protocol.seal({开局时间: opening.开局时间, 角色组: opening.角色组, 玩家: opening.玩家,
            历史选择: opening.历史选择, ...(opening.方案 ? {方案: opening.方案} : {})});
          replayed = replayRecord(record, seeded, (base, commands) => applyCommands(protocol, base, commands));
          protocol.createReadView(record.本局);
        } catch (error) {
          return {ok: false, code: error.code ?? '开局.封卷', 说明: '第 0 楼不是可重放的已封卷本局：' + error.message, 楼号: 0};
        }
        if (replayed.失败.length) return {ok: false, code: '重放.命令', 说明: '第 0 楼保存的开场命令重放失败', 楼号: 0};
        if (!sameSnapshot(replayed.state, record.本局))
          return {ok: false, code: '重放.失配', 说明: '第 0 楼命令重放结果与保存的本局不一致', 楼号: 0};
        if (JSON.stringify(replayed.已写入) !== JSON.stringify(record.已写入))
          return {ok: false, code: '重放.写入', 说明: '第 0 楼开场命令写入摘要与记录不一致', 楼号: 0};
        state = record.本局;
      } else {
        let replayed;
        try { replayed = replayRecord(record, state, (base, commands) => applyCommands(protocol, base, commands)); }
        catch (error) { return {ok: false, code: '重放.执行', 说明: error.message, 楼号: id}; }
        if (replayed.失败.length) return {ok: false, code: '重放.命令', 说明: '保存的成功命令在当前底本上执行失败', 楼号: id};
        if (!sameSnapshot(replayed.state, record.本局))
          return {ok: false, code: '重放.失配', 说明: '命令重放结果与保存的本局不一致', 楼号: id};
        if (JSON.stringify(replayed.已写入) !== JSON.stringify(record.已写入))
          return {ok: false, code: '重放.写入', 说明: '命令重放写入摘要与记录不一致', 楼号: id};
        state = record.本局;
      }
      if (cached) { prefixCache.push({楼号: id, 键: keys[index], state}); stats.replayedFloors += 1; }
    }
    return {ok: true, state};
  }

  return {replay, checkRecords, checkChangedAssistant, audit, clearCache, invalidateFrom, cacheStats};
}
