// 原型打包：node adapter/build.mjs [项目目录，缺省 examples/雾港] [--face 卡面文件，缺省 卡面.yaml] [--prepare-only] [--compatible <旧程序指纹>]...
// --prepare-only 只生成 bundle.generated.json，不调用 esbuild（供 smoke.mjs 在 node 中直接运行 runtime.mjs）。
// 世界书、程序依赖与卡面先规范化并校验，再由同一份构建清单驱动 bundle 与角色卡。
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkWorldbook} from '../checker/index.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {loadRouter} from '../core/router.mjs';
import {seal} from '../core/protocol.mjs';
import {applyCommands} from '../core/commands.mjs';
import {isMap} from '../core/utils.mjs';
import {assertProgramMatches, collectProgram, collectWorldbook, createManifest, PROGRAM_TEMPLATES, RUNTIME_ROOT} from './manifest.mjs';

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
const project = path.resolve(repo, projectArg ?? 'examples/雾港');
const ESBUILD = 'esbuild@0.28.2';

const nonEmptyText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`卡面字段“${label}”须为非空文本`);
};
const face = parseYaml(await fs.readFile(faceFile, 'utf8'));
if (!isMap(face)) throw new Error('卡面须为 YAML 映射');
const required = ['卡ID', '卡版本', '名称', '描述', '开场白'];
const optional = ['开局', '开场命令'];
for (const key of required) nonEmptyText(face[key], key);
for (const key of Object.keys(face)) if (![...required, ...optional].includes(key)) throw new Error(`卡面含未授权字段：${key}`);
if (face.开场白.includes('<命令>') || face.开场白.includes('</命令>')) throw new Error('开场白不得包含 <命令> 块');
if (!isMap(face.开局)) throw new Error('当前正常可玩的卡面须提供默认开局映射');
if (face.开场命令 !== undefined && (!Array.isArray(face.开场命令) || face.开场命令.some(command => !isMap(command) || Object.keys(command).length !== 1)))
  throw new Error('开场命令须为单键命令映射的列表');

// 先由清单收集器拒绝符号链接、非法 UTF-8、宿主绝对路径与重叠路径，再进入内容检查。
const worldbook = await collectWorldbook(project);
const check = await checkWorldbook(path.join(project, '世界书'));
if (check.errors.length) {
  for (const item of check.errors) console.error(`${item.规则} ${item.文件}：${item.说明}`);
  process.exit(1);
}
const program = await collectProgram(repo);
const programVersion = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
const manifest = createManifest({cardId: face.卡ID, cardVersion: face.卡版本, programVersion, worldbook, program, compatible});

const files = Object.fromEntries(worldbook.map(item => [item.路径, item.text]));
const templates = Object.fromEntries(PROGRAM_TEMPLATES.map(name => {
  const item = program.find(entry => entry.路径 === `templates/${name}.txt`);
  if (!item) throw new Error(`程序依赖缺少模板：templates/${name}.txt`);
  return [name, item.text];
}));
// 脚本与正则的 id 取自稳定卡ID，显示名改变时仍保持同一身份；同时写进 bundle 供运行时核对当前卡。
const idOf = salt => {
  const hex = createHash('sha256').update(`${face.卡ID}/${salt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const permissionIds = {脚本ID: idOf('script'), 正则ID: idOf('regex')};
const bundle = {root: `${RUNTIME_ROOT}/世界书`, files, templates, opening: face.开局, openingCommands: face.开场命令 ?? [], manifest,
  权限: permissionIds};

// 构建时执行一次独立开场，提前拦下会失败或改变协议语义的命令。
const {protocol} = await loadRouter(path.join(project, '世界书'), {fs, path});
const opening = applyCommands(protocol, seal(protocol, face.开局), bundle.openingCommands);
if (opening.失败.length) {
  for (const item of opening.失败) console.error(`开场命令 ${item.序号} ${item.命令}：${item.错误码} ${item.说明}`);
  process.exit(1);
}

const bundleFile = path.join(here, 'bundle.generated.json');
await fs.writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
if (prepareOnly) {
  console.log(`bundle.generated.json：${worldbook.length} 个世界书文件，${program.length} 个程序文件；世界书 ${manifest.世界书哈希.slice(0, 12)}…，程序 ${manifest.程序指纹.slice(0, 12)}…；未打包脚本`);
  process.exit(0);
}

// 只用本地安装的 esbuild，不在打包时下载。
const esbuild = path.join(repo, 'node_modules', '.bin', 'esbuild');
try { await fs.access(esbuild); }
catch {
  console.error(`缺少 esbuild：在 yggdrasill/ 下执行 npm install --save-dev --save-exact ${ESBUILD}`);
  process.exit(1);
}
const dist = path.join(here, 'dist');
await fs.mkdir(dist, {recursive: true});
const out = path.join(dist, 'runtime.js');
// 读回 esbuild 的 metafile，核对实际打包的本地模块与清单程序集合严格一致。
const metafileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yggdrasill-metafile-'));
try {
  const metafile = path.join(metafileDir, 'meta.json');
  execFileSync(esbuild, [path.join(here, 'runtime.mjs'), '--bundle', '--format=esm', '--platform=browser',
    `--alias:node:url=${path.join(here, 'node-url-shim.mjs')}`, '--charset=utf8', '--legal-comments=none',
    `--outfile=${out}`, `--metafile=${metafile}`], {stdio: 'inherit', cwd: repo});
  assertProgramMatches(program, JSON.parse(await fs.readFile(metafile, 'utf8')).inputs, {repo, cwd: repo});
} finally {
  await fs.rm(metafileDir, {recursive: true, force: true});
}
// 脚本内容放在 iframe 的 <script type="module"> 中，不能出现 </script。
const script = (await fs.readFile(out, 'utf8')).replace(/<\/script/gi, '<\\/script');

const scriptEntry = {
  type: 'script', enabled: true, name: '世界树原型', id: permissionIds.脚本ID,
  content: script, info: '世界树酒馆适配的一次性原型：每轮路由注入上下文；每次回复后另调一次模型记账（可在“记账设置”中改用别的模型或关闭）。',
  button: {enabled: true, buttons: ['开局', '本局', '重新记账', '设置', '本轮上下文']
    .map(name => ({name: `世界树：${name}`, visible: true}))},
  data: {}, export_with: {data: true, button: true},
};
const hideCommands = {
  id: permissionIds.正则ID, scriptName: '世界树：隐藏命令', findRegex: '/<命令>[\\s\\S]*?<\\/命令>/g',
  replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
  runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
};
const data = {
  name: face.名称, description: face.描述, personality: '', scenario: '', first_mes: face.开场白, mes_example: '',
  creator_notes: '世界树原型卡。需要酒馆助手并允许本卡脚本；关闭记账时还需允许并启用本卡局部正则。', system_prompt: '', post_history_instructions: '',
  alternate_greetings: [], tags: ['世界树'], creator: '', character_version: face.卡版本,
  extensions: {talkativeness: '0.5', fav: false, world: '', depth_prompt: {prompt: '', depth: 4, role: 'system'},
    regex_scripts: [hideCommands], tavern_helper: {scripts: [scriptEntry], variables: {}}},
};
const card = {spec: 'chara_card_v2', spec_version: '2.0', ...Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => [key, data[key]])), data};
const cardFile = path.join(dist, `${face.名称}.json`);
const cardText = `${JSON.stringify(card, null, 2)}\n`;
await fs.writeFile(cardFile, cardText);

// 读回产物，确认卡内脚本携带的清单与本次计算一致，且不含作者资料。
const written = JSON.parse(await fs.readFile(cardFile, 'utf8'));
const embeddedScript = written.data?.extensions?.tavern_helper?.scripts?.find(item => item.id === permissionIds.脚本ID);
const embedded = embeddedScript?.content;
if (!embedded) throw new Error('构建失败：卡内缺少世界树脚本');
if (embeddedScript.enabled !== true) throw new Error('构建失败：卡内世界树脚本未启用');
if (written.data.character_version !== face.卡版本 || !embedded.includes(manifest.世界书哈希) || !embedded.includes(manifest.程序指纹) || !embedded.includes(face.卡ID))
  throw new Error('构建失败：卡内脚本、卡版本、卡ID与构建清单不一致');
if (compatible.some(fingerprint => !embedded.includes(fingerprint)))
  throw new Error('构建失败：卡内脚本缺少兼容程序指纹');
const embeddedRegex = written.data?.extensions?.regex_scripts?.find(item => item.id === permissionIds.正则ID);
if (!embeddedRegex) throw new Error('构建失败：卡内缺少世界树局部正则');
if (embeddedRegex.disabled === true || !Array.isArray(embeddedRegex.placement) || !embeddedRegex.placement.includes(2)
  || embeddedRegex.findRegex !== hideCommands.findRegex)
  throw new Error('构建失败：卡内局部正则的 ID、启用状态或 placement 与构建清单不一致');
if (cardText.includes('/作者资料/') || Object.keys(files).some(file => file.startsWith('/项目/作者资料/')))
  throw new Error('构建失败：作者资料进入正式卡');

console.log(`${worldbook.length} 个世界书文件，${program.length} 个程序文件，脚本 ${(script.length / 1024).toFixed(0)}K 字符`);
console.log(`清单：${manifest.卡ID} ${manifest.卡版本} · 世界书 ${manifest.世界书哈希} · 程序 ${manifest.程序指纹}${manifest.兼容程序.length ? ` · 兼容 ${manifest.兼容程序.length} 个旧程序` : ''}`);
console.log(`卡 ${cardFile}`);
