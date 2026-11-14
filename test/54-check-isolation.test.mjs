import {test, assert, fs, path, example, fixture, edit} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {runCli} from '../cli/ygg.mjs';

const SUMMARY_KEYS = ['错误', '提示', '文件', '角色组', '档案', '条目', '事件'];
const all = result => [...result.errors, ...result.hints];
const hasRule = (result, rule, level) => all(result).some(item => item.规则 === rule && (!level || item.级别 === level));
const crashText = result => all(result).find(item => /is not a function|Cannot read propert|\(reading '/u.test(item.说明));

async function cli(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {...options, stdout: {write: text => { stdout += text; }}, stderr: {write: text => { stderr += text; }}});
  return {code, stdout, stderr};
}

async function addIndependentFindings(root) {
  await edit(root, '历史/事件/学修船/事件.txt', event => { event.备注 = '审计003独立错误'; });
  await edit(root, '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt', impression => {
    impression.行为准则.push('今年十七岁，仍在长身体。');
  });
}

async function malformedCase(t, mutate) {
  const root = await fixture(t);
  await mutate(root);
  await addIndependentFindings(root);
  const full = await checkWorldbook(root);
  const staticOnly = await checkWorldbook(root, {sampling: false});
  return {root, full, staticOnly};
}

function assertConcrete(result, rule) {
  assert.ok(hasRule(result, rule), `${rule}\n${JSON.stringify(result, null, 2)}`);
  assert.ok(hasRule(result, '事件.未知字段'), `独立错误丢失\n${JSON.stringify(result, null, 2)}`);
  assert.ok(hasRule(result, '档案.年龄', '提示'), `独立提示丢失\n${JSON.stringify(result, null, 2)}`);
  assert.equal(hasRule(result, '检查.规则失败'), false, JSON.stringify(result, null, 2));
  assert.equal(crashText(result), undefined, JSON.stringify(result, null, 2));
  assert.deepEqual(Object.keys(result.summary), SUMMARY_KEYS);
}

test('隔离-1：分支为字符串时报分支.格式且不崩溃', async t => {
  const {full, staticOnly} = await malformedCase(t, root => edit(root, '历史/事件/拜师/事件.txt', event => { event.分支 = '坏'; }));
  assertConcrete(staticOnly, '分支.格式');
  assertConcrete(full, '分支.格式');
  assert.ok(hasRule(full, '抽样.未执行', '提示'));
  assert.equal(hasRule(staticOnly, '抽样.未执行'), false);
});

test('隔离-2：缺事件结果且分支有变化时报事件.缺必填且不崩溃', async t => {
  const {full, staticOnly} = await malformedCase(t, root => edit(root, '历史/事件/拜师/事件.txt', event => { delete event.事件结果; }));
  assertConcrete(staticOnly, '事件.缺必填');
  assertConcrete(full, '事件.缺必填');
  assert.ok(hasRule(full, '抽样.未执行', '提示'));
  assert.equal(hasRule(staticOnly, '抽样.未执行'), false);
});

test('隔离-3：事件结果为字符串时报事件.分类且不崩溃', async t => {
  const {full, staticOnly} = await malformedCase(t, root => edit(root, '历史/事件/拜师/事件.txt', event => { event.事件结果 = '身份变化'; }));
  assertConcrete(staticOnly, '事件.分类');
  assertConcrete(full, '事件.分类');
  assert.ok(hasRule(full, '抽样.未执行', '提示'));
  assert.equal(hasRule(staticOnly, '抽样.未执行'), false);
});

test('隔离-4：CLI 人读与 JSON 保留畸形事件的真实发现和七键 summary', async t => {
  const root = await fixture(t);
  await edit(root, '历史/事件/拜师/事件.txt', event => { event.分支 = '坏'; });
  await addIndependentFindings(root);
  const json = await cli(['check', root, '--json', '--static-only']);
  assert.equal(json.code, 1);
  assert.equal(json.stderr, '');
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(parsed.summary), SUMMARY_KEYS);
  assert.ok(parsed.errors.some(item => item.规则 === '分支.格式'));
  assert.ok(parsed.errors.some(item => item.规则 === '事件.未知字段'));
  assert.ok(parsed.hints.some(item => item.规则 === '档案.年龄'));
  assert.equal(parsed.errors.some(item => item.规则 === '目录.读取失败'), false);
  const human = await cli(['check', root, '--static-only']);
  assert.equal(human.code, 1);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /错误 分支\.格式 /u);
  assert.match(human.stdout, /错误 事件\.未知字段 /u);
  assert.match(human.stdout, /提示 档案\.年龄 /u);
  assert.doesNotMatch(human.stdout, /目录\.读取失败/u);
  const full = await cli(['check', root]);
  assert.equal(full.code, 1);
  assert.match(full.stdout, /提示 抽样\.未执行 /u);
});

test('隔离-5：设置读取 EACCES 保留路径、错误类型与其它发现', async t => {
  const root = await fixture(t);
  await addIndependentFindings(root);
  const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
  await fs.writeFile(settingsFile, '运行参数: {}\n');
  const injectedFs = {
    ...fs,
    readFile: (file, ...args) => path.resolve(String(file)) === path.resolve(settingsFile)
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${file}'`),
        {code: 'EACCES', errno: -13, syscall: 'open', path: String(file)}))
      : fs.readFile(file, ...args),
  };
  const result = await checkWorldbook(root, {fs: injectedFs});
  const failure = result.errors.find(item => item.规则 === '目录.读取失败');
  assert.ok(failure, JSON.stringify(result, null, 2));
  assert.equal(failure.文件, 'yggdrasill.yaml');
  assert.ok(failure.说明.includes(settingsFile), failure.说明);
  assert.ok(failure.说明.includes('EACCES'), failure.说明);
  assert.ok(hasRule(result, '事件.未知字段'), JSON.stringify(result, null, 2));
  assert.ok(hasRule(result, '档案.年龄', '提示'), JSON.stringify(result, null, 2));
  assert.ok(hasRule(result, '抽样.未执行', '提示'));
  assert.equal(hasRule(result, '检查.规则失败'), false);
  assert.deepEqual(Object.keys(result.summary), SUMMARY_KEYS);
  const json = await cli(['check', root, '--json', '--static-only'], {fs: injectedFs});
  assert.equal(json.code, 1);
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.errors.some(item => item.规则 === '目录.读取失败' && item.说明.includes('EACCES')));
  assert.ok(parsed.errors.some(item => item.规则 === '事件.未知字段'));
  assert.ok(parsed.hints.some(item => item.规则 === '档案.年龄'));
  assert.deepEqual(Object.keys(parsed.summary), SUMMARY_KEYS);
});

test('隔离-6：非 I/O 内部异常按阶段隔离并保留异常名与 message', async t => {
  const root = await fixture(t);
  await addIndependentFindings(root);
  const settingsFile = path.join(path.dirname(root), 'yggdrasill.yaml');
  await fs.writeFile(settingsFile, '运行参数: {}\n');
  const injectedFs = {
    ...fs,
    readFile: (file, ...args) => path.resolve(String(file)) === path.resolve(settingsFile)
      ? Promise.reject(new TypeError('注入的内部异常：settings 阶段模拟'))
      : fs.readFile(file, ...args),
  };
  const result = await checkWorldbook(root, {fs: injectedFs});
  const failure = result.errors.find(item => item.规则 === '检查.规则失败');
  assert.ok(failure, JSON.stringify(result, null, 2));
  assert.ok(failure.说明.includes('checkSettings'), failure.说明);
  assert.ok(failure.说明.includes('TypeError'), failure.说明);
  assert.ok(failure.说明.includes('注入的内部异常：settings 阶段模拟'), failure.说明);
  assert.ok(hasRule(result, '事件.未知字段'), JSON.stringify(result, null, 2));
  assert.ok(hasRule(result, '档案.年龄', '提示'), JSON.stringify(result, null, 2));
  assert.ok(hasRule(result, '抽样.未执行', '提示'));
  assert.deepEqual(Object.keys(result.summary), SUMMARY_KEYS);
});

test('隔离-7：CLI 最后兜底保留异常名、message、实际目录与七键 summary', async t => {
  const root = await fixture(t);
  const brokenFs = {
    ...fs,
    readdir: (directory, ...args) => path.resolve(String(directory)) === path.resolve(root)
      ? Promise.resolve([null])
      : fs.readdir(directory, ...args),
  };
  const json = await cli(['check', root, '--json', '--static-only'], {fs: brokenFs});
  assert.equal(json.code, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.errors.length, 1, JSON.stringify(parsed, null, 2));
  const failure = parsed.errors[0];
  assert.equal(failure.规则, '检查.规则失败');
  assert.equal(failure.文件, path.resolve(root));
  assert.match(failure.说明, /TypeError/u);
  assert.match(failure.说明, /null/u);
  assert.deepEqual(parsed.hints, []);
  assert.deepEqual(Object.keys(parsed.summary), SUMMARY_KEYS);
  assert.deepEqual(Object.values(parsed.summary), [1, 0, 0, 0, 0, 0, 0]);
  assert.doesNotMatch(json.stdout, /请核对目录与文件权限/u);
  assert.equal(json.stderr, '');
  const human = await cli(['check', root, '--static-only'], {fs: brokenFs});
  assert.equal(human.code, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /检查\.规则失败/u);
  assert.match(human.stderr, /TypeError/u);
  assert.ok(human.stderr.includes(path.resolve(root)), human.stderr);
  assert.doesNotMatch(human.stderr, /请核对目录与文件权限/u);
});

test('隔离-8：合法雾港与缺目录的既有行为不变', async t => {
  const fog = await checkWorldbook(example);
  assert.deepEqual(fog.errors, []);
  assert.deepEqual(fog.hints, []);
  assert.deepEqual(Object.keys(fog.summary), SUMMARY_KEYS);
  const fogCli = await cli(['check', example, '--json', '--static-only']);
  assert.equal(fogCli.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(fogCli.stdout).summary), SUMMARY_KEYS);
  const missing = path.join(path.dirname(await fixture(t)), '不存在');
  const result = await checkWorldbook(missing, {sampling: false});
  assert.ok(hasRule(result, '目录.读取失败'));
  assert.ok(hasRule(result, '目录.缺少固定根'));
  assert.equal(hasRule(result, '检查.规则失败'), false);
  assert.deepEqual(Object.keys(result.summary), SUMMARY_KEYS);
  const missingCli = await cli(['check', missing, '--json', '--static-only']);
  assert.equal(missingCli.code, 1);
  assert.equal(missingCli.stderr, '');
  const parsed = JSON.parse(missingCli.stdout);
  assert.ok(parsed.errors.some(item => item.规则 === '目录.读取失败' && item.说明 === '无法读取目录'));
  assert.deepEqual(Object.keys(parsed.summary), SUMMARY_KEYS);
});
