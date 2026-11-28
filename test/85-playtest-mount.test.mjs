import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import {test, assert, fs, path, project, createTempPackRepo} from './helpers.mjs';
import {packCard} from '../adapter/pack.mjs';
import {mountCard, snapshotHashes, probeCard} from '../skills/ygg-playtest/scripts/mount-card.mjs';

const execFileAsync = promisify(execFile);
const mountScript = path.join(project, 'skills', 'ygg-playtest', 'scripts', 'mount-card.mjs');
const wugangDir = path.join(project, 'test', 'fixtures', '雾港');
const wugangFace = path.join(wugangDir, '卡面.yaml');
const quiet = {write: () => {}};

async function runMountCli(args, cwd = project) {
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, [mountScript, ...args], {cwd});
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};
  }
}

async function packFixtureCardToTmp(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-playtest-'));
  t.after(() => fs.rm(tmpDir, {recursive: true, force: true}));
  const tmpRepo = await createTempPackRepo(t, 'ygg-playtest-repo-');
  const result = await packCard({
    projectDir: wugangDir,
    faceFile: wugangFace,
    adapterDir: path.join(tmpRepo, 'adapter'),
    repo: tmpRepo,
    stdout: quiet,
    stderr: quiet,
  });
  const tmpCardPath = path.join(tmpDir, path.basename(result.cardFile));
  await fs.copyFile(result.cardFile, tmpCardPath);
  return {tmpDir, cardPath: tmpCardPath, manifest: result.manifest};
}

test('YG-PLAYTEST-01-1：mount-card.mjs 零外部依赖，仅使用 node:* 内置模块', async () => {
  const source = await fs.readFile(mountScript, 'utf8');
  const imports = [...source.matchAll(/^\s*import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gmu)].map(m => m[1]);
  assert.ok(imports.length >= 3, '应至少导入多个 node:* 内置模块');
  for (const spec of imports) {
    assert.ok(spec.startsWith('node:'), `禁止非 node:* 依赖：${spec}`);
  }
  assert.doesNotMatch(source, /\brequire\s*\(/u, '不得使用 CommonJS require');
});

test('YG-PLAYTEST-01-2：钩子模式（hook）挂载真实打包卡、全链路 API 可用且 cleanup 完整还原 globalThis', async t => {
  const {cardPath, manifest} = await packFixtureCardToTmp(t);
  const tracked = ['$', 'SillyTavern', 'tavern_events', 'getChatMessages', 'getLastMessageId',
    'getVariables', 'replaceVariables', 'injectPrompts', 'uninjectPrompts', 'retrieveDisplayedMessage',
    'eventOn', 'getButtonEvent', 'getModelList', 'getProxyPresetNames', 'getCurrentChatId',
    'toastr', 'document', 'generateRaw', '__YGG_PLAYTEST_HOOK__'];
  const beforeDescriptors = new Map(tracked.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  const mounted = await mountCard(cardPath);
  try {
    assert.equal(mounted.mode, 'hook');
    assert.equal(Object.isFrozen(mounted.api), true);
    assert.equal(mounted.cardMeta.name, '雾港');
    assert.equal(mounted.cardMeta.characterVersion, '0.1.0');
    assert.ok(mounted.cardMeta.bytes > 0);
    assert.match(mounted.cardMeta.sha256, /^[0-9a-f]{64}$/);
    assert.ok(mounted.cardMeta.esmBytes > 0);
    assert.match(mounted.cardMeta.esmSha256, /^[0-9a-f]{64}$/);
    assert.equal(mounted.cardMeta.manifest.卡ID, manifest.卡ID);
    assert.equal(mounted.cardMeta.manifest.程序指纹, manifest.程序指纹);
    assert.equal(mounted.cardMeta.manifest.世界书哈希, manifest.世界书哈希);

    const {api, host} = mounted;
    for (const key of ['bundle', 'manifest', 'catalog', 'decl', 'protocol', 'router', 'quietRouter', 'keeper',
      'createOpeningDraft', 'openingNode', 'runKeeperLoop', 'buildKeepRecord', 'repairRecord', 'callKeeper',
      'generateOpening', 'parseJson', 'applyCommands', 'route', 'renderContext', 'stringifyYaml',
      'createCalendar', 'evaluateCondition', 'conditionReferences', 'seal']) {
      assert.ok(api[key] !== undefined, `冻结 api 缺少 ${key}`);
    }

    // 1. 开局草稿与 UI 节点桩
    const draft = api.createOpeningDraft({
      protocol: api.protocol,
      catalog: api.catalog,
      decl: api.decl,
      defaults: api.bundle.opening,
      commands: api.bundle.openingCommands,
    });
    const ui = api.openingNode(draft);
    const rootNode = ui?.node ?? ui;
    assert.ok(rootNode);
    const allNodes = host.findAllNodes(rootNode, () => true);
    assert.ok(allNodes.length > 0);
    assert.ok(host.findNode(rootNode, n => n === rootNode));

    // 2. 封卷 + 开场命令 + 路由渲染
    const sealed = api.seal(api.protocol, api.bundle.opening);
    const applied = api.applyCommands(api.protocol, sealed, api.bundle.openingCommands);
    assert.equal(applied.失败.length, 0);
    const routed = api.route(api.quietRouter, applied.state, ['今夜海雾渐浓。']);
    const rendered = api.renderContext(routed.context);
    assert.ok(rendered.includes('雾港') || rendered.length > 100);

    // 3. 记账请求与 host.pushResponse 驱动 runKeeperLoop
    const req = api.keeper.request(applied.state, {input: '环顾值守室', narration: '灯塔值守室里风平浪静。'});
    assert.ok(Array.isArray(req.prompts) && req.prompts.length === 2);
    const present = Object.entries(applied.state.角色 ?? {})
      .filter(([, value]) => value?.在场 === true)
      .map(([id]) => id);
    host.pushResponse(JSON.stringify({
      时间: {方式: '不变', 日期: '', 事件ID: ''},
      地点: {地标: '', 场景: ''},
      在场: present,
      发生的事件: [],
      新情况: [],
    }));
    const loop = await api.runKeeperLoop({
      keeper: api.keeper,
      base: applied.state,
      input: '环顾值守室',
      narration: '灯塔值守室里风平浪静。',
      config: {应答格式: '提示词'},
      attempts: 2,
      call: api.callKeeper,
      isCurrent: () => true,
    });
    assert.equal(loop.stale, false);
    assert.equal(loop.calls, 1);
    assert.ok(loop.best && loop.best.outcome.失败.length === 0);
    assert.equal(host.calls.length, 1);
    host.clearResponses();
    assert.ok(host.toasts.some(t => t.level === 'success'));
  } finally {
    mounted.cleanup();
  }

  for (const key of tracked) {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, key),
      beforeDescriptors.get(key),
      `cleanup() 后 globalThis.${key} 未还原`,
    );
  }
});

test('YG-PLAYTEST-01-3：旧包回退模式（legacy-export）兼容无 __YGG_PLAYTEST_HOOK__ 的历史打包卡', async t => {
  const {tmpDir, cardPath, manifest} = await packFixtureCardToTmp(t);
  const card = JSON.parse(await fs.readFile(cardPath, 'utf8'));
  const scriptEntry = card.data.extensions.tavern_helper.scripts.find(s => s.name === '世界树');
  const stripped = scriptEntry.content.replace(
    /if\s*\(\s*typeof\s+globalThis\.__YGG_PLAYTEST_HOOK__\s*===\s*["']function["']\s*\)\s*\{[\s\S]*?\}\s*$/u,
    '',
  );
  assert.ok(!stripped.includes('__YGG_PLAYTEST_HOOK__'), '应已剥离测试钩子以模拟 v0.1.1/v0.1.2 旧包');
  scriptEntry.content = stripped;

  const legacyPath = path.join(tmpDir, 'legacy-wugang.json');
  await fs.writeFile(legacyPath, `${JSON.stringify(card, null, 2)}\n`);

  const mounted = await mountCard(legacyPath);
  try {
    assert.equal(mounted.mode, 'legacy-export');
    assert.equal(Object.isFrozen(mounted.api), true);
    assert.equal(mounted.cardMeta.manifest.卡ID, manifest.卡ID);
    for (const key of ['bundle', 'catalog', 'decl', 'protocol', 'router', 'keeper', 'createOpeningDraft', 'route', 'seal']) {
      assert.ok(mounted.api[key] !== undefined, `legacy-export 缺少 ${key}`);
    }
    const sealed = mounted.api.seal(mounted.api.protocol, mounted.api.bundle.opening);
    const routed = mounted.api.route(mounted.api.router, sealed, []);
    assert.ok(routed.context);
    const legacyProbe = probeCard(mounted.api);
    const fallbackProbe = probeCard({...mounted.api, conditionReferences: undefined});
    assert.deepEqual(fallbackProbe.eventTreeHealth, legacyProbe.eventTreeHealth);
    assert.equal(
      legacyProbe.eventTreeHealth.confirmStrategyCounts.自动确认
        + legacyProbe.eventTreeHealth.confirmStrategyCounts.条件确认
        + legacyProbe.eventTreeHealth.confirmStrategyCounts.仅作候选,
      mounted.api.catalog.events.length,
    );
  } finally {
    mounted.cleanup();
  }
});

test('YG-PLAYTEST-01-4：probeCard D1/D4 指标准确且 --probe --json CLI 脱敏输出', async t => {
  const {tmpDir, cardPath} = await packFixtureCardToTmp(t);
  const mounted = await mountCard(cardPath);
  let directProbe;
  try {
    directProbe = probeCard(mounted.api, {disableGroups: ['灯塔学徒']});
    assert.equal(directProbe.counts.groups, mounted.api.catalog.groups.length);
    assert.equal(directProbe.counts.events, mounted.api.catalog.events.length);
    assert.ok(directProbe.defaultProfiles.length > 0);
    for (const item of directProbe.defaultProfiles) {
      assert.ok(item.groupId && item.displayName && item.profileId);
      assert.ok(Array.isArray(item.applicableVersions) && item.applicableVersions.length > 0);
      assert.equal(typeof item.hasBasicInfo, 'boolean');
      assert.equal(typeof item.hasImpression, 'boolean');
    }
    const impact = directProbe.disabledImpact;
    assert.ok(impact);
    assert.deepEqual(impact.disableGroups, ['灯塔学徒']);
    assert.equal(impact.totalEvents, directProbe.counts.events);
    assert.ok(impact.directDisabled > 0, '停用灯塔学徒应至少直接停摆 1 个事件');
    assert.equal(impact.directDisabled + impact.cascadeDisabled + impact.survivingEvents, impact.totalEvents);
    const overlap = impact.directIds.filter(id => impact.cascadeIds.includes(id));
    assert.deepEqual(overlap, []);

    const health = directProbe.eventTreeHealth;
    assert.ok(health, 'probeCard 应包含 eventTreeHealth');
    assert.equal(
      health.confirmStrategyCounts.自动确认
        + health.confirmStrategyCounts.条件确认
        + health.confirmStrategyCounts.仅作候选,
      directProbe.counts.events,
    );
    assert.equal(
      health.autoConfirmRatio,
      Number((health.confirmStrategyCounts.自动确认 / directProbe.counts.events).toFixed(4)),
    );
    assert.ok(Array.isArray(health.compoundNameIds));
    assert.ok(Array.isArray(health.zeroChangeLeafEvents.ids));
    assert.equal(health.zeroChangeLeafEvents.count, health.zeroChangeLeafEvents.ids.length);
  } finally {
    mounted.cleanup();
  }

  const cliJson = await runMountCli([cardPath, '--probe', '--disable-group', '灯塔学徒', '--json']);
  assert.equal(cliJson.code, 0, cliJson.stderr);
  assert.ok(!cliJson.stdout.includes(tmpDir), 'JSON 输出不得包含宿主机临时目录绝对路径');
  assert.ok(!cliJson.stdout.includes(project), 'JSON 输出不得包含宿主机仓库绝对路径');
  const parsed = JSON.parse(cliJson.stdout);
  assert.equal(parsed.card, path.basename(cardPath));
  assert.equal(parsed.mode, 'hook');
  assert.deepEqual(parsed.probe, directProbe);

  const cliText = await runMountCli([cardPath, '--probe', '--disable-group=灯塔学徒']);
  assert.equal(cliText.code, 0, cliText.stderr);
  assert.match(cliText.stdout, /挂载模式：hook/u);
  assert.match(cliText.stdout, /默认档案（D1 待审计）/u);
  assert.match(cliText.stdout, /事件树健康：/u);
  assert.match(cliText.stdout, /停用影响（D4/u);
  assert.ok(!cliText.stdout.includes(tmpDir));
});

test('YG-PLAYTEST-01-5：snapshotHashes 只读防篡改、符号链接不跟随与 CLI 负例报错', async t => {
  const {tmpDir, cardPath} = await packFixtureCardToTmp(t);
  const subDir = path.join(tmpDir, 'sample');
  await fs.mkdir(path.join(subDir, 'nested'), {recursive: true});
  const fileA = path.join(subDir, 'a.txt');
  const fileB = path.join(subDir, 'nested', 'b.txt');
  const outsideFile = path.join(tmpDir, 'outside.txt');
  await fs.writeFile(fileA, 'alpha\n');
  await fs.writeFile(fileB, 'beta\n');
  await fs.writeFile(outsideFile, 'external-v1\n');
  await fs.symlink(outsideFile, path.join(subDir, 'link-out.txt'));

  // 只读挂载前后哈希逐字节一致
  const snapBefore = await snapshotHashes([subDir, cardPath]);
  const mounted = await mountCard(cardPath);
  probeCard(mounted.api, {disableGroups: ['灯塔学徒']});
  mounted.cleanup();
  const snapAfter = await snapshotHashes([subDir, cardPath]);
  assert.deepEqual(snapAfter, snapBefore);
  for (const rel of Object.keys(snapBefore.files)) {
    assert.ok(!path.isAbsolute(rel), `不应输出绝对路径：${rel}`);
    assert.ok(!rel.includes(tmpDir), `不应包含宿主机路径：${rel}`);
  }

  // 修改符号链接指向的外部文件，因不跟随符号链接，哈希保持不变
  await fs.writeFile(outsideFile, 'external-v2-changed\n');
  const snapAfterOutsideEdit = await snapshotHashes([subDir, cardPath]);
  assert.equal(snapAfterOutsideEdit.rootSha256, snapBefore.rootSha256);

  // 修改目录内实际文件，哈希立即变化
  await fs.writeFile(fileA, 'alpha-modified\n');
  const snapAfterInsideEdit = await snapshotHashes([subDir, cardPath]);
  assert.notEqual(snapAfterInsideEdit.rootSha256, snapBefore.rootSha256);

  // CLI 负例校验
  const badJsonPath = path.join(tmpDir, 'bad.json');
  await fs.writeFile(badJsonPath, '{broken json');
  const nonYggPath = path.join(tmpDir, 'plain.json');
  await fs.writeFile(nonYggPath, JSON.stringify({name: '普通卡', data: {name: '普通卡'}}));

  const cases = [
    [[], /请提供待挂载的角色卡/u],
    [[cardPath], /--probe/u],
    [[path.join(tmpDir, 'missing.json'), '--probe'], /无法读取角色卡文件/u],
    [[badJsonPath, '--probe'], /不是合法 JSON/u],
    [[nonYggPath, '--probe'], /不含世界树内嵌脚本/u],
    [[cardPath, '--probe', '--unknown-opt'], /未知选项/u],
  ];
  for (const [args, pattern] of cases) {
    const res = await runMountCli(args);
    assert.equal(res.code, 1, `负例应退出码 1：${args.join(' ')}`);
    assert.match(res.stderr, pattern, `负例报错不匹配：${res.stderr}`);
  }
});
