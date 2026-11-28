import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import {test, assert, fs, path, project, example} from './helpers.mjs';
import {
  FORBIDDEN_TERMS,
  SYSTEM_TERMS,
  WRITING_TERMS,
  CONDITION_TYPES,
  EVENT_BRANCH_FIELDS,
} from '../core/contract.mjs';
import {evaluateCondition, conditionReferences} from '../core/conditions.mjs';
import {parseYaml} from '../core/yaml.mjs';
import {checkEvents, isCompoundEventName} from '../checker/rules/events.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {probeCard, runCli as runMountCli} from '../skills/ygg-playtest/scripts/mount-card.mjs';
import {
  parseThemeYaml,
  validateThemeEntry,
  validateThemesDir,
  runCli as runThemeCli,
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

function makeSyntheticDecl({worldType = '世界'} = {}) {
  const classification = {
    主类型: ['世界', '势力', '个人'],
    标签: ['节点'],
    事件结果: {纪事存照: [], 关系变化: [], 职位变化: [], 装备变动: []},
  };
  if (worldType) classification.世界事件 = worldType;
  return {
    calendar: {前缀: '纪元', 年位数: 3, 月数: 12, 每月天数: 30},
    classification,
    variables: {角色: {}, 本局: {}},
    marks: {},
  };
}

function makeEvent({
  id,
  title = undefined,
  mainType = '个人',
  core = [],
  policy = '条件确认',
  results = ['纪事存照'],
  threshold = undefined,
  branches = [{分支ID: '默认', 分支条件: '自然发生', 分支结果: '完成', 变化: []}],
}) {
  const content = {
    事件ID: id,
    事件概要: `${id}概要。`,
    主类型: mainType,
    标签: ['节点'],
    事件结果: results,
    触发时间: {最早: '纪元001年', 最晚: '纪元002年'},
    确认策略: policy,
    核心参与者: core,
    默认分支: branches[0].分支ID,
    分支: branches,
  };
  if (title !== undefined) content.事件标题 = title;
  if (threshold !== undefined) content.门槛 = threshold;
  return {
    id,
    文件: `历史/事件/${id}/事件.txt`,
    原文: 'stub',
    内容: content,
  };
}

function makeCatalog(events, groups = ['角色甲', '角色乙', '角色丙', '角色丁', '角色戊']) {
  return {
    groups: groups.map(id => ({id, 内容: {显示名: id, 档案: []}, 档案: []})),
    entries: {},
    chains: [],
    worldlines: [],
    openingPlans: [],
    openingOptions: null,
    events,
  };
}

test('YG-SKILL-AUDIT-01-1：禁用词/系统词/陈旧词与内核 contract 100% 同步防漂移', async () => {
  const sharedRedline = await fs.readFile(path.join(project, 'skills/shared/写作红线.md'), 'utf8');
  for (const term of FORBIDDEN_TERMS) {
    assert.ok(sharedRedline.includes(term), `skills/shared/写作红线.md 缺少禁用词：${term}`);
  }
  for (const term of SYSTEM_TERMS) {
    assert.ok(sharedRedline.includes(term), `skills/shared/写作红线.md 缺少系统视角词：${term}`);
  }
  for (const term of WRITING_TERMS) {
    assert.ok(sharedRedline.includes(term), `skills/shared/写作红线.md 缺少陈旧写法词：${term}`);
  }

  const forbiddenTargets = [
    'skills/ygg-foundation/references/声明与写作要点.md',
    'skills/ygg-profile/references/档案字段与红线.md',
    'skills/ygg-scenes/references/填景字段与红线.md',
    'skills/ygg-entries/references/条目与红线.md',
    'skills/ygg-migrate/references/概念映射与拆解规则.md',
  ];
  for (const rel of forbiddenTargets) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    for (const term of FORBIDDEN_TERMS) {
      assert.ok(text.includes(term), `${rel} 缺少禁用词：${term}`);
    }
  }

  const entriesRef = await fs.readFile(path.join(project, 'skills/ygg-entries/references/条目与红线.md'), 'utf8');
  for (const term of SYSTEM_TERMS) {
    assert.ok(entriesRef.includes(term), `skills/ygg-entries/references/条目与红线.md 缺少系统视角词：${term}`);
  }

  for (const rel of [
    'skills/ygg-profile/references/档案字段与红线.md',
    'skills/ygg-scenes/references/填景字段与红线.md',
  ]) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    for (const term of WRITING_TERMS) {
      assert.ok(text.includes(term), `${rel} 缺少陈旧写法词：${term}`);
    }
  }
});

test('YG-SKILL-AUDIT-01-2：ygg-foundation 与 ygg-entries 设定与条目契约防漂移', async () => {
  const foundationSkill = await fs.readFile(path.join(project, 'skills/ygg-foundation/SKILL.md'), 'utf8');
  const foundationRef = await fs.readFile(path.join(project, 'skills/ygg-foundation/references/声明与写作要点.md'), 'utf8');
  assert.doesNotMatch(foundationRef, /有装备须含/u, 'ygg-foundation 不得残留“有装备须含”错误说法');
  assert.match(foundationRef, /无条件必写.*词表\.装备状态|词表\.装备状态.*无条件必写/u);
  assert.match(foundationSkill, /角色分类\.yaml/u);
  for (const needle of ['单次增减上限', '档案切期', '综合实力', '等级门槛', '集合持有', '前缀字段', '档案追加字段', '同名说明', '在场角色', '提及窗口', '条目字符']) {
    assert.ok(foundationRef.includes(needle), `声明与写作要点.md 缺少：${needle}`);
  }

  const entriesRef = await fs.readFile(path.join(project, 'skills/ygg-entries/references/条目与红线.md'), 'utf8');
  for (const needle of ['按上下级', '按种类', '上级类型', '技能可用', '键字段', '等级字段', '文本.系统视角', '平铺']) {
    assert.ok(entriesRef.includes(needle), `条目与红线.md 缺少：${needle}`);
  }
});

test('YG-SKILL-AUDIT-01-3：ygg-skeleton 核心参与者五重机制、12 条件、分支四字段与变化矩阵防漂移', async () => {
  const skeletonRef = await fs.readFile(path.join(project, 'skills/ygg-skeleton/references/骨架字段与检查.md'), 'utf8');
  for (const condType of CONDITION_TYPES) {
    assert.ok(skeletonRef.includes(condType), `骨架参考页缺少条件类型：${condType}`);
  }
  const branchTextFields = ['事件概要', '影响范围', '公开信息', '隐秘信息'];
  for (const field of branchTextFields) {
    assert.ok(EVENT_BRANCH_FIELDS.includes(field));
    assert.ok(skeletonRef.includes(field), `骨架参考页缺少分支专属字段：${field}`);
  }
  for (const needle of [
    '核心参与者五重硬机制',
    '变化.角色未保证启用',
    '终身不可逆排斥',
    '年精度按首日起点比较陷阱',
    '初始化方式` 缺省为 `显式确认',
    '唯一: true',
    '反事实独立成败测试',
    '核心参与者正交测试',
    '跨日/跨地拆分铁律',
    '单焦点分支测试',
    '抽样.档案冲突',
    '4096',
  ]) {
    assert.ok(skeletonRef.includes(needle), `骨架参考页缺少关键契约：${needle}`);
  }
});

test('YG-SKILL-AUDIT-01-4：ygg-profile、ygg-scenes、ygg-pack 与 ygg-edit/theme/guide 契约与口径统一', async () => {
  const profileRef = await fs.readFile(path.join(project, 'skills/ygg-profile/references/档案字段与红线.md'), 'utf8');
  for (const needle of ['严禁在档案中写完整台词', '二十岁', '口头特征', '共享档案', '镜像档案', '精简']) {
    assert.ok(profileRef.includes(needle), `档案字段与红线.md 缺少：${needle}`);
  }

  const scenesRef = await fs.readFile(path.join(project, 'skills/ygg-scenes/references/填景字段与红线.md'), 'utf8');
  for (const needle of ['候选阶段', '覆盖', '合并追加', '严禁剧透结局', '知识', '原台词', 'ygg context']) {
    assert.ok(scenesRef.includes(needle), `填景字段与红线.md 缺少：${needle}`);
  }

  const packRef = await fs.readFile(path.join(project, 'skills/ygg-pack/references/卡面与打包核对.md'), 'utf8');
  const packSkill = await fs.readFile(path.join(project, 'skills/ygg-pack/SKILL.md'), 'utf8');
  for (const field of ['自定义装备', '自定义技能', '额外技能', '移除技能', '能力覆写', '移除能力', '额外装备', '移除装备']) {
    assert.ok(packRef.includes(field), `卡面与打包核对.md 缺少玩家定制字段：${field}`);
  }
  assert.match(packRef, /四项核对/u);
  assert.match(packSkill, /四项核对/u);
  assert.doesNotMatch(packSkill, /核对构建输出三项|三项核对/u, 'ygg-pack SKILL.md 不得残留旧“三项核对”口径');

  const guideSkill = await fs.readFile(path.join(project, 'skills/ygg-guide/SKILL.md'), 'utf8');
  const sharedTools = await fs.readFile(path.join(project, 'skills/shared/工具与检查.md'), 'utf8');
  assert.match(guideSkill, /四项核对/u);
  assert.doesNotMatch(guideSkill, /三项核对/u);
  assert.match(sharedTools, /四项核对/u);
  assert.doesNotMatch(sharedTools, /三项核对/u);

  const editSkill = await fs.readFile(path.join(project, 'skills/ygg-edit/SKILL.md'), 'utf8');
  const editRef = await fs.readFile(path.join(project, 'skills/ygg-edit/references/按级编辑与检查矩阵.md'), 'utf8');
  assert.match(editSkill, /外观级/u);
  assert.match(editSkill, /世界树·前端/u);
  assert.match(editRef, /暂存清单\.yaml/u);
  assert.match(editRef, /核心参与者/u);

  const themeRef = await fs.readFile(path.join(project, 'skills/ygg-theme/references/主题规范与令牌参考.md'), 'utf8');
  assert.match(themeRef, /8 类危险顶层全局选择器/u);
  assert.match(themeRef, /重复键/u);
  assert.match(themeRef, /warnings/u);

  const playtestRef = await fs.readFile(path.join(project, 'skills/ygg-playtest/references/五维验收矩阵与判定口径.md'), 'utf8');
  for (const key of ['openingSpec', 'openingGreeting', 'optionalPresent', 'requiredGroups', 'planOpenings', 'multiCategoryBranchEvents', 'coreParticipantHealth', 'bundle.themes']) {
    assert.ok(playtestRef.includes(key), `五维验收矩阵与判定口径.md 缺少：${key}`);
  }
});

test('YG-SKILL-AUDIT-01-5：四层防拼盘（4 条机械拆分测试）、核心参与者最小化与十二个作者 skill 计数齐平', async () => {
  for (const rel of [
    'skills/ygg-read/SKILL.md',
    'skills/ygg-migrate/SKILL.md',
    'skills/ygg-skeleton/SKILL.md',
    'skills/shared/写作红线.md',
  ]) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    assert.match(text, /4\s*条机械/u, `${rel} 应包含 4 条机械拆分测试`);
    assert.match(text, /反事实独立成败/u, `${rel} 应包含反事实独立成败测试`);
    assert.match(text, /核心参与者/u, `${rel} 应包含核心参与者最小化原则`);
    assert.match(text, /世界事件/u, `${rel} 应说明世界事件核心参与者策略`);
  }

  for (const rel of [
    'skills/shared/工具与检查.md',
    'skills/shared/写作红线.md',
    'docs/00-概述.md',
    'docs/术语.md',
  ]) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    assert.doesNotMatch(text, /十一个(?:分层)?作者\s*skill/u, `${rel} 仍残留“十一个作者 skill”`);
    assert.match(text, /十二个(?:分层)?作者\s*skill/u, `${rel} 应同步更新为“十二个作者 skill”`);
  }
  const glossary = await fs.readFile(path.join(project, 'docs/术语.md'), 'utf8');
  assert.ok(glossary.includes('[世界树·前端](../skills/ygg-theme/SKILL.md)'), 'docs/术语.md 应补入 世界树·前端 链接');
});

test('YG-SKILL-AUDIT-01-6：事件.疑似拼盘 规则正反例精准识别且不产生错误级问题', () => {
  const positives = [
    '晋升与成婚',
    '学艺及宴会',
    '授勋暨巡游',
    '遇敌并夺宝',
    '出征兼巡边',
    '拜师、比武',
    '赴宴以及结盟',
    '结盟/分赃',
  ];
  const negatives = [
    '并州起兵',
    '两家和解',
    '祸及乡里',
    '参与议事',
    '吞并邻邦',
    '兼任太守',
    '及时驰援',
    '温和传教',
    '董卓兼并旧部',
  ];

  for (const name of positives) {
    assert.equal(isCompoundEventName(name), true, `应命中拼盘命名：${name}`);
  }
  for (const name of negatives) {
    assert.equal(isCompoundEventName(name), false, `不应误报固定词：${name}`);
  }

  const decl = makeSyntheticDecl({worldType: '世界'});
  const events = [
    ...positives.map(id => makeEvent({id})),
    makeEvent({id: '标题拼盘测试', title: '拜师、比武'}),
    ...negatives.map(id => makeEvent({id})),
  ];
  const issues = checkEvents(makeCatalog(events), decl);
  assert.equal(issues.filter(i => i.级别 === '错误').length, 0);

  const compoundHints = issues.filter(i => i.规则 === '事件.疑似拼盘');
  assert.equal(compoundHints.every(i => i.级别 === '提示'), true);
  assert.deepEqual(
    compoundHints.map(i => i.文件).sort(),
    [...positives, '标题拼盘测试'].map(id => `历史/事件/${id}/事件.txt`).sort(),
  );
});

test('YG-SKILL-AUDIT-01-7：事件.世界事件含核心参与者 正反例与 test/fixtures/雾港 0 错误 0 提示', async () => {
  const decl = makeSyntheticDecl({worldType: '世界'});
  const events = [
    makeEvent({id: '世界大事带人', mainType: '世界', core: ['角色甲']}),
    makeEvent({id: '世界大事留空', mainType: '世界', core: []}),
    makeEvent({id: '个人事件带人', mainType: '个人', core: ['角色甲']}),
  ];
  const issues = checkEvents(makeCatalog(events), decl);
  assert.equal(issues.filter(i => i.级别 === '错误').length, 0);

  const worldCoreHints = issues.filter(i => i.规则 === '事件.世界事件含核心参与者');
  assert.equal(worldCoreHints.length, 1);
  assert.equal(worldCoreHints[0].级别, '提示');
  assert.equal(worldCoreHints[0].文件, '历史/事件/世界大事带人/事件.txt');

  // 未声明 世界事件 时不触发
  const noWorldDecl = makeSyntheticDecl({worldType: null});
  const noWorldIssues = checkEvents(makeCatalog([makeEvent({id: '世界大事带人', mainType: '世界', core: ['角色甲']})]), noWorldDecl);
  assert.equal(noWorldIssues.filter(i => i.规则 === '事件.世界事件含核心参与者').length, 0);

  // test/fixtures/雾港 严格保持 0 错误 0 提示
  const wugangCheck = await checkWorldbook(example);
  assert.equal(wugangCheck.errors.length, 0);
  assert.equal(wugangCheck.hints.length, 0);
});

test('YG-SKILL-AUDIT-01-8：mount-card.mjs disabledImpact 分支门槛、事件串状态级联与 none 三值嵌套极性回归', () => {
  const decl = makeSyntheticDecl({worldType: '世界'});
  const catalog = {
    groups: ['停用角', '正常角'].map(id => ({id, 内容: {显示名: id, 档案: []}, 档案: []})),
    entries: {},
    chains: [
      {
        id: '双起点全断串',
        内容: {
          概述: '两个起点都因停用角阻塞',
          事件: ['串起点甲', '串起点乙', '串中段'],
          结局: [{事件ID: '串中段'}],
        },
      },
      {
        id: '双起点留一串',
        内容: {
          概述: '仅一个起点被阻塞，另一起点仍可启动',
          事件: ['半断起点被阻', '半断起点存活', '半断结局'],
          结局: [{事件ID: '半断结局'}],
        },
      },
    ],
    worldlines: [],
    openingPlans: [],
    openingOptions: null,
    events: [
      {
        id: '分支全依赖停用角',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          分支: [
            {分支ID: '甲支', 门槛: {角色启用: {角色组ID: '停用角'}}, 变化: []},
            {分支ID: '乙支', 门槛: {同处: {角色组ID: ['停用角', '正常角']}}, 变化: []},
          ],
        },
      },
      {
        id: '有兜底分支存活',
        内容: {
          主类型: '个人',
          确认策略: '自动确认',
          核心参与者: [],
          分支: [
            {分支ID: '需停用角', 门槛: {角色启用: {角色组ID: '停用角'}}, 变化: []},
            {分支ID: '兜底', 变化: []},
          ],
        },
      },
      {
        id: '单层none排除停用角存活',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {none: [{角色启用: {角色组ID: '停用角'}}]},
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '双层none依赖停用角阻塞',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {none: [{none: [{角色启用: {角色组ID: '停用角'}}]}]},
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: 'none_all含未知与停用角存活',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {none: [{all: [{角色启用: {角色组ID: '停用角'}}, {剧情标记: {标记ID: '某标记', 比较: '等于', 值: '开'}}]}]},
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: 'none_all双真阻塞',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {
            none: [{
              all: [
                {none: [{角色启用: {角色组ID: '停用角'}}]},
                {none: [{角色状态: {角色组ID: '停用角', 字段: '所在', 属于: ['某地']}}]},
              ],
            }],
          },
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: 'none_any含真与未知阻塞',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {
            none: [{
              any: [
                {none: [{角色启用: {角色组ID: '停用角'}}]},
                {剧情标记: {标记ID: '某标记', 比较: '等于', 值: '开'}},
              ],
            }],
          },
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: 'any_none与正常角存活',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          门槛: {any: [{none: [{角色启用: {角色组ID: '停用角'}}]}, {角色启用: {角色组ID: '正常角'}}]},
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '全分支级联阻塞',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: [],
          分支: [
            {分支ID: '支1', 门槛: {事件确认: {事件ID: '分支全依赖停用角'}}, 变化: []},
            {分支ID: '支2', 门槛: {none: [{none: [{事件确认: {事件ID: '双层none依赖停用角阻塞'}}]}]}, 变化: []},
          ],
        },
      },
      {
        id: '串起点甲',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: ['停用角'], 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '串起点乙',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {事件确认: {事件ID: '分支全依赖停用角'}}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '串中段',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {any: [{事件确认: {事件ID: '串起点甲'}}, {事件确认: {事件ID: '串起点乙'}}]}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '依赖断串进行中',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {事件串状态: {事件串ID: '双起点全断串', 状态: '进行中'}}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '依赖断串已结束',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {事件串状态: {事件串ID: '双起点全断串', 状态: '已结束'}}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '依赖断串未开始存活',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {事件串状态: {事件串ID: '双起点全断串', 状态: '未开始'}}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '排斥断串进行中存活',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {none: [{事件串状态: {事件串ID: '双起点全断串', 状态: '进行中'}}]}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '半断起点被阻',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: ['停用角'], 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '半断起点存活',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: ['正常角'], 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '半断结局',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {any: [{事件确认: {事件ID: '半断起点被阻'}}, {事件确认: {事件ID: '半断起点存活'}}]}, 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '依赖半断串存活',
        内容: {主类型: '个人', 确认策略: '条件确认', 核心参与者: [], 门槛: {事件串状态: {事件串ID: '双起点留一串', 状态: '进行中'}}, 分支: [{分支ID: '默认', 变化: []}]},
      },
    ],
  };

  const withHook = probeCard({catalog, decl, evaluateCondition, conditionReferences}, {disableGroups: ['停用角']});
  const fallback = probeCard({catalog, decl}, {disableGroups: ['停用角']});

  assert.deepEqual(fallback.disabledImpact, withHook.disabledImpact);
  const impact = withHook.disabledImpact;
  assert.deepEqual(impact.directIds, [
    'none_all双真阻塞',
    'none_any含真与未知阻塞',
    '串起点甲',
    '分支全依赖停用角',
    '半断起点被阻',
    '双层none依赖停用角阻塞',
  ].sort());
  assert.deepEqual(impact.cascadeIds, [
    '串中段',
    '串起点乙',
    '依赖断串已结束',
    '依赖断串进行中',
    '全分支级联阻塞',
  ].sort());
  for (const alive of [
    '有兜底分支存活',
    '单层none排除停用角存活',
    'none_all含未知与停用角存活',
    'any_none与正常角存活',
    '依赖断串未开始存活',
    '排斥断串进行中存活',
    '依赖半断串存活',
  ]) {
    assert.ok(!impact.directIds.includes(alive), `${alive} 不应直接阻塞`);
    assert.ok(!impact.cascadeIds.includes(alive), `${alive} 不应级联阻塞`);
  }
});

test('YG-SKILL-AUDIT-01-9：mount-card.mjs eventTreeHealth 升级指标（复合名精准排除/多域隐性拼盘/核心参与者健康）', () => {
  const decl = makeSyntheticDecl({worldType: '世界'});
  const catalog = {
    groups: ['甲', '乙', '丙', '丁', '戊'].map(id => ({id, 内容: {显示名: id, 档案: []}, 档案: []})),
    entries: {},
    chains: [],
    worldlines: [],
    openingPlans: [],
    openingOptions: null,
    events: [
      {
        id: '并州起兵',
        内容: {
          主类型: '世界',
          确认策略: '自动确认',
          核心参与者: ['甲'],
          事件结果: ['纪事存照'],
          分支: [{
            分支ID: '默认',
            变化: [
              {路径: '世界.剧情标记.战事', 操作: '设定', 值: '已起'},
              {路径: '角色.甲.职位.并州军', 操作: '设定', 值: '都尉'},
              {路径: '角色.甲.装备.铁矛', 操作: '新增', 值: {状态: '完好', 位置: '随身'}},
            ],
          }],
        },
      },
      {
        id: '祸及乡里',
        内容: {
          主类型: '世界',
          确认策略: '自动确认',
          核心参与者: [],
          事件结果: ['纪事存照'],
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '出征兼巡边',
        内容: {
          主类型: '势力',
          确认策略: '条件确认',
          核心参与者: ['甲', '乙', '丙', '丁', '戊'],
          事件结果: ['关系变化', '职位变化', '装备变动'],
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '同域多条关系不误报',
        内容: {
          主类型: '个人',
          确认策略: '条件确认',
          核心参与者: ['甲', '乙', '丙'],
          事件结果: ['关系变化'],
          分支: [{
            分支ID: '默认',
            变化: [
              {路径: '角色.甲.关系.乙', 操作: '设定', 值: '结义'},
              {路径: '角色.乙.关系.甲', 操作: '设定', 值: '结义'},
              {路径: '角色.甲.关系.丙', 操作: '设定', 值: '结义'},
              {路径: '角色.丙.关系.甲', 操作: '设定', 值: '结义'},
            ],
          }],
        },
      },
    ],
  };

  const withDecl = probeCard({catalog, decl, conditionReferences});
  const h = withDecl.eventTreeHealth;
  assert.deepEqual(h.compoundNameIds, ['出征兼巡边']);
  assert.deepEqual(h.multiCategoryBranchEvents, ['出征兼巡边', '并州起兵']);
  assert.deepEqual(h.coreParticipantHealth, {
    worldEventsWithCore: ['并州起兵'],
    crowdedCoreEvents: ['出征兼巡边'],
    maxCoreCount: 5,
  });

  // decl 缺失时安全回退
  const noDecl = probeCard({catalog});
  assert.deepEqual(noDecl.eventTreeHealth.coreParticipantHealth, {
    worldEventsWithCore: [],
    crowdedCoreEvents: ['出征兼巡边'],
    maxCoreCount: 5,
  });
});

test('YG-SKILL-AUDIT-01-10：theme-tool.mjs 重复键严格拦截（与 core/yaml 对齐）及未知顶层键告警', async t => {
  const dupCases = [
    ['顶层重复键', 'id: dup-top\nname: 甲\nname: 乙\n'],
    ['嵌套 tokens 重复键', 'id: dup-tok\nname: 令牌重复\ntokens:\n  --ygg-accent: "#111"\n  --ygg-accent: "#222"\n'],
    ['嵌套 layout 重复键', 'id: dup-lay\nname: 布局重复\nlayout:\n  每楼形态: bar\n  每楼形态: card\n'],
    ['行内映射重复键', 'id: dup-flow\nname: 行内重复\nlayout: { 每楼形态: bar, 每楼形态: card }\n'],
  ];
  for (const [label, yamlText] of dupCases) {
    assert.throws(() => parseYaml(yamlText), /.+/, `core/yaml 应拒绝 ${label}`);
    assert.throws(() => parseThemeYaml(yamlText), /重复键/u, `parseThemeYaml 应拒绝 ${label}`);
  }

  const allLegalAliases = [
    {id: 'alias-en', name: 'EN', description: 'd', default: true, base: 'modern', tokens: {'--ygg-accent': '#123'}, layout: {每楼形态: 'bar'}, cssFile: 'a.css', css: ''},
    {ID: 'alias-zh', 名称: '中文', 说明: '说', 默认: false, 基座: 'classic', 令牌: {'--ygg-accent': '#123'}, 布局: {正文美化: true}, 样式文件: 'a.css', 样式: ''},
    {id: 'alias-alt', 名称: '别名', 简介: '简', 继承: 'cyber'},
  ];
  for (const raw of allLegalAliases) {
    const validated = validateThemeEntry(raw);
    assert.deepEqual(validated.warnings, [], `合法键组合不应误报告警：${validated.id}`);
  }

  const withTypo = validateThemeEntry({
    id: 'typo-demo',
    name: '拼写演示',
    token: {'--ygg-accent': '#abc'},
    unknownTop: 'x',
  });
  assert.equal(withTypo.id, 'typo-demo');
  assert.equal(withTypo.warnings.length, 2);
  assert.match(withTypo.warnings[0], /token/u);
  assert.match(withTypo.warnings[1], /unknownTop/u);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-theme-audit-'));
  t.after(() => fs.rm(tmpRoot, {recursive: true, force: true}));

  const warnProj = path.join(tmpRoot, 'warn-proj');
  await fs.mkdir(path.join(warnProj, '外观'), {recursive: true});
  await fs.writeFile(path.join(warnProj, '外观', '主题.yaml'), 'id: warn-one\nname: 告警测试\ntoken:\n  --ygg-accent: "#fff"\n');
  const warnRes = await validateThemesDir(warnProj);
  assert.equal(warnRes.ok, true);
  assert.equal(warnRes.errors.length, 0);
  assert.equal(warnRes.warnings.length, 1);
  assert.match(warnRes.warnings[0], /token/u);

  let out = '';
  let err = '';
  const cliCode = await runThemeCli(['validate', warnProj, '--json'], {
    stdout: {write: s => { out += String(s); }},
    stderr: {write: s => { err += String(s); }},
  });
  assert.equal(cliCode, 0, err);
  const cliJson = JSON.parse(out);
  assert.equal(cliJson.ok, true);
  assert.equal(cliJson.warnings.length, 1);
  assert.match(cliJson.warnings[0], /token/u);

  const dupProj = path.join(tmpRoot, 'dup-proj');
  await fs.mkdir(path.join(dupProj, '外观'), {recursive: true});
  await fs.writeFile(path.join(dupProj, '外观', '主题.yaml'), 'id: dup-dir\nname: 重复\nbase: modern\nbase: classic\n');
  const dupRes = await validateThemesDir(dupProj);
  assert.equal(dupRes.ok, false);
  assert.match(dupRes.errors[0], /重复键/u);

  // 脱离仓库复制到 /tmp 独立执行双脚本验证零依赖
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-scripts-isolated-'));
  t.after(() => fs.rm(isolatedRoot, {recursive: true, force: true}));
  const isoThemeScript = path.join(isolatedRoot, 'theme-tool.mjs');
  const isoMountScript = path.join(isolatedRoot, 'mount-card.mjs');
  await fs.copyFile(path.join(project, 'skills/ygg-theme/scripts/theme-tool.mjs'), isoThemeScript);
  await fs.copyFile(path.join(project, 'skills/ygg-playtest/scripts/mount-card.mjs'), isoMountScript);

  const isoThemeOk = await spawnNode(isoThemeScript, ['validate', warnProj, '--json'], isolatedRoot);
  assert.equal(isoThemeOk.code, 0, isoThemeOk.stderr);
  assert.equal(JSON.parse(isoThemeOk.stdout).warnings.length, 1);

  const isoThemeDup = await spawnNode(isoThemeScript, ['validate', dupProj], isolatedRoot);
  assert.equal(isoThemeDup.code, 1);
  assert.match(isoThemeDup.stderr, /重复键/u);

  const isoMountHelp = await spawnNode(isoMountScript, ['--help'], isolatedRoot);
  assert.equal(isoMountHelp.code, 0, isoMountHelp.stderr);
  assert.match(isoMountHelp.stdout, /用法：node mount-card\.mjs/u);

  // 校验 examples/三国演义 保持零错误零告警
  const sanguoThemeRes = await validateThemesDir(path.join(project, 'examples/三国演义'));
  assert.equal(sanguoThemeRes.ok, true);
  assert.deepEqual(sanguoThemeRes.errors, []);
  assert.deepEqual(sanguoThemeRes.warnings, []);
});
