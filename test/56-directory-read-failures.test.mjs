import {test, fixture, fs, path, finding, hint, assertFindings} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';

function permission(file, code = 'EACCES') {
  return Object.assign(new Error(`${code}: permission denied, open '${file}'`),
    {code, errno: -13, syscall: 'open', path: String(file)});
}

function readDenied(target) {
  return {...fs, readFile: (file, ...args) => path.resolve(String(file)) === path.resolve(target)
    ? Promise.reject(permission(file)) : fs.readFile(file, ...args)};
}

function readdirDenied(target) {
  return {...fs, readdir: (directory, ...args) => path.resolve(String(directory)) === path.resolve(target)
    ? Promise.reject(permission(directory)) : fs.readdir(directory, ...args)};
}

test('读取-1：声明文件 EACCES 保留声明读取与目录读取两条发现', async t => {
  const root = await fixture(t);
  const target = path.join(root, '设定/文本规范.yaml');
  const result = await checkWorldbook(root, {fs: readDenied(target)});
  assertFindings(result, [
    finding('目录.读取失败', '设定/文本规范.yaml', {次数: 2, 说明: ['无法读取声明文件', '无法读取文件']}),
    finding('档案.未知字段', '角色/灯塔学徒/档案/林澜·学徒期/基本信息.txt', {说明: ['惯用手']}),
    finding('档案.未知字段', '角色/灯塔学徒/档案/林澜·少年期/基本信息.txt', {说明: ['惯用手']}),
    hint('抽样.未执行', '历史'),
  ], '读取-1');
});

test('读取-2：事件文件 EACCES 报读取失败与事件缺文件', async t => {
  const root = await fixture(t);
  const target = path.join(root, '历史/事件/接手商会账目/事件.txt');
  const result = await checkWorldbook(root, {fs: readDenied(target)});
  assertFindings(result, [
    finding('目录.读取失败', '历史/事件/接手商会账目/事件.txt', {说明: ['无法读取文件']}),
    finding('事件.缺文件', '历史/事件/接手商会账目/事件.txt', {说明: ['事件.txt']}),
    hint('抽样.未执行', '历史'),
  ], '读取-2');
});

test('读取-3：符号链接不当作普通文件读取', async t => {
  const root = await fixture(t);
  await fs.symlink('设定/纪年.yaml', path.join(root, '链接.yaml'));
  const result = await checkWorldbook(root);
  assertFindings(result, [
    finding('目录.读取失败', '链接.yaml', {说明: ['符号链接']}),
    hint('抽样.未执行', '历史'),
  ], '读取-3');
});

test('读取-4：出处目录 EACCES 报出处目录读取失败', async t => {
  const root = await fixture(t);
  const target = path.join(path.dirname(root), '作者资料/出处');
  const result = await checkWorldbook(root, {fs: readdirDenied(target)});
  assertFindings(result, [
    finding('目录.读取失败', '作者资料/出处', {说明: ['无法读取目录']}),
    hint('抽样.未执行', '历史'),
  ], '读取-4');
});

test('读取-5：运行参数 EACCES 保留实际路径与错误类型', async t => {
  const root = await fixture(t);
  const target = path.join(path.dirname(root), 'yggdrasill.yaml');
  await fs.writeFile(target, '运行参数: {}\n');
  const result = await checkWorldbook(root, {fs: readDenied(target)});
  assertFindings(result, [
    finding('目录.读取失败', 'yggdrasill.yaml', {说明: ['EACCES', target]}),
    hint('抽样.未执行', '历史'),
  ], '读取-5');
});
