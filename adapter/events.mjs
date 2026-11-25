// 酒馆事件与按钮监听注册：仅负责把宿主生命周期与按钮动作转发给运行时状态与队列。
export function registerAdapterEvents({
  INJECT_ID,
  manifest,
  bundle,
  protocol,
  view,
  history,
  session,
  messages,
  invalidateTasks,
  enqueue,
  checkPermission,
  isGeneratingOrEmptyTail,
  stopHostGeneration,
  isKeeping,
  bookkeeping,
  debugging,
  refresh,
  replayFrom,
  rekeepFloor,
  openRepair,
  init,
  checkCompatRecord,
  openingFlow,
  status,
  recordOf,
  emptyTailAssistant,
  callKeeper,
  parseJson,
  showSettings,
  stringifyYaml,
  seal,
  ownershipOf,
}) {
  eventOn(tavern_events.GENERATION_AFTER_COMMANDS, async (type, options, dryRun) => {
    // 酒馆助手的 generateRaw 在记账中发 GENERATION_AFTER_COMMANDS，参数是空对象；它必须立即返回，避免等自己。
    // 酒馆按钮触发的正常生成参数非空，即使记账仍在进行也要等队列完成。
    if (dryRun || (isKeeping() && options && typeof options === 'object' && Object.keys(options).length === 0)) return;
    await enqueue(() => {});
    const denied = checkPermission();
    if (!denied) {
      await stopHostGeneration('权限不足：' + (session.permission?.说明 ?? '卡内脚本或局部正则未获准'));
      return;
    }
    if (session.openingPending) {
      uninjectPrompts([INJECT_ID]);
      status.renderFloors();
      await stopHostGeneration('尚未开局');
      return;
    }
    if (session.integrity || session.upgrade) {
      uninjectPrompts([INJECT_ID]);
      if (session.upgrade) status.renderFloors();
      await stopHostGeneration(session.upgrade ? '世界书已增补更新，请先确认升级本局存档' : undefined);
      return;
    }
    invalidateTasks();
    const list = messages(), tail = list.at(-1);
    const replacing = ['swipe', 'regenerate', 'continue'].includes(type) && tail?.role === 'assistant';
    const ok = refresh({exclude: replacing ? tail.message_id : null});
    if (!ok || session.integrity || session.upgrade)
      await stopHostGeneration(session.upgrade ? '世界书已增补更新，请先确认升级本局存档' : undefined);
  });

  eventOn(tavern_events.MESSAGE_SENT, () => {
    invalidateTasks();
    if (session.openingPending || session.integrity || session.upgrade) { uninjectPrompts([INJECT_ID]); status.renderFloors(); return; }
    return refresh();
  });

  async function updateAssistant(list, number, message, base, kind, checkOld) {
    if (checkOld) {
      const oldChain = history.audit(list, {ignoreOwnership: number});
      if (!oldChain.ok) return status.blocked(oldChain);
    }
    const downstream = history.checkRecords(list, {from: number + 1, allowWorldbookDiff: true});
    if (!downstream.ok) return status.blocked(downstream);
    const changed = history.checkChangedAssistant(message, {allowWorldbookDiff: true});
    if (!changed.ok) return status.blocked({...changed, 楼号: number});
    if (await replayFrom(number, base, {fresh: true, kind})) refresh();
  }

  eventOn(tavern_events.MESSAGE_RECEIVED, (id, type) => {
    invalidateTasks();
    return enqueue(async () => {
      if (session.integrity || session.upgrade) return status.renderFloors();
      const number = Number(id), list = messages(), message = list[number];
      if (message?.role !== 'assistant') return refresh();
      // 新聊天的开场白也会发 first_message 的“收到消息”事件；它由 init 写入开场命令记录，不是叙事模型新写的助手楼。
      if (number === 0 && type === 'first_message') return init();
      if (session.openingPending) return status.renderFloors();
      if (number > 0 && !(message.message ?? '')) {
        if (list.slice(number + 1).some(item => item.role === 'assistant'))
          return status.blocked({code: '记录.空正文', 说明: '中间助手楼正文为空，后面还有助手楼，不能跳过或忽略', 楼号: number});
        toastr.warning('本楼正文为空，未记账；可重新生成或删除该楼。', '世界树');
        return refresh({exclude: number});
      }
      const prefix = history.audit(list, {end: number});
      if (!prefix.ok) return status.blocked(prefix);
      const stored = recordOf(message);
      // 酒馆会给新助手楼继承上一楼的变量；归属仍在旧楼时，它只是副本，不能当作本楼旧记录审计。
      await updateAssistant(list, number, message, prefix.state, '新正文', stored !== undefined && stored?.归属?.楼号 === number);
    });
  });

  eventOn(tavern_events.MESSAGE_EDITED, id => {
    const number = Number(id);
    history.invalidateFrom(number);
    // 开场提交会先写第 0 楼正文，宿主随后发出的编辑事件属于本次写入而非玩家改动。
    // 提交期间不使任务失效；提交完成后按正文指纹识别自己写入的那一版。
    const selfEdit = () => {
      if (number !== 0 || !session.openingSelfEdit) return false;
      const message = messages()[0];
      if (message && ownershipOf(message).正文指纹 === session.openingSelfEdit) return true;
      session.openingSelfEdit = null;
      return false;
    };
    if (selfEdit()) return;
    if (!session.openingPending) invalidateTasks();
    return enqueue(async () => {
      if (selfEdit()) return;
      if (session.integrity || session.upgrade) return status.renderFloors();
      const list = messages(), message = list[number];
      if (!message || message.role === 'system') return refresh();
      if (session.openingPending) return status.renderFloors();
      const prefix = history.audit(list, {end: number});
      if (!prefix.ok) return status.blocked(prefix);
      if (message.role === 'user') {
        const full = history.audit(list);
        if (!full.ok) return status.blocked(full);
        const downstream = history.checkRecords(list, {from: number + 1, allowWorldbookDiff: true});
        if (!downstream.ok) return status.blocked(downstream);
        if (await replayFrom(number + 1, prefix.state, {kind: '编辑玩家楼后重放'})) refresh();
      } else await updateAssistant(list, number, message, prefix.state, '编辑助手楼后记账', recordOf(message) !== undefined);
    });
  });

  eventOn(tavern_events.MESSAGE_SWIPED, id => {
    invalidateTasks();
    history.invalidateFrom(Number(id));
    return enqueue(async () => {
      if (session.integrity || session.upgrade) return status.renderFloors();
      const number = Number(id), list = messages(), message = list[number];
      if (session.openingPending) return status.renderFloors();
      const prefix = history.audit(list, {end: number});
      if (!prefix.ok) return status.blocked(prefix);
      if (message?.role !== 'assistant') return refresh();
      if (!message.message) {
        if (list.slice(number + 1).some(item => item.role === 'assistant'))
          return status.blocked({code: '记录.当前 swipe', 说明: '空 swipe 后面还有助手楼，不能跳过它作答', 楼号: number});
        refresh({exclude: number});
        return;
      }
      const checked = checkCompatRecord(recordOf(message), message);
      if (!checked.ok) return status.blocked({...checked, 楼号: number});
      const all = history.checkRecords(list, {allowWorldbookDiff: true});
      if (!all.ok) return status.blocked(all);
      if (await replayFrom(number, prefix.state, {kind: '切换 swipe 重放'})) refresh();
    });
  });

  // 删除事件只带新长度。从第 0 楼起用保留楼层的成功命令重放；只读/待升级态删楼后自动重审，若合法即刻解锁恢复。
  eventOn(tavern_events.MESSAGE_DELETED, () => {
    invalidateTasks();
    history.clearCache();
    return enqueue(async () => {
      const wasBlocked = Boolean(session.integrity || session.upgrade);
      session.integrity = null; session.upgrade = null;
      const list = messages();
      if (!list.length || (list[0]?.role === 'assistant' && !recordOf(list[0]))) await init();
      else {
        const end = emptyTailAssistant(list)?.message_id ?? list.length, effective = list.slice(0, end);
        const checked = history.checkRecords(effective, {shifted: true, allowWorldbookDiff: true});
        if (!checked.ok) return status.blocked(checked);
        if (effective[0]?.role !== 'assistant') return status.blocked({code: '记录.缺失', 说明: '这里没有可用的世界树记录', 楼号: 0});
        const opening = recordOf(effective[0]), rootAudit = history.audit(effective.slice(0, 1));
        if (!rootAudit.ok) return status.blocked(rootAudit);
        if (!(await replayFrom(1, opening.本局, {kind: '删除楼层后传播', shifted: true, end})) || !refresh()) return;
      }
      if (wasBlocked && !session.integrity && !session.upgrade)
        toastr.info('删除问题楼层后校验通过，已恢复正常游玩。', '世界树：已恢复');
    });
  });

  eventOn(tavern_events.CHAT_CHANGED, () => {
    invalidateTasks();
    history.clearCache();
    return enqueue(async () => {
      for (const key of ['openingPopup', 'repairPopup']) {
        if (!session[key]) continue;
        session.openingClosingForChat = true;
        try { await session[key].completeCancelled(); } catch {}
        session.openingClosingForChat = false;
        session[key] = null;
      }
      session.integrity = null; session.upgrade = null; session.compatNotified = false; session.permission = null;
      session.last = null; session.keepingFloor = null; session.openingPending = false; session.openingOpen = false;
      session.openingSelfEdit = null;
      await init();
    });
  });

  let redraw = null;
  const scheduleFloors = () => { clearTimeout(redraw); redraw = setTimeout(() => status.renderFloors(), 50); };
  for (const type of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED'])
    if (tavern_events[type]) eventOn(tavern_events[type], scheduleFloors);

  // ---------- 按钮 ----------
  eventOn(getButtonEvent('世界树：开局'), () => openingFlow.open());

  eventOn(getButtonEvent('世界树：本轮上下文'), () => {
    if (session.openingPending) return status.show('尚未开局', '请先完成开局。确认前不会创建本局或注入叙事上下文。');
    if (session.integrity) return status.showBlocked();
    if (session.upgrade) return status.showUpgrade();
    if (!debugging()) return status.show('本轮上下文', '本轮上下文中有尚未发生的事件。要看，先在“世界树：设置”中打开调试。');
    if (!session.last || session.last.error) refresh();
    if (session.last?.error) return status.show('本轮上下文', '路由失败：' + session.last.error);
    status.show('本轮上下文（' + [...session.last.content].length + ' 字符，基于' + session.last.基于 + '）',
      session.last.content + '\n\n===== 审计 =====\n' + stringifyYaml(session.last.audit));
  });

  eventOn(getButtonEvent('世界树：本局'), () => {
    if (session.openingPending) return status.show('尚未开局', '请先完成开局。确认前没有可显示的本局记录。');
    if (session.integrity) return status.showBlocked();
    if (session.upgrade) return status.showUpgrade();
    const state = session.last?.state ?? seal(protocol, bundle.opening);
    if (!debugging()) return status.showSections('本局', view.player(state));
    const floors = messages().map(message => ({楼号: message.message_id, 角色: message.role, 记录: recordOf(message)}))
      .filter(item => item.角色 === 'assistant' && checkCompatRecord(item.记录, messages()[item.楼号]).ok);
    status.showSections('本局（调试）', view.debug(state, floors));
  });

  eventOn(getButtonEvent('世界树：重新记账'), () => enqueue(async () => {
    if (session.openingPending) return toastr.warning('尚未开局，没有可以记账的楼', '世界树');
    if (session.integrity || session.upgrade) return status.renderFloors();
    const list = messages(), busy = isGeneratingOrEmptyTail(list);
    if (busy) return toastr.warning(busy, '世界树');
    const id = [...list].reverse().find(message => message.role === 'assistant' && message.message_id > 0)?.message_id;
    if (id === undefined) return toastr.warning('没有可以记账的楼', '世界树');
    await rekeepFloor(list, id);
  }));

  eventOn(getButtonEvent('世界树：设置'), () => showSettings({call: callKeeper, parse: parseJson, queue: enqueue, refresh}));
}
