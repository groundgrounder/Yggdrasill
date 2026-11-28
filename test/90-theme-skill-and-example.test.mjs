import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import {test, assert, fs, path, project} from './helpers.mjs';
import {packCard} from '../adapter/pack.mjs';
import {
  parseThemeYaml,
  validateThemeCss,
  validateThemeEntry,
  validateThemesDir,
  renderPreviewHtml,
} from '../skills/ygg-theme/scripts/theme-tool.mjs';

const execFileAsync = promisify(execFile);

async function spawnNode(script, args, cwd) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [script, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

test('YG-THEME-02：theme-tool.mjs 严格零第三方依赖且仅引入 node:* 内置模块', async () => {
  const scriptPath = path.join(project, 'skills', 'ygg-theme', 'scripts', 'theme-tool.mjs');
  const source = await fs.readFile(scriptPath, 'utf8');
  const imports = [...source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(imports.length > 0, '脚本应包含内置模块导入');
  for (const spec of imports) {
    assert.ok(spec.startsWith('node:'), `禁止引入非 node:* 模块：${spec}`);
    assert.ok(!spec.includes('..'), `禁止相对导入仓库文件：${spec}`);
  }
  assert.doesNotMatch(source, /\brequire\s*\(/u, '禁止使用 CommonJS require');
});

test('YG-THEME-02：parseThemeYaml / validateThemeCss / validateThemeEntry 核心边界校验', () => {
  const parsed = parseThemeYaml(`
# 注释
id: ink-scroll # 行内注释
name: "墨韵书卷"
default: true
base: classic
layout:
  每楼形态: card
  正文美化: true
  对白高亮: true
  首行缩进: false
tokens:
  --ygg-accent: "#b93a28"
  --ygg-dialogue-color: "color-mix(in srgb, #b93a28 58%, var(--ygg-text))"
css: |
  .ygg-prose-host[data-ygg-theme="ink-scroll"] p {
    letter-spacing: 0.03em;
  }
`);
  const validated = validateThemeEntry(parsed);
  assert.equal(validated.id, 'ink-scroll');
  assert.equal(validated.default, true);
  assert.equal(validated.base, 'classic');
  assert.equal(validated.layout.每楼形态, 'card');
  assert.equal(validated.tokens['--ygg-accent'], '#b93a28');
  assert.match(validated.css, /letter-spacing:\s*0\.03em/u);

  assert.equal(validateThemeCss('body { color: red; }').ok, false);
  assert.equal(validateThemeCss('@import "x.css";').ok, false);
  assert.equal(validateThemeCss('.ygg-panel { background: url(https://example.com/a.png); }').ok, false);
  assert.throws(() => parseThemeYaml('\tid: bad-indent\n'), /制表符/u);
  assert.throws(() => parseThemeYaml('- item1\n- item2\n'), /键值映射/u);
});

test('YG-THEME-02：skills/ygg-theme 独立复制到 /tmp 后脱离仓库运行 --help / validate 正反例 / preview', async t => {
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-theme-isolated-'));
  t.after(() => fs.rm(isolatedRoot, {recursive: true, force: true}));

  const isolatedSkillDir = path.join(isolatedRoot, 'ygg-theme');
  await fs.cp(path.join(project, 'skills', 'ygg-theme'), isolatedSkillDir, {recursive: true});
  const tool = path.join(isolatedSkillDir, 'scripts', 'theme-tool.mjs');

  // 1. --help
  const helpRes = await spawnNode(tool, ['--help'], isolatedRoot);
  assert.equal(helpRes.code, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /^用法：node theme-tool\.mjs/u);

  // 2. 单主题正例 + --json 脱敏
  const singleProj = path.join(isolatedRoot, 'single-proj');
  await fs.mkdir(path.join(singleProj, '外观'), {recursive: true});
  await fs.writeFile(path.join(singleProj, '外观', '主题.yaml'), `id: demo-ink
name: 示范墨卷
default: true
base: classic
layout: { 每楼形态: card, 正文美化: true, 对白高亮: true, 首行缩进: true }
tokens:
  --ygg-accent: "#a5382a"
`);
  await fs.writeFile(path.join(singleProj, '外观', '样式.css'),
    '.ygg-prose-host[data-ygg-theme="demo-ink"] blockquote { border-left-width: 4px; }\n');

  const singleJsonRes = await spawnNode(tool, ['validate', singleProj, '--json'], isolatedRoot);
  assert.equal(singleJsonRes.code, 0, singleJsonRes.stderr);
  assert.ok(!singleJsonRes.stdout.includes(isolatedRoot), '--json 输出不得泄露宿主机绝对路径');
  const singleJson = JSON.parse(singleJsonRes.stdout);
  assert.equal(singleJson.ok, true);
  assert.equal(singleJson.themeCount, 1);
  assert.equal(singleJson.themes[0].id, 'demo-ink');

  // 3. 多主题子目录正例
  const multiProj = path.join(isolatedRoot, 'multi-proj');
  await fs.mkdir(path.join(multiProj, '外观', '01-day'), {recursive: true});
  await fs.mkdir(path.join(multiProj, '外观', '02-night'), {recursive: true});
  await fs.writeFile(path.join(multiProj, '外观', '01-day', '主题.yaml'), 'id: theme-day\nname: 白昼\nbase: modern\n');
  await fs.writeFile(path.join(multiProj, '外观', '02-night', '主题.yaml'), 'id: theme-night\nname: 夜幕\nbase: cyber\ndefault: true\n');
  const multiRes = await spawnNode(tool, ['validate', multiProj, '--json'], isolatedRoot);
  assert.equal(multiRes.code, 0, multiRes.stderr);
  const multiJson = JSON.parse(multiRes.stdout);
  assert.equal(multiJson.ok, true);
  assert.equal(multiJson.themeCount, 2);
  assert.deepEqual(multiJson.themes.map(item => item.id), ['theme-day', 'theme-night']);

  // 4. preview 生成零外链有效 HTML
  const previewOut = path.join(isolatedRoot, 'out', 'preview.html');
  const previewRes = await spawnNode(tool, ['preview', singleProj, '--theme', 'demo-ink', '--mode', 'light', '--out', previewOut], isolatedRoot);
  assert.equal(previewRes.code, 0, previewRes.stderr);
  const html = await fs.readFile(previewOut, 'utf8');
  assert.match(html, /<!DOCTYPE html>/iu);
  assert.match(html, /data-preview-mode="light"/u);
  assert.match(html, /data-ygg-theme="demo-ink"/u);
  assert.match(html, /data-mode="dark"/u);
  assert.match(html, /data-mode="light"/u);
  assert.doesNotMatch(html, /https?:\/\//iu, '离线预览 HTML 严禁包含任何外链');

  // 5. 各类反例拦截
  async function expectReject(name, setupFn, pattern) {
    const badDir = path.join(isolatedRoot, `bad-${name}`);
    await fs.mkdir(path.join(badDir, '外观'), {recursive: true});
    await setupFn(path.join(badDir, '外观'));
    const res = await spawnNode(tool, ['validate', badDir], isolatedRoot);
    assert.equal(res.code, 1, `反例 ${name} 应失败，实际 exit 0`);
    assert.match(res.stderr, pattern, `反例 ${name} 错误信息不匹配：${res.stderr}`);
  }

  await expectReject('external-url', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: bad-url\nname: 外链\n');
    await fs.writeFile(path.join(dir, '样式.css'), '.ygg-panel { background: url(https://cdn.example/a.png); }\n');
  }, /外链 URL/u);

  await expectReject('at-import', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: bad-import\nname: 导入\n');
    await fs.writeFile(path.join(dir, '样式.css'), '@import "other.css";\n');
  }, /@import/u);

  await expectReject('bare-global', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: bad-global\nname: 全局\n');
    await fs.writeFile(path.join(dir, '样式.css'), 'body { background: red; }\n');
  }, /裸全局选择器/u);

  await expectReject('reserved-id', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: auto\nname: 保留字\n');
  }, /保留字/u);

  await expectReject('builtin-id', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: classic\nname: 重名内置\n');
  }, /内置主题重名/u);

  await expectReject('dup-id', async dir => {
    await fs.mkdir(path.join(dir, 'a'), {recursive: true});
    await fs.mkdir(path.join(dir, 'b'), {recursive: true});
    await fs.writeFile(path.join(dir, 'a', '主题.yaml'), 'id: dup-one\nname: 甲\n');
    await fs.writeFile(path.join(dir, 'b', '主题.yaml'), 'id: dup-one\nname: 乙\n');
  }, /重复/u);

  await expectReject('bad-token', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: bad-tok\nname: 非法令牌\ntokens:\n  --other-color: "#fff"\n');
  }, /非法令牌键/u);

  await expectReject('symlink', async dir => {
    await fs.writeFile(path.join(dir, '主题.yaml'), 'id: sym-test\nname: 软链\n');
    await fs.writeFile(path.join(isolatedRoot, 'outside.css'), '.ygg-panel { color: red; }\n');
    await fs.symlink(path.join(isolatedRoot, 'outside.css'), path.join(dir, '样式.css'));
  }, /符号链接/u);

  await expectReject('empty-dir', async () => {
    // 保留空外观目录
  }, /未在目标目录中找到任何主题配置/u);
});

test('YG-THEME-02：《三国演义》示范主题校验、打包内嵌与世界书哈希逐字节不变式', async t => {
  const sanguoDir = path.join(project, 'examples', '三国演义');
  const validated = await validateThemesDir(sanguoDir);
  assert.equal(validated.ok, true, validated.errors.join('\n'));
  assert.equal(validated.themes.length, 1);
  assert.equal(validated.themes[0].id, 'sanguo-scroll');
  assert.equal(validated.themes[0].default, true);
  assert.equal(validated.themes[0].base, 'classic');

  const html = renderPreviewHtml(validated.themes, {mode: 'dark'});
  assert.match(html, /data-ygg-theme="sanguo-scroll"/u);
  assert.doesNotMatch(html, /https?:\/\//iu);

  // 1. 带外观目录 prepareOnly 打包
  const outWith = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-sanguo-with-theme-'));
  const outWithout = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-sanguo-no-theme-'));
  const clonedProj = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-sanguo-clone-'));
  t.after(() => fs.rm(outWith, {recursive: true, force: true}));
  t.after(() => fs.rm(outWithout, {recursive: true, force: true}));
  t.after(() => fs.rm(clonedProj, {recursive: true, force: true}));

  const quiet = {write: () => {}};
  const resWith = await packCard({
    projectDir: sanguoDir,
    faceFile: path.join(sanguoDir, '卡面.yaml'),
    prepareOnly: true,
    repo: project,
    adapterDir: outWith,
    stdout: quiet,
    stderr: quiet,
  });
  const bundleWith = JSON.parse(await fs.readFile(resWith.bundleFile, 'utf8'));
  const sanguoTheme = bundleWith.themes.find(item => item.id === 'sanguo-scroll');
  assert.ok(sanguoTheme, 'bundle.themes 应包含 sanguo-scroll');
  assert.equal(sanguoTheme.default, true);
  assert.equal(sanguoTheme.source, 'card');
  assert.equal(sanguoTheme.base, 'classic');
  assert.equal(Object.keys(bundleWith.files).some(file => file.includes('外观')), false, 'bundle.files 不得包含 外观');

  // 2. 复制三国项目并删去 外观/ 后再次打包，世界书哈希须逐字节一致
  await fs.cp(sanguoDir, clonedProj, {recursive: true});
  await fs.rm(path.join(clonedProj, '外观'), {recursive: true, force: true});
  const resWithout = await packCard({
    projectDir: clonedProj,
    faceFile: path.join(clonedProj, '卡面.yaml'),
    prepareOnly: true,
    repo: project,
    adapterDir: outWithout,
    stdout: quiet,
    stderr: quiet,
  });
  const bundleWithout = JSON.parse(await fs.readFile(resWithout.bundleFile, 'utf8'));
  assert.deepEqual(bundleWithout.themes, []);
  assert.equal(resWith.manifest.世界书哈希, resWithout.manifest.世界书哈希, '增删外观目录不得改变世界书哈希');
});
