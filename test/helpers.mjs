import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseYaml, stringifyYaml} from '../core/yaml.mjs';
import {checkWorldbook} from '../checker/index.mjs';

export {fs, path, assert, test};
export const project = fileURLToPath(new URL('../', import.meta.url));
export const example = path.join(project, 'examples/雾港/世界书');
export const shortSkill = '技能/灯语/灯语·短讯.txt';
export const naturalSkill = '技能/雾中视/雾中视·辨影.txt';
export const equipment = '装备/工具/工具·铜扳手.txt';
export const ship = '船只/货船/潮汐号.txt';
export const port = '地点/北湾/雾港/雾港.txt';
export const district = '地点/北湾/雾港/码头区/码头区.txt';
export const lighthouse = '地点/北湾/雾港/灯塔/灯塔.txt';
export const oldGroup = '角色/秦守/角色组.yaml';
export const apprenticeGroup = '角色/灯塔学徒/角色组.yaml';
export const youngGroup = '角色/周岚/角色组.yaml';
export const captainGroup = '角色/白棠/角色组.yaml';
export const basic = '角色/灯塔学徒/档案/林澜·学徒期/基本信息.txt';
export const impression = '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt';

export async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yggdrasill-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const root = path.join(temporary, '世界书');
  await fs.cp(example, root, {recursive: true});
  const author = path.join(path.dirname(example), '作者资料');
  await fs.cp(author, path.join(temporary, '作者资料'), {recursive: true});
  return root;
}
export async function read(root, name) { return parseYaml(await fs.readFile(path.join(root, name), 'utf8')); }
export async function write(root, name, value) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, stringifyYaml(value));
}
export async function edit(root, name, callback) {
  const value = await read(root, name);
  await callback(value);
  await write(root, name, value);
}
export const remove = (root, name) => fs.rm(path.join(root, name), {recursive: true, force: true});
export const rename = (root, from, to) => fs.rename(path.join(root, from), path.join(root, to));
export function invalidCase(name, rule, mutate, level = '错误') {
  test(name, async t => {
    const root = await fixture(t);
    await mutate(root);
    const result = await checkWorldbook(root);
    const expected = Array.isArray(rule) ? rule : [rule];
    for (const id of expected) assert.ok([...result.errors, ...result.hints].some(item => item.规则 === id && item.级别 === (id === '命名.编码样式' ? '提示' : level)), `${id}\n${JSON.stringify(result, null, 2)}`);
    if (level === '提示') assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  });
}
