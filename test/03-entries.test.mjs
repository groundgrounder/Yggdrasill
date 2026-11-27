import {invalidCase, test, fixture, assertFindings, edit, write, read, remove, rename, shortSkill, naturalSkill, equipment, ship, district, lighthouse, finding, hint} from './helpers.mjs';
import {checkWorldbook} from '../checker/index.mjs';

invalidCase('条目-1：技能未声明字段', [
  hint('抽样.未执行', '历史'),
  finding('条目.未声明字段', '技能/灯语/灯语·短讯.txt'),
], root => edit(root, shortSkill, value => { value.备注 = '短讯。'; }));
invalidCase('条目-2：技能缺效果', [
  hint('抽样.未执行', '历史'),
  finding('条目.缺必填', '技能/灯语/灯语·短讯.txt'),
], root => edit(root, shortSkill, value => { delete value.效果; }));
invalidCase('条目-3：装备效果不是文本列表', [
  hint('抽样.未执行', '历史'),
  finding('条目.形态', '装备/工具/工具·铜扳手.txt'),
], root => edit(root, equipment, value => { value.效果 = '拧紧螺帽。'; }));
invalidCase('条目-4：技能等级超出值域', [
  finding('技能.门槛取值', '技能/灯语/灯语·短讯.txt'),
  hint('抽样.未执行', '历史'),
  finding('条目.取值', '技能/灯语/灯语·短讯.txt'),
], root => edit(root, shortSkill, value => { value.技能等级 = '大师'; }));
invalidCase('条目-5：势力所在区域不能解析', [
  hint('抽样.未执行', '历史'),
  finding('条目.引用', '势力/官署/港务署.txt'),
], root => edit(root, '势力/官署/港务署.txt', value => { value.所在区域 = '南湾'; }));
invalidCase('条目-6：船只航线不是映射', [
  hint('抽样.未执行', '历史'),
  finding('条目.子字段或映射', '船只/货船/潮汐号.txt'),
], root => edit(root, ship, value => { value.航线 = ['北湾']; }));
invalidCase('条目-7：街区不适用主管势力', [
  hint('抽样.未执行', '历史'),
  finding('条目.适用类型', '地点/北湾/雾港/码头区/码头区.txt'),
], root => edit(root, district, value => { value.主管势力 = '港务署'; }));
invalidCase('条目-8：技能所在目录分级错误', [
  hint('抽样.未执行', '历史'),
  finding('条目.分级', '技能/灯语/航海·夜航.txt'),
], root => rename(root, '技能/航海/航海·夜航.txt', '技能/灯语/航海·夜航.txt'));
invalidCase('条目-9：地点上级类型搭配错误', [
  hint('抽样.未执行', '历史'),
  finding('条目.上级类型', '地点/北湾/雾港/灯塔/灯塔.txt'),
], root => edit(root, lighthouse, value => { value.类型 = '港镇'; }));
invalidCase('条目-10：同库重复ID', [
  hint('抽样.未执行', '历史'),
  finding('条目.分级', '技能/航海/灯语·短讯.txt', {说明: ['门类“灯语”与目录“航海”不一致']}),
  finding('条目.重复ID', '技能/航海/灯语·短讯.txt', {次数: 2,
    说明: ['ID“灯语·短讯”重复', '首次出现于技能/灯语/灯语·短讯.txt']}),
], async root => write(root, '技能/航海/灯语·短讯.txt', await read(root, shortSkill)));
invalidCase('技能-1：没有适用的可用规则', [
  finding('技能.可用规则', '技能/雾中视/雾中视·辨影.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '设定/能力.yaml', value => { value.技能可用.pop(); }));
invalidCase('技能-2：等级门槛键不在常规组', [
  finding('变化.取值', '历史/事件/学徒守灯/事件.txt', {次数: 2}),
  finding('技能.门槛取值', '技能/雾中视/雾中视·辨影.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, naturalSkill, value => { value.来源 = '习得'; }));
invalidCase('技能-3：技能不符合集合成员条件', [
  finding('变化.取值', '历史/事件/学徒守灯/事件.txt', {次数: 2}),
  finding('技能.集合成员', '技能/雾中视/雾中视·辨影.txt'),
  hint('抽样.未执行', '历史'),
], root => edit(root, '设定/能力.yaml', value => { value.维度.天赋.成员.条件 = {来源: '习得'}; }));

async function setupMixedSkills(root) {
  await edit(root, '设定/文本规范.yaml', value => { delete value.ID命名.技能ID; });
  await edit(root, '设定/条目库.yaml', value => {
    value.技能 = {
      分法: '按种类',
      分级: ['类型'],
      字段: {
        类型: {必填: true, 取值: ['术式', '天赋']},
        派系: {取值: ['基础'], 适用类型: ['术式']},
        门类: {取值: '能力.技艺', 适用类型: ['术式']},
        技能等级: {取值: '等级.技艺', 适用类型: ['术式']},
        效果: {必填: true, 形态: '文本'},
        边界: {形态: '文本列表'},
      },
    };
  });
  await edit(root, '设定/能力.yaml', value => {
    value.维度.天赋.成员.条件 = {类型: '天赋'};
    value.技能可用[0].适用 = {类型: '术式', 派系: '基础'};
    value.技能可用[1].适用 = {类型: '天赋'};
  });
  const learnedFiles = [
    ['技能/灯语/灯语·短讯.txt', '灯语·短讯.txt'],
    ['技能/灯语/灯语·长夜信号.txt', '灯语·长夜信号.txt'],
    ['技能/航海/航海·夜航.txt', '航海·夜航.txt'],
    ['技能/修船/修船·补帆.txt', '修船·补帆.txt'],
  ];
  for (const [oldPath, fileName] of learnedFiles) {
    const content = await read(root, oldPath);
    delete content.来源;
    content.类型 = '术式';
    content.派系 = '基础';
    await write(root, `技能/术式/${fileName}`, content);
  }
  const innate = await read(root, naturalSkill);
  delete innate.来源;
  delete innate.门类;
  delete innate.技能等级;
  innate.类型 = '天赋';
  await write(root, '技能/天赋/雾中视·辨影.txt', innate);
  for (const dir of ['技能/灯语', '技能/航海', '技能/修船', '技能/雾中视']) await remove(root, dir);
}

test('技能-4：混合技能库仅对命中等级门槛规则的技能要求键字段与等级字段', async t => {
  const root = await fixture(t);
  await setupMixedSkills(root);
  assertFindings(await checkWorldbook(root), [], '技能-4');
});

test('技能-5：命中等级门槛规则但缺少键字段与等级字段时报缺必填且不报undefined门槛错', async t => {
  const root = await fixture(t);
  await setupMixedSkills(root);
  await edit(root, '技能/术式/灯语·短讯.txt', value => {
    delete value.门类;
    delete value.技能等级;
  });
  assertFindings(await checkWorldbook(root), [
    finding('条目.缺必填', '技能/术式/灯语·短讯.txt', {
      次数: 2,
      说明: ['缺少技能可用规则所需字段“门类”', '缺少技能可用规则所需字段“技能等级”'],
    }),
    hint('抽样.未执行', '历史'),
  ], '技能-5');
});
