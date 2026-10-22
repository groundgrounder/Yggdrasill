import {readDeclarations, validateDeclarations, loadWorldbook, parseYaml, stringifyYaml, checkField} from '../core/index.mjs';
import {checkWorldbook} from '../checker/index.mjs';
import {checkLayout} from '../checker/rules/layout.mjs';
import {checkEntries} from '../checker/rules/entries.mjs';
import {checkGroups} from '../checker/rules/groups.mjs';
import {checkProfiles} from '../checker/rules/profiles.mjs';
import {checkText} from '../checker/rules/text.mjs';
import {createCalendar} from '../core/calendar.mjs';
import {runCli} from '../cli/ygg.mjs';
import {test, assert, fs, path, example, fixture, edit, write, remove, read, invalidCase,
  shortSkill, naturalSkill, ship, basic, impression, oldGroup, apprenticeGroup, captainGroup} from './helpers.mjs';

invalidCase('补充：技能库依赖能力声明', '设定.缺少文件', root => remove(root, '设定/能力.yaml'));
invalidCase('补充：等级引用依赖等级文件', '设定.缺少文件', root => remove(root, '设定/等级.yaml'));
invalidCase('补充：角色组依赖角色分类文件', '设定.缺少文件', root => remove(root, '设定/角色分类.yaml'));
invalidCase('补充：技能可用适用条件引用未知字段', '设定.技能可用', root => edit(root, '设定/能力.yaml', value => { value.技能可用[0].适用 = {来历: '习得'}; }));
invalidCase('补充：两条技能可用规则同时匹配', '技能.可用规则', root => edit(root, '设定/能力.yaml', value => { value.技能可用.push(structuredClone(value.技能可用[0])); }));
invalidCase('补充：前置档案不在同一版本', '档案项.前置档案', root => edit(root, apprenticeGroup, value => { value.档案.find(item => item.档案ID === '林澜·学徒期').前置档案 = '林汐·学徒期'; }));
invalidCase('补充：默认档案不能有生效条件', '档案项.默认', root => edit(root, oldGroup, value => { value.档案.find(item => item.档案ID === '秦守·守塔期').生效条件 = {事件确认: {事件ID: '出师考核'}}; }));
invalidCase('补充：共享版本不能有两个默认档案', '档案项.默认', root => edit(root, captainGroup, value => { value.档案[1].默认 = true; delete value.档案[1].生效条件; }));
invalidCase('补充：初始能力集合成员不合声明', '档案项.初始能力', root => edit(root, oldGroup, value => { value.档案.find(item => item.档案ID === '秦守·守塔期').初始能力.天赋 = ['灯语·短讯']; }));
invalidCase('补充：初始装备不能重复', '档案项.初始装备', root => edit(root, oldGroup, value => { value.档案.find(item => item.档案ID === '秦守·守塔期').初始装备.push(structuredClone(value.档案.find(item => item.档案ID === '秦守·守塔期').初始装备[0])); }));
invalidCase('补充：短语不能带句末标点', '档案.形态', root => edit(root, impression, value => { value.核心身份 = ['灯塔学徒。']; }));
invalidCase('补充：能力特征两个数组必填', '档案.缺必填', root => edit(root, basic, value => { delete value.能力特征.技能补充; }));
invalidCase('补充：技能补充至少一个个人字段', '档案.技能补充', root => edit(root, basic, value => { value.能力特征.技能补充 = [{技能ID: '雾中视·辨影'}]; }));
invalidCase('补充：列表不能以空列表冒充已填写', '档案.形态', root => edit(root, basic, value => { value.穿着习惯 = []; }));
invalidCase('补充：映射内部键按引用报错', '条目.引用', root => edit(root, ship, value => { value.航线 = {南湾: '等潮后进港。'}; }));
invalidCase('补充：映射内部值按形态报错', '条目.形态', root => edit(root, ship, value => { value.航线 = {北湾: ['等潮后进港。']}; }));
invalidCase('补充：模型可见文件不能用yaml', '目录.扩展名不符', root => fs.rename(path.join(root, shortSkill), path.join(root, '技能/灯语/灯语·短讯.yaml')));
invalidCase('补充：标记ID不能用保留字', '命名.保留字', root => edit(root, '设定/剧情标记.yaml', value => { Object.defineProperty(value, 'constructor', {value: ['未至', '已至'], enumerable: true}); }));
invalidCase('补充：能力键不能带点号', '命名.非法字符', root => edit(root, '设定/能力.yaml', value => { value.维度.技艺.键.常规.push('绳.结'); }));
invalidCase('补充：实例目录不能缺同名实例', '条目.上级类型', root => remove(root, '地点/北湾/雾港/上城/上城.txt'));
invalidCase('补充：未使用的分类空目录也检查', '条目.分级', root => fs.mkdir(path.join(root, '装备/未声明种类')));
invalidCase('补充：档案追加字段不能必填', '设定.文本规范', root => edit(root, '设定/文本规范.yaml', value => { value.档案追加字段.基本信息.惯用手.必填 = true; }));
invalidCase('补充：增减上限必须正整数', '设定.本局变量', root => edit(root, '设定/本局变量.yaml', value => { value.单次增减上限 = 0; }));
invalidCase('补充：同名说明递归空字符串仍为空壳', '目录.空壳说明', root => write(root, '装备/装备.txt', {说明: ['', '  ']}), '提示');

test('补充：隐藏文件跳过，历史事件检查，机器字段不扫描', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.隐藏'));
  await fs.writeFile(path.join(root, '.隐藏/甲.txt'), '键: [坏语法');
  await edit(root, '历史/事件/学修船/事件.txt', value => { value.公开信息 = ['潮雾覆盖工具间。']; value.叙事条件 = '只在工具间处理旧船板。'; });
  await write(root, '世界概况/海况与雾季.txt', {海况: '海风来自北湾。', 生效条件: {说明: '变量与条目。'}});
  const result = await checkWorldbook(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});

test('补充：内核目录读取全部走注入接口', async () => {
  let reads = 0, walks = 0, joins = 0;
  const injectedFs = {
    readFile: (...args) => { reads++; return fs.readFile(...args); },
    readdir: (...args) => { walks++; return fs.readdir(...args); },
  };
  const injectedPath = {...path, join: (...args) => { joins++; return path.join(...args); }};
  const {raw} = await readDeclarations(example, {fs: injectedFs, path: injectedPath});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(example, {fs: injectedFs, path: injectedPath, decl});
  assert.ok(reads >= 58 && walks > 1 && joins > 1);
  assert.equal(catalog.groups.length, 4);
});

test('补充：声明1662种局部畸形替换均不崩溃', async () => {
  const {raw} = await readDeclarations(example, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(example, {fs, path, decl});
  function paths(value, prefix = []) {
    return value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, item]) => [[...prefix, key], ...paths(item, [...prefix, key])]) : [];
  }
  let mutations = 0;
  for (const keys of paths(raw)) for (const replacement of [null, false, 0, '', [], {}]) {
    const next = structuredClone(raw);
    let target = next;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = replacement;
    assert.doesNotThrow(() => {
      const {decl: current} = validateDeclarations(next);
      for (const checker of [checkLayout, checkEntries, checkGroups, checkProfiles, checkText]) checker(catalog, current);
      structuredClone(current);
    }, keys.join('.'));
    mutations++;
  }
  assert.equal(mutations, 1662);
});

test('补充：YAML唯一键、循环别名和纯数据往返', () => {
  assert.throws(() => parseYaml('甲: 一\n甲: 二\n'));
  assert.throws(() => parseYaml('甲: &甲 {乙: *甲}\n'));
  const value = {甲: ['一', '二'], 乙: {丙: true}};
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
  assert.deepEqual(structuredClone(parseYaml('甲: &甲 [一, 二]\n乙: *甲\n')), {甲: ['一', '二'], 乙: ['一', '二']});
});

test('补充：纪年不接受结尾换行', () => {
  const calendar = createCalendar({前缀: '潮历', 年位数: 3, 月数: 4, 每月天数: [91, 91, 91, 92]});
  assert.equal(calendar.time('潮历012年\n'), null);
  assert.equal(calendar.time('潮历012年04月92日\n'), null);
});

test('补充：字段子映射结构错误与内部值规则分别保留', () => {
  const schema = {子字段: {概况: {必填: true, 形态: '文本'}}};
  assert.ok(checkField({额外: '甲'}, schema).some(item => item.规则 === '条目.子字段或映射'));
  assert.ok(checkField({概况: []}, schema).some(item => item.规则 === '条目.形态'));
});

test('补充：命令用法错误返回一', async () => {
  let message = '';
  assert.equal(await runCli(['未知'], {stderr: {write: value => { message += value; }}}), 1);
  assert.match(message, /用法/);
});
