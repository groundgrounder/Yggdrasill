import {parseYaml} from './yaml.mjs';
import {createCalendar} from './calendar.mjs';
import {resolveDomain} from './fields.mjs';
import {DECLARATION_FILES, REQUIRED_DECLARATIONS, FIXED_ROOTS, TEXT_CONTAINERS, SKELETON_FIELDS,
  FIELD_KINDS, SHAPES, PROFILE_FIELDS, LENGTH_BUDGETS, RESERVED_IDS} from './contract.mjs';
import {has, isMap, isText, texts, pairs, list, dict, issue} from './utils.mjs';

export async function readDeclarations(root, {fs, path}) {
  const raw = {}, issues = [];
  for (const name of DECLARATION_FILES) {
    const file = path.join('设定', `${name}.yaml`);
    let source;
    try { source = await fs.readFile(path.join(root, file), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') issues.push(issue('目录.读取失败', '错误', file, '无法读取声明文件'));
      continue;
    }
    try { Object.defineProperty(raw, name, {value: parseYaml(source), enumerable: true}); }
    catch { issues.push(issue('目录.YAML错误', '错误', file, '声明的 YAML 解析失败或含重复键、循环别名')); }
  }
  return {raw, issues};
}

export function validateDeclarations(input) {
  const raw = isMap(input) ? input : {};
  const issues = [];
  const add = (rule, name, message) => issues.push(issue(rule, '错误', `设定/${name}.yaml`, message));
  const missing = new Set();
  function requireFile(name) {
    if (!has(raw, name) && !missing.has(name)) {
      missing.add(name);
      add('设定.缺少文件', name, `缺少用到的声明文件“${name}.yaml”`);
    }
  }
  function keys(value, allowed, required, name, label, rule = '设定.格式') {
    if (!isMap(value)) { add(rule, name, `${label}须为映射`); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(rule, name, `${label}含未知键“${key}”`);
    for (const key of required) if (!has(value, key)) add(rule, name, `${label}缺少“${key}”`);
    return true;
  }
  function textList(value, name, label, rule = '设定.格式', allowEmpty = false) {
    if (!texts(value, allowEmpty)) add(rule, name, `${label}须为${allowEmpty ? '' : '非空'}无重复文本列表`);
  }
  for (const name of REQUIRED_DECLARATIONS) requireFile(name);
  for (const name of DECLARATION_FILES) if (has(raw, name) && !isMap(raw[name])) add('设定.格式', name, '声明须为映射');
  let calendar = null;
  if (has(raw, '纪年')) {
    try { createCalendar(raw.纪年); calendar = structuredClone(raw.纪年); }
    catch { add('设定.纪年', '纪年', '纪年的四个键必须齐全，年月日位数及逐月天数必须合法'); }
  }
  const abilityRaw = dict(raw.能力), variableRaw = dict(raw.本局变量);
  const decl = {
    calendar,
    ladders: dict(raw.等级),
    ability: {维度: dict(abilityRaw.维度), 技能可用: list(abilityRaw.技能可用), 综合实力: null},
    classification: dict(raw.事件分类),
    libraries: dict(raw.条目库),
    variables: {词表: dict(variableRaw.词表), 角色: dict(variableRaw.角色), 世界: dict(variableRaw.世界), 单次增减上限: variableRaw.单次增减上限 ?? 100},
    marks: dict(raw.剧情标记),
    roleClasses: dict(raw.角色分类),
    textRules: dict(raw.文本规范),
  };
  const dimensions = decl.ability.维度;
  for (const [name, values] of pairs(decl.ladders)) textList(values, '等级', name);
  if (decl.ability.技能可用.length && !has(decl.libraries, '技能')) add('设定.技能可用', '能力', '声明技能可用规则时必须声明技能条目库');
  function ladder(name, file, rule) {
    requireFile('等级');
    if (!isText(name) || !has(decl.ladders, name)) add(rule, file, `引用了不存在的等级“${name}”`);
  }
  if (has(raw, '能力')) keys(abilityRaw, ['维度', '技能可用'], ['维度', '技能可用'], '能力', '能力');
  if (has(abilityRaw, '维度') && !isMap(abilityRaw.维度)) add('设定.能力', '能力', '维度须为映射');
  if (has(abilityRaw, '技能可用') && !Array.isArray(abilityRaw.技能可用)) add('设定.技能可用', '能力', '技能可用须为列表');
  for (const [name, dimension] of pairs(dimensions)) {
    const rule = '设定.能力';
    if (SKELETON_FIELDS.角色.includes(name) || has(decl.variables.角色, name)) add(rule, '能力', `维度“${name}”与角色字段重名`);
    if (!isMap(dimension)) { add(rule, '能力', `维度“${name}”须为映射`); continue; }
    const type = dimension.类型;
    if (!['等级映射', '单值等级', '集合'].includes(type)) { add(rule, '能力', `维度“${name}”类型未知`); continue; }
    const allowed = type === '等级映射' ? ['类型', '等级', '键'] : type === '单值等级' ? ['类型', '等级', '综合实力'] : ['类型', '成员'];
    keys(dimension, allowed, type === '等级映射' ? ['类型', '等级', '键'] : type === '单值等级' ? ['类型', '等级'] : ['类型', '成员'], '能力', name, rule);
    if (type !== '集合') ladder(dimension.等级, '能力', rule);
    if (has(dimension, '综合实力') && typeof dimension.综合实力 !== 'boolean') add(rule, '能力', `${name}的综合实力须为布尔`);
    if (dimension.综合实力 === true) {
      if (type !== '单值等级' || decl.ability.综合实力 !== null) add(rule, '能力', '综合实力至多标在一个单值等级维度上');
      else decl.ability.综合实力 = name;
    }
    if (type === '等级映射') {
      const values = dimension.键;
      if (Array.isArray(values)) textList(values, '能力', `${name}.键`, rule);
      else if (isMap(values) && Object.keys(values).length) {
        const all = [];
        for (const [group, members] of pairs(values)) {
          if (!isText(group)) add(rule, '能力', `${name}的键组名不能为空`);
          textList(members, '能力', `${name}.${group}`, rule);
          all.push(...list(members));
        }
        if (new Set(all).size !== all.length) add(rule, '能力', `${name}的键跨组重复`);
      } else add(rule, '能力', `${name}的键须为非空清单或分组映射`);
    }
  }
  function domain(value, file, label) {
    const rule = '设定.字段声明';
    if (Array.isArray(value)) { textList(value, file, label, rule); return; }
    if (value === '纪年') return;
    if (typeof value !== 'string' || !/^(等级|能力|词表)\..+$/.test(value)) { add(rule, file, `${label}取值域未知`); return; }
    const index = value.indexOf('.'), kind = value.slice(0, index), name = value.slice(index + 1);
    if (kind === '等级') ladder(name, file, rule);
    if (kind === '能力') {
      requireFile('能力');
      if (!has(dimensions, name) || dimensions[name]?.类型 !== '等级映射') add(rule, file, `${label}未引用等级映射维度的键`);
    }
    if (kind === '词表' && !has(decl.variables.词表, name)) add(rule, file, `${label}引用了不存在的词表“${name}”`);
  }
  function field(schema, file, label, variables = false, types = null) {
    const rule = '设定.字段声明';
    if (!isMap(schema)) { add(rule, file, `${label}声明须为映射`); return; }
    const kinds = FIELD_KINDS.filter(key => has(schema, key));
    keys(schema, [...FIELD_KINDS, '必填', '列表', '适用类型'], [], file, label, rule);
    if (kinds.length !== 1) { add(rule, file, `${label}必须恰好使用一种字段写法`); return; }
    const kind = kinds[0];
    if (has(schema, '必填') && typeof schema.必填 !== 'boolean') add(rule, file, `${label}的必填须为布尔`);
    if (has(schema, '列表') && (typeof schema.列表 !== 'boolean' || !['取值', '引用'].includes(kind))) add(rule, file, `${label}只有取值或引用可以声明列表`);
    if (has(schema, '适用类型')) {
      textList(schema.适用类型, file, `${label}.适用类型`, '设定.条目库');
      if (!texts(types) || list(schema.适用类型).some(value => !types.includes(value))) add('设定.条目库', file, `${label}须引用本库合规的类型字段`);
    }
    if (kind === '形态' && !SHAPES.includes(schema.形态)) add(rule, file, `${label}形态未知`);
    if (kind === '取值') domain(schema.取值, file, label);
    if (kind === '引用' && (!isText(schema.引用) || (!['角色组', '事件'].includes(schema.引用) && !has(decl.libraries, schema.引用)))) add(rule, file, `${label}引用目标须为已声明命名空间的文本名称`);
    if (kind === '子字段') {
      if (!isMap(schema.子字段) || !Object.keys(schema.子字段).length) add(rule, file, `${label}子字段须为非空映射`);
      fields(schema.子字段, file, label, variables, types);
    }
    if (kind === '映射') {
      if (keys(schema.映射, ['键', '值'], ['键', '值'], file, label, rule)) {
        field(schema.映射.键, file, `${label}.键`, variables, types);
        field(schema.映射.值, file, `${label}.值`, variables, types);
      }
    }
    if (['数值', '集合'].includes(kind) && !variables) add(rule, file, `${label}的${kind}只能用于本局变量`);
    if (kind === '数值' && (!Array.isArray(schema.数值) || schema.数值.length !== 2
      || !schema.数值.every(Number.isSafeInteger) || schema.数值[0] > schema.数值[1])) add(rule, file, `${label}数值范围须为整数上下限`);
    if (kind === '集合') field(schema.集合, file, `${label}.集合`, variables, types);
  }
  function fields(value, file, label, variables = false, types = null) {
    if (!isMap(value)) { add('设定.字段声明', file, `${label}须为字段映射`); return; }
    for (const [name, schema] of pairs(value)) {
      if (!isText(name) || name === '名称' || name === 'ID' || name === `${label}ID`) add('设定.字段声明', file, `${label}不能声明空字段名、自身ID或名称`);
      field(schema, file, `${label}.${name}`, variables, types);
    }
  }
  for (const [name, library] of pairs(decl.libraries)) {
    const rule = '设定.条目库';
    if ([...FIXED_ROOTS, ...TEXT_CONTAINERS, ...RESERVED_IDS].includes(name) || !isText(name) || name !== name.trim() || /[./\\]/.test(name)) add(rule, '条目库', `库名“${name}”不合法或与固定目录重名`);
    if (!keys(library, ['分法', '分级', '上级类型', '字段'], ['分法', '字段'], '条目库', name, rule)) continue;
    if (!['按种类', '按上下级'].includes(library.分法) || (name === '地点' && library.分法 !== '按上下级')) add(rule, '条目库', `${name}的分法不合法`);
    const schemas = dict(library.字段);
    const typeSchema = schemas.类型;
    const types = isMap(typeSchema) && Array.isArray(typeSchema.取值) && !typeSchema.列表 ? typeSchema.取值 : null;
    if (library.分法 === '按种类') {
      textList(library.分级, '条目库', `${name}.分级`, rule);
      if (has(library, '上级类型')) add(rule, '条目库', `${name}按种类时不能写上级类型`);
      for (const key of list(library.分级)) if (!has(schemas, key) || !has(schemas[key], '取值') || schemas[key]?.列表) add(rule, '条目库', `${name}的分级“${key}”须是已声明的单值取值字段`);
    } else if (has(library, '分级')) add(rule, '条目库', `${name}按上下级时不能写分级`);
    if (has(library, '上级类型')) {
      if (!isMap(library.上级类型) || !texts(types)) add(rule, '条目库', `${name}上级类型须为映射，且声明单值类型清单`);
      for (const [type, parents] of pairs(library.上级类型)) {
        textList(parents, '条目库', `${name}.${type}上级类型`, rule, true);
        if (!types?.includes(type) || list(parents).some(parent => !types?.includes(parent))) add(rule, '条目库', `${name}上级类型含未声明的类型`);
      }
    }
    fields(library.字段, '条目库', name, false, types);
  }
  if (has(decl.libraries, '技能')) requireFile('能力');
  const skillFields = dict(decl.libraries.技能?.字段);
  for (const [index, rule] of decl.ability.技能可用.entries()) {
    const code = '设定.技能可用', label = `技能可用第${index + 1}项`;
    if (!isMap(rule)) { add(code, '能力', `${label}须为映射`); continue; }
    const threshold = rule.规则 === '等级门槛';
    keys(rule, threshold ? ['适用', '规则', '维度', '键字段', '等级字段', '键组'] : ['适用', '规则', '维度'],
      threshold ? ['适用', '规则', '维度', '键字段', '等级字段'] : ['适用', '规则', '维度'], '能力', label, code);
    if (!['等级门槛', '集合持有'].includes(rule.规则)) add(code, '能力', `${label}规则形状未知`);
    const dimension = has(dimensions, rule.维度) ? dimensions[rule.维度] : null;
    if (!isMap(dimension) || dimension.类型 !== (threshold ? '等级映射' : '集合')) add(code, '能力', `${label}维度不存在或类型不符`);
    if (!isMap(rule.适用) || !Object.keys(rule.适用).length) add(code, '能力', `${label}适用须为非空字段条件映射`);
    const references = [...Object.keys(dict(rule.适用)), ...(threshold ? [rule.键字段, rule.等级字段] : [])];
    for (const key of references) if (!has(skillFields, key)) add(code, '能力', `${label}引用了未声明的技能字段“${key}”`);
    for (const [key, value] of pairs(rule.适用)) {
      const schema = has(skillFields, key) ? skillFields[key] : null;
      if (!isText(value) || (has(schema, '取值') && schema.取值 !== '纪年' && !resolveDomain(schema.取值, decl).includes(value))) add(code, '能力', `${label}适用取值不合字段声明`);
    }
    if (has(rule, '键组') && (!isText(rule.键组) || !isMap(dimension?.键) || !has(dimension.键, rule.键组))) add(code, '能力', `${label}键组不存在`);
  }
  for (const [name, dimension] of pairs(dimensions)) if (dimension?.类型 === '集合') {
    const member = dimension.成员;
    if (member === '文本') continue;
    if (!keys(member, ['条目库', '条件'], ['条目库'], '能力', `${name}.成员`, '设定.能力')) continue;
    if (!has(decl.libraries, member.条目库)) add('设定.能力', '能力', `${name}集合引用的条目库不存在`);
    if (has(member, '条件')) {
      if (!isMap(member.条件) || !Object.keys(member.条件).length) add('设定.能力', '能力', `${name}成员条件须为非空映射`);
      const schemas = dict(decl.libraries[member.条目库]?.字段);
      for (const [key, value] of pairs(member.条件)) {
        const schema = has(schemas, key) ? schemas[key] : null;
        if (!schema || !isText(value) || (has(schema, '取值') && schema.取值 !== '纪年' && !resolveDomain(schema.取值, decl).includes(value))) add('设定.能力', '能力', `${name}成员条件引用了未知字段或非法取值`);
      }
    }
  }
  if (has(raw, '本局变量')) keys(variableRaw, ['词表', '角色', '世界', '单次增减上限'], ['词表', '角色'], '本局变量', '本局变量');
  if (!has(decl.variables.词表, '装备状态')) add('设定.本局变量', '本局变量', '必须声明词表.装备状态');
  for (const [name, values] of pairs(decl.variables.词表)) textList(values, '本局变量', `词表.${name}`);
  if (has(variableRaw, '词表') && !isMap(variableRaw.词表)) add('设定.格式', '本局变量', '词表须为映射');
  for (const name of ['角色', '世界']) {
    if (has(variableRaw, name) && !isMap(variableRaw[name])) add('设定.格式', '本局变量', `${name}须为映射`);
    for (const key of Object.keys(decl.variables[name])) if (SKELETON_FIELDS[name].includes(key) || (name === '角色' && has(dimensions, key))) add('设定.本局变量', '本局变量', `${name}.${key}与骨架或能力维度重名`);
    fields(decl.variables[name], '本局变量', name, true);
  }
  if ((has(variableRaw, '单次增减上限') && variableRaw.单次增减上限 === null)
    || !Number.isSafeInteger(decl.variables.单次增减上限) || decl.variables.单次增减上限 <= 0) add('设定.本局变量', '本局变量', '单次增减上限须为正整数');
  if (has(raw, '事件分类')) keys(raw.事件分类, ['主类型', '标签', '事件结果'], ['主类型', '标签', '事件结果'], '事件分类', '事件分类');
  for (const key of ['主类型', '标签']) if (has(decl.classification, key)) textList(decl.classification[key], '事件分类', key);
  if (has(decl.classification, '事件结果') && !isMap(decl.classification.事件结果)) add('设定.格式', '事件分类', '事件结果须为支撑字段映射');
  const support = [...SKELETON_FIELDS.角色, ...SKELETON_FIELDS.世界, ...Object.keys(dimensions), ...Object.keys(decl.variables.角色), '剧情标记', '档案切期'];
  for (const [name, values] of pairs(decl.classification.事件结果)) {
    textList(values, '事件分类', name, '设定.格式', true);
    for (const value of list(values)) if (!support.includes(value)) add('设定.事件结果支撑', '事件分类', `${name}支撑字段“${value}”未声明`);
  }
  for (const [name, values] of pairs(decl.marks)) textList(values, '剧情标记', name, '设定.剧情标记');
  if (has(raw, '角色分类')) {
    if (keys(raw.角色分类, ['角色包', '分类'], ['角色包', '分类'], '角色分类', '角色分类')) {
      for (const key of ['角色包', '分类']) textList(raw.角色分类[key], '角色分类', key);
    }
  }
  const textRules = decl.textRules;
  if (has(raw, '文本规范')) keys(raw.文本规范, ['禁用词', 'ID命名', '档案追加字段', '长度预算'], [], '文本规范', '文本规范', '设定.文本规范');
  if (has(textRules, '禁用词')) textList(textRules.禁用词, '文本规范', '禁用词', '设定.文本规范', true);
  if (has(textRules, '长度预算')) {
    if (!isMap(textRules.长度预算)) add('设定.文本规范', '文本规范', '长度预算须为映射');
    for (const [name, budget] of pairs(textRules.长度预算)) if (!has(LENGTH_BUDGETS, name) || !Number.isSafeInteger(budget) || budget <= 0 || budget > LENGTH_BUDGETS[name]) add('设定.文本规范', '文本规范', `${name}预算须为正整数，且不能放宽第四层预算`);
  }
  if (has(textRules, 'ID命名')) {
    if (!isMap(textRules.ID命名)) add('设定.文本规范', '文本规范', 'ID命名须为映射');
    const namespaces = ['全部', '角色组ID', '版本ID', '档案ID', '剧情标记ID', '能力键', '事件ID', ...Object.keys(decl.libraries).map(name => `${name}ID`)];
    for (const [name, rule] of pairs(textRules.ID命名)) {
      if (!namespaces.includes(name)) add('设定.文本规范', '文本规范', `未知命名空间“${name}”`);
      keys(rule, ['只用中文', '前缀字段'], [], '文本规范', name, '设定.文本规范');
      if (has(rule, '只用中文') && rule.只用中文 !== true) add('设定.文本规范', '文本规范', '只用中文只能写 true');
      if (has(rule, '前缀字段')) {
        const library = name.endsWith('ID') ? decl.libraries[name.slice(0, -2)] : null;
        if (!isText(rule.前缀字段) || !has(library?.字段, rule.前缀字段)) add('设定.文本规范', '文本规范', `${name}前缀字段须引用本库声明的字段`);
      }
    }
  }
  if (has(textRules, '档案追加字段')) {
    if (!isMap(textRules.档案追加字段)) add('设定.文本规范', '文本规范', '档案追加字段须为映射');
    for (const [kind, schemas] of pairs(textRules.档案追加字段)) {
      if (!has(PROFILE_FIELDS, kind) || !isMap(schemas)) { add('设定.文本规范', '文本规范', '只能向基本信息与角色印象追加字段映射'); continue; }
      for (const [name, schema] of pairs(schemas)) {
        if (has(PROFILE_FIELDS[kind], name) || schema?.必填 === true) add('设定.文本规范', '文本规范', `${kind}.${name}必须是新建的可选字段`);
      }
      fields(schemas, '文本规范', kind);
    }
  }
  return {decl: structuredClone(decl), issues};
}
