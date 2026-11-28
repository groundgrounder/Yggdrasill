// 世界树成品卡纯静态解包与纯内存挂载核心。
// 严格禁止动态代码执行，仅通过静态字面量解析提取 bundle 并核验世界书哈希。
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import zlib from 'node:zlib';
import {codepointCompare, isMap} from '../core/utils.mjs';
import {stringifyYaml} from '../core/yaml.mjs';
import {digestEntries, normalizeVirtualPath, RUNTIME_ROOT, sha256} from './manifest.mjs';
import {createMemFs, memPath} from './memfs.mjs';
import {validateThemeEntry} from './themes.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WORLDBOOK_ROOT = `${RUNTIME_ROOT}/世界书`;
const WORLDBOOK_PREFIX = `${WORLDBOOK_ROOT}/`;
const SETTINGS_VIRTUAL_PATH = `${RUNTIME_ROOT}/yggdrasill.yaml`;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_LITERAL_DEPTH = 64;
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

const NON_YGG_HINT = '该文件不是世界树打包角色卡；如需将普通酒馆卡或世界书迁移为世界树，请使用 `世界树·迁移`（`skills/ygg-migrate/`）';

export class UnpackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnpackError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasDangerousKeysDeep(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hasDangerousKeysDeep(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) return key;
    const hit = hasDangerousKeysDeep(value[key], seen);
    if (hit) return hit;
  }
  return null;
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) return false;
    }
    return true;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left).sort(codepointCompare);
    const rightKeys = Object.keys(right).sort(codepointCompare);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      if (!deepEqual(left[leftKeys[i]], right[rightKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

function decodeUtf8Strict(buffer, label) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new UnpackError('unpack.失败', `${label}不是合法的 UTF-8 编码`);
  }
}

function decodeBase64Json(base64Text, chunkLabel) {
  const trimmed = String(base64Text ?? '').replace(/\s+/gu, '');
  if (!trimmed) {
    throw new UnpackError('unpack.失败', `PNG 区块 ${chunkLabel} 内容为空，无法解码角色卡 JSON`);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    throw new UnpackError('unpack.失败', `PNG 区块 ${chunkLabel} 不是合法的 Base64 编码`);
  }
  let rawBytes;
  try {
    rawBytes = Buffer.from(trimmed, 'base64');
  } catch (error) {
    throw new UnpackError('unpack.失败', `PNG 区块 ${chunkLabel} Base64 解码失败：${error.message}`);
  }
  const utf8Text = decodeUtf8Strict(rawBytes, `PNG 区块 ${chunkLabel}`);
  let parsed;
  try {
    parsed = JSON.parse(utf8Text);
  } catch (error) {
    throw new UnpackError('unpack.失败', `PNG 区块 ${chunkLabel} JSON 解析失败：${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new UnpackError('unpack.失败', `PNG 区块 ${chunkLabel} 顶层不是 JSON 对象`);
  }
  return parsed;
}

function parseTextChunk(type, data) {
  const nullIdx = data.indexOf(0);
  if (nullIdx === -1) {
    throw new UnpackError('unpack.失败', `PNG ${type} 区块缺少关键字分隔符`);
  }
  const keyword = data.subarray(0, nullIdx).toString('latin1');
  if (type === 'tEXt') {
    return {keyword, text: data.subarray(nullIdx + 1).toString('latin1')};
  }
  if (type === 'zTXt') {
    if (nullIdx + 2 > data.length) {
      throw new UnpackError('unpack.失败', `PNG zTXt 区块（${keyword}）缺少压缩方法字节`);
    }
    const method = data[nullIdx + 1];
    if (method !== 0) {
      throw new UnpackError('unpack.失败', `PNG zTXt 区块（${keyword}）使用了不支持的压缩方法：${method}`);
    }
    try {
      const inflated = zlib.inflateSync(data.subarray(nullIdx + 2));
      return {keyword, text: inflated.toString('latin1')};
    } catch (error) {
      throw new UnpackError('unpack.失败', `PNG zTXt 区块（${keyword}）zlib 解压失败：${error.message}`);
    }
  }
  // iTXt: keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text
  if (nullIdx + 3 > data.length) {
    throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）头部截断`);
  }
  const compressionFlag = data[nullIdx + 1];
  const compressionMethod = data[nullIdx + 2];
  const langEnd = data.indexOf(0, nullIdx + 3);
  if (langEnd === -1) {
    throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）缺少语言标签分隔符`);
  }
  const translatedEnd = data.indexOf(0, langEnd + 1);
  if (translatedEnd === -1) {
    throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）缺少译名关键字分隔符`);
  }
  const payload = data.subarray(translatedEnd + 1);
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）使用了不支持的压缩方法：${compressionMethod}`);
    }
    try {
      const inflated = zlib.inflateSync(payload);
      return {keyword, text: inflated.toString('utf8')};
    } catch (error) {
      throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）zlib 解压失败：${error.message}`);
    }
  }
  if (compressionFlag !== 0) {
    throw new UnpackError('unpack.失败', `PNG iTXt 区块（${keyword}）压缩标志非法：${compressionFlag}`);
  }
  return {keyword, text: payload.toString('utf8')};
}

/**
 * 解析 SillyTavern PNG 角色卡缓冲区，支持 tEXt / zTXt / iTXt；优先 ccv3，回退 chara。
 */
export function parsePngCard(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new UnpackError('unpack.参数', 'parsePngCard 仅接受 Buffer 输入');
  }
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new UnpackError('unpack.失败', '文件头不是合法 PNG 魔数');
  }

  const found = new Map();
  let offset = 8;
  let seenIend = false;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new UnpackError('unpack.失败', `PNG 区块头越界（偏移 ${offset}，文件长度 ${buffer.length}）`);
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (nextOffset > buffer.length) {
      throw new UnpackError('unpack.失败', `PNG 区块 ${type} 数据越界（声明长度 ${length}，剩余 ${buffer.length - dataStart} 字节）`);
    }
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const {keyword, text} = parseTextChunk(type, buffer.subarray(dataStart, dataEnd));
      const key = keyword.toLowerCase();
      if (key === 'ccv3' || key === 'chara') {
        found.set(key, {keyword: key, chunkType: type, text});
      }
    }
    offset = nextOffset;
    if (type === 'IEND') {
      seenIend = true;
      break;
    }
  }

  if (!seenIend && found.size === 0) {
    throw new UnpackError('unpack.失败', 'PNG 文件已截断，未找到 IEND 结束区块');
  }

  const chosen = found.get('ccv3') ?? found.get('chara');
  if (!chosen) {
    throw new UnpackError('unpack.非世界树卡', `PNG 文件不含 ccv3 或 chara 角色卡数据区块。${NON_YGG_HINT}`);
  }
  const card = decodeBase64Json(chosen.text, `${chosen.chunkType}(${chosen.keyword})`);
  return {
    card,
    chunk: chosen.keyword,
    chunkType: chosen.chunkType,
    chunksFound: [...found.keys()].sort(codepointCompare),
  };
}

/**
 * 读取角色卡文件（自动按 PNG 魔数识别 PNG 或按 UTF-8 JSON 解析），拒绝符号链接与非普通文件。
 */
export async function readCardFile(cardPath, {fs = defaultFs} = {}) {
  if (typeof cardPath !== 'string' || !cardPath.trim()) {
    throw new UnpackError('unpack.参数', '请提供角色卡文件路径');
  }
  let stat;
  try {
    stat = await fs.lstat(cardPath);
  } catch (error) {
    throw new UnpackError('unpack.失败', `无法访问角色卡文件 ${cardPath}：${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new UnpackError('unpack.失败', `拒绝读取符号链接输入：${cardPath}`);
  }
  if (!stat.isFile()) {
    throw new UnpackError('unpack.失败', `输入路径不是普通文件：${cardPath}`);
  }

  let buffer;
  try {
    buffer = await fs.readFile(cardPath);
  } catch (error) {
    throw new UnpackError('unpack.失败', `无法读取角色卡文件 ${cardPath}：${error.message}`);
  }
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  if (buffer.length === 0) {
    throw new UnpackError('unpack.失败', `角色卡文件为空：${cardPath}`);
  }

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    const png = parsePngCard(buffer);
    return {
      format: 'png',
      card: png.card,
      pngBuffer: buffer,
      chunk: png.chunk,
      chunkType: png.chunkType,
      chunksFound: png.chunksFound,
    };
  }

  const text = decodeUtf8Strict(buffer, `角色卡文件 ${cardPath}`);
  let card;
  try {
    card = JSON.parse(text);
  } catch (error) {
    throw new UnpackError('unpack.失败', `角色卡文件不是合法 JSON：${error.message}`);
  }
  if (!isPlainObject(card)) {
    throw new UnpackError('unpack.失败', '角色卡文件顶层须为 JSON 对象');
  }
  return {
    format: 'json',
    card,
    pngBuffer: null,
    chunk: null,
    chunkType: null,
    chunksFound: [],
  };
}

// ---------- 纯静态递归下降 JS 字面量解析器 ----------

const ID_START_RE = /[\p{ID_Start}$_]/u;
const ID_CONT_RE = /[\p{ID_Continue}$_]/u;
const HEX_RE = /^[0-9a-fA-F]+$/;

function isWhitespaceChar(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    || code === 0x0c || code === 0x0b || code === 0xfeff || code === 0xa0
    || code === 0x2028 || code === 0x2029;
}

function isDigitCode(code) {
  return code >= 0x30 && code <= 0x39;
}

function parseStaticObjectLiteral(source, startPos) {
  const len = source.length;
  let pos = startPos;

  function failSyntax(message) {
    throw new UnpackError('unpack.校验失败', `静态解析 bundle 失败（位置 ${pos}）：${message}`);
  }

  function skipIgnored() {
    while (pos < len) {
      const code = source.charCodeAt(pos);
      if (isWhitespaceChar(code)) {
        pos += 1;
        continue;
      }
      if (code === 0x2f /* / */) {
        const next = source.charCodeAt(pos + 1);
        if (next === 0x2f /* / */) {
          pos += 2;
          while (pos < len) {
            const c = source.charCodeAt(pos);
            pos += 1;
            if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) break;
          }
          continue;
        }
        if (next === 0x2a /* * */) {
          pos += 2;
          let closed = false;
          while (pos + 1 < len) {
            if (source.charCodeAt(pos) === 0x2a && source.charCodeAt(pos + 1) === 0x2f) {
              pos += 2;
              closed = true;
              break;
            }
            pos += 1;
          }
          if (!closed) failSyntax('块注释未闭合');
          continue;
        }
      }
      break;
    }
  }

  function parseString() {
    const quote = source.charCodeAt(pos);
    pos += 1;
    let out = '';
    let chunkStart = pos;
    while (pos < len) {
      const code = source.charCodeAt(pos);
      if (code === quote) {
        out += source.slice(chunkStart, pos);
        pos += 1;
        return out;
      }
      if (code === 0x0a || code === 0x0d) {
        failSyntax('字符串字面量包含未转义换行');
      }
      if (code === 0x5c /* \ */) {
        out += source.slice(chunkStart, pos);
        pos += 1;
        if (pos >= len) failSyntax('字符串转义截断');
        const esc = source.charCodeAt(pos);
        pos += 1;
        switch (esc) {
          case 0x22: out += '"'; break;
          case 0x27: out += "'"; break;
          case 0x5c: out += '\\'; break;
          case 0x2f: out += '/'; break;
          case 0x6e: out += '\n'; break;
          case 0x72: out += '\r'; break;
          case 0x74: out += '\t'; break;
          case 0x62: out += '\b'; break;
          case 0x66: out += '\f'; break;
          case 0x76: out += '\v'; break;
          case 0x30: {
            if (pos < len && isDigitCode(source.charCodeAt(pos))) {
              failSyntax('不支持旧式八进制转义');
            }
            out += '\0';
            break;
          }
          case 0x78: {
            const hex = source.slice(pos, pos + 2);
            if (hex.length !== 2 || !HEX_RE.test(hex)) failSyntax('非法 \\xHH 转义');
            pos += 2;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          case 0x75: {
            if (source.charCodeAt(pos) === 0x7b /* { */) {
              const closeIdx = source.indexOf('}', pos + 1);
              if (closeIdx === -1) failSyntax('未闭合的 \\u{...} 转义');
              const hex = source.slice(pos + 1, closeIdx);
              if (!hex.length || !HEX_RE.test(hex)) failSyntax('非法 \\u{...} 转义');
              const cp = parseInt(hex, 16);
              if (!Number.isFinite(cp) || cp > 0x10ffff) failSyntax('超出 Unicode 范围的 \\u{...} 转义');
              pos = closeIdx + 1;
              out += String.fromCodePoint(cp);
            } else {
              const hex = source.slice(pos, pos + 4);
              if (hex.length !== 4 || !HEX_RE.test(hex)) failSyntax('非法 \\uHHHH 转义');
              pos += 4;
              out += String.fromCharCode(parseInt(hex, 16));
            }
            break;
          }
          case 0x0d: {
            if (pos < len && source.charCodeAt(pos) === 0x0a) pos += 1;
            break;
          }
          case 0x0a:
          case 0x2028:
          case 0x2029:
            break;
          default: {
            if (esc >= 0x31 && esc <= 0x39) failSyntax('不支持旧式八进制转义');
            out += String.fromCharCode(esc);
            break;
          }
        }
        chunkStart = pos;
        continue;
      }
      pos += 1;
    }
    failSyntax('字符串字面量未闭合');
  }

  function parseNumber(allowNegative = true) {
    const start = pos;
    if (source.charCodeAt(pos) === 0x2d /* - */) {
      if (!allowNegative) failSyntax('属性键不能为负数');
      pos += 1;
    }
    if (pos >= len) failSyntax('非法数字字面量');
    const c0 = source.charCodeAt(pos);
    if (c0 === 0x2e /* . */) {
      pos += 1;
      const fracStart = pos;
      while (pos < len && isDigitCode(source.charCodeAt(pos))) pos += 1;
      if (pos === fracStart) failSyntax('非法小数');
    } else if (c0 === 0x30 /* 0 */) {
      pos += 1;
      if (pos < len && isDigitCode(source.charCodeAt(pos))) {
        failSyntax('不支持前导零数字');
      }
      if (pos < len && source.charCodeAt(pos) === 0x2e) {
        pos += 1;
        while (pos < len && isDigitCode(source.charCodeAt(pos))) pos += 1;
      }
    } else if (c0 >= 0x31 && c0 <= 0x39) {
      pos += 1;
      while (pos < len && isDigitCode(source.charCodeAt(pos))) pos += 1;
      if (pos < len && source.charCodeAt(pos) === 0x2e) {
        pos += 1;
        while (pos < len && isDigitCode(source.charCodeAt(pos))) pos += 1;
      }
    } else {
      failSyntax('非法数字字面量');
    }

    if (pos < len) {
      const exp = source.charCodeAt(pos);
      if (exp === 0x65 /* e */ || exp === 0x45 /* E */) {
        pos += 1;
        if (pos < len && (source.charCodeAt(pos) === 0x2b || source.charCodeAt(pos) === 0x2d)) {
          pos += 1;
        }
        const expStart = pos;
        while (pos < len && isDigitCode(source.charCodeAt(pos))) pos += 1;
        if (pos === expStart) failSyntax('数字指数缺少数值');
      }
    }

    if (pos < len) {
      const trail = String.fromCodePoint(source.codePointAt(pos));
      if (ID_CONT_RE.test(trail) || trail === '.') {
        failSyntax('数字字面量后存在非法字符');
      }
    }

    const raw = source.slice(start, pos);
    const num = Number(raw);
    if (!Number.isFinite(num)) failSyntax(`数字字面量无效：${raw}`);
    return num;
  }

  function readIdentifier() {
    if (pos >= len) failSyntax('预期属性键或关键字');
    const firstCp = source.codePointAt(pos);
    const firstChar = String.fromCodePoint(firstCp);
    if (!ID_START_RE.test(firstChar)) {
      failSyntax(`非法标识符起点：${firstChar}`);
    }
    const start = pos;
    pos += firstChar.length;
    while (pos < len) {
      const cp = source.codePointAt(pos);
      const ch = String.fromCodePoint(cp);
      if (!ID_CONT_RE.test(ch)) break;
      pos += ch.length;
    }
    return source.slice(start, pos);
  }

  function parseArray(depth) {
    if (depth > MAX_LITERAL_DEPTH) failSyntax('嵌套层级超过安全上限');
    pos += 1; // [
    const result = [];
    for (;;) {
      skipIgnored();
      if (pos >= len) failSyntax('数组字面量未闭合');
      if (source.charCodeAt(pos) === 0x5d /* ] */) {
        pos += 1;
        return result;
      }
      result.push(parseValue(depth + 1));
      skipIgnored();
      if (pos >= len) failSyntax('数组字面量未闭合');
      const sep = source.charCodeAt(pos);
      if (sep === 0x2c /* , */) {
        pos += 1;
        continue;
      }
      if (sep === 0x5d /* ] */) {
        pos += 1;
        return result;
      }
      failSyntax(`数组内出现非法符号“${source[pos]}”`);
    }
  }

  function parseObject(depth) {
    if (depth > MAX_LITERAL_DEPTH) failSyntax('嵌套层级超过安全上限');
    if (source.charCodeAt(pos) !== 0x7b /* { */) failSyntax('预期对象起始符 {');
    pos += 1;
    const obj = {};
    for (;;) {
      skipIgnored();
      if (pos >= len) failSyntax('对象字面量未闭合');
      const code = source.charCodeAt(pos);
      if (code === 0x7d /* } */) {
        pos += 1;
        return obj;
      }
      let key;
      if (code === 0x22 || code === 0x27) {
        key = parseString();
      } else if (isDigitCode(code)) {
        key = String(parseNumber(false));
      } else {
        key = readIdentifier();
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw new UnpackError('unpack.校验失败', `bundle 含危险原型键：${key}`);
      }
      skipIgnored();
      if (pos >= len || source.charCodeAt(pos) !== 0x3a /* : */) {
        failSyntax(`对象属性“${key}”缺少冒号或含非静态写法`);
      }
      pos += 1;
      const value = parseValue(depth + 1);
      Object.defineProperty(obj, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      skipIgnored();
      if (pos >= len) failSyntax('对象字面量未闭合');
      const sep = source.charCodeAt(pos);
      if (sep === 0x2c /* , */) {
        pos += 1;
        continue;
      }
      if (sep === 0x7d /* } */) {
        pos += 1;
        return obj;
      }
      failSyntax(`对象内出现非法符号“${source[pos]}”`);
    }
  }

  function parseValue(depth) {
    if (depth > MAX_LITERAL_DEPTH) failSyntax('嵌套层级超过安全上限');
    skipIgnored();
    if (pos >= len) failSyntax('意外到达脚本末尾');
    const code = source.charCodeAt(pos);
    if (code === 0x7b /* { */) return parseObject(depth);
    if (code === 0x5b /* [ */) return parseArray(depth);
    if (code === 0x22 /* " */ || code === 0x27 /* ' */) return parseString();
    if (code === 0x60 /* ` */) failSyntax('禁止模板字符串');
    if (code === 0x2d /* - */ || code === 0x2e /* . */ || isDigitCode(code)) return parseNumber(true);

    const ident = readIdentifier();
    if (ident === 'true') return true;
    if (ident === 'false') return false;
    if (ident === 'null') return null;
    failSyntax(`禁止未知标识符或表达式“${ident}”`);
  }

  skipIgnored();
  if (pos >= len || source.charCodeAt(pos) !== 0x7b) {
    failSyntax('bundle_generated_default 必须为静态对象字面量，禁止表达式或函数调用');
  }
  const value = parseObject(0);

  // 校验对象字面量后干净结束，拒绝拼接表达式（如 `{} + evil()` 或 `{}.x`）。
  while (pos < len) {
    const code = source.charCodeAt(pos);
    if (code === 0x20 || code === 0x09 || code === 0x0c || code === 0x0b || code === 0xfeff) {
      pos += 1;
      continue;
    }
    if (code === 0x2f && source.charCodeAt(pos + 1) === 0x2a) {
      pos += 2;
      let closed = false;
      while (pos + 1 < len) {
        if (source.charCodeAt(pos) === 0x2a && source.charCodeAt(pos + 1) === 0x2f) {
          pos += 2;
          closed = true;
          break;
        }
        pos += 1;
      }
      if (!closed) failSyntax('尾部块注释未闭合');
      continue;
    }
    if (code === 0x2f && source.charCodeAt(pos + 1) === 0x2f) {
      break;
    }
    if (code === 0x3b /* ; */ || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      break;
    }
    failSyntax(`bundle 对象字面量后存在非法尾随表达式（“${source[pos]}”）`);
  }

  return value;
}

/**
 * 纯静态提取卡内脚本的 bundle_generated_default 对象字面量。
 */
export function extractBundleFromScript(scriptContent) {
  if (typeof scriptContent !== 'string' || !scriptContent.trim()) {
    throw new UnpackError('unpack.非世界树卡', NON_YGG_HINT);
  }

  // 优先匹配紧邻 // adapter/bundle.generated.json 的声明，再回退语句起点声明。
  const anchoredPattern = /(?:^|[\r\n])\s*\/\/\s*adapter\/bundle\.generated\.json[^\r\n]*[\r\n]+\s*(?:var|let|const)\s+bundle_generated_default\s*=/gu;
  const fallbackPattern = /(?:^|[\r\n;])\s*(?:var|let|const)\s+bundle_generated_default\s*=/gu;

  const anchoredMatch = anchoredPattern.exec(scriptContent);
  if (anchoredMatch) {
    return parseStaticObjectLiteral(scriptContent, anchoredMatch.index + anchoredMatch[0].length);
  }
  const fallbackMatch = fallbackPattern.exec(scriptContent);
  if (fallbackMatch) {
    return parseStaticObjectLiteral(scriptContent, fallbackMatch.index + fallbackMatch[0].length);
  }

  throw new UnpackError('unpack.非世界树卡', NON_YGG_HINT);
}

function locateYggScript(card) {
  const scripts = card?.data?.extensions?.tavern_helper?.scripts
    ?? card?.extensions?.tavern_helper?.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    throw new UnpackError('unpack.非世界树卡', NON_YGG_HINT);
  }
  const byName = scripts.find(
    item => isPlainObject(item) && item.name === '世界树' && typeof item.content === 'string' && item.content.trim(),
  );
  if (byName) return byName.content;

  const bySignature = scripts.find(
    item => isPlainObject(item)
      && typeof item.content === 'string'
      && item.content.includes('bundle_generated_default')
      && item.content.includes(WORLDBOOK_ROOT),
  );
  if (bySignature) return bySignature.content;

  throw new UnpackError('unpack.非世界树卡', NON_YGG_HINT);
}

function validateExtractedBundle(bundle) {
  if (!isPlainObject(bundle)) {
    throw new UnpackError('unpack.校验失败', '提取的 bundle 不是对象');
  }
  const dangerous = hasDangerousKeysDeep(bundle);
  if (dangerous) {
    throw new UnpackError('unpack.校验失败', `bundle 含危险原型键：${dangerous}`);
  }
  if (bundle.root !== WORLDBOOK_ROOT) {
    throw new UnpackError('unpack.校验失败', `bundle.root 须为 ${WORLDBOOK_ROOT}，实际为 ${String(bundle.root)}`);
  }
  if (!isPlainObject(bundle.files)) {
    throw new UnpackError('unpack.校验失败', 'bundle.files 须为路径到文本的对象映射');
  }
  if (!isPlainObject(bundle.manifest)) {
    throw new UnpackError('unpack.校验失败', 'bundle.manifest 缺失或不是对象');
  }

  const manifest = bundle.manifest;
  for (const field of ['卡ID', '卡版本', '程序版本']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new UnpackError('unpack.校验失败', `bundle.manifest 缺少合法“${field}”`);
    }
  }
  for (const field of ['世界书哈希', '程序指纹']) {
    if (typeof manifest[field] !== 'string' || !HASH_PATTERN.test(manifest[field])) {
      throw new UnpackError('unpack.校验失败', `bundle.manifest.${field} 须为 64 位小写十六进制 SHA-256`);
    }
  }

  const seenPaths = new Set();
  const digestList = [];
  let worldbookCount = 0;

  for (const [rawKey, text] of Object.entries(bundle.files)) {
    if (typeof text !== 'string') {
      throw new UnpackError('unpack.校验失败', `bundle.files 中文件内容须为字符串：${rawKey}`);
    }
    let normalized;
    try {
      normalized = normalizeVirtualPath(rawKey, '世界书路径');
    } catch (error) {
      throw new UnpackError('unpack.校验失败', error.message);
    }
    if (normalized !== rawKey) {
      throw new UnpackError('unpack.校验失败', `bundle.files 含非规范路径：${rawKey}`);
    }
    const isWorldbookFile = normalized.startsWith(WORLDBOOK_PREFIX) && normalized.length > WORLDBOOK_PREFIX.length;
    const isSettingsFile = normalized === SETTINGS_VIRTUAL_PATH;
    if (!isWorldbookFile && !isSettingsFile) {
      throw new UnpackError('unpack.校验失败', `bundle.files 含越界或不允许的路径：${normalized}`);
    }
    if (seenPaths.has(normalized)) {
      throw new UnpackError('unpack.校验失败', `bundle.files 含重复路径：${normalized}`);
    }
    seenPaths.add(normalized);
    if (isWorldbookFile) worldbookCount += 1;
    digestList.push({路径: normalized, SHA256: sha256(Buffer.from(text, 'utf8'))});
  }

  if (worldbookCount === 0) {
    throw new UnpackError('unpack.校验失败', 'bundle.files 不包含任何世界书文件');
  }

  let computedHash;
  try {
    computedHash = digestEntries(digestList);
  } catch (error) {
    throw new UnpackError('unpack.校验失败', `重算世界书哈希失败：${error.message}`);
  }
  if (computedHash !== manifest.世界书哈希) {
    throw new UnpackError(
      'unpack.校验失败',
      `世界书哈希校验失败：清单记录 ${manifest.世界书哈希}，实际计算 ${computedHash}`,
    );
  }

  if (bundle.themes !== undefined) {
    if (!Array.isArray(bundle.themes)) {
      throw new UnpackError('unpack.校验失败', 'bundle.themes 须为列表');
    }
    const existingIds = new Set();
    for (const theme of bundle.themes) {
      if (!isPlainObject(theme) || typeof theme.id !== 'string' || !THEME_ID_PATTERN.test(theme.id.trim())) {
        throw new UnpackError('unpack.校验失败', `bundle.themes 含非法主题 ID：${String(theme?.id)}`);
      }
      try {
        validateThemeEntry(theme, {existingIds});
      } catch (error) {
        throw new UnpackError('unpack.校验失败', `bundle.themes 校验失败：${error.message}`);
      }
      existingIds.add(theme.id.trim());
    }
  }

  return bundle;
}

/**
 * 读取并静态检验一张世界树成品卡（JSON 或 PNG），返回卡体、bundle、清单与卡信息摘要。
 */
export async function inspectCard(cardPath, {fs = defaultFs} = {}) {
  const read = await readCardFile(cardPath, {fs});
  const scriptContent = locateYggScript(read.card);
  const bundle = validateExtractedBundle(extractBundleFromScript(scriptContent));
  const data = isPlainObject(read.card.data) ? read.card.data : read.card;
  const name = typeof data.name === 'string' && data.name.trim()
    ? data.name
    : (typeof read.card.name === 'string' && read.card.name.trim() ? read.card.name : bundle.manifest.卡ID);

  return {
    source: cardPath,
    format: read.format,
    chunk: read.chunk,
    chunkType: read.chunkType,
    chunksFound: read.chunksFound,
    pngBuffer: read.pngBuffer,
    card: read.card,
    bundle,
    manifest: bundle.manifest,
    cardInfo: {
      名称: name,
      卡ID: bundle.manifest.卡ID,
      卡版本: bundle.manifest.卡版本,
      程序版本: bundle.manifest.程序版本,
      世界书哈希: bundle.manifest.世界书哈希,
      程序指纹: bundle.manifest.程序指纹,
      主题数: Array.isArray(bundle.themes) ? bundle.themes.length : 0,
    },
  };
}

// ---------- 只读内存文件系统适配器 ----------

const notFound = target => Object.assign(new Error(`ENOENT: ${target}`), {code: 'ENOENT'});

/**
 * 基于 adapter/memfs.mjs 封装供 core/、checker/、view/data.mjs、context-preview 与 what-if 共用的只读 {fs, path}。
 */
export function createCardMemFs(files) {
  const baseFs = createMemFs(files);
  const fileMap = new Map();
  const dirs = new Set([RUNTIME_ROOT]);

  for (const [rawKey, text] of Object.entries(files)) {
    const key = memPath.resolve(rawKey);
    fileMap.set(key, text);
    let current = memPath.dirname(key);
    while (current && current !== '/' && current.startsWith(RUNTIME_ROOT)) {
      dirs.add(current);
      if (current === RUNTIME_ROOT) break;
      current = memPath.dirname(current);
    }
  }

  const cardFs = {
    async readFile(target, encoding) {
      const text = await baseFs.readFile(target);
      if (encoding === null) return Buffer.from(text, 'utf8');
      return text;
    },
    async readdir(directory, options) {
      const rawEntries = await baseFs.readdir(directory);
      const entries = rawEntries
        .map(entry => ({
          name: entry.name,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          isSymbolicLink: () => false,
        }))
        .sort((left, right) => codepointCompare(left.name, right.name));
      if (options && typeof options === 'object' && options.withFileTypes === true) {
        return entries;
      }
      return entries.map(entry => entry.name);
    },
    async access(target) {
      const key = memPath.resolve(target);
      if (fileMap.has(key) || dirs.has(key)) return undefined;
      throw notFound(key);
    },
    async stat(target) {
      const key = memPath.resolve(target);
      if (fileMap.has(key)) {
        const size = Buffer.byteLength(fileMap.get(key), 'utf8');
        return {isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size};
      }
      if (dirs.has(key)) {
        return {isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0};
      }
      throw notFound(key);
    },
    async lstat(target) {
      return cardFs.stat(target);
    },
    async realpath(target) {
      const key = memPath.resolve(target);
      if (fileMap.has(key) || dirs.has(key)) return key;
      throw notFound(key);
    },
  };

  const cardPath = {
    join: (...parts) => memPath.join(...parts),
    resolve: (...parts) => memPath.resolve(...parts),
    dirname: value => memPath.dirname(value),
    extname: value => memPath.extname(value),
    basename: (value, suffix) => defaultPath.posix.basename(String(value), suffix),
    relative: (from, to) => defaultPath.posix.relative(memPath.resolve(from), memPath.resolve(to)),
    sep: '/',
  };

  return {fs: cardFs, path: cardPath};
}

// ---------- 卡面.yaml 与本地项目还原 ----------

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UnpackError('unpack.校验失败', `缺少合法卡面字段“${label}”`);
  }
  return value;
}

/**
 * 按 adapter/pack.mjs 白名单字段顺序还原卡面 YAML。
 */
export function buildFaceYaml(card, bundle) {
  if (!isPlainObject(card) || !isPlainObject(bundle) || !isPlainObject(bundle.manifest)) {
    throw new UnpackError('unpack.校验失败', '还原卡面需要合法的 card 与 bundle');
  }
  const data = isPlainObject(card.data) ? card.data : card;
  const cardId = nonEmptyString(bundle.manifest.卡ID, '卡ID');
  const cardVersion = nonEmptyString(bundle.manifest.卡版本, '卡版本');
  const name = nonEmptyString(data.name ?? card.name, '名称');
  const description = nonEmptyString(data.description ?? card.description, '描述');
  if (!isMap(bundle.opening)) {
    throw new UnpackError('unpack.校验失败', 'bundle 缺少默认开局配置（opening）');
  }
  const greeting = nonEmptyString(bundle.openingGreeting ?? data.first_mes ?? card.first_mes, '开场白');

  const topCommands = Array.isArray(bundle.openingCommands) ? bundle.openingCommands : [];
  const topOptional = Array.isArray(bundle.openingOptionalPresent) ? bundle.openingOptionalPresent : [];
  const topRequired = Array.isArray(bundle.openingRequiredGroups) ? bundle.openingRequiredGroups : [];

  const face = {
    卡ID: cardId,
    卡版本: cardVersion,
    名称: name,
    描述: description,
    开局: bundle.opening,
    开场白: greeting,
  };
  if (topCommands.length > 0) face.开场命令 = topCommands;
  if (topOptional.length > 0) face.可选在场 = topOptional;
  if (topRequired.length > 0) face.必需角色组 = topRequired;

  if (isPlainObject(bundle.planOpenings)) {
    const planIds = Object.keys(bundle.planOpenings).sort(codepointCompare);
    if (planIds.length > 0) {
      const byPlan = {};
      for (const planId of planIds) {
        const resolved = bundle.planOpenings[planId];
        if (!isPlainObject(resolved)) continue;
        const entry = {};
        if (typeof resolved.开场白 === 'string' && resolved.开场白 !== greeting) {
          entry.开场白 = resolved.开场白;
        }
        if (Array.isArray(resolved.开场命令) && !deepEqual(resolved.开场命令, topCommands)) {
          entry.开场命令 = resolved.开场命令;
        }
        if (Array.isArray(resolved.可选在场) && !deepEqual(resolved.可选在场, topOptional)) {
          entry.可选在场 = resolved.可选在场;
        }
        if (Array.isArray(resolved.必需角色组) && !deepEqual(resolved.必需角色组, topRequired)) {
          entry.必需角色组 = resolved.必需角色组;
        }
        byPlan[planId] = entry;
      }
      if (Object.keys(byPlan).length > 0) {
        face.按方案 = byPlan;
      }
    }
  }

  const text = stringifyYaml(face);
  return text.endsWith('\n') ? text : `${text}\n`;
}

function buildThemeYaml(theme) {
  const payload = {
    id: theme.id,
    name: theme.name,
  };
  if (typeof theme.description === 'string' && theme.description.trim()) {
    payload.description = theme.description.trim();
  }
  if (theme.default === true) {
    payload.default = true;
  }
  payload.base = theme.base || 'modern';
  if (isPlainObject(theme.tokens) && Object.keys(theme.tokens).length > 0) {
    const orderedTokens = {};
    for (const key of Object.keys(theme.tokens).sort(codepointCompare)) {
      orderedTokens[key] = theme.tokens[key];
    }
    payload.tokens = orderedTokens;
  }
  if (isPlainObject(theme.layout) && Object.keys(theme.layout).length > 0) {
    payload.layout = {...theme.layout};
  }
  const text = stringifyYaml(payload);
  return text.endsWith('\n') ? text : `${text}\n`;
}

function isInside(parent, child, pathImpl) {
  const rel = pathImpl.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !pathImpl.isAbsolute(rel));
}

async function lstatOrNull(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function realOrNull(fsImpl, target) {
  try {
    return await fsImpl.realpath(target);
  } catch {
    return null;
  }
}

async function resolveWithRealAncestor(fsImpl, pathImpl, target) {
  const resolved = pathImpl.resolve(target);
  const direct = await realOrNull(fsImpl, resolved);
  if (direct) return direct;
  let ancestor = pathImpl.dirname(resolved);
  for (;;) {
    const realAncestor = await realOrNull(fsImpl, ancestor);
    if (realAncestor) return pathImpl.join(realAncestor, pathImpl.relative(ancestor, resolved));
    const next = pathImpl.dirname(ancestor);
    if (next === ancestor) return resolved;
    ancestor = next;
  }
}

async function assertNotSymlinkFile(fsImpl, target) {
  const stat = await lstatOrNull(fsImpl, target);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UnpackError('unpack.失败', `目标文件已存在且不是普通文件（禁止符号链接）：${target}`);
  }
}

async function safeCleanSubdir(fsImpl, pathImpl, realOutRoot, subName) {
  const subPath = pathImpl.join(realOutRoot, subName);
  const stat = await lstatOrNull(fsImpl, subPath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UnpackError('unpack.失败', `输出目录内“${subName}”为符号链接，拒绝清理：${subPath}`);
  }
  const realSub = await fsImpl.realpath(subPath);
  if (!isInside(realOutRoot, realSub, pathImpl) || realSub === realOutRoot) {
    throw new UnpackError('unpack.失败', `输出目录内“${subName}”越出目标目录，拒绝清理：${subPath}`);
  }
  await fsImpl.rm(subPath, {recursive: true, force: true});
}

/**
 * 将世界树成品卡（JSON 或 PNG）解包还原为本地可编辑、可重打的项目目录。
 */
export async function unpackCard(cardPath, outDir, {force = false, fs = defaultFs, path = defaultPath} = {}) {
  if (typeof cardPath !== 'string' || !cardPath.trim()) {
    throw new UnpackError('unpack.参数', '缺少角色卡文件路径');
  }
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new UnpackError('unpack.参数', '缺少输出目录');
  }

  const resolvedCard = path.resolve(cardPath);
  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === path.parse(resolvedOut).root) {
    throw new UnpackError('unpack.参数', '输出目录不能是文件系统根目录');
  }

  // 先完整读取、静态提取并校验卡文件与产物内容，任何错误均不触碰输出目录。
  const inspected = await inspectCard(resolvedCard, {fs});
  const faceYaml = buildFaceYaml(inspected.card, inspected.bundle);

  const realCard = (await realOrNull(fs, resolvedCard)) ?? resolvedCard;
  const realOutCandidate = await resolveWithRealAncestor(fs, path, resolvedOut);
  if (isInside(resolvedOut, resolvedCard, path) || isInside(realOutCandidate, realCard, path)) {
    throw new UnpackError('unpack.参数', '输出目录不能包含输入角色卡文件');
  }

  // 组装拟写入的全部文件清单（先在内存中确认路径无冲突）。
  const writes = [];
  let worldbookFileCount = 0;
  let hasSettings = false;

  const sortedVirtualPaths = Object.keys(inspected.bundle.files).sort(codepointCompare);
  for (const virtualPath of sortedVirtualPaths) {
    const content = inspected.bundle.files[virtualPath];
    if (virtualPath === SETTINGS_VIRTUAL_PATH) {
      hasSettings = true;
      writes.push({rel: 'yggdrasill.yaml', content});
    } else if (virtualPath.startsWith(WORLDBOOK_PREFIX)) {
      worldbookFileCount += 1;
      const rel = `世界书/${virtualPath.slice(WORLDBOOK_PREFIX.length)}`;
      writes.push({rel, content});
    }
  }

  writes.push({rel: '卡面.yaml', content: faceYaml});

  const themes = Array.isArray(inspected.bundle.themes) ? inspected.bundle.themes : [];
  if (themes.length === 1) {
    const theme = themes[0];
    writes.push({rel: '外观/主题.yaml', content: buildThemeYaml(theme)});
    if (typeof theme.css === 'string' && theme.css.length > 0) {
      writes.push({rel: '外观/样式.css', content: theme.css});
    }
  } else if (themes.length > 1) {
    const orderedThemes = [...themes].sort((a, b) => codepointCompare(a.id, b.id));
    for (const theme of orderedThemes) {
      if (!THEME_ID_PATTERN.test(theme.id)) {
        throw new UnpackError('unpack.校验失败', `外观主题 ID 非法：${theme.id}`);
      }
      writes.push({rel: `外观/${theme.id}/主题.yaml`, content: buildThemeYaml(theme)});
      if (typeof theme.css === 'string' && theme.css.length > 0) {
        writes.push({rel: `外观/${theme.id}/样式.css`, content: theme.css});
      }
    }
  }

  const hasCover = Boolean(inspected.pngBuffer);
  if (hasCover) {
    writes.push({rel: '封面.png', content: inspected.pngBuffer, binary: true});
  }

  // 输出目录护栏检查。
  const outStat = await lstatOrNull(fs, resolvedOut);
  if (outStat) {
    if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
      throw new UnpackError('unpack.失败', `输出路径已存在且不是普通目录：${resolvedOut}`);
    }
    const existing = await fs.readdir(resolvedOut);
    if (existing.length > 0 && !force) {
      throw new UnpackError('unpack.已存在', `输出目录非空，未写入任何文件（如需覆盖还原文件请传 --force）：${resolvedOut}`);
    }
    if (existing.length > 0 && force) {
      const realOut = await fs.realpath(resolvedOut);
      await safeCleanSubdir(fs, path, realOut, '世界书');
      await safeCleanSubdir(fs, path, realOut, '外观');
      await assertNotSymlinkFile(fs, path.join(realOut, '卡面.yaml'));
      if (hasSettings) await assertNotSymlinkFile(fs, path.join(realOut, 'yggdrasill.yaml'));
      if (hasCover) await assertNotSymlinkFile(fs, path.join(realOut, '封面.png'));
    }
  } else {
    await fs.mkdir(resolvedOut, {recursive: true});
  }

  const realOutRoot = await fs.realpath(resolvedOut);
  const writtenFiles = [];
  for (const item of writes) {
    const absTarget = path.join(realOutRoot, ...item.rel.split('/'));
    if (!isInside(realOutRoot, absTarget, path) || absTarget === realOutRoot) {
      throw new UnpackError('unpack.校验失败', `拟写路径越出输出目录：${item.rel}`);
    }
    await fs.mkdir(path.dirname(absTarget), {recursive: true});
    if (item.binary) {
      await fs.writeFile(absTarget, item.content);
    } else {
      await fs.writeFile(absTarget, item.content, 'utf8');
    }
    writtenFiles.push(item.rel);
  }
  writtenFiles.sort(codepointCompare);

  return {
    来源: resolvedCard,
    格式: inspected.format,
    卡信息: inspected.cardInfo,
    输出目录: resolvedOut,
    世界书文件数: worldbookFileCount,
    含运行参数: hasSettings,
    主题数: themes.length,
    已提取封面: hasCover,
    世界书哈希: inspected.manifest.世界书哈希,
    已写入文件: writtenFiles,
    异常: [],
  };
}
