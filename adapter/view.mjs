// 本局的视图：玩家面板、调试面板与每楼一行的记录。只产出数据，不碰 DOM，可在 node 中测试；页面上怎样画见 ui.mjs。
// 玩家看到的只有已经发生的：此刻、在场与认识的人、经历。候选、将到与已排除的事件只在调试面板里。
// 段落：{标题, 标记: [文本], 展开, 项: [[名, 值]], 行: [文本], 表: {列, 行}, 原文, 子段: [段落]}。值为文本，或文本列表（画成标签）。
import {createCalendar} from '../core/calendar.mjs';
import {stringifyYaml} from '../core/yaml.mjs';
import {isMap} from '../core/utils.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = value => value === undefined || value === null || (Array.isArray(value) ? !value.length : isMap(value) && !Object.keys(value).length);
// 在场与所在由“此刻”显示，已初始化只是标记。
const HIDDEN = new Set(['在场', '已初始化', '所在']);
const BRIEF = 3, FOLD = 6;
const COLUMNS = ['状态', '事件', '分支', '窗口', '确认', '实际'];

export function createView({protocol, catalog, decl, keeper}) {
  const calendar = createCalendar(decl.calendar);
  const events = new Map(catalog.events.map(event => [event.id, event]));
  const groups = new Map(catalog.groups.map(group => [group.id, group]));
  const dimensions = Object.keys(decl.ability?.维度 ?? {}), variables = decl.variables?.角色 ?? {};
  const short = text => String(text ?? '未写').replace(decl.calendar.前缀, '');
  const placeOf = state => { const place = state?.世界?.当前地点; return place ? `${place.地标}${place.场景 ? `·${place.场景}` : ''}` : '未写'; };
  const presentOf = state => Object.entries(state?.角色 ?? {}).filter(([, run]) => run?.在场 === true).map(([id]) => id);
  const selfOf = state => state?.开局?.玩家?.模式 === '扮演' ? state.开局.玩家.扮演角色组 : '玩家';
  const nameOf = (state, id) => {
    if (id === '玩家') return state?.开局?.玩家?.档案?.姓名 ?? '玩家';
    const group = groups.get(id);
    if (!group) return id;
    const version = (group.内容?.版本 ?? []).find(item => item.版本ID === state?.开局?.角色组?.[id]?.版本ID);
    return version?.显示名 ?? group.内容?.显示名 ?? id;
  };
  const titleOf = (id, record) => events.get(id)?.内容?.事件标题 ?? record?.摘要 ?? id;
  const branchOf = (id, branch) => (events.get(id)?.内容?.分支?.length ?? 0) > 1 && branch ? `（${branch}）` : '';
  const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

  // 值的标签：映射写作“键 值”，引用角色组的键换成显示名；装备写作“名（状态，位置）”。标量返回文本。
  function chips(state, value, key = null) {
    if (Array.isArray(value)) return value.map(item => isMap(item) ? JSON.stringify(item) : String(item));
    if (isMap(value) && key === '装备') return Object.entries(value).map(([id, item]) => `${id}（${[item?.状态, item?.位置].filter(Boolean).join('，')}）`);
    if (isMap(value)) return Object.entries(value).map(([id, item]) => `${groups.has(id) ? nameOf(state, id) : id} ${text(state, item)}`);
    return String(value);
  }
  const text = (state, value, key = null) => { const result = chips(state, value, key); return Array.isArray(result) ? result.join('、') : result; };

  function ageOf(view, id) {
    const state = view.state;
    const birth = id === '玩家' ? state.开局?.玩家?.档案?.出生年
      : groups.get(id)?.档案?.find(item => item.id === attempt(() => view.resolveProfile(id))?.档案ID)?.基本信息?.出生年;
    const now = calendar.year(state.世界?.当前时间), born = birth ? calendar.year(birth) : null;
    return now !== null && born !== null ? now - born : null;
  }

  function card(view, id, {self = false, open = false} = {}) {
    const state = view.state, run = state.角色?.[id] ?? {};
    const profile = id === '玩家' ? null : attempt(() => view.resolveProfile(id));
    const age = ageOf(view, id), items = [], children = [];
    for (const [key, value] of Object.entries(attempt(() => view.currentAbility(id)) ?? {})) if (!empty(value)) items.push([key, chips(state, value, key)]);
    const skills = attempt(() => view.availableSkills(id), []);
    if (skills.length) items.push(['可用技能', skills]);
    for (const [key, value] of Object.entries(run)) {
      if (HIDDEN.has(key) || dimensions.includes(key) || empty(value)) continue;
      if (Array.isArray(value) && value.length > FOLD) children.push({标题: key, 标记: [`${value.length} 条`], 行: value.map(String)});
      else items.push([key, chips(state, value, key)]);
    }
    return {标题: nameOf(state, id), 标记: [age !== null && `${age} 岁`, profile?.档案ID, self && id !== '玩家' && '玩家扮演'].filter(Boolean),
      展开: open, 项: items, ...(items.length || children.length ? {} : {行: ['（无记录）']}), 子段: children};
  }

  // 已发生的事件，按实际时间排序：[[时间, 标题]]。
  function history(state) {
    return Object.entries(state?.事件 ?? {}).filter(([id, record]) => record?.状态 === 1 && !id.startsWith('初次登场·'))
      .map(([id, record]) => ({id, record, at: calendar.time(record.实际时间)?.[0] ?? 0}))
      .sort((a, b) => a.at - b.at)
      .map(({id, record}) => [short(record.实际时间), `${titleOf(id, record)}${branchOf(id, record.分支)}`]);
  }

  function player(state) {
    const view = protocol.createReadView(state), current = view.state, self = selfOf(current);
    const present = view.presentIDs().filter(id => id !== self);
    const known = [...groups.keys()].filter(id => id !== self && !present.includes(id) && view.enabled(id) && current.角色?.[id]?.已初始化 === true);
    const lived = chain => (chain.内容?.事件 ?? []).filter(id => current.事件?.[id]?.状态 === 1).map(id => titleOf(id));
    const chains = catalog.chains.map(chain => ({chain, status: attempt(() => view.chainStatus(chain.id))}));
    const ongoing = chains.filter(item => item.status === '进行中').map(({chain}) => ({标题: chain.id, 标记: ['进行中'], 展开: true,
      行: [chain.内容?.概述].filter(Boolean), 项: [['已经历', lived(chain).length ? lived(chain) : '无']]}));
    const ended = chains.filter(item => item.status === '已结束').map(({chain}) => chain.id);
    const now = {标题: '此刻', 展开: true,
      项: [...(current.开局?.世界线 ? [['世界线', current.开局.世界线]] : []),
        ['时间', current.世界?.当前时间 ?? '未写'], ['地点', placeOf(current)], ['在场', present.length ? present.map(id => nameOf(current, id)) : '无'],
        ...(ended.length ? [['已经结束', ended]] : [])],
      子段: ongoing};
    const others = [...present.map(id => card(view, id)),
      ...(known.length ? [{标题: '不在场', 标记: [`${known.length} 人`], 子段: known.map(id => card(view, id))}] : [])];
    const past = history(current);
    return [now, card(view, self, {self: true, open: true}), ...others, {标题: '经历', 标记: [`${past.length} 件`], 项: past, ...(past.length ? {} : {行: ['无']})}];
  }

  // ---------- 调试面板 ----------
  function eventRow(view, event) {
    const status = attempt(() => view.eventStatus(event.id), {状态: '异常'}), record = view.state.事件?.[event.id];
    const window = event.内容?.触发时间 ?? {}, title = titleOf(event.id);
    const branch = record?.分支 ?? status.分支ID ?? (status.分支 ?? []).join('/');
    return [status.状态, title !== event.id ? `${title}〔${event.id}〕` : title, branch || '',
      `${short(window.最早)} — ${short(window.最晚)}`, event.内容?.确认策略 ?? '', record?.实际时间 ? short(record.实际时间) : ''];
  }
  const table = (view, ids) => ({列: COLUMNS, 行: ids.map(id => events.has(id) ? eventRow(view, events.get(id)) : ['不存在', id, '', '', '', ''])});

  // floors：[{楼号, 角色, 记录}]，记录为该楼可用的楼层变量。
  function debug(state, floors = []) {
    const view = protocol.createReadView(state), current = view.state;
    const chained = new Set(catalog.chains.flatMap(chain => chain.内容?.事件 ?? []));
    const chains = catalog.chains.map(chain => ({标题: chain.id, 标记: [attempt(() => view.chainStatus(chain.id)) ?? '?'], 表: table(view, chain.内容?.事件 ?? [])}));
    const loose = catalog.events.filter(event => !chained.has(event.id)).map(event => event.id);
    const dynamic = Object.entries(current.事件 ?? {}).filter(([id]) => !events.has(id) && !id.startsWith('初次登场·'))
      .map(([id, record]) => [short(record.实际时间), `${id}：${record.摘要 ?? ''}`]);
    const scope = keeper.upcoming(current);
    const floorSections = floors.map(({楼号, 角色, 记录}) => {
      const keep = 记录.记账 ?? {方式: '缺失', 应答格式: '缺失', 状态: '缺失', 尝试次数: 0};
      const source = `${keep.方式}·${keep.应答格式}·${keep.状态}·${keep.尝试次数} 次${keep.修补 ? '·已修补' : ''}`;
      const failed = 记录.失败?.length ?? 0;
      return {标题: `#${楼号} ${角色}`, 标记: [source, `格式 ${记录.记录格式}`, `命令 ${记录.命令数 ?? 记录.命令?.length ?? 0}`,
        ...(failed ? [`失败 ${failed}`] : [])],
        行: (记录.失败 ?? []).map(item => `${item.阶段}/${item.错误码}${item.序号 ? `·第 ${item.序号} 条` : ''}：${item.说明}`),
        原文: stringifyYaml({命令: 记录.命令 ?? null, ...(记录.记账?.原始结果 ? {原始结果: 记录.记账.原始结果} : {})})};
    });
    return [...player(state),
      {标题: '事件', 标记: [`${catalog.events.length} 件`], 子段: [...chains, {标题: '不在事件串中', 表: table(view, loose)},
        ...(dynamic.length ? [{标题: '动态事件', 项: dynamic}] : [])]},
      {标题: '记账员看到的事件', 项: [['候选', scope.candidates.length ? scope.candidates.map(item => item.event.id) : '无'],
        ['将到', scope.later.length ? scope.later.map(item => item.event.id) : '无']]},
      {标题: '各楼', 标记: [`${floors.length} 楼`], 子段: floorSections},
      {标题: '本局原文', 原文: stringifyYaml({世界: current.世界, 角色: current.角色, 事件: current.事件})}];
  }

  // ---------- 每楼一行 ----------
  // 一个字段的变化：[[简述, 详述…]]。映射里引用角色组的键写作“字段（显示名）”；一个映射里变了两项以上，简述并成“字段 N 项”。
  function diff(state, key, before, after) {
    const changes = changesOf(state, key, before, after);
    return isMap(before ?? after) && key !== '装备' && changes.length > 2 ? [[`${key} ${changes.length} 项`, ...changes.map(([, full]) => full)]] : changes;
  }

  function changesOf(state, key, before, after) {
    const changes = [];
    if (Array.isArray(before ?? after)) {
      const was = before ?? [], now = after ?? [];
      const added = now.filter(item => !was.some(old => same(old, item))), removed = was.filter(item => !now.some(value => same(value, item)));
      if (added.length) changes.push([added.length > 2 ? `${key} +${added.length}` : `${key} +${added.join('、')}`, `${key}：新增 ${added.join('、')}`]);
      if (removed.length) changes.push([`${key} −${removed.length}`, `${key}：移除 ${removed.join('、')}`]);
      return changes;
    }
    if (isMap(before ?? after)) {
      const was = before ?? {}, now = after ?? {}, keyed = variables[key]?.映射?.键?.引用;
      for (const sub of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
        if (same(was[sub], now[sub])) continue;
        const label = keyed ? `${key}（${groups.has(sub) ? nameOf(state, sub) : sub}）` : sub;
        let line;
        if (key === '装备') line = !was[sub] ? `获得 ${sub}` : !now[sub] ? `失去 ${sub}` : `${sub} ${text(state, was[sub])}→${text(state, now[sub])}`;
        else line = `${label} ${was[sub] === undefined ? '无' : text(state, was[sub])}→${now[sub] === undefined ? '无' : text(state, now[sub])}`;
        changes.push([line, line]);
      }
      return changes;
    }
    const line = `${key} ${before ?? '无'}→${after ?? '无'}`;
    return [[line, line]];
  }

  // before 为上一楼的本局（第 0 楼为开局封卷），after 为这一楼的。返回 {摘要, 详情: [[名, [值]]], 失败, 调试}：摘要收起时显示，详情按项分行。
  function floor(before, after, record, {debug: verbose = false} = {}) {
    const segments = [], details = [];
    const add = (brief, key, values) => { segments.push(brief); details.push([key, values]); };
    if (before.世界?.当前时间 !== after.世界?.当前时间) {
      const span = `${short(before.世界?.当前时间)} → ${short(after.世界?.当前时间)}`;
      add(`时间 ${span}`, '时间', [span]);
    }
    if (!same(before.世界?.当前地点, after.世界?.当前地点)) add(`地点 ${placeOf(after)}`, '地点', [placeOf(after)]);
    const was = new Set(presentOf(before)), now = new Set(presentOf(after));
    const came = [...now].filter(id => !was.has(id)).map(id => nameOf(after, id)), left = [...was].filter(id => !now.has(id)).map(id => nameOf(after, id));
    if (came.length) add(`来了 ${came.join('、')}`, '来了', came);
    if (left.length) add(`离开 ${left.join('、')}`, '离开', left);
    const happened = Object.entries(after.事件 ?? {}).filter(([id, item]) => item?.状态 === 1 && before.事件?.[id]?.状态 !== 1 && !id.startsWith('初次登场·'));
    const preset = happened.filter(([id]) => events.has(id)).map(([id, item]) => `${titleOf(id)}${branchOf(id, item.分支)}`);
    const dynamic = happened.filter(([id]) => !events.has(id)).map(([, item]) => item.摘要);
    if (preset.length) add(`发生 ${preset.join('、')}`, '发生', preset);
    if (dynamic.length) add(`新情况 ${dynamic.join('；')}`, '新情况', dynamic);
    for (const id of [...new Set([...Object.keys(before.角色 ?? {}), ...Object.keys(after.角色 ?? {})])]) {
      const old = before.角色?.[id] ?? {}, run = after.角色?.[id] ?? {};
      if (old.已初始化 !== true && run.已初始化 === true) { details.push([nameOf(after, id), ['初次登场']]); continue; }
      const changes = [...new Set([...Object.keys(old), ...Object.keys(run)])].filter(key => !HIDDEN.has(key) && !same(old[key], run[key]))
        .flatMap(key => diff(after, key, old[key], run[key]));
      if (!changes.length) continue;
      const brief = changes.slice(0, BRIEF).map(([value]) => value).join('，') + (changes.length > BRIEF ? ` 等 ${changes.length} 处` : '');
      add(`${nameOf(after, id)} ${brief}`, nameOf(after, id), changes.flatMap(([, ...full]) => full));
    }
    const failure = record?.记账?.状态 && !['成功', '部分失败'].includes(record.记账.状态)
      ? `记账${record.记账.状态}` : record?.失败?.length ? `${record.失败.length} 项没记上` : '';
    if (failure) add(failure, '没记上', [failure]);
    const result = {摘要: segments.join(' · ') || '无变化', 详情: details, 失败: Boolean(failure)};
    if (!verbose) return result;
    const views = [before, after].map(state => protocol.createReadView(state));
    const moved = catalog.events.map(event => [event.id, ...views.map(view => attempt(() => view.eventStatus(event.id).状态, '异常'))])
      .filter(([, from, to]) => from !== to).map(([id, from, to]) => `${id}：${from} → ${to}`);
    result.调试 = stringifyYaml({事件状态: moved,
      失败: (record?.失败 ?? []).map(item => `${item.阶段}/${item.错误码}：${item.说明}`),
      命令: record?.命令 ?? null, ...(record?.记账?.原始结果 ? {原始结果: record.记账.原始结果} : {})});
    return result;
  }

  return {player, debug, floor};
}
