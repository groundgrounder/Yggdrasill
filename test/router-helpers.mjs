import {fs, path, project, example, loadProtocol, S, W, time} from './protocol-helpers.mjs';
import {createRouter} from '../core/router.mjs';
import {readSettings} from '../core/settings.mjs';
export * from './protocol-helpers.mjs';
export * from '../core/router.mjs';
export * from '../core/text.mjs';
export * from '../core/commands.mjs';
export * from '../core/settings.mjs';
export {checkWorldbook} from '../checker/index.mjs';

export const templates = Object.fromEntries(await Promise.all(['变量更新规则', '角色通用约束', '扮演准则'].map(async name =>
  [name, await fs.readFile(path.join(project, 'templates', `${name}.txt`), 'utf8')])));
export const messages = ['棠小姐托人来问，雾季的灯号会不会改。',
  '秦守在值守室里讲起灯语·长夜信号的手法，又提到航海·夜航的规矩，说周书记过几天要上来看灯。'];
export async function loadRouting(root = example, settings = {}) {
  const result = await loadProtocol(root);
  const loaded = await readSettings(path.dirname(root), {fs, path, decl: result.decl});
  return {...result, router: createRouter({...result, settings: {...loaded, ...settings}, templates})};
}
export const R0 = protocol => W(protocol, S(protocol, '072'), {当前地点: {地标: '灯塔', 场景: '值守室'},
  在场: {灯塔学徒: true, 秦守: true}}).state;
export function U1(protocol) {
  const state = S(protocol, '071-04-19'); state.世界.当前时间 = time('071-04-25'); return state;
}
