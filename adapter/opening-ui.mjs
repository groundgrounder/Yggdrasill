// 开局前端界面：世界线 → 预设开局 → 开局时间与地点 → 玩家（含自建结构化引导表单）→ 四模式开场白 → 默认折叠的高级选项（角色组 + 历史选择）→ 有效预览摘要。
// 所有改动立即交给 opening.mjs 重新预演；失败只在顶部显示错误，上一份有效预览仍留在下方。
// DOM 与事件止于此，封卷、命令和写入仍由 runtime 完成。

export function openingNode(draft) {
  const root = $('<div>').addClass('ygg-panel ygg-form ygg-opening');
  const ui = {
    groupSearch: '',
    groupFilter: '',
    advancedOpen: false,
    yamlOpen: false,
    abilityPick: {},
    equipPick: {装备ID: '', 状态: '', 位置: '随身'},
  };

  const hint = text => $('<div>').addClass('ygg-hint').text(text);
  const field = (label, control, note) => $('<div>').addClass('ygg-field').append($('<label>').text(label), control, ...(note ? [hint(note)] : []));
  const select = options => $('<select>').addClass('text_pole').append(options.map(([value, label]) => $('<option>').val(value).text(label)));
  const section = (title, open, ...children) => $('<details>').addClass('ygg-sec').prop('open', open)
    .append($('<summary>').text(title), $('<div>').addClass('ygg-body').append(children));

  function renderSelfBuiltForm(snapshot) {
    const form = snapshot.自建表单 ?? {};
    const profile = form.档案 ?? {};
    const appearance = profile.稳定体貌 ?? {};
    const cal = form.纪年 ?? {};
    const textInput = (value, placeholder, onChange) => $('<input>').addClass('text_pole').attr({type: 'text', placeholder})
      .val(value ?? '').on('change', event => { onChange(event.target.value); render(); });

    // 开局年龄与出生年双向换算提示
    const birthMatch = typeof profile.出生年 === 'string' && cal.前缀
      ? profile.出生年.match(new RegExp(`^${cal.前缀.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)年`)) : null;
    const birthYear = birthMatch ? Number(birthMatch[1]) : null;
    const currentYear = Number.isSafeInteger(cal.当前年) ? cal.当前年 : null;
    const ageNow = currentYear !== null && birthYear !== null ? currentYear - birthYear : null;
    const ageInput = $('<input>').addClass('text_pole').attr({type: 'number', min: 0, placeholder: '按年龄换算'})
      .val(ageNow !== null && ageNow >= 0 ? String(ageNow) : '')
      .on('change', event => {
        const raw = String(event.target.value ?? '').trim();
        if (!raw || currentYear === null) return;
        const years = Number(raw);
        if (!Number.isSafeInteger(years) || years < 0 || currentYear - years < 0) return;
        const digits = Number(cal.年位数) || 3;
        const formatted = `${cal.前缀}${String(currentYear - years).padStart(digits, '0')}年`;
        draft.setProfileField('出生年', formatted);
        render();
      });

    const basicGrid = $('<div>').addClass('ygg-opening-grid').append(
      field('姓名', textInput(profile.姓名, '主角姓名', v => draft.setProfileField('姓名', v))),
      field('性别', textInput(profile.性别, '如：男 / 女', v => draft.setProfileField('性别', v))),
      field('种族', textInput(profile.种族, '如：人族', v => draft.setProfileField('种族', v))),
      field('出身', textInput(profile.出身, '简述出身背景', v => draft.setProfileField('出身', v))),
      field('出生年', $('<div>').addClass('ygg-row').append(
        textInput(profile.出生年, cal.格式 || '纪年', v => draft.setProfileField('出生年', v)),
        ...(currentYear !== null ? [ageInput] : []),
      ), ageNow !== null ? `当前约 ${ageNow} 岁；可填出生年或直接输年龄自动换算。` : `格式：${cal.格式 || snapshot.时间格式}`),
      field('称号', textInput((profile.称号 ?? []).join('、'), '多个用顿号分隔', v => draft.setProfileField('称号', v))),
    );

    const appearanceGrid = $('<div>').addClass('ygg-opening-grid').append(
      field('发色发型', textInput(appearance.发色发型, '如：黑发短发', v => draft.setProfileField('稳定体貌.发色发型', v))),
      field('瞳色', textInput(appearance.瞳色, '如：深褐', v => draft.setProfileField('稳定体貌.瞳色', v))),
      field('体型', textInput(appearance.体型, '如：匀称', v => draft.setProfileField('稳定体貌.体型', v))),
      field('体貌特征', textInput((appearance.特征 ?? []).join('、'), '短语，顿号分隔', v => draft.setProfileField('稳定体貌.特征', v))),
    );
    const clothing = field('穿着习惯', textInput((profile.穿着习惯 ?? []).join('、'), '多个用顿号分隔', v => draft.setProfileField('穿着习惯', v)));

    const children = [
      $('<div>').addClass('ygg-subhead').text('基本信息'),
      basicGrid,
      $('<div>').addClass('ygg-subhead').text('稳定体貌与穿着'),
      appearanceGrid,
      clothing,
    ];

    // 初始能力（按卡声明维度自动生成）
    const dims = form.能力维度 ?? [];
    if (dims.length) {
      const abilityNodes = [$('<div>').addClass('ygg-subhead').text('初始能力')];
      const currentAbility = form.初始能力 ?? {};
      for (const dim of dims) {
        if (dim.类型 === '单值等级') {
          const picked = select([['', '（未设定）'], ...dim.等级序列.map(rank => [rank, rank])])
            .val(currentAbility[dim.名称] ?? '')
            .on('change', event => { draft.setInitialAbility(dim.名称, event.target.value); render(); });
          abilityNodes.push(field(dim.名称, picked));
        } else if (dim.类型 === '等级映射') {
          const currentMap = currentAbility[dim.名称] ?? {};
          const tags = $('<div>').addClass('ygg-tag-list').append(
            Object.entries(currentMap).map(([key, rank]) => $('<span>').addClass('ygg-chip').append(
              $('<span>').text(`${key}：${rank} `),
              $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
                const next = {...currentMap};
                delete next[key];
                draft.setInitialAbility(dim.名称, next);
                render();
              }),
            )),
          );
          const pickState = ui.abilityPick[dim.名称] ?? (ui.abilityPick[dim.名称] = {
            键: dim.键列表[0] ?? '', 等级: dim.等级序列[0] ?? '',
          });
          const keySelect = select(dim.键列表.map(k => [k, k])).val(pickState.键)
            .on('change', event => { pickState.键 = event.target.value; });
          const rankSelect = select(dim.等级序列.map(r => [r, r])).val(pickState.等级)
            .on('change', event => { pickState.等级 = event.target.value; });
          const addBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加').on('click', () => {
            if (!pickState.键 || !pickState.等级) return;
            draft.setInitialAbility(dim.名称, {...currentMap, [pickState.键]: pickState.等级});
            render();
          });
          abilityNodes.push(field(dim.名称, $('<div>').append(
            ...(Object.keys(currentMap).length ? [tags] : []),
            $('<div>').addClass('ygg-row').append(keySelect, rankSelect, addBtn),
          )));
        } else if (dim.类型 === '集合') {
          const currentList = Array.isArray(currentAbility[dim.名称]) ? currentAbility[dim.名称] : [];
          const tags = $('<div>').addClass('ygg-tag-list').append(
            currentList.map(item => $('<span>').addClass('ygg-chip').append(
              $('<span>').text(`${item} `),
              $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
                draft.setInitialAbility(dim.名称, currentList.filter(v => v !== item));
                render();
              }),
            )),
          );
          const pickState = ui.abilityPick[dim.名称] ?? (ui.abilityPick[dim.名称] = {
            成员: dim.成员选项?.[0]?.id ?? '',
          });
          const picker = dim.成员选项?.length
            ? select(dim.成员选项.map(item => [item.id, item.名称 === item.id ? item.id : `${item.名称}（${item.id}）`]))
              .val(pickState.成员).on('change', event => { pickState.成员 = event.target.value; })
            : $('<input>').addClass('text_pole').attr({type: 'text', placeholder: `输入${dim.名称}`})
              .val(pickState.成员).on('change', event => { pickState.成员 = event.target.value; });
          const addBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加').on('click', () => {
            const val = String(pickState.成员 ?? '').trim();
            if (!val) return;
            draft.setInitialAbility(dim.名称, [...currentList, val]);
            if (!dim.成员选项?.length) pickState.成员 = '';
            render();
          });
          abilityNodes.push(field(dim.名称, $('<div>').append(
            ...(currentList.length ? [tags] : []),
            $('<div>').addClass('ygg-row').append(picker, addBtn),
          )));
        }
      }
      const skills = form.可用技能 ?? [];
      abilityNodes.push($('<div>').addClass('ygg-hint')
        .text('当前可用技能预览：' + (skills.length ? skills.join('、') : '无')));
      children.push(...abilityNodes);
    }

    // 初始装备（有装备库时显示）
    const equipLib = form.装备库 ?? [];
    if (equipLib.length) {
      const equipList = Array.isArray(form.初始装备) ? form.初始装备 : [];
      const states = form.装备状态?.length ? form.装备状态 : ['完好'];
      if (!ui.equipPick.装备ID) ui.equipPick.装备ID = equipLib[0].id;
      if (!ui.equipPick.状态) ui.equipPick.状态 = states[0];
      const tags = $('<div>').addClass('ygg-tag-list').append(
        equipList.map(item => $('<span>').addClass('ygg-chip').append(
          $('<span>').text(`${item.装备ID}（${item.状态}，${item.位置}） `),
          $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
            draft.setInitialEquipment(equipList.filter(e => e.装备ID !== item.装备ID));
            render();
          }),
        )),
      );
      const idSelect = select(equipLib.map(e => [e.id, e.名称 === e.id ? e.id : `${e.名称}（${e.id}）`]))
        .val(ui.equipPick.装备ID).on('change', event => { ui.equipPick.装备ID = event.target.value; });
      const stateSelect = select(states.map(s => [s, s]))
        .val(ui.equipPick.状态).on('change', event => { ui.equipPick.状态 = event.target.value; });
      const posInput = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '位置（如：随身）'})
        .val(ui.equipPick.位置).on('change', event => { ui.equipPick.位置 = event.target.value; });
      const addEquipBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加').on('click', () => {
        if (!ui.equipPick.装备ID || !ui.equipPick.状态 || !String(ui.equipPick.位置 ?? '').trim()) return;
        const rest = equipList.filter(e => e.装备ID !== ui.equipPick.装备ID);
        draft.setInitialEquipment([...rest, {
          装备ID: ui.equipPick.装备ID,
          状态: ui.equipPick.状态,
          位置: String(ui.equipPick.位置).trim(),
        }]);
        render();
      });
      children.push(
        $('<div>').addClass('ygg-subhead').text('初始装备'),
        field('装备列表', $('<div>').append(
          ...(equipList.length ? [tags] : []),
          $('<div>').addClass('ygg-row').append(idSelect, stateSelect, posInput, addEquipBtn),
        )),
      );
    }

    // 折叠区：高级 YAML 源码（保留 textarea 供高阶编辑与兼容既有测试）
    const profileTextarea = $('<textarea>').addClass('text_pole').attr('rows', 6).val(snapshot.档案文本)
      .on('change', event => { draft.setProfileText(event.target.value); render(); });
    const yamlSec = $('<details>').addClass('ygg-sec').prop('open', ui.yamlOpen)
      .on('toggle', event => { ui.yamlOpen = Boolean(event?.target?.open); })
      .append(
        $('<summary>').text('高级：YAML 源码'),
        $('<div>').addClass('ygg-body').append(
          field('自建档案（YAML 映射）', profileTextarea, '字段与取值由协议校验；可留空为 {}。'),
        ),
      );
    children.push(yamlSec);
    return children;
  }

  function render() {
    const snapshot = draft.snapshot(), preview = snapshot.预览;
    root.empty().append($('<h3>').text('世界树：选择开局'));
    root.append(hint('改动即预演；预演不写聊天变量、不执行开场命令，也不调用叙事或记账模型。取消后可从“世界树：开局”重新打开。'));
    if (snapshot.错误) root.append($('<div>').addClass('ygg-opening-error')
      .text(`尚未开局：${snapshot.错误.code}\n${snapshot.错误.说明}`));

    // 1. 世界线（仅多世界线卡显示）
    if (snapshot.世界线列表?.length) {
      const currentWl = snapshot.世界线列表.find(item => item.id === snapshot.世界线);
      const wlSelect = select(snapshot.世界线列表.map(item => [item.id, `${item.id}${item.默认 ? '（默认）' : ''}`]))
        .val(snapshot.世界线 ?? '')
        .on('change', event => { draft.setWorldline(event.target.value); render(); });
      root.append(section('世界线', true,
        field('选择世界线', wlSelect, currentWl?.概述 || '切换世界线将联动筛选预设开局与历史节点。')));
    }

    // 2. 预设开局
    const plans = select([
      ['', '无预设（自由开局）'],
      ...snapshot.计划.map(plan => [plan.id, `${plan.id}${plan.概述 ? `：${plan.概述}` : ''}`]),
    ]).val(snapshot.方案 ?? '').on('change', event => { draft.setPlan(event.target.value); render(); });
    const chosenPlan = snapshot.计划.find(plan => plan.id === snapshot.方案);
    root.append(section('预设开局', true,
      field('开局方案', plans, chosenPlan?.概述 || '无预设时按当前世界线、时间、地点与主角自由开局。')));

    // 3. 开局时间与地点
    const timeInput = $('<input>').addClass('text_pole').attr('type', 'text').val(snapshot.时间)
      .on('change', event => { draft.setTime(event.target.value); render(); });
    const timeLocChildren = [field('开局时间', timeInput, `卡纪年格式：${snapshot.时间格式}`)];
    if (snapshot.地点列表?.length) {
      const locSelect = select(snapshot.地点列表.map(item => [item.id, item.标签]))
        .val(snapshot.地点 ?? '')
        .on('change', event => { draft.setLocation(event.target.value); render(); });
      const locHint = snapshot.玩家?.模式 === '扮演'
        ? `默认按角色当前所在推算（${snapshot.默认地点 || '无'}），可改选。`
        : '选择初始地点。';
      timeLocChildren.push(field('开局地点', locSelect, locHint));
    }
    root.append(section('开局时间与地点', true, ...timeLocChildren));

    // 4. 玩家
    const player = snapshot.玩家;
    const modeSelect = select([['自建', '自建玩家'], ['扮演', '扮演角色组']])
      .val(player.模式).on('change', event => { draft.setPlayerMode(event.target.value); render(); });
    const enabledGroups = snapshot.角色组.filter(group => group.启用).map(group => [group.id, group.显示名]);
    const roleGroupSelect = select(enabledGroups).val(player.扮演角色组 ?? '')
      .on('change', event => { draft.setPlayerGroup(event.target.value); render(); });
    root.append(section('玩家', true,
      field('玩家模式', modeSelect),
      ...(player.模式 === '扮演'
        ? [field('扮演角色组', roleGroupSelect, '只列出当前已启用的角色组；切换角色会联动推算默认开局地点。')]
        : renderSelfBuiltForm(snapshot))));

    // 5. 开场白（四模式）
    const greetingOptions = [
      ...(snapshot.可用预设开场白 ? [['预设', '预设精修']] : []),
      ['自动生成', 'AI 自动生成'],
      ['提示扩写', '提示扩写'],
      ['手写', '玩家手写'],
    ];
    const greetingModeSelect = select(greetingOptions).val(snapshot.开场白模式)
      .on('change', event => { draft.setGreetingMode(event.target.value); render(); });
    const greetingChildren = [field('开场白模式', greetingModeSelect)];
    if (snapshot.预设偏离提示) {
      const switchBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('切换为 AI 自动生成')
        .on('click', () => { draft.setGreetingMode('自动生成'); render(); });
      greetingChildren.push($('<div>').addClass('ygg-opening-warn').append(
        $('<div>').addClass('ygg-line').text(snapshot.预设偏离提示),
        switchBtn,
      ));
    }
    if (snapshot.开场白模式 === '预设') {
      const greeting = snapshot.开场白 ?? '';
      greetingChildren.push(
        $('<div>').addClass('ygg-line ygg-opening-greeting').text(greeting || '（当前方案没有开场白）'),
        ...(greeting && greeting !== (snapshot.主开场白 ?? '')
          ? [hint('确认开局后将同步第 0 楼开场白；写入失败会恢复原正文。')]
          : [hint('确认开局后使用这段正文作为第 0 楼开场白。')]),
      );
    } else if (snapshot.开场白模式 === '自动生成') {
      greetingChildren.push(hint('确认开局后将按当前世界线、时间、地点与主角调用当前叙事模型生成第 0 楼开场白并记账落盘。'));
    } else if (snapshot.开场白模式 === '提示扩写') {
      const hintInput = $('<input>').addClass('text_pole').attr({
        type: 'text',
        placeholder: '输入一句开场提示（例如：暴雨夜独自守塔，忽闻远方钟声）',
      }).val(snapshot.开场提示 ?? '').on('change', event => { draft.setGreetingHint(event.target.value); render(); });
      greetingChildren.push(field('开场提示', hintInput, '确认开局后由叙事模型结合当前上下文扩写并记账。'));
    } else if (snapshot.开场白模式 === '手写') {
      const customArea = $('<textarea>').addClass('text_pole').attr({
        rows: 5,
        placeholder: '直接填写第 0 楼开场白正文…',
      }).val(snapshot.手写开场白 ?? '').on('change', event => { draft.setCustomGreeting(event.target.value); render(); });
      greetingChildren.push(field('手写开场白正文', customArea, '确认开局后写入第 0 楼并执行一次记账落盘。'));
    }
    root.append(section('开场白', true, ...greetingChildren));

    // 6. 高级选项（默认折叠）：角色组开关与版本 + 历史选择
    const categories = [...new Set(snapshot.角色组.flatMap(g => [g.分类, g.角色包].filter(Boolean)))];
    const searchInput = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '按名称或 ID 过滤角色组…'})
      .val(ui.groupSearch).on('input', event => { ui.groupSearch = event.target.value; render(); })
      .on('change', event => { ui.groupSearch = event.target.value; render(); });
    const filterSelect = select([['', '全部分类/角色包'], ...categories.map(c => [c, c])])
      .val(ui.groupFilter).on('change', event => { ui.groupFilter = event.target.value; render(); });
    const keyword = ui.groupSearch.trim().toLowerCase();
    const filteredGroups = snapshot.角色组.filter(group => {
      if (ui.groupFilter && group.分类 !== ui.groupFilter && group.角色包 !== ui.groupFilter) return false;
      if (keyword && !`${group.id} ${group.显示名} ${group.分类} ${group.角色包}`.toLowerCase().includes(keyword)) return false;
      return true;
    });
    const groupNodes = filteredGroups.map(group => {
      const version = select(group.版本.map(id => {
        const declared = group.版本内容.find(item => item.版本ID === id) ?? {};
        return [id, `${declared.显示名 ?? id}${declared.简介 ? `：${declared.简介}` : ''}`];
      })).val(group.版本ID)
        .on('change', event => { draft.setGroup(group.id, {版本ID: event.target.value}); render(); });
      const enabled = $('<input>').attr('type', 'checkbox').prop('checked', group.启用 === true)
        .on('change', event => { draft.setGroup(group.id, {启用: event.target.checked}); render(); });
      const tags = $('<span>').addClass('ygg-group-tags').append(
        $('<span>').addClass('ygg-tag').text(group.启用 ? '启用' : '停用'),
        ...(group.必选 ? [$('<span>').addClass('ygg-tag ygg-required').text('必选')] : []));
      return $('<div>').addClass('ygg-group-row').append(
        $('<label>').addClass('ygg-check').append(enabled, $('<span>').text(`${group.显示名}${group.分类 ? `（${group.分类}）` : ''}`)),
        version, tags,
        ...(group.必选 && group.依赖原因?.length
          ? [$('<div>').addClass('ygg-required-reason').text('依赖：' + group.依赖原因.join('；'))] : []));
    });

    const historyNodes = snapshot.历史.length
      ? [
        hint(snapshot.自由组合
          ? '自由组合已开启：仅展示当前开局时间之前且前置成立的节点与合法分支，留空按方案或协议默认求解。'
          : '自由组合已关闭：历史选择由所选方案派生。'),
        ...snapshot.历史.map(item => {
          if (!snapshot.自由组合) return $('<div>').addClass('ygg-line')
            .text(`${item.问题}：${item.值 || '由方案与历史求解决定'}`);
          const choices = select([['', '按方案/默认'], ...item.分支.map(branch => [branch.id, `${branch.id}：${branch.label}`])])
            .val(item.值).on('change', event => { draft.setHistory(item.事件ID, event.target.value); render(); });
          return field(item.问题, choices);
        }),
      ]
      : [hint('当前开局时间之前没有可调整的历史节点。')];

    const advancedSec = $('<details>').addClass('ygg-sec ygg-advanced').prop('open', ui.advancedOpen)
      .on('toggle', event => { ui.advancedOpen = Boolean(event?.target?.open); })
      .append(
        $('<summary>').text('高级选项（角色组与历史选择）'),
        $('<div>').addClass('ygg-body').append(
          $('<div>').addClass('ygg-subhead').text('角色组开关与版本'),
          ...(snapshot.角色组.length ? [$('<div>').addClass('ygg-row').append(searchInput, ...(categories.length ? [filterSelect] : []))] : []),
          ...(groupNodes.length ? groupNodes : [hint(snapshot.角色组.length ? '没有匹配筛选条件的角色组。' : '这张卡没有声明角色组。')]),
          $('<div>').addClass('ygg-subhead').text('历史选择'),
          ...historyNodes,
        ),
      );
    root.append(advancedSec);

    // 7. 有效预览摘要
    const previewNode = $('<div>').addClass('ygg-opening-preview');
    if (!preview) previewNode.append(hint('当前没有可用的封卷预览。'));
    else {
      const opening = preview.开局, enabled = Object.entries(opening.角色组 ?? {}).filter(([, value]) => value.启用);
      const groupText = enabled.length ? enabled.map(([id, value]) =>
        `${snapshot.角色组.find(group => group.id === id)?.显示名 ?? id}(${value.版本ID})`).join('、') : '无';
      previewNode.append(
        $('<div>').addClass('ygg-line').text(`有效预览：${opening.开局时间}${opening.方案 ? ` · 方案 ${opening.方案}` : ''}`),
        ...(opening.世界线 ? [$('<div>').addClass('ygg-line').text(`世界线：${opening.世界线}`)] : []),
        ...(snapshot.地点 ? [$('<div>').addClass('ygg-line').text(`开局地点：${snapshot.地点}`)] : []),
        $('<div>').addClass('ygg-line').text(`角色组（已启用 ${enabled.length} / ${snapshot.角色组.length}）：${groupText}`),
        $('<div>').addClass('ygg-line').text('玩家：' + (opening.玩家?.模式 === '扮演'
          ? `扮演 ${opening.玩家.扮演角色组}` : `自建 ${opening.玩家?.档案?.姓名 ?? '未命名'}`)),
        $('<div>').addClass('ygg-line').text('历史选择：' + (Object.keys(opening.历史选择 ?? {}).length
          ? Object.entries(opening.历史选择).map(([event, branch]) => `${event}=${branch}`).join('、') : '无')),
      );
    }
    root.append(previewNode);
    return root;
  }

  return render();
}
