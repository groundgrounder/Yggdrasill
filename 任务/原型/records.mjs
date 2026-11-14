// 正式楼层记录：正文归属、运行清单兼容、字段完整性与快照重放。这里只做纯计算，不读写酒馆。
// 正文指纹使用 UTF-8 字节的 SHA-256；浏览器与 node 共用，不能依赖 node:crypto。

export const RECORD_KEY = '世界树';
export const RECORD_FORMAT = 1;
export const REQUIRED_FIELDS = ['记录格式', '运行清单', '归属', '本局', '命令', '失败', '已写入', '记账'];
export const MANIFEST_FIELDS = ['卡ID', '卡版本', '程序版本', '记录格式', '程序指纹', '世界书哈希', '兼容程序'];

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

const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
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

export function manifestIssue(stored, current) {
  if (!isMap(stored)) return issue('运行清单.缺失', '记录没有运行清单');
  for (const field of MANIFEST_FIELDS) if (!Object.hasOwn(stored, field)) return issue(`运行清单.${field}`, `运行清单缺少字段：${field}`);
  if (!isMap(current)) return issue('运行清单.当前', '当前构建清单缺失');
  if (stored.卡ID !== current.卡ID) return issue('运行清单.卡ID', `卡ID不一致：${stored.卡ID ?? '未写'} ≠ ${current.卡ID}`);
  if (stored.记录格式 !== current.记录格式) return issue('运行清单.记录格式', `运行清单记录格式不一致：${stored.记录格式} ≠ ${current.记录格式}`);
  if (stored.世界书哈希 !== current.世界书哈希) return issue('运行清单.世界书哈希', '世界书哈希不一致');
  const compatible = Array.isArray(current.兼容程序) ? current.兼容程序 : [];
  if (stored.程序指纹 !== current.程序指纹 && !compatible.includes(stored.程序指纹))
    return issue('运行清单.程序指纹', `程序指纹不兼容：${stored.程序指纹 ?? '未写'}`);
  return {ok: true};
}

export function validateRecord(record, message, currentManifest, currentFormat = RECORD_FORMAT) {
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
  const compatible = manifestIssue(record.运行清单, currentManifest);
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

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isMap(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export const sameSnapshot = (left, right) => canonical(left) === canonical(right);

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
