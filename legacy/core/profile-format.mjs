// 时期档案格式：按核心契约的档案形态校验基本信息、角色印象与角色组索引的写法。
// 规范正文见 spec/；本模块只做机器可判断的部分。ctx 提供 skills（技能目录）与 dialect（年份形态）。
import {traitsIssues} from './growth.mjs';
import {PROFILE_SHAPES, GROUP_INDEX} from './contract.mjs';

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const endsWithStop = s => /[。．.！!？?；;]$/.test(s.trim());

// 返回 {errors, warnings}；label 用于定位到具体字段。
function shapeIssues(value, spec, label, ctx) {
  const errors = [], warnings = [], err = m => errors.push(`${label} ${m}`);
  const list = () => {
    if (!Array.isArray(value) || !value.length) { err('须为非空列表'); return false; }
    if (!value.every(text)) { err('列表项须为非空文本'); return false; }
    return true;
  };
  switch (spec.形态) {
    case '文本': if (!text(value)) err('须为非空文本'); break;
    case '年份': if (!text(value) || !ctx.dialect?.time(value)) err('须为项目纪年格式'); break;
    case '文本列表': list(); break;
    case '短语列表':
      if (list()) for (const s of value) {
        if (endsWithStop(s)) err(`短语不以句号结尾：${s}`);
        if (spec.最长 && [...s].length > spec.最长) err(`每项不超过${spec.最长}字：${s}`);
      }
      break;
    case '禁区列表':
      if (list()) for (const s of value) if (!s.trim().startsWith('不')) err(`每条以“不”开头：${s}`);
      break;
    case '情境列表':
      if (!Array.isArray(value) || !value.length) { err('须为非空的“- 情境: 内容”列表'); break; }
      for (const item of value) {
        const keys = plain(item) ? Object.keys(item) : [];
        if (keys.length !== 1 || !text(keys[0]) || !text(item[keys[0]])) err(`每项须为单键映射“情境: 内容”：${JSON.stringify(item)}`);
      }
      break;
    case '映射': {
      if (!plain(value)) { err('须为映射'); break; }
      const order = Object.keys(spec.子字段 || {}), keys = Object.keys(value);
      for (const k of keys) if (!order.includes(k)) err(`子字段非法 ${k}`);
      const idx = keys.map(k => order.indexOf(k)).filter(i => i >= 0);
      if (idx.some((v, i) => i && v < idx[i - 1])) err('子字段顺序应为 ' + order.join('、'));
      if (keys.length < (spec.最少子字段 || 1)) err(`至少写 ${spec.最少子字段 || 1} 个子字段`);
      for (const k of keys) if (spec.子字段?.[k]) {
        const r = shapeIssues(value[k], spec.子字段[k], `${label}.${k}`, ctx);
        errors.push(...r.errors); warnings.push(...r.warnings);
      }
      break;
    }
    case '能力特征':
      for (const m of traitsIssues(value, {skills: ctx.skills})) err(m);
      for (const s of Array.isArray(value?.技能补充) ? value.技能补充 : [])
        for (const k of ['个体表现', '个体限制']) if (k in (s || {}) && !Array.isArray(s[k])) err(`${s.技能ID} 的${k}须写成列表`);
      break;
    default: err('规划中的形态未知 ' + spec.形态);
  }
  const [min, max] = spec.建议条数 || [];
  if (Array.isArray(value) && min && (value.length < min || value.length > max)) warnings.push(`${label} 建议 ${min}–${max} 条，现有 ${value.length} 条`);
  return {errors, warnings};
}

// kind：基本信息 / 角色印象；body 为解析后的对象，raw 为原文。
export function profileFormatIssues(kind, body, raw, shapes = PROFILE_SHAPES[kind], ctx = {}) {
  const errors = [], warnings = [];
  const lines = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== `<${kind}>` || lines.at(-1) !== `</${kind}>`) errors.push(`须以 <${kind}> 与 </${kind}> 包裹首尾`);
  for (const line of lines) if (/:\s*\[\s*[^\]\s]/.test(line)) errors.push(`列表须块状书写：${line}`);
  if (!plain(body)) return {errors: [...errors, '正文须为映射'], warnings};
  const order = Object.keys(shapes), keys = Object.keys(body);
  for (const k of keys) if (!order.includes(k)) errors.push('字段非法 ' + k);
  const idx = keys.map(k => order.indexOf(k)).filter(i => i >= 0);
  if (idx.some((v, i) => i && v < idx[i - 1])) errors.push('字段顺序应为 ' + order.filter(k => keys.includes(k)).join('、'));
  for (const [k, spec] of Object.entries(shapes)) {
    if (!(k in body)) { if (spec.必填) errors.push('缺字段 ' + k); continue; }
    const r = shapeIssues(body[k], spec, k, ctx);
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  return {errors, warnings};
}

// 角色组索引：顶层键顺序、档案项键顺序、空初始成长省略、别名为列表。
export function groupIndexFormatIssues(index, contract = GROUP_INDEX) {
  const errors = [];
  const ordered = (keys, order, where) => {
    const idx = keys.map(k => order.indexOf(k));
    if (idx.includes(-1)) errors.push(`${where} 含未登记的键：${keys.filter(k => !order.includes(k)).join('、')}`);
    else if (idx.some((v, i) => i && v < idx[i - 1])) errors.push(`${where} 键顺序应为 ${order.filter(k => keys.includes(k)).join('、')}`);
  };
  if (!plain(index)) return ['角色组索引须为映射'];
  ordered(Object.keys(index), contract.key_order, '角色组索引');
  if (!Array.isArray(index.别名)) errors.push('别名须为列表，没有时写 []');
  for (const p of Array.isArray(index.档案) ? index.档案 : []) {
    if (!plain(p)) continue;
    ordered(Object.keys(p), contract.profile_fields, `档案 ${p.档案ID}`);
    if (Array.isArray(p.初始成长) && !p.初始成长.length) errors.push(`档案 ${p.档案ID} 的初始成长为空时省略`);
  }
  return errors;
}
