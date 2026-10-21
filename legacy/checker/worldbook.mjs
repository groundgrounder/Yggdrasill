// 世界书检查：核心规则（结构、引用、索引、门槛、变化、档案、禁用词）+ 项目规则插件 + 运行抽样。
// 本检查器对任何世界书目录（含空项目）通用；具体故事的门控案例由项目自己的回归测试负责。
// 插件规则：{名称, files(ctx), catalog(ctx)}；files 在读取运行目录前执行，catalog 在其后执行。
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtocol, seal, assemble, sceneGateIssues} from '../core/protocol.mjs';
import {loadCatalog} from '../core/catalog.mjs';
import {analyzeEvents, checkStorylines, evaluateCondition} from '../core/relations.mjs';
import {growthIssues, abilityChangeIssues} from '../core/growth.mjs';
import {profileFormatIssues, groupIndexFormatIssues} from '../core/profile-format.mjs';
import {requireDialect} from '../core/dialect.mjs';
import {parseYaml, stringifyYaml, unwrap} from '../core/yaml.mjs';
import * as C from '../core/contract.mjs';

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, {withFileTypes: true})) {
    if (e.name.startsWith('.')) continue;
    const f = path.join(dir, e.name);
    out.push(...(e.isDirectory() ? [{dir: f}, ...await walk(f)] : [{file: f}]));
  }
  return out;
}

// 返回 {code, stdout, stderr}；由调用方输出并退出，便于测试与嵌入。
export async function checkWorldbook(root, {dialect, rules = [], staticOnly = false, fixIndex = false, label = root} = {}) {
  requireDialect(dialect, '世界书检查');
  const {time, calendar, rank} = dialect;
  const errors = [], warnings = [];
  const fail = (file, message) => errors.push(`${file}: ${message}`);
  const warn = message => warnings.push(message);
  const stdout = [], stderr = [];
  const done = code => ({code, stdout: stdout.join('\n') + (stdout.length ? '\n' : ''), stderr: stderr.join('\n') + (stderr.length ? '\n' : ''), errors, warnings});
  const json = v => stdout.push(JSON.stringify(v, null, 2));
  const failed = () => { stderr.push(errors.join('\n')); stderr.push(`\n未通过：${errors.length} 项`); return done(1); };

  const items = await walk(root);
  const rel = f => path.relative(root, f).split(path.sep).join('/');
  const files = items.filter(i => i.file).map(i => rel(i.file)).filter(f => /\.(txt|yaml)$/.test(f));
  const dirs = ['', ...items.filter(i => i.dir).map(i => rel(i.dir))];
  const data = {}, rawText = {};
  for (const f of files) {
    const raw = rawText[f] = await fs.readFile(path.join(root, f), 'utf8');
    try { data[f] = (await parseYaml(unwrap(raw))) ?? {}; } catch (e) { fail(f, 'YAML ' + e.message.split('\n')[0]); }
  }

  // 目录分类
  const segs = d => d ? d.split('/') : [];
  const isProfileDir = d => segs(d)[0] === '角色' && segs(d).length >= 2;
  const isEventDir = d => segs(d)[0] === '历史' && segs(d).length >= 3;
  const specialIndex = new Set([C.LAYOUT.roleIndex, '历史/' + C.LAYOUT.storylineIndex]);
  for (const d of dirs) {
    const s = segs(d);
    if (s[0] === '角色' && s.length === 2) specialIndex.add(`${d}/${s[1]}索引.txt`);
    if (s[0] === '历史' && s.length === 2) specialIndex.add(`${d}/${s[1]}索引.txt`);
  }
  const buildOnly = f => f.endsWith('索引.txt') || f.endsWith('/体系元数据.txt') || f.endsWith('/' + C.LAYOUT.growthTree) || (f.startsWith('变量/') && f !== C.LAYOUT.vocabulary);

  // 普通索引：说明 + 入口，与目录内容确定性一致。
  for (const d of dirs) {
    if (isProfileDir(d) || isEventDir(d)) continue;
    const name = d ? segs(d).at(-1) : '世界书';
    const indexFile = (d ? d + '/' : '') + name + '索引.txt';
    if (specialIndex.has(indexFile)) continue;
    const local = files.filter(f => path.posix.dirname(f) === (d || '.')).map(f => path.posix.basename(f));
    const subdirs = dirs.filter(x => x && path.posix.dirname(x) === (d || '.')).map(x => segs(x).at(-1));
    const expected = {};
    if (d && !d.startsWith('变量') && local.includes(name + '.txt')) expected.说明 = name + '.txt';
    const entries = [...local.filter(f => f !== name + '索引.txt' && f !== name + '.txt').sort(), ...subdirs.sort().map(s => `${s}/${s}索引.txt`)];
    if (entries.length) expected.入口 = entries;
    if (fixIndex) { await fs.writeFile(path.join(root, indexFile), await stringifyYaml(expected)); data[indexFile] = expected; if (!files.includes(indexFile)) files.push(indexFile); continue; }
    if (!files.includes(indexFile)) { fail(indexFile, '缺少索引'); continue; }
    try { assert.deepEqual(data[indexFile], expected); } catch { fail(indexFile, '索引与目录不一致，期望 ' + JSON.stringify(expected)); }
  }
  if (!fixIndex) for (const d of dirs) if (d && d !== '角色' && !isProfileDir(d) && !isEventDir(d) && !d.startsWith('变量') && !files.includes(`${d}/${segs(d).at(-1)}.txt`)) fail(d, '缺少同名说明文件');
  for (const f of files.filter(f => f.endsWith('索引.txt') && !specialIndex.has(f))) {
    const extra = Object.keys(data[f] || {}).filter(k => !['说明', '入口'].includes(k));
    if (extra.length) fail(f, '普通索引只能含说明和入口：' + extra.join('、'));
  }

  // 命名空间
  const ns = Object.fromEntries(C.NAMESPACES.map(k => [k, new Map()]));
  for (const [f, d] of Object.entries(data)) for (const k of Object.keys(ns)) if (d && typeof d[k] === 'string') {
    if (ns[k].has(d[k])) fail(f, `重复${k} ${d[k]}`); else ns[k].set(d[k], f);
  }
  const meta = data[C.LAYOUT.systemsMeta] || {};
  const systems = new Set([...(meta.一般体系 || []), ...(meta.固有或特殊体系 || [])]);

  // 技能：协议依赖的等级与体系。字段、分类与目录约定属于项目规则。
  for (const f of ns.技能ID.values()) {
    const d = data[f];
    if (!rank(d.技能等级)) fail(f, '技能等级非法 ' + d.技能等级);
    if (!systems.has(d.体系)) fail(f, '体系未登记 ' + d.体系);
  }

  const ctx = {root, files, dirs, data, rawText, fail, warn, segs, dialect, rank, ns, meta, systems};
  for (const r of rules) if (r.files) await r.files(ctx);

  // 读取目录前先校验角色索引，避免缺失入口导致读取崩溃。
  const roleIndex = data[C.LAYOUT.roleIndex];
  if (!roleIndex || !Array.isArray(roleIndex.角色组)) fail(C.LAYOUT.roleIndex, '缺少角色索引或角色组列表');
  for (const r of roleIndex?.角色组 || []) {
    if (r.角色组ID === C.PLAYER) fail(C.LAYOUT.roleIndex, `“${C.PLAYER}”是保留的角色组ID`);
    if (!files.includes('角色/' + r.入口)) fail(C.LAYOUT.roleIndex, `${r.角色组ID} 的入口不存在：${r.入口}`);
  }
  if (!data[C.LAYOUT.historyIndex]) fail(C.LAYOUT.historyIndex, '缺少历史索引');
  if (!data[C.LAYOUT.variableSchema]?.角色?.['{角色组ID}']) fail(C.LAYOUT.variableSchema, '缺少角色变量结构 角色.{角色组ID}');
  if (!data[C.LAYOUT.vocabulary]) fail(C.LAYOUT.vocabulary, '缺少取值词表');
  if (errors.length) return failed();
  const catalog = await loadCatalog(root, parseYaml, fs, path);
  const protocol = createProtocol(catalog, dialect);
  Object.assign(ctx, {catalog, protocol});
  // 技能必须能从技能索引逐层到达；一般技能的体系必须是一般体系。
  for (const [id, f] of ns.技能ID) if (!protocol.skills.has(id)) fail(f, '技能无法从技能索引到达');
  for (const s of catalog.skills) if (s.来源 === '一般' && !(meta.一般体系 || []).includes(s.体系)) fail(s.路径, '一般技能的体系必须登记在一般体系中');
  // 地点：ID 与文件名一致、能从地理索引到达、上级目录有同名地点。类型层次属于项目规则。
  for (const [id, f] of ns.地点ID) if (!protocol.locations.has(id)) fail(f, '地点无法从地理索引到达');
  for (const l of catalog.locations) {
    if (path.posix.basename(l.路径, '.txt') !== l.地点ID) fail(l.路径, '地点ID应与文件名一致');
    if (l.父级 && !protocol.locations.get(l.父级)) fail(l.路径, '上级目录没有同名地点文件 ' + l.父级);
  }
  const groupIDs = new Set(catalog.groups.map(g => g.角色组ID));
  for (const g of catalog.groups) {
    const where = `角色/${g.角色组ID}/${C.LAYOUT.growthTree}`;
    for (const message of growthIssues(g.growth, g, {skills: protocol.skills, equipment: protocol.equipment, systems, dialect})) fail(where, message);
  }
  const roleDirs = dirs.filter(d => segs(d)[0] === '角色' && segs(d).length === 2).map(d => segs(d)[1]);
  try { assert.deepEqual([...groupIDs].sort(), roleDirs.sort()); } catch { fail(C.LAYOUT.roleIndex, '角色组与目录不一致'); }
  for (const r of roleIndex.角色组) for (const k of C.ROLE_INDEX.fields) if (!(k in r)) fail(C.LAYOUT.roleIndex, `${r.角色组ID} 缺 ${k}`);
  function checkCondition(node, where) {
    const [type] = Object.keys(node || {}), a = node?.[type];
    if (!type || Object.keys(node).length !== 1) return fail(where, '条件必须只有一个类型键');
    if (C.COMBINATORS.includes(type)) return Array.isArray(a) && a.length ? a.forEach(n => checkCondition(n, where)) : fail(where, '空逻辑组合');
    if (!dialect.conditions.has(type)) return fail(where, '未登记条件类型 ' + type);
    for (const issue of sceneGateIssues(type, a, {groups: protocol.groups, locations: protocol.locations, dialect})) fail(where, issue);
    if (!a || typeof a !== 'object') return fail(where, '条件参数须为对象');
    if (a.角色组ID && !groupIDs.has(a.角色组ID)) fail(where, '条件引用未知角色组 ' + a.角色组ID);
    if (type === '角色版本' && !catalog.groups.find(g => g.角色组ID === a.角色组ID)?.版本.some(v => v.版本ID === a.版本ID)) fail(where, '条件引用未知版本 ' + a.版本ID);
    if (type === '事件确认') {
      const e = protocol.events.get(a.事件ID);
      if (!e) fail(where, '条件引用未知事件 ' + a.事件ID);
      else if (a.分支ID && !e.分支.some(b => b.分支ID === a.分支ID)) fail(where, '条件引用未知分支 ' + a.分支ID);
    }
    if (type === '当前时间' && !time(a.值)) fail(where, '时间格式非法 ' + a.值);
  }

  const GI = C.GROUP_INDEX;
  for (const g of catalog.groups) {
    const where = `角色/${g.角色组ID}/${g.角色组ID}索引.txt`, d = data[where];
    for (const k of GI.fields) if (!(k in d)) fail(where, '缺 ' + k);
    for (const issue of groupIndexFormatIssues(d, GI)) fail(where, issue);
    if (g.初始成长登记 !== undefined && !GI.initialization_modes.includes(g.初始成长登记)) fail(where, '初始成长登记方式非法');
    const versions = new Set(g.版本.map(v => v.版本ID));
    if (!versions.has(g.默认版本)) fail(where, '默认版本不在版本列表');
    const profileDirs = dirs.filter(x => x.startsWith(`角色/${g.角色组ID}/档案/`) && segs(x).length === 4).map(x => segs(x)[3]);
    try { assert.deepEqual(g.档案.map(p => p.档案ID).sort(), profileDirs.sort()); } catch { fail(where, '档案列表与档案目录不一致'); }
    const appliesTo = p => p.版本ID ? [p.版本ID] : Array.isArray(p.适用版本) ? p.适用版本 : [];
    for (const v of versions) if (g.档案.filter(p => appliesTo(p).includes(v) && p.默认).length > 1) fail(where, `版本 ${v} 有多个默认档案`);
    for (const p of g.档案) {
      for (const k of Object.keys(p)) if (!GI.profile_fields.includes(k)) fail(where, `${p.档案ID} 字段非法 ${k}`);
      const hasVersionID = typeof p.版本ID === 'string' && p.版本ID.length > 0;
      const hasApplicableVersions = Array.isArray(p.适用版本);
      if (hasVersionID === hasApplicableVersions) fail(where, `${p.档案ID} 必须且只能填写版本ID或适用版本`);
      if (hasApplicableVersions) {
        if (!p.适用版本.length) fail(where, `${p.档案ID} 适用版本不能为空`);
        for (const v of p.适用版本) if (!versions.has(v)) fail(where, `${p.档案ID} 适用版本未登记 ${v}`);
      } else if (!versions.has(p.版本ID)) fail(where, `${p.档案ID} 版本未登记`);
      if (p.默认 && p.生效条件) fail(where, `${p.档案ID} 默认档案不能写生效条件`);
      if (!p.默认 && !p.生效条件) fail(where, `${p.档案ID} 非默认档案缺生效条件`);
      if (p.生效条件) checkCondition(p.生效条件, where);
      if ('初始成长' in p) {
        if (!Array.isArray(p.初始成长) || new Set(p.初始成长).size !== p.初始成长.length) fail(where, `${p.档案ID} 初始成长须为无重复节点数组`);
        else for (const id of p.初始成长) {
          const n = g.growth?.节点?.find(n => n?.节点ID === id);
          if (n?.核定状态 !== '已核定' || n.运行效果 !== '激活') fail(where, `${p.档案ID} 初始成长只允许已核定可执行节点 ${id}`);
          else if (n.适用版本?.length && appliesTo(p).some(v => !n.适用版本.includes(v))) fail(where, `${p.档案ID} 初始成长版本不适用 ${id}`);
        }
      }
      if (p.前置档案) {
        const parent = g.档案.find(q => q.档案ID === p.前置档案);
        if (!parent) fail(where, `${p.档案ID} 前置档案不存在 ${p.前置档案}`);
        else if (!appliesTo(p).some(v => appliesTo(parent).includes(v))) fail(where, `${p.档案ID} 前置档案与当前适用版本无交集`);
      }
      const f = g.files[p.档案ID], pf = `角色/${g.角色组ID}/档案/${p.档案ID}`;
      for (const kind of C.PROFILE_FILES) if (!f[kind]) fail(pf, '缺 ' + kind);
      // 字段、顺序与形态按核心契约校验；建议条数只在档案格式快速检查中提示。
      for (const [kind, body] of Object.entries(f)) {
        const rel = `${pf}/${kind}.txt`;
        for (const issue of profileFormatIssues(kind, body, rawText[rel] ?? '', C.PROFILE_SHAPES[kind], {skills: protocol.skills, dialect}).errors) fail(rel, issue);
      }
    }
    if (!g.growth) fail(where, '每组必须有成长树');
  }
  const cls = dialect.classification;
  const primaryValues = new Set(cls.主类型), tagValues = new Set(cls.标签), resultValues = new Set(cls.事件结果);
  const lineIndexFile = '历史/' + C.LAYOUT.storylineIndex, lineIndex = data[lineIndexFile];
  if (Object.keys(lineIndex || {}).some(k => !C.STORYLINE.index.includes(k))) fail(lineIndexFile, '剧情线索引字段非法');
  for (const message of checkStorylines(lineIndex?.剧情线, catalog.events)) fail(lineIndexFile, message);
  const eventIssues = analyzeEvents(catalog.events, time).issues;
  for (const issue of eventIssues) fail('历史/' + issue.事件ID, issue.说明);
  const roleFields = Object.keys(data[C.LAYOUT.variableSchema].角色['{角色组ID}']);
  const eventRoot = C.LAYOUT.eventRoot, eventIndexFile = `历史/${C.LAYOUT.eventIndex}`, eventIndex = data[eventIndexFile];
  if (!dirs.includes(eventRoot)) fail(eventRoot, '缺少事件目录');
  if (!eventIndex) fail(eventIndexFile, '缺少事件索引');
  else {
    for (const k of Object.keys(eventIndex)) if (!C.EVENT.index.includes(k)) fail(eventIndexFile, '字段非法 ' + k);
    const listed = (eventIndex.事件 || []).map(e => e.事件ID).sort();
    const present = dirs.filter(x => path.posix.dirname(x) === eventRoot).map(x => segs(x)[2]).sort();
    try { assert.deepEqual(listed, present); } catch { fail(eventIndexFile, '事件列表与目录不一致'); }
  }
  if (!(data[C.LAYOUT.historyIndex]?.入口 || []).includes(C.LAYOUT.eventIndex)) fail(C.LAYOUT.historyIndex, '未列出事件索引');
  const projectedFieldsMissing = dialect.projectedFields.filter(k => !roleFields.includes(k));
  if (projectedFieldsMissing.length) fail(C.LAYOUT.variableSchema, '方言输出字段未在角色变量结构中定义：' + projectedFieldsMissing.join('、'));
  for (const e of catalog.events) {
    const where = e.目录 + '/事件.txt', body = data[where];
    if (segs(e.目录)[0] !== '历史' || segs(e.目录)[1] !== '事件' || segs(e.目录)[2] !== e.事件ID) fail(where, '事件ID与目录不一致');
    if (/[A-Za-z]/.test(e.事件ID)) fail(where, '事件ID必须使用中文短语，不能暴露英文编码');
    const labels = Array.isArray(body.标签) ? body.标签 : typeof body.标签 === 'string' ? [body.标签] : [];
    if (!Array.isArray(body.标签)) fail(where, '标签必须是目标多选标签数组');
    if (!labels.length) fail(where, '目标标签数组不能为空');
    if (new Set(labels).size !== labels.length) fail(where, '目标标签不得重复');
    for (const label of labels) if (!tagValues.has(label)) fail(where, '目标标签非法 ' + label);
    if ('事件标题' in body && (typeof body.事件标题 !== 'string' || !body.事件标题.trim())) fail(where, '事件标题必须是非空字符串');
    if ('主类型' in body && (typeof body.主类型 !== 'string' || !primaryValues.has(body.主类型))) fail(where, '主类型非法 ' + body.主类型);
    if ('事件结果' in body) {
      if (!Array.isArray(body.事件结果) || !body.事件结果.length) fail(where, '事件结果必须是非空数组');
      else {
        if (new Set(body.事件结果).size !== body.事件结果.length) fail(where, '事件结果不得重复');
        for (const result of body.事件结果) if (!resultValues.has(result)) fail(where, '事件结果非法 ' + result);
      }
    }
    for (const k of C.EVENT.required) if (!(k in body)) fail(where, '缺字段 ' + k);
    for (const k of Object.keys(body)) if (![...C.EVENT.required, ...C.EVENT.optional].includes(k)) fail(where, '字段非法 ' + k);
    if (!C.CONFIRMATION_POLICIES.includes(e.确认策略)) fail(where, '确认策略非法');
    const from = time(e.时间范围?.最早), to = time(e.时间范围?.最晚);
    if (!from || !to || from[0] > to[0]) fail(where, '时间范围非法');
    for (const g of e.核心参与者 || []) if (!groupIDs.has(g)) fail(where, '核心参与者不是已登记角色组 ' + g);
    if (e.门槛) checkCondition(e.门槛, where);
    const branchIDs = new Set(e.分支.map(b => b.分支ID));
    if (branchIDs.size !== e.分支.length) fail(where, '分支ID重复');
    if (!branchIDs.has(e.默认分支)) fail(where, '默认分支不存在');
    for (const b of e.分支) for (const c of b.变化 || []) {
      const p = c.路径.split('.');
      const okRoot = (p[0] === '世界' && p[1] === '剧情标记' && p.length === 3) || (p[0] === '角色' && (groupIDs.has(p[1]) || p[1] === C.PLAYER) && p.length >= 3);
      if (!okRoot) fail(where, '变化路径根非法 ' + c.路径);
      if (!C.CHANGE_OPERATIONS.includes(c.操作)) fail(where, '变化操作非法 ' + c.操作);
      for (const issue of abilityChangeIssues(c, protocol)) fail(where, issue);
      if (p[0] === '角色' && !roleFields.includes(p[2])) fail(where, '变化写入未定义的角色字段 ' + p[2]);
      if (p[0] === '角色' && p[2] === C.ABILITY.activated) {
        if (p.length !== 3 || c.操作 !== '新增') fail(where, '成长节点已激活只允许新增，不得移除或覆写');
        const ids = Array.isArray(c.值) ? c.值 : [c.值], g = protocol.groups.get(p[1]);
        if (!ids.length) fail(where, '成长激活列表不能为空');
        for (const id of ids) {
          const n = g?.growth?.节点?.find(n => n?.节点ID === id);
          if (!n) { fail(where, '成长节点不存在 ' + id); continue; }
          if (n.核定状态 !== '已核定' || n.运行效果 !== '激活') fail(where, '成长节点尚不可激活 ' + id);
          for (const v of g.版本) if (n.适用版本?.length && !n.适用版本.includes(v.版本ID)) {
            const possible = e.门槛 ? evaluateCondition(e.门槛, (type, a, negative) => {
              if (type !== '角色版本' || a.角色组ID !== g.角色组ID) return null;
              const matches = a.版本ID === v.版本ID;
              return negative ? !matches : matches;
            }) : true;
            if (possible !== false) fail(where, `事件未排除成长节点的不适用版本 ${v.版本ID} / ${id}`);
          }
        }
      }
    }
    for (const [g, pos] of Object.entries(e.角色位置)) {
      const pw = `${e.目录}/角色/${g}.txt`;
      if (!groupIDs.has(g)) fail(pw, '文件名不是角色组ID');
      if (pos.事件ID !== e.事件ID || pos.角色组ID !== g) fail(pw, '事件ID或角色组ID与位置不一致');
      for (const k of C.CHARACTER_POSITION.required) if (!(k in pos)) fail(pw, '缺字段 ' + k);
      for (const k of Object.keys(pos)) if (![...C.CHARACTER_POSITION.required, ...C.CHARACTER_POSITION.optional].includes(k)) fail(pw, '字段非法 ' + k);
      for (const b of pos.适用分支 || []) if (!branchIDs.has(b)) fail(pw, '适用分支不存在 ' + b);
    }
    if (from && to && from[0] <= to[0] && !eventIssues.length) try {
      protocol.eventStatus(e.事件ID, {开局: {已封卷: true, 角色组: Object.fromEntries([...groupIDs].map(g => [g, {启用: true, 版本ID: catalog.groups.find(x => x.角色组ID === g).默认版本}]))}, 世界: {当前时间: e.时间范围.最早}});
    } catch (err) { fail(where, err.message); }
  }
  for (const r of rules) if (r.catalog) await r.catalog(ctx);
  // 档案互斥抽样：枚举抽样时间、版本与档案条件所引用事件的存储状态组合。
  const yearOf = t => Math.floor(time(t)[0] / calendar.yearDays);
  function profileConflicts() {
    const found = [];
    const refs = node => !node || typeof node !== 'object' ? [] : node.事件确认 ? [node.事件确认.事件ID] : Object.values(node).flatMap(v => Array.isArray(v) ? v.flatMap(refs) : refs(v));
    const times = [...new Set(catalog.events.flatMap(e => [e.时间范围.最早, e.时间范围.最晚]).map(yearOf).flatMap(y => [y - 1, y, y + 1]))].filter(y => y >= 0).map(calendar.format);
    for (const g of catalog.groups) for (const v of g.版本) {
      const applies = p => p.版本ID === v.版本ID || (Array.isArray(p.适用版本) && p.适用版本.includes(v.版本ID));
      // 未知事件已由条件检查报告，这里只枚举已登记事件，避免抽样崩溃吞掉错误清单。
      const ids = [...new Set(g.档案.filter(applies).flatMap(p => refs(p.生效条件)))].filter(id => protocol.events.has(id));
      const choices = ids.map(id => [undefined, {状态: 2}, ...protocol.events.get(id).分支.map(b => ({状态: 1, 分支: b.分支ID}))]);
      const combos = choices.reduce((acc, c) => acc.flatMap(a => c.map(x => [...a, x])), [[]]);
      for (const t of times) for (const combo of combos) {
        const stat = {世界: {当前时间: t}, 开局: {已封卷: true, 角色组: {[g.角色组ID]: {启用: true, 版本ID: v.版本ID}}}, 事件: {}};
        combo.forEach((x, i) => { if (x) stat.事件[ids[i]] = x; });
        const r = protocol.resolveProfile(g.角色组ID, stat);
        if (r.状态 === '冲突') found.push({角色组ID: g.角色组ID, 版本ID: v.版本ID, 时间: t, 事件: stat.事件, 候选: r.候选});
      }
    }
    return found;
  }
  // 模型可见文件：剥离机器字段后，值中不得出现运行实现术语、作者维护规则和来源标签。
  const forbidden = new RegExp([...C.FORBIDDEN_TERMS, ...dialect.sourceLabels.map(escape)].join('|'));
  const machine = new Set(C.MACHINE_FIELDS);
  const values = (v, key) => machine.has(key) || key === '来源摘要' ? [] : Array.isArray(v) ? v.flatMap(x => values(x)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => values(x, k)) : typeof v === 'string' ? [v] : [];
  // 同名说明文件额外禁止系统视角措辞，并按长度预算提示。具体条目中的同类词可能是世界内用语（如公会登记），不在此列。
  const isDescription = f => path.posix.basename(f, '.txt') === segs(path.posix.dirname(f)).at(-1) && !dialect.descriptionExempt.includes(segs(f)[0]);
  let visible = 0;
  for (const f of files.filter(f => !buildOnly(f) && f !== '世界书索引.txt')) {
    visible++;
    for (const v of values(data[f])) {
      const m = v.match(forbidden) || (isDescription(f) && v.match(C.SYSTEM_VOICE));
      if (m) fail(f, `模型可见文本含“${m[0]}”：${v}`);
    }
    const size = values(data[f]).join('').replace(/\s/g, '').length;
    const budget = isDescription(f) ? C.LENGTH_BUDGET.同名说明 : C.LENGTH_BUDGET[path.posix.basename(f, '.txt')];
    if (budget && size > budget) warn(`${f}: 正文${size}字，超过${budget}字预算`);
  }

  // 时间格式、取值词表与数值增减
  const vocab = data[C.LAYOUT.vocabulary];
  const timeFields = node => !node || typeof node !== 'object' ? [] : Object.entries(node).flatMap(([k, v]) => ['最早', '最晚', '出生年', '值'].includes(k) && calendar.looksLike(v) ? [v] : timeFields(v));
  for (const [f, d] of Object.entries(data)) for (const t of timeFields(d)) if (!time(t)) fail(f, `时间格式应为 ${calendar.pattern}：` + t);
  for (const e of catalog.events) for (const b of e.分支) for (const c of b.变化 || []) {
    const p = c.路径.split('.'), where = e.目录 + '/事件.txt';
    if (p[0] === '角色' && p[2] === '关系' && c.操作 === '设定' && !(vocab.关系阶段 || []).includes(c.值)) fail(where, '关系阶段不在词表中：' + c.值);
    if (p[0] === '角色' && p[2] === '身体状态' && !(vocab.身体状态?.[p[3]] || []).includes(c.值)) fail(where, '身体状态不在词表中：' + c.路径 + '=' + c.值);
    if (p[0] === '角色' && dialect.ranges[p[2]] && !(['增加', '减少'].includes(c.操作) && Number.isInteger(c.值) && c.值 > 0 && c.值 <= dialect.maxDelta))
      fail(where, `${p[2]}只能用增加或减少，且单次为1至${dialect.maxDelta}的整数：${c.操作} ${c.值}`);
    if (p[0] === '世界' && p[1] === '剧情标记' && !(vocab.剧情标记?.[p[2]] || []).includes(c.值)) fail(where, '剧情标记或取值未登记：' + p[2] + '=' + c.值);
  }
  const markRefs = node => !node || typeof node !== 'object' ? [] : node.剧情标记 ? [node.剧情标记] : Object.values(node).flatMap(v => Array.isArray(v) ? v.flatMap(markRefs) : markRefs(v));
  for (const e of catalog.events) for (const m of markRefs(e.门槛)) if (!(vocab.剧情标记?.[m.标记ID] || []).includes(m.值)) fail(e.目录 + '/事件.txt', '门槛中的剧情标记或取值未登记：' + m.标记ID + '=' + m.值);
  // 非封卷条件只能用于仅作候选：封卷时没有场景与在场者，用在其它策略上会使晚期开局排除该事件。
  const unsealable = node => !node || typeof node !== 'object' ? [] : Object.entries(node).flatMap(([k, v]) => C.CONDITION_TYPES[k]?.sealable === false ? [k] : Array.isArray(v) ? v.flatMap(unsealable) : []);
  for (const e of catalog.events) if (e.确认策略 !== '仅作候选') for (const type of new Set(unsealable(e.门槛))) warn(`${e.目录}/事件.txt: ${type}在封卷时为未知，${e.确认策略}事件在晚期开局会被排除`);

  // 日期草稿不影响独立静态检查；仍阻止它们流入封卷和档案互斥抽样。
  if (catalog.events.some(e => { const from = time(e.时间范围?.最早), to = time(e.时间范围?.最晚); return !from || !to || from[0] > to[0]; })) {
    json({结果: '不通过', 错误: errors, 提示: warnings, 事件: catalog.events.length, 模型可见文件: visible, 档案互斥抽样: '未执行：事件时间范围非法', 运行抽样: '未执行：事件时间范围非法，须先核定正文'});
    return done(1);
  }
  // 事件关系有结构错误时（已在上方逐条报告），档案解析与互斥抽样无法求值，跳过而不崩溃。
  const eventStructureBroken = eventIssues.length > 0;
  if (!eventStructureBroken) for (const g of catalog.groups) for (const version of g.版本) try {
    protocol.resolveProfile(g.角色组ID, {开局: {已封卷: true, 角色组: {[g.角色组ID]: {启用: true, 版本ID: version.版本ID}}}, 世界: {当前时间: calendar.format(dialect.earliestYear)}});
  } catch (e) { fail(`角色/${g.角色组ID}/${g.角色组ID}索引.txt`, e.message); }
  if (!eventStructureBroken) for (const c of profileConflicts()) fail(`角色/${c.角色组ID}`, '档案条件冲突 ' + JSON.stringify(c));
  if (eventStructureBroken && errors.length) {
    json({结果: '不通过', 错误: errors, 提示: warnings, 事件: catalog.events.length, 档案互斥抽样: '未执行：事件关系有结构错误', 运行抽样: '未执行：事件关系有结构错误'});
    return done(1);
  }
  // 作者改写剧情时可单独检查结构；默认模式继续执行运行抽样。
  if (staticOnly) {
    json({结果: errors.length ? '不通过' : '通过', 模式: '静态结构与档案互斥', 文件: files.length, 事件: catalog.events.length, 错误: errors, 提示: warnings, 运行抽样: '未执行：显式--static-only'});
    return done(errors.length ? 1 : 0);
  }

  // 运行抽样：不依赖具体故事，只验证通用不变量——任意抽样开局都能封卷，每个启用角色恰好一份当前档案，只读组装不改快照。
  const sampleYears = [...new Set([dialect.earliestYear, ...catalog.events.flatMap(e => [e.时间范围.最早, e.时间范围.最晚]).map(yearOf).flatMap(y => [y, y + 1])])].sort((a, b) => a - b);
  const maxVersions = Math.max(1, ...catalog.groups.map(g => g.版本.length));
  const variants = [{名称: '默认开局', 角色组: {}}, ...Array.from({length: maxVersions}, (_, i) => ({
    名称: `全部启用·版本${i + 1}`,
    角色组: Object.fromEntries(catalog.groups.map(g => [g.角色组ID, {启用: true, 版本ID: g.版本[Math.min(i, g.版本.length - 1)].版本ID}])),
  }))];
  const freezeDeep = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freezeDeep); } return o; };
  let samples = 0;
  for (const y of sampleYears) for (const v of variants) {
    const at = calendar.format(y), label = `${at}·${v.名称}`;
    try {
      const st = seal(protocol, {开局时间: at, 角色组: v.角色组});
      const enabledIDs = catalog.groups.filter(g => st.开局.角色组[g.角色组ID]?.启用).map(g => g.角色组ID);
      for (const id of enabledIDs) {
        const r = protocol.resolveProfile(id, st);
        if (r.状态 !== '成立') fail('运行抽样', `${label}：${id} 当前档案${r.状态} ${JSON.stringify(r.候选 || r.原因 || '')}`);
      }
      const before = JSON.stringify(st);
      const out = assemble(protocol, freezeDeep(structuredClone(st)), {present: enabledIDs});
      if (out.异常.length) fail('运行抽样', `${label}：组装异常 ${JSON.stringify(out.异常)}`);
      if (JSON.stringify(st) !== before) fail('运行抽样', `${label}：只读组装改写了快照`);
      samples++;
    } catch (e) { fail('运行抽样', `${label}：${e.message}`); }
  }

  if (errors.length) return failed();
  if (warnings.length) stderr.push('提示（不判失败）：\n' + warnings.join('\n'));
  json({结果: '通过', 目录: label, 文件: files.length, 模型可见文件: visible, 技能: ns.技能ID.size, 装备: ns.装备ID.size, 道具: ns.道具ID.size, 角色组: groupIDs.size,
    档案: catalog.groups.reduce((n, g) => n + g.档案.length, 0), 事件: catalog.events.length,
    运行抽样: {开局: samples, 年份: sampleYears.length, 组合: variants.map(v => v.名称)}});
  return done(0);
}

export function printReport({code, stdout, stderr}) {
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  process.exitCode = code;
  return code;
}
