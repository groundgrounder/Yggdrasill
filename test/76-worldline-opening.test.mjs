import {
  test, assert, fs, path, fixture, edit, write, remove, finding, assertFindings,
} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {compileWorldbook} from '../core/catalog.mjs';
import {createProtocol} from '../core/protocol.mjs';
import {loadRouter, route, renderContext} from '../core/router.mjs';
import {buildReferenceIndex} from '../core/references.mjs';
import {formatWorldbook} from '../core/format.mjs';
import {runIf} from '../cli/if.mjs';
import {runPreview} from '../cli/preview.mjs';
import {runContext} from '../cli/context.mjs';
import {runTrace} from '../cli/trace.mjs';

function capture() {
  let out = '', err = '';
  return {
    stdout: {write(chunk) { out += String(chunk); }},
    stderr: {write(chunk) { err += String(chunk); }},
    get out() { return out; },
    get err() { return err; },
  };
}

// 在雾港临时副本上构建双世界线（正史默认 + 异闻），含世界线条件切期、世界线专属事件、专属概况与归属方案。
async function multiWorldlineFixture(t) {
  const root = await fixture(t);

  await write(root, '历史/世界线/正史.yaml', {
    概述: '北湾风浪如常，灯塔照旧巡守。',
    默认: true,
    角色组: {
      周岚: {启用: true},
    },
  });
  await write(root, '历史/世界线/异闻.yaml', {
    概述: '大雾之后北湾暗潮涌动，灯塔另起新规。',
    默认: false,
    角色组: {
      周岚: {启用: true},
      白棠: {启用: false},
    },
  });

  // 为既有开局方案补上世界线与可选开局地点。
  await edit(root, '历史/开局方案/码头少年.yaml', plan => {
    plan.世界线 = '正史';
    plan.开局地点 = '码头区';
  });
  await edit(root, '历史/开局方案/补考之年.yaml', plan => {
    plan.世界线 = '正史';
  });
  await write(root, '历史/开局方案/异闻雾夜.yaml', {
    世界线: '异闻',
    概述: '异闻世界线下从码头启程。',
    开局时间: '潮历073年',
    开局地点: '灯塔',
    角色组: {
      白棠: {启用: true},
    },
  });

  // 为周岚增加大雾之夜后按世界线分流的两份切期档案，及仅靠世界线覆盖默认档案的示例在秦守上演示。
  await fs.cp(
    path.join(root, '角色/周岚/档案/周岚·港务期'),
    path.join(root, '角色/周岚/档案/周岚·正史守塔期'),
    {recursive: true},
  );
  await fs.cp(
    path.join(root, '角色/周岚/档案/周岚·港务期'),
    path.join(root, '角色/周岚/档案/周岚·异闻暗潮期'),
    {recursive: true},
  );
  await edit(root, '角色/周岚/角色组.yaml', group => {
    group.档案.push(
      {
        档案ID: '周岚·正史守塔期',
        前置档案: '周岚·港务期',
        生效条件: {
          all: [
            {事件确认: {事件ID: '大雾之夜'}},
            {世界线: {世界线ID: '正史'}},
          ],
        },
        初始能力: {名望: '熟手'},
      },
      {
        档案ID: '周岚·异闻暗潮期',
        前置档案: '周岚·港务期',
        生效条件: {
          all: [
            {事件确认: {事件ID: '大雾之夜'}},
            {世界线: {世界线ID: '异闻'}},
          ],
        },
        初始能力: {名望: '匠人'},
      },
    );
  });

  // 秦守：仅凭 {世界线: {世界线ID: '异闻'}} + 前置档案 覆盖默认档案。
  await fs.cp(
    path.join(root, '角色/秦守/档案/秦守·守塔期'),
    path.join(root, '角色/秦守/档案/秦守·异闻守塔期'),
    {recursive: true},
  );
  await edit(root, '角色/秦守/角色组.yaml', group => {
    group.档案.push({
      档案ID: '秦守·异闻守塔期',
      前置档案: '秦守·守塔期',
      生效条件: {世界线: {世界线ID: '异闻'}},
      初始能力: {名望: '匠人'},
    });
  });

  // 新增一条仅在异闻世界线发生的预设事件，用于测试 ygg if --世界线 对比。
  await write(root, '历史/事件/异闻暗灯/事件.txt', {
    事件ID: '异闻暗灯',
    事件概要: '异闻世界线中北湾暗灯在雾夜之后亮起。',
    主类型: '个人',
    标签: ['航行'],
    事件结果: ['知识变化'],
    触发时间: {最早: '潮历073年02月01日', 最晚: '潮历073年02月01日'},
    地点: ['灯塔'],
    确认策略: '自动确认',
    核心参与者: ['秦守'],
    门槛: {世界线: {世界线ID: '异闻'}},
    默认分支: '暗灯初燃',
    分支: [
      {
        分支ID: '暗灯初燃',
        分支条件: '异闻世界线下的灯塔燃起暗灯。',
        分支结果: '北湾暗灯彻夜不灭。',
        变化: [
          {路径: '角色.秦守.知识', 操作: '新增', 值: '暗灯已在雾夜之后重燃'},
        ],
      },
    ],
  });

  return root;
}

test('YG-WL-01-A2：多世界线切期（事件前开局局内切期、事件后开局封卷切期）、纯世界线覆写与角色组合并优先级', async t => {
  const root = await multiWorldlineFixture(t);
  assertFindings(await checkWorldbook(root), [], '多世界线基础夹具应 0 错误 0 提示');

  const {catalog, decl} = await compileWorldbook(root, {fs, path});
  const protocol = createProtocol({catalog, decl});

  // 1) 事件前开局（大雾之夜为潮历071年04月20日）→ 局内确认大雾之夜 → 按各自世界线切期。
  for (const [wl, expectedArchive] of [['正史', '周岚·正史守塔期'], ['异闻', '周岚·异闻暗潮期']]) {
    let state = protocol.seal({世界线: wl, 开局时间: '潮历071年04月20日'});
    assert.equal(state.开局.世界线, wl);
    assert.equal(protocol.resolveProfile(state, '周岚').档案ID, '周岚·港务期');
    // 秦守在异闻下开局即生效纯世界线档案，正史下维持默认档案。
    assert.equal(protocol.resolveProfile(state, '秦守').档案ID, wl === '异闻' ? '秦守·异闻守塔期' : '秦守·守塔期');
    const confirmed = protocol.confirmEvent(state, {事件ID: '大雾之夜', 分支ID: '发生'});
    state = confirmed.state;
    assert.equal(protocol.resolveProfile(state, '周岚').档案ID, expectedArchive);
  }

  // 2) 事件后开局 → 封卷直接切期。
  const afterMain = protocol.seal({世界线: '正史', 开局时间: '潮历072年'});
  const afterAlt = protocol.seal({世界线: '异闻', 开局时间: '潮历072年'});
  assert.equal(protocol.resolveProfile(afterMain, '周岚').档案ID, '周岚·正史守塔期');
  assert.equal(protocol.resolveProfile(afterAlt, '周岚').档案ID, '周岚·异闻暗潮期');
  assert.equal(afterMain.事件.异闻暗灯, undefined);
  const endAlt = protocol.seal({世界线: '异闻', 开局时间: '潮历074年'});
  assert.equal(endAlt.事件.异闻暗灯?.状态, 1);

  // 3) 角色组逐键合并优先级：角色组默认 < 世界线.角色组 < 方案.角色组 < config.角色组。
  // 异闻世界线设 白棠: {启用: false}；异闻雾夜方案设 白棠: {启用: true}；config 可再覆盖版本或启用。
  const fromWlOnly = protocol.seal({世界线: '异闻', 开局时间: '潮历073年'});
  assert.equal(fromWlOnly.开局.角色组.白棠.启用, false);
  const fromPlan = protocol.seal({方案: '异闻雾夜'});
  assert.equal(fromPlan.开局.世界线, '异闻');
  assert.equal(fromPlan.开局.角色组.白棠.启用, true);
  // 逐键浅合并：世界线设版本，方案设启用，config 再改启用时保留世界线的版本。
  await edit(root, '历史/世界线/异闻.yaml', wl => {
    wl.角色组.灯塔学徒 = {版本ID: '林汐'};
  });
  await edit(root, '历史/开局方案/异闻雾夜.yaml', plan => {
    plan.角色组.灯塔学徒 = {启用: true};
  });
  const compiled2 = await compileWorldbook(root, {fs, path});
  const protocol2 = createProtocol({catalog: compiled2.catalog, decl: compiled2.decl});
  const merged = protocol2.seal({方案: '异闻雾夜', 角色组: {灯塔学徒: {启用: false}}});
  assert.deepEqual(merged.开局.角色组.灯塔学徒, {启用: false, 版本ID: '林汐'});

  // 4) 封卷冲突：传入与方案世界线冲突的 世界线 报 封卷.参数。
  assert.throws(() => protocol2.seal({世界线: '正史', 方案: '异闻雾夜'}), err => err?.code === '封卷.参数');
});

test('YG-WL-01-A2负例：世界线校验、多默认、方案缺世界线、单世界线卡误写世界线与否定世界线档案条件', async t => {
  // 多世界线卡方案缺世界线 + 双默认 + 非法开局地点
  const root = await multiWorldlineFixture(t);
  await edit(root, '历史/世界线/异闻.yaml', wl => { wl.默认 = true; });
  await edit(root, '历史/开局方案/异闻雾夜.yaml', plan => {
    delete plan.世界线;
    plan.开局地点 = '不存在的码头';
  });
  const res = await checkWorldbook(root);
  assert.ok(res.errors.some(item => item.规则 === '开局.世界线格式' && item.文件 === '历史/世界线'));
  assert.ok(res.errors.some(item => item.规则 === '开局.方案格式' && item.文件 === '历史/开局方案/异闻雾夜.yaml' && item.说明.includes('必须指定世界线')));
  assert.ok(res.errors.some(item => item.规则 === '开局.方案格式' && item.文件 === '历史/开局方案/异闻雾夜.yaml' && item.说明.includes('开局地点')));

  // 仅否定世界线（无正向事件确认或正向世界线）作为非默认档案生效条件报错
  const root2 = await multiWorldlineFixture(t);
  await edit(root2, '角色/秦守/角色组.yaml', group => {
    const item = group.档案.find(p => p.档案ID === '秦守·异闻守塔期');
    item.生效条件 = {none: [{世界线: {世界线ID: '正史'}}]};
  });
  const res2 = await checkWorldbook(root2);
  assert.ok(res2.errors.some(item => item.规则 === '档案项.生效条件' && item.文件 === '角色/秦守/角色组.yaml'));

  // 单世界线卡方案写世界线报错，封卷传世界线报 封卷.参数
  const single = await fixture(t);
  const compiledSingle = await compileWorldbook(single, {fs, path});
  const protoSingle = createProtocol({catalog: compiledSingle.catalog, decl: compiledSingle.decl});
  assert.throws(() => protoSingle.seal({开局时间: '潮历072年', 世界线: '正史'}), err => err?.code === '封卷.参数');
  await edit(single, '历史/开局方案/码头少年.yaml', plan => { plan.世界线 = '正史'; });
  const resSingle = await checkWorldbook(single);
  assert.ok(resSingle.errors.some(item => item.规则 === '开局.世界线引用' && item.文件 === '历史/开局方案/码头少年.yaml'));
});

test('YG-WL-01-A3：可选世界线专属概况（共享、按世界线追加、不泄露、措辞与目录引用检查）', async t => {
  const root = await multiWorldlineFixture(t);

  // 无专属概况时，两条世界线共享同一份公共世界概况
  {
    const {protocol, router} = await loadRouter(root, {fs, path});
    const s1 = protocol.seal({世界线: '正史', 开局时间: '潮历072年'});
    const s2 = protocol.seal({世界线: '异闻', 开局时间: '潮历072年'});
    const r1 = route(router, s1, []);
    const r2 = route(router, s2, []);
    assert.equal(r1.context.世界概况, r2.context.世界概况);
    assert.ok(r1.context.世界概况.length > 0);
  }

  // 添加 异闻 专属概况
  await write(root, '世界概况/世界线/异闻/异闻纪要.txt', {
    暗潮格局: '异闻世界线中北湾暗潮由旧灯塔残部暗中维持。',
  });
  assertFindings(await checkWorldbook(root), [], '合法世界线专属概况应 0 错误 0 提示');

  {
    const {protocol, router} = await loadRouter(root, {fs, path});
    const sMain = protocol.seal({世界线: '正史', 开局时间: '潮历072年'});
    const sAlt = protocol.seal({世界线: '异闻', 开局时间: '潮历072年'});
    const rMain = route(router, sMain, []);
    const rAlt = route(router, sAlt, []);
    assert.ok(!rMain.context.世界概况.includes('暗潮格局'), '正史不应泄露异闻专属概况');
    assert.ok(rAlt.context.世界概况.includes('暗潮格局'), '异闻应追加专属概况');
    assert.ok(rAlt.context.世界概况.startsWith(rMain.context.世界概况 + '\n\n'), '专属概况须以 \\n\\n 追加在公共概况之后');
    assert.ok(renderContext(rAlt.context).includes('<世界概况>'));
  }

  // 删除公共世界概况后：异闻仅输出专属概况，正史省略 <世界概况>
  {
    const rootNoShared = await multiWorldlineFixture(t);
    for (const entry of await fs.readdir(path.join(rootNoShared, '世界概况'))) {
      if (entry.endsWith('.txt')) await remove(rootNoShared, `世界概况/${entry}`);
    }
    await write(rootNoShared, '世界概况/世界线/异闻/异闻纪要.txt', {
      暗潮格局: '仅异闻可见的独立背景。',
    });
    const {protocol, router} = await loadRouter(rootNoShared, {fs, path});
    const rMain = route(router, protocol.seal({世界线: '正史', 开局时间: '潮历072年'}), []);
    const rAlt = route(router, protocol.seal({世界线: '异闻', 开局时间: '潮历072年'}), []);
    assert.equal(rMain.context.世界概况, undefined);
    assert.ok(!renderContext(rMain.context).includes('<世界概况>'));
    assert.ok(rAlt.context.世界概况.includes('仅异闻可见的独立背景'));
  }

  // 专属概况受 checkText 措辞检查，非法世界线目录报 开局.世界线引用，散文件报 目录.未知文件
  await write(root, '世界概况/世界线/异闻/异闻纪要.txt', {
    暗潮格局: '此处误写了禁用词变量。',
  });
  await write(root, '世界概况/世界线/不存在世界线/说明.txt', {
    备注: '指向不存在的世界线。',
  });
  await write(root, '世界概况/世界线/散落.txt', {
    备注: '直接放在世界线目录下的散文件。',
  });
  const checked = await checkWorldbook(root);
  assert.ok(checked.errors.some(item => item.规则 === '文本.禁用词' && item.文件 === '世界概况/世界线/异闻/异闻纪要.txt'));
  assert.ok(checked.errors.some(item => item.规则 === '开局.世界线引用' && item.文件 === '世界概况/世界线/不存在世界线'));
  assert.ok(checked.errors.some(item => item.规则 === '目录.未知文件' && item.文件 === '世界概况/世界线/散落.txt'));
});

test('YG-WL-01-A4：按世界线抽样、ygg if/preview/context/trace/format 正负例', async t => {
  const root = await multiWorldlineFixture(t);
  await write(root, '世界概况/世界线/异闻/异闻纪要.txt', {
    暗潮格局: '异闻专属世界概况文本。',
  });

  // 1) 同世界线双档案冲突仍能稳定报 抽样.档案冲突
  const conflictRoot = await multiWorldlineFixture(t);
  await fs.cp(
    path.join(conflictRoot, '角色/周岚/档案/周岚·港务期'),
    path.join(conflictRoot, '角色/周岚/档案/周岚·正史冲突期'),
    {recursive: true},
  );
  await edit(conflictRoot, '角色/周岚/角色组.yaml', group => {
    group.档案.push({
      档案ID: '周岚·正史冲突期',
      前置档案: '周岚·港务期',
      生效条件: {
        all: [
          {事件确认: {事件ID: '大雾之夜'}},
          {世界线: {世界线ID: '正史'}},
        ],
      },
    });
  });
  const conflictCheck = await checkWorldbook(conflictRoot);
  assert.ok(conflictCheck.errors.some(item => item.规则 === '抽样.档案冲突' && item.文件 === '角色/周岚/角色组.yaml'));

  // 2) ygg if --世界线
  {
    const io = capture();
    const code = await runIf([root, '--世界线', '异闻', '--json'], io);
    assert.equal(code, 0);
    const json = JSON.parse(io.out);
    assert.equal(json.输入.世界线, '异闻');
    assert.ok(json.新发生.includes('异闻暗灯'));

    const badIo = capture();
    const badCode = await runIf([root, '--世界线', '正史', '--方案', '异闻雾夜', '--json'], badIo);
    assert.equal(badCode, 1);
    assert.ok(JSON.parse(badIo.out).异常.some(item => item.规则 === 'if.参数冲突'));
  }

  // 3) ygg preview --世界线
  {
    const ioMain = capture();
    assert.equal(await runPreview([root, '周岚', '--世界线', '正史', '--json'], ioMain), 0);
    const mainJson = JSON.parse(ioMain.out);
    assert.equal(mainJson.世界线, '正史');
    assert.equal(mainJson.预览.档案ID, '周岚·正史守塔期');

    const ioAlt = capture();
    assert.equal(await runPreview([root, '周岚', '--世界线', '异闻', '--json'], ioAlt), 0);
    const altJson = JSON.parse(ioAlt.out);
    assert.equal(altJson.世界线, '异闻');
    assert.equal(altJson.预览.档案ID, '周岚·异闻暗潮期');

    const conflictIo = capture();
    assert.equal(await runPreview([root, '周岚', '--世界线', '异闻', '--本局', 'x.json'], conflictIo), 1);
  }

  // 4) ygg context --世界线
  {
    const ioAlt = capture();
    assert.equal(await runContext([root, '--世界线', '异闻', '--raw'], ioAlt), 0);
    assert.ok(ioAlt.out.includes('异闻专属世界概况文本'));

    const ioMain = capture();
    assert.equal(await runContext([root, '--世界线', '正史', '--raw'], ioMain), 0);
    assert.ok(!ioMain.out.includes('异闻专属世界概况文本'));

    const ioJson = capture();
    assert.equal(await runContext([root, '--世界线', '异闻', '--json'], ioJson), 0);
    assert.equal(JSON.parse(ioJson.out).输入.世界线, '异闻');

    const badCtx = capture();
    assert.equal(await runContext([root, '--世界线', '不存在'], badCtx), 1);
  }

  // 5) ygg trace 世界线:<ID> 与 开局方案.开局地点 引用
  {
    const io = capture();
    assert.equal(await runTrace([root, '世界线:异闻', '--json'], io), 0);
    const traced = JSON.parse(io.out);
    assert.equal(traced.对象.类型, '世界线');
    assert.ok(traced.引用它.some(item => item.来源对象 === '开局方案:异闻雾夜' && item.引用种类 === '开局世界线'));
    assert.ok(traced.引用它.some(item => item.来源对象 === '事件:异闻暗灯' && item.引用种类 === '世界线'));
    assert.ok(traced.引用它.some(item => item.来源对象 === '档案:周岚:周岚·异闻暗潮期' && item.引用种类 === '世界线'));
    assert.ok(traced.它引用.some(item => item.目标对象 === '角色组:白棠' && item.引用种类 === '世界线角色组'));

    const {catalog, decl} = await compileWorldbook(root, {fs, path});
    const index = buildReferenceIndex(catalog, decl);
    const planTrace = index.query('开局方案:异闻雾夜');
    assert.ok(planTrace.它引用.some(item => item.目标对象 === '条目:地点:灯塔' && item.引用种类 === '开局地点'));
  }

  // 6) ygg format 识别并重排 历史/世界线/*.yaml 与新版 历史/开局方案/*.yaml
  {
    await fs.writeFile(path.join(root, '历史/世界线/异闻.yaml'), '角色组:\n  白棠:\n    启用: false\n默认: false\n概述: 重排测试。\n');
    await fs.writeFile(path.join(root, '历史/开局方案/异闻雾夜.yaml'), '开局地点: 灯塔\n概述: 重排方案。\n世界线: 异闻\n');
    const report = await formatWorldbook(root, {write: true});
    assert.equal(report.项目.异常, 0);
    assert.ok(report.已写入.some(item => item.文件 === '历史/世界线/异闻.yaml'));
    assert.ok(report.已写入.some(item => item.文件 === '历史/开局方案/异闻雾夜.yaml'));
    const wlText = await fs.readFile(path.join(root, '历史/世界线/异闻.yaml'), 'utf8');
    const planText = await fs.readFile(path.join(root, '历史/开局方案/异闻雾夜.yaml'), 'utf8');
    assert.ok(wlText.indexOf('概述:') < wlText.indexOf('默认:') && wlText.indexOf('默认:') < wlText.indexOf('角色组:'));
    assert.ok(planText.indexOf('世界线:') < planText.indexOf('概述:') && planText.indexOf('概述:') < planText.indexOf('开局地点:'));
  }
});

test('YG-WL-01-A5：自建玩家初始能力与初始装备落盘、路由展开与负例校验', async t => {
  const root = await fixture(t);
  const {protocol, router} = await loadRouter(root, {fs, path});

  // 1) 未传初始能力与初始装备时，与旧快照 100% 一致（无事件前 state.角色 为 {}，不创建 角色.玩家，玩家对象无多余键）
  const bareEarly = protocol.seal({开局时间: '潮历060年', 玩家: {模式: '自建', 档案: {姓名: '无名客'}}});
  assert.deepEqual(bareEarly.角色, {});
  const bare = protocol.seal({开局时间: '潮历072年', 玩家: {模式: '自建', 档案: {姓名: '无名客'}}});
  assert.equal(bare.角色.玩家, undefined);
  assert.deepEqual(Object.keys(bare.开局.玩家), ['模式', '档案']);

  // 2) 带初始能力（等级映射/单值等级/集合）与初始装备封卷，写入 state.角色.玩家 并置 已初始化: true
  const seeded = protocol.seal({
    开局时间: '潮历072年',
    玩家: {
      模式: '自建',
      档案: {姓名: '沉渊', 性别: '男', 种族: '人族'},
      初始能力: {
        技艺: {灯语: '熟手'},
        名望: '熟手',
        天赋: ['雾中视·辨影'],
      },
      初始装备: [
        {装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰间'},
      ],
    },
  });
  assert.equal(seeded.角色.玩家.已初始化, true);
  assert.deepEqual(seeded.角色.玩家.技艺, {灯语: '熟手'});
  assert.equal(seeded.角色.玩家.名望, '熟手');
  assert.deepEqual(seeded.角色.玩家.天赋, ['雾中视·辨影']);
  assert.deepEqual(seeded.角色.玩家.装备, {'工具·铜扳手': {状态: '完好', 位置: '腰间'}});

  // 3) 写入当前地点后，路由自动输出玩家当前能力、可用技能并展开装备与技能条目
  const withScene = protocol.writeScene(seeded, {当前地点: {地标: '灯塔', 场景: '塔顶'}}).state;
  const routed = route(router, withScene, []);
  const playerEntry = routed.context.在场角色.find(item => item.角色组ID === '玩家');
  assert.ok(playerEntry);
  assert.deepEqual(playerEntry.当前能力, {技艺: {灯语: '熟手'}, 名望: '熟手', 天赋: ['雾中视·辨影'], 习惯: []});
  assert.ok(playerEntry.可用技能.includes('灯语·短讯'));
  assert.ok(playerEntry.可用技能.includes('雾中视·辨影'));
  assert.ok(routed.context.条目.装备?.some(item => item.装备ID === '工具·铜扳手'));
  assert.ok(routed.context.条目.技能?.some(item => item.技能ID === '雾中视·辨影'));

  // 4) 负例：封卷与状态校验均拒绝非法维度、空等级映射、非法等级、未知/重复装备、非法装备状态
  const badPlayers = [
    {模式: '自建', 档案: {}, 初始能力: {}},
    {模式: '自建', 档案: {}, 初始能力: {未知维度: '熟手'}},
    {模式: '自建', 档案: {}, 初始能力: {技艺: {}}},
    {模式: '自建', 档案: {}, 初始能力: {名望: '不存在等级'}},
    {模式: '自建', 档案: {}, 初始装备: []},
    {模式: '自建', 档案: {}, 初始装备: [{装备ID: '不存在装备', 状态: '完好', 位置: '腰间'}]},
    {模式: '自建', 档案: {}, 初始装备: [
      {装备ID: '工具·铜扳手', 状态: '完好', 位置: '腰间'},
      {装备ID: '工具·铜扳手', 状态: '完好', 位置: '背包'},
    ]},
    {模式: '自建', 档案: {}, 初始装备: [{装备ID: '工具·铜扳手', 状态: '非法状态', 位置: '腰间'}]},
  ];
  for (const player of badPlayers) {
    assert.throws(() => protocol.seal({开局时间: '潮历072年', 玩家: player}), err => err?.code === '封卷.参数');
    const tampered = structuredClone(bare);
    tampered.开局.玩家 = player;
    assert.throws(() => protocol.createReadView(tampered), err => err?.code === '协议.参数');
  }
});

test('YG-WL-01-A6：开局选项允许省略 问题，兼容既有写法并拦截非法 问题', async t => {
  // 1) 省略 问题 通过检查（0 错误 0 提示）
  const omitted = await fixture(t);
  await edit(omitted, '历史/开局选项.yaml', options => {
    for (const item of options.选项) delete item.问题;
  });
  assertFindings(await checkWorldbook(omitted), [], '省略问题应 0 错误 0 提示');

  // 2) 非法问题（空串 / 非文本）仍报错
  for (const bad of ['', 123]) {
    const root = await fixture(t);
    await edit(root, '历史/开局选项.yaml', options => {
      options.选项[0].问题 = bad;
    });
    const res = await checkWorldbook(root);
    assert.ok(res.errors.some(item => item.规则 === '开局.选项格式' && item.文件 === '历史/开局选项.yaml'));
  }
});
