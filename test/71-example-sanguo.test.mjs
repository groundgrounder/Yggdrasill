import {test, assert, fs, path, project} from './helpers.mjs';
import {createHash} from 'node:crypto';
import {checkWorldbook} from '../checker/index.mjs';
import {formatWorldbook} from '../core/format.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {isMap} from '../core/utils.mjs';
import {
  collectProgram, collectWorldbook, createManifest, PROGRAM_TEMPLATES, RUNTIME_ROOT,
} from '../adapter/manifest.mjs';
import {loadRouter} from '../core/router.mjs';
import {seal} from '../core/protocol.mjs';
import {applyCommands} from '../core/commands.mjs';

const sanguoProject = path.join(project, 'examples', '三国演义');
const sanguoWorldbook = path.join(sanguoProject, '世界书');
const sanguoFaceFile = path.join(sanguoProject, '卡面.yaml');

const CARD_REQUIRED_FIELDS = ['卡ID', '卡版本', '名称', '描述', '开场白'];
const CARD_ALLOWED_FIELDS = new Set([...CARD_REQUIRED_FIELDS, '开局', '开场命令']);

test('三国示例-1：全量 check 0 错误且不含内部规则失败', async () => {
  const result = await checkWorldbook(sanguoWorldbook);
  assert.deepEqual(result.errors, []);
  assert.equal(result.hints.some(item => item.规则 === '检查.规则失败'), false);
  assert.ok(result.summary.角色组 > 0);
  assert.ok(result.summary.事件 > 0);
});

test('三国示例-2：只读 format --check 0 差异、0 异常且无写入', async () => {
  const result = await formatWorldbook(sanguoWorldbook, {write: false});
  assert.equal(result.项目.异常, 0);
  assert.equal(result.项目.差异, 0);
  assert.equal(result.项目.已写入, 0);
  assert.ok(result.项目.文件 > 0);
});

test('三国示例-3：无副作用内存构建校验与 0 /作者资料/ 泄露', async () => {
  const face = parseYaml(await fs.readFile(sanguoFaceFile, 'utf8'));
  assert.ok(isMap(face), '卡面须为 YAML 映射');
  for (const key of CARD_REQUIRED_FIELDS) {
    assert.equal(typeof face[key], 'string', `卡面字段“${key}”须为文本`);
    assert.ok(face[key].trim().length > 0, `卡面字段“${key}”不能为空`);
  }
  for (const key of Object.keys(face)) {
    assert.ok(CARD_ALLOWED_FIELDS.has(key), `卡面含未授权字段：${key}`);
  }
  assert.equal(face.开场白.includes('<命令>'), false);
  assert.equal(face.开场白.includes('</命令>'), false);
  assert.ok(isMap(face.开局), '卡面须提供开局映射');
  if (face.开场命令 !== undefined) {
    assert.ok(Array.isArray(face.开场命令), '开场命令须为列表');
    assert.equal(
      face.开场命令.every(command => isMap(command) && Object.keys(command).length === 1),
      true,
      '开场命令须为单键命令映射列表',
    );
  }

  const worldbook = await collectWorldbook(sanguoProject);
  assert.ok(worldbook.length > 0);
  for (const entry of worldbook) {
    assert.ok(
      entry.路径.startsWith(`${RUNTIME_ROOT}/世界书/`) || entry.路径 === `${RUNTIME_ROOT}/yggdrasill.yaml`,
      `非法收集路径：${entry.路径}`,
    );
    assert.equal(entry.路径.includes('/作者资料/'), false, `不应收集作者资料：${entry.路径}`);
  }

  const program = await collectProgram(project);
  const {version: programVersion} = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  const manifest = createManifest({
    cardId: face.卡ID,
    cardVersion: face.卡版本,
    programVersion,
    worldbook,
    program,
  });
  assert.match(manifest.世界书哈希, /^[0-9a-f]{64}$/u);
  assert.match(manifest.程序指纹, /^[0-9a-f]{64}$/u);

  const files = Object.fromEntries(worldbook.map(item => [item.路径, item.text]));
  const templates = Object.fromEntries(PROGRAM_TEMPLATES.map(name => {
    const item = program.find(entry => entry.路径 === `templates/${name}.txt`);
    assert.ok(item, `缺少模板：templates/${name}.txt`);
    return [name, item.text];
  }));
  const idOf = salt => {
    const hex = createHash('sha256').update(`${face.卡ID}/${salt}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const bundle = {
    root: `${RUNTIME_ROOT}/世界书`,
    files,
    templates,
    opening: face.开局,
    openingCommands: face.开场命令 ?? [],
    manifest,
    权限: {脚本ID: idOf('script'), 正则ID: idOf('regex')},
  };
  const bundleText = JSON.stringify(bundle);
  assert.equal(bundleText.includes('/作者资料/'), false, '内存 bundle 不得包含 /作者资料/');

  const {protocol} = await loadRouter(sanguoWorldbook, {fs, path});
  const opening = applyCommands(protocol, seal(protocol, face.开局), bundle.openingCommands);
  assert.deepEqual(opening.失败, []);
});
