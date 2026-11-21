import os from 'node:os';
import {runStatus} from '../cli/status.mjs';
import {runInit, parseArgs} from '../cli/init.mjs';
import {inspectProjectStatus, StatusError} from '../core/project-status.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {test, assert, fs, path, project, example, fixture, edit, assertFindings} from './helpers.mjs';
async function run(command, args, options = {}) {
  let stdout = '', stderr = '';
  const status = await command(args, {cwd: project,
    stdout: {write: value => { stdout += value; }}, stderr: {write: value => { stderr += value; }}, ...options});
  return {status, stdout, stderr, value: stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : null};
}

async function makeProject(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-status-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  return temporary;
}

test('状态-1：空目录诊断为未备料并推荐通读', async t => {
  const empty = await makeProject(t);
  const result = await run(runStatus, [empty, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.value), ['项目', '各层', '计数', '台词统计', '静态检查', '当前阶段', '缺口', '推荐skill', '异常']);
  assert.equal(result.value.项目.识别, '项目目录');
  assert.equal(result.value.当前阶段, '第 0 层：未备料');
  assert.equal(result.value.推荐skill, '世界树·通读');
  assert.equal(result.value.台词统计, null);
  assert.equal(result.value.静态检查.说明, '跳过：缺少 世界书/设定/纪年.yaml');
  assert.ok(result.value.缺口.some(item => item.includes('世界书/设定/纪年.yaml')));
  assert.deepEqual(result.value.异常, []);

  const missing = await run(runStatus, [path.join(empty, '不存在'), '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.value.异常[0].规则, '状态.路径');

  const notDirectory = await run(runStatus, [path.join(empty), '--json']);
  void notDirectory;
  const file = path.join(empty, '一个文件.md');
  await fs.writeFile(file, 'x');
  const asFile = await run(runStatus, [file, '--json']);
  assert.equal(asFile.status, 1);
  assert.equal(asFile.value.异常[0].规则, '状态.路径');
});

test('状态-2：雾港项目目录与世界书目录同口径', async () => {
  const byProject = await run(runStatus, ['examples/雾港', '--json']);
  assert.equal(byProject.status, 0, byProject.stderr);
  const byWorldbook = await run(runStatus, ['examples/雾港/世界书', '--json']);
  assert.equal(byWorldbook.status, 0, byWorldbook.stderr);
  assert.equal(byProject.value.项目.目录, byWorldbook.value.项目.目录);
  assert.equal(byWorldbook.value.项目.识别, '世界书目录');
  assert.deepEqual(byProject.value.计数, {来源资料文件: 0, 通读分卷文件: 0, 声明文件: 9, 世界概况文件: 2,
    扮演准则文件: 1, 条目库: 5, 角色组: 4, 档案: 11, 事件: 13, 事件串: 2, 开局选项: 2, 开局方案: 2,
    角色位置: 7, 暂存文件: 0, 候选文件: 0, 卡面文件: 0});
  assert.deepEqual(byProject.value.静态检查, {错误: 0, 提示: 0});
  assert.deepEqual(byProject.value.台词统计, {事件总数: 13, 有角色位置事件数: 4, 角色位置总数: 7,
    有台词角色位置数: 4, 缺台词角色位置数: 3, 候选台词总数: 4, 原台词数: 1, 作者台词数: 3,
    原台词占比: 0.25, 有事件级出处事件数: 13, 台词记录总数: 1});
  assert.equal(byProject.value.各层.第0层.已跳过, true);
  assert.equal(byProject.value.当前阶段, '第 4 层：档案与填景待补');
  assert.equal(byProject.value.推荐skill, '世界树·填景');
  assert.deepEqual(byProject.value.缺口, ['有 3 个角色位置缺候选台词', '项目根没有含 卡ID 或名为 卡面.yaml 的卡面文件']);
  assert.ok(byProject.value.各层.第3层.完成);
  assert.equal(byProject.value.各层.第4层.完成, false);

  const human = await run(runStatus, ['examples/雾港']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /当前阶段：第 4 层：档案与填景待补\n/u);
  assert.match(human.stdout, /第3层 骨架：角色组 4、档案 11、事件 13、事件串 2、开局选项 2、开局方案 2；静态检查 0 错误、0 提示\n/u);
  assert.match(human.stdout, /推荐skill：世界树·填景\n/u);
});

test('状态-3：半途项目按层判定并只读降级', async t => {
  const root = await makeProject(t);
  const read = path.join(root, '作者资料', '通读');
  await fs.mkdir(path.join(read, '分卷'), {recursive: true});
  await fs.writeFile(path.join(read, '分卷', '卷一.yaml'), '- 章节坐标\n');
  await fs.writeFile(path.join(read, '活词表.yaml'), '词: []\n');
  for (const name of ['世界体系汇总.yaml', '人物总名单与分期方案.yaml', '全书年表与因果事件表.yaml', 'if分岔与开局提案.yaml'])
    await fs.writeFile(path.join(read, name), 'x\n');
  await fs.writeFile(path.join(read, '待作者拍板清单.md'), 'x\n');
  const initialized = await run(runInit, [root, '--json']);
  assert.equal(initialized.status, 0, initialized.stderr);
  await fs.writeFile(path.join(root, '世界书', '世界概况', '总述.txt'), '世界背景\n');
  await fs.writeFile(path.join(root, '世界书', '扮演准则', '总则.txt'), '叙述准则\n');

  const atEntries = await run(runStatus, [root, '--json']);
  assert.equal(atEntries.status, 0);
  assert.equal(atEntries.value.当前阶段, '第 2 层：待建条目');
  assert.equal(atEntries.value.推荐skill, '世界树·条目');
  assert.ok(atEntries.value.缺口.some(item => item === '条目库 地点 为空'));

  await fs.mkdir(path.join(root, '世界书', '地点', '北湾'), {recursive: true});
  await fs.writeFile(path.join(root, '世界书', '地点', '北湾', '北湾.txt'), '地点ID: 北湾\n类型: 区域\n概况: 海湾\n');
  await fs.mkdir(path.join(root, '世界书', '势力', '官署'), {recursive: true});
  await fs.writeFile(path.join(root, '世界书', '势力', '官署', '港务署.txt'), '势力ID: 港务署\n类型: 组织\n概况: 港务\n');
  const atSkeleton = await run(runStatus, [root, '--json']);
  assert.equal(atSkeleton.value.当前阶段, '第 3 层：待建骨架');
  assert.equal(atSkeleton.value.推荐skill, '世界树·骨架');
  assert.ok(atSkeleton.value.缺口.some(item => item.includes('没有角色组')));

  // 静态检查有错只标注在结果中，不影响退出码。
  const broken = await fixture(t);
  await edit(broken, '设定/纪年.yaml', value => { value.年位数 = '坏'; });
  const checked = await run(runStatus, [broken, '--json']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(checked.value.静态检查.错误 >= 1);
  assert.ok(checked.value.缺口.some(item => item.startsWith('静态检查有')));
});

test('状态-4：inspectProjectStatus 注入、确定性与只读保证', async () => {
  const first = await inspectProjectStatus(path.join(project, 'examples/雾港'), {fs, path});
  const second = await inspectProjectStatus(path.join(project, 'examples/雾港'), {fs, path});
  assert.deepEqual(first, second);
  await assert.rejects(inspectProjectStatus(path.join(project, 'examples/不存在'), {fs, path}),
    error => error instanceof StatusError && error.code === '状态.路径');

  const guardFs = new Proxy(fs, {get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (first, ...rest) => {
      if (['writeFile', 'mkdir', 'rm', 'rename', 'unlink', 'rmdir'].includes(String(key)))
        throw new Error(`status 不得写入：${key}`);
      return value(first, ...rest);
    };
  }});
  const readonly = await run(runStatus, ['examples/雾港', '--json'], {fs: guardFs});
  assert.equal(readonly.status, 0, readonly.stderr);
  assert.deepEqual(readonly.value.异常, []);
});

test('状态-5：路径 B 仅 5 份全局总账判第 0 层完成', async t => {
  const root = await makeProject(t);
  const read = path.join(root, '作者资料', '通读');
  await fs.mkdir(read, {recursive: true});
  for (const name of ['世界体系汇总.yaml', '人物总名单与分期方案.yaml', '全书年表与因果事件表.yaml',
    'if分岔与开局提案.yaml', '待作者拍板清单.md']) await fs.writeFile(path.join(read, name), 'x\n');
  const result = await run(runStatus, [root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.各层.第0层.完成, true);
  assert.equal(result.value.各层.第0层.已跳过, false);
  assert.equal(result.value.当前阶段, '第 1 层：待建地基');
  assert.equal(result.value.推荐skill, '世界树·地基');
});

test('状态-6：刚 ygg init 完的项目跳过第 0 层判第 1 层', async t => {
  const root = await makeProject(t);
  const initialized = await run(runInit, [root, '--json']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = await run(runStatus, [root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.各层.第0层.已跳过, true);
  assert.equal(result.value.当前阶段, '第 1 层：待建地基');
  assert.equal(result.value.推荐skill, '世界树·地基');
});

test('状态-7：非法参数搭配 --json 输出 状态.参数', async t => {
  const root = await makeProject(t);
  const extra = await run(runStatus, [root, '多余参数', '--json']);
  assert.equal(extra.status, 1);
  assert.equal(extra.value.异常[0].规则, '状态.参数');
  assert.equal(extra.value.异常[0].文件, null);
  assert.equal(extra.value.异常[0].级别, '错误');
  const unknown = await run(runStatus, [root, '--未知', '--json']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.value.异常[0].规则, '状态.参数');
  const human = await run(runStatus, [root, '多余参数']);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /用法：ygg status/u);
  assert.equal(human.value, null);
});

test('初始化-1：默认纪年脚手架并直接通过静态检查', async t => {
  const root = await makeProject(t);
  const result = await run(runInit, [root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.value), ['项目目录', '世界书目录', '纪年', '已创建目录', '已写入文件', '跳过或覆盖说明', '异常']);
  assert.deepEqual(result.value.纪年, {前缀: '纪元', 年位数: 4, 月数: 12, 每月天数: 30});
  assert.deepEqual(result.value.已创建目录.sort(), ['世界书/扮演准则', '世界书/世界概况', '世界书/地点', '世界书/势力',
    '世界书/历史/事件', '世界书/历史/事件串', '世界书/历史/开局方案', '世界书/设定', '世界书/角色',
    '作者资料/出处', '作者资料/候选', '作者资料/归档', '作者资料/生成', '作者资料/暂存', '作者资料/通读/分卷', '来源资料'].sort());
  assert.deepEqual(result.value.已写入文件, ['世界书/设定/纪年.yaml', '世界书/设定/事件分类.yaml',
    '世界书/设定/本局变量.yaml', '世界书/设定/条目库.yaml']);
  assert.equal(result.value.跳过或覆盖说明, '全新创建；未跳过或覆盖任何已有文件');

  assert.equal(await fs.readFile(path.join(root, '世界书/设定/纪年.yaml'), 'utf8'),
    '前缀: 纪元\n年位数: 4\n月数: 12\n每月天数: 30\n');
  const libraries = await fs.readFile(path.join(root, '世界书/设定/条目库.yaml'), 'utf8');
  assert.match(libraries, /地点:\n {2}分法: 按上下级/u);
  assert.match(libraries, /势力:\n {2}分法: 按种类/u);
  assertFindings(await checkWorldbook(path.join(root, '世界书'), {sampling: false, fs, path}), [], '初始化-1 静态检查');

  const human = await run(runInit, [await makeProject(t)]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /已创建目录 16 个，已写入文件 4 份。/u);
});

test('初始化-2：自定义纪年与非法参数', async t => {
  const root = await makeProject(t);
  const result = await run(runInit, [root, '--纪年前缀', '星历', '--年位数', '3', '--月数', '5', '--每月天数', '7', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.value.纪年, {前缀: '星历', 年位数: 3, 月数: 5, 每月天数: 7});
  assertFindings(await checkWorldbook(path.join(root, '世界书'), {sampling: false, fs, path}), [], '初始化-2 静态检查');

  for (const args of [['--年位数', '0'], ['--年位数', '12'], ['--月数', 'x'], ['--每月天数', '1.5']]) {
    assert.throws(() => parseArgs(['/tmp/项目', ...args]), error => error?.code === '初始化.参数', JSON.stringify(args));
  }
  assert.throws(() => parseArgs([]), error => /缺少项目目录/u.test(error.message));
  assert.throws(() => parseArgs(['/tmp/项目', '--未知']), error => /未知选项/u.test(error.message));
  assert.throws(() => parseArgs(['/tmp/项目', '--纪年前缀']), error => /缺少值/u.test(error.message));
  assert.throws(() => parseArgs(['/tmp/项目', '--纪年前缀', ' 星历']), error => /首尾空白/u.test(error.message));
  assert.throws(() => parseArgs(['/tmp/项目', '--月数', '5', '--月数', '6']), error => /只能给出一次/u.test(error.message));

  for (const args of [['/tmp/项目', '--年位数', '0'], []]) {
    const failure = await run(runInit, [...args, '--json']);
    assert.equal(failure.status, 1, JSON.stringify(args));
    assert.equal(failure.value.异常[0].规则, '初始化.参数');
    assert.deepEqual(failure.value.已写入文件, []);
  }
});

test('初始化-3：已存在拒绝零写入，--force 只覆盖脚手架', async t => {
  const root = await makeProject(t);
  const settings = path.join(root, '世界书', '设定');
  await fs.mkdir(settings, {recursive: true});
  await fs.mkdir(path.join(root, '世界书', '世界概况'), {recursive: true});
  await fs.writeFile(path.join(settings, '纪年.yaml'), '前缀: 旧\n');
  await fs.writeFile(path.join(root, '世界书', '世界概况', '序.txt'), '用户已有内容\n');

  const conflict = await run(runInit, [root, '--json']);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.value.异常[0].规则, '初始化.已存在');
  assert.match(conflict.value.异常[0].说明, /世界书\/设定\/纪年\.yaml/u);
  assert.deepEqual(conflict.value.已创建目录, []);
  assert.deepEqual(conflict.value.已写入文件, []);
  await assert.rejects(fs.access(path.join(root, '世界书', '角色')), /ENOENT/u, '拒绝时不创建任何目录');
  assert.equal(await fs.readFile(path.join(settings, '纪年.yaml'), 'utf8'), '前缀: 旧\n');
  assert.equal(await fs.readFile(path.join(root, '世界书', '世界概况', '序.txt'), 'utf8'), '用户已有内容\n');

  const forced = await run(runInit, [root, '--force', '--纪年前缀', '新星历', '--json']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.value.跳过或覆盖说明, /--force 覆盖已存在的脚手架文件：世界书\/设定\/纪年\.yaml；其他已有文件与目录保持原状/u);
  assert.equal((await fs.readFile(path.join(settings, '纪年.yaml'), 'utf8')).split('\n')[0], '前缀: 新星历');
  assert.equal(await fs.readFile(path.join(root, '世界书', '世界概况', '序.txt'), 'utf8'), '用户已有内容\n');
  assertFindings(await checkWorldbook(path.join(root, '世界书'), {sampling: false, fs, path}), [], '初始化-3 force 后静态检查');
});

test('初始化-4：目标为已存在文件报初始化.路径', async t => {
  const root = await makeProject(t);
  const file = path.join(root, '挡路.md');
  await fs.writeFile(file, 'x\n');
  const result = await run(runInit, [file, '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.value.异常[0].规则, '初始化.路径');
  assert.match(result.value.异常[0].说明, /目标已存在且不是目录/u);
});
