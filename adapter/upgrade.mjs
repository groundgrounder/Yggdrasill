// 世界书哈希变化时的只读试重放分级（A/B/C）、封闭白名单差异分析与 B 级无损升级事务。
// 绝不修改 core/，也不在未获用户确认前改写任何楼层变量。
import {applyCommands} from '../core/commands.mjs';
import {codepointCompare, isMap} from '../core/utils.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
const MAX_DIFF_LINES = 10;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isMap(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export const sameSnapshot = (left, right) => canonical(left) === canonical(right);

function formatDiffValue(value) {
  if (value === undefined) return '无';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function collectFieldDiffs(path, left, right, diffs) {
  if (sameSnapshot(left, right)) return;
  if (isMap(left) && isMap(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(codepointCompare);
    for (const key of keys) {
      if (!Object.hasOwn(left, key)) {
        diffs.push(`字段变化：${path}.${key}（无 → ${formatDiffValue(right[key])}）`);
      } else if (!Object.hasOwn(right, key)) {
        diffs.push(`字段变化：${path}.${key}（${formatDiffValue(left[key])} → 无）`);
      } else {
        collectFieldDiffs(`${path}.${key}`, left[key], right[key], diffs);
      }
    }
    return;
  }
  diffs.push(`字段变化：${path}（${formatDiffValue(left)} → ${formatDiffValue(right)}）`);
}

function diffWhitelistMap({oldMap, newMap, prefix, missingLabel, addedOut, diffs}) {
  if (!isMap(oldMap) || !isMap(newMap)) {
    collectFieldDiffs(prefix, oldMap, newMap, diffs);
    return;
  }
  for (const key of Object.keys(oldMap).sort(codepointCompare)) {
    if (!Object.hasOwn(newMap, key)) diffs.push(`${missingLabel}：${prefix}.${key}`);
    else if (!sameSnapshot(oldMap[key], newMap[key])) collectFieldDiffs(`${prefix}.${key}`, oldMap[key], newMap[key], diffs);
  }
  for (const key of Object.keys(newMap).sort(codepointCompare)) {
    if (!Object.hasOwn(oldMap, key)) addedOut.push([key, clone(newMap[key])]);
  }
}

// 封闭白名单比对：仅允许 开局.角色组 与 世界.剧情标记 新增键，其余所有字段与原有键必须 100% 一致。
export function diffWorldbookState(saved, replayed, floorId = null) {
  const tag = floorId === null || floorId === undefined ? '' : `#${floorId} `;
  if (sameSnapshot(saved, replayed)) return {级别: 'A', 新增角色组: [], 新增剧情标记: [], 差异: [], 差异总数: 0};
  if (!isMap(saved) || !isMap(replayed)) {
    return {级别: 'C', 新增角色组: [], 新增剧情标记: [], 差异: [`${tag}字段变化：本局（${formatDiffValue(saved)} → ${formatDiffValue(replayed)}）`], 差异总数: 1};
  }
  const addedGroups = [], addedMarks = [], rawDiffs = [];

  if (!isMap(saved.开局) || !isMap(replayed.开局)) {
    collectFieldDiffs('开局', saved.开局, replayed.开局, rawDiffs);
  } else {
    const groupEntries = [];
    diffWhitelistMap({oldMap: saved.开局.角色组, newMap: replayed.开局.角色组, prefix: '开局.角色组',
      missingLabel: '缺失原角色组', addedOut: groupEntries, diffs: rawDiffs});
    for (const [id, value] of groupEntries) addedGroups.push({id, ...(isMap(value) ? value : {值: value})});
    for (const key of [...new Set([...Object.keys(saved.开局), ...Object.keys(replayed.开局)])].filter(k => k !== '角色组').sort(codepointCompare))
      collectFieldDiffs(`开局.${key}`, saved.开局[key], replayed.开局[key], rawDiffs);
  }

  if (!isMap(saved.世界) || !isMap(replayed.世界)) {
    collectFieldDiffs('世界', saved.世界, replayed.世界, rawDiffs);
  } else {
    const markEntries = [];
    diffWhitelistMap({oldMap: saved.世界.剧情标记, newMap: replayed.世界.剧情标记, prefix: '世界.剧情标记',
      missingLabel: '缺失原剧情标记', addedOut: markEntries, diffs: rawDiffs});
    for (const [id, value] of markEntries) addedMarks.push({id, 初值: value});
    for (const key of [...new Set([...Object.keys(saved.世界), ...Object.keys(replayed.世界)])].filter(k => k !== '剧情标记').sort(codepointCompare))
      collectFieldDiffs(`世界.${key}`, saved.世界[key], replayed.世界[key], rawDiffs);
  }

  for (const key of [...new Set([...Object.keys(saved), ...Object.keys(replayed)])].filter(k => k !== '开局' && k !== '世界').sort(codepointCompare))
    collectFieldDiffs(key, saved[key], replayed[key], rawDiffs);

  if (rawDiffs.length) {
    return {级别: 'C', 新增角色组: addedGroups, 新增剧情标记: addedMarks,
      差异: rawDiffs.slice(0, MAX_DIFF_LINES).map(line => `${tag}${line}`), 差异总数: rawDiffs.length};
  }
  return {级别: 'B', 新增角色组: addedGroups, 新增剧情标记: addedMarks, 差异: [], 差异总数: 0};
}

// 在内存对全聊助手楼执行只读试重放，输出 A（无缝放行）/ B（纯增补待升级 + 升级计划）/ C（破坏性冲突 + 精准差异）。
export function assessWorldbookCompat({list, end = list.length, skip = null, ignoreOwnership = null, protocol, manifest,
  recordOf, replayRecord, storedManifest, ownershipOf, recordFormat = 1}) {
  let state = null, hasB = false, hasC = false, totalCDiffs = 0;
  const cDiffs = [], cFloors = [], diffFloors = [], floorPlans = [];
  const addedGroupMap = new Map(), addedMarkMap = new Map();

  for (let id = 0; id < end; id++) {
    const message = list[id];
    if (message?.role !== 'assistant' || id === skip) continue;
    const record = recordOf(message);
    const candidate = id === ignoreOwnership && record?.归属 && typeof record.归属 === 'object'
      ? {...record, 归属: ownershipOf(message)} : record;
    if (candidate?.运行清单?.世界书哈希 !== manifest.世界书哈希) diffFloors.push(id);

    let replayed;
    if (id === 0) {
      try {
        const opening = candidate.本局.开局;
        const seeded = protocol.seal({
          开局时间: opening.开局时间, 角色组: opening.角色组, 玩家: opening.玩家,
          历史选择: opening.历史选择, ...(opening.方案 ? {方案: opening.方案} : {}),
        });
        replayed = replayRecord(candidate, seeded, (base, commands) => applyCommands(protocol, base, commands));
        protocol.createReadView(replayed.state);
      } catch (error) {
        hasC = true;
        cFloors.push(0);
        cDiffs.push(`#0 重放异常（${error.code ?? '开局.封卷'}）：${error.message}`);
        totalCDiffs += 1;
        break;
      }
    } else {
      if (state === null) {
        hasC = true;
        cFloors.push(0);
        cDiffs.push('#0 缺失可用的开局记录');
        totalCDiffs += 1;
        break;
      }
      try {
        replayed = replayRecord(candidate, state, (base, commands) => applyCommands(protocol, base, commands));
      } catch (error) {
        hasC = true;
        cFloors.push(id);
        cDiffs.push(`#${id} 重放异常（${error.code ?? '重放.执行'}）：${error.message}`);
        totalCDiffs += 1;
        break;
      }
    }

    if (replayed.失败.length) {
      hasC = true;
      cFloors.push(id);
      for (const item of replayed.失败) {
        totalCDiffs += 1;
        if (cDiffs.length < MAX_DIFF_LINES) cDiffs.push(`#${id} 命令失败（${item.错误码}）：${item.说明}`);
      }
      break;
    }
    if (JSON.stringify(replayed.已写入) !== JSON.stringify(candidate.已写入)) {
      hasC = true;
      cFloors.push(id);
      totalCDiffs += 1;
      if (cDiffs.length < MAX_DIFF_LINES)
        cDiffs.push(`#${id} 已写入变化：${JSON.stringify(candidate.已写入)} → ${JSON.stringify(replayed.已写入)}`);
      break;
    }

    const diff = diffWorldbookState(candidate.本局, replayed.state, id);
    if (diff.级别 === 'C') {
      hasC = true;
      cFloors.push(id);
      totalCDiffs += diff.差异总数;
      for (const line of diff.差异) if (cDiffs.length < MAX_DIFF_LINES) cDiffs.push(line);
    } else if (diff.级别 === 'B') {
      hasB = true;
      for (const item of diff.新增角色组) if (!addedGroupMap.has(item.id)) addedGroupMap.set(item.id, item);
      for (const item of diff.新增剧情标记) if (!addedMarkMap.has(item.id)) addedMarkMap.set(item.id, item);
    }
    floorPlans.push({楼号: id, 归属: clone(candidate.归属), 原始记录: candidate, 新本局: replayed.state});
    state = replayed.state;
  }

  if (hasC) {
    return {
      ok: false,
      code: '运行清单.世界书哈希',
      级别: 'C',
      楼号: cFloors[0] ?? diffFloors[0] ?? 0,
      说明: `世界书更新存在破坏性冲突（共 ${totalCDiffs || cDiffs.length} 处）`,
      差异: cDiffs.slice(0, MAX_DIFF_LINES),
      差异总数: totalCDiffs || cDiffs.length,
    };
  }

  if (hasB) {
    const groupIds = [...addedGroupMap.keys()].sort(codepointCompare);
    const markIds = [...addedMarkMap.keys()].sort(codepointCompare);
    const manifestSnapshot = storedManifest(manifest);
    const 升级计划 = floorPlans.filter(item =>
      item.原始记录.运行清单.世界书哈希 !== manifest.世界书哈希 || !sameSnapshot(item.原始记录.本局, item.新本局),
    ).map(item => ({
      楼号: item.楼号,
      归属: item.归属,
      记录: {
        记录格式: recordFormat,
        运行清单: clone(manifestSnapshot),
        归属: clone(item.归属),
        本局: clone(item.新本局),
        命令: clone(item.原始记录.命令),
        失败: clone(item.原始记录.失败),
        已写入: clone(item.原始记录.已写入),
        记账: clone(item.原始记录.记账),
      },
    }));
    return {
      ok: false,
      code: '运行清单.世界书哈希',
      级别: 'B',
      楼号: 升级计划[0]?.楼号 ?? diffFloors[0] ?? 0,
      说明: '世界书已增补更新（原有历史 0 冲突），请先确认升级本局存档',
      upgrade: {
        新增角色组: groupIds,
        新增角色组详情: groupIds.map(id => addedGroupMap.get(id)),
        新增剧情标记: markIds.map(id => `${id}=${addedMarkMap.get(id).初值}`),
        新增剧情标记详情: markIds.map(id => addedMarkMap.get(id)),
        待升级楼号: 升级计划.map(item => item.楼号),
        升级计划,
        归属快照: floorPlans.map(item => item.归属),
      },
    };
  }

  return {ok: true, state, worldbook: {级别: 'A', 差异楼号: diffFloors}};
}

// B 级待升级事务执行器：在串行队列中重新校验归属与 B 级前置，逐楼写入新快照与清单，中途失败即停。
export function createUpgradeFlow({manifest, recordKey, recordFormat, validateRecord, ownershipOf, sanitizeText,
  messages, chatId, enqueue, audit, refresh, session, status}) {
  async function upgrade() {
    if (!session.upgrade) return false;
    const originChatId = session.upgrade.chatId;
    const originSnapshots = session.upgrade.snapshots;
    return enqueue(async () => {
      if (!session.upgrade) return false;
      if (chatId() !== originChatId) {
        status.toastError('聊天已切换，已取消升级本局存档。', '世界树：升级失败');
        return false;
      }
      const list = messages();
      const liveSnapshots = list.filter(item => item.role === 'assistant').map(item => ownershipOf(item));
      if (originSnapshots?.length && !sameSnapshot(liveSnapshots, originSnapshots)) {
        const rechecked = audit(list);
        if (!rechecked.ok) {
          if (rechecked.级别 === 'B') status.upgradePending(rechecked);
          else status.blocked(rechecked);
        }
        status.toastError('楼层正文或分支已变化，已中止升级。', '世界树：升级失败');
        return false;
      }
      const fresh = audit(list);
      if (fresh.ok) {
        session.upgrade = null;
        session.integrity = null;
        refresh();
        return true;
      }
      if (fresh.级别 !== 'B' || !fresh.upgrade?.升级计划?.length) {
        status.blocked(fresh);
        return false;
      }
      for (const step of fresh.upgrade.升级计划) {
        if (chatId() !== originChatId) {
          status.toastError('升级中途聊天已切换，已立即停止。', '世界树：升级失败');
          return false;
        }
        const liveList = messages(), message = liveList[step.楼号];
        if (!message || message.role !== 'assistant' || !sameSnapshot(ownershipOf(message), step.归属)) {
          status.toastError(`第 ${step.楼号} 楼归属发生变化，已停止升级。`, '世界树：升级失败');
          return false;
        }
        const checked = validateRecord(step.记录, message, manifest, recordFormat);
        if (!checked.ok) {
          status.toastError(`第 ${step.楼号} 楼升级记录校验失败：${checked.说明}`, '世界树：升级失败');
          return false;
        }
        try {
          const variables = getVariables({type: 'message', message_id: step.楼号});
          await replaceVariables({...variables, [recordKey]: step.记录}, {type: 'message', message_id: step.楼号});
        } catch (error) {
          status.toastError(`第 ${step.楼号} 楼写入失败：${sanitizeText(error.message)}`, '世界树：升级失败');
          return false;
        }
      }
      session.upgrade = null;
      session.integrity = null;
      const verified = audit(messages());
      if (!verified.ok) {
        if (verified.级别 === 'B') status.upgradePending(verified);
        else status.blocked(verified);
        status.toastError('升级后整局校验未通过：' + (verified.说明 ?? ''), '世界树：升级失败');
        return false;
      }
      refresh();
      toastr.success(`已完成 ${fresh.upgrade.升级计划.length} 个助手楼的无损升级。`, '世界树：存档已升级');
      return true;
    });
  }

  return {upgrade};
}
