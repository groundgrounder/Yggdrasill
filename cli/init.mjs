import * as defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCalendar} from '../core/calendar.mjs';

const USAGE = '用法：ygg init <项目目录> [--纪年前缀 <前缀>] [--年位数 <整数>] [--月数 <整数>] '
  + '[--每月天数 <整数>] [--force] [--json]';

const DIRECTORIES = ['世界书/设定', '世界书/角色', '世界书/历史/事件', '世界书/历史/事件串', '世界书/历史/开局方案',
  '世界书/世界概况', '世界书/扮演准则', '世界书/地点', '世界书/势力',
  '作者资料/通读/分卷', '作者资料/出处', '作者资料/暂存', '作者资料/候选', '作者资料/生成', '作者资料/归档', '来源资料'];

// 最小条目库：地点 与 势力 支撑 defaults/设定/本局变量.yaml 中 职位 的键引用，可按本卡需要增改。
const MINIMAL_LIBRARIES = `地点:
  分法: 按上下级
  字段:
    类型: {必填: true, 取值: [区域]}
    概况: {必填: true, 形态: 文本}
势力:
  分法: 按种类
  分级: [类型]
  字段:
    类型: {必填: true, 取值: [组织]}
    概况: {必填: true, 形态: 文本}
`;

export async function runInit(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  fs = defaultFs, path = defaultPath, defaultsDir = null} = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    stderr.write(`${USAGE}\n错误 ${error.code ?? '初始化.参数'}：${error.message}\n`);
    if (args.includes('--json')) stdout.write(`${JSON.stringify(failureResult(null, error), null, 2)}\n`);
    return 1;
  }
  const target = path.resolve(cwd, parsed.项目目录);
  try {
    const result = await scaffold(target, parsed, {fs, path, defaultsDir});
    if (parsed.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      stdout.write(`项目目录：${result.项目目录}\n世界书目录：${result.世界书目录}\n`);
      stdout.write(`纪年：${result.纪年.前缀}${'Y'.repeat(result.纪年.年位数)}年（${result.纪年.月数} 个月，每月 ${result.纪年.每月天数} 天）\n`);
      stdout.write(`已创建目录 ${result.已创建目录.length} 个，已写入文件 ${result.已写入文件.length} 份。\n`);
      stdout.write(`${result.跳过或覆盖说明}\n`);
    }
    return 0;
  } catch (error) {
    const known = error instanceof InitError;
    stderr.write(`错误 ${known ? error.code : '初始化.路径'}：${known ? error.message : `无法完成初始化：${error?.message ?? String(error)}`}\n`);
    if (parsed.json) stdout.write(`${JSON.stringify(failureResult(parsed, known ? error
      : new InitError('初始化.路径', `无法完成初始化：${error?.message ?? String(error)}`)), null, 2)}\n`);
    return 1;
  }
}

async function scaffold(target, parsed, {fs, path, defaultsDir}) {
  // 纪年组合先经 createCalendar 验证，非法直接拒绝，零写入。
  try { createCalendar(parsed.纪年); }
  catch { throw new InitError('初始化.参数', `纪年参数组合不合法：${parsed.纪年.前缀} ${parsed.纪年.年位数} 位年、`
    + `${parsed.纪年.月数} 个月、每月 ${parsed.纪年.每月天数} 天`); }
  try {
    const existingStat = await fs.stat(target);
    if (typeof existingStat?.isDirectory !== 'function' || !existingStat.isDirectory())
      throw new InitError('初始化.路径', `目标已存在且不是目录：${target}`);
  } catch (error) {
    if (error instanceof InitError) throw error;
    if (error?.code !== 'ENOENT') throw new InitError('初始化.路径', `无法访问目标目录：${error?.message ?? error}`);
  }

  const settingsDir = path.join(target, '世界书', '设定');
  const files = {
    '世界书/设定/纪年.yaml': `前缀: ${parsed.纪年.前缀}\n年位数: ${parsed.纪年.年位数}\n`
      + `月数: ${parsed.纪年.月数}\n每月天数: ${parsed.纪年.每月天数}\n`,
    '世界书/设定/事件分类.yaml': await readDefault('事件分类.yaml', {fs, path, defaultsDir}),
    '世界书/设定/本局变量.yaml': await readDefault('本局变量.yaml', {fs, path, defaultsDir}),
    '世界书/设定/条目库.yaml': MINIMAL_LIBRARIES,
  };

  // 未传 --force 时先预检全部拟写文件：任一已存在即拒绝，不留下半套覆盖文件。
  const preexisting = [];
  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== 'string') throw new InitError('初始化.路径', `无法读取默认声明：${name}`);
    try { await fs.access(path.join(target, name)); preexisting.push(name); }
    catch (error) { if (error?.code !== 'ENOENT') throw new InitError('初始化.路径', `无法预检文件：${name}：${error?.message ?? error}`); }
  }
  if (preexisting.length && !parsed.force)
    throw new InitError('初始化.已存在', `目标已有脚手架文件，未写入任何内容：${preexisting.join('、')}`);

  const created = [];
  for (const directory of DIRECTORIES) {
    const full = path.join(target, directory);
    try { await fs.stat(full); }
    catch { created.push(directory); }
    try { await fs.mkdir(full, {recursive: true}); }
    catch (error) { throw new InitError('初始化.路径', `无法创建目录 ${directory}：${error?.message ?? error}`); }
  }
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    try { await fs.writeFile(path.join(target, name), content); }
    catch (error) { throw new InitError('初始化.路径', `无法写入 ${name}：${error?.message ?? error}`); }
    written.push(name);
  }
  return {
    项目目录: target,
    世界书目录: path.join(target, '世界书'),
    纪年: {...parsed.纪年},
    已创建目录: created,
    已写入文件: written,
    跳过或覆盖说明: preexisting.length
      ? `--force 覆盖已存在的脚手架文件：${preexisting.join('、')}；其他已有文件与目录保持原状`
      : '全新创建；未跳过或覆盖任何已有文件',
    异常: [],
  };
}

async function readDefault(name, {fs, path, defaultsDir}) {
  if (defaultsDir) {
    try { return await fs.readFile(path.join(defaultsDir, name), 'utf8'); }
    catch (error) { throw new InitError('初始化.路径', `无法读取默认声明 ${name}：${error?.message ?? error}`); }
  }
  const real = await import('node:fs/promises');
  try { return await real.readFile(fileURLToPath(new URL(`../defaults/设定/${name}`, import.meta.url)), 'utf8'); }
  catch (error) { throw new InitError('初始化.路径', `无法读取仓库默认声明 ${name}：${error?.message ?? error}`); }
}

export function parseArgs(args) {
  if (!Array.isArray(args)) throw argumentError('init 参数须为列表');
  const result = {项目目录: null, 纪年: {前缀: '纪元', 年位数: 4, 月数: 12, 每月天数: 30}, force: false, json: false};
  const positionals = [];
  const seen = new Set();
  const integer = (value, option) => {
    if (!/^\d+$/u.test(value)) throw argumentError(`${option} 须为正整数`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw argumentError(`${option} 须为 >= 1 的安全整数`);
    return parsed;
  };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--json') { result.json = true; continue; }
    if (value === '--force') { result.force = true; continue; }
    if (value === '--纪年前缀') {
      once(seen, '--纪年前缀');
      const next = optionValue(args, ++index, '--纪年前缀');
      if (next.trim() !== next || !next.trim().length) throw argumentError('--纪年前缀 须为无首尾空白的非空文本');
      result.纪年.前缀 = next;
      continue;
    }
    if (['--年位数', '--月数', '--每月天数'].includes(value)) {
      const key = value === '--年位数' ? '年位数' : value === '--月数' ? '月数' : '每月天数';
      const limit = key === '年位数' ? 11 : 99;
      once(seen, value);
      const next = integer(optionValue(args, ++index, value), value);
      if (next > limit) throw argumentError(`${value} 不能超过 ${limit}`);
      result.纪年[key] = next;
      continue;
    }
    if (value.startsWith('-')) throw argumentError(`未知选项：${value}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw argumentError(positionals.length
    ? `多余位置参数：${positionals.slice(1).join(' ')}` : '缺少项目目录');
  result.项目目录 = positionals[0];
  return result;
}

class InitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InitError';
    this.code = code;
  }
}

function failureResult(parsed, error) {
  return {项目目录: parsed?.项目目录 ?? null, 世界书目录: null,
    纪年: parsed?.纪年 ? {...parsed.纪年} : null, 已创建目录: [], 已写入文件: [], 跳过或覆盖说明: null,
    异常: [{规则: error?.code ?? '初始化.参数', 级别: '错误', 文件: parsed?.项目目录 ?? 'init',
      说明: error?.message ?? String(error)}]};
}

function optionValue(args, index, option) {
  const value = args[index];
  if (typeof value !== 'string' || !value.length || value.startsWith('-')) throw argumentError(`${option} 缺少值`);
  return value;
}

function once(seen, option) {
  if (seen.has(option)) throw argumentError(`${option} 只能给出一次`);
  seen.add(option);
}

function argumentError(message) {
  const error = new Error(message);
  error.code = '初始化.参数';
  return error;
}
