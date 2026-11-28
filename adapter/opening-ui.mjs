// 开局前端界面：世界线 → 预设开局 → 开局时间与地点 → 玩家（含自建结构化引导表单）→ 四模式开场白 → 默认折叠的高级选项（角色组 + 历史选择）→ 有效预览摘要。
// 所有改动立即交给 opening.mjs 重新预演；失败只在顶部显示错误，上一份有效预览仍留在下方。
// DOM 与事件止于此，封卷、命令和写入仍由 runtime 完成。

export function openingNode(draft, {storage = null, initialNotice = ''} = {}) {
  const root = $('<div>').addClass('ygg-panel ygg-form ygg-opening');
  const ui = {
    groupSearch: '',
    groupFilter: '',
    advancedOpen: false,
    yamlOpen: false,
    abilityPick: {},
    skillPick: '',
    customSkillDraft: {名称: '', 说明: '', 限制: ''},
    customSkillHint: '',
    equipPick: {装备ID: '', 状态: '', 位置: '随身'},
    customEquipDraft: {名称: '', 说明: '', 状态: '', 位置: '随身'},
    customEquipHint: '',
    ageError: '',
    selectedPreset: '',
    presetName: '',
    presetNotice: initialNotice || '',
  };

  const hint = text => $('<div>').addClass('ygg-hint').text(text);
  const subcard = (...children) => $('<div>').addClass('ygg-subcard').append(children);
  const field = (label, control, note, {required = false} = {}) => {
    const labelNode = $('<label>').text(label);
    if (required) labelNode.append($('<span>').addClass('ygg-req').attr('aria-hidden', 'true').text('*'));
    return $('<div>').addClass('ygg-field').append(labelNode, control, ...(note ? [hint(note)] : []));
  };
  const select = options => $('<select>').addClass('text_pole').append(options.map(([value, label]) => $('<option>').val(value).text(label)));
  // 步骤编号与折叠头实时摘要通过 data-* 属性 + CSS ::before 渲染，既在浏览器清晰展示，又保持 <summary>.text() 与既有单测精确一致。
  const makeSummary = (title, {step = null, summary = ''} = {}) => $('<summary>').append(
    ...(step !== null ? [$('<span>').addClass('ygg-step-num').attr('data-step', String(step)).attr('aria-hidden', 'true')] : []),
    $('<span>').addClass('ygg-sec-title').text(title),
    ...(summary ? [$('<span>').addClass('ygg-sec-summary').attr('data-summary', summary).attr('title', summary)] : []),
  );
  const section = (title, open, meta, ...children) => $('<details>').addClass('ygg-sec').prop('open', open)
    .append(makeSummary(title, meta), $('<div>').addClass('ygg-body').append(children));

  function renderAbilityBlock({title, dims, currentAbility, onChange}) {
    if (!dims?.length) return [];
    const abilityNodes = [$('<div>').addClass('ygg-subhead').text(title)];
    const ability = currentAbility ?? {};
    for (const dim of dims) {
      if (dim.类型 === '单值等级') {
        const picked = select([['', '（未设定）'], ...dim.等级序列.map(rank => [rank, rank])])
          .val(ability[dim.名称] ?? '')
          .on('change', event => { onChange(dim.名称, event.target.value); render(); });
        abilityNodes.push(field(dim.名称, picked));
      } else if (dim.类型 === '等级映射') {
        const currentMap = ability[dim.名称] ?? {};
        const tags = $('<div>').addClass('ygg-tag-list').append(
          Object.entries(currentMap).map(([key, rank]) => $('<span>').addClass('ygg-chip').append(
            $('<span>').text(`${key}：${rank} `),
            $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
              const next = {...currentMap};
              delete next[key];
              onChange(dim.名称, next);
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
          onChange(dim.名称, {...currentMap, [pickState.键]: pickState.等级});
          render();
        });
        abilityNodes.push(field(dim.名称, $('<div>').append(
          ...(Object.keys(currentMap).length ? [tags] : []),
          $('<div>').addClass('ygg-row').append(keySelect, rankSelect, addBtn),
        )));
      } else if (dim.类型 === '集合') {
        const currentList = Array.isArray(ability[dim.名称]) ? ability[dim.名称] : [];
        const tags = $('<div>').addClass('ygg-tag-list').append(
          currentList.map(item => $('<span>').addClass('ygg-chip').append(
            $('<span>').text(`${item} `),
            $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
              onChange(dim.名称, currentList.filter(v => v !== item));
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
          onChange(dim.名称, [...currentList, val]);
          if (!dim.成员选项?.length) pickState.成员 = '';
          render();
        });
        abilityNodes.push(field(dim.名称, $('<div>').append(
          ...(currentList.length ? [tags] : []),
          $('<div>').addClass('ygg-row').append(picker, addBtn),
        )));
      }
    }
    return [subcard(...abilityNodes)];
  }

  function renderSkillBlock({skills = [], skillLib = [], customSkills = []}) {
    const nodes = [$('<div>').addClass('ygg-subhead').text('技能')];
    if (skillLib.length) {
      if (!ui.skillPick || !skillLib.some(s => s.id === ui.skillPick)) ui.skillPick = skillLib[0].id;
      const skillTags = $('<div>').addClass('ygg-tag-list').append(
        skills.map(id => $('<span>').addClass('ygg-chip').append(
          $('<span>').text(`${id} `),
          $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
            draft.removeSkill(id);
            render();
          }),
        )),
      );
      const skillSelect = select(skillLib.map(s => [s.id, s.名称 === s.id ? s.id : `${s.名称}（${s.id}）`]))
        .val(ui.skillPick).on('change', event => { ui.skillPick = event.target.value; });
      const addSkillBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加技能').on('click', () => {
        if (!ui.skillPick) return;
        draft.addSkill(ui.skillPick);
        render();
      });
      nodes.push(field('可用世界书技能', $('<div>').append(
        ...(skills.length ? [skillTags] : [hint('当前无可用世界书技能')]),
        $('<div>').addClass('ygg-row').append(skillSelect, addSkillBtn),
      )));
    }
    const customTags = $('<div>').addClass('ygg-tag-list').append(
      customSkills.map((item, idx) => $('<span>').addClass('ygg-chip').append(
        $('<span>').text(`${item.名称}：${item.说明}${item.限制 ? `（限制：${item.限制}）` : ''} `),
        $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
          draft.setCustomSkills(customSkills.filter((_, i) => i !== idx));
          render();
        }),
      )),
    );
    const nameIn = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '自定义技能名称'})
      .val(ui.customSkillDraft.名称).on('change', event => { ui.customSkillDraft.名称 = event.target.value; });
    const descIn = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '说明（必填）'})
      .val(ui.customSkillDraft.说明).on('change', event => { ui.customSkillDraft.说明 = event.target.value; });
    const limitIn = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '限制（可选）'})
      .val(ui.customSkillDraft.限制).on('change', event => { ui.customSkillDraft.限制 = event.target.value; });
    const addCustomSkillBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加自定义技能').on('click', () => {
      const name = String(ui.customSkillDraft.名称 ?? '').trim();
      const desc = String(ui.customSkillDraft.说明 ?? '').trim();
      const limit = String(ui.customSkillDraft.限制 ?? '').trim();
      const missing = [];
      if (!name) missing.push('技能名称');
      if (!desc) missing.push('说明');
      if (missing.length) {
        ui.customSkillHint = `请填写自定义技能的${missing.join('和')}后再添加（未添加不影响开局提交）。`;
        render();
        return;
      }
      ui.customSkillHint = '';
      const nextItem = {名称: name, 说明: desc, ...(limit ? {限制: limit} : {})};
      draft.setCustomSkills([...customSkills, nextItem]);
      ui.customSkillDraft = {名称: '', 说明: '', 限制: ''};
      render();
    });
    nodes.push(field('自定义技能', $('<div>').append(
      ...(customSkills.length ? [customTags] : []),
      $('<div>').addClass('ygg-row').append(nameIn, descIn, limitIn, addCustomSkillBtn),
      ...(ui.customSkillHint ? [hint(ui.customSkillHint)] : []),
    )));
    return [subcard(...nodes)];
  }

  function formatEquipOption(entry, mode, roleGroup) {
    if (!entry.唯一) return entry.名称 === entry.id ? entry.id : `${entry.名称}（${entry.id}）`;
    const otherOwners = (entry.原主 ?? []).filter(o => mode !== '扮演' || o.id !== roleGroup);
    if (!otherOwners.length) return `${entry.名称}（唯一）`;
    return `${entry.名称}（唯一 · 原主：${otherOwners.map(o => o.显示名).join('、')}）`;
  }

  function renderEquipmentBlock({title, mode, roleGroup, equipItems = [], equipLib = [], equipStates = [],
    customEquipments = [], onAddWorldEquip, onRemoveWorldEquip}) {
    const nodes = [$('<div>').addClass('ygg-subhead').text(title)];
    const states = equipStates.length ? equipStates : ['完好'];
    const equipById = new Map(equipLib.map(e => [e.id, e]));
    if (equipLib.length) {
      if (!ui.equipPick.装备ID || !equipById.has(ui.equipPick.装备ID)) ui.equipPick.装备ID = equipLib[0].id;
      if (!ui.equipPick.状态 || !states.includes(ui.equipPick.状态)) ui.equipPick.状态 = states[0];
      const tags = $('<div>').addClass('ygg-tag-list').append(
        equipItems.map(item => {
          const meta = equipById.get(item.装备ID);
          const uniqueTag = meta?.唯一 ? ' · 唯一' : '';
          return $('<span>').addClass('ygg-chip').append(
            $('<span>').text(`${item.装备ID}（${item.状态}，${item.位置}${uniqueTag}） `),
            $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
              onRemoveWorldEquip(item.装备ID);
              render();
            }),
          );
        }),
      );
      const idSelect = select(equipLib.map(e => [e.id, formatEquipOption(e, mode, roleGroup)]))
        .val(ui.equipPick.装备ID).on('change', event => { ui.equipPick.装备ID = event.target.value; render(); });
      const stateSelect = select(states.map(s => [s, s]))
        .val(ui.equipPick.状态).on('change', event => { ui.equipPick.状态 = event.target.value; });
      const posInput = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '位置（如：随身）'})
        .val(ui.equipPick.位置).on('change', event => { ui.equipPick.位置 = event.target.value; });
      const addEquipBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加').on('click', () => {
        if (!ui.equipPick.装备ID || !ui.equipPick.状态 || !String(ui.equipPick.位置 ?? '').trim()) return;
        onAddWorldEquip({
          装备ID: ui.equipPick.装备ID,
          状态: ui.equipPick.状态,
          位置: String(ui.equipPick.位置).trim(),
        });
        render();
      });
      const pickedMeta = equipById.get(ui.equipPick.装备ID);
      const pickedOtherOwners = pickedMeta?.唯一
        ? (pickedMeta.原主 ?? []).filter(o => mode !== '扮演' || o.id !== roleGroup)
        : [];
      nodes.push(field('装备列表', $('<div>').append(
        ...(equipItems.length ? [tags] : []),
        $('<div>').addClass('ygg-row').append(idSelect, stateSelect, posInput, addEquipBtn),
        ...(pickedOtherOwners.length
          ? [$('<div>').addClass('ygg-unique-hint').text('唯一装备：开局后将由你持有，原主不再持有')]
          : []),
      )));
    }

    if (!ui.customEquipDraft.状态 || !states.includes(ui.customEquipDraft.状态)) ui.customEquipDraft.状态 = states[0];
    const customTags = $('<div>').addClass('ygg-tag-list').append(
      customEquipments.map((item, idx) => $('<span>').addClass('ygg-chip').append(
        $('<span>').text(`${item.名称}（${item.状态}，${item.位置}）：${item.说明} `),
        $('<button>').attr('type', 'button').addClass('ygg-chip-del').text('×').on('click', () => {
          draft.setCustomEquipment(customEquipments.filter((_, i) => i !== idx));
          render();
        }),
      )),
    );
    const ceName = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '自定义装备名称'})
      .val(ui.customEquipDraft.名称).on('change', event => { ui.customEquipDraft.名称 = event.target.value; });
    const ceDesc = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '说明（必填）'})
      .val(ui.customEquipDraft.说明).on('change', event => { ui.customEquipDraft.说明 = event.target.value; });
    const ceState = select(states.map(s => [s, s])).val(ui.customEquipDraft.状态)
      .on('change', event => { ui.customEquipDraft.状态 = event.target.value; });
    const cePos = $('<input>').addClass('text_pole').attr({type: 'text', placeholder: '位置（如：随身）'})
      .val(ui.customEquipDraft.位置).on('change', event => { ui.customEquipDraft.位置 = event.target.value; });
    const addCustomEquipBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('添加自定义装备').on('click', () => {
      const name = String(ui.customEquipDraft.名称 ?? '').trim();
      const desc = String(ui.customEquipDraft.说明 ?? '').trim();
      const pos = String(ui.customEquipDraft.位置 ?? '').trim();
      const st = ui.customEquipDraft.状态 || states[0];
      const missing = [];
      if (!name) missing.push('装备名称');
      if (!desc) missing.push('说明');
      if (!pos) missing.push('位置');
      if (missing.length) {
        ui.customEquipHint = `请填写自定义装备的${missing.join('、')}后再添加（未添加不影响开局提交）。`;
        render();
        return;
      }
      ui.customEquipHint = '';
      draft.setCustomEquipment([...customEquipments, {名称: name, 说明: desc, 状态: st, 位置: pos}]);
      ui.customEquipDraft = {名称: '', 说明: '', 状态: states[0], 位置: '随身'};
      render();
    });
    nodes.push(field('自定义装备', $('<div>').append(
      ...(customEquipments.length ? [customTags] : []),
      $('<div>').addClass('ygg-row').append(ceName, ceDesc, ceState, cePos, addCustomEquipBtn),
      ...(ui.customEquipHint ? [hint(ui.customEquipHint)] : []),
    )));
    return [subcard(...nodes)];
  }

  function renderSelfBuiltForm(snapshot) {
    const isPlainMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const form = isPlainMap(snapshot.自建表单) ? snapshot.自建表单 : {};
    const profile = isPlainMap(form.档案) ? form.档案 : {};
    const appearance = isPlainMap(profile.稳定体貌) ? profile.稳定体貌 : {};
    const cal = isPlainMap(form.纪年) ? form.纪年 : {};
    const asText = value => typeof value === 'string' ? value : '';
    const asListText = value => Array.isArray(value)
      ? value.filter(item => typeof item === 'string' || typeof item === 'number').join('、')
      : '';
    const textInput = (value, placeholder, onChange) => $('<input>').addClass('text_pole').attr({type: 'text', placeholder})
      .val(asText(value)).on('change', event => { onChange(event.target.value); render(); });

    // 开局年龄与出生年双向换算提示（支持纪元前年份）
    const digits = Number(cal.年位数) || 3;
    const formatYear = value => {
      if (typeof draft.formatYear === 'function') return draft.formatYear(value);
      if (!Number.isSafeInteger(value) || !cal.前缀) return null;
      const abs = Math.abs(value);
      if (String(abs).length > digits) return null;
      return `${cal.前缀}${value < 0 ? '前' : ''}${String(abs).padStart(digits, '0')}年`;
    };
    let birthYear = Number.isSafeInteger(cal.出生年数值) ? cal.出生年数值 : null;
    if (birthYear === null && typeof profile.出生年 === 'string' && profile.出生年) {
      if (typeof draft.parseYear === 'function') birthYear = draft.parseYear(profile.出生年);
      else if (cal.前缀) {
        const match = profile.出生年.match(new RegExp(`^${cal.前缀.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(前)?(\\d{${digits}})年`));
        if (match) {
          const rawY = Number(match[2]);
          if (!(match[1] && rawY === 0)) birthYear = match[1] ? -rawY : rawY;
        }
      }
    }
    const currentYear = Number.isSafeInteger(cal.当前年) ? cal.当前年 : null;
    const ageNow = currentYear !== null && birthYear !== null ? currentYear - birthYear : null;
    const ageInput = $('<input>').addClass('text_pole').attr({type: 'number', min: 0, placeholder: '按年龄换算'})
      .val(ageNow !== null && ageNow >= 0 ? String(ageNow) : '')
      .on('change', event => {
        const raw = String(event.target.value ?? '').trim();
        if (!raw) {
          ui.ageError = '';
          draft.setProfileField('出生年', '');
          render();
          return;
        }
        if (currentYear === null) {
          ui.ageError = '当前开局时间无效，无法按年龄换算出生年。';
          render();
          return;
        }
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          ui.ageError = '年龄须为非负整数（如 0、18、20），未修改当前出生年。';
          render();
          return;
        }
        const years = Number(raw);
        const targetYear = currentYear - years;
        const formatted = formatYear(targetYear);
        if (!formatted) {
          const maxAbs = 10 ** digits - 1;
          const maxAge = currentYear + maxAbs;
          ui.ageError = `换算结果超出 ${digits} 位纪年上限（最早仅支持 ${cal.前缀}前${String(maxAbs).padStart(digits, '0')}年，当前最大可换算年龄为 ${maxAge} 岁），未修改当前出生年。`;
          render();
          return;
        }
        ui.ageError = '';
        draft.setProfileField('出生年', formatted);
        render();
      });
    const birthNote = ui.ageError
      ? ui.ageError
      : ageNow !== null
        ? (ageNow >= 0
          ? `当前约 ${ageNow} 岁；可填出生年或直接输年龄自动换算。`
          : `出生年晚于当前开局时间（相差 ${-ageNow} 年），年龄框已留空；可调整出生年或开局时间。`)
        : `格式：${cal.格式 || snapshot.时间格式}`;

    const basicGrid = $('<div>').addClass('ygg-opening-grid').append(
      field('姓名', textInput(asText(profile.姓名), '主角姓名', v => draft.setProfileField('姓名', v))),
      field('性别', textInput(asText(profile.性别), '如：男 / 女', v => draft.setProfileField('性别', v))),
      field('种族', textInput(asText(profile.种族), '如：人族', v => draft.setProfileField('种族', v))),
      field('出身', textInput(asText(profile.出身), '简述出身背景', v => draft.setProfileField('出身', v))),
      field('出生年', $('<div>').addClass('ygg-row').append(
        textInput(asText(profile.出生年), cal.格式 || '纪年', v => { ui.ageError = ''; draft.setProfileField('出生年', v); }),
        ...(currentYear !== null ? [ageInput] : []),
      ), birthNote),
      field('称号', textInput(asListText(profile.称号), '多个用顿号分隔', v => draft.setProfileField('称号', v))),
    );

    const appearanceGrid = $('<div>').addClass('ygg-opening-grid').append(
      field('发色发型', textInput(asText(appearance.发色发型), '如：黑发短发', v => draft.setProfileField('稳定体貌.发色发型', v))),
      field('瞳色', textInput(asText(appearance.瞳色), '如：深褐', v => draft.setProfileField('稳定体貌.瞳色', v))),
      field('体型', textInput(asText(appearance.体型), '如：匀称', v => draft.setProfileField('稳定体貌.体型', v))),
      field('体貌特征', textInput(asListText(appearance.特征), '短语，顿号分隔', v => draft.setProfileField('稳定体貌.特征', v))),
    );
    const clothing = field('穿着习惯', textInput(asListText(profile.穿着习惯), '多个用顿号分隔', v => draft.setProfileField('穿着习惯', v)));

    const equipList = Array.isArray(form.初始装备) ? form.初始装备 : [];
    const children = [
      hint('以下角色信息、能力、技能与装备均为选填，可按需填写或全部留空直接开局。'),
      subcard($('<div>').addClass('ygg-subhead').text('基本信息'), basicGrid),
      subcard($('<div>').addClass('ygg-subhead').text('稳定体貌与穿着'), appearanceGrid, clothing),
      ...renderAbilityBlock({
        title: '初始能力',
        dims: form.能力维度 ?? [],
        currentAbility: form.初始能力 ?? {},
        onChange: (dimName, val) => draft.setInitialAbility(dimName, val),
      }),
      ...renderSkillBlock({
        skills: form.可用技能 ?? [],
        skillLib: form.技能库 ?? [],
        customSkills: form.自定义技能 ?? [],
      }),
      ...renderEquipmentBlock({
        title: '初始装备',
        mode: '自建',
        roleGroup: null,
        equipItems: equipList,
        equipLib: form.装备库 ?? [],
        equipStates: form.装备状态 ?? [],
        customEquipments: form.自定义装备 ?? [],
        onAddWorldEquip: item => {
          const rest = equipList.filter(e => e.装备ID !== item.装备ID);
          draft.setInitialEquipment([...rest, item]);
        },
        onRemoveWorldEquip: id => {
          draft.setInitialEquipment(equipList.filter(e => e.装备ID !== id));
        },
      }),
    ];

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

  function renderRoleplayForm(snapshot) {
    const form = snapshot.扮演表单;
    if (!form) return [];
    const nodes = [];
    const baseline = form.基线;
    const bar = $('<div>').addClass('ygg-rp-bar');
    let hasBar = false;
    if (baseline?.结果 === '成立') {
      hasBar = true;
      bar.append(
        $('<span>').text(`当前时期档案：${baseline.档案ID}`),
        $('<span>').text(`默认所在：${baseline.所在 || '无'}`),
      );
    } else if (baseline?.结果) {
      hasBar = true;
      bar.append($('<span>').text(`当前时期现状：${baseline.结果}`));
    }
    if (form.已自定义项数 > 0) {
      hasBar = true;
      const resetBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('恢复当前时期默认').on('click', () => {
        draft.resetRoleplayCustomization();
        render();
      });
      bar.append($('<span>').addClass('ygg-tag').text(`已自定义 ${form.已自定义项数} 项`), resetBtn);
    }
    if (hasBar) nodes.push(bar);

    const equipLib = form.装备库 ?? [];
    const equipLibIds = new Set(equipLib.map(e => e.id));
    const worldEquipItems = Object.entries(form.有效装备 ?? {})
      .filter(([id]) => equipLibIds.has(id))
      .map(([id, item]) => ({装备ID: id, 状态: item?.状态 ?? '', 位置: item?.位置 ?? ''}));

    nodes.push(
      ...renderAbilityBlock({
        title: '当前能力（可直接调整）',
        dims: form.能力维度 ?? [],
        currentAbility: form.有效能力 ?? {},
        onChange: (dimName, val) => draft.setRoleplayAbility(dimName, val),
      }),
      ...renderSkillBlock({
        skills: form.有效可用技能 ?? [],
        skillLib: form.技能库 ?? [],
        customSkills: form.自定义技能 ?? [],
      }),
      ...renderEquipmentBlock({
        title: '当前装备（可直接增删）',
        mode: '扮演',
        roleGroup: form.扮演角色组,
        equipItems: worldEquipItems,
        equipLib,
        equipStates: form.装备状态 ?? [],
        customEquipments: form.自定义装备 ?? [],
        onAddWorldEquip: item => { draft.setRoleplayEquipment(item.装备ID, {状态: item.状态, 位置: item.位置}); },
        onRemoveWorldEquip: id => { draft.setRoleplayEquipment(id, null); },
      }),
    );
    return nodes;
  }

  function suggestPresetName(snapshot) {
    if (snapshot.玩家?.模式 === '自建') {
      const name = String(snapshot.自建表单?.档案?.姓名 ?? '').trim();
      if (name) return name;
    } else if (snapshot.玩家?.模式 === '扮演' && snapshot.玩家?.扮演角色组) {
      const group = snapshot.角色组?.find(item => item.id === snapshot.玩家.扮演角色组);
      if (group?.显示名) return group.显示名;
    }
    if (snapshot.方案) return snapshot.方案;
    return '开局设定';
  }

  function renderPresetToolbar(snapshot) {
    const bar = $('<div>').addClass('ygg-preset-bar');
    const resetBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('恢复默认').on('click', async () => {
      draft.resetDefaults?.();
      if (storage?.saveDraft) await storage.saveDraft(null);
      ui.ageError = '';
      ui.presetNotice = '已恢复初始默认设定。';
      render();
    });

    if (storage) {
      const presets = storage.listPresets?.() ?? [];
      if (presets.length) {
        if (!ui.selectedPreset || !presets.some(item => item.名称 === ui.selectedPreset)) {
          ui.selectedPreset = presets[0].名称;
        }
      } else {
        ui.selectedPreset = '';
      }
      const presetSelect = select(presets.length
        ? presets.map(item => [item.名称, item.名称])
        : [['', '（暂无已保存设定）']],
      ).val(ui.selectedPreset).on('change', event => { ui.selectedPreset = event.target.value; });
      const loadBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('载入').on('click', () => {
        const picked = presets.find(item => item.名称 === ui.selectedPreset);
        if (!picked) {
          ui.presetNotice = '请先选择一条已保存的开局设定。';
          render();
          return;
        }
        const res = draft.importPreset?.(picked.数据);
        ui.ageError = '';
        if (!res?.ok) {
          ui.presetNotice = `载入失败：${res?.error?.说明 ?? '预设格式不合法'}`;
        } else if (res.ignored?.length) {
          ui.presetNotice = `已载入设定「${picked.名称}」（已忽略 ${res.ignored.length} 项失效配置：${res.ignored.join('；')}）`;
        } else {
          ui.presetNotice = `已载入设定「${picked.名称}」。`;
        }
        render();
      });
      const deleteBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('删除').on('click', async () => {
        if (!ui.selectedPreset) {
          ui.presetNotice = '请先选择要删除的开局设定。';
          render();
          return;
        }
        const res = await storage.deletePreset(ui.selectedPreset);
        if (res?.ok) {
          ui.presetNotice = `已删除设定「${res.名称}」。`;
          ui.selectedPreset = '';
        } else {
          ui.presetNotice = `删除失败：${res?.error ?? '未知错误'}`;
        }
        render();
      });
      const nameInput = $('<input>').addClass('text_pole').attr({
        type: 'text',
        placeholder: `输入设定名称（留空默认：${suggestPresetName(snapshot)}）`,
      }).val(ui.presetName)
        .on('input', event => { ui.presetName = event.target.value; })
        .on('change', event => { ui.presetName = event.target.value; });
      const saveBtn = $('<button>').attr('type', 'button').addClass('menu_button').text('保存当前设定').on('click', async () => {
        const name = String(ui.presetName ?? '').trim() || suggestPresetName(draft.snapshot());
        const res = await storage.savePreset(name, draft.exportPreset());
        if (res?.ok) {
          ui.selectedPreset = res.名称;
          ui.presetName = '';
          ui.presetNotice = res.覆盖 ? `已覆盖保存设定「${res.名称}」。` : `已保存设定「${res.名称}」。`;
        } else {
          ui.presetNotice = `保存失败：${res?.error ?? '未知错误'}`;
        }
        render();
      });
      bar.append(
        $('<div>').addClass('ygg-subhead').text('已保存的开局设定'),
        $('<div>').addClass('ygg-row').append(presetSelect, loadBtn, deleteBtn, resetBtn),
        $('<div>').addClass('ygg-row').append(nameInput, saveBtn),
      );
    } else {
      bar.append($('<div>').addClass('ygg-row').append(resetBtn));
    }

    if (ui.presetNotice) bar.append($('<div>').addClass('ygg-preset-notice').text(ui.presetNotice));
    return bar;
  }

  function render() {
    const snapshot = draft.snapshot(), preview = snapshot.预览;
    let step = 0;
    const nextStep = () => ++step;

    root.empty().append(
      $('<div>').addClass('ygg-panel-head').append(
        $('<div>').addClass('ygg-panel-brand').append(
          $('<span>').addClass('ygg-ico ygg-ico-spark ygg-ico-lg').attr('aria-hidden', 'true'),
          $('<h3>').text('世界树：选择开局'),
        ),
      ),
      $('<div>').addClass('ygg-hint ygg-guide-hint').text('带 * 为必填项，其余均为选填；改动即预演，预演不写聊天变量、不执行开场命令，也不调用叙事或记账模型。取消后可从“世界树：开局”重新打开。'),
    );
    if (snapshot.错误) root.append($('<div>').addClass('ygg-opening-error')
      .text(`尚未开局：${snapshot.错误.code}\n${snapshot.错误.说明}`));
    root.append(renderPresetToolbar(snapshot));

    // 1. 世界线（仅多世界线卡显示）
    if (snapshot.世界线列表?.length) {
      const currentWl = snapshot.世界线列表.find(item => item.id === snapshot.世界线);
      const wlSelect = select(snapshot.世界线列表.map(item => [item.id, `${item.id}${item.默认 ? '（默认）' : ''}`]))
        .val(snapshot.世界线 ?? '')
        .on('change', event => { ui.ageError = ''; draft.setWorldline(event.target.value); render(); });
      root.append(section('世界线', true, {step: nextStep(), summary: snapshot.世界线 || '未选择'},
        field('选择世界线', wlSelect, currentWl?.概述 || '切换世界线将联动筛选预设开局与历史节点。', {required: true})));
    }

    // 2. 预设开局
    const plans = select([
      ['', '无预设（自由开局）'],
      ...snapshot.计划.map(plan => [plan.id, `${plan.id}${plan.概述 ? `：${plan.概述}` : ''}`]),
    ]).val(snapshot.方案 ?? '').on('change', event => { ui.ageError = ''; draft.setPlan(event.target.value); render(); });
    const chosenPlan = snapshot.计划.find(plan => plan.id === snapshot.方案);
    root.append(section('预设开局', true, {step: nextStep(), summary: snapshot.方案 || '自由开局'},
      field('开局方案', plans, chosenPlan?.概述 || '无预设时按当前世界线、时间、地点与主角自由开局。')));

    // 3. 开局时间与地点
    const timeInput = $('<input>').addClass('text_pole').attr('type', 'text').val(snapshot.时间)
      .on('change', event => { ui.ageError = ''; draft.setTime(event.target.value); render(); });
    const timeField = field('开局时间', timeInput, `卡纪年格式：${snapshot.时间格式}`, {required: true});
    const timeLocSummary = [snapshot.时间, snapshot.地点].filter(Boolean).join(' · ') || '未填写';
    let timeLocContent;
    if (snapshot.地点列表?.length) {
      const locSelect = select(snapshot.地点列表.map(item => [item.id, item.标签]))
        .val(snapshot.地点 ?? '')
        .on('change', event => { draft.setLocation(event.target.value); render(); });
      const locHint = snapshot.玩家?.模式 === '扮演'
        ? `默认按角色当前所在推算（${snapshot.默认地点 || '无'}），可改选。`
        : '选择初始地点。';
      const locField = field('开局地点', locSelect, locHint, {required: true});
      timeLocContent = [$('<div>').addClass('ygg-opening-time-grid').append(timeField, locField)];
    } else {
      timeLocContent = [timeField];
    }
    root.append(section('开局时间与地点', true, {step: nextStep(), summary: timeLocSummary}, ...timeLocContent));

    // 4. 玩家
    const player = snapshot.玩家;
    const modeSelect = select([['自建', '自建玩家'], ['扮演', '扮演角色组']])
      .val(player.模式).on('change', event => { draft.setPlayerMode(event.target.value); render(); });
    const enabledGroups = snapshot.角色组.filter(group => group.启用).map(group => [group.id, group.显示名]);
    const roleGroupSelect = select(enabledGroups).val(player.扮演角色组 ?? '')
      .on('change', event => { draft.setPlayerGroup(event.target.value); render(); });
    const rpGroupName = snapshot.角色组.find(group => group.id === player.扮演角色组)?.显示名 || player.扮演角色组 || '未选择';
    const playerHeadSummary = player.模式 === '扮演'
      ? `扮演 · ${rpGroupName}`
      : `自建 · ${String(snapshot.自建表单?.档案?.姓名 ?? '').trim() || '未命名'}`;
    root.append(section('玩家', true, {step: nextStep(), summary: playerHeadSummary},
      field('玩家模式', modeSelect),
      ...(player.模式 === '扮演'
        ? [field('扮演角色组', roleGroupSelect, '只列出当前已启用的角色组；切换角色会联动推算默认开局地点。', {required: true}), ...renderRoleplayForm(snapshot)]
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
    const greetingLabel = greetingOptions.find(([v]) => v === snapshot.开场白模式)?.[1] ?? snapshot.开场白模式;
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
      greetingChildren.push(field('开场提示', hintInput, '确认开局后由叙事模型结合当前上下文扩写并记账。', {required: true}));
    } else if (snapshot.开场白模式 === '手写') {
      const customArea = $('<textarea>').addClass('text_pole').attr({
        rows: 5,
        placeholder: '直接填写第 0 楼开场白正文…',
      }).val(snapshot.手写开场白 ?? '').on('change', event => { draft.setCustomGreeting(event.target.value); render(); });
      greetingChildren.push(field('手写开场白正文', customArea, '确认开局后写入第 0 楼并执行一次记账落盘。', {required: true}));
    }
    root.append(section('开场白', true, {step: nextStep(), summary: greetingLabel}, ...greetingChildren));

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

    const enabledCount = snapshot.角色组.filter(g => g.启用).length;
    const advancedSec = $('<details>').addClass('ygg-sec ygg-advanced').prop('open', ui.advancedOpen)
      .on('toggle', event => { ui.advancedOpen = Boolean(event?.target?.open); })
      .append(
        makeSummary('高级选项（角色组与历史选择）', {step: nextStep(), summary: `已启用 ${enabledCount}/${snapshot.角色组.length} 角色组`}),
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
      const rpCustomCount = opening.玩家?.模式 === '扮演' ? (snapshot.扮演表单?.已自定义项数 ?? 0) : 0;
      const selfCustomCount = opening.玩家?.模式 === '自建'
        ? (opening.玩家?.自定义装备?.length ?? 0) + (opening.玩家?.自定义技能?.length ?? 0)
          + (opening.玩家?.额外技能?.length ?? 0) + (opening.玩家?.移除技能?.length ?? 0)
        : 0;
      const playerSummary = opening.玩家?.模式 === '扮演'
        ? `扮演 ${opening.玩家.扮演角色组}${rpCustomCount > 0 ? `（已自定义 ${rpCustomCount} 项）` : ''}`
        : `自建 ${opening.玩家?.档案?.姓名 ?? '未命名'}${selfCustomCount > 0 ? `（已自定义 ${selfCustomCount} 项）` : ''}`;
      const previewItem = (text, wide = false) => $('<div>')
        .addClass(`ygg-preview-item${wide ? ' ygg-preview-wide' : ''}`)
        .append($('<div>').addClass('ygg-line').text(text));
      previewNode.append(
        $('<div>').addClass('ygg-preview-head').append(
          $('<div>').addClass('ygg-line').text(`有效预览：${opening.开局时间}${opening.方案 ? ` · 方案 ${opening.方案}` : ''}`),
        ),
        $('<div>').addClass('ygg-preview-grid').append(
          ...(opening.世界线 ? [previewItem(`世界线：${opening.世界线}`)] : []),
          ...(snapshot.地点 ? [previewItem(`开局地点：${snapshot.地点}`)] : []),
          previewItem('玩家：' + playerSummary),
          previewItem('历史选择：' + (Object.keys(opening.历史选择 ?? {}).length
            ? Object.entries(opening.历史选择).map(([event, branch]) => `${event}=${branch}`).join('、') : '无')),
          previewItem(`角色组（已启用 ${enabled.length} / ${snapshot.角色组.length}）：${groupText}`, true),
        ),
      );
    }
    root.append(previewNode);
    return root;
  }

  return render();
}
