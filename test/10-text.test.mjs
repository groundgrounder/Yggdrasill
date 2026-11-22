import {checkWorldbook} from '../checker/index.mjs';
import {invalidCase, edit, basic, port, impression, ship, shortSkill, test, assert, fixture, finding, hint} from './helpers.mjs';

invalidCase('文本-1甲：通用禁用词条目', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '世界概况/秩序与行当.txt'),
], root => edit(root, '世界概况/秩序与行当.txt', value => { value.补充 = '每个条目写在海图背面。'; }));
invalidCase('文本-1乙：第五层禁用词原作中', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '世界概况/海况与雾季.txt'),
], root => edit(root, '世界概况/海况与雾季.txt', value => { value.补充 = '原作中海雾从北边来。'; }));
invalidCase('文本-2：同名地点说明不能写读取', [
  hint('抽样.未执行', '历史'),
  finding('文本.系统视角', '地点/北湾/雾港/雾港.txt'),
], root => edit(root, port, value => { value.概况 += '读取海图可知港口朝向。'; }));
invalidCase('文本-3：说明不用破折号', [
  hint('抽样.未执行', '历史'),
  finding('文本.破折号', '装备/装备.txt'),
], root => edit(root, '装备/装备.txt', value => { value.说明.push('船舷很低——水容易溅进来。'); }));
invalidCase('文本-4：第五层收紧基本信息预算', [
  hint('文本.长度', '角色/灯塔学徒/档案/林澜·学徒期/基本信息.txt'),
], root => edit(root, basic, value => { value.出身 = '海'.repeat(401); }));
invalidCase('文本-5：仿佛只报写法提示', [
  hint('文本.写法', '装备/装备.txt'),
], root => edit(root, '装备/装备.txt', value => { value.说明.push('灯光仿佛连成一线。'); }));

invalidCase('文本-6：通用反应的情境键含条目', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt'),
], root => edit(root, impression, value => { value.通用反应.push({看见条目: '先辨方向，再逐段记下明暗间隔。'}); }));
invalidCase('文本-7：技能库说明的键含读取', [
  hint('抽样.未执行', '历史'),
  finding('文本.系统视角', '技能/技能.txt'),
], root => edit(root, '技能/技能.txt', value => { value.读取灯号 = '港人先辨明灯光的方向。'; }));
invalidCase('文本-8：只加长情境键使全文超过六百字', [
  hint('文本.长度', '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt'),
], root => edit(root, impression, value => { value.通用反应[0] = {['灯'.repeat(601)]: Object.values(value.通用反应[0])[0]}; }));
invalidCase('文本-9：情境键不能含破折号', [
  hint('抽样.未执行', '历史'),
  finding('文本.破折号', '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt'),
], root => edit(root, impression, value => { value.通用反应[0] = {'看见灯光——远处传来钟声': Object.values(value.通用反应[0])[0]}; }));

invalidCase('文本补充：情境键与机器字段同名仍扫描正文', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '角色/灯塔学徒/档案/林澜·学徒期/角色印象.txt'),
], root => edit(root, impression, value => { value.通用反应.push({变化: '先确认条目上的灯号。'}); }));
invalidCase('文本补充：文本容器的嵌套键参与扫描', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '世界概况/海况与雾季.txt'),
], root => edit(root, '世界概况/海况与雾季.txt', value => { value.海况.push({海边条目: '落潮后能看见湾口暗礁。'}); }));
invalidCase('文本补充：说明文件的嵌套键计入长度', [
  hint('文本.长度', '技能/技能.txt'),
], root => edit(root, '技能/技能.txt', value => { value.说明.push({['灯'.repeat(301)]: '港人先辨明灯光的方向。'}); }));
invalidCase('文本补充：基本信息的追加情境字段扫描键', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '角色/灯塔学徒/档案/林澜·学徒期/基本信息.txt'),
], async root => {
  await edit(root, '设定/文本规范.yaml', value => { value.档案追加字段.基本信息.习惯动作 = {形态: '情境列表'}; });
  await edit(root, basic, value => { value.习惯动作 = [{看见条目: '停下手边动作。'}]; });
});
invalidCase('文本补充：条目嵌套映射按文本声明扫描键', [
  hint('抽样.未执行', '历史'),
  finding('文本.禁用词', '船只/货船/潮汐号.txt'),
], async root => {
  await edit(root, '设定/条目库.yaml', value => { value.船只.字段.见闻 = {子字段: {沿途: {映射: {键: {形态: '文本'}, 值: {形态: '文本'}}}}}; });
  await edit(root, ship, value => { value.见闻 = {沿途: {看见条目: '船员先收拢缆绳。'}}; });
});

test('文本补充：固定字段名、追加字段名和引用映射键不扫描', async t => {
  const root = await fixture(t);
  await edit(root, '设定/文本规范.yaml', value => { value.禁用词.push('核心身份', '技能ID', '概况', '惯用手', '北湾'); });
  const result = await checkWorldbook(root, {sampling: false});
  const files = [basic, impression, shortSkill, port, ship];
  assert.deepEqual(result.errors.filter(item => files.includes(item.文件)), []);
  assert.deepEqual(result.hints, []);
});

test('文本补充：已入出处的逐字原台词含写法词豁免文本.写法', async t => {
  const root = await fixture(t);
  const quote = '灯架上似乎还有昨夜留下的油渍。';
  await edit(root, '历史/事件/拜师/角色/秦守.txt', value => {
    value.事件触发语料[0].候选台词.push(quote);
  });
  await edit(root, '../作者资料/出处/雾港.yaml', value => {
    value.push({事件ID: '拜师', 角色组ID: '秦守', 台词: quote, 来源: '测试原台词'});
  });
  const result = await checkWorldbook(root, {sampling: false});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hints, []);
});

invalidCase('文本补充：同位置未入出处的自拟台词含写法词仍报文本.写法', [
  hint('文本.写法', '历史/事件/拜师/角色/秦守.txt', {说明: ['似乎']}),
], async root => {
  const originalQuote = '灯架上似乎还有昨夜留下的油渍。';
  await edit(root, '历史/事件/拜师/角色/秦守.txt', value => {
    value.事件触发语料[0].候选台词.push(originalQuote, '风声似乎又紧了些。');
  });
  await edit(root, '../作者资料/出处/雾港.yaml', value => {
    value.push({事件ID: '拜师', 角色组ID: '秦守', 台词: originalQuote, 来源: '测试原台词'});
  });
});

invalidCase('文本补充：同位置非原台词字段含写法词仍报文本.写法', [
  hint('文本.写法', '历史/事件/拜师/角色/秦守.txt', {说明: ['似乎']}),
], async root => {
  const originalQuote = '灯架上似乎还有昨夜留下的油渍。';
  await edit(root, '历史/事件/拜师/角色/秦守.txt', value => {
    value.事件触发语料[0].候选台词.push(originalQuote);
    value.按分支.拜师.主观记忆.push('徒弟进门时似乎先扫了一眼灯架。');
  });
  await edit(root, '../作者资料/出处/雾港.yaml', value => {
    value.push({事件ID: '拜师', 角色组ID: '秦守', 台词: originalQuote, 来源: '测试原台词'});
  });
});

invalidCase('文本补充：普通档案正文含写法词仍报文本.写法', [
  hint('文本.写法', basic, {说明: ['似乎']}),
], root => edit(root, basic, value => { value.出身 += '，似乎自小熟悉海潮。'; }));
