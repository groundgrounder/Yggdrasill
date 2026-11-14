// 构建清单：规范化世界书与程序依赖，按固定顺序计算内容哈希。这里只供构建脚本使用，不进入浏览器运行时。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const HASH_ALGORITHM = 'SHA-256';
export const RECORD_FORMAT = 1;
export const RUNTIME_ROOT = '/项目';
export const PROGRAM_TEMPLATES = ['变量更新规则', '角色通用约束', '扮演准则'];

const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const fail = message => {
  const error = new Error(message);
  error.code = '清单.路径';
  throw error;
};

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function compareCodePoints(left, right) {
  const a = [...left].map(char => char.codePointAt(0));
  const b = [...right].map(char => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

// 源相对路径必须以 / 分段，拒绝宿主绝对路径、反斜杠、空段、.、.. 与 NUL。
export function normalizeSourcePath(value, label = '路径') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) fail(`${label}不是可用的相对路径：${String(value)}`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(`${label}不得是宿主绝对路径：${value}`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail(`${label}含空段、. 或 ..：${value}`);
  return parts.join('/');
}

export function virtualPath(value) {
  return `${RUNTIME_ROOT}/${normalizeSourcePath(value)}`;
}

export function normalizeVirtualPath(value, label = '运行时路径') {
  if (typeof value !== 'string' || !value.startsWith(`${RUNTIME_ROOT}/`)) fail(`${label}须位于 ${RUNTIME_ROOT}：${String(value)}`);
  return virtualPath(value.slice(RUNTIME_ROOT.length + 1));
}

// 先按内容哈希，再用无空白 JSON 的 [路径, 哈希] 数组重算总哈希。
export function digestEntries(entries) {
  const ordered = entries.map(item => {
    const entryPath = typeof item.路径 === 'string' && item.路径.startsWith(`${RUNTIME_ROOT}/`)
      ? normalizeVirtualPath(item.路径, '摘要路径')
      : normalizeSourcePath(item.路径, '摘要路径');
    if (!/^[0-9a-f]{64}$/.test(item.SHA256)) fail(`摘要中的 SHA-256 不合法：${entryPath}`);
    return [entryPath, item.SHA256];
  }).sort((a, b) => compareCodePoints(a[0], b[0]));
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index - 1][0] === ordered[index][0]) fail(`规范化路径重复：${ordered[index][0]}`);
  }
  return sha256(Buffer.from(JSON.stringify(ordered), 'utf8'));
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function contain(realRoot, file, label) {
  const real = await fs.realpath(file);
  const relative = path.relative(realRoot, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${label}越出项目根：${file}`);
  return real;
}

function textEntry(file, buffer) {
  let text;
  try { text = utf8.decode(buffer); }
  catch { fail(`${file}不是合法 UTF-8 文本`); }
  return {text, bytes: buffer.byteLength, SHA256: sha256(buffer)};
}

async function walkWorldbook(directory, relative, realRoot, entries) {
  const children = await fs.readdir(directory, {withFileTypes: true});
  children.sort((a, b) => compareCodePoints(a.name, b.name));
  for (const child of children) {
    if (child.isSymbolicLink()) fail(`不跟随符号链接：${path.join(directory, child.name)}`);
    const full = path.join(directory, child.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) fail(`不跟随符号链接：${full}`);
    const childRelative = `${relative}/${child.name}`;
    if (stat.isDirectory()) {
      await contain(realRoot, full, '世界书目录');
      await walkWorldbook(full, childRelative, realRoot, entries);
    } else if (stat.isFile()) {
      await contain(realRoot, full, '世界书文件');
      const item = textEntry(full, await fs.readFile(full));
      entries.push({路径: virtualPath(childRelative), 长度: item.bytes, SHA256: item.SHA256, text: item.text});
    } else {
      fail(`世界书中存在非普通文件：${full}`);
    }
  }
}

// 返回按规范化虚拟路径排序的世界书条目。作者资料不在根参数内，因此不会被收集。
export async function collectWorldbook(project) {
  const projectRoot = await fs.realpath(project);
  const projectStat = await fs.stat(projectRoot);
  if (!projectStat.isDirectory()) fail(`项目根不是目录：${project}`);
  const worldbook = path.join(projectRoot, '世界书');
  const worldbookStat = await lstatOrNull(worldbook);
  if (!worldbookStat?.isDirectory() || worldbookStat.isSymbolicLink()) fail(`世界书缺失、不是目录或是符号链接：${worldbook}`);
  const realWorldbook = await contain(projectRoot, worldbook, '世界书目录');
  const entries = [];
  await walkWorldbook(realWorldbook, '世界书', projectRoot, entries);

  const config = path.join(projectRoot, 'yggdrasill.yaml');
  const configStat = await lstatOrNull(config);
  if (configStat) {
    if (configStat.isSymbolicLink() || !configStat.isFile()) fail(`yggdrasill.yaml 须是普通文件且不得是符号链接：${config}`);
    await contain(projectRoot, config, 'yggdrasill.yaml');
    const item = textEntry(config, await fs.readFile(config));
    entries.push({路径: virtualPath('yggdrasill.yaml'), 长度: item.bytes, SHA256: item.SHA256, text: item.text});
  }

  entries.sort((a, b) => compareCodePoints(a.路径, b.路径));
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].路径 === entries[index].路径) fail(`规范化路径重复：${entries[index].路径}`);
  }
  return entries;
}

function importSpecifiers(source) {
  const found = [];
  const pattern = /(?:\bimport\s+(?:[^;]*?\s+from\s+)?|\bexport\s+[^;]*?\s+from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

// 程序指纹只收运行入口递归导入的本地源码、esbuild 的 node:url 替换件和固定模板。
export async function collectProgram(repo, {entry = '任务/原型/runtime.mjs', templates = PROGRAM_TEMPLATES} = {}) {
  const realRepo = await fs.realpath(repo);
  const files = new Map();

  async function visit(relative, from = null) {
    const normalized = normalizeSourcePath(relative, '程序源路径');
    const full = path.resolve(realRepo, normalized);
    const stat = await lstatOrNull(full);
    if (!stat?.isFile() || stat.isSymbolicLink()) fail(`程序依赖缺失、不是普通文件或是符号链接：${normalized}`);
    const real = await contain(realRepo, full, '程序依赖');
    if (files.has(normalized)) return;
    const buffer = await fs.readFile(real);
    const item = textEntry(real, buffer);
    files.set(normalized, {路径: normalized, 长度: item.bytes, SHA256: item.SHA256, text: item.text});
    for (const specifier of importSpecifiers(item.text)) {
      if (specifier.startsWith('node:') || !specifier.startsWith('.')) continue;
      if (specifier.endsWith('.json')) continue;
      const target = path.resolve(path.dirname(full), specifier);
      const targetRelative = path.relative(realRepo, target).split(path.sep).join('/');
      if (targetRelative.startsWith('../') || path.isAbsolute(targetRelative)) fail(`程序依赖逃出仓库${from ? `（来自 ${from}）` : ''}：${specifier}`);
      await visit(targetRelative, normalized);
    }
  }

  await visit(normalizeSourcePath(entry));
  await visit('任务/原型/node-url-shim.mjs');
  for (const name of templates) await visit(normalizeSourcePath(`templates/${name}.txt`, '模板路径'));

  return [...files.values()].sort((a, b) => compareCodePoints(a.路径, b.路径));
}

export function createManifest({cardId, cardVersion, programVersion, worldbook, program, compatible = []}) {
  if (typeof cardId !== 'string' || !cardId.trim()) fail('卡ID不能为空');
  if (typeof cardVersion !== 'string' || !cardVersion.trim()) fail('卡版本不能为空');
  if (typeof programVersion !== 'string' || !programVersion.trim()) fail('程序版本不能为空');
  if (!Array.isArray(compatible)) fail('兼容程序须为列表');
  return {
    卡ID: cardId,
    卡版本: cardVersion,
    程序版本: programVersion,
    记录格式: RECORD_FORMAT,
    程序指纹: digestEntries(program),
    世界书哈希: digestEntries(worldbook),
    兼容程序: compatible,
    世界书文件: worldbook.map(({text, ...item}) => item),
    程序文件: program.map(({text, ...item}) => item),
    哈希算法: HASH_ALGORITHM,
  };
}
