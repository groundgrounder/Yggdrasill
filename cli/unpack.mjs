#!/usr/bin/env node
// 世界树成品卡解包命令：将世界树打包的 JSON 或 PNG 角色卡静态还原为本地可编辑、可重打的项目目录。
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {fileURLToPath} from 'node:url';
import {unpackCard, UnpackError} from '../adapter/unpack.mjs';

export const USAGE = '用法：ygg unpack <角色卡文件> -o <输出目录> [--force] [--json]\n'
  + '      支持世界树打包的角色卡 JSON 或酒馆导出的 PNG（优先 ccv3，回退 chara）。\n'
  + '      -o, --out <目录>   必填，指定解包输出目录\n'
  + '      -f, --force        输出目录非空时仅安全清理 世界书/ 与 外观/ 并覆写还原文件（保留无关文件）\n'
  + '      --json             输出结构化 JSON 摘要\n'
  + '      -h, --help         显示本帮助信息';

function argumentError(message) {
  const error = new Error(message);
  error.code = 'unpack.参数';
  return error;
}

function failureResult(card, out, error) {
  return {
    来源: card ?? null,
    格式: null,
    卡信息: null,
    输出目录: out ?? null,
    世界书文件数: 0,
    含运行参数: false,
    主题数: 0,
    已提取封面: false,
    世界书哈希: null,
    已写入文件: [],
    异常: [{
      规则: error?.code ?? 'unpack.失败',
      级别: '错误',
      文件: card ?? 'unpack',
      说明: error?.message ?? String(error),
    }],
  };
}

export function parseUnpackArgs(args) {
  if (!Array.isArray(args)) throw argumentError('unpack 参数须为列表');
  const options = {card: null, out: null, force: false, json: false, help: false};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (value === '--force' || value === '-f') { options.force = true; continue; }
    if (value === '--json') { options.json = true; continue; }
    if (value === '-o' || value === '--out') {
      if (options.out !== null) throw argumentError('-o / --out 只能给出一次');
      const next = args[++index];
      if (typeof next !== 'string' || !next.length || next.startsWith('-')) {
        throw argumentError(`${value} 后须提供输出目录`);
      }
      options.out = next;
      continue;
    }
    if (value.startsWith('--out=')) {
      if (options.out !== null) throw argumentError('-o / --out 只能给出一次');
      const next = value.slice('--out='.length);
      if (!next.length || next.startsWith('-')) throw argumentError('--out 后须提供输出目录');
      options.out = next;
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    if (options.card !== null) throw argumentError(`多余的位置参数：${value}`);
    options.card = value;
  }
  if (!options.help) {
    if (!options.card) throw argumentError('缺少角色卡文件');
    if (!options.out) throw argumentError('缺少输出目录（请通过 -o 或 --out 指定）');
  }
  return options;
}

export async function runUnpack(args, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  fs = defaultFs,
  path: pathImpl = defaultPath,
} = {}) {
  let options;
  try {
    options = parseUnpackArgs(args);
  } catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? 'unpack.参数'}：${error.message}\n`);
    if (Array.isArray(args) && args.includes('--json')) {
      stdout.write(`${JSON.stringify(failureResult(null, null, error), null, 2)}\n`);
    }
    return 1;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cardFile = pathImpl.resolve(cwd, options.card);
  const outDir = pathImpl.resolve(cwd, options.out);
  try {
    const result = await unpackCard(cardFile, outDir, {force: options.force, fs, path: pathImpl});
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const info = result.卡信息;
      const lines = [
        `解包完成：${info.名称}（${info.卡ID} ${info.卡版本}）`,
        `来源格式：${result.格式.toUpperCase()} · 世界书文件 ${result.世界书文件数} 份 · yggdrasill.yaml：${result.含运行参数 ? '有' : '无'}`,
        `外观主题：${result.主题数} 套 · 封面.png：${result.已提取封面 ? '已提取' : '无'}`,
        `已核验世界书哈希：${result.世界书哈希.slice(0, 12)}…`,
        `输出目录：${result.输出目录}`,
      ];
      stdout.write(`${lines.join('\n')}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof UnpackError ? error.code : 'unpack.失败';
    const message = error?.message ?? String(error);
    stderr.write(`错误 ${code}：${message}\n`);
    if (options.json) {
      stdout.write(`${JSON.stringify(failureResult(cardFile, outDir, new UnpackError(code, message)), null, 2)}\n`);
    }
    return 1;
  }
}

if (process.argv[1] && defaultPath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runUnpack(process.argv.slice(2));
}
