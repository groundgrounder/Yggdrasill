import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import zlib from 'node:zlib';
import {test, assert, fs, path, project} from './helpers.mjs';
import {
  parsePngCard,
  parseInputFile,
  detectFeatures,
  unpackCards,
  runCli,
} from '../skills/ygg-migrate/scripts/unpack-card.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = path.join(project, 'skills', 'ygg-migrate', 'scripts', 'unpack-card.mjs');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcBuf = Buffer.alloc(4); // 拆包脚本按 chunk 边界遍历，不强制校验图像 CRC
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function makeIhdr() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type
  return makeChunk('IHDR', ihdr);
}

function makeTextChunk(keyword, text) {
  return makeChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

function makeZtxtChunk(keyword, text) {
  const compressed = zlib.deflateSync(Buffer.from(text, 'latin1'));
  return makeChunk('zTXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), compressed]));
}

function makeItxtChunk(keyword, text, compressed = true) {
  const payload = compressed ? zlib.deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return makeChunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0, compressed ? 1 : 0, 0, 0, 0]),
      payload,
    ]),
  );
}

function buildPng(extraChunks = []) {
  return Buffer.concat([PNG_SIGNATURE, makeIhdr(), ...extraChunks, makeChunk('IEND', Buffer.alloc(0))]);
}

function encodeCardBase64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

async function runScript(args, cwd = project) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [scriptPath, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function makeTempDir(t, prefix = 'ygg-migrate-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('YG-MIGRATE-01-A2：unpack-card.mjs 仅使用 Node 内置模块（零第三方依赖）', async () => {
  const src = await fs.readFile(scriptPath, 'utf8');
  const imports = [...src.matchAll(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gmu)].map(m => m[1]);
  assert.ok(imports.length > 0, '应包含标准 Node 内置模块导入');
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:'), `禁止非 Node 内置依赖：${specifier}`);
  }
});

test('YG-MIGRATE-01-A2：合成 PNG V2（tEXt chara）拆包、开场白与内嵌世界书单文件落盘', async t => {
  const tmp = await makeTempDir(t);
  const v2Card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '青灯守夜人',
      creator: '测试作者',
      character_version: '1.0',
      tags: ['悬疑', '架空'],
      description: '守夜人林青驻守钟楼，习惯低声自语。',
      personality: '沉静寡言，观察细致。',
      scenario: '雨夜钟楼值守。',
      first_mes: '雨滴敲在铜钟外沿，他抬眼看向门口。',
      alternate_greetings: ['清晨雾散，钟楼台阶尚湿。'],
      mes_example: '<START>\n{{char}}: 今夜风大，先关窗。',
      system_prompt: '保持克制冷静的叙述风格。',
      post_history_instructions: '勿替玩家决定行动。',
      creator_notes: '极简测试样例。',
      character_book: {
        name: '钟楼录',
        entries: [
          {
            uid: 10,
            comment: '钟楼/主塔:概况',
            keys: ['钟楼', '主塔'],
            secondary_keys: ['雨夜'],
            content: '旧城最高的石砌钟楼。',
            enabled: true,
            constant: true,
            selective: false,
            insertion_order: 100,
            position: 'before_char',
          },
          {
            uid: 11,
            comment: '青铜提灯',
            keys: ['提灯'],
            content: '灯芯燃着淡青色火光。',
            disable: true,
            constant: false,
            order: 200,
          },
        ],
      },
    },
  };

  const pngPath = path.join(tmp, 'keeper-v2.png');
  const outDir = path.join(tmp, 'out-v2');
  await fs.writeFile(pngPath, buildPng([makeTextChunk('chara', encodeCardBase64(v2Card))]));

  const manifest = await unpackCards([pngPath], outDir);
  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.inputs.length, 1);
  assert.equal(manifest.inputs[0].file, 'keeper-v2.png');
  assert.equal(manifest.inputs[0].kind, 'png-card');
  assert.equal(manifest.inputs[0].spec, 'chara_card_v2');
  assert.equal(manifest.inputs[0].chunk, 'chara');
  assert.equal(manifest.card.has_card, true);
  assert.equal(manifest.card.name, '青灯守夜人');
  assert.equal(manifest.counts.greetings, 2);
  assert.equal(manifest.counts.lorebook_total, 2);
  assert.equal(manifest.counts.lorebook_enabled, 1);
  assert.equal(manifest.counts.lorebook_disabled, 1);
  assert.equal(manifest.counts.lorebook_constant, 1);

  const cardCore = await fs.readFile(path.join(outDir, 'card-core.md'), 'utf8');
  assert.match(cardCore, /青灯守夜人/u);
  assert.match(cardCore, /守夜人林青驻守钟楼/u);
  assert.match(cardCore, /保持克制冷静的叙述风格/u);

  const greetings = JSON.parse(await fs.readFile(path.join(outDir, 'greetings.json'), 'utf8'));
  assert.equal(greetings.length, 2);
  assert.equal(greetings[0].kind, 'first_mes');
  assert.equal(greetings[1].kind, 'alternate_greeting');
  assert.equal(greetings[1].alternate_index, 0);

  const loreIndex = JSON.parse(await fs.readFile(path.join(outDir, 'lorebook', 'index.json'), 'utf8'));
  assert.equal(loreIndex.length, 2);
  assert.equal(loreIndex[0].enabled, true);
  assert.equal(loreIndex[1].enabled, false);
  assert.equal(loreIndex[0].source_file, 'keeper-v2.png');
  assert.ok(!loreIndex[0].file.includes(':'), '非法文件名字符应被安全清洗');

  const entry1 = await fs.readFile(path.join(outDir, loreIndex[0].file), 'utf8');
  assert.match(entry1, /旧城最高的石砌钟楼/u);
  assert.match(entry1, /source_file: keeper-v2\.png/u);
});

test('YG-MIGRATE-01-A2：合成 PNG V3（iTXt / zTXt 压缩 ccv3 与 tEXt chara 共存）优先取 ccv3 并正确解压', () => {
  const fallbackV2 = {
    spec: 'chara_card_v2',
    data: {name: '旧版回退名', description: '旧版描述'},
  };
  const preferredV3 = {
    spec: 'chara_card_v3',
    data: {name: '新版V3名', description: '新版中文描述（含 UTF-8 字符）'},
  };

  const pngItxt = buildPng([
    makeTextChunk('chara', encodeCardBase64(fallbackV2)),
    makeItxtChunk('ccv3', encodeCardBase64(preferredV3), true),
  ]);
  const resItxt = parsePngCard(pngItxt);
  assert.equal(resItxt.chunk, 'ccv3');
  assert.equal(resItxt.chunkType, 'iTXt');
  assert.deepEqual(resItxt.chunksFound, ['ccv3', 'chara']);
  assert.equal(resItxt.raw.data.name, '新版V3名');

  const pngZtxt = buildPng([
    makeTextChunk('chara', encodeCardBase64(fallbackV2)),
    makeZtxtChunk('ccv3', encodeCardBase64(preferredV3)),
  ]);
  const resZtxt = parsePngCard(pngZtxt);
  assert.equal(resZtxt.chunk, 'ccv3');
  assert.equal(resZtxt.chunkType, 'zTXt');
  assert.equal(resZtxt.raw.data.name, '新版V3名');
});

test('YG-MIGRATE-01-A2：JSON V1/V2/V3、独立世界书（对象映射含 disable 与数组形态）与多文件合并且零绝对路径泄露', async t => {
  const tmp = await makeTempDir(t);

  // V1 扁平 JSON
  const v1 = parseInputFile('/abs/path/v1-card.json', Buffer.from(JSON.stringify({
    name: '扁平旅人',
    description: '独自穿行荒原的旅人。',
    first_mes: '风沙扑面而来。',
  }), 'utf8'));
  assert.equal(v1.kind, 'json-card');
  assert.equal(v1.spec, 'chara_card_v1');
  assert.equal(v1.card.name, '扁平旅人');

  // 根数组独立世界书
  const rootArrayLore = parseInputFile('/abs/path/root-lore.json', Buffer.from(JSON.stringify([
    {uid: 1, name: '荒原客栈', key: ['客栈'], content: '荒原路口的小客栈。', disable: false},
  ]), 'utf8'));
  assert.equal(rootArrayLore.kind, 'lorebook');
  assert.equal(rootArrayLore.loreEntries.length, 1);
  assert.equal(rootArrayLore.loreEntries[0].enabled, true);
  assert.equal(rootArrayLore.loreEntries[0].source_file, 'root-lore.json');

  // 多文件合并：PNG 角色卡 + 独立对象映射世界书 + 独立数组世界书
  const pngPath = path.join(tmp, 'main-card.png');
  const loreMapPath = path.join(tmp, 'world-map.json');
  const loreArrPath = path.join(tmp, 'world-arr.json');
  const outDir = path.join(tmp, 'merged-out');

  const baseCard = {
    spec: 'chara_card_v3',
    data: {
      name: '星港领航员',
      description: '负责校准航标的领航员。',
      first_mes: '星图已展开。',
      character_book: {
        entries: [{uid: 1, comment: '星港灯标', keys: ['灯标'], content: '指引航道的浮标。', enabled: true}],
      },
    },
  };
  await fs.writeFile(pngPath, buildPng([makeItxtChunk('ccv3', encodeCardBase64(baseCard), true)]));
  await fs.writeFile(loreMapPath, JSON.stringify({
    entries: {
      '2': {uid: 2, comment: '旧航线（停用）', key: ['旧航线'], content: '已废弃航路。', disable: true},
      '0': {uid: 0, comment: '星港议会', key: ['议会'], keysecondary: ['法令'], content: '管理港口的议事机构。', disable: false, constant: true},
    },
  }));
  await fs.writeFile(loreArrPath, JSON.stringify({
    entries: [{uid: 3, name: '星尘罗盘', keys: ['罗盘'], content: '指向深空信标。', enabled: true}],
  }));

  const manifest = await unpackCards([pngPath, loreMapPath, loreArrPath], outDir);
  assert.equal(manifest.inputs.length, 3);
  assert.equal(manifest.counts.lorebook_total, 4);
  assert.equal(manifest.counts.lorebook_enabled, 3);
  assert.equal(manifest.counts.lorebook_disabled, 1);

  const loreIndex = JSON.parse(await fs.readFile(path.join(outDir, 'lorebook', 'index.json'), 'utf8'));
  assert.deepEqual(loreIndex.map(e => e.source_file), [
    'main-card.png',
    'world-map.json',
    'world-map.json',
    'world-arr.json',
  ]);
  assert.equal(loreIndex[1].comment, '星港议会'); // 对象映射按数字键 "0" 排在 "2" 前
  assert.equal(loreIndex[2].enabled, false); // disable: true -> enabled: false

  // 全输出目录零宿主机绝对路径泄露校验
  for (const rel of manifest.files) {
    const content = await fs.readFile(path.join(outDir, rel), 'utf8');
    assert.ok(!content.includes(tmp), `${rel} 不得包含临时目录绝对路径`);
    assert.ok(!content.includes(os.tmpdir()), `${rel} 不得包含系统临时绝对路径`);
  }

  // 纯独立世界书输入（无角色卡主体）
  const pureLoreOut = path.join(tmp, 'pure-lore-out');
  const pureManifest = await unpackCards([loreMapPath], pureLoreOut);
  assert.equal(pureManifest.card.has_card, false);
  const pureCore = await fs.readFile(path.join(pureLoreOut, 'card-core.md'), 'utf8');
  assert.match(pureCore, /纯独立世界书输入/u);
});

test('YG-MIGRATE-01-A2：6 项动态特征准确命中，且 regex_scripts 与其他 extensions 剥离落盘', async t => {
  const tmp = await makeTempDir(t);
  const complexCard = {
    spec: 'chara_card_v3',
    data: {
      name: '浮空学院群像',
      description: '多角色校园设定。\n## 角色一：林羽\n## 角色二：苏澄\n## 角色三：陆明\n<% if (getvar("chapter") == 1) { %>第一期<% } %>',
      first_mes: '<div class="status-bar">状态</div><UpdateVariable>_.set("hp", 10)</UpdateVariable>',
      character_book: {
        entries: [
          {
            uid: 1,
            comment: '[InitVar] 初始变量',
            keys: ['初始化'],
            content: 'stat_data = { hp: 100 }; // MVU 配置',
            enabled: true,
            constant: true,
          },
        ],
      },
      extensions: {
        tavern_helper: {scripts: [{name: 'panel'}]},
        regex_scripts: [
          {id: 'r1', scriptName: '美化状态栏', placement: [2], markdownOnly: true},
          {id: 'r2', scriptName: '改写提示词', placement: [1], promptOnly: true},
        ],
        custom_vars: {schema: 'v1', initialHp: 100},
      },
    },
  };

  const directFlags = detectFeatures(
    `${complexCard.data.description}\n${complexCard.data.first_mes}\n${complexCard.data.character_book.entries[0].content}`,
    complexCard.data.extensions,
  );
  assert.deepEqual(directFlags, {
    hasEjs: true,
    hasMvu: true,
    hasTavernHelper: true,
    hasRegexScripts: true,
    hasHtmlUi: true,
    isMultiCharacter: true,
  });

  const jsonPath = path.join(tmp, 'complex.json');
  const outDir = path.join(tmp, 'out-complex');
  await fs.writeFile(jsonPath, JSON.stringify(complexCard), 'utf8');

  const manifest = await unpackCards([jsonPath], outDir);
  assert.deepEqual(manifest.features, {
    hasEjs: true,
    hasMvu: true,
    hasTavernHelper: true,
    hasRegexScripts: true,
    hasHtmlUi: true,
    isMultiCharacter: true,
  });
  assert.equal(manifest.counts.regex_scripts, 2);
  assert.equal(manifest.counts.regex_scripts_display_only, 1);
  assert.equal(manifest.counts.regex_scripts_prompt_rewrite, 1);
  assert.equal(manifest.counts.extension_keys, 2);

  const regexFile = JSON.parse(await fs.readFile(path.join(outDir, 'scripts', 'regex-scripts.json'), 'utf8'));
  assert.equal(regexFile.total, 2);
  assert.equal(regexFile.display_only, 1);
  assert.equal(regexFile.prompt_rewrite, 1);

  const extFile = JSON.parse(await fs.readFile(path.join(outDir, 'scripts', 'extensions.json'), 'utf8'));
  assert.deepEqual(extFile.keys, ['custom_vars', 'tavern_helper']);
  assert.equal('regex_scripts' in extFile.data, false);
});

test('YG-MIGRATE-01-A2：负例校验均返回非 0 退出码与清晰中文报错且不残留半成品目录', async t => {
  const tmp = await makeTempDir(t);

  // 1. 损坏 PNG（区块长度越界）
  const corruptPng = path.join(tmp, 'corrupt.png');
  const badLen = Buffer.alloc(12);
  badLen.writeUInt32BE(9999, 0);
  badLen.write('tEXt', 4, 'ascii');
  await fs.writeFile(corruptPng, Buffer.concat([PNG_SIGNATURE, badLen]));
  const outCorrupt = path.join(tmp, 'out-corrupt');
  const resCorrupt = await runScript([corruptPng, '-o', outCorrupt]);
  assert.notEqual(resCorrupt.code, 0);
  assert.match(resCorrupt.stderr, /越界/u);
  await assert.rejects(fs.access(outCorrupt), {code: 'ENOENT'});

  // 2. 普通 PNG（不含 chara / ccv3）
  const plainPng = path.join(tmp, 'plain.png');
  await fs.writeFile(plainPng, buildPng([makeTextChunk('Comment', 'plain image')]));
  const outPlain = path.join(tmp, 'out-plain');
  const resPlain = await runScript([plainPng, '-o', outPlain]);
  assert.notEqual(resPlain.code, 0);
  assert.match(resPlain.stderr, /不含 ccv3 或 chara/u);
  await assert.rejects(fs.access(outPlain), {code: 'ENOENT'});

  // 3. 非法 JSON
  const badJson = path.join(tmp, 'broken.json');
  await fs.writeFile(badJson, '{not valid json', 'utf8');
  const outBadJson = path.join(tmp, 'out-bad-json');
  const resBadJson = await runScript([badJson, '-o', outBadJson]);
  assert.notEqual(resBadJson.code, 0);
  assert.match(resBadJson.stderr, /不是合法 JSON/u);
  await assert.rejects(fs.access(outBadJson), {code: 'ENOENT'});

  // 4. 重复传入两份角色卡主体
  const cardA = path.join(tmp, 'a.json');
  const cardB = path.join(tmp, 'b.json');
  await fs.writeFile(cardA, JSON.stringify({name: '甲', description: '甲描述'}), 'utf8');
  await fs.writeFile(cardB, JSON.stringify({name: '乙', description: '乙描述'}), 'utf8');
  const outDup = path.join(tmp, 'out-dup');
  const resDup = await runScript([cardA, cardB, '-o', outDup]);
  assert.notEqual(resDup.code, 0);
  assert.match(resDup.stderr, /多份角色卡主体/u);
  await assert.rejects(fs.access(outDup), {code: 'ENOENT'});

  // 5. 缺失 -o 输出目录
  let stderrText = '';
  const missingOutCode = await runCli([cardA], {
    stdout: {write: () => {}},
    stderr: {write: s => { stderrText += s; }},
  });
  assert.equal(missingOutCode, 1);
  assert.match(stderrText, /指定输出目录/u);

  // 6. 输出目录非空且未传 --force 时拒绝覆盖，传 --force 允许覆盖
  const existingOut = path.join(tmp, 'existing-out');
  await fs.mkdir(existingOut, {recursive: true});
  await fs.writeFile(path.join(existingOut, 'keep.txt'), 'old', 'utf8');
  const resNoForce = await runScript([cardA, '-o', existingOut]);
  assert.notEqual(resNoForce.code, 0);
  assert.match(resNoForce.stderr, /非空/u);
  const resForce = await runScript([cardA, '-o', existingOut, '--force']);
  assert.equal(resForce.code, 0, resForce.stderr);
  assert.match(resForce.stdout, /拆包完成/u);
});
