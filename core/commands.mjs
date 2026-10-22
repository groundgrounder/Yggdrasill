import {ProtocolError} from './protocol.mjs';
import {isMap} from './utils.mjs';

export function applyCommands(protocol, state, commands) {
  if (!Array.isArray(commands)) throw new ProtocolError('协议.参数', '命令须为列表');
  const handlers = new Map([
    ['确认事件', params => protocol.confirmEvent(current, params)],
    ['动态事件', params => protocol.confirmDynamicEvent(current, params)],
    ['确认初始化', params => {
      if (Object.keys(params).length !== 1 || !Object.hasOwn(params, '角色组ID')) throw new ProtocolError('协议.参数', '确认初始化参数须只含角色组ID');
      return protocol.confirmInitialization(current, params.角色组ID);
    }],
    ['写场景', params => protocol.writeScene(current, params)],
    ['待定项', params => protocol.writePendingItem(current, params)],
  ]);
  let current = state;
  const written = [], failures = [];
  commands.forEach((command, index) => {
    const name = isMap(command) && Object.keys(command).length === 1 ? Object.keys(command)[0] : null;
    try {
      if (!name || !handlers.has(name) || !isMap(command[name])) throw new ProtocolError('协议.参数', '命令须为已知命令名到参数映射的单键映射');
      const result = handlers.get(name)(command[name]);
      current = result.state; written.push(...result.已写入);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      failures.push({序号: index + 1, 命令: name, 错误码: error.code, 说明: error.message});
    }
  });
  return {state: current, 已写入: written, 失败: failures};
}
