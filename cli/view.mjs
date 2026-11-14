#!/usr/bin/env node
// 作者视图命令：只解析参数并启动本地服务；读写边界在 view/server.mjs 与 view/store.mjs。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertStorage, ViewError} from '../view/store.mjs';
import {startViewServer} from '../view/server.mjs';

const USAGE = '用法：ygg view --worldbook <世界书目录> [--storage <审阅存储目录>] [--port <端口>]\n'
  + '      --port 缺省 4317；0 表示自动选择空闲端口；只监听 127.0.0.1。\n'
  + '      缺省存储为 <世界书父目录>/作者资料/审阅器，且必须在实现仓库与世界书之外。';

export function parseViewArgs(args) {
  const options = {worldbook: null, storage: null, port: 4317, help: false};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (['--worldbook', '--storage', '--port'].includes(value)) {
      const next = args[++index];
      if (typeof next !== 'string' || !next.length || next.startsWith('-')) throw argumentError(`${value} 缺少值`);
      if (value === '--worldbook') {
        if (options.worldbook !== null) throw argumentError('--worldbook 只能给出一次');
        options.worldbook = next;
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
  if (positionals.length) throw argumentError(`多余位置参数：${positionals.join(' ')}`);
  if (!options.help && !options.worldbook) throw argumentError('缺少 --worldbook');
  if (options.port < 0 || options.port > 65535 || !Number.isInteger(options.port))
    throw argumentError('端口须为 0 至 65535 的整数');
  return options;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'view.参数';
  return error;
}

export async function runView(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr} = {}) {
  let options;
  try { options = parseViewArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? 'view.参数'}：${error.message}\n`);
    return 1;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
  const worldbook = path.resolve(cwd, options.worldbook);
  const storage = options.storage
    ? path.resolve(cwd, options.storage)
    : path.join(path.dirname(worldbook), '作者资料', '审阅器');
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  let app;
  try {
    await assertStorage({worldbook, storage, repoRoot});
    app = await startViewServer({worldbook, storage, port: options.port, repoRoot});
  }
  catch (error) {
    stderr.write(`错误 view.启动失败：${error.message}\n`);
    return 1;
  }
  stdout.write(`世界树作者视图已启动：${app.url}\n世界书：${app.worldbook}\n存储：${app.storage}\n按 Ctrl+C 停止。\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runView(process.argv.slice(2));
