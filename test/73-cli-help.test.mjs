import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test, assert, fs, path, project, fixture} from './helpers.mjs';
import {runCli} from '../cli/ygg.mjs';

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

async function spawnCli(args, cwd = project) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [cliEntry, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

test('CLI-帮助与版本-1：顶层 --help/-h 与 --version/-v 输出到 stdout 且退出码为 0', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  for (const flag of ['--help', '-h']) {
    const res = await cli([flag]);
    assert.equal(res.code, 0, flag);
    assert.equal(res.stderr, '', flag);
    assert.match(res.stdout, /用法：ygg check/u, flag);
    assert.match(res.stdout, /--help \| -h.*--version \| -v/u, flag);
  }
  for (const flag of ['--version', '-v']) {
    const res = await cli([flag]);
    assert.equal(res.code, 0, flag);
    assert.equal(res.stderr, '', flag);
    assert.equal(res.stdout.trim(), `yggdrasill ${pkg.version}`);
  }

  const realHelp = await spawnCli(['--help']);
  assert.equal(realHelp.code, 0);
  assert.match(realHelp.stdout, /用法：ygg check/u);
  const realVer = await spawnCli(['--version']);
  assert.equal(realVer.code, 0);
  assert.equal(realVer.stdout.trim(), `yggdrasill ${pkg.version}`);
});

test('CLI-帮助与版本-2：全部 12 个子命令 --help/-h 返回退出码 0 且不读写世界书', async () => {
  const subcommands = [
    ['check', /用法：ygg check/u],
    ['format', /用法：ygg format/u],
    ['trace', /用法：ygg trace/u],
    ['if', /用法：ygg if/u],
    ['preview', /用法：ygg preview/u],
    ['context', /用法：ygg context/u],
    ['tree', /用法：ygg tree/u],
    ['status', /用法：ygg status/u],
    ['init', /用法：ygg init/u],
    ['view', /用法：ygg view/u],
    ['pack', /用法：ygg pack/u],
    ['unpack', /用法：ygg unpack/u],
  ];
  const forbiddenFs = new Proxy({}, {
    get(_target, prop) {
      return () => { throw new Error(`help 不应访问文件系统：${String(prop)}`); };
    },
  });
  for (const [cmd, pattern] of subcommands) {
    for (const flag of ['--help', '-h']) {
      const res = await cli([cmd, flag], {fs: forbiddenFs});
      assert.equal(res.code, 0, `${cmd} ${flag}: ${res.stderr}`);
      assert.equal(res.stderr, '', `${cmd} ${flag}`);
      assert.match(res.stdout, pattern, `${cmd} ${flag}`);
    }
  }
});

test('CLI-帮助与版本-3：无参、默认 check 与错误参数维持原退出码与报错语义', async t => {
  const bare = await cli([]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /用法：ygg check/u);

  const root = await fixture(t);
  const defaultCheck = await cli(['check', '--json', '--static-only'], {cwd: path.dirname(root)});
  assert.equal(defaultCheck.code, 0, defaultCheck.stderr);
  assert.equal(JSON.parse(defaultCheck.stdout).errors.length, 0);

  for (const args of [
    ['未知'],
    ['check', '--未知'],
    ['format', '--未知'],
    ['trace'],
    ['trace', '--未知'],
    ['if', '--未知'],
    ['preview', '--未知'],
    ['context', '--未知'],
    ['tree', '--未知'],
    ['status', '--未知'],
    ['init', '--未知'],
    ['view', '--未知'],
    ['pack', '--未知'],
    ['unpack', '--未知'],
  ]) {
    const res = await cli(args);
    assert.equal(res.code, 1, JSON.stringify(args));
    assert.match(res.stderr, /用法：/u, JSON.stringify(args));
  }

  const jsonErr = await cli(['if', '--未知', '--json']);
  assert.equal(jsonErr.code, 1);
  assert.match(jsonErr.stderr, /未知选项：--未知/u);
  assert.equal(JSON.parse(jsonErr.stdout).异常[0].规则, 'if.参数');
});
