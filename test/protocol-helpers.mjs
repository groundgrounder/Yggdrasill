import {fs, path, example, fixture, edit} from './helpers.mjs';
import {readDeclarations, validateDeclarations, loadWorldbook, createProtocol, seal, writeScene, confirmEvent,
  confirmDynamicEvent, ProtocolError} from '../core/index.mjs';
export * from './helpers.mjs';
export * from '../core/protocol.mjs';
export const eventFile = id => `历史/事件/${id}/事件.txt`;
export const time = value => {
  if (value.startsWith('潮历')) return value;
  const [year, month, day] = value.split('-');
  return `潮历${year}年${month ? `${month}月${day}日` : ''}`;
};
export async function loadProtocol(root = example) {
  const {raw} = await readDeclarations(root, {fs, path});
  const {decl} = validateDeclarations(raw);
  const {catalog} = await loadWorldbook(root, {fs, path, decl});
  return {protocol: createProtocol({catalog, decl}), catalog, decl};
}
export async function changedProtocol(t, file, change) {
  const root = await fixture(t);
  await edit(root, file, change);
  return {root, ...await loadProtocol(root)};
}
export const S = (protocol, value, choices = {}) => seal(protocol, {...(value ? {开局时间: time(value)} : {}), ...choices});
export const W = (protocol, state, params) => writeScene(protocol, state, params);
export const C = (protocol, state, id, branchID, extra = {}) => confirmEvent(protocol, state, {事件ID: id, 分支ID: branchID, ...extra});
export const D = (protocol, state, changes, extra = {}) => confirmDynamicEvent(protocol, state,
  {事件ID: '测试', 摘要: '测试', 变化: changes, ...extra});
export const change = (field, operation, value) => ({路径: field.startsWith('角色.') || field.startsWith('世界.')
  ? field : `角色.灯塔学徒.${field}`, 操作: operation, ...(value === undefined ? {} : {值: value})});
export const errorCode = code => error => error instanceof ProtocolError && error.code === code;
export const fogGate = {all: [{事件确认: {事件ID: '大雾之夜'}}, {none: [{事件确认: {事件ID: '港务署问责'}}]}]};
export const record = (branch, at, participants) => ({状态: 1, 分支: branch, 实际时间: time(at), 实际参与者: participants});
export const records72 = {
  拜师: record('拜师', '071-01-10', ['灯塔学徒', '秦守']),
  夜间值守: record('完成', '071-03-91', ['灯塔学徒']),
  接手商会账目: record('接手', '071-03-91', ['白棠']),
  大雾之夜: record('发生', '071-04-20', []),
  学徒守灯: record('重燃灯塔', '071-04-20', ['灯塔学徒']),
  白棠在码头: record('在家等候', '071-04-20', ['白棠']),
  港务署问责: {状态: 2},
};
export const records74 = {...records72,
  出师考核: record('通过', '072-02-01', ['灯塔学徒', '秦守']),
  正式守灯: record('就任', '073-03-91', ['灯塔学徒']),
  潮汐号首航: {状态: 2}, 补考: {状态: 2}};
export const roles72 = {
  灯塔学徒: {所在: '灯塔', 身份: ['秦守的徒弟'], 技艺: {灯语: '熟手'}, 关系: {秦守: '师徒'}, 习惯: ['每刻钟查一次灯芯'],
    天赋: ['雾中视·辨影'], 好感度: {秦守: 10}, 知识: ['秦守在雾夜守住了灯']},
  秦守: {关系: {灯塔学徒: '师徒'}, 好感度: {灯塔学徒: 5}},
  白棠: {职位: {白帆商会: '账房'}, 身份: ['商会继承人'], 知识: ['雾夜里码头的钟响了一整夜']},
};
export const roles74 = {...roles72, 灯塔学徒: {...roles72.灯塔学徒, 技艺: {灯语: '匠人'},
  装备: {'灯具·风暴灯': {状态: '完好', 位置: '随身'}}, 职位: {港务署: '守灯人'}, 身份: ['秦守的徒弟', '灯塔守'], 名望: '熟手'}};
