import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileWorldbook} from './catalog.mjs';
import {createProtocol} from './protocol.mjs';
import {timelineEnd} from './what-if.mjs';
import {readSettings} from './settings.mjs';
import {createRouter, route, renderContext, DEFAULT_TAGS} from './router.mjs';
import {codepointCompare, has, isMap, isText, list, pairs} from './utils.mjs';

export class ContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

const TEMPLATE_NAMES = ['变量更新规则', '角色通用约束', '扮演准则'];

/**
 * 只读推演一局的路由上下文与预算占用：封卷或读入本局、按需写场景后复用现行路由。
 * 世界书、作者资料、yggdrasill.yaml 与 --本局 文件一律走传入的 {fs, path}；
 * 仓库固定模板优先取 options.templates，未传时用真实 node:fs/promises 定位本仓库 templates/。
 */
export async function previewContext(root, options = {}) {
  const fs = options.fs ?? defaultFs, path = options.path ?? defaultPath;
  if (options.本局 && (options.开局 || options.方案 || options.世界线))
    throw new ContextError('上下文.参数', '--本局 不能与 --世界线、--开局 或 --方案 同用');

  let compiled;
  try { compiled = await compileWorldbook(root, {fs, path}); }
  catch (error) { throw new ContextError('上下文.读取失败', `无法读取世界书：${error?.message ?? error}`); }
  const {catalog, decl, issues} = compiled;
  const fatal = list(issues).filter(item => item?.级别 === '错误');
  if (fatal.length) throw new ContextError('上下文.读取失败', fatal.map(item => `${item.文件}：${item.说明}`).join('；'));

  const protocol = createProtocol({catalog, decl});
  const groups = new Map(list(catalog.groups).map(group => [group.id, group]));
  const locations = list(catalog.entries?.地点);
  const plans = list(catalog.openingPlans);
  const worldlines = list(catalog.worldlines);

  let state;
  if (options.本局) {
    state = await readState(options.本局, {fs, path, base: options.cwd ?? process.cwd()});
    try { protocol.createReadView(state); }
    catch (error) {
      if (error?.name === 'ProtocolError') throw new ContextError('上下文.本局', `本局状态不合法：${error.code}：${error.message}`);
      throw error;
    }
  } else {
    if (options.世界线 != null && (!isText(options.世界线) || !worldlines.some(item => item.id === options.世界线)))
      throw new ContextError('上下文.世界线', `世界线不存在：${String(options.世界线)}`);
    if (options.方案 != null && (!isText(options.方案) || !plans.some(plan => plan.id === options.方案)))
      throw new ContextError('上下文.方案', `开局方案不存在：${String(options.方案)}`);
    let opening = isText(options.开局) ? options.开局 : undefined;
    if (!opening && isText(options.方案)) {
      const plan = plans.find(item => item.id === options.方案);
      opening = isText(plan?.内容?.开局时间) ? plan.内容.开局时间 : undefined;
    }
    if (!opening) {
      try { opening = timelineEnd(catalog, decl); }
      catch (error) { throw new ContextError('上下文.时间轴', error?.message ?? '无法确定时间轴末尾'); }
    }
    const config = {开局时间: opening};
    if (isText(options.世界线)) config.世界线 = options.世界线;
    if (isText(options.方案)) config.方案 = options.方案;
    try { state = protocol.seal(config); }
    catch (error) {
      if (error?.name === 'ProtocolError') throw new ContextError('上下文.封卷', `${error.code}：${error.message}`);
      throw error;
    }
  }

  // 场景参数：--地点 须是已声明地标；仅传 --场景 时本局须已有当前地点。
  const location = isText(options.地点) ? options.地点 : null;
  if (location && !locations.some(entry => entry.id === location))
    throw new ContextError('上下文.地点', `地标不存在：${location}`);
  let scene = isText(options.场景) ? options.场景 : null;
  if (!location && scene && !isText(state?.世界?.当前地点?.地标))
    throw new ContextError('上下文.参数', '仅传 --场景 时，本局须已有当前地点');
  if (location && !scene) scene = location;

  // 在场：去重按码点排序；须存在（或自建模式下的玩家）且已启用。
  const present = [...new Set(list(options.在场).filter(isText))].sort(codepointCompare);
  for (const id of present) {
    if (id === '玩家') {
      if (state?.开局?.玩家?.模式 !== '自建') throw new ContextError('上下文.角色组', '玩家 仅在自建模式下可在场');
      if (!location && !isText(state?.世界?.当前地点?.地标))
        throw new ContextError('上下文.场景', '自建模式玩家在场须先指定 --地点 或本局已有当前地点');
      continue;
    }
    if (!groups.has(id)) throw new ContextError('上下文.角色组', `角色组不存在：${id}`);
    if (state?.开局?.角色组?.[id]?.启用 !== true) throw new ContextError('上下文.角色组', `角色组未启用：${id}`);
  }

  // 自动初始化：避免模拟在场被首登场门禁卡死；档案不成立时留给 writeScene 报清晰错误。
  const 模拟初始化 = [];
  if (options.自动初始化 !== false && present.length) {
    for (const id of present) {
      if (id === '玩家' || !groups.has(id)) continue;
      if (groups.get(id).内容?.初始化方式 === '出场自动' || hasAppeared(state, id)) continue;
      try { state = protocol.confirmInitialization(state, id).state; 模拟初始化.push(id); }
      catch (error) {
        if (error?.name === 'ProtocolError' && error.code === '协议.初始化' && error.message.includes('当前档案不成立')) continue;
        if (error?.name === 'ProtocolError' && options.本局 && error.code === '协议.参数')
          throw new ContextError('上下文.本局', `本局状态不合法：${error.message}`);
        if (error?.name === 'ProtocolError') throw new ContextError('上下文.场景', `${error.code}：${error.message}`);
        throw error;
      }
    }
  }

  // 只在需要设置或变更 当前地点/在场 时写场景；自建模式玩家随当前地点自动在场，不写入 在场 映射。
  const scenePresent = present.filter(id => id !== '玩家');
  if (location || scene || scenePresent.length) {
    const params = {};
    if (location || scene) params.当前地点 = {地标: location ?? state?.世界?.当前地点?.地标, 场景: scene};
    if (scenePresent.length) params.在场 = Object.fromEntries(scenePresent.map(id => [id, true]));
    try { state = protocol.writeScene(state, params).state; }
    catch (error) {
      if (error?.name === 'ProtocolError') throw new ContextError('上下文.场景', `${error.code}：${error.message}`);
      throw error;
    }
  }

  // 运行参数与模板；模板不经过注入的虚拟 fs。
  const projectRoot = path.dirname(path.resolve(root));
  let settingsSource = '调用方注入';
  let settings = options.settings;
  if (!isMap(settings)) {
    settings = null;
    settingsSource = '默认';
    try { await fs.access(path.join(projectRoot, 'yggdrasill.yaml')); settingsSource = '项目 yggdrasill.yaml'; }
    catch { /* 无运行参数文件时取默认 */ }
    try { settings = await readSettings(projectRoot, {fs, path, decl}); }
    catch (error) { throw new ContextError('上下文.读取失败', `无法读取运行参数：${error?.message ?? error}`); }
  }
  const templates = isMap(options.templates) ? options.templates : await loadTemplates();

  const router = createRouter({catalog, decl, protocol, settings, templates});
  const messages = list(options.消息).filter(value => typeof value === 'string');
  let routed;
  try { routed = route(router, state, messages); }
  catch (error) {
    if (options.本局 && error?.name === 'ProtocolError')
      throw new ContextError('上下文.本局', `本局状态不合法：${error.message}`);
    throw error;
  }
  const {context, audit} = routed;
  const rendered = renderContext(context);
  const 分块字符 = {};
  for (const key of Object.keys(DEFAULT_TAGS)) if (has(context, key))
    分块字符[key] = [...renderContext({[key]: context[key]})].length;

  const worldline = isText(options.世界线) ? options.世界线 : state?.开局?.世界线 ?? null;
  return {
    输入: {世界书: root, ...(worldline ? {世界线: worldline} : {}),
      开局: state?.开局?.开局时间 ?? state?.世界?.当前时间 ?? null,
      方案: isText(options.方案) ? options.方案 : state?.开局?.方案 ?? null,
      地点: location, 场景: scene, 在场: present, 模拟初始化, 消息: messages, 运行参数来源: settingsSource},
    汇总: {总字符: [...rendered].length, 分块字符},
    预算: {
      经历: {已用条数: audit.经历.选入.length, 条数上限: audit.经历.预算.条数,
        已用字符: audit.经历.字符, 字符上限: audit.经历.预算.字符},
      候选: {已用条数: audit.候选.选入.length, 条数上限: audit.候选.预算.条数,
        已用字符: audit.候选.字符, 字符上限: audit.候选.预算.字符},
      条目: Object.fromEntries(pairs(audit.条目).map(([name, log]) =>
        [name, {已用字符: log.字符, 预算上限: log.预算}])),
      在场角色: {已用人数: audit.在场角色.选入.length,
        完整人数: audit.在场角色.选入.filter(item => item.形式 === '完整').length,
        完整人数上限: audit.在场角色.预算.完整人数, 已用字符: audit.在场角色.字符, 字符上限: audit.在场角色.预算.字符},
    },
    审计: {经历: audit.经历, 候选: audit.候选, 条目: audit.条目, 提及: audit.提及, 在场角色: audit.在场角色, 异常: audit.异常},
    正文: options.raw === true ? rendered : null,
  };
}

async function readState(file, {fs, path, base}) {
  let text;
  try { text = await fs.readFile(path.resolve(base, file), 'utf8'); }
  catch { throw new ContextError('上下文.本局', `无法读取本局文件：${file}`); }
  let state;
  try { state = JSON.parse(text); }
  catch { throw new ContextError('上下文.本局', `本局文件不是合法 JSON：${file}`); }
  if (!isMap(state) || state?.开局?.已封卷 !== true)
    throw new ContextError('上下文.本局', '本局文件须是已封卷的本局状态');
  return state;
}

function hasAppeared(state, id) {
  const present = new Set(Object.entries(state?.角色 ?? {}).filter(([, value]) => value?.在场 === true).map(([key]) => key));
  const player = state?.开局?.玩家;
  if (state?.世界?.当前地点 && player?.模式 === '扮演') present.add(player.扮演角色组);
  if (state?.世界?.当前地点 && player?.模式 === '自建') present.add('玩家');
  return present.has(id) || state?.角色?.[id]?.已初始化 === true
    || Object.values(state?.事件 ?? {}).some(record => record?.状态 === 1 && list(record.实际参与者).includes(id));
}

async function loadTemplates() {
  const root = defaultPath.resolve(defaultPath.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  return Object.fromEntries(await Promise.all(TEMPLATE_NAMES.map(async name =>
    [name, await defaultFs.readFile(defaultPath.join(root, `${name}.txt`), 'utf8')])));
}
