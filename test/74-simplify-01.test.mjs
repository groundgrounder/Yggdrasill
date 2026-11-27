import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';
import {promisify} from 'node:util';
import {test, assert, fs, path, project, fixture, write} from './helpers.mjs';
import {runCli} from '../cli/ygg.mjs';
import {parsePackArgs} from '../cli/pack.mjs';
import {packCard, PackError} from '../adapter/pack.mjs';
import {slugifyHeading} from '../scripts/check-docs.mjs';

const execFileAsync = promisify(execFile);
const cliEntry = path.join(project, 'cli', 'ygg.mjs');

async function cli(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {
    ...options,
    stdout: {write: value => { stdout += String(value); }},
    stderr: {write: value => { stderr += String(value); }},
  });
  return {code, stdout, stderr};
}

async function spawnNode(script, args, cwd = project) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [script, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function collectMarkdownFiles(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

function extractHeadings(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (!match) continue;
    const base = slugifyHeading(match[1].replace(/\s+#+\s*$/u, ''));
    let count = seen.get(base) ?? 0;
    let slug = count === 0 ? base : `${base}-${count}`;
    while (anchors.has(slug)) { count += 1; slug = `${base}-${count}`; }
    seen.set(base, count + 1);
    anchors.add(slug);
  }
  return anchors;
}

test('SIMPLIFY-01-A1：移除 .omp、启用 .agents/skills 软链，且 10 个 ygg-* skill 独立复制到 /tmp 仍零断链', async t => {
  await assert.rejects(fs.lstat(path.join(project, '.omp')), {code: 'ENOENT'});

  const agentsSkills = path.join(project, '.agents', 'skills');
  const linkStat = await fs.lstat(agentsSkills);
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await fs.readlink(agentsSkills), '../skills');

  const listed = (await fs.readdir(agentsSkills)).sort();
  const expectedSkills = [
    'ygg-edit', 'ygg-entries', 'ygg-foundation', 'ygg-guide', 'ygg-migrate',
    'ygg-pack', 'ygg-profile', 'ygg-read', 'ygg-scenes', 'ygg-skeleton',
  ];
  for (const name of ['README.md', 'shared', ...expectedSkills]) {
    assert.ok(listed.includes(name), `缺少 ${name}`);
  }

  for (const skillName of expectedSkills) {
    const srcSkillDir = path.join(project, 'skills', skillName);
    const mdFiles = await collectMarkdownFiles(srcSkillDir);
    assert.ok(mdFiles.some(file => path.basename(file) === 'SKILL.md'), `${skillName} 缺少 SKILL.md`);

    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ygg-skill-${skillName}-`));
    t.after(() => fs.rm(isolatedRoot, {recursive: true, force: true}));
    const isolatedSkillDir = path.join(isolatedRoot, skillName);
    await fs.cp(srcSkillDir, isolatedSkillDir, {recursive: true});

    for (const isolatedFile of await collectMarkdownFiles(isolatedSkillDir)) {
      const text = await fs.readFile(isolatedFile, 'utf8');
      assert.doesNotMatch(text, /\.\.\//u, `${skillName}/${path.relative(isolatedSkillDir, isolatedFile)} 不得包含 ../`);
      const stripped = text.replace(/`[^`]*`/gu, '');
      for (const match of stripped.matchAll(/!?\[[^\]]*\]\(([^)\r\n]+)\)/gu)) {
        const rawTarget = match[1].trim().replace(/^<(.+)>$/u, '$1');
        if (!rawTarget || /^(?:https?:|mailto:)/iu.test(rawTarget)) continue;
        const [relFile, anchor] = rawTarget.split('#');
        const targetAbs = relFile ? path.resolve(path.dirname(isolatedFile), relFile) : isolatedFile;
        const relToSkill = path.relative(isolatedSkillDir, targetAbs);
        assert.ok(!relToSkill.startsWith('..') && !path.isAbsolute(relToSkill), `${skillName} 链接越出本目录：${rawTarget}`);
        const stat = await fs.stat(targetAbs);
        assert.ok(stat.isFile(), `${skillName} 目标不存在：${rawTarget}`);
        if (anchor && targetAbs.endsWith('.md')) {
          const headings = extractHeadings(await fs.readFile(targetAbs, 'utf8'));
          assert.ok(headings.has(decodeURIComponent(anchor)), `${skillName} 失效锚点：${rawTarget}`);
        }
      }
    }

    if (skillName === 'ygg-migrate') {
      const isolatedScript = path.join(isolatedSkillDir, 'scripts', 'unpack-card.mjs');
      const helpRun = await spawnNode(isolatedScript, ['--help'], isolatedRoot);
      assert.equal(helpRun.code, 0, `独立复制的 ygg-migrate 脚本 --help 失败：${helpRun.stderr}`);
      assert.match(helpRun.stdout, /用法：node unpack-card\.mjs/u);
    }
  }

  for (const rel of ['README.md', 'docs/作者指南.md', 'skills/README.md',
    ...expectedSkills.map(name => `skills/${name}/SKILL.md`)]) {
    const content = await fs.readFile(path.join(project, rel), 'utf8');
    assert.doesNotMatch(content, /(?:^|[^a-zA-Z])omp(?:[^a-zA-Z]|$)/u, `${rel} 仍含 omp`);
    assert.doesNotMatch(content, /skills\.customDirectories|skill:\/\/|\.omp\/skills/u, `${rel} 仍含专有加载词`);
  }
});

test('SIMPLIFY-01-A2：ygg pack 参数解析、cwd 相对路径、缺省 卡面.yaml、打包产物与旧入口清理', async t => {
  assert.deepEqual(parsePackArgs([]), {project: null, face: null, prepareOnly: false, compatible: [], help: false});
  assert.deepEqual(parsePackArgs(['examples/三国演义', '--face', 'custom.yaml', '--prepare-only', '--compatible', 'a'.repeat(64)]),
    {project: 'examples/三国演义', face: 'custom.yaml', prepareOnly: true, compatible: ['a'.repeat(64)], help: false});
  assert.throws(() => parsePackArgs(['--未知']), /未知选项/);
  assert.throws(() => parsePackArgs(['--compatible', 'bad']), /64 位/);
  assert.throws(() => parsePackArgs(['a', 'b']), /多余的项目目录/);

  const helpRes = await cli(['pack', '--help']);
  assert.equal(helpRes.code, 0);
  assert.equal(helpRes.stderr, '');
  assert.match(helpRes.stdout, /用法：ygg pack/u);

  const badRes = await cli(['pack', '--compatible', 'xyz']);
  assert.equal(badRes.code, 1);
  assert.match(badRes.stderr, /用法：ygg pack/u);

  // 在项目目录内省略项目目录与 --face，自动按 cwd 定位项目和 <cwd>/卡面.yaml
  const worldbook = await fixture(t);
  const projectDir = path.dirname(worldbook);
  await fs.copyFile(path.join(project, 'test', 'fixtures', '雾港', '卡面.yaml'), path.join(projectDir, '卡面.yaml'));
  const cwdPrepare = await spawnNode(cliEntry, ['pack', '--prepare-only'], projectDir);
  assert.equal(cwdPrepare.code, 0, cwdPrepare.stderr);
  assert.match(cwdPrepare.stdout, /bundle\.generated\.json：/u);

  // 打包公开示例《三国演义》，验证产出且无 /作者资料/ 泄露
  const sanguoPack = await spawnNode(cliEntry, ['pack', 'examples/三国演义'], project);
  assert.equal(sanguoPack.code, 0, sanguoPack.stderr);
  assert.match(sanguoPack.stdout, /卡 .*三国演义·第一至三回\.json/u);
  const cardPath = path.join(project, 'adapter', 'dist', '三国演义·第一至三回.json');
  const cardText = await fs.readFile(cardPath, 'utf8');
  assert.ok(!cardText.includes('/作者资料/'), '产物不得泄露 /作者资料/');
  const card = JSON.parse(cardText);
  assert.equal(card.name, '三国演义·第一至三回');

  // 确认旧入口与过时目录已清理，且雾港夹具卡面已迁入 test/fixtures/雾港/卡面.yaml
  await assert.rejects(fs.lstat(path.join(project, 'legacy')), {code: 'ENOENT'});
  await assert.rejects(fs.lstat(path.join(project, 'adapter', ['build', 'mjs'].join('.'))), {code: 'ENOENT'});
  await assert.rejects(fs.lstat(path.join(project, 'adapter', '卡面.yaml')), {code: 'ENOENT'});
  const fixtureFaceStat = await fs.stat(path.join(project, 'test', 'fixtures', '雾港', '卡面.yaml'));
  assert.equal(fixtureFaceStat.isFile(), true);
});

test('YG-OPEN-01-A1：卡面按方案字段、逐方案干跑与 alternate_greetings 导出', async t => {
  const worldbook = await fixture(t);
  const projectDir = path.dirname(worldbook);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-open-pack-'));
  t.after(() => fs.rm(out, {recursive: true, force: true}));
  const quiet = {write: () => {}};
  const base = {
    卡ID: 'yggdrasill.wu-gang', 卡版本: '0.1.0', 名称: '雾港·多方案', 描述: '多方案打包测试。',
    开场白: '主开场白。\n\n第二段。',
    开局: {开局时间: '潮历071年04月01日'},
    开场命令: [
      {确认初始化: {角色组ID: '灯塔学徒'}},
      {写场景: {当前地点: {地标: '灯塔', 场景: '值守室'}, 在场: {灯塔学徒: true, 秦守: true}}},
    ],
    可选在场: ['秦守'],
    必需角色组: ['灯塔学徒'],
    按方案: {
      码头少年: {
        开场白: '码头开场白。',
        开场命令: [
          {确认初始化: {角色组ID: '白棠'}},
          {写场景: {当前地点: {地标: '码头区', 场景: '栈桥'}, 在场: {白棠: true}}},
        ],
        可选在场: ['白棠'],
        必需角色组: [],
      },
      补考之年: {开场白: '补考开场白。'},
    },
  };
  const faceFile = async (name, face) => {
    await write(projectDir, name, face);
    return path.join(projectDir, name);
  };
  const pack = (file, options = {}) => packCard({projectDir, faceFile: file,
    adapterDir: path.join(project, 'adapter'), repo: project, stdout: quiet, stderr: quiet, ...options});

  const file = await faceFile('卡面.yaml', base);
  const result = await pack(file);
  const bundle = JSON.parse(await fs.readFile(result.bundleFile, 'utf8'));
  assert.equal(bundle.openingGreeting, base.开场白);
  assert.deepEqual(bundle.openingOptionalPresent, ['秦守']);
  assert.deepEqual(bundle.openingRequiredGroups, ['灯塔学徒']);
  assert.deepEqual(Object.keys(bundle.planOpenings), ['码头少年', '补考之年']);
  assert.deepEqual(bundle.planOpenings.码头少年, base.按方案.码头少年);
  assert.deepEqual(bundle.planOpenings.补考之年, {开场白: '补考开场白。', 开场命令: base.开场命令,
    可选在场: base.可选在场, 必需角色组: base.必需角色组}, '方案未写字段应继承顶层');
  const card = JSON.parse(await fs.readFile(result.cardFile, 'utf8'));
  assert.equal(card.data.first_mes, base.开场白);
  assert.deepEqual(card.data.alternate_greetings, ['码头开场白。', '补考开场白。'],
    'alternate_greetings 按世界书方案顺序导出并去重');

  // 无按方案的单方案卡保持旧行为：bundle 新字段为空，alternate_greetings 为 []。
  const {按方案, ...single} = base;
  const singleFile = await faceFile('单方案.yaml', single);
  const singleResult = await pack(singleFile);
  const singleBundle = JSON.parse(await fs.readFile(singleResult.bundleFile, 'utf8'));
  assert.deepEqual(singleBundle.planOpenings, {});
  assert.deepEqual(singleBundle.openingOptionalPresent, ['秦守']);
  const singleCard = JSON.parse(await fs.readFile(singleResult.cardFile, 'utf8'));
  assert.deepEqual(singleCard.data.alternate_greetings, []);
  assert.equal(singleCard.data.first_mes, base.开场白);

  // 非法配置在打包阶段拒绝；结构性错误不写产物。
  const rejectFace = async (name, face, pattern) => {
    const badFile = await faceFile(name, face);
    await assert.rejects(pack(badFile, {prepareOnly: true, adapterDir: out}),
      error => error instanceof PackError && pattern.test(error.message), name);
  };
  await rejectFace('未知字段.yaml', {...base, 多余: 1}, /未授权字段/u);
  await rejectFace('未知方案.yaml', {...base, 按方案: {不存在: {}}}, /开局方案不存在：不存在/u);
  await rejectFace('未知方案键.yaml', {...base, 按方案: {码头少年: {摘要: 'x'}}}, /未授权字段：摘要/u);
  await rejectFace('冲突.yaml', {...base, 必需角色组: ['秦守']}, /同时出现在/u);
  await rejectFace('玩家.yaml', {...base, 可选在场: ['玩家']}, /不能包含“玩家”/u);
  await rejectFace('命令标签.yaml', {...base, 按方案: {码头少年: {开场白: '前<命令>后'}}}, /不得包含 <命令>/u);
  await rejectFace('干跑失败.yaml', {...base, 按方案: {码头少年: {开场命令: [{写场景: {在场: {白棠: '是'}}}]}}},
    /方案“码头少年”开场命令执行存在/u);
});

test('SIMPLIFY-01-A3：ygg view 支持位置参数与仓库示例自动回退系统临时目录，显式仓库内 --storage 仍拒绝', async t => {
  const forbiddenReviewDir = path.join(project, 'examples', '三国演义', '作者资料', '审阅器');
  await assert.rejects(fs.access(forbiddenReviewDir), {code: 'ENOENT'});

  const child = spawn(process.execPath, [cliEntry, 'view', 'examples/三国演义/世界书', '--port', '0'], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ygg view 启动超时：${stderr}`)), 15_000);
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(stdout);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', check);
    child.once('exit', code => {
      if (code !== null && !/http:\/\/127\.0\.0\.1:\d+/u.test(stdout)) {
        clearTimeout(timer);
        reject(new Error(`ygg view 提前退出(${code})：${stderr}`));
      }
    });
  });

  assert.match(stdout, /临时审阅目录（仓库内示例不写入仓库）/u);
  const storageMatch = /存储：([^\r\n]+)/u.exec(stdout);
  assert.ok(storageMatch, `未输出存储路径：${stdout}`);
  const tempStorage = storageMatch[1].trim();
  const relToTmp = path.relative(os.tmpdir(), tempStorage);
  assert.ok(!relToTmp.startsWith('..') && !path.isAbsolute(relToTmp), `存储应位于 os.tmpdir()：${tempStorage}`);
  await assert.rejects(fs.access(tempStorage), {code: 'ENOENT'}, '启动时不得提前在磁盘创建临时审阅目录');
  await assert.rejects(fs.access(forbiddenReviewDir), {code: 'ENOENT'}, '仓库内不得新建审阅目录');

  const pageRes = await fetch(url);
  assert.equal(pageRes.status, 200);
  const dataRes = await fetch(`${url}/api/data`);
  assert.equal(dataRes.status, 200);
  assert.equal((await dataRes.json()).元数据.计数.事件, 150);

  child.kill('SIGTERM');
  await once(child, 'exit');

  const explicitRejected = await spawnNode(cliEntry, [
    'view', 'examples/三国演义/世界书', '--storage', 'examples/三国演义/作者资料/审阅器', '--port', '0',
  ], project);
  assert.equal(explicitRejected.code, 1);
  assert.match(explicitRejected.stderr, /实现仓库/u);
});

test('SIMPLIFY-01-A4：node-url-shim 已清除「原型」字样且 presets 口径为可选开箱预设', async () => {
  const shim = await fs.readFile(path.join(project, 'adapter', 'node-url-shim.mjs'), 'utf8');
  assert.doesNotMatch(shim, /原型/u);
  assert.match(shim, /浏览器环境中不可用：fileURLToPath/u);

  for (const rel of ['README.md', 'docs/作者指南.md', 'docs/06-酒馆适配.md']) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    assert.match(text, /可选开箱预设/u, `${rel} 应标明 presets/yggdrasill.json 为可选开箱预设`);
  }
});
