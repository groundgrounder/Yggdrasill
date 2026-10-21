import {checkWorldbook} from '../checker/index.mjs';
import {loadWorldbook, readDeclarations, validateDeclarations} from '../core/index.mjs';
import {test, assert, fs, path, example, project, fixture, remove} from './helpers.mjs';
import {runCli} from '../cli/ygg.mjs';

test('正例：原样雾港零错误零提示', async () => {
  const result = await checkWorldbook(example);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
  assert.deepEqual(result.summary, {错误: 0, 提示: 0, 文件: 58, 角色组: 4, 档案: 9, 条目: 18, 事件: 3});
});
test('命令-1：检查示例退出零', async () => {
  let stdout = '', stderr = '';
  const status = await runCli(['check', example], {cwd: project, stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}});
  assert.equal(status, 0, stderr + stdout);
  assert.match(stdout.trim().split('\n').at(-1), /^摘要：0 错误，0 提示/);
});
test('命令-2：反例输出可解析JSON且退出一', async t => {
  const root = await fixture(t);
  await remove(root, '设定/纪年.yaml');
  let stdout = '', stderr = '';
  const status = await runCli(['check', root, '--json'], {stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}});
  assert.equal(status, 1, stderr);
  assert.ok(JSON.parse(stdout).errors.some(item => item.规则 === '设定.缺少文件'));
});
test('纯数据：目录和编译声明可结构化克隆', async () => {
  const {raw} = await readDeclarations(example, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(example, {fs, path, decl});
  assert.deepEqual(structuredClone(catalog), catalog);
  assert.deepEqual(structuredClone(decl), decl);
  const shared = catalog.groups.find(group => group.id === '白棠');
  assert.equal(shared.档案.length, 3);
  assert.equal(catalog.entries.地点.find(entry => entry.id === '商会馆').上级, '上城');
  assert.equal(catalog.entries.地点.find(entry => entry.id === '北湾').上级, null);
});
test('命令补充：默认检查当前目录的世界书', async t => {
  const root = await fixture(t);
  let stdout = '', stderr = '';
  const status = await runCli(['check', '--json'], {cwd: path.dirname(root), stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}});
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(stdout).summary.角色组, 4);
});
