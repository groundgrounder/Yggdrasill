import {invalidCase, edit, remove, basic, impression} from './helpers.mjs';

invalidCase('档案-1：缺角色印象文件', '档案.缺文件', root => remove(root, '角色/周岚/档案/周岚·港务期/角色印象.txt'));
invalidCase('档案-2：未知年龄字段', '档案.未知字段', root => edit(root, basic, value => { value.年龄 = 14; }));
invalidCase('档案-3：缺必填种族', '档案.缺必填', root => edit(root, basic, value => { delete value.种族; }));
invalidCase('档案-4甲：禁区必须以不开头', '档案.形态', root => edit(root, impression, value => { value.表现禁区 = ['擅自补出消息。']; }));
invalidCase('档案-4乙：口头特征超过八字', '档案.形态', root => edit(root, impression, value => { value.表达规律.口头特征 = ['一二三四五六七八九']; }));
invalidCase('档案-4丙：稳定体貌未知子键', '档案.形态', root => edit(root, basic, value => { value.稳定体貌.光芒 = '青色。'; }));
invalidCase('档案-5：出生年未按位数补齐', '档案.出生年', root => edit(root, basic, value => { value.出生年 = '潮历12年'; }));
invalidCase('档案-6：技能补充引用不存在', '档案.技能补充', root => edit(root, basic, value => { value.能力特征.技能补充[0].技能ID = '灯语·不存在'; }));
invalidCase('档案-7：核心身份超建议条数只提示', '档案.建议条数', root => edit(root, impression, value => { value.核心身份 = ['灯塔学徒', '细心观察者', '夜灯辨读者', '沉默的港人']; }), '提示');

invalidCase('档案-8：核心身份不写十四岁', '档案.年龄', root => edit(root, impression, value => { value.核心身份 = ['沉默的十四岁灯塔学徒']; }), '提示');
invalidCase('档案补充：基本信息中的数字年龄只提示', '档案.年龄', root => edit(root, basic, value => { value.出身 = '14岁以前在雾港工匠家庭长大。'; }), '提示');
invalidCase('档案补充：情境键中的汉字数字年龄只提示', '档案.年龄', root => edit(root, impression, value => { value.通用反应[0] = {两岁时听见钟声: Object.values(value.通用反应[0])[0]}; }), '提示');
