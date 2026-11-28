import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import os from 'node:os';
import zlib from 'node:zlib';
import {assert, test, fs, path, project, createTempPackRepo} from './helpers.mjs';
import {packCard} from '../adapter/pack.mjs';
import {
  UnpackError,
  parsePngCard,
  readCardFile,
  extractBundleFromScript,
  inspectCard,
  createCardMemFs,
  buildFaceYaml,
  unpackCard,
} from '../adapter/unpack.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {whatIf} from '../core/what-if.mjs';
import {previewContext} from '../core/context-preview.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {loadProject, loadViewData} from '../view/data.mjs';
import {startViewServer} from '../view/server.mjs';
import {runCli} from '../cli/ygg.mjs';
import {parseViewArgs} from '../cli/view.mjs';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(project, 'cli/ygg.mjs');
const THEME_TOOL = path.join(project, 'skills/ygg-theme/scripts/theme-tool.mjs');
const WUGANG_DIR = path.join(project, 'test/fixtures/雾港');
const SANGUO_DIR = path.join(project, 'examples/三国演义');

// ---------- 纯 Node PNG 测试卡构造器（支持 tEXt / zTXt / iTXt） ----------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeTextChunk(type, keyword, payloadText, {compressed = false} = {}) {
  const keyBuf = Buffer.from(keyword, 'latin1');
  if (type === 'tEXt') {
    return pngChunk('tEXt', Buffer.concat([keyBuf, Buffer.from([0]), Buffer.from(payloadText, 'latin1')]));
  }
  if (type === 'zTXt') {
    const deflated = zlib.deflateSync(Buffer.from(payloadText, 'latin1'));
    return pngChunk('zTXt', Buffer.concat([keyBuf, Buffer.from([0, 0]), deflated]));
  }
  if (type === 'iTXt') {
    const raw = Buffer.from(payloadText, 'utf8');
    const body = compressed ? zlib.deflateSync(raw) : raw;
    return pngChunk('iTXt', Buffer.concat([
      keyBuf,
      Buffer.from([0, compressed ? 1 : 0, 0, 0, 0]),
      body,
    ]));
  }
  throw new Error(`unsupported chunk type: ${type}`);
}

function buildTestPng(chunks = []) {
  // 1x1 透明 RGBA PNG
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    ...chunks,
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function cardToBase64(cardObj) {
  return Buffer.from(JSON.stringify(cardObj), 'utf8').toString('base64');
}

async function runCliCapture(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {
    ...options,
    stdout: {write: text => { stdout += String(text); }},
    stderr: {write: text => { stderr += String(text); }},
  });
  return {code, stdout, stderr};
}

async function spawnView(args, cwd = project) {
  const child = spawn(process.execPath, [CLI_ENTRY, 'view', ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {child, stdout: () => stdout, stderr: () => stderr};
}

async function waitForUrl(spawned) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`命令行未输出 URL：${spawned.stderr()}`)), 15_000);
    const check = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(spawned.stdout());
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    spawned.child.stdout.on('data', check);
    spawned.child.once('exit', code => {
      if (code !== null && !/http:\/\/127\.0\.0\.1:\d+/u.test(spawned.stdout())) {
        clearTimeout(timer);
        reject(new Error(`命令行提前退出：${code} ${spawned.stderr()}`));
      }
    });
    check();
  });
}

async function packIsolated(t, projectDir, faceFile = path.join(projectDir, '卡面.yaml')) {
  const tmpRepo = await createTempPackRepo(t, 'ygg-unpack-pack-');
  const adapterDir = path.join(tmpRepo, 'adapter');
  let out = '', err = '';
  const packed = await packCard({
    projectDir,
    faceFile,
    repo: tmpRepo,
    adapterDir,
    stdout: {write: text => { out += String(text); }},
    stderr: {write: text => { err += String(text); }},
  });
  return {...packed, tmpRepo, stdout: out, stderr: err};
}

const silentIo = () => ({stdout: {write: () => {}}, stderr: {write: () => {}}});

// ---------- 测试用例 ----------

test('解包-安全-1：adapter/unpack.mjs 零代码执行审计与纯静态字面量解析器边界', async () => {
  const source = await fs.readFile(path.join(project, 'adapter/unpack.mjs'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(/u, '禁止 eval');
  assert.doesNotMatch(source, /\bnew\s+Function\b/u, '禁止 new Function');
  assert.doesNotMatch(source, /['"]node:vm['"]|from\s+['"]vm['"]/u, '禁止 node:vm');
  assert.doesNotMatch(source, /data:text\/javascript/u, '禁止 data:text/javascript 动态导入');

  const script = `
    // adapter/bundle.generated.json
    var bundle_generated_default = {
      root: "/项目/世界书",
      单引号: '含 <\\/script> 与 \\'单引号\\' 与 \\"双引号\\" 与 \\\\ \\n\\r\\t\\b\\f\\v\\0\\x41\\u4e2d\\u{1F333}',
      数字: [-0, 42, -3.14, .5, 1e3, 2.5e-2],
      布尔与空: [true, false, null,],
      nested: { 0: "numkey", 键_1: "ok", },
    };
  `;
  const parsed = extractBundleFromScript(script);
  assert.equal(parsed.root, '/项目/世界书');
  assert.equal(parsed.单引号, '含 </script> 与 \'单引号\' 与 "双引号" 与 \\ \n\r\t\b\f\v\0A中🌳');
  assert.deepEqual(parsed.数字, [-0, 42, -3.14, 0.5, 1000, 0.025]);
  assert.deepEqual(parsed.布尔与空, [true, false, null]);
  assert.deepEqual(parsed.nested, {0: 'numkey', 键_1: 'ok'});

  for (const [label, badScript] of [
    ['函数调用值', 'var bundle_generated_default = { root: evil() };'],
    ['函数调用顶层', 'var bundle_generated_default = buildBundle();'],
    ['二元表达式', 'var bundle_generated_default = { a: 1 + 2 };'],
    ['尾随表达式', 'var bundle_generated_default = { a: 1 } + evil();'],
    ['模板字符串', 'var bundle_generated_default = { a: `hello` };'],
    ['未知标识符', 'var bundle_generated_default = { a: process };'],
    ['原型键 __proto__', 'var bundle_generated_default = { "__proto__": { polluted: true } };'],
    ['原型键 constructor', 'var bundle_generated_default = { constructor: {} };'],
    ['原型键 prototype', 'var bundle_generated_default = { prototype: {} };'],
  ]) {
    assert.throws(
      () => extractBundleFromScript(badScript),
      error => error instanceof UnpackError && error.code === 'unpack.校验失败',
      `应拦截：${label}`,
    );
  }

  assert.throws(
    () => extractBundleFromScript('console.log("not ygg");'),
    error => error instanceof UnpackError && error.code === 'unpack.非世界树卡' && error.message.includes('世界树·迁移'),
  );
});

test('解包-格式-1：PNG tEXt / zTXt / iTXt 解析、ccv3 优先与文件安全校验', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-unpack-fmt-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  const cardChara = {spec: 'chara_card_v2', data: {name: '来自chara'}};
  const cardV3 = {spec: 'chara_card_v3', data: {name: '来自ccv3'}};

  const pngText = buildTestPng([makeTextChunk('tEXt', 'chara', cardToBase64(cardChara))]);
  assert.equal(parsePngCard(pngText).card.data.name, '来自chara');
  assert.equal(parsePngCard(pngText).chunkType, 'tEXt');

  const pngZtxt = buildTestPng([makeTextChunk('zTXt', 'chara', cardToBase64(cardChara))]);
  assert.equal(parsePngCard(pngZtxt).card.data.name, '来自chara');
  assert.equal(parsePngCard(pngZtxt).chunkType, 'zTXt');

  const pngItxtPlain = buildTestPng([
    makeTextChunk('tEXt', 'chara', cardToBase64(cardChara)),
    makeTextChunk('iTXt', 'ccv3', cardToBase64(cardV3), {compressed: false}),
  ]);
  const resPlain = parsePngCard(pngItxtPlain);
  assert.equal(resPlain.card.data.name, '来自ccv3');
  assert.equal(resPlain.chunk, 'ccv3');
  assert.equal(resPlain.chunkType, 'iTXt');

  const pngItxtCompressed = buildTestPng([
    makeTextChunk('zTXt', 'chara', cardToBase64(cardChara)),
    makeTextChunk('iTXt', 'ccv3', cardToBase64(cardV3), {compressed: true}),
  ]);
  const resComp = parsePngCard(pngItxtCompressed);
  assert.equal(resComp.card.data.name, '来自ccv3');
  assert.equal(resComp.chunk, 'ccv3');
  assert.equal(resComp.chunkType, 'iTXt');

  // 改名成 .json 的 PNG 仍按魔数识别为 PNG
  const renamedPng = path.join(tmpDir, 'renamed.json');
  await fs.writeFile(renamedPng, pngItxtCompressed);
  const readRenamed = await readCardFile(renamedPng);
  assert.equal(readRenamed.format, 'png');
  assert.equal(readRenamed.card.data.name, '来自ccv3');
  assert.ok(Buffer.isBuffer(readRenamed.pngBuffer) && readRenamed.pngBuffer.equals(pngItxtCompressed));

  // 拒绝符号链接输入与非对象顶层 JSON
  const symPath = path.join(tmpDir, 'link.png');
  await fs.symlink(renamedPng, symPath);
  await assert.rejects(() => readCardFile(symPath), error => error instanceof UnpackError && error.code === 'unpack.失败');

  const arrJson = path.join(tmpDir, 'array.json');
  await fs.writeFile(arrJson, '[1, 2, 3]\n', 'utf8');
  await assert.rejects(() => readCardFile(arrJson), error => error instanceof UnpackError && error.code === 'unpack.失败');

  // 无 chara/ccv3 区块的普通 PNG
  const plainPng = buildTestPng([]);
  assert.throws(
    () => parsePngCard(plainPng),
    error => error instanceof UnpackError && error.code === 'unpack.非世界树卡' && error.message.includes('世界树·迁移'),
  );
});

test('解包-校验-1：非世界树酒馆卡、哈希篡改与非法路径注入拦截', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-unpack-sec-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  // 1. 普通 SillyTavern 角色卡（不含世界树脚本）
  const plainCardPath = path.join(tmpDir, 'ordinary-card.json');
  await fs.writeFile(plainCardPath, JSON.stringify({
    spec: 'chara_card_v2',
    data: {name: '普通酒馆卡', description: '普通卡', first_mes: '你好', extensions: {}},
  }), 'utf8');
  const outOrdinary = path.join(tmpDir, 'out-ordinary');
  await assert.rejects(
    () => unpackCard(plainCardPath, outOrdinary),
    error => error instanceof UnpackError
      && error.code === 'unpack.非世界树卡'
      && error.message.includes('世界树·迁移')
      && error.message.includes('skills/ygg-migrate/'),
  );
  await assert.rejects(() => fs.access(outOrdinary), {code: 'ENOENT'});

  // 2. 打包雾港，然后篡改卡内文件内容触发 unpack.校验失败
  const packed = await packIsolated(t, WUGANG_DIR);
  const originalCard = JSON.parse(await fs.readFile(packed.cardFile, 'utf8'));
  const tamperedCard = structuredClone(originalCard);
  const scriptObj = tamperedCard.data.extensions.tavern_helper.scripts[0];
  assert.ok(scriptObj.content.includes('灯语'), '打包卡应含世界书文本');
  scriptObj.content = scriptObj.content.replace('灯语', '灯谜');
  const tamperedPath = path.join(tmpDir, 'tampered.json');
  await fs.writeFile(tamperedPath, JSON.stringify(tamperedCard), 'utf8');
  await assert.rejects(
    () => inspectCard(tamperedPath),
    error => error instanceof UnpackError && error.code === 'unpack.校验失败' && error.message.includes('哈希'),
  );

  // 3. 注入非法路径（/项目/作者资料/x.txt 与 ../逃逸）
  for (const badPath of ['/项目/作者资料/x.txt', '/项目/世界书/../逃逸.txt']) {
    const injectedCard = {
      spec: 'chara_card_v2',
      data: {
        name: '注入卡',
        description: 'desc',
        first_mes: 'hi',
        extensions: {
          tavern_helper: {
            scripts: [{
              name: '世界树',
              content: `// adapter/bundle.generated.json\nvar bundle_generated_default = ${JSON.stringify({
                root: '/项目/世界书',
                files: {
                  '/项目/世界书/设定/纪年.yaml': '前缀: 纪元\n',
                  [badPath]: 'secret',
                },
                manifest: {
                  卡ID: 'test.bad',
                  卡版本: '0.1.0',
                  程序版本: '0.1.3',
                  世界书哈希: '0'.repeat(64),
                  程序指纹: '0'.repeat(64),
                },
              })};\n`,
            }],
          },
        },
      },
    };
    const badFile = path.join(tmpDir, `bad-${badPath.includes('作者资料') ? 'author' : 'escape'}.json`);
    await fs.writeFile(badFile, JSON.stringify(injectedCard), 'utf8');
    await assert.rejects(
      () => inspectCard(badFile),
      error => error instanceof UnpackError && error.code === 'unpack.校验失败',
      `应拦截非法路径 ${badPath}`,
    );
  }
});

test('解包-闭环-1：雾港 JSON（含 yggdrasill.yaml 与按方案配置）解包、检查与重打哈希一致', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-unpack-wugang-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  const srcProject = path.join(tmpDir, 'wugang-src');
  await fs.cp(WUGANG_DIR, srcProject, {recursive: true});
  const settingsYaml = '运行参数:\n  经历:\n    条数: 8\n    字符: 3500\n';
  await fs.writeFile(path.join(srcProject, 'yggdrasill.yaml'), settingsYaml, 'utf8');

  // 扩展卡面以测试 可选在场 / 必需角色组 / 按方案 还原闭环
  const facePath = path.join(srcProject, '卡面.yaml');
  const baseFace = await fs.readFile(facePath, 'utf8');
  const extendedFace = `${baseFace}可选在场: [白棠]\n必需角色组: [灯塔学徒]\n按方案:\n  码头少年:\n    开场白: |-\n      潮历071年04月初，码头区清晨。\n    可选在场: []\n    必需角色组: [灯塔学徒, 白棠]\n`;
  await fs.writeFile(facePath, extendedFace, 'utf8');

  const packed = await packIsolated(t, srcProject);
  const outDir = path.join(tmpDir, 'wugang-unpacked');
  const cliRes = await runCliCapture(['unpack', packed.cardFile, '-o', outDir, '--json']);
  assert.equal(cliRes.code, 0, cliRes.stderr);
  assert.equal(cliRes.stderr, '');
  const summary = JSON.parse(cliRes.stdout);
  assert.deepEqual(Object.keys(summary), [
    '来源', '格式', '卡信息', '输出目录', '世界书文件数',
    '含运行参数', '主题数', '已提取封面', '世界书哈希', '已写入文件', '异常',
  ]);
  assert.equal(summary.格式, 'json');
  assert.equal(summary.含运行参数, true);
  assert.equal(summary.主题数, 0);
  assert.equal(summary.已提取封面, false);
  assert.equal(summary.世界书哈希, packed.manifest.世界书哈希);
  assert.deepEqual(summary.异常, []);

  assert.equal(await fs.readFile(path.join(outDir, 'yggdrasill.yaml'), 'utf8'), settingsYaml);
  const unpackedFace = parseYaml(await fs.readFile(path.join(outDir, '卡面.yaml'), 'utf8'));
  assert.equal(unpackedFace.卡ID, 'yggdrasill.wu-gang');
  assert.deepEqual(unpackedFace.可选在场, ['白棠']);
  assert.deepEqual(unpackedFace.必需角色组, ['灯塔学徒']);
  assert.deepEqual(unpackedFace.按方案.码头少年.可选在场, []);
  assert.deepEqual(unpackedFace.按方案.码头少年.必需角色组, ['灯塔学徒', '白棠']);

  // 还原后的世界书通过 ygg check（0 错误）
  const checkRes = await checkWorldbook(path.join(outDir, '世界书'));
  assert.equal(checkRes.errors.length, 0, JSON.stringify(checkRes.errors));

  // 重新打包成功且世界书哈希逐字节一致
  const repacked = await packIsolated(t, outDir);
  assert.equal(repacked.manifest.世界书哈希, packed.manifest.世界书哈希);
  assert.equal(repacked.manifest.程序指纹, packed.manifest.程序指纹);
  const origInspected = await inspectCard(packed.cardFile);
  const repackedInspected = await inspectCard(repacked.cardFile);
  assert.deepEqual(repackedInspected.bundle.planOpenings, origInspected.bundle.planOpenings);
});

test('解包-闭环-2：三国演义 PNG（含外观主题与封面）解包、主题校验、多主题与重打等价', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-unpack-sanguo-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  const packed = await packIsolated(t, SANGUO_DIR);
  const cardObj = JSON.parse(await fs.readFile(packed.cardFile, 'utf8'));
  const pngBytes = buildTestPng([
    makeTextChunk('tEXt', 'chara', cardToBase64(cardObj)),
    makeTextChunk('iTXt', 'ccv3', cardToBase64(cardObj), {compressed: true}),
  ]);
  const pngPath = path.join(tmpDir, 'sanguo.png');
  await fs.writeFile(pngPath, pngBytes);

  const outDir = path.join(tmpDir, 'sanguo-unpacked');
  const cliRes = await runCliCapture(['unpack', pngPath, '-o', outDir]);
  assert.equal(cliRes.code, 0, cliRes.stderr);
  assert.match(cliRes.stdout, /三国演义·第一至三回/u);
  assert.match(cliRes.stdout, /PNG/u);
  assert.match(cliRes.stdout, /封面\.png：已提取/u);
  assert.match(cliRes.stdout, new RegExp(packed.manifest.世界书哈希.slice(0, 12)));

  // 校验关键还原产物与封面字节一致且封面不进入世界书
  const coverBytes = await fs.readFile(path.join(outDir, '封面.png'));
  assert.ok(coverBytes.equals(pngBytes));
  await assert.rejects(() => fs.access(path.join(outDir, '世界书', '封面.png')), {code: 'ENOENT'});
  await fs.access(path.join(outDir, '卡面.yaml'));
  await fs.access(path.join(outDir, '外观/主题.yaml'));
  await fs.access(path.join(outDir, '外观/样式.css'));

  // ygg check 0 错误
  const checkRes = await checkWorldbook(path.join(outDir, '世界书'));
  assert.equal(checkRes.errors.length, 0, JSON.stringify(checkRes.errors));

  // theme-tool.mjs validate 0 错误
  const themeExec = await execFileAsync(process.execPath, [THEME_TOOL, 'validate', outDir, '--json'], {cwd: project});
  const themeReport = JSON.parse(themeExec.stdout);
  assert.equal(themeReport.ok, true, JSON.stringify(themeReport));
  assert.equal(themeReport.errors.length, 0);

  // 重打且世界书哈希与 bundle.themes 完全等价
  const repacked = await packIsolated(t, outDir);
  assert.equal(repacked.manifest.世界书哈希, packed.manifest.世界书哈希);
  const origInspected = await inspectCard(pngPath);
  const repackedInspected = await inspectCard(repacked.cardFile);
  assert.deepEqual(repackedInspected.bundle.themes, origInspected.bundle.themes);
  assert.equal(repackedInspected.bundle.themes[0].id, 'sanguo-scroll');

  // 多主题（2 套）解包为 外观/<theme.id>/ 并可重打
  const multiSrc = path.join(tmpDir, 'multi-theme-src');
  await fs.cp(WUGANG_DIR, multiSrc, {recursive: true});
  await fs.mkdir(path.join(multiSrc, '外观/alpha-theme'), {recursive: true});
  await fs.mkdir(path.join(multiSrc, '外观/beta-theme'), {recursive: true});
  await fs.writeFile(path.join(multiSrc, '外观/alpha-theme/主题.yaml'),
    'id: alpha-theme\nname: 主题甲\ndefault: true\nbase: modern\ntokens:\n  --ygg-accent: "#336699"\n', 'utf8');
  await fs.writeFile(path.join(multiSrc, '外观/alpha-theme/样式.css'),
    '.ygg-panel[data-ygg-theme="alpha-theme"] { letter-spacing: 0.01em; }\n', 'utf8');
  await fs.writeFile(path.join(multiSrc, '外观/beta-theme/主题.yaml'),
    'id: beta-theme\nname: 主题乙\nbase: classic\n', 'utf8');

  const packedMulti = await packIsolated(t, multiSrc);
  const multiOut = path.join(tmpDir, 'multi-unpacked');
  const multiRes = await unpackCard(packedMulti.cardFile, multiOut);
  assert.equal(multiRes.主题数, 2);
  await fs.access(path.join(multiOut, '外观/alpha-theme/主题.yaml'));
  await fs.access(path.join(multiOut, '外观/alpha-theme/样式.css'));
  await fs.access(path.join(multiOut, '外观/beta-theme/主题.yaml'));
  const repackedMulti = await packIsolated(t, multiOut);
  assert.equal(repackedMulti.manifest.世界书哈希, packedMulti.manifest.世界书哈希);
  const repackedMultiInspected = await inspectCard(repackedMulti.cardFile);
  assert.deepEqual(
    repackedMultiInspected.bundle.themes.map(item => item.id),
    ['alpha-theme', 'beta-theme'],
  );
});

test('解包-护栏-1：--force 保留无关文件、非空拒绝、祖先目录拦截与 CLI 参数校验', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-unpack-guard-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  const packed = await packIsolated(t, WUGANG_DIR);
  const cardCopyDir = path.join(tmpDir, 'cards');
  await fs.mkdir(cardCopyDir, {recursive: true});
  const cardPath = path.join(cardCopyDir, 'wugang.json');
  await fs.copyFile(packed.cardFile, cardPath);

  // 非空输出目录且无 --force：报 unpack.已存在 退出 1 且零写入
  const targetDir = path.join(tmpDir, 'target');
  await fs.mkdir(path.join(targetDir, '用户笔记'), {recursive: true});
  await fs.writeFile(path.join(targetDir, '保留我.txt'), 'important-data', 'utf8');
  await fs.writeFile(path.join(targetDir, '用户笔记/想法.md'), 'keep', 'utf8');

  const noForce = await runCliCapture(['unpack', cardPath, '-o', targetDir, '--json']);
  assert.equal(noForce.code, 1);
  assert.match(noForce.stderr, /unpack\.已存在/u);
  assert.equal(JSON.parse(noForce.stdout).异常[0].规则, 'unpack.已存在');
  await assert.rejects(() => fs.access(path.join(targetDir, '世界书')), {code: 'ENOENT'});
  await assert.rejects(() => fs.access(path.join(targetDir, '卡面.yaml')), {code: 'ENOENT'});
  assert.equal(await fs.readFile(path.join(targetDir, '保留我.txt'), 'utf8'), 'important-data');

  // 带 --force：仅覆写还原内容并保留无关文件
  await fs.mkdir(path.join(targetDir, '世界书'), {recursive: true});
  await fs.writeFile(path.join(targetDir, '世界书/旧残留.txt'), 'stale', 'utf8');
  const withForce = await runCliCapture(['unpack', cardPath, '-o', targetDir, '--force']);
  assert.equal(withForce.code, 0, withForce.stderr);
  assert.equal(await fs.readFile(path.join(targetDir, '保留我.txt'), 'utf8'), 'important-data');
  assert.equal(await fs.readFile(path.join(targetDir, '用户笔记/想法.md'), 'utf8'), 'keep');
  await assert.rejects(() => fs.access(path.join(targetDir, '世界书/旧残留.txt')), {code: 'ENOENT'});
  await fs.access(path.join(targetDir, '卡面.yaml'));

  // 拒绝输出目录包含输入卡文件（祖先目录护栏）
  const ancestorErr = await runCliCapture(['unpack', cardPath, '-o', tmpDir, '--force']);
  assert.equal(ancestorErr.code, 1);
  assert.match(ancestorErr.stderr, /unpack\.参数/u);
  await fs.access(cardPath);

  // 拒绝文件系统根目录
  const rootErr = await runCliCapture(['unpack', cardPath, '-o', path.parse(tmpDir).root]);
  assert.equal(rootErr.code, 1);
  assert.match(rootErr.stderr, /unpack\.参数/u);

  // --help 与 -h 退出 0
  for (const flag of ['--help', '-h']) {
    const helpRes = await runCliCapture(['unpack', flag]);
    assert.equal(helpRes.code, 0);
    assert.equal(helpRes.stderr, '');
    assert.match(helpRes.stdout, /用法：ygg unpack/u);
  }

  // 缺参 / 重复 -o / 未知选项
  for (const badArgs of [
    ['unpack'],
    ['unpack', cardPath],
    ['unpack', cardPath, '-o', targetDir, '--out', targetDir],
    ['unpack', cardPath, '-o', targetDir, '--unknown'],
  ]) {
    const res = await runCliCapture(badArgs);
    assert.equal(res.code, 1, JSON.stringify(badArgs));
    assert.match(res.stderr, /unpack\.参数/u, JSON.stringify(badArgs));
  }
});

test('视图-只读卡-1：createCardMemFs 纯内存支持 check / loadViewData / previewContext / whatIf', async t => {
  const packed = await packIsolated(t, WUGANG_DIR);
  const inspected = await inspectCard(packed.cardFile);
  const mem = createCardMemFs(inspected.bundle.files);

  // readdir 支持 withFileTypes 与字符串名两种形式
  const names = await mem.fs.readdir('/项目/世界书');
  assert.ok(Array.isArray(names) && names.includes('设定') && names.every(item => typeof item === 'string'));
  const dirents = await mem.fs.readdir('/项目/世界书', {withFileTypes: true});
  assert.ok(dirents.every(item => typeof item.isFile === 'function' && item.isSymbolicLink() === false));
  assert.equal((await mem.fs.stat('/项目/世界书')).isDirectory(), true);
  assert.equal((await mem.fs.lstat('/项目/世界书/设定/纪年.yaml')).isFile(), true);
  assert.equal(await mem.fs.realpath('/项目/世界书/设定/纪年.yaml'), '/项目/世界书/设定/纪年.yaml');

  const checkRes = await checkWorldbook('/项目/世界书', {fs: mem.fs, path: mem.path});
  assert.equal(checkRes.errors.length, 0, JSON.stringify(checkRes.errors));

  const viewData = await loadViewData('/项目/世界书', {fs: mem.fs, path: mem.path});
  assert.equal(viewData.元数据.计数.事件, 13);
  assert.equal(viewData.元数据.计数.角色组, 4);

  const ctx = await previewContext('/项目/世界书', {
    fs: mem.fs,
    path: mem.path,
    地点: '灯塔',
    在场: ['灯塔学徒', '秦守'],
    templates: inspected.bundle.templates,
  });
  assert.ok(ctx.汇总.总字符 > 0);

  const proj = await loadProject('/项目/世界书', {fs: mem.fs, path: mem.path});
  const ifRes = whatIf(proj.catalog, proj.decl, {方案: '码头少年', issues: proj.issues});
  assert.ok(Array.isArray(ifRes.没发生));
});

test('视图-只读卡-2：ygg view 位置参数（JSON/PNG）与 --card 只读打开、7 个写端点 403 与参数互斥', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-view-card-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));

  const packedWugang = await packIsolated(t, WUGANG_DIR);
  const wugangJson = path.join(tmpDir, 'wugang.json');
  await fs.copyFile(packedWugang.cardFile, wugangJson);

  const packedSanguo = await packIsolated(t, SANGUO_DIR);
  const sanguoCardObj = JSON.parse(await fs.readFile(packedSanguo.cardFile, 'utf8'));
  const sanguoPng = path.join(tmpDir, 'sanguo.png');
  await fs.writeFile(sanguoPng, buildTestPng([
    makeTextChunk('iTXt', 'ccv3', cardToBase64(sanguoCardObj), {compressed: true}),
  ]));

  // 1. startViewServer({card: sanguoPng}) 验证全部读端点 200 与 7 个写端点 403
  const app = await startViewServer({card: sanguoPng, port: 0});
  t.after(() => app.close());
  assert.equal(app.readOnly, true);
  assert.equal(app.mode, 'card');
  assert.equal(app.storage, null);

  const htmlRes = await fetch(`${app.url}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /世界树/u);

  const dataRes = await fetch(`${app.url}/api/data`);
  assert.equal(dataRes.status, 200);
  const data = await dataRes.json();
  assert.equal(data.服务.只读, true);
  assert.equal(data.服务.模式, 'card');
  assert.equal(data.服务.来源文件, 'sanguo.png');
  assert.equal(data.服务.存储, null);
  assert.equal(data.服务.卡信息.名称, '三国演义·第一至三回');
  assert.equal(data.服务.卡信息.卡ID, 'yggdrasill.sanguo-yanyi.ch01-03');
  assert.equal(data.服务.卡信息.主题数, 1);
  assert.equal(data.元数据.计数.事件, 150);
  assert.equal(data.元数据.计数.角色组, 37);
  assert.deepEqual(data.review, {revision: '', value: {notes: {}, layout: {}}});

  const treeRes = await fetch(`${app.url}/api/tree.md`);
  assert.equal(treeRes.status, 200);
  assert.match(await treeRes.text(), /桃园结义/u);
  const treeDl = await fetch(`${app.url}/api/tree.md?download=1`);
  assert.equal(treeDl.status, 200);
  assert.match(treeDl.headers.get('content-disposition') ?? '', /event-tree\.md/u);

  const post = (route, body) => fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Review-Token': app.token},
    body: JSON.stringify(body),
  });

  const ifRes = await post('/api/if', {});
  assert.equal(ifRes.status, 200);
  const ifJson = await ifRes.json();
  assert.ok(Array.isArray(ifJson.没发生));

  const ctxRes = await post('/api/context', {方案: '榜前长叹', 地点: '涿县', 在场: ['刘备', '张飞']});
  assert.equal(ctxRes.status, 200);
  const ctxJson = await ctxRes.json();
  assert.ok(ctxJson.汇总.总字符 > 0);

  // 全部 7 个写/编辑端点一律返回 HTTP 403
  const blockedRoutes = [
    '/api/preview',
    '/api/save',
    '/api/review',
    '/api/event/create/preview',
    '/api/position/preview',
    '/api/yaml/parse',
    '/api/yaml/format',
  ];
  for (const route of blockedRoutes) {
    const res = await post(route, {});
    assert.equal(res.status, 403, `${route} 应返回 403`);
    const payload = await res.json();
    assert.match(payload.error, /只读成品卡模式不支持编辑或保存/u, route);
  }

  // 2. 真实子进程测试：位置参数 JSON、位置参数 PNG、--card 参数（均零磁盘写入）
  const beforeEntries = (await fs.readdir(tmpDir)).sort();
  for (const [label, viewArgs, expectedEvents] of [
    ['位置参数 JSON', [wugangJson, '--port', '0'], 13],
    ['位置参数 PNG', [sanguoPng, '--port', '0'], 150],
    ['--card JSON', ['--card', wugangJson, '--port', '0'], 13],
  ]) {
    const spawned = await spawnView(viewArgs, project);
    t.after(() => { if (!spawned.child.killed) spawned.child.kill('SIGTERM'); });
    const url = await waitForUrl(spawned);
    const outText = spawned.stdout();
    assert.match(outText, /模式：只读成品卡/u, label);
    assert.match(outText, /ygg unpack/u, label);
    const resp = await fetch(`${url}/api/data`);
    assert.equal(resp.status, 200, label);
    const body = await resp.json();
    assert.equal(body.服务.只读, true, label);
    assert.equal(body.元数据.计数.事件, expectedEvents, label);
    spawned.child.kill('SIGTERM');
    await once(spawned.child, 'exit');
  }
  assert.deepEqual((await fs.readdir(tmpDir)).sort(), beforeEntries, '只读成品卡模式不应在卡所在目录写入任何文件');

  // 3. 参数互斥校验
  assert.throws(() => parseViewArgs(['--card', wugangJson, '--storage', '/tmp/s']), /view|storage|只读/u);
  assert.throws(() => parseViewArgs(['--card', wugangJson, '--worldbook', '世界书']), /不能同时传入/u);
  assert.throws(() => parseViewArgs([wugangJson, '--card', wugangJson]), /不能同时传入/u);

  const posWithStorage = await spawnView([wugangJson, '--storage', path.join(tmpDir, 'forbidden-storage'), '--port', '0'], project);
  const [posStorageCode] = await once(posWithStorage.child, 'exit');
  assert.equal(posStorageCode, 1);
  assert.match(posWithStorage.stderr(), /view\.参数/u);
  assert.match(posWithStorage.stderr(), /--storage/u);
  void silentIo;
  void buildFaceYaml;
});
