// 作者视图的写入面：预览、保存、备份、恢复与批注/布局。
// 所有写入串行化；预览只在校验通过且完整输入指纹未变时签发一次性令牌。
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {checkWorldbook, issue} from '../checker/index.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {analyzeEventTree} from '../core/graph.mjs';
import {buildReferenceIndex} from '../core/references.mjs';
import {codepointCompare, has, isMap, isText, list} from '../core/utils.mjs';
import {digest, impactOf, loadProject, queryReference} from './data.mjs';

export {digest};
export const PREVIEW_TTL = 15 * 60 * 1000;
export const MAX_BODY = 2_500_000;
export const MAX_CANDIDATE = 256_000;
export const MAX_STATE = 2_000_000;
export const NOTE_STATUSES = Object.freeze(['待审', '通过', '需调整']);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ViewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ViewError';
    this.status = status;
  }
}

const isInside = (parent, child) => {
  const relative = defaultPath.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !defaultPath.isAbsolute(relative));
};

const normalizeRelative = (base, file) => defaultPath.relative(base, file).split(defaultPath.sep).join('/');

function safe(value, fallback = null) {
  try { return value(); }
  catch { return fallback; }
}

const realOrNull = async (fs, target) => {
  try { return await fs.realpath(target); }
  catch { return null; }
};

/**
 * 默认存储必须在实现仓库与世界书之外；显式存储也必须避开输入世界书和出处目录。
 * 不创建目录，避免“启动即写入”。
 */
export async function assertStorage({worldbook, storage, repoRoot = null, fs = defaultFs, path = defaultPath}) {
  const root = path.resolve(worldbook), target = path.resolve(storage);
  let rootStat;
  try { rootStat = await fs.stat(root); }
  catch { throw new ViewError(`世界书目录不存在或不可读：${root}`, 400); }
  if (!rootStat.isDirectory()) throw new ViewError(`世界书不是目录：${root}`, 400);
  const source = path.join(path.dirname(root), '作者资料', '出处');
  const forbidden = (candidate, label) => {
    if (isInside(candidate, target)) throw new ViewError(`存储目录不能位于${label}内：${target}`, 400);
  };
  forbidden(root, '世界书');
  forbidden(source, '作者资料/出处');
  if (repoRoot) forbidden(path.resolve(repoRoot), '实现仓库');
  if (target === path.parse(target).root) throw new ViewError('存储目录不能是文件系统根目录', 400);

  let existingTarget = null;
  try { existingTarget = await fs.realpath(target); }
  catch (error) { if (error?.code !== 'ENOENT') throw new ViewError(`无法检查存储目录：${error.message}`, 400); }
  const realRoot = await realOrNull(fs, root);
  const realSource = await realOrNull(fs, source);
  const realRepo = repoRoot ? (await realOrNull(fs, path.resolve(repoRoot))) ?? path.resolve(repoRoot) : null;
  if (existingTarget) {
    const stat = await fs.stat(existingTarget);
    if (!stat.isDirectory()) throw new ViewError(`存储路径不是目录：${target}`, 400);
    if (realRoot && isInside(realRoot, existingTarget)) throw new ViewError(`存储目录不能位于世界书内：${target}`, 400);
    if (realSource && isInside(realSource, existingTarget)) throw new ViewError(`存储目录不能位于作者资料/出处内：${target}`, 400);
    if (realRepo && isInside(realRepo, existingTarget)) throw new ViewError(`存储目录不能位于实现仓库内：${target}`, 400);
  }
  else {
    // 存储尚未创建时，解析最近的已存在祖先，防止父级符号链接把写入带进禁写区域。
    let ancestor = path.dirname(target);
    for (;;) {
      try { await fs.access(ancestor); break; }
      catch { const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next; }
    }
    const realAncestor = (await realOrNull(fs, ancestor)) ?? ancestor;
    const realCandidate = path.join(realAncestor, path.relative(ancestor, target));
    if (realRoot && isInside(realRoot, realCandidate)) throw new ViewError(`存储目录不能位于世界书内：${target}`, 400);
    if (realSource && isInside(realSource, realCandidate)) throw new ViewError(`存储目录不能位于作者资料/出处内：${target}`, 400);
    if (realRepo && isInside(realRepo, realCandidate)) throw new ViewError(`存储目录不能位于实现仓库内：${target}`, 400);
  }
  return {worldbook: realRoot ?? root, storage: target, projectRoot: path.dirname(realRoot ?? root)};
}

async function copyTree(from, to, {fs, path}) {
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) throw new ViewError(`审阅目录不支持符号链接：${from}`, 400);
  if (stat.isDirectory()) {
    await fs.mkdir(to, {recursive: true});
    const children = (await fs.readdir(from, {withFileTypes: true}))
      .sort((left, right) => codepointCompare(left.name, right.name));
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      await copyTree(path.join(from, child.name), path.join(to, child.name), {fs, path});
    }
    return;
  }
  if (!stat.isFile()) throw new ViewError(`不读取特殊文件：${from}`, 400);
  await fs.copyFile(from, to);
}

/**
 * 完整输入指纹：世界书整棵树 + 作者资料/出处 + 项目 yggdrasill.yaml。
 * 读取期不写入；符号链接被拒绝，避免把指纹之外的路径带进预览。
 */
export async function fingerprintProject(root, {fs = defaultFs, path = defaultPath, storage = null} = {}) {
  root = path.resolve(root);
  const projectRoot = path.dirname(root);
  const rows = [];
  const walk = async (directory, label) => {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw new ViewError(`审阅目录不支持符号链接：${directory}`, 400);
    if (!stat.isDirectory()) return;
    const children = (await fs.readdir(directory, {withFileTypes: true}))
      .sort((left, right) => codepointCompare(left.name, right.name));
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (storage && (file === path.resolve(storage) || isInside(path.resolve(storage), file))) continue;
      if (child.isSymbolicLink()) throw new ViewError(`审阅目录不支持符号链接：${file}`, 400);
      if (child.isDirectory()) { await walk(file, label); continue; }
      if (!child.isFile()) throw new ViewError(`不读取特殊文件：${file}`, 400);
      rows.push(`${label}/${normalizeRelative(directory, file)}\u0000${digest(await fs.readFile(file))}`);
    }
  };
  await walk(root, '世界书');
  const sources = path.join(projectRoot, '作者资料', '出处');
  try { await walk(sources, '作者资料/出处'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const settings = path.join(projectRoot, 'yggdrasill.yaml');
  let settingsStat;
  try { settingsStat = await fs.lstat(settings); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (settingsStat) {
    if (settingsStat.isSymbolicLink()) throw new ViewError('运行参数文件不支持符号链接', 400);
    rows.push(`yggdrasill.yaml\u0000${digest(await fs.readFile(settings))}`);
  }
  rows.sort(codepointCompare);
  return digest(rows.join('\n'));
}

export function lineDiff(before, after) {
  const left = before.split('\n'), right = after.split('\n');
  if (left.length * right.length > 1_000_000) return [
    ...left.map(text => ({type: '-', text})), ...right.map(text => ({type: '+', text})),
  ];
  const table = Array.from({length: left.length + 1}, () => new Uint32Array(right.length + 1));
  for (let row = left.length - 1; row >= 0; row--) for (let column = right.length - 1; column >= 0; column--)
    table[row][column] = left[row] === right[column] ? table[row + 1][column + 1] + 1
      : Math.max(table[row + 1][column], table[row][column + 1]);
  const rows = [];
  let row = 0, column = 0;
  while (row < left.length || column < right.length) {
    if (row < left.length && column < right.length && left[row] === right[column]) {
      rows.push({type: ' ', text: left[row++]});
      column++;
    }
    else if (column < right.length && (row === left.length || table[row][column + 1] >= table[row + 1][column]))
      rows.push({type: '+', text: right[column++]});
    else rows.push({type: '-', text: left[row++]});
  }
  return rows;
}

export async function atomicWrite(file, text, {fs = defaultFs, path = defaultPath, mode = null} = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, {recursive: true});
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', mode === null ? 0o644 : mode & 0o777);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    if (mode !== null) await fs.chmod(temp, mode & 0o777);
    await fs.rename(temp, file);
    const directoryHandle = await fs.open(directory, 'r');
    try { await directoryHandle.sync(); } catch { /* 某些文件系统不支持目录同步 */ }
    finally { await directoryHandle.close(); }
  }
  finally { await fs.rm(temp, {force: true}); }
}

function assertSafeValue(value, label = '候选事件') {
  if (Array.isArray(value)) { value.forEach(item => assertSafeValue(item, label)); return; }
  if (!isMap(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (BAD_KEYS.has(key)) throw new ViewError(`${label}含危险键“${key}”`, 400);
    assertSafeValue(child, label);
  }
  for (const branch of list(value.分支)) for (const change of list(branch?.变化)) {
    if (isText(change?.路径) && change.路径.split('.').some(part => BAD_KEYS.has(part)))
      throw new ViewError(`${label}的变化路径含危险段`, 400);
  }
}

function assertKeys(value, keys, label = '输入') {
  if (!isMap(value)) throw new ViewError(`${label}须为对象`, 400);
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length) throw new ViewError(`${label}含未知字段：${unknown.join('、')}`, 400);
}

function validateStateValue(value) {
  assertKeys(value, ['notes', 'layout'], '批注与布局');
  if (!isMap(value.notes) || !isMap(value.layout)) throw new ViewError('批注与布局须为映射', 400);
  const safeKey = key => {
    if (!isText(key) && key !== '') throw new ViewError('批注或布局的键须为文本', 400);
    if (key.length > 300) throw new ViewError('批注或布局的键过长', 400);
    if (BAD_KEYS.has(key)) throw new ViewError('批注或布局的键不合法', 400);
  };
  for (const [key, note] of Object.entries(value.notes)) {
    safeKey(key);
    assertKeys(note, ['text', 'status'], '批注');
    if (typeof note.text !== 'string' || note.text.length > 12_000) throw new ViewError('批注文本须为不超过 12000 字的文本', 400);
    if (!NOTE_STATUSES.includes(note.status)) throw new ViewError('批注状态不合法', 400);
  }
  for (const [key, position] of Object.entries(value.layout)) {
    safeKey(key);
    assertKeys(position, ['x', 'y'], '布局');
    if (![position.x, position.y].every(number => Number.isFinite(number) && Math.abs(number) < 1_000_000))
      throw new ViewError('布局坐标不合法', 400);
  }
  return value;
}

function readStateShape(raw) {
  const empty = {notes: {}, layout: {}};
  if (raw === null) return {revision: digest(''), value: empty, damaged: false, error: null};
  let value;
  try { value = JSON.parse(raw); }
  catch { return {revision: digest(raw), value: empty, damaged: true, error: '审阅状态文件不是合法 JSON'}; }
  if (!isMap(value) || Object.keys(value).some(key => !['notes', 'layout'].includes(key))
    || !isMap(value.notes) || !isMap(value.layout))
    return {revision: digest(raw), value: empty, damaged: true, error: '审阅状态文件结构不正确'};
  return {revision: digest(raw), value, damaged: false, error: null};
}

/**
 * 创建存储面。preview/save/review 共享一条写队列；预览令牌 15 分钟有效。
 */
export function createViewStore({worldbook, storage, fs = defaultFs, path = defaultPath,
  now = () => Date.now(), check = checkWorldbook, previewTTL = PREVIEW_TTL} = {}) {
  const root = path.resolve(worldbook), storeRoot = path.resolve(storage);
  const stateFile = path.join(storeRoot, '审阅状态.json');
  const previews = new Map();
  let pending = Promise.resolve();
  const locked = fn => {
    const next = pending.then(fn, fn);
    pending = next.catch(() => {});
    return next;
  };
  const readStateFile = async () => {
    let raw;
    try { raw = await fs.readFile(stateFile, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return readStateShape(null);
      throw new ViewError(`无法读取审阅状态：${error.message}`, 400);
    }
    return readStateShape(raw);
  };
  const fullCheck = async () => {
    try {
      const result = await check(root, {sampling: true, fs, path});
      return {模式: '完整检查', 通过: result.errors.length === 0, 错误: result.errors.length,
        提示: result.hints.length, 摘要: result.summary, 错误列表: result.errors, 提示列表: result.hints};
    }
    catch (error) {
      return {模式: '完整检查', 通过: false, 错误: 1, 提示: 0, 摘要: null,
        错误列表: [issue('视图.完整检查失败', '错误', '.', error.message)], 提示列表: []};
    }
  };

  const preview = input => locked(async () => {
    assertKeys(input, ['eventID', 'raw', 'revision'], '预览输入');
    if (!isText(input.eventID)) throw new ViewError('事件ID须为文本', 400);
    if (typeof input.raw !== 'string') throw new ViewError('事件原文须为文本', 400);
    if (Buffer.byteLength(input.raw, 'utf8') > MAX_CANDIDATE) throw new ViewError('事件原文须小于 256KB', 400);
    if (!isText(input.revision)) throw new ViewError('revision 须为文本', 400);

    let project;
    try { project = await loadProject(root, {fs, path}); }
    catch (error) { throw new ViewError(`无法读取世界书：${error.message}`, 400); }
    const {catalog, decl, analysis, index, settings, settingsSource} = project;
    const event = list(catalog.events).find(item => item.id === input.eventID);
    if (!event) throw new ViewError(`未知事件：${input.eventID}`, 404);
    const file = path.join(root, ...event.文件.split('/'));
    if (!isInside(root, file)) throw new ViewError('事件路径越界', 400);
    const before = event.原文;
    if (typeof before !== 'string') throw new ViewError('事件原文缺失或不可读', 400);
    if (digest(before) !== input.revision) throw new ViewError('原文已被外部修改，请刷新后重新编辑', 409);

    const fingerprint = await fingerprintProject(root, {fs, path, storage: storeRoot});
    const diff = lineDiff(before, input.raw);
    const precheckErrors = [];
    let candidate = null;
    try {
      candidate = parseYaml(input.raw);
      if (!isMap(candidate)) throw new ViewError('事件原文须为 YAML 映射', 400);
      if (candidate.事件ID !== input.eventID) throw new ViewError('事件ID不可在编辑中修改；改名需要同步迁移引用', 400);
      assertSafeValue(candidate);
    }
    catch (error) {
      if (!(error instanceof ViewError)) error = new ViewError(`候选事件解析失败：${error.message}`, 400);
      precheckErrors.push(issue('视图.候选', '错误', event.文件, error.message));
      candidate = null;
    }

    const beforeQuery = safe(() => queryReference(index, `事件:${input.eventID}`), {
      对象: {对象键: `事件:${input.eventID}`}, 引用它: [], 它引用: [], 出处: [], 异常: [],
    });
    const downstream = safe(() => impactOf(catalog, input.eventID), []);
    let after = null;
    if (candidate) {
      const afterCatalog = {...catalog, events: list(catalog.events).map(item => item.id === input.eventID
        ? {...item, 内容: candidate, 原文: input.raw} : item)};
      const afterIndex = safe(() => buildReferenceIndex(afterCatalog, decl), null);
      const afterAnalysis = safe(() => analyzeEventTree(afterCatalog, decl), null);
      after = {
        引用它: afterIndex ? safe(() => queryReference(afterIndex, `事件:${input.eventID}`)?.引用它, []) : [],
        下游: safe(() => impactOf(afterCatalog, input.eventID), []),
        结构异常: afterAnalysis ? list(afterAnalysis.issues).filter(item => item?.文件 === event.文件) : [],
      };
    }
    const impact = {
      引用它: beforeQuery?.引用它 ?? [], 它引用: beforeQuery?.它引用 ?? [],
      出处: beforeQuery?.出处 ?? [], 异常: beforeQuery?.异常 ?? [],
      下游: downstream,
      档案: (beforeQuery?.引用它 ?? []).filter(reference => reference.来源类型 === '档案'
        && (reference.字段 === '生效条件' || reference.字段.startsWith('生效条件.'))),
      角色位置: list(event.角色位置).map(position => position.角色组ID ?? position.内容?.角色组ID).filter(isText),
      修改后: after,
    };

    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-view-preview-'));
    let validation;
    try {
      const base = path.basename(root);
      const stageRoot = path.join(stage, base);
      await copyTree(root, stageRoot, {fs, path});
      const source = path.join(path.dirname(root), '作者资料', '出处');
      try { await copyTree(source, path.join(stage, '作者资料', '出处'), {fs, path}); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
      try { await fs.copyFile(settingsFile, path.join(stage, 'yggdrasill.yaml')); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const stagedEvent = path.join(stageRoot, ...event.文件.split('/'));
      await fs.mkdir(path.dirname(stagedEvent), {recursive: true});
      await fs.writeFile(stagedEvent, input.raw, 'utf8');
      const result = await check(stageRoot, {sampling: false, fs, path});
      const errors = [...precheckErrors, ...result.errors];
      validation = {模式: '静态检查', 通过: errors.length === 0, 错误: errors.length,
        提示: result.hints.length, 摘要: result.summary, 错误列表: errors, 提示列表: result.hints};
    }
    catch (error) {
      validation = {模式: '静态检查', 通过: false, 错误: 1, 提示: 0, 摘要: null,
        错误列表: [...precheckErrors, issue('视图.预览失败', '错误', event.文件, error.message)], 提示列表: []};
    }
    finally { await fs.rm(stage, {recursive: true, force: true}); }

    const afterFingerprint = await fingerprintProject(root, {fs, path, storage: storeRoot});
    if (afterFingerprint !== fingerprint) throw new ViewError('校验期间项目发生变化，请重新预览', 409);

    for (const [token, value] of previews) if (value.expires < now()) previews.delete(token);
    const unchanged = before === input.raw;
    let token = null;
    if (validation.通过 && !unchanged) {
      token = randomUUID();
      previews.set(token, {eventID: input.eventID, file, before, raw: input.raw,
        fingerprint, validation, expires: now() + previewTTL});
    }
    return {
      eventID: input.eventID, 文件: event.文件, 当前revision: input.revision, revision: digest(input.raw),
      unchanged, token, validation, diff, impact,
      输入: {
        世界书: path.basename(root),
        作者资料: {出处: {存在: catalog.sources !== null,
          文件: list(catalog.sources?.记录).length}},
        运行参数: {来源: settingsSource, 值: settings},
        检查模式: '静态检查',
        临时副本: '世界书 + 作者资料/出处 + yggdrasill.yaml',
      },
    };
  });

  const save = input => locked(async () => {
    assertKeys(input, ['token', 'raw'], '保存输入');
    if (!isText(input.token) || typeof input.raw !== 'string') throw new ViewError('保存输入缺少令牌或原文', 400);
    const stored = previews.get(input.token);
    if (!stored) throw new ViewError('预览已过期或不存在，请重新预览', 409);
    if (stored.expires < now()) { previews.delete(input.token); throw new ViewError('预览已过期，请重新预览', 409); }
    if (input.raw !== stored.raw) throw new ViewError('编辑内容已改变，请重新预览', 409);
    const fingerprint = await fingerprintProject(root, {fs, path, storage: storeRoot});
    if (fingerprint !== stored.fingerprint) throw new ViewError('项目文件在预览后发生变化，请刷新并重新预览', 409);
    let current;
    try { current = await fs.readFile(stored.file, 'utf8'); }
    catch (error) { throw new ViewError(`无法读取事件原文：${error.message}`, 409); }
    if (current !== stored.before) throw new ViewError('原文已被外部修改', 409);

    const stat = await fs.stat(stored.file);
    const stamp = new Date(now()).toISOString().replaceAll(':', '-');
    const backupDirectory = path.join(storeRoot, '修改备份', `${stamp}_${randomUUID()}`);
    const metadata = {
      事件ID: stored.eventID,
      源文件: normalizeRelative(root, stored.file),
      保存时间: new Date(now()).toISOString(),
      修改前哈希: digest(stored.before),
      修改后哈希: digest(input.raw),
    };
    await atomicWrite(path.join(backupDirectory, '事件.txt'), stored.before, {fs, path, mode: stat.mode});
    await atomicWrite(path.join(backupDirectory, '修改说明.json'), `${JSON.stringify(metadata, null, 2)}\n`,
      {fs, path, mode: 0o644});
    if (await fingerprintProject(root, {fs, path, storage: storeRoot}) !== stored.fingerprint)
      throw new ViewError('备份期间项目文件发生变化，已停止写入', 409);

    await atomicWrite(stored.file, input.raw, {fs, path, mode: stat.mode});
    previews.delete(input.token);
    const full = await fullCheck();
    return {
      saved: true, 事件ID: stored.eventID, revision: digest(input.raw),
      backup: normalizeRelative(storeRoot, backupDirectory), 备份说明: metadata,
      静态预览: {模式: stored.validation.模式, 通过: stored.validation.通过, 摘要: stored.validation.摘要},
      检查: full,
      message: full.通过 ? '已保存；完整检查通过。' : `已保存；完整检查未通过：${full.错误} 错误、${full.提示} 提示。`,
    };
  });

  const saveState = input => locked(async () => {
    assertKeys(input, ['revision', 'value'], '批注与布局');
    if (!isText(input.revision)) throw new ViewError('revision 须为文本', 400);
    const current = await readStateFile();
    if (input.revision !== current.revision) throw new ViewError('批注或布局已在其他窗口更新，请刷新', 409);
    const value = validateStateValue(input.value);
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATE) throw new ViewError('批注与布局总量超过 2MB', 400);
    await atomicWrite(stateFile, raw, {fs, path, mode: 0o644});
    return {revision: digest(raw), value};
  });

  const restore = backup => locked(async () => {
    const directory = path.resolve(storeRoot, backup);
    const backupRoot = path.join(storeRoot, '修改备份');
    if (directory === backupRoot || !isInside(backupRoot, directory))
      throw new ViewError('只能从本存储的修改备份恢复', 400);
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(directory, '修改说明.json'), 'utf8')); }
    catch (error) { throw new ViewError(`无法读取备份说明：${error.message}`, 400); }
    if (!isMap(metadata) || !isText(metadata.源文件) || !isText(metadata.修改前哈希) || !isText(metadata.修改后哈希))
      throw new ViewError('备份说明结构不正确', 400);
    const original = await fs.readFile(path.join(directory, '事件.txt'), 'utf8');
    if (digest(original) !== metadata.修改前哈希) throw new ViewError('备份文件哈希与说明不符，拒绝恢复', 409);
    const target = path.join(root, ...metadata.源文件.split('/'));
    if (!isInside(root, target)) throw new ViewError('备份源路径越界，拒绝恢复', 400);
    let current;
    try { current = await fs.readFile(target, 'utf8'); }
    catch (error) { throw new ViewError(`无法读取待恢复事件：${error.message}`, 409); }
    if (digest(current) !== metadata.修改后哈希)
      throw new ViewError('源文件在保存后又被修改，拒绝用旧备份覆盖', 409);
    const stat = await fs.stat(target);
    await atomicWrite(target, original, {fs, path, mode: stat.mode});
    return {restored: true, 事件ID: metadata.事件ID, 哈希: digest(original), 文件: metadata.源文件,
      检查: await fullCheck()};
  });

  return Object.freeze({
    worldbook: root, storage: storeRoot,
    readState: () => readStateFile(),
    preview, save, saveState, restore,
  });
}
