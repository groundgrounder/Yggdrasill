import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {test, assert, fs, path, example, project} from './helpers.mjs';
import {readDeclarations, validateDeclarations, loadWorldbook, createProtocol} from '../core/index.mjs';

const execute = promisify(execFile);
const cli = path.join(project, 'cli/ygg.mjs');

async function real(args) {
  try {
    const result = await execute(process.execPath, [cli, ...args], {cwd: project, maxBuffer: 4 * 1024 * 1024});
    return {status: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    return {status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function json(args) {
  const result = await real([...args, '--json']);
  return {...result, value: result.stdout ? JSON.parse(result.stdout) : null};
}

async function inputHash() {
  const files = [];
  for (const root of [example, path.join(path.dirname(example), '作者资料')]) {
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files.push([file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
      }
    }
    await walk(root);
  }
  files.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return createHash('sha256').update(files.map(([file, hash]) => `${hash}  ${file}\n`).join('')).digest('hex');
}

async function initializedState() {
  const root = example;
  const {raw} = await readDeclarations(root, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(root, {fs, path, decl});
  const protocol = createProtocol({catalog, decl});
  const state = protocol.confirmInitialization(protocol.seal({开局时间: '潮历074年'}), '秦守').state;
  assert.equal(state.角色.秦守.已初始化, true);
  return state;
}

test('预览-1：缺省以时间轴末尾封卷，输出档案、能力与装备', async t => {
  const result = await json(['preview', example, '秦守']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.value), ['角色组', '开局', '方案', '预览', '原因', '异常']);
  assert.equal(result.value.角色组, '秦守');
  assert.equal(result.value.开局, '潮历074年');
  assert.equal(result.value.方案, null);
  assert.equal(result.value.原因, null);
  assert.deepEqual(result.value.异常, []);
  assert.equal(result.value.预览.档案ID, '秦守·守塔期');
  assert.deepEqual(result.value.预览.能力, {技艺: {灯语: '名匠', 修船: '匠人'}, 名望: '匠人'});
  assert.deepEqual(result.value.预览.装备, [{装备ID: '工具·铜扳手', 状态: '完好', 位置: '随身工具袋'}]);

  const human = await real(['preview', example, '秦守']);
  assert.equal(human.status, 0);
  for (const heading of ['角色组：秦守', '开局：潮历074年', '方案：默认', '预览', '档案：秦守·守塔期', '装备：工具·铜扳手', '异常（0）'])
    assert.match(human.stdout, new RegExp(heading, 'u'));

  t.diagnostic(`preview 默认：${JSON.stringify(result.value)}`);
});

test('预览-2：--开局 与 --方案 分别生效', async t => {
  const early = await json(['preview', example, '灯塔学徒', '--开局', '潮历071年01月05日']);
  assert.equal(early.status, 0, early.stderr);
  assert.equal(early.value.开局, '潮历071年01月05日');
  assert.equal(early.value.预览.档案ID, '林澜·少年期');
  assert.deepEqual(early.value.预览.能力, {});
  assert.deepEqual(early.value.预览.装备, []);

  const plan = await json(['preview', example, '秦守', '--方案', '码头少年']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.value.方案, '码头少年');
  assert.equal(plan.value.开局, '潮历074年');
  assert.equal(plan.value.预览.档案ID, '秦守·守塔期');

  t.diagnostic(`--开局：${JSON.stringify(early.value)}；--方案：${JSON.stringify(plan.value)}`);
});

test('预览-3：未启用、已初始化与不存在的角色组', async t => {
  const disabled = await json(['preview', example, '周岚']);
  assert.equal(disabled.status, 0);
  assert.equal(disabled.value.预览, null);
  assert.equal(disabled.value.原因, '未启用');

  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ygg-preview-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const stateFile = path.join(directory, '本局.json');
  await fs.writeFile(stateFile, JSON.stringify(await initializedState()));
  const initialized = await json(['preview', example, '秦守', '--本局', stateFile]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(initialized.value.预览, null);
  assert.equal(initialized.value.原因, '已初始化');

  const missing = await json(['preview', example, '不存在']);
  assert.equal(missing.status, 1);
  assert.equal(missing.value.异常[0].规则, '预览.角色组');
  assert.match(missing.value.异常[0].说明, /角色组不存在/u);

  t.diagnostic(`未启用：${JSON.stringify(disabled.value)}；已初始化：${JSON.stringify(initialized.value)}；未知组：${JSON.stringify(missing.value)}`);
});

test('预览-4：JSON 固定键、重复运行只读、参数与本局错误', async t => {
  const before = await inputHash();
  const first = await json(['preview', example, '秦守']);
  const second = await json(['preview', example, '秦守']);
  const after = await inputHash();
  assert.equal(first.stdout, second.stdout);
  assert.equal(before, after);

  const conflict = await json(['preview', example, '秦守', '--本局', '/tmp/不存在.json', '--开局', '潮历074年']);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.value.异常[0].规则, '预览.参数');

  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ygg-preview-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const broken = path.join(directory, '坏本局.json');
  await fs.writeFile(broken, '{');
  const invalid = await json(['preview', example, '秦守', '--本局', broken]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.value.异常[0].规则, '预览.本局');

  const unsealed = path.join(directory, '未封卷.json');
  await fs.writeFile(unsealed, JSON.stringify({开局: {已封卷: false}, 世界: {}, 角色: {}, 事件: {}, 待定项: []}));
  const rejected = await json(['preview', example, '秦守', '--本局', unsealed]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.value.异常[0].规则, '预览.本局');

  t.diagnostic(`输入哈希 ${before} → ${after}；重复输出一致；冲突/坏本局/未封卷均退出 1`);
});

test('预览-5：--状态 --json 输出七键与封卷后完整角色状态，且人类可读输出稳定', async t => {
  const result = await json(['preview', example, '灯塔学徒', '--状态']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.equal(result.value.角色组, '灯塔学徒');
  assert.equal(result.value.状态.所在, '灯塔');
  assert.ok(Array.isArray(result.value.状态.身份) && result.value.状态.身份.includes('秦守的徒弟'));
  assert.equal(result.value.状态.关系?.秦守, '师徒');

  const human1 = await real(['preview', example, '灯塔学徒', '--状态']);
  const human2 = await real(['preview', example, '灯塔学徒', '--状态']);
  assert.equal(human1.status, 0, human1.stderr);
  assert.equal(human1.stdout, human2.stdout);
  const previewIndex = human1.stdout.indexOf('\n预览\n');
  const stateIndex = human1.stdout.indexOf('\n状态\n');
  const issueIndex = human1.stdout.indexOf('\n异常（0）\n');
  assert.ok(previewIndex !== -1 && stateIndex > previewIndex && issueIndex > stateIndex, human1.stdout);
  assert.match(human1.stdout, /  所在：灯塔/u);
  assert.match(human1.stdout, /  关系：秦守=师徒/u);

  t.diagnostic(`preview --状态：${JSON.stringify(result.value.状态)}`);
});

test('预览-6：--状态 配合 --开局 与 --方案 体现时间与路径状态差异', async t => {
  const early = await json(['preview', example, '灯塔学徒', '--开局', '潮历071年01月05日', '--状态']);
  assert.equal(early.status, 0, early.stderr);
  assert.deepEqual(Object.keys(early.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.deepEqual(early.value.状态, {});

  const earlyHuman = await real(['preview', example, '灯塔学徒', '--开局', '潮历071年01月05日', '--状态']);
  assert.equal(earlyHuman.status, 0, earlyHuman.stderr);
  assert.match(earlyHuman.stdout, /\n状态\n  无\n/u);

  const afterApprentice = await json(['preview', example, '灯塔学徒', '--开局', '潮历072年', '--状态']);
  assert.equal(afterApprentice.status, 0, afterApprentice.stderr);
  assert.equal(afterApprentice.value.状态.所在, '灯塔');
  assert.ok(afterApprentice.value.状态.身份.includes('秦守的徒弟'));

  const plan = await json(['preview', example, '灯塔学徒', '--方案', '码头少年', '--状态']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.value.方案, '码头少年');
  assert.ok(plan.value.状态.身份.includes('码头帮工'));
  assert.equal(plan.value.状态.所在, undefined);

  t.diagnostic(`早期：${JSON.stringify(early.value.状态)}；拜师后：${JSON.stringify(afterApprentice.value.状态)}；码头少年：${JSON.stringify(plan.value.状态)}`);
});

test('预览-7：--状态 支持未启用、--本局 已初始化角色与失败路径', async t => {
  const disabled = await json(['preview', example, '周岚', '--状态']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(Object.keys(disabled.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.equal(disabled.value.预览, null);
  assert.equal(disabled.value.原因, '未启用');
  assert.deepEqual(disabled.value.状态, {});

  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ygg-preview-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const stateFile = path.join(directory, '本局.json');
  await fs.writeFile(stateFile, JSON.stringify(await initializedState()));

  const initialized = await json(['preview', example, '秦守', '--本局', stateFile, '--状态']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(Object.keys(initialized.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.equal(initialized.value.预览, null);
  assert.equal(initialized.value.原因, '已初始化');
  assert.equal(initialized.value.状态.已初始化, true);
  assert.equal(initialized.value.状态.装备?.['工具·铜扳手']?.状态, '完好');

  const initHuman = await real(['preview', example, '秦守', '--本局', stateFile, '--状态']);
  assert.equal(initHuman.status, 0, initHuman.stderr);
  assert.match(initHuman.stdout, /预览：无（已初始化）/u);
  assert.match(initHuman.stdout, /  已初始化：是/u);
  assert.match(initHuman.stdout, /  装备：工具·铜扳手（完好，随身工具袋）/u);

  const missing = await json(['preview', example, '不存在', '--状态']);
  assert.equal(missing.status, 1);
  assert.deepEqual(Object.keys(missing.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.equal(missing.value.状态, null);
  assert.equal(missing.value.异常[0].规则, '预览.角色组');

  const badArg = await json(['preview', example, '秦守', '--本局', stateFile, '--开局', '潮历074年', '--状态']);
  assert.equal(badArg.status, 1);
  assert.deepEqual(Object.keys(badArg.value), ['角色组', '开局', '方案', '预览', '原因', '状态', '异常']);
  assert.equal(badArg.value.状态, null);
  assert.equal(badArg.value.异常[0].规则, '预览.参数');

  t.diagnostic(`未启用/已初始化/失败路径均符合 7 键与状态口径`);
});
