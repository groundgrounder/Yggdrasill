// 角色卡打包：node adapter/build.mjs [项目目录，缺省 test/fixtures/雾港] [--face 卡面文件，缺省 卡面.yaml] [--prepare-only] [--compatible <旧程序指纹>]...
// --prepare-only 只生成 bundle.generated.json，不调用 esbuild（供 smoke.mjs 在 node 中直接运行 runtime.mjs）。
// 世界书、程序依赖与卡面先规范化并校验，再由同一份构建清单驱动 bundle 与角色卡。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packCard, PackError} from './pack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
let projectArg = null, faceArg = '卡面.yaml', prepareOnly = false;
const compatible = [];
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (value === '--prepare-only') prepareOnly = true;
  else if (value === '--face') {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--face 后须提供卡面文件');
    faceArg = args[++index];
  } else if (value === '--compatible') {
    const fingerprint = args[++index];
    if (!fingerprint || fingerprint.startsWith('--') || !/^[0-9a-f]{64}$/.test(fingerprint))
      throw new Error('--compatible 后须提供 64 位小写十六进制程序指纹');
    if (!compatible.includes(fingerprint)) compatible.push(fingerprint);
  } else if (value.startsWith('--')) throw new Error(`未知参数：${value}`);
  else if (projectArg !== null) throw new Error(`多余的项目目录：${value}`);
  else projectArg = value;
}

const faceFile = path.resolve(here, faceArg);
const projectDir = path.resolve(repo, projectArg ?? 'test/fixtures/雾港');

try {
  await packCard({projectDir, faceFile, prepareOnly, compatible, repo, adapterDir: here});
} catch (error) {
  if (!(error instanceof PackError && error.alreadyPrinted)) console.error(error?.message ?? String(error));
  process.exit(1);
}
