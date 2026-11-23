#!/usr/bin/env node
import defaultPath from 'node:path';
import {fileURLToPath} from 'node:url';
import {packCard, PackError} from '../adapter/pack.mjs';

export const USAGE = '用法：ygg pack [项目目录] [--face <卡面文件>] [--prepare-only] [--compatible <64位指纹>]...\n'
  + '      项目目录与 --face 均相对当前工作目录解析；省略项目目录时取当前目录，--face 缺省为 <项目目录>/卡面.yaml。\n'
  + '      --prepare-only 只生成 adapter/bundle.generated.json，不调用 esbuild 打包角色卡。';

export function parsePackArgs(args) {
  if (!Array.isArray(args)) throw argumentError('pack 参数须为列表');
  const options = {project: null, face: null, prepareOnly: false, compatible: [], help: false};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (value === '--prepare-only') { options.prepareOnly = true; continue; }
    if (value === '--face') {
      if (options.face !== null) throw argumentError('--face 只能给出一次');
      const next = args[++index];
      if (typeof next !== 'string' || !next.length || next.startsWith('-')) throw argumentError('--face 后须提供卡面文件');
      options.face = next;
      continue;
    }
    if (value === '--compatible') {
      const fingerprint = args[++index];
      if (typeof fingerprint !== 'string' || fingerprint.startsWith('-') || !/^[0-9a-f]{64}$/.test(fingerprint))
        throw argumentError('--compatible 后须提供 64 位小写十六进制程序指纹');
      if (!options.compatible.includes(fingerprint)) options.compatible.push(fingerprint);
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    if (options.project !== null) throw argumentError(`多余的项目目录：${value}`);
    options.project = value;
  }
  return options;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = 'pack.参数';
  return error;
}

export async function runPack(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  path: pathImpl = defaultPath} = {}) {
  let options;
  try { options = parsePackArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? 'pack.参数'}：${error.message}\n`);
    return 1;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }

  const projectDir = pathImpl.resolve(cwd, options.project ?? '.');
  const faceFile = options.face ? pathImpl.resolve(cwd, options.face) : pathImpl.join(projectDir, '卡面.yaml');
  const adapterDir = defaultPath.dirname(fileURLToPath(new URL('../adapter/pack.mjs', import.meta.url)));
  const repo = defaultPath.resolve(adapterDir, '..');

  try {
    await packCard({
      projectDir,
      faceFile,
      prepareOnly: options.prepareOnly,
      compatible: options.compatible,
      repo,
      adapterDir,
      stdout,
      stderr,
    });
    return 0;
  } catch (error) {
    if (!(error instanceof PackError && error.alreadyPrinted)) {
      stderr.write(`错误 pack.失败：${error?.message ?? String(error)}\n`);
    }
    return 1;
  }
}
