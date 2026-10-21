import {invalidCase, edit, write, read, rename, shortSkill, naturalSkill, equipment, ship, district, lighthouse} from './helpers.mjs';

invalidCase('条目-1：技能未声明字段', '条目.未声明字段', root => edit(root, shortSkill, value => { value.备注 = '短讯。'; }));
invalidCase('条目-2：技能缺效果', '条目.缺必填', root => edit(root, shortSkill, value => { delete value.效果; }));
invalidCase('条目-3：装备效果不是文本列表', '条目.形态', root => edit(root, equipment, value => { value.效果 = '拧紧螺帽。'; }));
invalidCase('条目-4：技能等级超出值域', '条目.取值', root => edit(root, shortSkill, value => { value.技能等级 = '大师'; }));
invalidCase('条目-5：势力所在区域不能解析', '条目.引用', root => edit(root, '势力/官署/港务署.txt', value => { value.所在区域 = '南湾'; }));
invalidCase('条目-6：船只航线不是映射', '条目.子字段或映射', root => edit(root, ship, value => { value.航线 = ['北湾']; }));
invalidCase('条目-7：街区不适用主管势力', '条目.适用类型', root => edit(root, district, value => { value.主管势力 = '港务署'; }));
invalidCase('条目-8：技能所在目录分级错误', '条目.分级', root => rename(root, '技能/航海/航海·夜航.txt', '技能/灯语/航海·夜航.txt'));
invalidCase('条目-9：地点上级类型搭配错误', '条目.上级类型', root => edit(root, lighthouse, value => { value.类型 = '港镇'; }));
invalidCase('条目-10：同库重复ID', '条目.重复ID', async root => write(root, '技能/航海/灯语·短讯.txt', await read(root, shortSkill)));
invalidCase('技能-1：没有适用的可用规则', '技能.可用规则', root => edit(root, '设定/能力.yaml', value => { value.技能可用.pop(); }));
invalidCase('技能-2：等级门槛键不在常规组', '技能.门槛取值', root => edit(root, naturalSkill, value => { value.来源 = '习得'; }));
invalidCase('技能-3：技能不符合集合成员条件', '技能.集合成员', root => edit(root, '设定/能力.yaml', value => { value.维度.天赋.成员.条件 = {来源: '习得'}; }));
