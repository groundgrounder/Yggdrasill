import {test, assert, fs, path, project, example} from './helpers.mjs';
import {conditionReferences} from '../core/conditions.mjs';
import {checkEvents} from '../checker/rules/events.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {probeCard} from '../skills/ygg-playtest/scripts/mount-card.mjs';

function makeSyntheticDecl() {
  return {
    calendar: {前缀: '纪元', 年位数: 3, 月数: 12, 每月天数: 30},
    classification: {
      主类型: ['世界', '势力', '个人'],
      世界事件: '世界',
      标签: ['节点'],
      事件结果: {纪事存照: []},
    },
    variables: {角色: {}, 本局: {}},
    marks: {},
  };
}

function makeSyntheticEvent(index, policy = '自动确认') {
  const id = `测试事件${String(index).padStart(2, '0')}`;
  return {
    id,
    文件: `历史/事件/${id}/事件.txt`,
    原文: 'stub',
    内容: {
      事件ID: id,
      事件概要: `第 ${index} 件测试事件。`,
      主类型: '个人',
      标签: ['节点'],
      事件结果: ['纪事存照'],
      触发时间: {最早: '纪元001年', 最晚: '纪元002年'},
      确认策略: policy,
      核心参与者: [],
      默认分支: '默认',
      分支: [{分支ID: '默认', 分支条件: '按时发生', 分支结果: '事件完成', 变化: []}],
    },
  };
}

function makeSyntheticCatalog(policies) {
  return {
    groups: [],
    entries: {},
    chains: [],
    worldlines: [],
    openingPlans: [],
    openingOptions: null,
    events: policies.map((policy, idx) => makeSyntheticEvent(idx + 1, policy)),
  };
}

test('YG-TREE-01-A2：规范正本、检查规则表与作者 Skill 完整覆盖五条红线及探针说明', async () => {
  const redlineFiles = [
    'docs/写作规范.md',
    'skills/ygg-read/SKILL.md',
    'skills/ygg-skeleton/SKILL.md',
    'skills/ygg-skeleton/references/骨架字段与检查.md',
    'skills/shared/写作红线.md',
  ];
  for (const rel of redlineFiles) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    assert.match(text, /拼盘/u, `${rel} 应包含拼盘禁令`);
    assert.match(text, /前史/u, `${rel} 应包含前史归档案原则`);
    assert.match(text, /三问/u, `${rel} 应包含三问准入门槛`);
    assert.match(text, /触发时间/u, `${rel} 应包含真因果与触发时间区分`);
    assert.match(text, /自动确认/u, `${rel} 应包含自动确认口径`);
    assert.match(text, /条件确认/u, `${rel} 应包含条件确认口径`);
    assert.match(text, /仅作候选/u, `${rel} 应包含仅作候选口径`);
    assert.match(text, /主类型/u, `${rel} 应包含主类型归类口径`);
    assert.match(text, /01月01日/u, `${rel} 应包含禁编造 01月01日 口径`);
  }

  for (const rel of [
    'skills/ygg-playtest/SKILL.md',
    'skills/ygg-playtest/references/五维验收矩阵与判定口径.md',
  ]) {
    const text = await fs.readFile(path.join(project, rel), 'utf8');
    assert.match(text, /eventTreeHealth/u, `${rel} 应说明 eventTreeHealth`);
    assert.match(text, /confirmStrategyCounts/u, `${rel} 应说明 confirmStrategyCounts`);
    assert.match(text, /compoundNameIds/u, `${rel} 应说明 compoundNameIds`);
    assert.match(text, /zeroChangeLeafEvents/u, `${rel} 应说明 zeroChangeLeafEvents`);
  }

  const rulesDoc = await fs.readFile(path.join(project, 'docs/参考/检查规则.md'), 'utf8');
  assert.match(
    rulesDoc,
    /\| `事件\.世界依赖个人` \| 提示 \|[^\n]+\n\| `事件\.自动确认偏高` \| 提示 \|/u,
    'docs/参考/检查规则.md 应在 事件.世界依赖个人 后登记 事件.自动确认偏高（级别：提示）',
  );
});

test('YG-TREE-01-A3：probeCard eventTreeHealth 在标准路径与无 conditionReferences 回退路径均精准统计', () => {
  const catalog = {
    groups: [
      {
        id: '角色甲',
        内容: {
          显示名: '角色甲',
          档案: [
            {档案ID: '默认期', 默认: true},
            {档案ID: '切期一', 默认: false, 生效条件: {事件确认: {事件ID: '档案支撑事件'}}},
            {档案ID: '排斥期', 默认: false, 生效条件: {none: [{事件确认: {事件ID: '仅被档案排斥'}}]}},
          ],
        },
        档案: [],
      },
    ],
    entries: {},
    chains: [
      {
        id: '主线串',
        内容: {
          概述: '测试事件串',
          事件: ['串结局事件'],
          结局: [{事件ID: '串结局事件', 分支ID: '达成'}],
        },
      },
    ],
    worldlines: [],
    openingPlans: [],
    openingOptions: {
      内容: {
        选项: [
          {事件ID: '开局选项事件', 选项: {达成: '达成', 未发生: '未发生'}},
        ],
      },
    },
    events: [
      {
        id: '晋升与成婚',
        内容: {
          确认策略: '自动确认',
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '标题含及事件',
        内容: {
          事件标题: '学艺及宴会',
          确认策略: '自动确认',
          分支: [{分支ID: '默认', 变化: [{路径: '本局.标记', 操作: '设为', 值: '是'}]}],
        },
      },
      {
        id: '标题含暨事件',
        内容: {
          事件标题: '授勋暨巡游',
          确认策略: '条件确认',
          门槛: {all: [{事件确认: {事件ID: '被下游门槛引用'}}]},
          分支: [
            {
              分支ID: '默认',
              门槛: {
                all: [
                  {none: [{none: [{事件确认: {事件ID: '双否定正向引用'}}]}]},
                  {none: [{事件确认: {事件ID: '仅被奇层排斥引用'}}]},
                ],
              },
              变化: [],
            },
          ],
        },
      },
      {
        id: '被下游门槛引用',
        内容: {确认策略: '自动确认', 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '双否定正向引用',
        内容: {确认策略: '条件确认', 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '仅被奇层排斥引用',
        内容: {确认策略: '仅作候选', 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '自引用孤立事件',
        内容: {
          确认策略: '仅作候选',
          门槛: {事件确认: {事件ID: '自引用孤立事件'}},
          分支: [{分支ID: '默认', 变化: []}],
        },
      },
      {
        id: '档案支撑事件',
        内容: {确认策略: '自动确认', 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '仅被档案排斥',
        内容: {确认策略: '自动确认', 分支: [{分支ID: '默认', 变化: []}]},
      },
      {
        id: '串结局事件',
        内容: {确认策略: '自动确认', 分支: [{分支ID: '达成', 变化: []}]},
      },
      {
        id: '开局选项事件',
        内容: {确认策略: '自动确认', 分支: [{分支ID: '达成', 变化: []}]},
      },
    ],
  };

  const withHelper = probeCard({catalog, conditionReferences});
  const withoutHelper = probeCard({catalog});

  assert.deepEqual(withoutHelper.eventTreeHealth, withHelper.eventTreeHealth);
  const h = withHelper.eventTreeHealth;
  assert.deepEqual(h.confirmStrategyCounts, {自动确认: 7, 条件确认: 2, 仅作候选: 2});
  assert.equal(h.autoConfirmRatio, Number((7 / 11).toFixed(4)));
  assert.deepEqual(h.compoundNameIds, ['晋升与成婚', '标题含及事件', '标题含暨事件']);
  assert.deepEqual(h.zeroChangeLeafEvents, {
    count: 5,
    ids: ['仅被奇层排斥引用', '仅被档案排斥', '晋升与成婚', '标题含暨事件', '自引用孤立事件'],
  });

  // 空事件集合边界
  const emptyProbe = probeCard({
    catalog: {groups: [], events: [], chains: [], worldlines: [], openingPlans: [], entries: {}},
  });
  assert.deepEqual(emptyProbe.eventTreeHealth, {
    confirmStrategyCounts: {自动确认: 0, 条件确认: 0, 仅作候选: 0},
    autoConfirmRatio: 0,
    compoundNameIds: [],
    zeroChangeLeafEvents: {count: 0, ids: []},
  });
});

test('YG-TREE-01-A4：事件.自动确认偏高 轻提示规则与边界条件全覆盖', async () => {
  const decl = makeSyntheticDecl();

  // 1. 50 事件全自动确认 -> 精准报 1 条提示，0 错误
  const allAuto50 = checkEvents(makeSyntheticCatalog(Array(50).fill('自动确认')), decl);
  assert.equal(allAuto50.filter(i => i.级别 === '错误').length, 0);
  const allAutoHints = allAuto50.filter(i => i.规则 === '事件.自动确认偏高');
  assert.equal(allAutoHints.length, 1);
  assert.equal(allAutoHints[0].级别, '提示');
  assert.equal(allAutoHints[0].文件, '历史/事件');
  assert.match(allAutoHints[0].说明, /50/u);
  assert.match(allAutoHints[0].说明, /100\.0%/u);
  assert.match(allAutoHints[0].说明, /条件确认/u);

  // 2. 50 事件：45 自动 + 5 仅作候选 + 0 条件（占比 90.0%） -> 精准报 1 条提示，0 错误
  const border90 = checkEvents(
    makeSyntheticCatalog([...Array(45).fill('自动确认'), ...Array(5).fill('仅作候选')]),
    decl,
  );
  assert.equal(border90.filter(i => i.级别 === '错误').length, 0);
  const border90Hints = border90.filter(i => i.规则 === '事件.自动确认偏高');
  assert.equal(border90Hints.length, 1);
  assert.equal(border90Hints[0].级别, '提示');
  assert.match(border90Hints[0].说明, /90\.0%/u);

  // 3. 49 事件全自动确认 -> 不触发
  const under50 = checkEvents(makeSyntheticCatalog(Array(49).fill('自动确认')), decl);
  assert.equal(under50.length, 0);

  // 4. 50 事件：49 自动 + 1 条件确认 -> 不触发
  const withConditional = checkEvents(
    makeSyntheticCatalog([...Array(49).fill('自动确认'), '条件确认']),
    decl,
  );
  assert.equal(withConditional.length, 0);

  // 5. 50 事件：44 自动 + 6 仅作候选 + 0 条件（占比 88.0%） -> 不触发
  const under90 = checkEvents(
    makeSyntheticCatalog([...Array(44).fill('自动确认'), ...Array(6).fill('仅作候选')]),
    decl,
  );
  assert.equal(under90.length, 0);

  // 6. test/fixtures/雾港 保持 0 错误 0 提示
  const wugangCheck = await checkWorldbook(example);
  assert.equal(wugangCheck.errors.length, 0);
  assert.equal(wugangCheck.hints.length, 0);
});
