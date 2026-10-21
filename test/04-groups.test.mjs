import {invalidCase, edit, remove, fs, path, oldGroup, youngGroup, apprenticeGroup, captainGroup} from './helpers.mjs';

invalidCase('角色组-1：缺角色组文件', '角色组.缺文件', root => remove(root, youngGroup));
invalidCase('角色组-2：角色组未知字段', '角色组.未知字段', root => edit(root, oldGroup, value => { value.年龄 = 60; }));
invalidCase('角色组-3：别名不能写字符串', '角色组.字段', root => edit(root, oldGroup, value => { value.别名 = '秦伯'; }));
invalidCase('角色组-4：分类未声明', '角色组.角色分类', root => edit(root, youngGroup, value => { value.分类 = '渔民'; }));
invalidCase('角色组-5：多版本缺默认版本', '角色组.版本', root => edit(root, apprenticeGroup, value => { delete value.默认版本; }));
invalidCase('角色组-6：组与版本别名重复', '角色组.别名重复', root => edit(root, apprenticeGroup, value => { value.别名.push('阿澜'); }));
invalidCase('角色组-7：跨组别名只提示', '角色组.跨组别名', root => edit(root, youngGroup, value => { value.别名.push('秦伯'); }), '提示');
invalidCase('角色组-8：初始所在不存在', '角色组.初始所在', root => edit(root, captainGroup, value => { value.初始所在 = '南湾'; }));
invalidCase('档案项-1：未登记档案目录', '档案项.目录不符', root => fs.mkdir(path.join(root, '角色/秦守/档案/未登记')));
invalidCase('档案项-2：适用版本未登记', '档案项.适用版本', root => edit(root, apprenticeGroup, value => { value.档案[0].适用版本.push('林海'); }));
invalidCase('档案项-3：非默认档案缺生效条件', '档案项.默认', root => edit(root, apprenticeGroup, value => { delete value.档案[2].生效条件; }));
invalidCase('档案项-4：某版本没有适用档案', '档案项.无适用档案', root => edit(root, apprenticeGroup, value => {
  for (const item of value.档案) if (item.档案ID.startsWith('林汐')) item.适用版本 = ['林澜'];
}));
invalidCase('档案项-5：前置链成环', '档案项.前置档案', root => edit(root, apprenticeGroup, value => { value.档案[0].前置档案 = '林澜·守塔期'; }));
invalidCase('档案项-6甲：初始能力维度未声明', '档案项.初始能力', root => edit(root, oldGroup, value => { value.档案[0].初始能力.力量 = '名匠'; }));
invalidCase('档案项-6乙：初始能力等级非法', '档案项.初始能力', root => edit(root, oldGroup, value => { value.档案[0].初始能力.技艺.灯语 = '宗师'; }));
invalidCase('档案项-7：初始装备状态非法', '档案项.初始装备', root => edit(root, oldGroup, value => { value.档案[0].初始装备[0].状态 = '崭新'; }));
