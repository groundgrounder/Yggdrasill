import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {isDeepStrictEqual, TextDecoder} from 'node:util';
import {isAlias, isMap, isPair, isScalar, isSeq, parseDocument} from 'yaml';
import {parseYaml} from './yaml.mjs';
import {
  CHAIN_FIELDS, DECLARATION_FILES, DIALOGUE_FIELDS, EVENT_BRANCH_FIELDS, EVENT_FIELDS, GROUP_FIELDS,
  OPENING_OPTION_FIELDS, OPENING_PLAN_FIELDS, POSITION_FIELDS, PROFILE_FIELDS, PROFILE_ITEM_FIELDS,
  TEXT_CONTAINERS, VERSION_FIELDS, WORLDLINE_FIELDS,
} from './contract.mjs';
import {codepointCompare, freeze, has, isMap as isPlainMap} from './utils.mjs';

const CHANGE_FIELDS = freeze(['路径', '操作', '值']);
const TIME_FIELDS = freeze(['最早', '最晚']);
const SKILL_SUPPLEMENT_FIELDS = freeze(['技能ID', '个体表现', '个体限制']);
const INITIAL_EQUIPMENT_FIELDS = freeze(['装备ID', '状态', '位置']);
const OUTCOME_FIELDS = freeze(['事件ID', '分支ID']);
const OPTION_FIELDS = freeze(['事件ID', '问题', '选项']);
const OPENING_GROUP_FIELDS = freeze(['启用', '版本ID']);
const BRANCH_DETAIL_FIELDS = freeze(['角色知情', '主观记忆']);
const CONDITION_PARAM_FIELDS = freeze({
  角色启用: freeze(['角色组ID']),
  角色版本: freeze(['角色组ID', '版本ID']),
  事件确认: freeze(['事件ID', '分支ID']),
  事件串状态: freeze(['事件串ID', '状态']),
  当前时间: freeze(['比较', '值']),
  剧情标记: freeze(['标记ID', '比较', '值']),
  角色状态: freeze(['角色组ID', '字段', '属于']),
  同处: freeze(['角色组ID']),
  角色已出场: freeze(['角色组ID']),
  当前场景: freeze(['地标', '场景']),
  在场实力人数: freeze(['最低实力', '最少人数', '排除角色组']),
  世界线: freeze(['世界线ID']),
});

const mapSpec = (order, children = {}) => ({order, children});
const seqSpec = items => ({items});

const BASIC_SPEC = mapSpec(Object.keys(PROFILE_FIELDS.基本信息), {
  稳定体貌: mapSpec(Object.keys(PROFILE_FIELDS.基本信息.稳定体貌.子字段)),
  能力特征: mapSpec(Object.keys(PROFILE_FIELDS.基本信息.能力特征.子字段), {
    技能补充: seqSpec(mapSpec(SKILL_SUPPLEMENT_FIELDS)),
  }),
});
const IMPRESSION_SPEC = mapSpec(Object.keys(PROFILE_FIELDS.角色印象), {
  表达规律: mapSpec(Object.keys(PROFILE_FIELDS.角色印象.表达规律.子字段)),
});
const GROUP_SPEC = mapSpec(GROUP_FIELDS, {
  版本: seqSpec(mapSpec(VERSION_FIELDS)),
  档案: seqSpec(mapSpec(PROFILE_ITEM_FIELDS, {
    生效条件: {condition: true},
    初始装备: seqSpec(mapSpec(INITIAL_EQUIPMENT_FIELDS)),
  })),
});
const EVENT_SPEC = mapSpec(EVENT_FIELDS, {
  触发时间: mapSpec(TIME_FIELDS),
  门槛: {condition: true},
  分支: seqSpec(mapSpec(EVENT_BRANCH_FIELDS, {
    门槛: {condition: true},
    变化: seqSpec(mapSpec(CHANGE_FIELDS)),
  })),
});
const POSITION_SPEC = mapSpec(POSITION_FIELDS, {
  按分支: {values: mapSpec(BRANCH_DETAIL_FIELDS)},
  事件触发语料: seqSpec(mapSpec(DIALOGUE_FIELDS)),
});
const CHAIN_SPEC = mapSpec(CHAIN_FIELDS, {结局: seqSpec(mapSpec(OUTCOME_FIELDS))});
const WORLDLINE_SPEC = mapSpec(WORLDLINE_FIELDS, {角色组: {values: mapSpec(OPENING_GROUP_FIELDS)}});
const OPENING_OPTIONS_SPEC = mapSpec(OPENING_OPTION_FIELDS, {选项: seqSpec(mapSpec(OPTION_FIELDS))});
const OPENING_PLAN_SPEC = mapSpec(OPENING_PLAN_FIELDS, {角色组: {values: mapSpec(OPENING_GROUP_FIELDS)}});

const EXTENSIONS = new Set(['.yaml', '.txt']);

export function recognizeWorldbookFile(relative, libraries = {}) {
  const parts = relative.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null;
  const name = parts.at(-1), dot = name.lastIndexOf('.'), extension = dot >= 0 ? name.slice(dot) : '';
  if (!EXTENSIONS.has(extension)) return null;
  const stem = extension ? name.slice(0, -extension.length) : name;
  if (parts[0] === '设定' && parts.length === 2 && extension === '.yaml' && DECLARATION_FILES.includes(stem)) {
    return {种类: '声明', 名称: stem};
  }
  if (parts[0] === '角色' && parts.length === 3 && name === '角色组.yaml') return {种类: '角色组'};
  if (parts[0] === '角色' && parts.length === 5 && parts[2] === '档案' && extension === '.txt'
    && ['基本信息', '角色印象'].includes(stem)) return {种类: stem};
  if (parts[0] === '历史') {
    if (parts.length === 2 && name === '开局选项.yaml') return {种类: '开局选项'};
    if (parts.length === 3 && parts[1] === '事件串' && extension === '.yaml') return {种类: '事件串'};
    if (parts.length === 3 && parts[1] === '世界线' && extension === '.yaml') return {种类: '世界线'};
    if (parts.length === 3 && parts[1] === '开局方案' && extension === '.yaml') return {种类: '开局方案'};
    if (parts.length === 4 && parts[1] === '事件' && name === '事件.txt') return {种类: '事件'};
    if (parts.length === 5 && parts[1] === '事件' && parts[3] === '角色' && extension === '.txt') return {种类: '角色位置'};
    return null;
  }
  if (TEXT_CONTAINERS.includes(parts[0]) && extension === '.txt') return {种类: '文本容器'};
  if (has(libraries, parts[0]) && extension === '.txt') {
    return {种类: '条目', 库: parts[0], 路径: parts, 文件名: stem};
  }
  return null;
}

export function formatYamlText(text, {kind, libraries = {}} = {}) {
  if (typeof text !== 'string') throw new TypeError('YAML 文本须为字符串');
  let baseline;
  try { baseline = parseYaml(text); }
  catch (error) { throw new Error(`YAML 解析失败：${error.message}`); }
  const makeDocument = () => {
    const document = parseDocument(text, {uniqueKeys: true, prettyErrors: true});
    if (document.errors.length) throw new Error(`YAML 解析失败：${document.errors.map(error => error.message).join('；')}`);
    if (!document.contents || !isMap(document.contents)) throw new Error('YAML 根节点须为映射');
    return document;
  };
  const document = makeDocument(), signature = aliasSignature(document.contents);
  const spec = specFor(kind, libraries);
  for (const [reorder, scalars] of [[true, true], [false, true], [false, false]]) {
    const candidate = reorder ? document : makeDocument(), firstPair = candidate.contents.items[0];
    formatNode(candidate.contents, reorder ? spec : null, {scalars});
    if (reorder && spec && candidate.contents.items[0] !== firstPair) liftHeader(candidate, firstPair);
    let output;
    try { output = candidate.toString({indent: 2, lineWidth: 0, minContentWidth: 0}); }
    catch (error) { throw new Error(`YAML 输出失败：${error.message}`); }
    if (validCandidate(output, baseline, signature)) return {text: output, changed: output !== text, value: baseline};
  }
  throw new Error('格式化后语义不一致，未写入');
}

export async function formatWorldbook(root, options = {}) {
  const fs = options.fs ?? defaultFs, path = options.path ?? defaultPath, write = options.write === true;
  const result = {项目: {目录: root, 模式: write ? '写入' : '检查', 文件: 0, 差异: 0, 已写入: 0, 异常: 0}, 文件: [], 异常: [], 已写入: []};
  let stat;
  try { stat = await fs.lstat(root); }
  catch { return fail(result, root, '无法读取世界书目录'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return fail(result, root, '世界书目录须为普通目录，不跟随符号链接');
  let libraries;
  try { libraries = await readLibraries(root, {fs, path}); }
  catch (error) { return fail(result, '设定/条目库.yaml', error.message); }
  const records = [];
  await walk(root, [], records, {fs, path, libraries, result});
  for (const record of records) {
    const file = path.join(root, ...record.相对.split('/'));
    let buffer;
    try { buffer = await fs.readFile(file); }
    catch { pushFile(result, record.相对, '读取失败', null, null, '无法读取文件'); continue; }
    const originalHash = hash(buffer);
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(buffer); }
    catch { pushFile(result, record.相对, '读取失败', originalHash, null, '文件不是有效的 UTF-8'); continue; }
    let formatted;
    try { formatted = formatYamlText(text, {kind: record.种类, libraries}); }
    catch (error) { pushFile(result, record.相对, '解析失败', originalHash, null, error.message); continue; }
    const newHash = hash(Buffer.from(formatted.text, 'utf8'));
    const entry = {文件: record.相对, 状态: formatted.changed ? (write ? '待写入' : '有差异') : '无差异',
      原哈希: originalHash, 新哈希: newHash, 解析异常: null, 字节: buffer.length, 新字节: Buffer.byteLength(formatted.text)};
    result.文件.push(entry);
    if (!formatted.changed) continue;
    result.项目.差异++;
    if (!write) continue;
    try {
      const original = await fs.stat(file);
      await atomicReplace(file, formatted.text, original.mode & 0o7777, {fs, path});
      entry.状态 = '已格式化';
      result.已写入.push({文件: record.相对, 原哈希: originalHash, 新哈希: newHash, 字节: entry.新字节});
    } catch (error) {
      entry.状态 = '写入失败';
      result.异常.push({文件: record.相对, 说明: `写入失败：${error.message}`});
    }
  }
  result.文件.sort((left, right) => codepointCompare(left.文件, right.文件));
  result.已写入.sort((left, right) => codepointCompare(left.文件, right.文件));
  result.项目.文件 = result.文件.length;
  result.项目.已写入 = result.已写入.length;
  result.项目.异常 = result.异常.length;
  return result;
}

function specFor(kind, libraries) {
  switch (kind?.种类) {
    case '角色组': return GROUP_SPEC;
    case '事件': return EVENT_SPEC;
    case '角色位置': return POSITION_SPEC;
    case '事件串': return CHAIN_SPEC;
    case '世界线': return WORLDLINE_SPEC;
    case '开局选项': return OPENING_OPTIONS_SPEC;
    case '开局方案': return OPENING_PLAN_SPEC;
    case '基本信息': return BASIC_SPEC;
    case '角色印象': return IMPRESSION_SPEC;
    case '条目': {
      const schema = libraries[kind.库], parts = kind.路径, stem = kind.文件名;
      const description = schema?.分法 === '按上下级'
        ? parts.length === 2 && stem === kind.库
        : stem === (parts.length === 2 ? kind.库 : parts.at(-2));
      return description ? null : entrySpec(kind.库, schema);
    }
    default: return null;
  }
}

function entrySpec(library, schema) {
  const fields = isPlainMap(schema?.字段) ? schema.字段 : {};
  const names = Object.keys(fields);
  const children = Object.create(null);
  for (const name of names) children[name] = fieldSpec(fields[name]);
  return mapSpec([`${library}ID`, '名称', ...names], children);
}

function fieldSpec(schema) {
  if (!isPlainMap(schema)) return undefined;
  if (isPlainMap(schema.子字段)) {
    const names = Object.keys(schema.子字段), children = Object.create(null);
    for (const name of names) children[name] = fieldSpec(schema.子字段[name]);
    return mapSpec(names, children);
  }
  if (isPlainMap(schema.映射)) return {values: fieldSpec(schema.映射.值)};
  return undefined;
}

function liftHeader(document, firstPair) {
  const comment = firstPair?.key?.commentBefore;
  if (!comment) return;
  document.commentBefore = document.commentBefore ? `${document.commentBefore}\n${comment}` : comment;
  firstPair.key.commentBefore = null;
}

function formatNode(node, spec, {scalars}) {
  if (isMap(node)) {
    if (spec?.condition) { formatCondition(node, {scalars}); return; }
    if (spec?.order) node.items = orderPairs(node.items, spec.order);
    for (const pair of node.items) {
      const name = keyName(pair.key);
      const child = name !== null && spec?.children && has(spec.children, name) ? spec.children[name] : undefined;
      formatNode(pair.value, child ?? spec?.values ?? null, {scalars});
    }
    if (node.items.length) {
      if (node.comment) relocateComment(node);
      node.flow = false;
    } else node.flow = true;
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) formatNode(item, spec?.items ?? null, {scalars});
    if (node.items.length) {
      if (node.comment) relocateComment(node);
      node.flow = false;
    } else node.flow = true;
    return;
  }
  if (scalars && isScalar(node)) normalizeScalar(node);
}

function relocateComment(node) {
  let target = node;
  while (target) {
    if (isPair(target)) target = target.value;
    else if (isMap(target) || isSeq(target)) target = target.items.at(-1);
    else break;
  }
  if (target && isScalar(target) && !target.comment) {
    target.comment = node.comment;
    node.comment = null;
  }
}

function formatCondition(node, options) {
  if (!isMap(node) || node.items.length !== 1) { formatNode(node, null, options); return; }
  const pair = node.items[0], name = keyName(pair.key);
  if (name === 'all' || name === 'any' || name === 'none') {
    if (isSeq(pair.value)) {
      for (const item of pair.value.items) formatCondition(item, options);
      pair.value.flow = pair.value.items.length === 0;
    } else formatNode(pair.value, null, options);
  } else if (name !== null && has(CONDITION_PARAM_FIELDS, name) && isMap(pair.value)) {
    pair.value.items = orderPairs(pair.value.items, CONDITION_PARAM_FIELDS[name]);
    for (const item of pair.value.items) formatNode(item.value, null, options);
    pair.value.flow = pair.value.items.length === 0;
  } else formatNode(pair.value, null, options);
  node.flow = false;
}

function normalizeScalar(node) {
  if (typeof node.value !== 'string') return;
  if (node.value.includes('\n') && !node.value.includes('\r')) node.type = 'BLOCK_LITERAL';
  else if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') node.type = 'PLAIN';
}

function orderPairs(items, order) {
  const rank = new Map(order.map((name, index) => [name, index]));
  const entries = items.map((pair, index) => ({pair, index, name: keyName(pair.key)}));
  entries.sort((left, right) => {
    const leftRank = left.name === null ? Number.POSITIVE_INFINITY : rank.get(left.name) ?? rank.size;
    const rightRank = right.name === null ? Number.POSITIVE_INFINITY : rank.get(right.name) ?? rank.size;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank === rank.size) {
      const compared = codepointCompare(left.name, right.name);
      if (compared) return compared;
    }
    return left.index - right.index;
  });
  return dependencyOrder(entries);
}

function dependencyOrder(entries) {
  if (entries.length < 2) return entries.map(entry => entry.pair);
  const definitions = new Map(), aliases = [];
  for (const [index, entry] of entries.entries()) {
    const anchors = new Set(), references = new Set();
    collectAnchors(entry.pair.key, anchors, references);
    collectAnchors(entry.pair.value, anchors, references);
    for (const name of anchors) {
      if (!definitions.has(name)) definitions.set(name, []);
      definitions.get(name).push(index);
    }
    aliases[index] = references;
  }
  const edges = Array.from({length: entries.length}, () => new Set()), incoming = new Array(entries.length).fill(0);
  for (const [index, references] of aliases.entries()) for (const name of references) {
    for (const source of definitions.get(name) ?? []) {
      if (source === index || edges[source].has(index)) continue;
      edges[source].add(index);
      incoming[index]++;
    }
  }
  const available = [];
  for (let index = 0; index < entries.length; index++) if (incoming[index] === 0) available.push(index);
  const sorted = [];
  while (available.length) {
    available.sort((left, right) => left - right);
    const index = available.shift();
    sorted.push(entries[index].pair);
    for (const next of edges[index]) if (--incoming[next] === 0) available.push(next);
  }
  return sorted.length === entries.length ? sorted : entries.map(entry => entry.pair);
}

function collectAnchors(node, anchors, aliases) {
  if (!node || typeof node !== 'object') return;
  if (isAlias(node)) { aliases.add(node.source); return; }
  if (node.anchor) anchors.add(node.anchor);
  if (isPair(node)) { collectAnchors(node.key, anchors, aliases); collectAnchors(node.value, anchors, aliases); return; }
  if (isMap(node) || isSeq(node)) for (const item of node.items) collectAnchors(item, anchors, aliases);
}

function aliasSignature(node) {
  const anchors = [], aliases = [];
  collectNames(node, anchors, aliases);
  return `${anchors.sort(codepointCompare).join('\u0000')}\u0001${aliases.sort(codepointCompare).join('\u0000')}`;
}

function collectNames(node, anchors, aliases) {
  if (!node || typeof node !== 'object') return;
  if (isAlias(node)) { aliases.push(node.source); return; }
  if (node.anchor) anchors.push(node.anchor);
  if (isPair(node)) { collectNames(node.key, anchors, aliases); collectNames(node.value, anchors, aliases); return; }
  if (isMap(node) || isSeq(node)) for (const item of node.items) collectNames(item, anchors, aliases);
}

function keyName(node) {
  return isScalar(node) && typeof node.value === 'string' ? node.value : null;
}

function validCandidate(text, baseline, signature) {
  let document;
  try {
    document = parseDocument(text, {uniqueKeys: true, prettyErrors: true});
    if (document.errors.length || !document.contents) return false;
    return isDeepStrictEqual(baseline, parseYaml(text)) && aliasSignature(document.contents) === signature;
  } catch { return false; }
}

async function readLibraries(root, {fs, path}) {
  const file = path.join(root, '设定', '条目库.yaml');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(await fs.readFile(file)); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`无法读取条目库 ${file}：${error?.code ?? error?.message ?? error}`);
  }
  let value;
  try { value = parseYaml(text); }
  catch (error) { throw new Error(`条目库 YAML 解析失败 ${file}：${error.message}`); }
  if (!isPlainMap(value)) throw new Error(`条目库根节点须为映射 ${file}`);
  return value;
}

async function walk(root, parts, records, context) {
  const {fs, path, libraries, result} = context, relative = parts.join('/');
  let children;
  try { children = await fs.readdir(path.join(root, ...parts), {withFileTypes: true}); }
  catch { result.异常.push({文件: relative || '.', 说明: '无法读取目录'}); return; }
  children.sort((left, right) => codepointCompare(left.name, right.name));
  for (const child of children) {
    if (child.name.startsWith('.')) continue;
    const next = [...parts, child.name], file = next.join('/');
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) { await walk(root, next, records, context); continue; }
    if (!child.isFile()) continue;
    const kind = recognizeWorldbookFile(file, libraries);
    if (kind) records.push({相对: file, 种类: kind});
  }
}

async function atomicReplace(file, text, mode, {fs, path}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.ygg-format-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(Buffer.from(text, 'utf8'));
      await handle.sync();
    } finally { await handle.close(); }
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.unlink(temporary); } catch {}
    throw error;
  }
}

function pushFile(result, file, status, originalHash, newHash, message) {
  result.文件.push({文件: file, 状态: status, 原哈希: originalHash, 新哈希: newHash, 解析异常: message});
  result.异常.push({文件: file, 说明: message});
}

function fail(result, file, message) {
  result.异常.push({文件: file, 说明: message});
  result.项目.异常 = result.异常.length;
  return result;
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
