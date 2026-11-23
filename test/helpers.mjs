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
export const example = path.join(project, 'test/fixtures/雾港/世界书');
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

// 期望的一条发现；默认错误级、出现一次。说明片段只断言稳定部分，不 pin 整句。
export function finding(规则, 文件, {级别 = '错误', 次数 = 1, 说明 = []} = {}) {
  return {规则, 级别, 文件, 次数, 说明};
}
export function hint(规则, 文件, options = {}) {
  return finding(规则, 文件, {...options, 级别: '提示'});
}

function findingKey(item) {
  return [item.级别, item.规则, item.文件].join('\u0000');
}
function describe(items) {
  return items.slice().sort((left, right) => findingKey(left) < findingKey(right) ? -1 : findingKey(left) > findingKey(right) ? 1 : 0)
    .map(item => `${item.级别} ${item.规则} ${item.文件}：${item.说明}`).join('\n') || '（无）';
}

// 完整发现集合：级别 + 规则 + 文件的重复次数必须与期望一致；说明只核对给出的稳定片段。
export function assertFindings(result, expected, label = '发现集合') {
  const actual = [...result.errors, ...result.hints];
  const expectedItems = (Array.isArray(expected) ? expected : [expected]).map(item => ({
    规则: item.规则, 级别: item.级别 ?? '错误', 文件: item.文件, 次数: item.次数 ?? 1, 说明: item.说明 ?? [],
  }));
  assert.ok(expectedItems.every(item => item.规则 !== '检查.规则失败'), `${label}：不得把检查.规则失败列为预期`);
  assert.equal(actual.some(item => item.规则 === '检查.规则失败'), false,
    `${label}：内部规则失败不能当作业务发现\n${describe(actual)}`);

  const actualCounts = new Map(), actualMessages = new Map();
  for (const item of actual) {
    const key = findingKey(item);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    if (!actualMessages.has(key)) actualMessages.set(key, []);
    actualMessages.get(key).push(item.说明);
  }
  const expectedCounts = new Map();
  for (const item of expectedItems) {
    const key = findingKey(item);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + item.次数);
  }
  const differences = [];
  for (const key of [...new Set([...actualCounts.keys(), ...expectedCounts.keys()])].sort()) {
    const actualCount = actualCounts.get(key) ?? 0, expectedCount = expectedCounts.get(key) ?? 0;
    if (actualCount !== expectedCount) differences.push(`${key.split('\u0000').join(' | ')}：实际 ${actualCount}，期望 ${expectedCount}`);
  }
  assert.deepEqual(differences, [],
    `${label}：发现集合不符\n实际：\n${describe(actual)}\n差异：\n${differences.join('\n') || '（无）'}`);

  for (const item of expectedItems) for (const fragment of item.说明) {
    const messages = (actualMessages.get(findingKey(item)) ?? []).join('\n');
    assert.ok(messages.includes(fragment), `${label}：${item.规则} ${item.文件} 缺少说明片段“${fragment}”\n${messages}`);
  }
  return actual;
}

export function assertIssues(issues, expected, label = '异常集合') {
  return assertFindings({
    errors: issues.filter(item => item.级别 === '错误'),
    hints: issues.filter(item => item.级别 === '提示'),
  }, expected, label);
}

export function invalidCase(name, expected, mutate) {
  test(name, async t => {
    const root = await fixture(t);
    await mutate(root);
    assertFindings(await checkWorldbook(root), expected, name);
  });
}
