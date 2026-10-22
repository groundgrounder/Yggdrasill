import {parseYaml} from './yaml.mjs';
import {ProtocolError} from './protocol.mjs';
import {freeze, has, isMap} from './utils.mjs';

export const DEFAULT_SETTINGS = freeze({经历: {条数: 6, 字符: 3000}, 候选: {条数: 4, 字符: 4000},
  条目字符: {默认: 1500}, 提及窗口: 2});

export function normalizeSettings(input = {}, libraries = {}) {
  const fail = message => { throw new ProtocolError('运行参数.格式', message); };
  const integer = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label}须为非负安全整数`);
  };
  if (!isMap(input)) fail('运行参数须为映射');
  for (const key of Object.keys(input)) if (!has(DEFAULT_SETTINGS, key)) fail(`运行参数含未知键“${key}”`);
  const result = structuredClone(DEFAULT_SETTINGS);
  for (const key of ['经历', '候选']) if (has(input, key)) {
    if (!isMap(input[key])) fail(`${key}须为映射`);
    for (const [name, value] of Object.entries(input[key])) {
      if (!['条数', '字符'].includes(name)) fail(`${key}含未知键“${name}”`);
      integer(value, `${key}.${name}`);
      result[key][name] = value;
    }
  }
  if (has(input, '提及窗口')) { integer(input.提及窗口, '提及窗口'); result.提及窗口 = input.提及窗口; }
  if (has(input, '条目字符')) {
    if (!isMap(input.条目字符)) fail('条目字符须为映射');
    for (const [key, value] of Object.entries(input.条目字符)) {
      if (key !== '默认' && !has(libraries, key)) fail(`条目字符含未声明的库名“${key}”`);
      integer(value, `条目字符.${key}`);
      Object.defineProperty(result.条目字符, key, {value, enumerable: true, writable: true, configurable: true});
    }
  }
  return result;
}

export async function readSettings(projectRoot, {fs, path, decl} = {}) {
  let source;
  try { source = await fs.readFile(path.join(projectRoot, 'yggdrasill.yaml'), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS); throw error; }
  let input;
  try { input = parseYaml(source); }
  catch { throw new ProtocolError('运行参数.格式', '运行参数文件的 YAML 不合法'); }
  if (!isMap(input) || Object.keys(input).length !== 1 || !has(input, '运行参数'))
    throw new ProtocolError('运行参数.格式', '运行参数文件只能含“运行参数”映射');
  let libraries = decl?.libraries;
  if (!libraries && isMap(input.运行参数?.条目字符) && Object.keys(input.运行参数.条目字符).some(key => key !== '默认')) {
    for (const file of [path.join(projectRoot, '设定', '条目库.yaml'), path.join(projectRoot, '世界书', '设定', '条目库.yaml')]) {
      try { libraries = parseYaml(await fs.readFile(file, 'utf8')); break; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return normalizeSettings(input.运行参数, libraries);
}
