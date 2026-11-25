// 角色卡打包核心流程：校验卡面与世界书、生成构建清单与 bundle.generated.json，并调用本地 esbuild 打成角色卡 JSON。
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
import {compileWorldbook} from '../core/catalog.mjs';
import {applyCommands} from '../core/commands.mjs';
import {isMap} from '../core/utils.mjs';
import {adaptOpeningCommands} from './opening.mjs';
import {assertProgramMatches, collectProgram, collectWorldbook, createManifest, PROGRAM_TEMPLATES, RUNTIME_ROOT} from './manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, '..');
const ESBUILD = 'esbuild@0.28.2';

export class PackError extends Error {
  constructor(message, {alreadyPrinted = false} = {}) {
    super(message);
    this.name = 'PackError';
    this.alreadyPrinted = alreadyPrinted;
  }
}

const nonEmptyText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new PackError(`卡面字段“${label}”须为非空文本`);
};
const textList = (value, label) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))
    throw new PackError(`卡面字段“${label}”须为无空项的文本列表`);
  if (new Set(value).size !== value.length) throw new PackError(`卡面字段“${label}”不得重复`);
  if (value.includes('玩家')) throw new PackError(`卡面字段“${label}”不能包含“玩家”`);
  return [...value];
};
const commandList = (value, label = '开场命令') => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(command => !isMap(command) || Object.keys(command).length !== 1))
    throw new PackError(`${label}须为单键命令映射的列表`);
  return value;
};
const overlap = (left, right) => left.find(id => right.includes(id)) ?? null;
const PLAN_FIELDS = ['开场白', '开场命令', '可选在场', '必需角色组'];

export async function packCard({
  projectDir,
  faceFile,
  prepareOnly = false,
  compatible = [],
  repo = DEFAULT_REPO,
  adapterDir = HERE,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!projectDir) throw new PackError('缺少项目目录');
  if (!faceFile) throw new PackError('缺少卡面文件');

  let faceRaw;
  try { faceRaw = await fs.readFile(faceFile, 'utf8'); }
  catch (error) { throw new PackError(`无法读取卡面文件 ${faceFile}：${error.message}`); }

  const face = parseYaml(faceRaw);
  if (!isMap(face)) throw new PackError('卡面须为 YAML 映射');
  const required = ['卡ID', '卡版本', '名称', '描述', '开场白'];
  const optional = ['开局', '开场命令', '可选在场', '必需角色组', '按方案'];
  for (const key of required) nonEmptyText(face[key], key);
  for (const key of Object.keys(face)) {
    if (![...required, ...optional].includes(key)) throw new PackError(`卡面含未授权字段：${key}`);
  }
  if (face.开场白.includes('<命令>') || face.开场白.includes('</命令>')) throw new PackError('开场白不得包含 <命令> 块');
  if (!isMap(face.开局)) throw new PackError('当前正常可玩的卡面须提供默认开局映射');
  const topCommands = commandList(face.开场命令);
  const topOptionalPresent = textList(face.可选在场, '可选在场');
  const topRequiredGroups = textList(face.必需角色组, '必需角色组');
  const topConflict = overlap(topOptionalPresent, topRequiredGroups);
  if (topConflict) throw new PackError(`角色组不能同时出现在“可选在场”与“必需角色组”：${topConflict}`);

  const planSpecs = face.按方案 ?? null;
  if (planSpecs !== null && !isMap(planSpecs)) throw new PackError('卡面字段“按方案”须为映射');
  for (const [id, entry] of Object.entries(planSpecs ?? {})) {
    if (!isMap(entry)) throw new PackError(`按方案“${id}”须为映射`);
    for (const key of Object.keys(entry)) {
      if (!PLAN_FIELDS.includes(key)) throw new PackError(`按方案“${id}”含未授权字段：${key}`);
    }
    if (Object.hasOwn(entry, '开场白')) {
      nonEmptyText(entry.开场白, `按方案.${id}.开场白`);
      if (entry.开场白.includes('<命令>') || entry.开场白.includes('</命令>'))
        throw new PackError(`按方案“${id}”的开场白不得包含 <命令> 块`);
    }
    commandList(entry.开场命令, `按方案“${id}”开场命令`);
    const optionalPresent = textList(entry.可选在场, `按方案.${id}.可选在场`);
    const requiredGroups = textList(entry.必需角色组, `按方案.${id}.必需角色组`);
    const conflict = overlap(optionalPresent, requiredGroups);
    if (conflict) throw new PackError(`方案“${id}”的角色组不能同时出现在“可选在场”与“必需角色组”：${conflict}`);
  }

  // 先由清单收集器拒绝符号链接、非法 UTF-8、宿主绝对路径与重叠路径，再进入内容检查。
  const worldbook = await collectWorldbook(projectDir);
  const check = await checkWorldbook(path.join(projectDir, '世界书'));
  if (check.errors.length) {
    for (const item of check.errors) stderr.write(`${item.规则} ${item.文件}：${item.说明}\n`);
    throw new PackError(`世界书检查存在 ${check.errors.length} 处错误`, {alreadyPrinted: true});
  }

  const program = await collectProgram(repo);
  const programVersion = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
  const manifest = createManifest({cardId: face.卡ID, cardVersion: face.卡版本, programVersion, worldbook, program, compatible});

  const files = Object.fromEntries(worldbook.map(item => [item.路径, item.text]));
  const templates = Object.fromEntries(PROGRAM_TEMPLATES.map(name => {
    const item = program.find(entry => entry.路径 === `templates/${name}.txt`);
    if (!item) throw new PackError(`程序依赖缺少模板：templates/${name}.txt`);
    return [name, item.text];
  }));

  // 脚本与正则的 id 取自稳定卡ID，显示名改变时仍保持同一身份；同时写进 bundle 供运行时核对当前卡。
  const idOf = salt => {
    const hex = createHash('sha256').update(`${face.卡ID}/${salt}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const permissionIds = {脚本ID: idOf('script'), 正则ID: idOf('regex')};

  const {protocol} = await loadRouter(path.join(projectDir, '世界书'), {fs, path});
  const {catalog} = await compileWorldbook(path.join(projectDir, '世界书'), {fs, path});
  const groupIds = new Set(catalog.groups.map(group => group.id));
  const planIds = new Set(catalog.openingPlans.map(plan => plan.id));
  const checkGroups = (value, label) => {
    for (const id of value) if (!groupIds.has(id)) throw new PackError(`卡面字段“${label}”含未定义角色组：${id}`);
  };
  checkGroups(topOptionalPresent, '可选在场');
  checkGroups(topRequiredGroups, '必需角色组');

  // 按方案字段未写时继承顶层；冲突在解析后按方案再查一次，避免顶层与方案覆盖拼出同一角色组。
  const planOpenings = Object.create(null);
  for (const [id, entry] of Object.entries(planSpecs ?? {})) {
    if (!planIds.has(id)) throw new PackError(`开局方案不存在：${id}`);
    const resolved = {
      开场白: Object.hasOwn(entry, '开场白') ? entry.开场白 : face.开场白,
      开场命令: Object.hasOwn(entry, '开场命令') ? [...entry.开场命令] : [...topCommands],
      可选在场: Object.hasOwn(entry, '可选在场') ? [...entry.可选在场] : [...topOptionalPresent],
      必需角色组: Object.hasOwn(entry, '必需角色组') ? [...entry.必需角色组] : [...topRequiredGroups],
    };
    checkGroups(resolved.可选在场, `按方案.${id}.可选在场`);
    checkGroups(resolved.必需角色组, `按方案.${id}.必需角色组`);
    const conflict = overlap(resolved.可选在场, resolved.必需角色组);
    if (conflict) throw new PackError(`方案“${id}”的角色组不能同时出现在“可选在场”与“必需角色组”：${conflict}`);
    planOpenings[id] = resolved;
  }

  const bundle = {
    root: `${RUNTIME_ROOT}/世界书`,
    files,
    templates,
    opening: face.开局,
    openingCommands: topCommands,
    openingGreeting: face.开场白,
    openingOptionalPresent: topOptionalPresent,
    openingRequiredGroups: topRequiredGroups,
    planOpenings,
    manifest,
    权限: permissionIds,
  };

  // 构建时对顶层与每个声明方案各执行一次独立开场，提前拦下会失败或改变协议语义的命令。
  // 干跑用封卷后的启用状态适配可选在场，关停的非必选角色不阻断打包。
  const dryRun = (prefix, config, commands, optionalPresent) => {
    let state;
    try { state = seal(protocol, config); }
    catch (error) {
      throw new PackError(`${prefix}封卷失败：${[error?.code, error?.message].filter(Boolean).join(' ')}`.trim());
    }
    const enabledGroups = Object.fromEntries(Object.entries(state.开局?.角色组 ?? {})
      .map(([id, run]) => [id, run?.启用 === true]));
    const opening = applyCommands(protocol, state,
      adaptOpeningCommands(commands, state.开局?.玩家, {enabledGroups, optionalPresent}));
    if (opening.失败.length) {
      for (const item of opening.失败) stderr.write(`${prefix}开场命令 ${item.序号} ${item.命令}：${item.错误码} ${item.说明}\n`);
      throw new PackError(`${prefix}开场命令执行存在 ${opening.失败.length} 处失败`, {alreadyPrinted: true});
    }
  };
  dryRun('', face.开局, topCommands, topOptionalPresent);
  // 方案干跑采用与开局草稿相同的优先级：方案字段覆盖卡面初值，而不是反过来。
  const planConfig = plan => {
    const config = {...face.开局}, source = isMap(plan.内容) ? plan.内容 : {};
    for (const key of ['开局时间', '角色组', '玩家', '历史选择'])
      if (Object.hasOwn(source, key)) config[key] = source[key];
    config.方案 = plan.id;
    return config;
  };
  for (const plan of catalog.openingPlans) {
    const entry = planOpenings[plan.id];
    if (!entry) continue;
    dryRun(`方案“${plan.id}”`, planConfig(plan), entry.开场命令, entry.可选在场);
  }

  // 方案开场白按世界书中的方案顺序导出并去重；与主开场白相同的方案不进入 alternate_greetings。
  const alternateGreetings = [];
  for (const plan of catalog.openingPlans) {
    const entry = planOpenings[plan.id];
    if (entry && entry.开场白 !== face.开场白 && !alternateGreetings.includes(entry.开场白)) alternateGreetings.push(entry.开场白);
  }

  const bundleFile = path.join(adapterDir, 'bundle.generated.json');
  await fs.writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  if (prepareOnly) {
    stdout.write(`bundle.generated.json：${worldbook.length} 个世界书文件，${program.length} 个程序文件；世界书 ${manifest.世界书哈希.slice(0, 12)}…，程序 ${manifest.程序指纹.slice(0, 12)}…；未打包脚本\n`);
    return {prepareOnly: true, bundleFile, cardFile: null, worldbook, program, manifest};
  }

  // 只用本地安装的 esbuild，不在打包时下载。
  const esbuild = path.join(repo, 'node_modules', '.bin', 'esbuild');
  try { await fs.access(esbuild); }
  catch {
    stderr.write(`缺少 esbuild：在 yggdrasill/ 下执行 npm install --save-dev --save-exact ${ESBUILD}\n`);
    throw new PackError(`缺少 esbuild：${ESBUILD}`, {alreadyPrinted: true});
  }

  const dist = path.join(adapterDir, 'dist');
  await fs.mkdir(dist, {recursive: true});
  const out = path.join(dist, 'runtime.js');
  // 读回 esbuild 的 metafile，核对实际打包的本地模块与清单程序集合严格一致。
  const metafileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yggdrasill-metafile-'));
  try {
    const metafile = path.join(metafileDir, 'meta.json');
    const esbuildOut = execFileSync(esbuild, [
      path.join(adapterDir, 'runtime.mjs'), '--bundle', '--format=esm', '--platform=browser',
      `--alias:node:url=${path.join(adapterDir, 'node-url-shim.mjs')}`, '--charset=utf8', '--legal-comments=none',
      `--outfile=${out}`, `--metafile=${metafile}`,
    ], {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    if (esbuildOut) stdout.write(esbuildOut);
    assertProgramMatches(program, JSON.parse(await fs.readFile(metafile, 'utf8')).inputs, {repo, cwd: repo});
  } finally {
    await fs.rm(metafileDir, {recursive: true, force: true});
  }

  // 脚本内容放在 iframe 的 <script type="module"> 中，不能出现 </script。
  const script = (await fs.readFile(out, 'utf8')).replace(/<\/script/gi, '<\\/script');

  const scriptEntry = {
    type: 'script', enabled: true, name: '世界树', id: permissionIds.脚本ID,
    content: script, info: '世界树酒馆适配：每轮路由注入上下文；每次回复后另调一次模型记账（可在“记账设置”中改用别的模型或关闭）。',
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
    creator_notes: '世界树角色卡。需要酒馆助手并允许本卡脚本；关闭记账时还需允许并启用本卡局部正则。', system_prompt: '', post_history_instructions: '',
    alternate_greetings: alternateGreetings, tags: ['世界树'], creator: '', character_version: face.卡版本,
    extensions: {talkativeness: '0.5', fav: false, world: '', depth_prompt: {prompt: '', depth: 4, role: 'system'},
      regex_scripts: [hideCommands], tavern_helper: {scripts: [scriptEntry], variables: {}}},
  };
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    ...Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => [key, data[key]])),
    data,
  };
  const cardFile = path.join(dist, `${face.名称}.json`);
  const cardText = `${JSON.stringify(card, null, 2)}\n`;
  await fs.writeFile(cardFile, cardText);

  // 读回产物，确认卡内脚本携带的清单与本次计算一致，且不含作者资料。
  const written = JSON.parse(await fs.readFile(cardFile, 'utf8'));
  const embeddedScript = written.data?.extensions?.tavern_helper?.scripts?.find(item => item.id === permissionIds.脚本ID);
  const embedded = embeddedScript?.content;
  if (!embedded) throw new PackError('构建失败：卡内缺少世界树脚本');
  if (embeddedScript.enabled !== true) throw new PackError('构建失败：卡内世界树脚本未启用');
  if (written.data.character_version !== face.卡版本 || !embedded.includes(manifest.世界书哈希) || !embedded.includes(manifest.程序指纹) || !embedded.includes(face.卡ID))
    throw new PackError('构建失败：卡内脚本、卡版本、卡ID与构建清单不一致');
  if (compatible.some(fingerprint => !embedded.includes(fingerprint)))
    throw new PackError('构建失败：卡内脚本缺少兼容程序指纹');
  const embeddedRegex = written.data?.extensions?.regex_scripts?.find(item => item.id === permissionIds.正则ID);
  if (!embeddedRegex) throw new PackError('构建失败：卡内缺少世界树局部正则');
  if (embeddedRegex.disabled === true || !Array.isArray(embeddedRegex.placement) || !embeddedRegex.placement.includes(2)
    || embeddedRegex.findRegex !== hideCommands.findRegex)
    throw new PackError('构建失败：卡内局部正则的 ID、启用状态或 placement 与构建清单不一致');
  if (cardText.includes('/作者资料/') || Object.keys(files).some(file => file.startsWith('/项目/作者资料/')))
    throw new PackError('构建失败：作者资料进入正式卡');

  stdout.write(`${worldbook.length} 个世界书文件，${program.length} 个程序文件，脚本 ${(script.length / 1024).toFixed(0)}K 字符\n`);
  stdout.write(`清单：${manifest.卡ID} ${manifest.卡版本} · 世界书 ${manifest.世界书哈希} · 程序 ${manifest.程序指纹}${manifest.兼容程序.length ? ` · 兼容 ${manifest.兼容程序.length} 个旧程序` : ''}\n`);
  stdout.write(`卡 ${cardFile}\n`);
  return {prepareOnly: false, bundleFile, cardFile, worldbook, program, manifest};
}
