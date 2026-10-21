import {invalidCase, fs, path, edit, write, remove, rename, read, shortSkill, equipment, port} from './helpers.mjs';

invalidCase('目录-1：删除设定固定根', '目录.缺少固定根', root => remove(root, '设定'));
invalidCase('目录-2：根下未声明杂项目录', '目录.未声明目录', root => write(root, '杂项/甲.txt', {说明: '海风吹过栈桥。'}));
invalidCase('目录-3：角色组下未知备注', '目录.未知文件', root => write(root, '角色/秦守/备注.txt', {说明: '海风吹过栈桥。'}));
invalidCase('目录-4：声明误用文本扩展名', '目录.扩展名不符', root => rename(root, '设定/纪年.yaml', '设定/纪年.txt'));
invalidCase('目录-5：源文件写包裹标签', '目录.包裹标签', async root => {
  const file = path.join(root, shortSkill);
  await fs.writeFile(file, `<技能>\n${await fs.readFile(file, 'utf8')}</技能>\n`);
});
invalidCase('目录-6：装备重复键', '目录.YAML错误', root => fs.appendFile(path.join(root, equipment), '简介: 第二种说法。\n'));
invalidCase('目录-7：分类说明为空壳', '目录.空壳说明', root => fs.writeFile(path.join(root, '技能/灯语/灯语.txt'), ''), '提示');
invalidCase('命名-1：装备ID带点号', '命名.非法字符', root => write(root, '装备/工具/工具·铜.扳手.txt', {装备ID: '工具·铜.扳手', 标签: '工具'}));
invalidCase('命名-2：玩家角色组保留字', '命名.保留字', root => fs.mkdir(path.join(root, '角色/玩家')));
invalidCase('命名-3：技能ID与文件名不一致', '命名.文件名不符', root => edit(root, shortSkill, value => { value.技能ID = '灯语·快讯'; }));
invalidCase('命名-4：编码样式与本卡中文限制', ['命名.编码样式', '命名.本卡规则'], root => write(root, '势力/官署/hall_01.txt', {势力ID: 'hall_01', 类型: '官署'}));
invalidCase('命名-5：地标ID超过十二字', '命名.过长', root => {
  const id = '雾港北湾东岬旧石阶外侧观潮台';
  return write(root, `地点/北湾/雾港/${id}.txt`, {地点ID: id, 类型: '地标', 概况: '东岬外侧的石砌观潮台。'});
}, '提示');
invalidCase('命名-6：技能ID前缀字段不符', '命名.本卡规则', async root => {
  const value = await read(root, shortSkill);
  value.技能ID = '信号·短讯';
  await write(root, '技能/灯语/信号·短讯.txt', value);
});
invalidCase('命名补充：势力ID超过十二字', '命名.过长', root => {
  const id = '雾港北湾联合航运商业公会海商';
  return write(root, `势力/商会/${id}.txt`, {势力ID: id, 类型: '商会'});
}, '提示');
