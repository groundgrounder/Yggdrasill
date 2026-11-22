// 页面上的画法：样式、本局面板的段落、每楼一行、设置表单。依赖酒馆页面的 jQuery（$）；数据见 view.mjs，逻辑在 runtime.mjs。
// 颜色都取酒馆主题的变量，换主题时随之变化。

const STYLE_ID = 'ygg-style';
const CSS = `
.ygg-panel { text-align: left; font-size: calc(var(--mainFontSize) * 0.92); }
.ygg-panel h3 { margin: 0 0 8px; }
.ygg-sec { border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; margin: 6px 0; background: var(--black30a); }
.ygg-sec .ygg-sec { background: transparent; margin: 6px 0 2px; }
.ygg-sec > summary { cursor: pointer; padding: 5px 10px; font-weight: bold; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; list-style: none; }
.ygg-sec > summary::-webkit-details-marker { display: none; }
.ygg-sec > summary::before, .ygg-floor > summary::before { content: '▸'; display: inline-block; color: var(--SmartThemeEmColor); transition: transform 0.15s; }
.ygg-sec[open] > summary::before, .ygg-floor[open] > summary::before { transform: rotate(90deg); }
.ygg-sec > .ygg-body { padding: 2px 10px 8px; }
.ygg-tag { font-weight: normal; font-size: 0.85em; padding: 0 6px; border-radius: 9px; border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeEmColor); }
.ygg-items { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 4px 0; }
.ygg-key { color: var(--SmartThemeEmColor); white-space: nowrap; }
.ygg-chip { display: inline-block; margin: 0 4px 3px 0; padding: 0 7px; border-radius: 4px; background: color-mix(in srgb, var(--SmartThemeBodyColor) 12%, transparent); }
.ygg-line { margin: 2px 0; }
.ygg-pre { white-space: pre-wrap; font-size: 0.85em; margin: 4px 0; max-height: 60vh; overflow: auto; }
.ygg-table { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: 0.9em; }
.ygg-table th, .ygg-table td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--SmartThemeBorderColor); vertical-align: top; }
.ygg-table th { color: var(--SmartThemeEmColor); font-weight: normal; }
.ygg-badge { display: inline-block; padding: 0 6px; border-radius: 4px; white-space: nowrap; background: var(--grey30); }
.ygg-ok { background: color-mix(in srgb, #3c9a5f 45%, transparent); }
.ygg-hot { background: color-mix(in srgb, var(--SmartThemeQuoteColor) 45%, transparent); }
.ygg-info { background: color-mix(in srgb, #3f7fbf 45%, transparent); }
.ygg-bad { background: color-mix(in srgb, #b54848 45%, transparent); }
.ygg-dim { opacity: 0.6; }
.ygg-floor { margin: 6px 0 0; font-size: 0.85em; color: var(--SmartThemeEmColor); border-left: 3px solid var(--grey30); border-radius: 4px; background: var(--black30a); }
.ygg-floor.ygg-warn { border-left-color: var(--SmartThemeQuoteColor); }
.ygg-floor.ygg-blocked { border-left-color: #b54848; border-left-width: 4px; }
.ygg-floor.ygg-upgrade { border-left-color: #3f7fbf; border-left-width: 4px; }
.ygg-floor.ygg-pending { opacity: 0.6; }
.ygg-floor > summary { cursor: pointer; list-style: none; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ygg-floor > summary::-webkit-details-marker { display: none; }
.ygg-floor > summary::before { margin-right: 6px; }
.ygg-floor .ygg-label { color: var(--SmartThemeBodyColor); margin-right: 6px; }
.ygg-floor[open] .ygg-brief { display: none; }
.ygg-floor .ygg-body { padding: 0 8px 6px 22px; }
.ygg-floor .ygg-items { gap: 2px 10px; }
.ygg-floor .ygg-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.ygg-floor .menu_button { display: inline-block; width: auto; padding: 1px 10px; margin: 4px 0 0; font-size: 1em; }
.ygg-form .ygg-field { margin: 8px 0; }
.ygg-form .ygg-field > label { display: block; margin-bottom: 3px; }
.ygg-form .ygg-hint { font-size: 0.85em; color: var(--SmartThemeEmColor); margin-top: 2px; }
.ygg-form .ygg-row { display: flex; gap: 6px; align-items: center; }
.ygg-form .ygg-row > .text_pole { flex: 1; margin: 0; }
.ygg-form .ygg-row > .menu_button { width: auto; white-space: nowrap; margin: 0; padding: 3px 10px; }
.ygg-form .ygg-check { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0; cursor: pointer; }
.ygg-form .ygg-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ygg-form .ygg-status { margin-left: 8px; font-size: 0.9em; }
.ygg-opening .ygg-opening-error { margin: 8px 0; padding: 6px 9px; border-radius: 5px; border-left: 4px solid #b54848; background: color-mix(in srgb, #b54848 16%, transparent); white-space: pre-wrap; }
.ygg-opening .ygg-opening-preview { margin: 8px 0; padding: 7px 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 5px; background: var(--black30a); }
.ygg-opening .ygg-group-row { display: grid; grid-template-columns: minmax(10em, 1fr) minmax(9em, 1fr) auto; gap: 8px; align-items: center; margin: 5px 0; }
.ygg-opening .ygg-opening-status { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ygg-opening .ygg-opening-status .menu_button { width: auto; margin: 0; }
`;

export function installStyle() {
  $(`#${STYLE_ID}`).remove();
  $('head').append($('<style>').attr('id', STYLE_ID).text(CSS));
}

const TONES = [['已确认', 'ok'], ['进行中', 'hot'], ['候选', 'hot'], ['待登记', 'info'], ['已结束', 'ok'], ['已排除', 'bad'], ['异常', 'bad'], ['不存在', 'bad']];
const badge = text => $('<span>').addClass(`ygg-badge ygg-${TONES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? 'dim'}`).text(text);
const value = item => Array.isArray(item) ? $('<span>').append(item.map(chip => $('<span>').addClass('ygg-chip').text(chip))) : $('<span>').text(item);

// 段落（view.mjs 的形状）→ 可折叠的 <details>。
export function sectionNode(item) {
  const summary = $('<summary>').append($('<span>').text(item.标题), (item.标记 ?? []).map(tag => $('<span>').addClass('ygg-tag').text(tag)));
  const body = $('<div>').addClass('ygg-body');
  for (const line of item.行 ?? []) body.append($('<div>').addClass('ygg-line').text(line));
  if (item.项?.length) body.append($('<div>').addClass('ygg-items').append(item.项.flatMap(([key, content]) => [$('<span>').addClass('ygg-key').text(key), value(content)])));
  if (item.表?.行.length) body.append($('<table>').addClass('ygg-table').append(
    $('<tr>').append(item.表.列.map(name => $('<th>').text(name))),
    item.表.行.map(row => $('<tr>').append(row.map((cell, index) => $('<td>').append(index === 0 ? badge(cell) : $('<span>').text(cell)))))));
  if (item.原文) body.append($('<pre>').addClass('ygg-pre').text(item.原文));
  for (const child of item.子段 ?? []) body.append(sectionNode(child));
  return $('<details>').addClass('ygg-sec').prop('open', item.展开 === true).append(summary, body);
}

export const panelNode = (title, sections) => $('<div>').addClass('ygg-panel').append($('<h3>').text(title), sections.map(sectionNode));
export const textNode = (title, text) => $('<div>').addClass('ygg-panel').append($('<h3>').text(title), $('<pre>').addClass('ygg-pre').text(text));

// 开局前端：所有改变立即交给 opening.mjs 重新预演；失败只在顶部显示错误，上一份有效预览仍留在下方。
// draft 为 createOpeningDraft 的返回值。DOM 与事件止于此，封卷、命令和写入仍由 runtime 完成。
export function openingNode(draft) {
  const root = $('<div>').addClass('ygg-panel ygg-form ygg-opening');
  const hint = text => $('<div>').addClass('ygg-hint').text(text);
  const field = (label, control, note) => $('<div>').addClass('ygg-field').append($('<label>').text(label), control, ...(note ? [hint(note)] : []));
  const select = options => $('<select>').addClass('text_pole').append(options.map(([value, label]) => $('<option>').val(value).text(label)));
  const section = (title, ...children) => $('<details>').addClass('ygg-sec').prop('open', true)
    .append($('<summary>').text(title), $('<div>').addClass('ygg-body').append(children));

  function render() {
    const snapshot = draft.snapshot(), preview = snapshot.预览;
    root.empty().append($('<h3>').text('世界树：选择开局'));
    root.append(hint('改动即预演；预演不写聊天变量、不执行开场命令，也不调用叙事或记账模型。取消后可从“世界树：开局”重新打开。'));
    if (snapshot.错误) root.append($('<div>').addClass('ygg-opening-error')
      .text(`尚未开局：${snapshot.错误.code}\n${snapshot.错误.说明}`));

    const plans = select([['', '不使用方案'], ...snapshot.计划.map(plan => [plan.id, `${plan.id}${plan.概述 ? `：${plan.概述}` : ''}`])])
      .val(snapshot.方案 ?? '').on('change', event => { draft.setPlan(event.target.value); render(); });
    const time = $('<input>').addClass('text_pole').attr('type', 'text').val(snapshot.时间)
      .on('change', event => { draft.setTime(event.target.value); render(); });
    const chosenPlan = snapshot.计划.find(plan => plan.id === snapshot.方案);
    root.append(section('开局方案与时间',
      field('开局方案', plans, chosenPlan?.概述 || '不选方案时使用卡面初值与协议默认值。'),
      field('开局时间', time, `卡纪年格式：${snapshot.时间格式}`)));

    const groups = snapshot.角色组.map(group => {
      const version = select(group.版本.map(id => {
        const declared = group.版本内容.find(item => item.版本ID === id) ?? {};
        return [id, `${declared.显示名 ?? id}${declared.简介 ? `：${declared.简介}` : ''}`];
      })).val(group.版本ID)
        .on('change', event => { draft.setGroup(group.id, {版本ID: event.target.value}); render(); });
      const enabled = $('<input>').attr('type', 'checkbox').prop('checked', group.启用 === true)
        .on('change', event => { draft.setGroup(group.id, {启用: event.target.checked}); render(); });
      return $('<div>').addClass('ygg-group-row').append(
        $('<label>').addClass('ygg-check').append(enabled, $('<span>').text(`${group.显示名}${group.分类 ? `（${group.分类}）` : ''}`)),
        version, $('<span>').addClass('ygg-tag').text(group.启用 ? '启用' : '停用'));
    });
    root.append(section('角色组', ...(groups.length ? groups : [hint('这张卡没有声明角色组。')])));

    const player = snapshot.玩家, mode = select([['自建', '自建玩家'], ['扮演', '扮演角色组']])
      .val(player.模式).on('change', event => { draft.setPlayerMode(event.target.value); render(); });
    const enabledGroups = snapshot.角色组.filter(group => group.启用).map(group => [group.id, group.显示名]);
    const roleGroup = select(enabledGroups).val(player.扮演角色组 ?? '')
      .on('change', event => { draft.setPlayerGroup(event.target.value); render(); });
    const profile = $('<textarea>').addClass('text_pole').attr('rows', 8).val(snapshot.档案文本)
      .on('change', event => { draft.setProfileText(event.target.value); render(); });
    root.append(section('玩家', field('玩家模式', mode),
      ...(player.模式 === '扮演' ? [field('扮演角色组', roleGroup, '只列出当前有效预览中已启用的角色组；改停该组后预演会明确失败。')]
        : [field('自建档案（YAML 映射）', profile, '字段与取值由协议校验；可留空为 {}。')])));

    if (snapshot.历史.length) {
      const rows = snapshot.历史.map(item => {
        if (!snapshot.自由组合) return $('<div>').addClass('ygg-line')
          .text(`${item.问题}：${item.值 || '由方案与历史求解决定'}`);
        const choices = select([['', '按方案/默认'], ...item.分支.map(branch => [branch.id, `${branch.id}：${branch.label}`])]).val(item.值)
          .on('change', event => { draft.setHistory(item.事件ID, event.target.value); render(); });
        return field(item.问题, choices);
      });
      root.append(section('历史选择', hint(snapshot.自由组合
        ? '自由组合已开启：只列出已声明的分支与“未发生”，留空时仍取方案或协议历史求解。'
        : '自由组合已关闭：不提供自由历史编辑，历史选择只从所选方案派生。'), ...rows));
    }

    const previewNode = $('<div>').addClass('ygg-opening-preview');
    if (!preview) previewNode.append(hint('当前没有可用的封卷预览。'));
    else {
      const opening = preview.开局, enabled = Object.entries(opening.角色组 ?? {}).filter(([, value]) => value.启用);
      const groupText = enabled.length ? enabled.map(([id, value]) =>
        `${snapshot.角色组.find(group => group.id === id)?.显示名 ?? id}(${value.版本ID})`).join('、') : '无';
      previewNode.append($('<div>').addClass('ygg-line').text(`有效预览：${opening.开局时间}${opening.方案 ? ` · 方案 ${opening.方案}` : ''}`),
        $('<div>').addClass('ygg-line').text('角色组：' + groupText),
        $('<div>').addClass('ygg-line').text('玩家：' + (opening.玩家?.模式 === '扮演'
          ? `扮演 ${opening.玩家.扮演角色组}` : `自建 ${opening.玩家?.档案?.姓名 ?? '未命名'}`)),
        $('<div>').addClass('ygg-line').text('历史选择：' + (Object.keys(opening.历史选择 ?? {}).length
          ? Object.entries(opening.历史选择).map(([event, branch]) => `${event}=${branch}`).join('、') : '无')));
    }
    root.append(previewNode);
    return root;
  }

  return render();
}

export function openingStatusNode({open, reason = '尚未开局'}) {
  const body = $('<div>').addClass('ygg-body').append(
    $('<div>').addClass('ygg-line').text('尚未开局：确认开局前不会执行开场命令、创建第 0 楼记录、注入叙事上下文或发送叙事请求。'),
    $('<div>').addClass('ygg-opening-status').append($('<span>').text(reason),
      $('<button>').attr('type', 'button').addClass('menu_button').text('打开开局').on('click', event => {
        event?.preventDefault?.(); return open();
      })));
  return $('<details>').addClass('ygg-floor ygg-pending').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').text('开局'), $('<span>').text('等待选择')), body);
}

// 每楼一行：收起时一行摘要，展开为逐项详情、调试附录与“重新记账”“修补”。line 为 view.floor 的结果；pending 时只显示“记账中”。
export function floorNode(line, {rekeep = null, repair = null, pending = false} = {}) {
  const node = $('<details>').addClass('ygg-floor');
  if (pending) return node.addClass('ygg-pending').append($('<summary>').append($('<span>').addClass('ygg-label').text('记账'), $('<span>').text('记账中…')));
  if (line.失败) node.addClass('ygg-warn');
  const body = $('<div>').addClass('ygg-body');
  if (line.详情.length) body.append($('<div>').addClass('ygg-items').append(line.详情.flatMap(([key, values]) => [$('<span>').addClass('ygg-key').text(key), value(values)])));
  if (line.调试) body.append($('<pre>').addClass('ygg-pre').text(line.调试));
  if (rekeep || repair) {
    const actions = $('<div>').addClass('ygg-actions');
    if (rekeep) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('重新记账').on('click', event => { event?.preventDefault?.(); return rekeep(); }));
    if (repair) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('修补').on('click', event => { event?.preventDefault?.(); return repair(); }));
    body.append(actions);
  }
  return node.append($('<summary>').append($('<span>').addClass('ygg-label').text('记账'), $('<span>').addClass('ygg-brief').text(line.摘要)), body);
}

// 每楼修补弹窗：展示已记摘要、失败列表与修补说明输入框；报错原地保留用户输入以便调整重试。
export function repairNode({id, line, record, commandsText}) {
  const state = {instruction: '', touched: false};
  const root = $('<div>').addClass('ygg-panel ygg-form ygg-opening');
  const errorBox = $('<div>').addClass('ygg-opening-error').text('').hide();
  const failures = record?.失败 ?? [];
  const failureItems = failures.length
    ? failures.map(item => $('<div>').addClass('ygg-line').text(`${item.阶段}/${item.错误码}${item.序号 ? `·第 ${item.序号} 条` : ''}：${item.说明}`))
    : [$('<div>').addClass('ygg-line').text('当前无失败项')];
  const textarea = $('<textarea>').addClass('text_pole').attr('rows', 4)
    .attr('placeholder', '留空＝仅定向修补上述失败项；或输入一句指令，例如：补记吕布与刘备、张飞相识 / 没换地点，撤回场景改动')
    .val('')
    .on('input', event => { state.touched = true; state.instruction = String(event?.target?.value ?? ''); })
    .on('change', event => { state.touched = true; state.instruction = String(event?.target?.value ?? ''); });
  root.append(
    $('<h3>').text(`世界树：修补第 ${id} 楼记账`),
    $('<div>').addClass('ygg-hint').text('留空仅修补当前失败项；填写说明时按说明在原正文基础上增补、修改或撤回变化，失败不会覆盖原记录。'),
    errorBox,
    $('<div>').addClass('ygg-opening-preview').append(
      $('<div>').addClass('ygg-line').text(`已记摘要：${line?.摘要 || '无变化'}`),
      ...(line?.详情?.length ? [$('<div>').addClass('ygg-items').append(line.详情.flatMap(([key, values]) => [$('<span>').addClass('ygg-key').text(key), value(values)]))] : []),
      $('<pre>').addClass('ygg-pre').text(commandsText || '[]'),
    ),
    $('<details>').addClass('ygg-sec').prop('open', true).append(
      $('<summary>').text('失败列表'),
      $('<div>').addClass('ygg-body').append(failureItems),
    ),
    $('<div>').addClass('ygg-field').append($('<label>').text('修补说明（可选）'), textarea),
  );
  return {
    node: root,
    getInstruction: () => state.touched ? state.instruction : String(textarea.val() ?? ''),
    setError: message => { if (!message) errorBox.text('').hide(); else errorBox.text(String(message)).show(); },
  };
}
// 存档校验失败时只显示原因与只读边界；不显示记录原文、命令或任何可编辑入口。
export function readOnlyNode(title, text) {
  const body = $('<div>').addClass('ygg-body').append(text.split('\n').map(line => $('<div>').addClass('ygg-line').text(line)));
  return $('<details>').addClass('ygg-floor ygg-warn ygg-blocked').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').text('只读'), $('<span>').text(title)), body);
}
// 权限不足与存档只读分开显示：脚本/正则未获准不是记录失配，不能误称存档只读。
export function permissionNode(text) {
  const body = $('<div>').addClass('ygg-body').append(text.split('\n').map(line => $('<div>').addClass('ygg-line').text(line)));
  return $('<details>').addClass('ygg-floor ygg-warn ygg-blocked').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').text('权限'), $('<span>').text('权限不足')), body);
}
// 世界书纯增补（B 级）待升级卡片：只读展示新增角色组、新增剧情标记与待更新楼层，确认前不写任何楼层变量。
export function upgradeNode(upgrade, {onUpgrade = null, onInspect = null} = {}) {
  const floors = upgrade.待升级楼号?.length ?? 0;
  const floorList = (upgrade.待升级楼号 ?? []).map(id => `#${id}`).join('、') || '无';
  const body = $('<div>').addClass('ygg-body').append(
    $('<div>').addClass('ygg-line').text('世界书已增补更新（原有历史 0 冲突）：确认后将逐楼无损写入新快照与当前版本清单。'),
    $('<div>').addClass('ygg-items').append(
      $('<span>').addClass('ygg-key').text('新增角色组'), value(upgrade.新增角色组?.length ? upgrade.新增角色组 : '无'),
      $('<span>').addClass('ygg-key').text('新增剧情标记'), value(upgrade.新增剧情标记?.length ? upgrade.新增剧情标记 : '无'),
      $('<span>').addClass('ygg-key').text('将更新楼层'), value(`共 ${floors} 个助手楼（${floorList}）`),
    ),
  );
  if (onUpgrade || onInspect) {
    const actions = $('<div>').addClass('ygg-actions');
    if (onUpgrade) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('升级本局存档')
      .on('click', event => { event?.preventDefault?.(); return onUpgrade(); }));
    if (onInspect) actions.append($('<button>').attr('type', 'button').addClass('menu_button').text('查看差异详情')
      .on('click', event => { event?.preventDefault?.(); return onInspect(); }));
    body.append(actions);
  }
  return $('<details>').addClass('ygg-floor ygg-upgrade').prop('open', true)
    .append($('<summary>').append($('<span>').addClass('ygg-label').text('待升级'), $('<span>').text('世界书已增补更新（原有历史 0 冲突）')), body);
}
// 设置表单，分区仿 MVU 的额外模型解析：显示、记账（方式、连接、模型与拉取、参数、应答格式、测试）。改动即存。
// current 为当前设置，save(patch) 存，presets 为酒馆的代理预设名，activeModel 为酒馆当前的模型名；
// pull(settings) 返回模型列表，test(settings) 返回 {文本}，失败时抛出。
export function settingsNode({current, save, presets = [], activeModel = '', pull, test}) {
  const settings = {...current}, set = patch => {
    Object.assign(settings, patch);
    const saving = save(patch);
    saving?.catch?.(() => {});
    sync();
  };
  const hint = text => $('<div>').addClass('ygg-hint').text(text);
  const field = (label, control, note) => $('<div>').addClass('ygg-field').append($('<label>').text(label), control, ...(note ? [hint(note)] : []));
  const input = (key, type = 'text', attrs = {}) => $('<input>').addClass('text_pole').attr({type, ...attrs}).val(settings[key])
    .on('change', event => set({[key]: type === 'number' ? Number(event.target.value) : event.target.value}));
  const select = (key, options) => $('<select>').addClass('text_pole').append(options.map(([optionValue, label]) => $('<option>').val(optionValue).text(label)))
    .val(settings[key]).on('change', event => set({[key]: event.target.value}));
  const check = (key, label, note) => $('<label>').addClass('ygg-check').append(
    $('<input>').attr('type', 'checkbox').prop('checked', settings[key] === true).on('change', event => set({[key]: event.target.checked})),
    $('<span>').append($('<span>').text(label), ...(note ? [hint(note)] : [])));
  const section = (title, open, ...children) => $('<details>').addClass('ygg-sec').prop('open', open)
    .append($('<summary>').text(title), $('<div>').addClass('ygg-body').append(children));

  const sameHint = hint(`用酒馆当前的连接与模型${activeModel ? `（现在是 ${activeModel}）` : ''}。`);
  const manual = $('<div>').append(
    field('API 地址', input('地址', 'text', {placeholder: 'https://…/v1'}), 'OpenAI 兼容的地址，缺 /v1 时自动补上。'),
    field('密钥', input('密钥', 'password'), '以明文存在酒馆的全局变量里（MVU 也是这样存的），本机的其它脚本读得到。'));
  const modelInput = input('模型', 'text', {placeholder: '模型名'});
  const picker = $('<select>').addClass('text_pole').hide().on('change', event => { modelInput.val(event.target.value); set({模型: event.target.value}); });
  const pullButton = $('<button>').attr('type', 'button').addClass('menu_button').text('拉取模型');
  pullButton.on('click', async event => {
    event?.preventDefault?.();
    pullButton.prop('disabled', true).text('拉取中…');
    try {
      const models = await pull(settings);
      picker.empty().append($('<option>').val('').text(`选择模型（共 ${models.length} 个）`), models.map(id => $('<option>').val(id).text(id)))
        .val(models.includes(settings.模型) ? settings.模型 : '').show();
      toastr.success(`共 ${models.length} 个模型`, '世界树：拉取模型');
    } catch (error) { toastr.error(error.message, '世界树：拉取模型失败'); }
    finally { pullButton.prop('disabled', false).text('拉取模型'); }
  });
  const other = section('另设模型', true,
    field('连接', select('代理预设', [['', '手动填写地址与密钥'], ...presets.map(name => [name, `代理预设：${name}`])]),
      '选代理预设时，地址与密钥用酒馆里存的那一份；拉取模型只认手动填写的地址。'),
    manual,
    field('模型', $('<div>').addClass('ygg-row').append(modelInput, pullButton), '填写模型名，或拉取后从下面选。'),
    picker,
    field('来源', select('来源', [['openai', 'OpenAI 兼容'], ['custom', '自定义（custom）'], ['claude', 'Claude'], ['makersuite', 'Google AI Studio'], ['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter']]),
      '多数中转站选 OpenAI 兼容。'));

  const status = $('<span>').addClass('ygg-status');
  const testButton = $('<button>').attr('type', 'button').addClass('menu_button').css({display: 'inline-block', width: 'auto'}).text('测试记账连接');
  testButton.on('click', async event => {
    event?.preventDefault?.();
    testButton.prop('disabled', true);
    status.text('测试中…');
    try { status.text(`成功：${(await test(settings)).文本}`); }
    catch (error) { status.text(`失败：${error.message}`); }
    finally { testButton.prop('disabled', false); }
  });
  const params = section('参数与应答格式', true,
    $('<div>').addClass('ygg-grid').append(
      field('温度', input('温度', 'number', {min: 0, max: 2, step: 0.1})),
      field('最大回复长度', input('最大长度', 'number', {min: 0, step: 256}), '0＝随预设'),
      field('尝试次数', input('尝试次数', 'number', {min: 1, max: 3, step: 1}), '结果不合规时重试')),
    field('应答格式', select('应答格式', [['结构化输出', '结构化输出（json_schema）'], ['提示词', '提示词要求 JSON']]),
      '源不支持 json_schema 时选“提示词要求 JSON”。'),
    $('<div>').addClass('ygg-field').append(testButton, status));

  const mode = select('方式', [['同一模型', '同一模型'], ['另设模型', '另设模型'], ['关闭', '关闭（旧方式：叙事模型写 <命令>）']]);
  function sync() {
    sameHint.toggle(settings.方式 === '同一模型');
    other.toggle(settings.方式 === '另设模型');
    manual.toggle(!settings.代理预设);
    params.toggle(settings.方式 !== '关闭');
  }
  const form = $('<div>').addClass('ygg-panel ygg-form').append($('<h3>').text('世界树：设置'),
    section('显示', true,
      check('每楼记录', '每楼下方显示这一楼记了什么', '只显示在页面上，不进提示词。'),
      check('调试', '调试', '本局面板显示全部事件与各楼的记账结果，每楼记录附命令，失败提示写出细节。会看到尚未发生的事件。')),
    section('记账', true, field('记账用的模型', mode), sameHint, other, params));
  sync();
  return form;
}

// 状态、弹窗与每楼一行：运行时状态由调用方持有（session），这里只按状态画提示并处理权限/只读的展示。
export const popup = (node, options = {wide: true, large: true}) =>
  SillyTavern.callGenericPopup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});

export function modalPopup(node, options = {wide: true, large: true}, track = null) {
  if (typeof SillyTavern.Popup !== 'function') return popup(node, options);
  const instance = new SillyTavern.Popup(node, SillyTavern.POPUP_TYPE.TEXT, '', {...options, allowVerticalScrolling: true});
  track?.(instance);
  return instance.show().finally(() => track?.(null, instance));
}

export function createStatusView({session, injectId, messages, chatId, recordOf, checkRecord, floorOf, keeperSettings,
  openOpening, rekeepFor, repairFor, runUpgrade}) {
  const show = (title, text) => popup(textNode(title, text));
  const showSections = (title, sections) => popup(panelNode(title, sections));
  const showBlocked = () => {
    const sections = [{标题: '世界树', 展开: true, 行: [
      session.integrity.说明,
      '错误码：' + session.integrity.code + (Number.isSafeInteger(session.integrity.楼号) ? '，楼号：' + session.integrity.楼号 : ''),
      '原始变量保持不变；不会自动迁移、补记账、提交命令或继续生成。',
    ]}];
    if (session.integrity.差异?.length) {
      sections.push({
        标题: `冲突差异明细（共 ${session.integrity.差异总数 || session.integrity.差异.length} 处）`,
        展开: true,
        行: session.integrity.差异,
      });
    }
    return showSections('存档不可用（只读）', sections);
  };
  const showUpgrade = () => {
    const up = session.upgrade;
    if (!up) return;
    const floorList = (up.待升级楼号 ?? []).map(id => `#${id}`).join('、') || '无';
    const groupLines = (up.新增角色组详情 ?? []).map(item => `+ 开局.角色组.${item.id}（启用=${item.启用}，版本ID=${item.版本ID}）`);
    const markLines = (up.新增剧情标记详情 ?? []).map(item => `+ 世界.剧情标记.${item.id}=${item.初值}`);
    return showSections('世界书已增补更新（待升级）', [
      {标题: '升级摘要', 展开: true,
        行: ['世界书已增补更新（原有历史 0 冲突）；确认升级前保持只读且未修改任何楼层变量。'],
        项: [
          ['新增角色组', up.新增角色组?.length ? up.新增角色组 : '无'],
          ['新增剧情标记', up.新增剧情标记?.length ? up.新增剧情标记 : '无'],
          ['将更新楼层', `共 ${up.待升级楼号?.length ?? 0} 个助手楼（${floorList}）`],
        ]},
      {标题: '增补差异明细（只读）', 展开: true,
        行: [...groupLines, ...markLines].length ? [...groupLines, ...markLines] : ['无增补明细']},
    ]);
  };

  // 权限诊断自身可能运行在残缺宿主上：toast 缺失时保留控制台诊断，不把诊断变成新的异常。
  function toastError(body, title) {
    try {
      if (typeof globalThis.toastr?.error === 'function') { globalThis.toastr.error(body, title); return; }
    } catch (error) { console.warn('世界树：toast 失败', error); }
    console.error(title + '：' + body);
  }

  function clearInjection() {
    if (typeof globalThis.uninjectPrompts !== 'function') return;
    try { globalThis.uninjectPrompts([injectId]); } catch (error) { console.warn('世界树：注入清理失败', error); }
  }

  function attachFloor(id, node) {
    const box = retrieveDisplayedMessage(id);
    if (box.length) box.after(node); else $('#chat').append(node);
  }

  function renderFloors() {
    if (typeof globalThis.$ !== 'function') return;
    $('#chat .ygg-floor').remove();
    if (session.permission) {
      const id = messages().at(-1)?.message_id;
      const node = permissionNode('权限不足：' + session.permission.说明 + '\n原因：' + session.permission.code
        + '\n原始聊天与楼层变量未被改写；恢复权限后重新生成即可继续。');
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.openingPending) {
      const id = messages()[0]?.message_id, node = openingStatusNode({open: openOpening,
        reason: session.last?.error?.startsWith('已取消') ? '上一次开局已取消，选择仍可重新打开。' : '请先打开开局并确认。'});
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.upgrade) {
      const id = Number.isSafeInteger(session.upgrade.楼号) ? session.upgrade.楼号 : messages().at(-1)?.message_id;
      const node = upgradeNode(session.upgrade, {onUpgrade: runUpgrade, onInspect: showUpgrade});
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (session.integrity) {
      const id = Number.isSafeInteger(session.integrity.楼号) ? session.integrity.楼号 : messages().at(-1)?.message_id;
      const total = session.integrity.差异总数 || session.integrity.差异?.length || 0;
      const diffLines = session.integrity.差异?.length
        ? [`冲突差异（共 ${total} 处${total > session.integrity.差异.length ? `，显示前 ${session.integrity.差异.length} 处` : ''}）：`,
           ...session.integrity.差异]
        : [];
      const node = readOnlyNode('存档只读：' + session.integrity.说明,
        ['原因：' + session.integrity.code, ...diffLines,
         '原始楼层变量保持不变；不会自动迁移、补记账、提交命令或继续生成。',
         '继续游玩请新建兼容聊天，或切换到合法的聊天。'].join('\n'));
      if (Number.isSafeInteger(id)) attachFloor(id, node); else $('#chat').append(node);
      return;
    }
    if (!keeperSettings().每楼记录) return;
    const verbose = keeperSettings().调试 === true, rekeep = keeperSettings().方式 !== '关闭';
    let before = null;
    for (const message of messages()) {
      const id = message.message_id;
      if (id === session.keepingFloor) { attachFloor(id, floorNode(null, {pending: true})); continue; }
      if (message.role !== 'assistant') continue;
      const record = recordOf(message);
      if (!checkRecord(record, message)) continue;
      try {
        if (id === 0) before = {世界: {当前时间: record.本局?.世界?.当前时间, 剧情标记: record.本局?.世界?.剧情标记 ?? {}},
          开局: record.本局?.开局 ?? {}, 角色: {}, 事件: {}, 待定项: []};
        if (before === null) continue;
        const line = floorOf(before, record.本局, record, verbose);
        const again = rekeep && id > 0 ? rekeepFor(id) : null;
        const repair = rekeep && id > 0 && repairFor ? repairFor(id) : null;
        attachFloor(id, floorNode(line, {rekeep: again, repair}));
        before = record.本局;
      } catch (error) { console.warn('世界树：每楼记录', error); }
    }
  }

  function upgradePending(result) {
    const fresh = !session.upgrade;
    session.openingPending = false;
    session.integrity = null;
    session.upgrade = {
      chatId: result.chatId ?? chatId?.() ?? '',
      code: result.code ?? '运行清单.世界书哈希',
      说明: result.说明 ?? '世界书已增补更新，请先确认升级本局存档',
      楼号: result.楼号,
      ...(result.upgrade ?? {}),
      snapshots: result.snapshots ?? result.upgrade?.归属快照 ?? [],
    };
    session.last = {error: session.upgrade.说明, code: session.upgrade.code, floor: session.upgrade.楼号};
    uninjectPrompts([injectId]);
    renderFloors();
    if (fresh) toastr.warning('世界书已增补更新，请先确认升级本局存档。', '世界树：待升级存档');
    return false;
  }

  function blocked(result) {
    if (result?.级别 === 'B') return upgradePending(result);
    session.openingPending = false;
    session.upgrade = null;
    session.integrity = {
      code: result.code ?? '校验.失败',
      说明: result.说明 ?? '楼层记录不可用',
      楼号: result.楼号,
      差异: result.差异 ?? [],
      差异总数: result.差异总数 ?? (result.差异?.length ?? 0),
    };
    session.last = {error: session.integrity.说明, code: session.integrity.code, floor: session.integrity.楼号};
    uninjectPrompts([injectId]);
    renderFloors();
    toastr.error(session.integrity.说明, '世界树：存档只读（' + session.integrity.code + '）');
    return false;
  }

  function permissionBlocked(result) {
    const changed = !session.permission || session.permission.code !== result.code || session.permission.说明 !== result.说明;
    session.permission = {code: result.code ?? '权限.失败', 说明: result.说明 ?? '卡内脚本或局部正则未获准'};
    session.integrity = null;
    session.upgrade = null;
    session.last = {error: session.permission.说明, code: session.permission.code, floor: null};
    clearInjection();
    try { renderFloors(); } catch (error) { console.warn('世界树：权限提示渲染失败', error); }
    if (changed) toastError(session.permission.说明, '世界树：权限不足（' + session.permission.code + '）');
    return false;
  }

  function pendingOpening(reason = '尚未开局') {
    session.openingPending = true;
    session.integrity = null;
    session.upgrade = null;
    session.last = {error: reason, code: '开局.未完成', floor: 0};
    uninjectPrompts([injectId]);
    renderFloors();
    return false;
  }

  return {show, showSections, showBlocked, showUpgrade, toastError, clearInjection, renderFloors, attachFloor,
    blocked, upgradePending, permissionBlocked, pendingOpening};
}
