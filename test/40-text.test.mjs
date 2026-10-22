import {test, assert, fs, path, project, templates, loadRouting, protocolText, writableFields, locationList, formatCalendar,
  errorCode} from './router-helpers.mjs';
const {catalog, decl} = await loadRouting();
const expectedFields = `世界.剧情标记.灯塔状态：设定；运转 / 熄灭 / 重燃
世界.剧情标记.雾季：设定；未至 / 已至 / 已过
世界.天气：设定；晴 / 雾 / 风暴
角色.<角色组ID>.关系.<角色组ID>：设定、新增、移除；陌生 / 相识 / 友好 / 信任 / 师徒 / 疏远
角色.<角色组ID>.好感度.<角色组ID>：增加、减少；-100 至 100 的整数
角色.<角色组ID>.身份：新增、移除；文本
角色.<角色组ID>.职位.<势力ID>：设定、新增、移除；文本
角色.<角色组ID>.知识：新增、移除；文本
角色.<角色组ID>.身体状态.健康：设定；未初始化 / 正常 / 受伤 / 重伤
角色.<角色组ID>.技艺.<键>：提升、设定、移除；学徒 / 熟手 / 匠人 / 名匠；键为 灯语 / 航海 / 修船 / 雾中视
角色.<角色组ID>.名望：提升、设定、移除；学徒 / 熟手 / 匠人 / 名匠
角色.<角色组ID>.天赋：新增、移除；<技能ID>（来源为 天生）
角色.<角色组ID>.习惯：新增、移除；文本
角色.<角色组ID>.装备.<装备ID>：新增、设定、移除；值为 {状态: 完好 / 破损 / 报废, 位置: 文本}`;
const expectedPlaces = `北湾（海域）
  雾港（港镇）
    上城（街区）
      商会馆（地标）
    灯塔（地标）
    码头区（街区）`;
const expectedCalendar = '潮历YYY年或潮历YYY年MM月DD日（年份 3 位，每年 4 个月，各月 91、91、91、92 天）';
test('文本-1：可写字段按声明顺序逐行展开', () => assert.equal(writableFields(decl), expectedFields));
test('文本-2：地点列表按上下级与码点排序', () => assert.equal(locationList(catalog), expectedPlaces));
test('文本-3：雾港不等长月份纪年格式', () => assert.equal(formatCalendar(decl.calendar), expectedCalendar));
test('文本-4：等长月份纪年格式', () => assert.equal(formatCalendar({前缀: '甲龙历', 年位数: 4, 月数: 12, 每月天数: 30}),
  '甲龙历YYYY年或甲龙历YYYY年MM月DD日（年份 4 位，每年 12 个月，每月 30 天）'));
test('文本-5：三份模板精确填充并以空行拼接', async () => {
  const card = catalog.texts.find(item => item.文件 === '扮演准则/海港白描.txt').原文.replace(/[\r\n]+$/u, '');
  const replacements = {'纪年格式': expectedCalendar, '可写字段': expectedFields, '地点列表': expectedPlaces, '单次增减上限': 100, '本卡扮演准则': card};
  const expected = ['变量更新规则', '角色通用约束', '扮演准则'].map(name => templates[name].replace(/[\r\n]+$/u, '')
    .replace(/\{\{([^{}]+)\}\}/gu, (match, key) => replacements[key])).join('\n\n');
  const actual = protocolText({catalog, decl, templates});
  assert.equal(actual, expected); assert.ok(!actual.includes('{{')); assert.ok(actual.includes('一次不超过 100'));
  assert.equal(actual.split('## 本卡\n\n')[1], card);
  assert.equal(templates.变量更新规则, await fs.readFile(path.join(project, 'templates/变量更新规则.txt'), 'utf8'));
});
test('文本-6：未知占位符报错', () => assert.throws(() => protocolText({catalog, decl,
  templates: {...templates, 角色通用约束: '{{未知}}'}}), errorCode('模板.占位符')));
test('文本-7：没有本卡扮演准则时填无', () => {
  const result = protocolText({catalog: {...catalog, texts: []}, decl, templates});
  assert.ok(result.endsWith('## 本卡\n\n无'));
});
test('文本-边界：原文只剥末尾换行，替换文本不再当作模板处理', () => {
  const changed = {...catalog, texts: [{文件: '扮演准则/𠀀.txt', 原文: '后\r\n\r\n'},
    {文件: '扮演准则/甲.txt', 原文: '前 $& {{保留原文}}  \n'}]};
  const result = protocolText({catalog: changed, decl, templates});
  assert.ok(result.endsWith('前 $& {{保留原文}}  \n\n后'));
  assert.equal(locationList({entries: {}}), '无');
  assert.equal(formatCalendar({...decl.calendar, 每月天数: [90, 90, 90, 90]}).split('，').at(-1), '每月 90 天）');
});
test('文本-边界：子字段、引用、任意映射键与集合成员条件', () => {
  const changed = structuredClone(decl);
  changed.variables.角色.索引 = {映射: {键: {形态: '文本'}, 值: {引用: '势力'}}};
  changed.variables.角色.佩饰 = {子字段: {刻字: {形态: '文本'}}};
  const fields = writableFields(changed);
  assert.ok(fields.includes('角色.<角色组ID>.索引.<键>：设定、新增、移除；<势力ID>'));
  assert.ok(fields.includes('角色.<角色组ID>.佩饰.刻字：设定；文本'));
});
