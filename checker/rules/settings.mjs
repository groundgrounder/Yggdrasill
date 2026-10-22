import {readSettings} from '../../core/settings.mjs';
import {ProtocolError} from '../../core/protocol.mjs';
import {issue} from '../../core/utils.mjs';

export async function checkSettings(projectRoot, {fs, path, decl}) {
  try { await readSettings(projectRoot, {fs, path, decl}); return []; }
  catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    return [issue('运行参数.格式', '错误', 'yggdrasill.yaml', error.message)];
  }
}
