import {test, assert, fs, path, project} from './helpers.mjs';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkDocs} from '../scripts/check-docs.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = path.join(project, 'scripts', 'check-docs.mjs');

async function createTempDocsRepo(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-check-docs-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(absPath), {recursive: true});
    await fs.writeFile(absPath, content, 'utf8');
  }
  return dir;
}

async function runCli(args, cwd = project) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [scriptPath, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

test('docs-1：当前仓库全量文档门禁通过且统计规模符合预期', async () => {
  const result = await checkDocs(project);
  assert.deepEqual(result.errors, []);
  assert.ok(result.files.length >= 30, `应扫描至少 30 份文档，实际 ${result.files.length}`);
  assert.ok(result.linkCount > 100, `相对链接数应大于 100，实际 ${result.linkCount}`);
  assert.ok(result.anchorCount > 20, `锚点数应大于 20，实际 ${result.anchorCount}`);

  const cli = await runCli([]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /0 错误/);
});

test('docs-2：失效相对链接被检出且 CLI 返回退出码 1', async t => {
  const root = await createTempDocsRepo(t, {
    'README.md': '# 首页\n\n见 [缺失文件](docs/not-a-file.md)。\n',
  });
  const result = await checkDocs(root);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].rule, 'broken-link');
  assert.equal(result.errors[0].file, 'README.md');
  assert.equal(result.errors[0].line, 3);

  const cli = await runCli([root]);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /broken-link/);
});

test('docs-3：失效 #锚点（同文件与跨文件中文锚点）被检出，合法与重名锚点放行', async t => {
  const root = await createTempDocsRepo(t, {
    'README.md': [
      '# 首页',
      '',
      '## 章节',
      '## 章节',
      '',
      '- 有效同文件：[重名](#章节-1)',
      '- 有效跨文件：[命令](docs/指南.md#命令-说明)',
      '- 有效编码：[命令](docs/指南.md#%E5%91%BD%E4%BB%A4-%E8%AF%B4%E6%98%8E)',
      '- 失效同文件：[坏锚点](#不存在的锚点)',
      '- 失效跨文件：[坏跨锚点](docs/指南.md#不存在的中文锚点)',
      '',
    ].join('\n'),
    'docs/指南.md': '# 指南\n\n## 命令 说明\n',
  });
  const result = await checkDocs(root);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(item => [item.rule, item.line]), [
    ['broken-anchor', 9],
    ['broken-anchor', 10],
  ]);
});

test('docs-4：禁用术语在正文报错，仅在 docs/术语.md 统一用语表“不用”列豁免', async t => {
  const root = await createTempDocsRepo(t, {
    'README.md': '# 说明\n\n这里误用了原著、完整检查和孤立事件。\n',
    'docs/术语.md': [
      '# 术语',
      '',
      '正文误用：原著。',
      '',
      '## 统一用语',
      '',
      '| 不用 | 用 |',
      '|---|---|',
      '| 原著 | 原作 |',
      '| 完整检查 | 全量检查 |',
      '| 孤立事件 | 独立事件 |',
      '| 旧词 | 仍误用完整检查 |',
      '',
    ].join('\n'),
  });
  const result = await checkDocs(root);
  const banned = result.errors.filter(item => item.rule === 'banned-term');
  assert.deepEqual(
    banned.map(item => [item.file, item.line, item.detail]),
    [
      ['README.md', 3, '禁用术语“原著”'],
      ['README.md', 3, '禁用术语“完整检查”'],
      ['README.md', 3, '禁用术语“孤立事件”'],
      ['docs/术语.md', 3, '禁用术语“原著”'],
      ['docs/术语.md', 12, '禁用术语“完整检查”'],
    ],
  );
});

test('docs-5：隐私路径、本机绝对路径与旧 examples/雾港 路径被检出，归档目录豁免', async t => {
  const root = await createTempDocsRepo(t, {
    'README.md': [
      '# 路径测试',
      '',
      '- /home/alice/repo',
      '- /Users/bob/notes',
      '- C:\\Users\\carol\\work',
      '- ~/syncL/dev/yggdrasill',
      '- reports/YG-VIEW-01.md',
      '- examples/雾港/世界书',
      '',
    ].join('\n'),
    'docs/归档/历史.md': '# 归档\n\n这里提到 examples/雾港 不应报错。\n',
  });
  const result = await checkDocs(root);
  assert.deepEqual(
    result.errors.map(item => [item.rule, item.line]),
    [
      ['privacy-path', 3],
      ['privacy-path', 4],
      ['privacy-path', 5],
      ['privacy-path', 6],
      ['privacy-path', 7],
      ['legacy-path', 8],
    ],
  );
});

test('docs-6：fenced code block 内的伪链接与代码示例不误报', async t => {
  const root = await createTempDocsRepo(t, {
    'README.md': [
      '# 示例',
      '',
      '```markdown',
      '[x](not-a-file.md)',
      '[bad](#missing-anchor)',
      '```',
      '',
      '~~~markdown',
      '[y](also-not-a-file.md)',
      '~~~',
      '',
    ].join('\n'),
  });
  const result = await checkDocs(root);
  assert.deepEqual(result.errors, []);
});
