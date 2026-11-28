#!/usr/bin/env node
// 作者视图命令：只解析参数并启动本地服务；读写边界在 view/server.mjs 与 view/store.mjs。
import {createHash} from 'node:crypto';
import defaultFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertStorage} from '../view/store.mjs';
import {startViewServer} from '../view/server.mjs';

const USAGE = '用法：ygg view [<世界书目录或角色卡文件> | --worldbook <世界书目录> | --card <角色卡文件>] [--storage <审阅存储目录>] [--port <端口>]\n'
  + '      --port 缺省 4317；0 表示自动选择空闲端口；只监听 127.0.0.1。\n'
  + '      目录模式缺省存储为 <世界书父目录>/作者资料/审阅器；若默认落入实现仓库内，则自动回退到系统临时目录。\n'
  + '      传入世界树成品卡（JSON/PNG）或 --card 时以纯内存只读模式启动，不写入磁盘，不支持 --storage。';

const READONLY_STORAGE_ERROR = '只读成品卡模式不写入磁盘，不支持 `--storage`；如需本地批注与编辑请先用 `ygg unpack` 解包';

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

async function realOrSelf(fsImpl, target) {
  try { return await fsImpl.realpath(target); }
  catch { return null; }
}

async function resolveExistingAncestor(fsImpl, target) {
  const resolved = path.resolve(target);
  const direct = await realOrSelf(fsImpl, resolved);
  if (direct) return direct;
  let ancestor = path.dirname(resolved);
  for (;;) {
    const realAncestor = await realOrSelf(fsImpl, ancestor);
    if (realAncestor) return path.join(realAncestor, path.relative(ancestor, resolved));
    const next = path.dirname(ancestor);
    if (next === ancestor) return resolved;
    ancestor = next;
  }
}

export function parseViewArgs(args) {
  const options = {worldbook: null, storage: null, port: 4317, help: false};
  let flagWorldbook = null;
  let flagCard = null;
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (['--worldbook', '--card', '--storage', '--port'].includes(value)) {
      const next = args[++index];
      if (typeof next !== 'string' || !next.length || next.startsWith('-')) throw argumentError(`${value} 缺少值`);
      if (value === '--worldbook') {
        if (flagWorldbook !== null) throw argumentError('--worldbook 只能给出一次');
        flagWorldbook = next;
      }
      else if (value === '--card') {
        if (flagCard !== null) throw argumentError('--card 只能给出一次');
        flagCard = next;
      }
      else if (value === '--storage') {
        if (options.storage !== null) throw argumentError('--storage 只能给出一次');
        options.storage = next;
      }
      else {
        if (!/^\d+$/.test(next)) throw argumentError('端口须为 0 至 65535 的整数');
        options.port = Number(next);
      }
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    positionals.push(value);
  }
  if (positionals.length > 1) throw argumentError(`多余位置参数：${positionals.slice(1).join(' ')}`);
  if (positionals.length && flagWorldbook !== null) throw argumentError('不能同时传入位置参数与 --worldbook');
  if (positionals.length && flagCard !== null) throw argumentError('不能同时传入位置参数与 --card');
  if (flagWorldbook !== null && flagCard !== null) throw argumentError('不能同时传入 --worldbook 与 --card');
  if (!options.help && flagCard !== null && options.storage !== null) throw argumentError(READONLY_STORAGE_ERROR);
  options.worldbook = flagWorldbook ?? positionals[0] ?? null;
  if (!options.help && !options.worldbook && flagCard === null)
    throw argumentError('缺少世界书目录或角色卡文件（请传入 <世界书目录或角色卡文件>、--worldbook 或 --card）');
  if (options.port < 0 || options.port > 65535 || !Number.isInteger(options.port))
    throw argumentError('端口须为 0 至 65535 的整数');
  const targetKind = flagCard !== null ? 'card' : flagWorldbook !== null ? 'worldbook' : (positionals.length ? 'auto' : null);
  if (flagCard !== null) {
    options.card = flagCard;
  } else {
    Object.defineProperty(options, 'card', {value: null, enumerable: false, configurable: true});
  }
  Object.defineProperty(options, 'targetKind', {value: targetKind, enumerable: false, configurable: true});
  return options;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'view.参数';
  return error;
}

export async function runView(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs: fsImpl = defaultFs} = {}) {
  let options;
  try { options = parseViewArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? 'view.参数'}：${error.message}\n`);
    return 1;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }

  let mode = options.targetKind === 'card' ? 'card' : 'directory';
  let targetPath = path.resolve(cwd, options.card ?? options.worldbook);

  if (options.targetKind === 'auto') {
    let targetStat = null;
    try { targetStat = await fsImpl.stat(targetPath); }
    catch { targetStat = null; }
    if (targetStat?.isFile()) {
      mode = 'card';
      if (options.storage !== null) {
        stderr.write(`${USAGE}\n错误 view.参数：${READONLY_STORAGE_ERROR}\n`);
        return 1;
      }
    }
  }

  if (mode === 'card') {
    let app;
    try {
      app = await startViewServer({card: targetPath, port: options.port, fs: fsImpl});
    }
    catch (error) {
      stderr.write(`错误 view.启动失败：${error.message}\n`);
      return 1;
    }
    const info = app.cardInfo;
    const lines = [
      `世界树作者视图已启动：${app.url}`,
      '模式：只读成品卡',
      `来源：${info.名称} ${info.卡版本}（${String(app.format ?? '').toUpperCase()}）`,
      `卡ID：${info.卡ID} · 世界书哈希：${info.世界书哈希.slice(0, 12)}…`,
      '提示：只读浏览模式，不写入磁盘；如需修改请先运行 `ygg unpack` 解包',
      '按 Ctrl+C 停止。',
    ];
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  const worldbook = targetPath;
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const realRepo = (await realOrSelf(fsImpl, repoRoot)) ?? repoRoot;

  let storage;
  let usingTempStorage = false;
  if (options.storage) {
    storage = path.resolve(cwd, options.storage);
  } else {
    const defaultStorage = path.join(path.dirname(worldbook), '作者资料', '审阅器');
    const realWorldbook = (await realOrSelf(fsImpl, worldbook)) ?? worldbook;
    const realDefaultStorage = await resolveExistingAncestor(fsImpl, defaultStorage);
    if (isInside(repoRoot, worldbook) || isInside(realRepo, realWorldbook)
      || isInside(repoRoot, defaultStorage) || isInside(realRepo, realDefaultStorage)) {
      const hashPrefix = createHash('sha256').update(realWorldbook).digest('hex').slice(0, 12);
      storage = path.join(os.tmpdir(), 'yggdrasill-view', hashPrefix);
      usingTempStorage = true;
    } else {
      storage = defaultStorage;
    }
  }

  let app;
  try {
    await assertStorage({worldbook, storage, repoRoot});
    app = await startViewServer({worldbook, storage, port: options.port, repoRoot});
  }
  catch (error) {
    stderr.write(`错误 view.启动失败：${error.message}\n`);
    return 1;
  }
  const lines = [
    `世界树作者视图已启动：${app.url}`,
    `世界书：${app.worldbook}`,
    `存储：${app.storage}`,
    ...(usingTempStorage ? ['提示：临时审阅目录（仓库内示例不写入仓库）'] : []),
    '按 Ctrl+C 停止。',
  ];
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runView(process.argv.slice(2));
