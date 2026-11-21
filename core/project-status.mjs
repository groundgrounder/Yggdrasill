import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {checkWorldbook} from '../checker/index.mjs';
import {compileWorldbook} from './catalog.mjs';
import {parseYaml} from './yaml.mjs';
import {summarizeQuotes} from './tree-export.mjs';
import {has, list} from './utils.mjs';

export class StatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
  }
}

const LEDGER_FILES = ['世界体系汇总.yaml', '人物总名单与分期方案.yaml', '全书年表与因果事件表.yaml',
  'if分岔与开局提案.yaml', '待作者拍板清单.md'];
const DECLARATION_FILES = ['纪年', '等级', '能力', '事件分类', '条目库', '本局变量', '剧情标记', '角色分类', '文本规范'];
const REQUIRED_DECLARATIONS = ['纪年', '事件分类', '本局变量'];
const STAGE_SKILLS = ['世界树·通读', '世界树·地基', '世界树·条目', '世界树·骨架', '世界树·档案', '世界树·填景', '世界树·打包'];

export async function inspectProjectStatus(target, {fs = defaultFs, path = defaultPath} = {}) {
  let stats;
  try { stats = await fs.stat(target); }
  catch { throw new StatusError('状态.路径', `路径不存在或不可读：${target}`); }
  if (typeof stats?.isDirectory !== 'function' || !stats.isDirectory())
    throw new StatusError('状态.路径', `目标不是目录：${target}`);

  const exists = async file => {
    try { await fs.stat(file); return true; } catch { return false; }
  };
  const isDirectory = async file => {
    try { return (await fs.stat(file)).isDirectory(); } catch { return false; }
  };
  const countFiles = async directory => {
    let children;
    try { children = await fs.readdir(directory, {withFileTypes: true}); }
    catch { return 0; }
    let count = 0;
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      if (child.isDirectory()) count += await countFiles(path.join(directory, child.name));
      else if (child.isFile()) count++;
    }
    return count;
  };
  const countTxt = async directory => {
    let children;
    try { children = await fs.readdir(directory, {withFileTypes: true}); }
    catch { return 0; }
    let count = 0;
    for (const child of children) {
      if (child.name.startsWith('.') || !child.isFile()) continue;
      if (path.extname(child.name) === '.txt') count++;
    }
    return count;
  };

  const basename = path.basename(target);
  const hasSettings = await isDirectory(path.join(target, '设定'));
  const hasWorldbookChild = await isDirectory(path.join(target, '世界书'));
  const asWorldbook = basename === '世界书' || (hasSettings && !hasWorldbookChild);
  const projectRoot = asWorldbook ? path.dirname(target) : target;
  const worldbookRoot = asWorldbook ? target : path.join(target, '世界书');

  // 第 0 层（通读）：只读盘点，不改动任何文件。
  const sourceCount = await countFiles(path.join(projectRoot, '来源资料'));
  const readRoot = path.join(projectRoot, '作者资料', '通读');
  const volumeCount = await countFiles(path.join(readRoot, '分卷'));
  const lexicon = await exists(path.join(readRoot, '活词表.yaml'));
  const ledgers = {};
  for (const name of LEDGER_FILES) ledgers[name] = await exists(path.join(readRoot, name));
  const layer0 = {来源资料文件数: sourceCount, 通读分卷文件数: volumeCount, 活词表: lexicon, 全局总账: ledgers};
  const allFiveLedgers = Object.values(ledgers).every(Boolean);
  layer0.完成 = allFiveLedgers && (sourceCount === 0 || (volumeCount > 0 && lexicon));

  // 第 1 层（地基）：必需声明、已建声明清单、全局文本与运行参数。
  const settingsDir = path.join(worldbookRoot, '设定');
  const declared = {};
  for (const name of DECLARATION_FILES) declared[name] = await exists(path.join(settingsDir, `${name}.yaml`));
  const overviewCount = await countTxt(path.join(worldbookRoot, '世界概况'));
  const conductCount = await countTxt(path.join(worldbookRoot, '扮演准则'));
  const settingsFile = await exists(path.join(projectRoot, 'yggdrasill.yaml'));
  const layer1 = {声明文件: declared, 世界概况文件数: overviewCount, 扮演准则文件数: conductCount, 运行参数文件: settingsFile};
  layer1.完成 = REQUIRED_DECLARATIONS.every(name => declared[name]) && overviewCount > 0 && conductCount > 0;

  // 目录与计数：能编译就复用同一份目录；不能编译时保持只读降级，不崩溃。
  let catalog = null, staticCheck = null;
  if (await exists(path.join(settingsDir, '纪年.yaml'))) {
    try { ({catalog} = await compileWorldbook(worldbookRoot, {fs, path})); }
    catch { catalog = null; }
    try {
      const checked = await checkWorldbook(worldbookRoot, {sampling: false, fs, path});
      staticCheck = {错误: checked.errors.length, 提示: checked.hints.length};
    } catch { staticCheck = {错误: null, 提示: null, 说明: '静态检查未能完成'}; }
  } else staticCheck = {错误: null, 提示: null, 说明: '跳过：缺少 世界书/设定/纪年.yaml'};

  let libraries = {};
  if (await exists(path.join(settingsDir, '条目库.yaml'))) {
    try { libraries = parseYaml(await fs.readFile(path.join(settingsDir, '条目库.yaml'), 'utf8')) ?? {}; }
    catch { libraries = {解析失败: null}; }
  }
  const libraryCounts = {};
  for (const name of Object.keys(libraries)) libraryCounts[name] = list(catalog?.entries?.[name]).length;
  const layer2 = {已声明条目库: Object.keys(libraries), 各库条目数: libraryCounts};
  layer2.完成 = Object.keys(libraries).length > 0 && !has(libraries, '解析失败')
    && Object.values(libraryCounts).every(count => count > 0);

  const groups = list(catalog?.groups), events = list(catalog?.events), chains = list(catalog?.chains);
  const worldbookStarted = Object.values(declared).some(Boolean) || overviewCount > 0 || conductCount > 0
    || groups.length > 0 || events.length > 0;
  layer0.已跳过 = !layer0.完成 && worldbookStarted;
  const profiles = groups.reduce((sum, group) => sum + group.档案.length, 0);
  const options = list(catalog?.openingOptions?.内容?.选项).length, plans = list(catalog?.openingPlans).length;
  const layer3 = {角色组: groups.length, 档案: profiles, 事件: events.length, 事件串: chains.length,
    开局选项: options, 开局方案: plans};
  layer3.完成 = groups.length > 0 && profiles >= groups.length && events.length > 0 && chains.length > 0
    && (options > 0 || plans > 0) && staticCheck.错误 === 0;

  // 第 4 层（档案与填景）：角色位置与纯静态台词统计，暂存/候选只数文件。
  const positions = events.reduce((sum, event) => sum + list(event.角色位置).length, 0);
  const quotes = catalog ? summarizeQuotes(catalog).总计 : null;
  const stagingCount = await countFiles(path.join(projectRoot, '作者资料', '暂存'));
  const candidateCount = await countFiles(path.join(projectRoot, '作者资料', '候选'));
  const layer4 = {角色位置数: positions, 台词统计: quotes, 暂存文件数: stagingCount, 候选文件数: candidateCount};
  layer4.完成 = positions > 0 && quotes !== null && quotes.缺台词角色位置数 === 0;

  // 第 5 层（打包）：优先项目根含 卡ID 或名为 卡面.yaml 的非隐藏 .yaml。
  const faces = [];
  let rootChildren;
  try { rootChildren = await fs.readdir(projectRoot, {withFileTypes: true}); }
  catch { rootChildren = []; }
  for (const child of rootChildren.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (child.name.startsWith('.') || !child.isFile() || path.extname(child.name) !== '.yaml') continue;
    if (child.name === '卡面.yaml') { faces.push(child.name); continue; }
    try { if ((await fs.readFile(path.join(projectRoot, child.name), 'utf8')).includes('卡ID')) faces.push(child.name); }
    catch { /* 不可读的候选卡面只跳过 */ }
  }
  const layer5 = {卡面文件: faces};
  layer5.完成 = faces.length > 0;

  const layers = [layer0, layer1, layer2, layer3, layer4, layer5];
  const startLayer = layer0.已跳过 ? 1 : 0;
  const first = layers.findIndex((layer, index) => index >= startLayer && !layer.完成);
  const 当前阶段 = first < 0 ? '第 5 层：已完成'
    : first === 0 ? (sourceCount === 0 && volumeCount === 0 ? '第 0 层：未备料' : '第 0 层：通读中')
      : ['第 1 层：待建地基', '第 2 层：待建条目', '第 3 层：待建骨架', '第 4 层：档案与填景待补', '第 5 层：可打包'][first - 1];
  const 推荐skill = first < 0 ? '世界树·修订'
    : first === 4 ? (groups.length === 0 || profiles < groups.length ? '世界树·档案' : '世界树·填景')
      : STAGE_SKILLS[first];

  const 缺口 = [];
  if (!layer0.完成 && !layer0.已跳过) {
    if (volumeCount === 0) 缺口.push('作者资料/通读/分卷/ 没有分卷账本');
    if (!lexicon) 缺口.push('缺少 作者资料/通读/活词表.yaml');
    for (const [name, present] of Object.entries(ledgers)) if (!present) 缺口.push(`缺少 作者资料/通读/${name}`);
  }
  if (!layer1.完成) {
    for (const name of REQUIRED_DECLARATIONS) if (!declared[name]) 缺口.push(`缺少 世界书/设定/${name}.yaml`);
    if (overviewCount === 0) 缺口.push('世界书/世界概况/ 没有 .txt 文件');
    if (conductCount === 0) 缺口.push('世界书/扮演准则/ 没有 .txt 文件');
  }
  if (!layer2.完成) {
    if (!Object.keys(libraries).length) 缺口.push('缺少 世界书/设定/条目库.yaml');
    else if (has(libraries, '解析失败')) 缺口.push('世界书/设定/条目库.yaml 不是合法 YAML');
    else for (const [name, count] of Object.entries(libraryCounts)) if (count === 0) 缺口.push(`条目库 ${name} 为空`);
  }
  if (!layer3.完成) {
    if (groups.length === 0) 缺口.push('世界书/角色/ 没有角色组');
    if (profiles < groups.length) 缺口.push(`档案数 ${profiles} 少于角色组数 ${groups.length}`);
    if (events.length === 0) 缺口.push('世界书/历史/事件/ 没有事件');
    if (chains.length === 0) 缺口.push('世界书/历史/事件串/ 没有事件串');
    if (options === 0 && plans === 0) 缺口.push('没有开局选项或开局方案');
    if (staticCheck.错误 !== null && staticCheck.错误 > 0)
      缺口.push(`静态检查有 ${staticCheck.错误} 个错误、${staticCheck.提示 ?? 0} 个提示`);
  }
  if (!layer4.完成) {
    if (positions === 0) 缺口.push('事件没有角色位置');
    if (quotes === null) 缺口.push('目录不可编译，无法统计台词');
    else if (quotes.缺台词角色位置数 > 0) 缺口.push(`有 ${quotes.缺台词角色位置数} 个角色位置缺候选台词`);
  }
  if (!layer5.完成) 缺口.push('项目根没有含 卡ID 或名为 卡面.yaml 的卡面文件');

  return {
    项目: {目录: projectRoot, 世界书: worldbookRoot, 识别: asWorldbook ? '世界书目录' : '项目目录'},
    各层: {第0层: layer0, 第1层: layer1, 第2层: layer2, 第3层: layer3, 第4层: layer4, 第5层: layer5},
    计数: {来源资料文件: sourceCount, 通读分卷文件: volumeCount, 声明文件: Object.values(declared).filter(Boolean).length,
      世界概况文件: overviewCount, 扮演准则文件: conductCount, 条目库: Object.keys(libraries).length,
      角色组: groups.length, 档案: profiles, 事件: events.length, 事件串: chains.length,
      开局选项: options, 开局方案: plans, 角色位置: positions,
      暂存文件: stagingCount, 候选文件: candidateCount, 卡面文件: faces.length},
    台词统计: quotes,
    静态检查: staticCheck,
    当前阶段,
    缺口,
    推荐skill,
    异常: [],
  };
}
