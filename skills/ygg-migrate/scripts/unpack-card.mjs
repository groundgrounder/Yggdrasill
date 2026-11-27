#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {pathToFileURL} from 'node:url';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const USAGE = `用法：node unpack-card.mjs <输入文件1> [输入文件2...] -o <输出目录> [--force]

选项：
  -o, --out <目录>   必填，指定拆包输出目录（不写入当前目录）
  -f, --force        若输出目录已存在且非空，允许清空覆盖
  -h, --help         显示本帮助信息

支持输入：
  - SillyTavern PNG 角色卡（自动解析 tEXt / zTXt / iTXt，优先 ccv3，回退 chara）
  - SillyTavern JSON 角色卡（V3 / V2 / V1 扁平格式，含内嵌 character_book）
  - 独立 World Info / Lorebook JSON（对象映射、entries 数组或根数组形态）
`;

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => (typeof item === 'string' ? item : String(item ?? ''))).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function sanitizeFilenameSegment(raw, maxLen = 48) {
  const cleaned = asString(raw)
    .replace(/[\x00-\x1f\x7f]/gu, '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-_.]+|[-_.]+$/gu, '');
  if (!cleaned) return 'untitled';
  return cleaned.slice(0, maxLen).replace(/[-_.]+$/gu, '') || 'untitled';
}

function decodeBase64Json(base64Text, chunkName) {
  const trimmed = asString(base64Text).replace(/\s+/gu, '');
  if (!trimmed) {
    throw new Error(`PNG 区块 ${chunkName} 内容为空，无法解码角色卡 JSON`);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    throw new Error(`PNG 区块 ${chunkName} 不是合法的 Base64 编码`);
  }
  let utf8Text;
  try {
    utf8Text = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch (error) {
    throw new Error(`PNG 区块 ${chunkName} Base64 解码失败：${error.message}`);
  }
  try {
    const parsed = JSON.parse(utf8Text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层不是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new Error(`PNG 区块 ${chunkName} JSON 解析失败：${error.message}`);
  }
}

function parseTextChunk(type, data) {
  const nullIdx = data.indexOf(0);
  if (nullIdx === -1) {
    throw new Error(`PNG ${type} 区块缺少关键字分隔符`);
  }
  const keyword = data.subarray(0, nullIdx).toString('latin1');
  if (type === 'tEXt') {
    return {keyword, text: data.subarray(nullIdx + 1).toString('latin1')};
  }
  if (type === 'zTXt') {
    if (nullIdx + 2 > data.length) {
      throw new Error(`PNG zTXt 区块（${keyword}）缺少压缩方法字节`);
    }
    const method = data[nullIdx + 1];
    if (method !== 0) {
      throw new Error(`PNG zTXt 区块（${keyword}）使用了不支持的压缩方法：${method}`);
    }
    try {
      const inflated = zlib.inflateSync(data.subarray(nullIdx + 2));
      return {keyword, text: inflated.toString('latin1')};
    } catch (error) {
      throw new Error(`PNG zTXt 区块（${keyword}）zlib 解压失败：${error.message}`);
    }
  }
  // iTXt: keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text
  if (nullIdx + 3 > data.length) {
    throw new Error(`PNG iTXt 区块（${keyword}）头部截断`);
  }
  const compressionFlag = data[nullIdx + 1];
  const compressionMethod = data[nullIdx + 2];
  const langEnd = data.indexOf(0, nullIdx + 3);
  if (langEnd === -1) {
    throw new Error(`PNG iTXt 区块（${keyword}）缺少语言标签分隔符`);
  }
  const translatedEnd = data.indexOf(0, langEnd + 1);
  if (translatedEnd === -1) {
    throw new Error(`PNG iTXt 区块（${keyword}）缺少译名关键字分隔符`);
  }
  const payload = data.subarray(translatedEnd + 1);
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      throw new Error(`PNG iTXt 区块（${keyword}）使用了不支持的压缩方法：${compressionMethod}`);
    }
    try {
      const inflated = zlib.inflateSync(payload);
      return {keyword, text: inflated.toString('utf8')};
    } catch (error) {
      throw new Error(`PNG iTXt 区块（${keyword}）zlib 解压失败：${error.message}`);
    }
  }
  if (compressionFlag !== 0) {
    throw new Error(`PNG iTXt 区块（${keyword}）压缩标志非法：${compressionFlag}`);
  }
  return {keyword, text: payload.toString('utf8')};
}

/**
 * 解析 SillyTavern PNG 角色卡缓冲区，支持 tEXt / zTXt / iTXt；优先 ccv3，回退 chara。
 */
export function parsePngCard(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('parsePngCard 仅接受 Buffer 输入');
  }
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('文件头不是合法 PNG 魔数');
  }

  const found = new Map();
  let offset = 8;
  let seenIend = false;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new Error(`PNG 区块头越界（偏移 ${offset}，文件长度 ${buffer.length}）`);
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (nextOffset > buffer.length) {
      throw new Error(`PNG 区块 ${type} 数据越界（声明长度 ${length}，剩余 ${buffer.length - dataStart} 字节）`);
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
    throw new Error('PNG 文件已截断，未找到 IEND 结束区块');
  }

  const chosen = found.get('ccv3') ?? found.get('chara');
  if (!chosen) {
    throw new Error('PNG 文件不含 ccv3 或 chara 角色卡数据区块');
  }
  const raw = decodeBase64Json(chosen.text, `${chosen.chunkType}(${chosen.keyword})`);
  return {
    raw,
    chunk: chosen.keyword,
    chunkType: chosen.chunkType,
    chunksFound: [...found.keys()].sort(),
  };
}

function normalizeLoreEntry(entry, sourceFile) {
  const keys = asStringArray(entry.keys ?? entry.key);
  const secondaryKeys = asStringArray(entry.secondary_keys ?? entry.keysecondary);
  const comment = asString(entry.comment ?? entry.name);
  const content = asString(entry.content);
  let enabled = true;
  if (typeof entry.enabled === 'boolean') enabled = entry.enabled;
  else if (typeof entry.disable === 'boolean') enabled = !entry.disable;

  const order = entry.insertion_order ?? entry.order ?? null;
  const position = entry.position ?? null;
  const depth = entry.depth ?? entry.extensions?.depth ?? null;
  const uid = entry.uid ?? entry.id ?? null;

  return {
    uid,
    source_file: sourceFile,
    comment,
    content,
    enabled,
    constant: Boolean(entry.constant),
    selective: Boolean(entry.selective),
    keys,
    secondary_keys: secondaryKeys,
    position,
    order,
    depth,
    detected_flags: detectFeatures(content),
  };
}

function extractEntriesList(rawEntries, sourceFile) {
  if (Array.isArray(rawEntries)) {
    return rawEntries
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => normalizeLoreEntry(item, sourceFile));
  }
  if (rawEntries && typeof rawEntries === 'object') {
    const keys = Object.keys(rawEntries).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a && String(nb) === b) {
        return na - nb;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return keys
      .map(key => rawEntries[key])
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => normalizeLoreEntry(item, sourceFile));
  }
  return [];
}

function isCardPayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.spec === 'chara_card_v3' || obj.spec === 'chara_card_v2') {
    return Boolean(obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data));
  }
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    const d = obj.data;
    if (typeof d.name === 'string' && ('description' in d || 'first_mes' in d || 'personality' in d)) {
      return true;
    }
  }
  return typeof obj.name === 'string' && (
    typeof obj.description === 'string'
    || typeof obj.first_mes === 'string'
    || typeof obj.personality === 'string'
    || typeof obj.scenario === 'string'
    || typeof obj.mes_example === 'string'
  );
}

function isLorebookPayload(obj) {
  if (Array.isArray(obj)) {
    return obj.length > 0 && obj.every(item => item && typeof item === 'object' && !Array.isArray(item));
  }
  if (!obj || typeof obj !== 'object') return false;
  if ('entries' in obj && (Array.isArray(obj.entries) || (obj.entries && typeof obj.entries === 'object'))) {
    return true;
  }
  return false;
}

function normalizeCardObject(raw, sourceFile) {
  let spec = 'chara_card_v1';
  let data = raw;
  if (raw.spec === 'chara_card_v3' && raw.data && typeof raw.data === 'object') {
    spec = 'chara_card_v3';
    data = raw.data;
  } else if (raw.spec === 'chara_card_v2' && raw.data && typeof raw.data === 'object') {
    spec = 'chara_card_v2';
    data = raw.data;
  } else if (raw.data && typeof raw.data === 'object' && typeof raw.data.name === 'string') {
    spec = typeof raw.spec === 'string' ? raw.spec : 'chara_card_v2';
    data = raw.data;
  }

  const extensions = (data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions))
    ? data.extensions
    : ((raw.extensions && typeof raw.extensions === 'object' && !Array.isArray(raw.extensions)) ? raw.extensions : {});

  const characterBook = data.character_book ?? raw.character_book ?? null;
  const loreEntries = characterBook && typeof characterBook === 'object'
    ? extractEntriesList(characterBook.entries, sourceFile)
    : [];

  const regexScripts = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : [];
  const otherExtensions = {};
  for (const key of Object.keys(extensions).sort()) {
    if (key === 'regex_scripts' || key === 'character_book') continue;
    otherExtensions[key] = extensions[key];
  }

  const card = {
    name: asString(data.name ?? raw.name),
    description: asString(data.description ?? raw.description),
    personality: asString(data.personality ?? raw.personality),
    scenario: asString(data.scenario ?? raw.scenario),
    first_mes: asString(data.first_mes ?? raw.first_mes),
    mes_example: asString(data.mes_example ?? raw.mes_example),
    system_prompt: asString(data.system_prompt ?? raw.system_prompt),
    post_history_instructions: asString(data.post_history_instructions ?? raw.post_history_instructions),
    creator_notes: asString(data.creator_notes ?? raw.creator_notes),
    creator: asString(data.creator ?? raw.creator),
    character_version: asString(data.character_version ?? raw.character_version),
    tags: asStringArray(data.tags ?? raw.tags),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.map(asString)
      : (Array.isArray(raw.alternate_greetings) ? raw.alternate_greetings.map(asString) : []),
  };

  return {
    spec,
    card,
    loreEntries,
    regexScripts,
    extensions,
    otherExtensions,
  };
}

/**
 * 探测文本与扩展中的动态特性标记（EJS / MVU / TavernHelper / 正则脚本 / HTML UI / 多角色线索）。
 */
export function detectFeatures(text = '', extensions = null) {
  const source = asString(text);
  const ext = (extensions && typeof extensions === 'object' && !Array.isArray(extensions)) ? extensions : {};

  const hasEjs = /<%|%>|\b(?:getvar|setvar|getwi)\s*\(/iu.test(source);
  const hasMvu = /_\.set\s*\(|<UpdateVariable>|\[InitVar\]|\bstat_data\b|\bmvu\b/iu.test(source);
  const hasTavernHelper = Boolean(ext.tavern_helper) || /\b(?:TavernHelper|STScript)\b/iu.test(source);
  const hasRegexScripts = Array.isArray(ext.regex_scripts) && ext.regex_scripts.length > 0;
  const hasHtmlUi = /<(?:style|div|table|details|script)(?:\s|>|$)/iu.test(source);

  const multiCharKeywords = /(?:多角色|群像|主要角色|角色列表|登场人物|characters?\s*:)/iu.test(source);
  const charHeadings = source.match(/(?:^|\n)\s*(?:#{1,4}\s*|(?:角色|人物)\s*[一二三四五六七八九十\d]+[：:.]|\*\*[^*\n]{1,16}\*\*\s*[：:])/gu) ?? [];
  const isMultiCharacter = multiCharKeywords || charHeadings.length >= 3;

  return {
    hasEjs,
    hasMvu,
    hasTavernHelper,
    hasRegexScripts,
    hasHtmlUi,
    isMultiCharacter,
  };
}

function classifyRegexScripts(scripts) {
  let displayOnly = 0;
  let promptRewrite = 0;
  for (const script of scripts) {
    if (!script || typeof script !== 'object') continue;
    const placement = Array.isArray(script.placement) ? script.placement : [];
    const isPrompt = Boolean(script.promptOnly) || placement.includes(1);
    const isDisplay = (Boolean(script.markdownOnly) || placement.includes(2)) && !isPrompt;
    if (isDisplay) displayOnly += 1;
    else if (isPrompt || placement.length > 0) promptRewrite += 1;
  }
  return {
    total: scripts.length,
    display_only: displayOnly,
    prompt_rewrite: promptRewrite,
  };
}

/**
 * 解析单份输入文件（PNG 角色卡、JSON 角色卡或独立 World Info JSON）。
 */
export function parseInputFile(filePath, buffer) {
  const basename = path.basename(filePath);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`输入文件 ${basename} 为空或无法读取`);
  }

  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
  const ext = path.extname(basename).toLowerCase();

  if (isPng || ext === '.png') {
    const png = parsePngCard(buffer);
    if (!isCardPayload(png.raw)) {
      throw new Error(`PNG 文件 ${basename} 解码出的 JSON 不是有效的 SillyTavern 角色卡结构`);
    }
    const normalized = normalizeCardObject(png.raw, basename);
    return {
      file: basename,
      kind: 'png-card',
      spec: normalized.spec,
      chunk: png.chunk,
      chunks_found: png.chunksFound,
      ...normalized,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`文件 ${basename} 不是合法 JSON：${error.message}`);
  }

  if (isCardPayload(parsed)) {
    const normalized = normalizeCardObject(parsed, basename);
    return {
      file: basename,
      kind: 'json-card',
      spec: normalized.spec,
      ...normalized,
    };
  }

  if (isLorebookPayload(parsed)) {
    const rawEntries = Array.isArray(parsed) ? parsed : parsed.entries;
    const loreEntries = extractEntriesList(rawEntries, basename);
    return {
      file: basename,
      kind: 'lorebook',
      spec: Array.isArray(parsed) ? 'lorebook_array' : (Array.isArray(parsed.entries) ? 'lorebook_entries_array' : 'lorebook_entries_map'),
      card: null,
      loreEntries,
      regexScripts: [],
      extensions: {},
      otherExtensions: {},
    };
  }

  throw new Error(`文件 ${basename} 既不是有效的 SillyTavern 角色卡 JSON，也不是可识别的世界书 JSON`);
}

function renderCardCoreMarkdown(card) {
  if (!card) {
    return '# 原卡核心字段\n\n纯独立世界书输入，无角色卡主体字段。\n';
  }
  const sections = [
    ['name', card.name],
    ['creator', card.creator],
    ['character_version', card.character_version],
    ['tags', card.tags.length > 0 ? card.tags.join(', ') : ''],
    ['description', card.description],
    ['personality', card.personality],
    ['scenario', card.scenario],
    ['mes_example', card.mes_example],
    ['system_prompt', card.system_prompt],
    ['post_history_instructions', card.post_history_instructions],
    ['creator_notes', card.creator_notes],
  ];
  const lines = ['# 原卡核心字段', ''];
  for (const [heading, value] of sections) {
    lines.push(`## ${heading}`, '');
    lines.push(value ? value : '（空）', '');
  }
  return `${lines.join('\n')}`;
}

function renderGreetingsMarkdown(greetings) {
  const lines = ['# 原卡开场白', ''];
  if (greetings.length === 0) {
    lines.push('（无开场白）', '');
    return lines.join('\n');
  }
  for (const item of greetings) {
    const label = item.kind === 'first_mes'
      ? '## [0] first_mes'
      : `## [${item.index}] alternate_greetings[${item.alternate_index}]`;
    const activeFlags = Object.entries(item.detected_flags).filter(([, v]) => v).map(([k]) => k);
    lines.push(label, '');
    lines.push(`- 字符数：${item.chars}`);
    lines.push(`- 特征标记：${activeFlags.length > 0 ? activeFlags.join(', ') : '无'}`, '');
    lines.push(item.content || '（空）', '');
  }
  return lines.join('\n');
}

function renderLoreEntryMarkdown(entry) {
  const activeFlags = Object.entries(entry.detected_flags).filter(([, v]) => v).map(([k]) => k);
  const metaLines = [
    `# ${entry.comment || `条目 ${entry.index}`}`,
    '',
    `- index: ${entry.index}`,
    `- uid: ${entry.uid ?? ''}`,
    `- source_file: ${entry.source_file}`,
    `- comment: ${entry.comment}`,
    `- enabled: ${entry.enabled}`,
    `- constant: ${entry.constant}`,
    `- selective: ${entry.selective}`,
    `- keys: ${JSON.stringify(entry.keys)}`,
    `- secondary_keys: ${JSON.stringify(entry.secondary_keys)}`,
    `- position: ${entry.position ?? ''}`,
    `- order: ${entry.order ?? ''}`,
    `- depth: ${entry.depth ?? ''}`,
    `- detected_flags: ${activeFlags.length > 0 ? activeFlags.join(', ') : 'none'}`,
    '',
    '## content',
    '',
    entry.content || '（空）',
    '',
  ];
  return metaLines.join('\n');
}

async function ensureOutputDirReady(outputDir, force) {
  let exists = false;
  try {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      throw new Error(`输出路径已存在且不是目录：${outputDir}`);
    }
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists) {
    const existing = await fs.readdir(outputDir);
    if (existing.length > 0 && !force) {
      throw new Error(`输出目录非空，请指定空目录或添加 --force 覆盖：${path.basename(outputDir)}`);
    }
    if (existing.length > 0 && force) {
      await fs.rm(outputDir, {recursive: true, force: true});
    }
  }
}

/**
 * 拆包一份或多份角色卡/世界书文件到确定性目录结构。
 */
export async function unpackCards(inputFiles, outputDir, options = {}) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
    throw new Error('请至少提供 1 份输入文件（角色卡 PNG/JSON 或独立世界书 JSON）');
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('请通过 -o <输出目录> 指定输出目录');
  }

  const parsedInputs = [];
  for (const filePath of inputFiles) {
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (error) {
      throw new Error(`无法读取输入文件 ${path.basename(filePath)}：${error.message}`);
    }
    parsedInputs.push(parseInputFile(filePath, buffer));
  }

  const cardInputs = parsedInputs.filter(item => item.card !== null);
  if (cardInputs.length > 1) {
    const names = cardInputs.map(item => item.file).join('、');
    throw new Error(`检测到多份角色卡主体（${names}），每次仅允许 0 或 1 份角色卡主体加任意份独立世界书`);
  }

  const cardInput = cardInputs[0] ?? null;
  const card = cardInput?.card ?? null;
  const mergedLore = parsedInputs.flatMap(item => item.loreEntries);
  const regexScripts = cardInput?.regexScripts ?? [];
  const extensions = cardInput?.extensions ?? {};
  const otherExtensions = cardInput?.otherExtensions ?? {};
  const otherExtensionKeys = Object.keys(otherExtensions).sort();

  const greetings = [];
  if (card) {
    if (card.first_mes) {
      greetings.push({
        index: 0,
        kind: 'first_mes',
        chars: card.first_mes.length,
        detected_flags: detectFeatures(card.first_mes),
        content: card.first_mes,
      });
    }
    card.alternate_greetings.forEach((text, altIdx) => {
      greetings.push({
        index: greetings.length,
        kind: 'alternate_greeting',
        alternate_index: altIdx,
        chars: text.length,
        detected_flags: detectFeatures(text),
        content: text,
      });
    });
  }

  const allTextParts = [];
  if (card) {
    allTextParts.push(
      card.description,
      card.personality,
      card.scenario,
      card.first_mes,
      card.mes_example,
      card.system_prompt,
      card.post_history_instructions,
      card.creator_notes,
      ...card.alternate_greetings,
    );
  }
  for (const entry of mergedLore) {
    allTextParts.push(entry.content);
  }

  const combinedFeatures = detectFeatures(allTextParts.join('\n'), extensions);
  const characterLikeEntries = mergedLore.filter(entry =>
    /(?:角色|人物|人设|character|npc)/iu.test(`${entry.comment} ${entry.keys.join(' ')}`),
  );
  if (characterLikeEntries.length >= 3) {
    combinedFeatures.isMultiCharacter = true;
  }

  const regexSummary = classifyRegexScripts(regexScripts);
  const padWidth = Math.max(3, String(mergedLore.length).length);
  const usedEntryNames = new Set();
  const loreIndex = [];
  const loreFilesToWrite = [];

  mergedLore.forEach((entry, idx) => {
    const num = idx + 1;
    const prefix = String(num).padStart(padWidth, '0');
    const baseTitle = sanitizeFilenameSegment(entry.comment || entry.keys[0] || `entry-${prefix}`);
    let fileName = `${prefix}-${baseTitle}.md`;
    let suffix = 2;
    while (usedEntryNames.has(fileName)) {
      fileName = `${prefix}-${baseTitle}-${suffix}.md`;
      suffix += 1;
    }
    usedEntryNames.add(fileName);
    const relPath = toPosix(path.join('lorebook', 'entries', fileName));
    const enriched = {...entry, index: num, file: relPath};
    loreIndex.push({
      index: num,
      file: relPath,
      uid: entry.uid,
      source_file: entry.source_file,
      comment: entry.comment,
      enabled: entry.enabled,
      constant: entry.constant,
      keys: entry.keys,
      chars: entry.content.length,
      detected_flags: entry.detected_flags,
    });
    loreFilesToWrite.push({relPath, content: renderLoreEntryMarkdown(enriched)});
  });

  // 所有输入校验与内存组装成功后，再写入磁盘，避免失败时残留半成品目录
  await ensureOutputDirReady(outputDir, Boolean(options.force));

  const writtenFiles = [];
  async function writeRel(relPath, content) {
    const absPath = path.join(outputDir, relPath);
    await fs.mkdir(path.dirname(absPath), {recursive: true});
    await fs.writeFile(absPath, content, 'utf8');
    writtenFiles.push(toPosix(relPath));
  }

  await writeRel('card-core.md', renderCardCoreMarkdown(card));
  await writeRel('greetings.json', `${JSON.stringify(greetings, null, 2)}\n`);
  await writeRel('greetings.md', renderGreetingsMarkdown(greetings));
  await writeRel('lorebook/index.json', `${JSON.stringify(loreIndex, null, 2)}\n`);
  for (const item of loreFilesToWrite) {
    await writeRel(item.relPath, item.content);
  }
  if (regexScripts.length > 0) {
    await writeRel(
      'scripts/regex-scripts.json',
      `${JSON.stringify({...regexSummary, scripts: regexScripts}, null, 2)}\n`,
    );
  }
  if (otherExtensionKeys.length > 0) {
    await writeRel(
      'scripts/extensions.json',
      `${JSON.stringify({keys: otherExtensionKeys, data: otherExtensions}, null, 2)}\n`,
    );
  }

  const allFiles = [...writtenFiles, 'manifest.json'].sort();
  const manifest = {
    format_version: 1,
    inputs: parsedInputs.map(item => ({
      file: item.file,
      kind: item.kind,
      spec: item.spec,
      ...(item.chunk ? {chunk: item.chunk, chunks_found: item.chunks_found} : {}),
    })),
    card: card
      ? {
          name: card.name,
          creator: card.creator,
          character_version: card.character_version,
          tags: card.tags,
          has_card: true,
        }
      : {
          name: '',
          creator: '',
          character_version: '',
          tags: [],
          has_card: false,
        },
    counts: {
      greetings: greetings.length,
      lorebook_total: mergedLore.length,
      lorebook_enabled: mergedLore.filter(e => e.enabled).length,
      lorebook_disabled: mergedLore.filter(e => !e.enabled).length,
      lorebook_constant: mergedLore.filter(e => e.constant).length,
      regex_scripts: regexSummary.total,
      regex_scripts_display_only: regexSummary.display_only,
      regex_scripts_prompt_rewrite: regexSummary.prompt_rewrite,
      extension_keys: otherExtensionKeys.length,
    },
    features: combinedFeatures,
    files: allFiles,
  };

  await writeRel('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseCliArgs(argv) {
  const inputFiles = [];
  let outputDir = null;
  let force = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-f' || arg === '--force') {
      force = true;
    } else if (arg === '-o' || arg === '--out') {
      if (i + 1 >= argv.length) {
        throw new Error(`选项 ${arg} 缺少输出目录参数`);
      }
      outputDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      outputDir = arg.slice('--out='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else {
      inputFiles.push(arg);
    }
  }

  return {inputFiles, outputDir, force, help};
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const {inputFiles, outputDir, force, help} = parseCliArgs(argv);
    if (help) {
      stdout.write(USAGE);
      return 0;
    }
    if (inputFiles.length === 0) {
      stderr.write(`错误：请提供至少一份角色卡或世界书输入文件。\n\n${USAGE}`);
      return 1;
    }
    if (!outputDir) {
      stderr.write(`错误：请通过 -o <输出目录> 指定输出目录。\n\n${USAGE}`);
      return 1;
    }
    const manifest = await unpackCards(inputFiles, outputDir, {force});
    const activeFlags = Object.entries(manifest.features).filter(([, v]) => v).map(([k]) => k);
    stdout.write(
      `拆包完成：输入 ${manifest.inputs.length} 份，开场白 ${manifest.counts.greetings} 条，`
      + `世界书 ${manifest.counts.lorebook_total} 条（启用 ${manifest.counts.lorebook_enabled} / 停用 ${manifest.counts.lorebook_disabled} / 常驻 ${manifest.counts.lorebook_constant}），`
      + `正则 ${manifest.counts.regex_scripts} 条，特征：${activeFlags.length > 0 ? activeFlags.join(', ') : '无'}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`拆包失败：${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
