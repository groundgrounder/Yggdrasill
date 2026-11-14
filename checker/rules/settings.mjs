import {readSettings} from '../../core/settings.mjs';
import {ProtocolError} from '../../core/protocol.mjs';
import {issue} from '../../core/utils.mjs';

export async function checkSettings(projectRoot, {fs, path, decl}) {
  try { await readSettings(projectRoot, {fs, path, decl}); return []; }
  catch (error) {
    if (error instanceof ProtocolError) return [issue('运行参数.格式', '错误', 'yggdrasill.yaml', error.message)];
    if (typeof error?.code === 'string' && typeof error?.syscall === 'string') {
      const actual = typeof error?.path === 'string' ? error.path : path.join(projectRoot, 'yggdrasill.yaml');
      const relative = path.relative(projectRoot, actual);
      const file = relative && !relative.startsWith('..') ? relative : actual;
      const message = String(error.message ?? '');
      const detail = message.includes(error.code) ? message : `${error.code}: ${message}`;
      return [issue('目录.读取失败', '错误', file, `无法读取运行参数“${actual}”：${detail}`)];
    }
    throw error;
  }
}
